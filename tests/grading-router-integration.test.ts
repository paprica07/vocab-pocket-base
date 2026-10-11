import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import { PDFDocument, degrees } from "pdf-lib";
import { createApiApp } from "../server/_core/index";
import { router } from "../server/_core/trpc";
import { createWorksheetHybridProcedures } from "../server/grading/router";
import { gradeFixedLayoutPdfWithPoppler } from "../server/grading/poppler-pipeline";
import { createExamPdfWithManifest } from "./helpers/actual-worksheet";
import type { WorksheetManifest } from "../lib/worksheet-layout";
import { manifestPlanId, worksheetPdfMarker } from "../lib/worksheet-layout";
import type { GeminiInvoker } from "../server/grading/gemini-fallback";

const terms = ["apple", "banana", "journey", "garden", "window", "river", "school", "book", "chair", "table", "house", "water", "bread", "orange", "lemon", "flower", "forest", "summer", "winter", "spring", "mother", "father", "sister", "brother", "music", "friend", "doctor", "nurse", "artist", "pilot"];
const rows = (count: number, blanks: number[] = []) => terms.slice(0, count).map((term, index) => ({
  prompt: index % 2 ? `뜻 ${index + 1}` : term,
  answer: index % 2 ? term : "여정",
  direction: index % 2 ? "koreng" as const : "engkor" as const,
  sourceTerm: term, sourceMeaning: index % 2 ? `뜻 ${index + 1}` : "여정",
  ...(blanks.includes(index + 1) ? { studentAnswer: "" } : {}),
}));

let target: WorksheetManifest;
let calls: number[][] = [];
let behavior: "normal" | "failure" | "strictViolation" | "uncertain" = "normal";
const invoke: GeminiInvoker = async params => {
  const content = params.messages[0].content;
  if (!Array.isArray(content)) throw new Error("missing batch");
  const supplied = content.filter(part => typeof part !== "string" && part.type === "text" && part.text.startsWith("The next image belongs"))
    .map(part => JSON.parse((part as { text: string }).text.split(": ").slice(1).join(": ")) as { number: number });
  calls.push(supplied.map(q => q.number));
  expect(content.filter(part => typeof part !== "string" && part.type === "image_url")).toHaveLength(supplied.length);
  for (const image of content.filter(part => typeof part !== "string" && part.type === "image_url")) {
    expect((image as { image_url: { url: string } }).image_url.url).toMatch(/^data:image\/png;base64,/);
  }
  if (behavior === "failure") throw new Error("test provider unavailable");
  return { id: "mock-only", created: 0, model: "gemini-3.5-flash", choices: [{ index: 0, finish_reason: "stop", message: {
    role: "assistant", content: JSON.stringify({ results: supplied.reverse().map(q => ({
      number: q.number, answer: behavior === "strictViolation" ? "deliberateWrong" : target.questions[q.number - 1].expected,
      correct: behavior !== "uncertain", confidence: 96, needsReview: behavior === "uncertain", note: "mock integration response",
    })) }),
  } }] };
};
const testRouter = router({ worksheet: router(createWorksheetHybridProcedures({ invoke })) });
let server: Server;
let base: string;
let client: ReturnType<typeof createTRPCClient<typeof testRouter>>;
let full: Awaited<ReturnType<typeof createExamPdfWithManifest>>;
let blank: typeof full;
let twoPage: typeof full;
const originalGate = process.env.VOCAB_POCKET_HYBRID_ENABLED;
const mutate = (m: WorksheetManifest) => structuredClone(m);

async function upload(pdf: Uint8Array) {
  const response = await fetch(`${base}/api/worksheet/upload-pdf`, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: Buffer.from(pdf) });
  expect(response.status).toBe(200);
  return (await response.json()).key as string;
}
async function grade(pdf = full.pdfBytes, manifest: unknown = full.manifest) {
  const storageKey = await upload(pdf);
  try { return await client.worksheet.gradeHybridPdf.mutate({ storageKey, manifest: manifest as WorksheetManifest }); }
  finally { await expect(access(path.join(os.tmpdir(), "vocab-pocket-pdfs", `${storageKey}.pdf`))).rejects.toThrow(); }
}
async function modifiedPdf(change: (pdf: PDFDocument) => void) {
  const pdf = await PDFDocument.load(full.pdfBytes); change(pdf); return pdf.save();
}

describe("real upload HTTP → existing tRPC manifest contract → hybrid (mock Gemini only)", () => {
  beforeAll(async () => {
    process.env.VOCAB_POCKET_HYBRID_ENABLED = "1";
    full = await createExamPdfWithManifest(rows(16), { examId: "vp-integration-16" });
    blank = await createExamPdfWithManifest(rows(16, [2, 5]), { examId: "vp-integration-review" });
    twoPage = await createExamPdfWithManifest(rows(30, [2, 28, 30]), { examId: "vp-integration-30" });
    const app = await createApiApp(testRouter);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    client = createTRPCClient<typeof testRouter>({ links: [httpBatchLink({ url: `${base}/api/trpc`, transformer: superjson })] });
  }, 180_000);
  beforeEach(() => { calls = []; target = full.manifest; behavior = "normal"; process.env.VOCAB_POCKET_HYBRID_ENABLED = "1"; });
  afterAll(async () => {
    process.env.VOCAB_POCKET_HYBRID_ENABLED = originalGate;
    server?.closeAllConnections(); await new Promise<void>(resolve => server?.close(() => resolve()));
  });

  it("reports capabilities and keeps existing health/upload endpoints", async () => {
    expect(await client.worksheet.gradingCapabilities.query()).toEqual({ hybridEnabled: true });
    expect((await (await fetch(`${base}/api/health`)).json()).ok).toBe(true);
  });
  it("A: saved actual 16-question manifest enters hybrid; confirmed OCR makes zero calls", async () => {
    const out = await grade();
    expect(out.results.map(r => r.number)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(out.results.map(r => r.expected)).toEqual(full.manifest.questions.map(q => q.expected));
    expect(out.results.map(r => r.term)).toEqual(full.manifest.questions.map(q => q.term));
    expect(out).toMatchObject({ score: 16, total: 16, reviewCount: 0 }); expect(calls).toEqual([]);
  }, 180_000);
  it("disabled gate refuses hybrid, without any Gemini request", async () => {
    process.env.VOCAB_POCKET_HYBRID_ENABLED = "0";
    expect((await client.worksheet.gradingCapabilities.query()).hybridEnabled).toBe(false);
    await expect(grade()).rejects.toThrow("활성화되지"); expect(calls).toEqual([]);
  });
  it("B: missing manifest cannot enter fixed-layout hybrid", async () => {
    const storageKey = await upload(full.pdfBytes);
    await expect(client.worksheet.gradeHybridPdf.mutate({ storageKey, manifest: undefined as unknown as WorksheetManifest })).rejects.toThrow("manifest"); expect(calls).toEqual([]);
    await expect(access(path.join(os.tmpdir(), "vocab-pocket-pdfs", `${storageKey}.pdf`))).rejects.toThrow();
  });
  it("malformed non-object manifest is refused and its uploaded PDF is deleted", async () => {
    await expect(grade(full.pdfBytes, "not-a-manifest")).rejects.toThrow("manifest"); expect(calls).toEqual([]);
  });
  it.each(["examId", "planId", "pageCount", "answerRect", "questionNumber"] as const)("C–G: altered %s is rejected before OCR/fallback", async field => {
    const m = mutate(full.manifest);
    if (field === "examId") { m.examId = "vp-other-exam"; m.planId = manifestPlanId(m); }
    if (field === "planId") m.planId = "00000000";
    if (field === "pageCount") m.pageCount += 1;
    if (field === "answerRect") m.questions[0].answerRect.x += 5;
    if (field === "questionNumber") delete (m.questions[0] as Partial<typeof m.questions[0]>).number;
    await expect(grade(full.pdfBytes, m)).rejects.toThrow(/manifest|ID/); expect(calls).toEqual([]);
  });
  it.each(["version", "pageNumber", "baselineY"] as const)("rejects altered %s in the same shared manifest", async field => {
    const m: any = mutate(full.manifest);
    if (field === "version") m.layoutVersion = "fixed-layout-v1"; else m.questions[0][field] += 1;
    await expect(grade(full.pdfBytes, m)).rejects.toThrow("manifest"); expect(calls).toEqual([]);
  });
  it.each(["marker", "size", "rotation", "pageCount"] as const)("rejects a PDF with mismatched %s; never guesses crop positions", async field => {
    const pdf = await modifiedPdf(p => {
      if (field === "marker") p.setSubject("");
      if (field === "size") p.getPage(0).setSize(612, 792);
      if (field === "rotation") p.getPage(0).setRotation(degrees(90));
      if (field === "pageCount") p.addPage();
    });
    await expect(grade(pdf)).rejects.toThrow("페이지 규격"); expect(calls).toEqual([]);
  });
  it("keeps exact page/row number matching and reorders only sparse reviews across two pages", async () => {
    target = twoPage.manifest;
    const out = await grade(twoPage.pdfBytes, twoPage.manifest);
    expect(target.questions[26].pageNumber).toBe(2);
    expect(calls).toEqual([[2, 28, 30]]); expect(out.score).toBe(30);
    expect(out.results.map(r => r.number)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(out.results.filter(r => r.source === "gemini").map(r => r.number)).toEqual([2, 28, 30]);
  }, 180_000);
  it("fallback failure preserves actual OCR fields, review score is never counted", async () => {
    target = blank.manifest; behavior = "failure";
    const original = await gradeFixedLayoutPdfWithPoppler(blank.pdfBytes, blank.manifest);
    const out = await grade(blank.pdfBytes, blank.manifest);
    expect(out.results).toEqual(original); expect(out.score).toBe(14); expect(out.reviewCount).toBe(2);
    expect(calls).toEqual([[2, 5]]); expect(out.fallback.status).toBe("failed");
  }, 180_000);
  it("a Gemini spelling/strict-compare violation cannot become a correct score", async () => {
    target = blank.manifest; behavior = "strictViolation";
    const out = await grade(blank.pdfBytes, blank.manifest);
    expect(out.score).toBe(14); expect(out.reviewCount).toBe(2);
    expect(out.results.filter(r => r.needsReview).every(r => !r.correct && r.source === "ocr")).toBe(true);
  }, 180_000);
  it("Gemini explicit uncertain preserves review and excludes it from score", async () => {
    target = blank.manifest; behavior = "uncertain";
    const out = await grade(blank.pdfBytes, blank.manifest);
    expect(out.score).toBe(14); expect(out.reviewCount).toBe(2);
    expect(out.results.filter(r => r.source === "gemini").every(r => r.needsReview && !r.correct)).toBe(true);
  }, 180_000);
  it("deletes uploaded temporary PDF after successful grading and PDF mismatch", async () => {
    const key = await upload(full.pdfBytes);
    await client.worksheet.gradeHybridPdf.mutate({ storageKey: key, manifest: full.manifest });
    await expect(access(path.join(os.tmpdir(), "vocab-pocket-pdfs", `${key}.pdf`))).rejects.toThrow();
    await expect(grade(await modifiedPdf(p => p.setSubject("")))).rejects.toThrow("페이지 규격");
  }, 180_000);
  it.skip("Integration 10: new actual 16-question human handwriting + real Gemini run persisted (sample/device not supplied)", () => {});
});

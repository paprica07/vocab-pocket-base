import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  assertWorksheetManifest, manifestPlanId, orderWordsByWorksheetManifest, WORKSHEET_LAYOUT,
  type WorksheetManifest,
} from "../lib/worksheet-layout";
import { gradeFixedLayoutPdfWithPoppler, rowsPerPage } from "../server/grading/poppler-pipeline";
import { gradeFixedLayoutPdfHybrid } from "../server/grading/hybrid-pipeline";
import { SingleOcrWorker } from "../server/grading/ocr";
import { validatePdfManifest } from "../server/grading/manifest";
import { isPopplerAvailableSync } from "../server/grading/poppler-render";
import { isStrictCorrectAnswer } from "../lib/worksheet-utils";
import { applyGeminiFallback, type GradingTelemetryEvent } from "../server/grading/gemini-fallback";
import type { InvokeParams, InvokeResult } from "../server/_core/llm";
import { createExamPdfWithManifest, nativeGenerator, type WorksheetFixtureRow } from "./helpers/actual-worksheet";

const answers = ["apple", "banana", "journey", "garden", "window", "river", "school", "book", "chair", "table", "house", "water", "bread", "orange", "lemon", "flower", "forest", "summer", "winter", "spring", "mother", "father", "sister", "brother", "music", "friend", "doctor", "nurse", "artist", "pilot"];
const rows = (): WorksheetFixtureRow[] => answers.map((answer, i) => ({ prompt: `단어 ${i + 1}`, answer, direction: "koreng", sourceTerm: answer, sourceMeaning: `단어 ${i + 1}` }));
const longPrompt = (i: number) => `문항 ${i + 1} ` + "아주 긴 한글과 English prompt를 그대로 표시합니다. ".repeat(3);
function bboxRows(bytes: Uint8Array) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "vp-layout-bbox-"));
  try {
    writeFileSync(path.join(dir, "test.pdf"), bytes);
    const result = spawnSync("pdftotext", ["-bbox-layout", path.join(dir, "test.pdf"), path.join(dir, "out.html")]);
    if (result.status !== 0) throw new Error("pdftotext bbox 실패");
    const html = readFileSync(path.join(dir, "out.html"), "utf8");
    return [...html.matchAll(/<page\b[^>]*>([\s\S]*?)<\/page>/g)].flatMap((page, pi) =>
      [...page[1].matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">(\d+)\.<\/word>/g)]
        .filter(w => Math.abs(Number(w[1]) - WORKSHEET_LAYOUT.numberX) < 0.1)
        .map(w => ({ number: Number(w[3]), pageNumber: pi + 1, baselineY: WORKSHEET_LAYOUT.pageHeight - Number(w[2]) - 8.616 })),
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
function verifyBbox(manifest: WorksheetManifest, bytes: Uint8Array) {
  const actual = bboxRows(bytes);
  expect(actual).toHaveLength(manifest.questions.length);
  actual.forEach((a, index) => {
    const q = manifest.questions[index];
    expect(a.number).toBe(q.number); expect(a.pageNumber).toBe(q.pageNumber);
    expect(a.baselineY).toBeCloseTo(q.baselineY, 2);
  });
  return actual;
}
const response = (entries: unknown[]): InvokeResult => ({ id: "mock-only", model: "mock", created: 0, choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ results: entries }) }, finish_reason: "STOP" }] });
const result = (number: number, answer: string, correct: boolean) => ({ number, answer, correct, confidence: 98, needsReview: false, note: "모의 전송 검증" });
afterEach(() => vi.restoreAllMocks());

// Actual app generator + actual Poppler + actual Tesseract. No real Gemini calls.
describe.skipIf(!isPopplerAvailableSync())("saved app layout is the only source of OCR positions", () => {
  it.each([
    ["short", []], ["first wrap", [0]], ["middle wrap", [14]], ["multiple wraps", [0, 8, 14, 23]],
  ] as const)("%s: 30 unique answers map to their actual PDF numbers/pages/baselines", async (_name, wraps) => {
    const input = rows();
    for (const i of wraps) { input[i].prompt = longPrompt(i); input[i].sourceMeaning = input[i].prompt; }
    const fixture = await createExamPdfWithManifest(input);
    const actual = verifyBbox(fixture.manifest, fixture.pdfBytes);
    const placed = await validatePdfManifest(fixture.pdfBytes, fixture.manifest);
    placed.questions.forEach((q, i) => {
      expect(q.pageNumber).toBe(actual[i].pageNumber); expect(q.baselineY).toBeCloseTo(actual[i].baselineY, 2);
      expect(q.answerRect.y).toBeCloseTo(WORKSHEET_LAYOUT.pageHeight - q.baselineY - 15, 5);
    });
    const out = await gradeFixedLayoutPdfWithPoppler(fixture.pdfBytes, fixture.manifest);
    expect(out.map(q => q.number)).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
    expect(out.map(q => q.answer)).toEqual(answers);
    expect(out.every(q => q.correct && !q.needsReview)).toBe(true);
    if (!wraps.length) { expect(rowsPerPage()).toBe(26); expect(fixture.manifest.questions[25].pageNumber).toBe(1); expect(fixture.manifest.questions[26].pageNumber).toBe(2); }
  }, 180_000);

  it("1-page 10 unique answers retain exact mapping", async () => {
    const f = await createExamPdfWithManifest(rows().slice(0, 10));
    verifyBbox(f.manifest, f.pdfBytes);
    expect((await gradeFixedLayoutPdfWithPoppler(f.pdfBytes, f.manifest)).map(r => r.answer)).toEqual(answers.slice(0, 10));
  }, 60_000);

  it("exam and answer reuse the same 30-item random mixed manifest, even with wrapped prompts", async () => {
    const pairs = rows().map((r, i) => ({ id: `id-${i}`, term: r.sourceTerm!, meaning: i === 2 ? longPrompt(i) : r.sourceMeaning! }));
    const ordered = [...pairs].reverse();
    const questions = ordered.map((w, i) => ({ number: i + 1, direction: i % 2 ? "koreng" as const : "engkor" as const,
      prompt: i % 2 ? w.meaning : w.term, answer: i % 2 ? w.term : w.meaning, sourceTerm: w.term, sourceMeaning: w.meaning }));
    const inputText = pairs.map(w => `${w.term}: ${w.meaning}`).join("\n");
    const generated = await nativeGenerator().createExamPdfWithManifest(questions, { inputText });
    const saved = JSON.parse(JSON.stringify(generated.manifest));
    assertWorksheetManifest(saved, { words: pairs.map((w, i) => ({ ...w, id: `reparsed-${i}` })), inputText, examId: saved.examId });
    expect(orderWordsByWorksheetManifest(pairs, saved).map(w => w.term)).toEqual(ordered.map(w => w.term));
    const exam = Buffer.from(generated.base64, "base64");
    // Ensure the long meaning is asked as prompt, not an oversized answer key row.
    const answer = Buffer.from(await nativeGenerator().createAnswerPdf(saved), "base64");
    const e = verifyBbox(saved, exam), a = verifyBbox(saved, answer);
    expect(a).toEqual(e);
    expect((await PDFDocument.load(answer)).getSubject()).toContain(saved.examId);
    expect((await PDFDocument.load(exam)).getSubject()).toContain(saved.planId);
    expect(saved.questions.map(q => [q.number, q.direction, q.sourceTerm, q.sourceMeaning, q.expected])).toEqual(generated.manifest.questions.map(q => [q.number, q.direction, q.sourceTerm, q.sourceMeaning, q.expected]));
  }, 60_000);

  it("a mismatched PDF exam identity cannot generate OCR or Gemini crops", async () => {
    const f = await createExamPdfWithManifest(rows().slice(0, 2));
    const another = structuredClone(f.manifest); another.examId = "vp-another-exam"; another.planId = manifestPlanId(another);
    const recognize = vi.spyOn(SingleOcrWorker.prototype, "recognize"); const invoke = vi.fn();
    const out = await gradeFixedLayoutPdfHybrid(f.pdfBytes, another, { invoke });
    expect(recognize).not.toHaveBeenCalled(); expect(invoke).not.toHaveBeenCalled();
    expect(out.results.every(q => q.needsReview && !q.correct)).toBe(true);
  }, 60_000);

  it("missing layout metadata stays under review, with no guessed rows or Gemini sends", async () => {
    const f = await createExamPdfWithManifest(rows().slice(0, 2)); const pdf = await PDFDocument.load(f.pdfBytes); pdf.setSubject("");
    const invoke = vi.fn(); const out = await gradeFixedLayoutPdfHybrid(await pdf.save(), f.manifest, { invoke });
    expect(invoke).not.toHaveBeenCalled(); expect(out.results.every(q => q.needsReview && !q.correct)).toBe(true);
  }, 60_000);

  it("original OCR correct=true + actual overflow always becomes correct=false; failure preserves it", async () => {
    const f = await createExamPdfWithManifest(rows().slice(0, 1)); const pdf = await PDFDocument.load(f.pdfBytes);
    const q = f.manifest.questions[0];
    pdf.getPage(0).drawRectangle({ x: 323, y: q.baselineY + 2, width: 4, height: 6 });
    // Ink/overflow is real Poppler; only recognized text is injected to isolate the former safety defect.
    vi.spyOn(SingleOcrWorker.prototype, "recognize").mockResolvedValue({ text: "apple", confidence: 99, script: "eng" });
    const bytes = await pdf.save(); const base = await gradeFixedLayoutPdfWithPoppler(bytes, f.manifest);
    expect(base[0]).toMatchObject({ answer: "apple", confidence: 99, correct: false, needsReview: true });
    const failed = await gradeFixedLayoutPdfHybrid(bytes, f.manifest, { invoke: async () => { throw new Error("503 mocked"); } });
    expect(failed.results).toEqual(base);
    const recovered = await gradeFixedLayoutPdfHybrid(bytes, f.manifest, { invoke: async () => response([result(1, "apple", true)]) });
    expect(recovered.results[0]).toMatchObject({ source: "gemini", correct: true, needsReview: false });
  }, 60_000);

  it("real OCR confirmations are never sent; blanks across wrapped pages form exactly one reversed-response batch", async () => {
    const input = rows(); const blanks = new Set([1, 27, 29]);
    for (const i of blanks) input[i].studentAnswer = "";
    input[5].prompt = longPrompt(5); input[5].sourceMeaning = input[5].prompt;
    input[3].studentAnswer = "banana"; // clear actual wrong answer, never sent
    const f = await createExamPdfWithManifest(input); const base = await gradeFixedLayoutPdfWithPoppler(f.pdfBytes, f.manifest);
    const invoke = vi.fn(async (request: InvokeParams) => {
      const content = request.messages[0].content as { type: string; text?: string }[];
      const meta = content.filter(p => p.type === "text").slice(1).map(p => JSON.parse(p.text!.split("question: ")[1]));
      expect(meta.map(q => q.number)).toEqual([2, 28, 30]);
      expect(content.filter(p => p.type === "image_url")).toHaveLength(3);
      return response([result(30, "", false), result(2, "", false), result(28, "", false)]);
    });
    const out = await gradeFixedLayoutPdfHybrid(f.pdfBytes, f.manifest, { invoke });
    expect(invoke).toHaveBeenCalledTimes(1); expect(out.results.map(q => q.number)).toEqual(base.map(q => q.number));
    for (let i = 0; i < 30; i++) { if (blanks.has(i)) expect(out.results[i].source).toBe("gemini"); else expect(out.results[i]).toEqual(base[i]); }
    expect(out.results[3]).toMatchObject({ source: "ocr", correct: false, needsReview: false });
  }, 180_000);
});

describe("manifest corruption is rejected, not silently re-randomized", () => {
  const fixture = async () => (await createExamPdfWithManifest(rows().slice(0, 3))).manifest;
  it.each(["duplicate question", "duplicate word", "direction", "term/meaning", "number", "version", "baseline", "rectangle", "planId"])('%s rejects', async kind => {
    const m = await fixture();
    switch (kind) {
      case "duplicate question": m.questions[1] = structuredClone(m.questions[0]); break;
      case "duplicate word": m.questions[1].sourceTerm = m.questions[0].sourceTerm; m.questions[1].wordIdentity = m.questions[0].wordIdentity; break;
      case "direction": m.questions[0].direction = "engkor"; break;
      case "term/meaning": m.questions[0].sourceMeaning = "changed"; break;
      case "number": m.questions[0].number = 50; break;
      case "version": (m as { layoutVersion: string }).layoutVersion = "fixed-layout-v1"; break;
      case "baseline": m.questions[0].baselineY -= 26; break;
      case "rectangle": m.questions[0].answerRect.x += 1; break;
      case "planId": m.planId = "broken"; break;
    }
    if (kind !== "planId") m.planId = manifestPlanId(m);
    expect(() => assertWorksheetManifest(m)).toThrow("manifest");
  });
  it("different exam ID, input or word-pair is rejected by storage-context validation", async () => {
    const f = await createExamPdfWithManifest(rows().slice(0, 3), { inputText: "apple: 단어 1" });
    expect(() => assertWorksheetManifest(f.manifest, { examId: "vp-different" })).toThrow();
    expect(() => assertWorksheetManifest(f.manifest, { inputText: "apple: changed" })).toThrow();
    expect(() => assertWorksheetManifest(f.manifest, { words: [{ id: "new", term: "apple", meaning: "changed" }] })).toThrow();
  });
  it("old questions-only manifests are rejected", () => expect(() => assertWorksheetManifest([{ number: 1, prompt: "apple", answer: "사과" }])).toThrow());
});

describe("unchanged strict policy and boundary/failure invariants", () => {
  it("legacy standalone string[] answer PDF still prints duplicate and long answers", async () => {
    const bytes = Buffer.from(await nativeGenerator().createAnswerPdf(["사과", "사과", "아주 긴 답안 ".repeat(12)]), "base64");
    expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThanOrEqual(1);
    expect(bboxRows(bytes).map(q => q.number)).toEqual([1, 2, 3]);
  });
  it("saved-exam answer PDF never clips or independently moves an oversized key", async () => {
    const generated = await nativeGenerator().createExamPdfWithManifest([{ number: 1, prompt: "long-answer", answer: "아주 긴 답안 ".repeat(12), direction: "engkor" }]);
    await expect(nativeGenerator().createAnswerPdf(generated.manifest)).rejects.toThrow("저장된 시험지 행보다 깁니다");
  });
  it.each([["아세포", true], ["모세포", true], ["아세포, 모세포", false], ["모세포, 아세포", false]] as const)("policy characterization ONLY: %s -> %s (no policy change)", (answer, correct) => expect(isStrictCorrectAnswer(answer, "아세포, 모세포")).toBe(correct));
  it("fallback never confirms an inconsistent needsReview/correct input on failure", async () => {
    const original = { number: 1, term: "사과", expected: "apple", answer: "apple", confidence: 99, correct: true, needsReview: true, source: "ocr" as const, note: "legacy overflow" };
    const out = await applyGeminiFallback([original], [], vi.fn());
    expect(out.results[0]).toMatchObject({ correct: false, needsReview: true });
    expect(original.correct).toBe(true);
  });
  it("fallback cannot replace local key using mismatched crop metadata", async () => {
    const original = { number: 1, term: "사과", expected: "apple", answer: "", confidence: 0, correct: false, needsReview: true, source: "ocr" as const, note: "" };
    const invoke = vi.fn();
    await applyGeminiFallback([original], [{ index: 0, question: { number: 1, term: "사과", expected: "banana", answerKey: "banana" }, pageNumber: 1, rowIndex: 0, png: Buffer.from("x"), touchesBoundary: false }], invoke);
    expect(invoke).not.toHaveBeenCalled();
  });
  it("fallback telemetry logs start/batch/completion but not raw answers or images", async () => {
    const events: GradingTelemetryEvent[] = [];
    const original = { number: 1, term: "PRIVATE-PROMPT", expected: "apple", answer: "", confidence: 0, correct: false, needsReview: true, source: "ocr" as const, note: "" };
    await applyGeminiFallback([original], [{ index: 0, question: { ...original, answerKey: "apple" }, pageNumber: 1, rowIndex: 0, png: Buffer.from("image-private-bytes"), touchesBoundary: false }], async () => response([result(1, "apple", true)]), { telemetry: e => events.push(e) });
    expect(events.map(e => "phase" in e ? e.phase : e.type)).toEqual(["fallback_start", "batch_created", "fallback_completed"]);
    expect(JSON.stringify(events)).not.toContain("PRIVATE-PROMPT"); expect(JSON.stringify(events)).not.toContain("apple");
  });
});

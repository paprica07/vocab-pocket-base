import { describe, expect, it, vi } from "vitest";
import { buildWorksheetManifest } from "../lib/worksheet-layout";
import { gradeUploadedWorksheet, summarizeWorksheetResults, worksheetConfidencePercent, worksheetResultLabel } from "../lib/worksheet-grading";

const words = [{ id: "1", term: "apple", meaning: "사과" }];
const manifest = buildWorksheetManifest([{ number: 1, prompt: "apple", answer: "사과", direction: "engkor" }], () => 20, { examId: "vp-client-contract" });
const row = { number: 1, term: "apple", expected: "사과", answer: "사과", correct: true };
type Options = Parameters<typeof gradeUploadedWorksheet>[0];
const clients = () => ({ capabilities: vi.fn(async () => ({ hybridEnabled: true })),
  aiOnly: vi.fn(async (_input: Parameters<Options["aiOnly"]>[0]) => ({ results: [row] })),
  hybrid: vi.fn(async (_input: Parameters<Options["hybrid"]>[0]) => ({ results: [{ ...row, confidence: 96, source: "ocr" as const, needsReview: false }] })) });

describe("actual app upload orchestration and result presentation", () => {
  it("defaults to AI-only even with a valid saved exam", async () => {
    const api = clients();
    const out = await gradeUploadedWorksheet({ storageKey: "key", words, manifest, hybridEnabled: false, ...api });
    expect(out.mode).toBe("ai-only"); expect(api.capabilities).not.toHaveBeenCalled(); expect(api.hybrid).not.toHaveBeenCalled();
    expect(api.aiOnly.mock.calls[0][0]).toMatchObject({ questions: [{ number: 1, direction: "engkor" }] });
  });
  it("transmits the entire existing manifest unchanged with both gates on", async () => {
    const api = clients();
    const out = await gradeUploadedWorksheet({ storageKey: "key", words, manifest, hybridEnabled: true, ...api });
    expect(out.mode).toBe("hybrid"); expect(api.aiOnly).not.toHaveBeenCalled();
    expect(api.hybrid.mock.calls[0][0].manifest).toBe(manifest);
    expect(api.hybrid.mock.calls[0][0].manifest.questions[0]).toMatchObject({ answerRect: manifest.questions[0].answerRect, baselineY: manifest.questions[0].baselineY });
  });
  it.each([undefined, { ...manifest, planId: "stale" }])("does not use missing/stale manifests for hybrid", async saved => {
    const api = clients();
    const out = await gradeUploadedWorksheet({ storageKey: "key", words, manifest: saved, hybridEnabled: true, ...api });
    expect(out.mode).toBe("ai-only"); expect(api.hybrid).not.toHaveBeenCalled(); expect(api.capabilities).not.toHaveBeenCalled();
    expect(api.aiOnly.mock.calls[0][0].questions).toBeUndefined();
  });
  it("preserves existing AI-only if the server gate is off", async () => {
    const api = clients(); api.capabilities.mockResolvedValue({ hybridEnabled: false });
    expect((await gradeUploadedWorksheet({ storageKey: "key", words, manifest, hybridEnabled: true, ...api })).mode).toBe("ai-only");
    expect(api.hybrid).not.toHaveBeenCalled();
  });
  it("preserves older servers without capabilities endpoint", async () => {
    const api = clients(); api.capabilities.mockRejectedValue(new Error("NOT_FOUND"));
    expect((await gradeUploadedWorksheet({ storageKey: "key", words, manifest, hybridEnabled: true, ...api })).mode).toBe("ai-only");
  });
  it("does not resend an ID/geometry rejection to whole-PDF AI-only", async () => {
    const api = clients(); api.hybrid.mockRejectedValue(new Error("manifest mismatch"));
    await expect(gradeUploadedWorksheet({ storageKey: "key", words, manifest, hybridEnabled: true, ...api })).rejects.toThrow("manifest mismatch");
    expect(api.aiOnly).not.toHaveBeenCalled();
  });
  it("excludes even inconsistent review/correct items from score and shows review not correct", () => {
    const summary = summarizeWorksheetResults([row, { ...row, number: 2, correct: true, needsReview: true }]);
    expect(summary).toMatchObject({ score: 1, total: 2, reviewCount: 1 });
    expect(summary.results[1].correct).toBe(false); expect(worksheetResultLabel(summary.results[1])).toBe("확인 필요");
  });
  it("keeps normal AI-only result labels", () => {
    expect(worksheetResultLabel(row)).toBe("정답"); expect(worksheetResultLabel({ ...row, correct: false })).toBe("오답 · 사과");
  });
  it.each([[{ ...row, confidence: .96 }, 96], [{ ...row, confidence: 96, source: "ocr" as const }, 96], [{ ...row, confidence: 1, source: "gemini" as const }, 1], [{ ...row, confidence: 95 }, 95]])("displays AI-only and hybrid confidence on the correct scale", (value, expected) => {
    expect(worksheetConfidencePercent(value)).toBe(expected);
  });
});

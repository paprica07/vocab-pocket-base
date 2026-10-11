import { PDFDocument } from "pdf-lib";
import { describe, expect, it, vi } from "vitest";
import type { InvokeParams, InvokeResult } from "../server/_core/llm";
import { gradeFixedLayoutPdfHybrid } from "../server/grading/hybrid-pipeline";
import { gradeFixedLayoutPdfWithPoppler } from "../server/grading/poppler-pipeline";
import { isPopplerAvailableSync } from "../server/grading/poppler-render";
import { collectReviewCrops } from "../server/grading/review-crops";
import type { OcrQuestion } from "../server/grading/types";
import { createExamPdfWithManifest, type WorksheetFixtureRow } from "./helpers/actual-worksheet";

function fixtureRows(studentAnswers: string[], expectedAnswers: string[] = studentAnswers): WorksheetFixtureRow[] {
  return studentAnswers.map((studentAnswer, index) => ({
    // Prompts are intentionally unique: app manifests reject duplicate source-term identities.
    prompt: `prompt-${index + 1}`,
    answer: expectedAnswers[index] ?? `answer-${index + 1}`,
    studentAnswer,
    direction: "engkor",
  }));
}
const key = (number: number, expected = "journey"): OcrQuestion => ({ number, term: "prompt", expected, answerKey: expected });
const reply = (results: unknown[]): InvokeResult => ({
  id: "mock", created: 0, model: "mock",
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ results }) }, finish_reason: "STOP" }],
});
const result = (number: number, answer: string, correct: boolean) => ({ number, answer, correct, confidence: 96, needsReview: false, note: "모의 Gemini 판독" });

// No network: actual OCR and image extraction; only Gemini is mocked.
describe.skipIf(!isPopplerAvailableSync())("Phase 2 real PDF hybrid integration", () => {
  it("makes no Gemini request for confirmed answers", async () => {
    const invoke = vi.fn();
    const worksheet = await createExamPdfWithManifest(fixtureRows(["journey", "banana"], ["journey", "apple"]));
    const out = await gradeFixedLayoutPdfHybrid(worksheet.pdfBytes, worksheet.manifest, { invoke });
    expect(invoke).not.toHaveBeenCalled();
    expect(out.results.map((item) => [item.source, item.correct, item.needsReview])).toEqual([["ocr", true, false], ["ocr", false, false]]);
  }, 60_000);

  it("uses one batch for multiple blanks, with local confirmed results unchanged", async () => {
    const worksheet = await createExamPdfWithManifest(fixtureRows(["journey", "", "banana", ""], ["journey", "apple", "apple", "curious"]));
    const base = await gradeFixedLayoutPdfWithPoppler(worksheet.pdfBytes, worksheet.manifest);
    const invoke = vi.fn(async (_request: InvokeParams) => reply([result(4, "", false), result(2, "", false)]));
    const out = await gradeFixedLayoutPdfHybrid(worksheet.pdfBytes, worksheet.manifest, { invoke });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(out.fallback).toMatchObject({ sentCount: 2, updatedCount: 2, resolvedCount: 2, batchCalls: 1 });
    expect(out.results[0]).toEqual(base[0]);
    expect(out.results[2]).toEqual(base[2]);
    expect(out.results[1]).toMatchObject({ source: "gemini", correct: false, needsReview: false });
  }, 60_000);

  it("maps sparse review crops across both pages and preserves manifest order/direction", async () => {
    const blanks = new Set([1, 27, 29]);
    const worksheet = await createExamPdfWithManifest(fixtureRows(
      Array.from({ length: 30 }, (_, index) => blanks.has(index) ? "" : "x2"),
      Array.from({ length: 30 }, () => "x2"),
    ));
    const base = await gradeFixedLayoutPdfWithPoppler(worksheet.pdfBytes, worksheet.manifest);
    const crops = await collectReviewCrops(worksheet.pdfBytes, worksheet.manifest, base);
    expect(crops.items.map((crop) => [crop.index, crop.pageNumber, crop.rowIndex, crop.question.number])).toEqual([
      [1, 1, 1, 2], [27, 2, 1, 28], [29, 2, 3, 30],
    ]);
    expect(crops.failures).toEqual([]);
    // Keep the old shuffled-response characterization, while the real app manifest uses 1..30.
    const invoke = vi.fn(async (_request: InvokeParams) => reply([result(30, "", false), result(2, "", false), result(28, "", false)]));
    const out = await gradeFixedLayoutPdfHybrid(worksheet.pdfBytes, worksheet.manifest, { invoke });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(out.results.map((item) => item.number)).toEqual(worksheet.manifest.questions.map((item) => item.number));
    expect(out.results.filter((item) => item.source === "gemini").map((item) => item.number)).toEqual([2, 28, 30]);
    expect(out.results.filter((item) => item.source === "ocr").every((item) => item.correct)).toBe(true);
  }, 180_000);

  it("retains all OCR results on fallback failure", async () => {
    const worksheet = await createExamPdfWithManifest(fixtureRows(["journey", ""], ["journey", "apple"]));
    const base = await gradeFixedLayoutPdfWithPoppler(worksheet.pdfBytes, worksheet.manifest);
    const out = await gradeFixedLayoutPdfHybrid(worksheet.pdfBytes, worksheet.manifest, { invoke: async () => { throw new Error("Gemini API failed: 429 Too Many Requests"); } });
    expect(out.results).toEqual(base);
    expect(out.fallback.errorCode).toBe("rate_limit");
  }, 60_000);

  it("gives review items wider overflow context without including the prompt column", async () => {
    const worksheet = await createExamPdfWithManifest(fixtureRows(["journey"]), { answerX: 310 });
    const base = await gradeFixedLayoutPdfWithPoppler(worksheet.pdfBytes, worksheet.manifest);
    expect(base[0].needsReview).toBe(true);
    const crops = await collectReviewCrops(worksheet.pdfBytes, worksheet.manifest, base);
    expect(crops.items).toHaveLength(1);
    expect(crops.items[0].touchesBoundary).toBe(false);
    const out = await gradeFixedLayoutPdfHybrid(worksheet.pdfBytes, worksheet.manifest, { invoke: async () => reply([result(1, "journey", true)]) });
    expect(out.results[0]).toMatchObject({ source: "gemini", answer: "journey", correct: true, needsReview: false });
  }, 60_000);

  it("does not invent crops for a missing page", async () => {
    const worksheet = await createExamPdfWithManifest(fixtureRows(Array.from({ length: 30 }, (_, index) => `journey${index + 1}`)));
    const pdf = await PDFDocument.load(worksheet.pdfBytes);
    pdf.removePage(1);
    const missingFirstPage = await pdf.save();
    const base = await gradeFixedLayoutPdfWithPoppler(missingFirstPage, worksheet.manifest);
    const crops = await collectReviewCrops(missingFirstPage, worksheet.manifest, base);
    expect(crops.items.some((item) => item.pageNumber === 2)).toBe(false);
    expect(crops.failures.length).toBeGreaterThan(0);
  }, 120_000);

  it("returns needsReview safely for invalid PDF and never calls Gemini", async () => {
    const invoke = vi.fn();
    const out = await gradeFixedLayoutPdfHybrid(Buffer.from("invalid PDF"), [key(1)], { invoke });
    expect(invoke).not.toHaveBeenCalled();
    expect(out.results[0]).toMatchObject({ source: "ocr", needsReview: true, correct: false });
  }, 60_000);

  it("rejects duplicate manifest numbers before any Gemini call", async () => {
    const invoke = vi.fn();
    await expect(gradeFixedLayoutPdfHybrid(Buffer.from("invalid"), [key(1), key(1)], { invoke })).rejects.toThrow("중복");
    expect(invoke).not.toHaveBeenCalled();
  });
});

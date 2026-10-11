import { gradeFixedLayoutPdfWithPoppler } from "./poppler-pipeline";
import { collectReviewCrops } from "./review-crops";
import { applyGeminiFallback, type FallbackSummary, type GeminiInvoker, type GradingTelemetry } from "./gemini-fallback";
import { OCR_DPI, type HybridQuestionResult, type WorksheetInput, type OcrQuestionResult } from "./types";
import type { PdfInput } from "./poppler-render";
import { inputQuestions } from "./manifest";
import { assertWorksheetManifest } from "../../lib/worksheet-layout";

export type HybridGradeResult = {
  results: HybridQuestionResult[];
  /** Additive metadata; the UI's existing { results: [...] } contract stays usable. */
  fallback: FallbackSummary;
};

export type HybridOptions = {
  dpi?: number;
  /** Tests can inject a mock. Production defaults to existing invokeLLM. */
  invoke?: GeminiInvoker;
  /** Opt-in safe metadata, never raw student content or credentials. */
  telemetry?: GradingTelemetry;
};

// Serialize hybrid calls within one Node process, keeping at most one hybrid OCR
// worker alive. No scheduler, daemon, route, or new infrastructure is introduced.
let queue: Promise<unknown> = Promise.resolve();

async function runHybrid(pdfBytes: PdfInput, input: WorksheetInput, options: HybridOptions): Promise<HybridGradeResult> {
  if (!Array.isArray(input)) assertWorksheetManifest(input);
  const questions = inputQuestions(input);
  if (questions.length > 200) throw new Error("문항은 최대 200개까지 처리할 수 있습니다.");
  const numbers = new Set<number>();
  for (const question of questions) {
    if (!Number.isInteger(question.number) || question.number < 1 || numbers.has(question.number)) {
      throw new Error("문항 번호는 중복 없는 양의 정수여야 합니다.");
    }
    numbers.add(question.number);
    if (typeof question.expected !== "string" || typeof question.answerKey !== "string") {
      throw new Error("정답키가 올바르지 않습니다.");
    }
  }
  const dpi = options.dpi ?? OCR_DPI;
  if (!Number.isFinite(dpi) || dpi < 72 || dpi > 300) throw new Error("OCR DPI는 72~300 범위여야 합니다.");
  if (!questions.length) return applyGeminiFallback([], [], options.invoke, options);

  let ocrResults: OcrQuestionResult[];
  try {
    ocrResults = await gradeFixedLayoutPdfWithPoppler(pdfBytes, input, dpi);
  } catch {
    // E.g. invalid/encrypted PDF or missing Poppler. No fabricated image/results.
    ocrResults = questions.map((question) => ({
      number: question.number, term: question.term, expected: question.expected,
      answer: "", correct: false, confidence: 0, needsReview: true, source: "ocr", note: "PDF/OCR 처리에 실패했습니다. 확인이 필요합니다.",
    }));
  }
  // gradeFixedLayoutPdfWithPoppler has already terminated its Tesseract worker.
  if (!ocrResults.some((result) => result.needsReview)) return applyGeminiFallback(ocrResults, [], options.invoke, options);
  const crops = await collectReviewCrops(pdfBytes, input, ocrResults, dpi);
  try {
    const graded = await applyGeminiFallback(ocrResults, crops.items, options.invoke, options);
    if (crops.failures.length && graded.fallback.status !== "failed") {
      graded.fallback.status = graded.fallback.updatedCount ? "partial" : "failed";
      graded.fallback.errorCode = "crop_failed";
      graded.fallback.message = "일부 문항 이미지를 추출하지 못했습니다. 해당 OCR 확인 대상은 유지합니다.";
    }
    return graded;
  } finally {
    // No image buffers/base64 strings are included in the API result or persisted.
    crops.items.length = 0;
  }
}

/**
 * PDF → Poppler → Tesseract → strict comparison → review-only Gemini batch.
 * Input MUST be the saved manifest including PDF identity and explicit placements.
 * This entry point is intentionally NOT connected to server/routers.ts/UI.
 */
export function gradeFixedLayoutPdfHybrid(
  pdfBytes: PdfInput,
  input: WorksheetInput,
  options: HybridOptions = {},
): Promise<HybridGradeResult> {
  const run = queue.then(() => runHybrid(pdfBytes, input, options));
  queue = run.then(() => undefined, () => undefined);
  return run;
}

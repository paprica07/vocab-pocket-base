import { fixedRowsPerPage } from "../../lib/worksheet-layout";
import { judgeOcrAnswer } from "./compare";
import { SingleOcrWorker, selectOcrScript } from "./ocr";
import { cropPlannedStripCell, detectPlannedAnswerOverflow, renderPdfPlannedAnswerStrip } from "./poppler-render";
import { inputQuestions, validatePdfManifest } from "./manifest";
import { OCR_DPI, type OcrQuestion, type OcrQuestionResult, type WorksheetInput } from "./types";

/** Diagnostic compatibility API. Grading no longer uses a rows-per-page estimate. */
export const rowsPerPage = fixedRowsPerPage;
const OVERFLOW_NOTE = "답안이 답안칸을 벗어난 것으로 보입니다. 확인이 필요합니다.";
function reviewResult(question: OcrQuestion, note: string): OcrQuestionResult {
  return { ...judgeOcrAnswer(question, "", 0, selectOcrScript(question.answerKey)), correct: false, needsReview: true, note };
}

/** Poppler → one Tesseract worker. Input positions come only from the saved plan. */
export async function gradeFixedLayoutPdfWithPoppler(
  pdfBytes: Uint8Array | ArrayBuffer, input: WorksheetInput, dpi = OCR_DPI,
): Promise<OcrQuestionResult[]> {
  const unplaced = inputQuestions(input);
  let validated: Awaited<ReturnType<typeof validatePdfManifest>>;
  try { validated = await validatePdfManifest(pdfBytes, input); }
  catch (error) { return unplaced.map(q => reviewResult(q, error instanceof Error ? error.message : "PDF/layout manifest 검증 실패")); }
  const questions = validated.questions;
  const worker = new SingleOcrWorker();
  const results = new Array<OcrQuestionResult>(questions.length);
  try {
    const pages = [...new Set(questions.map(q => q.pageNumber))];
    for (const pageNumber of pages) {
      const pageItems = questions.map((q, index) => ({ q, index })).filter(({ q }) => q.pageNumber === pageNumber);
      let strip: Awaited<ReturnType<typeof renderPdfPlannedAnswerStrip>> | undefined;
      try {
        strip = await renderPdfPlannedAnswerStrip(pdfBytes, pageNumber, pageItems.map(({ q }) => q.answerRect), dpi);
        const overflow = await detectPlannedAnswerOverflow(strip, pageItems.map(({ q }) => q.answerRect), dpi);
        for (let row = 0; row < pageItems.length; row += 1) {
          const { q, index } = pageItems[row];
          try {
            const cell = await cropPlannedStripCell(strip, q.answerRect, dpi);
            const recognized = await worker.recognize(cell, q.answerKey);
            const judged = judgeOcrAnswer(q, recognized.text, recognized.confidence, recognized.script);
            results[index] = overflow[row]?.overflow
              ? { ...judged, correct: false, needsReview: true, note: OVERFLOW_NOTE } : judged;
          } catch (error) { results[index] = reviewResult(q, error instanceof Error ? `답안 영역/OCR 처리 실패: ${error.message}` : "답안 처리 실패"); }
        }
      } catch (error) {
        for (const { q, index } of pageItems) results[index] = reviewResult(q, error instanceof Error ? `PDF 페이지 처리 실패: ${error.message}` : "PDF 페이지 처리 실패");
      } finally { strip = undefined; }
    }
    return results.map(result => result.needsReview ? { ...result, correct: false } : result);
  } finally { await worker.close(); }
}
export type { OcrQuestion, OcrQuestionResult } from "./types";

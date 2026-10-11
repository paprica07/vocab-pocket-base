import { createCanvas, loadImage } from "@napi-rs/canvas";
import { judgeOcrAnswer } from "./compare";
import { SingleOcrWorker, selectOcrScript } from "./ocr";
import { renderPdfPage, type PdfInput } from "./raster";
import { inputQuestions, validatePdfManifest } from "./manifest";
import { FIXED_LAYOUT, OCR_DPI, type OcrQuestion, type OcrQuestionResult, type WorksheetInput } from "./types";
function reviewResult(question: OcrQuestion, note: string): OcrQuestionResult {
  return { ...judgeOcrAnswer(question, "", 0, selectOcrScript(question.answerKey)), correct: false, needsReview: true, note };
}
/** Preserved pdf.js path. Only layout mapping changes; renderer is unchanged. */
export async function gradeFixedLayoutPdf(pdfBytes: PdfInput, input: WorksheetInput, dpi = OCR_DPI): Promise<OcrQuestionResult[]> {
  let validated: Awaited<ReturnType<typeof validatePdfManifest>>;
  try { validated = await validatePdfManifest(pdfBytes, input); }
  catch (error) { return inputQuestions(input).map(q => reviewResult(q, error instanceof Error ? error.message : "layout 검증 실패")); }
  const questions = validated.questions, results = new Array<OcrQuestionResult>(questions.length), worker = new SingleOcrWorker();
  try {
    for (const pageNumber of [...new Set(questions.map(q => q.pageNumber))]) {
      const entries = questions.map((q, index) => ({ q, index })).filter(({ q }) => q.pageNumber === pageNumber);
      try {
        const page = await renderPdfPage(pdfBytes, pageNumber, dpi);
        const image = await loadImage(page.png);
        for (const { q, index } of entries) {
          try {
            const s = dpi / 72, r = q.answerRect;
            const x = Math.round(r.x * s), y = Math.round(r.y * s), w = Math.round(r.width * s), h = Math.round(r.height * s);
            if (x < 0 || y < 0 || x + w > image.width || y + h > image.height) throw new Error("답안 영역이 페이지 밖에 있습니다.");
            const canvas = createCanvas(w, h);
            try {
              canvas.getContext("2d").drawImage(image, x, y, w, h, 0, 0, w, h);
              const recognized = await worker.recognize(canvas.toBuffer("image/png"), q.answerKey);
              results[index] = judgeOcrAnswer(q, recognized.text, recognized.confidence, recognized.script);
            } finally { canvas.width = 1; canvas.height = 1; }
          } catch (error) { results[index] = reviewResult(q, error instanceof Error ? error.message : "답안 처리 실패"); }
        }
      } catch (error) { for (const { q, index } of entries) results[index] = reviewResult(q, error instanceof Error ? error.message : "PDF 처리 실패"); }
    }
    return results;
  } finally { await worker.close(); }
}
export { FIXED_LAYOUT };
export type { OcrQuestion, OcrQuestionResult } from "./types";

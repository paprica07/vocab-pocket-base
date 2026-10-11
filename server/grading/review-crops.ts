import { createCanvas, loadImage } from "@napi-rs/canvas";
import {
  getPlannedCellRectInStrip, POPPLER_CROP_PADDING_Y, POPPLER_OVERFLOW_BAND_PT,
  renderPdfPlannedAnswerStrip, type PdfInput,
} from "./poppler-render";
import { validatePdfManifest } from "./manifest";
import { FIXED_LAYOUT, OCR_DPI, type OcrQuestion, type OcrQuestionResult, type WorksheetInput } from "./types";
export type ReviewCrop = { question: OcrQuestion; index: number; pageNumber: number; rowIndex: number; png: Buffer; touchesBoundary: boolean };
export type ReviewCropCollection = { items: ReviewCrop[]; failures: Array<{ number: number; reason: string }> };
export const MAX_REVIEW_CROP_BYTES = 8 * 1024 * 1024;
function boundaryHasInk(pixels: Uint8ClampedArray, width: number, height: number) {
  let dark = 0;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    if (x >= 2 && x < width - 2 && y >= 2 && y < height - 2) continue;
    const offset = (y * width + x) * 4;
    if (0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2] < 160 && ++dark >= 12) return true;
  }
  return false;
}
/** Re-render only review pages with the exact saved placements, after OCR closes. */
export async function collectReviewCrops(pdfBytes: PdfInput, input: WorksheetInput, results: OcrQuestionResult[], dpi = OCR_DPI): Promise<ReviewCropCollection> {
  const items: ReviewCrop[] = [], failures: ReviewCropCollection["failures"] = [];
  const pending = results.map((result, index) => ({ result, index })).filter(({ result }) => result.needsReview);
  if (!pending.length) return { items, failures };
  let validated: Awaited<ReturnType<typeof validatePdfManifest>>;
  try { validated = await validatePdfManifest(pdfBytes, input); }
  catch { return { items, failures: pending.map(({ result }) => ({ number: result.number, reason: "PDF와 저장된 manifest 위치를 확인하지 못했습니다." })) }; }
  const { questions } = validated;
  const padX = Math.max(3, Math.floor((FIXED_LAYOUT.answerX - POPPLER_OVERFLOW_BAND_PT - FIXED_LAYOUT.separatorX - 4) * dpi / 72));
  const eligible = pending.filter(({ result, index }) => {
    if (questions[index]?.number === result.number) return true;
    failures.push({ number: result.number, reason: "결과와 manifest 문항 번호가 다릅니다." }); return false;
  });
  let totalBytes = 0;
  const pages = [...new Set(eligible.map(({ index }) => questions[index].pageNumber))];
  for (const pageNumber of pages) {
    const pageItems = eligible.filter(({ index }) => questions[index].pageNumber === pageNumber);
    let strip: Awaited<ReturnType<typeof renderPdfPlannedAnswerStrip>> | undefined;
    let image: Awaited<ReturnType<typeof loadImage>> | undefined;
    try {
      strip = await renderPdfPlannedAnswerStrip(pdfBytes, pageNumber, pageItems.map(({ index }) => questions[index].answerRect), dpi, padX, POPPLER_CROP_PADDING_Y);
      image = await loadImage(strip.png);
      for (const { result, index } of pageItems) {
        try {
          const question = questions[index];
          const rect = getPlannedCellRectInStrip(strip, question.answerRect, dpi, padX, POPPLER_CROP_PADDING_Y);
          if (rect.y < 0 || rect.y + rect.height > image.height) throw new Error("행 범위를 벗어났습니다.");
          const canvas = createCanvas(image.width, rect.height);
          try {
            const context = canvas.getContext("2d");
            context.fillStyle = "#ffffff"; context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, 0, rect.y, image.width, rect.height, 0, 0, image.width, rect.height);
            const touchesBoundary = boundaryHasInk(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
            const png = canvas.toBuffer("image/png");
            if (totalBytes + png.length > MAX_REVIEW_CROP_BYTES) throw new Error("배치 이미지 용량 제한을 초과했습니다.");
            totalBytes += png.length;
            items.push({ question, index, pageNumber, rowIndex: question.rowIndex, png, touchesBoundary });
          } finally { canvas.width = 1; canvas.height = 1; }
        } catch (error) { failures.push({ number: result.number, reason: error instanceof Error ? error.message : "답안 crop 실패" }); }
      }
    } catch { failures.push(...pageItems.map(({ result }) => ({ number: result.number, reason: "확인 대상 페이지 crop 실패" }))); }
    finally { image = undefined; strip = undefined; }
  }
  return { items, failures };
}

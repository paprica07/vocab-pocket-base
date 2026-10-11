import { createCanvas, loadImage } from "@napi-rs/canvas";
import { FIXED_LAYOUT, OCR_DPI } from "./types";

export type CropRect = { x: number; y: number; width: number; height: number };

export type CropResult = {
  png: Buffer;
  rect: CropRect;
};

/**
 * Return the answer cell for a zero-based row on a rendered page.
 * The crop intentionally excludes the number, prompt and underline label.
 */
export function getAnswerCropRect(
  rowIndex: number,
  dpi = OCR_DPI,
  layout = FIXED_LAYOUT,
): CropRect {
  if (!Number.isInteger(rowIndex) || rowIndex < 0) {
    throw new Error(`잘못된 문항 행 번호입니다: ${rowIndex}`);
  }

  const scale = dpi / 72;
  const firstRowY = layout.pageHeight - layout.margin - layout.headerHeight;
  const rowHeight = layout.lineHeight + layout.rowGap;
  const baselineY = firstRowY - rowIndex * rowHeight;
  const topPdfY = baselineY + layout.fontSize + 3;
  const bottomPdfY = baselineY - 7;

  return {
    x: Math.round(layout.answerX * scale),
    y: Math.round((layout.pageHeight - topPdfY) * scale),
    width: Math.round((layout.answerRight - layout.answerX) * scale),
    height: Math.max(1, Math.round((topPdfY - bottomPdfY) * scale)),
  };
}

export async function cropAnswerCell(
  pagePng: Buffer,
  rowIndex: number,
  dpi = OCR_DPI,
): Promise<CropResult> {
  const image = await loadImage(pagePng);
  const rect = getAnswerCropRect(rowIndex, dpi);
  const pageCanvas = createCanvas(image.width, image.height);
  pageCanvas.getContext("2d").drawImage(image, 0, 0);

  const clipped = createCanvas(rect.width, rect.height);
  const context = clipped.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, rect.width, rect.height);

  const right = Math.min(rect.x + rect.width, pageCanvas.width);
  const bottom = Math.min(rect.y + rect.height, pageCanvas.height);
  if (rect.x < 0 || rect.y < 0 || right <= rect.x || bottom <= rect.y) {
    throw new Error(`답안 영역이 페이지 밖에 있습니다: row=${rowIndex}`);
  }

  context.drawImage(
    pageCanvas,
    rect.x,
    rect.y,
    right - rect.x,
    bottom - rect.y,
    0,
    0,
    right - rect.x,
    bottom - rect.y,
  );
  return { png: clipped.toBuffer("image/png"), rect };
}

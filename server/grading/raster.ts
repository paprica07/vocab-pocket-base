import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import path from "node:path";
import { FIXED_LAYOUT, OCR_DPI } from "./types";

export type PdfInput = Uint8Array | ArrayBuffer;

export type RasterPage = {
  pageNumber: number;
  width: number;
  height: number;
  png: Buffer;
};

const standardFontDataUrl = path.join(
  process.cwd(),
  "node_modules",
  "pdfjs-dist",
  "standard_fonts",
  path.sep,
);

function toUint8Array(input: PdfInput) {
  // pdfjs transfers the data to its worker. A Node Buffer subclass is rejected
  // by that transfer path, so always pass a plain copied Uint8Array.
  return input instanceof ArrayBuffer ? new Uint8Array(input) : Uint8Array.from(input);
}

/** Render one PDF page at a time so the full document is never retained. */
export async function renderPdfPage(
  pdfBytes: PdfInput,
  pageNumber: number,
  dpi = OCR_DPI,
): Promise<RasterPage> {
  const document = await pdfjs.getDocument({
    data: toUint8Array(pdfBytes),
    useSystemFonts: false,
    disableFontFace: false,
    standardFontDataUrl,
  }).promise;

  try {
    if (pageNumber < 1 || pageNumber > document.numPages) {
      throw new Error(`PDF 페이지 범위를 벗어났습니다: ${pageNumber}/${document.numPages}`);
    }

    const page = await document.getPage(pageNumber);
    const scale = dpi / 72;
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
    }).promise;

    return {
      pageNumber,
      width: canvas.width,
      height: canvas.height,
      png: canvas.toBuffer("image/png"),
    };
  } finally {
    await document.destroy();
  }
}

export function getPdfPageCount(pdfBytes: PdfInput) {
  return pdfjs.getDocument({
    data: toUint8Array(pdfBytes),
    useSystemFonts: false,
    standardFontDataUrl,
  }).promise.then(async (document) => {
    try {
      return document.numPages;
    } finally {
      await document.destroy();
    }
  });
}

export { FIXED_LAYOUT };

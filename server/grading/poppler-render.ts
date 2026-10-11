import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { getAnswerCropRect, type CropRect } from "./crop";
import { FIXED_LAYOUT, OCR_DPI, type FixedLayout } from "./types";
import type { AnswerRect } from "../../lib/worksheet-layout";

/**
 * Poppler based renderer (Phase 1.5).
 *
 * This module is additive: the existing pdf.js renderer in ./raster.ts stays in
 * place and untouched. Poppler is used because the pdf.js + @napi-rs/canvas path
 * needs ~500MB RSS for a single page, which is not safe on a 512MB instance.
 *
 * Poppler is invoked as an OS process, so its memory is released as soon as the
 * process exits. Only one render runs at a time (see withRenderLock) and every
 * temporary file is removed before the call resolves.
 */

export type PdfInput = Uint8Array | ArrayBuffer;

export type PopplerPage = {
  pageNumber: number;
  width: number;
  height: number;
  png: Buffer;
};

export type PopplerStrip = PopplerPage & { rect: CropRect };

const RENDER_BINARY = "pdftoppm";
const INFO_BINARY = "pdfinfo";
const COMMAND_TIMEOUT_MS = 60_000;
const MAX_ERROR_CHARS = 400;

/**
 * Poppler starts the first glyph slightly further left than pdf.js, so the raw
 * answer cell can clip it (measured: the leading "ㅎ" of "호기심이 많은" was lost).
 * A few pixels of padding recover the whole syllable while staying far away from
 * the prompt column, which ends at separatorX = 300pt.
 */
export const POPPLER_CROP_PADDING_X = 3;
export const POPPLER_CROP_PADDING_Y = 2;

/**
 * 답안칸 이탈 감지용 좌우 밴드입니다. 답안칸 경계 바로 옆 GUARD_PT 구간은
 * 안티앨리어싱 여유로 제외하고, 그 바깥 BAND_PT 구간에 잉크가 일정량 이상
 * 있으면 답안이 답안칸을 벗어난 것으로 판단합니다.
 * 시험지의 문항 열은 300pt에서 끝나고 밑줄은 답안칸 안에서 끝나므로 두 밴드는
 * 정상 답안에서는 비어 있습니다.
 */
export const POPPLER_OVERFLOW_BAND_PT = 10;
export const POPPLER_OVERFLOW_GUARD_PT = 2;
export const POPPLER_OVERFLOW_INK_THRESHOLD = 12;
const INK_LUMINANCE_THRESHOLD = 160;

function toBuffer(input: PdfInput) {
  return input instanceof ArrayBuffer ? Buffer.from(new Uint8Array(input)) : Buffer.from(input);
}

function runCommand(command: string, args: string[]) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { timeout: COMMAND_TIMEOUT_MS, killSignal: "SIGKILL" });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      reject(new Error(`${command} 실행에 실패했습니다: ${error.message}`));
    });
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim().slice(0, MAX_ERROR_CHARS);
      reject(new Error(`${command} 종료 코드 ${code ?? signal ?? "unknown"}${detail ? `: ${detail}` : ""}`));
    });
  });
}

let availabilityCache: boolean | null = null;

/** Synchronous probe, intended for test guards and startup diagnostics. */
export function isPopplerAvailableSync() {
  const probe = spawnSync(RENDER_BINARY, ["-v"], { timeout: 10_000 });
  return !probe.error && probe.status === 0;
}

export async function isPopplerAvailable() {
  if (availabilityCache !== null) return availabilityCache;
  availabilityCache = await runCommand(RENDER_BINARY, ["-v"]).then(
    () => true,
    () => false,
  );
  return availabilityCache;
}

export async function getPopplerVersion() {
  try {
    const { stdout, stderr } = await runCommand(RENDER_BINARY, ["-v"]);
    const line = `${stdout}\n${stderr}`
      .split("\n")
      .map((value) => value.trim())
      .find((value) => value.length > 0);
    return line ?? null;
  } catch {
    return null;
  }
}

/**
 * Render at most one PDF region at a time. Render Free gives a single small
 * instance, so serialising the Poppler processes keeps the peak predictable.
 */
let renderQueue: Promise<unknown> = Promise.resolve();

function withRenderLock<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task, task);
  renderQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function withTempDir<T>(task: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vocab-pocket-poppler-"));
  try {
    return await task(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Bounding box of the answer cells for `rowCount` rows, in rendered pixels.
 * The geometry comes from crop.ts so both renderers crop exactly the same area.
 */
function expandRect(rect: CropRect, padX: number, padY: number, dpi: number, layout: FixedLayout): CropRect {
  const scale = dpi / 72;
  const pageWidth = Math.round(layout.pageWidth * scale);
  const pageHeight = Math.round(layout.pageHeight * scale);
  const x = Math.max(0, rect.x - padX);
  const y = Math.max(0, rect.y - padY);
  const right = Math.min(pageWidth, rect.x + rect.width + padX);
  const bottom = Math.min(pageHeight, rect.y + rect.height + padY);
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

function bandPx(dpi: number) {
  return Math.round((POPPLER_OVERFLOW_BAND_PT * dpi) / 72);
}

function guardPx(dpi: number) {
  return Math.round((POPPLER_OVERFLOW_GUARD_PT * dpi) / 72);
}

/** 답안칸 영역과 좌우 이탈 감지 밴드를 합친 영역(패딩 적용 전). */
function stripBaseRect(rowCount: number, dpi: number, layout: FixedLayout): CropRect {
  const first = getAnswerCropRect(0, dpi, layout);
  const last = getAnswerCropRect(rowCount - 1, dpi, layout);
  const band = bandPx(dpi);
  return {
    x: first.x - band,
    y: first.y,
    width: first.width + band * 2,
    height: last.y + last.height - first.y,
  };
}

export function getAnswerStripRect(
  rowCount: number,
  dpi = OCR_DPI,
  layout = FIXED_LAYOUT,
  padX = POPPLER_CROP_PADDING_X,
  padY = POPPLER_CROP_PADDING_Y,
): CropRect {
  if (!Number.isInteger(rowCount) || rowCount < 1) {
    throw new Error(`잘못된 문항 행 수입니다: ${rowCount}`);
  }
  return expandRect(stripBaseRect(rowCount, dpi, layout), padX, padY, dpi, layout);
}

/** 답안칸 한 칸의 사각형을 스트립 좌표로 반환합니다. */
export function getAnswerCellRectInStrip(
  rowIndex: number,
  dpi = OCR_DPI,
  layout = FIXED_LAYOUT,
  padX = POPPLER_CROP_PADDING_X,
  padY = POPPLER_CROP_PADDING_Y,
): CropRect {
  const strip = getAnswerStripRect(rowIndex + 1, dpi, layout, padX, padY);
  const cell = expandRect(getAnswerCropRect(rowIndex, dpi, layout), padX, padY, dpi, layout);
  return { x: cell.x - strip.x, y: cell.y - strip.y, width: cell.width, height: cell.height };
}

/** 답안칸 좌우 이탈 감지 밴드를 스트립 좌표로 반환합니다. */
export function getAnswerOverflowBandsInStrip(
  rowIndex: number,
  dpi = OCR_DPI,
  layout = FIXED_LAYOUT,
  padX = POPPLER_CROP_PADDING_X,
  padY = POPPLER_CROP_PADDING_Y,
) {
  const strip = getAnswerStripRect(rowIndex + 1, dpi, layout, padX, padY);
  const cell = expandRect(getAnswerCropRect(rowIndex, dpi, layout), padX, padY, dpi, layout);
  const width = Math.max(1, bandPx(dpi) - guardPx(dpi));
  const y = cell.y - strip.y;
  return {
    left: { x: padX, y, width, height: cell.height },
    right: { x: cell.x + cell.width + guardPx(dpi) - strip.x, y, width, height: cell.height },
  };
}

export async function getPdfPageCount(pdfBytes: PdfInput) {
  return withTempDir(async (dir) => {
    const inputPath = path.join(dir, "input.pdf");
    await writeFile(inputPath, toBuffer(pdfBytes));
    const { stdout } = await runCommand(INFO_BINARY, [inputPath]);
    const match = stdout.match(/^Pages:\s+(\d+)/m);
    if (!match) throw new Error("PDF 페이지 수를 확인하지 못했습니다.");
    return Number.parseInt(match[1], 10);
  });
}

/** Metadata-only native inspection: do not load embedded font/image objects in Node. */
export async function getPdfDocumentInfo(pdfBytes: PdfInput) {
  return withTempDir(async dir => {
    const inputPath = path.join(dir, "input.pdf");
    await writeFile(inputPath, toBuffer(pdfBytes));
    const { stdout } = await runCommand(INFO_BINARY, ["-f", "1", "-l", "200", inputPath]);
    const pageCount = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1]);
    const subject = /^Subject:\s*(.*)$/m.exec(stdout)?.[1] ?? "";
    const sizes = [...stdout.matchAll(/^Page\s+(\d+) size:\s+([\d.]+) x ([\d.]+) pts/gm)]
      .map(m => ({ pageNumber: Number(m[1]), width: Number(m[2]), height: Number(m[3]) }));
    const rotations = new Map([...stdout.matchAll(/^Page\s+(\d+) rot:\s+(-?\d+)/gm)].map(m => [Number(m[1]), Number(m[2])]));
    if (!Number.isInteger(pageCount) || pageCount < 1 || sizes.length !== pageCount) throw new Error("PDF 페이지 규격을 확인하지 못했습니다.");
    return { pageCount, subject, pages: sizes.map(page => ({ ...page, rotation: rotations.get(page.pageNumber) })) };
  });
}

async function renderRegion(
  pdfBytes: PdfInput,
  pageNumber: number,
  dpi: number,
  rect: CropRect | null,
): Promise<PopplerPage> {
  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new Error(`잘못된 PDF 페이지 번호입니다: ${pageNumber}`);
  }

  return withTempDir(async (dir) => {
    const inputPath = path.join(dir, "input.pdf");
    const outputPrefix = path.join(dir, "page");
    await writeFile(inputPath, toBuffer(pdfBytes));

    const args = ["-png", "-r", String(dpi), "-f", String(pageNumber), "-l", String(pageNumber)];
    if (rect) {
      args.push("-x", String(rect.x), "-y", String(rect.y), "-W", String(rect.width), "-H", String(rect.height));
    }
    args.push("-singlefile", inputPath, outputPrefix);

    await runCommand(RENDER_BINARY, args);

    const png = await readFile(`${outputPrefix}.png`);
    const image = await loadImage(png);
    return { pageNumber, width: image.width, height: image.height, png };
  });
}

/** Full page render. Kept for parity checks against the pdf.js renderer. */
export function renderPdfPage(pdfBytes: PdfInput, pageNumber: number, dpi = OCR_DPI) {
  return withRenderLock(() => renderRegion(pdfBytes, pageNumber, dpi, null));
}

/**
 * Render only the answer column for the given rows. This avoids materialising a
 * full page bitmap and is the memory-safe path for Render Free.
 */
export async function renderPdfAnswerStrip(
  pdfBytes: PdfInput,
  pageNumber: number,
  rowCount: number,
  dpi = OCR_DPI,
  padX = POPPLER_CROP_PADDING_X,
  padY = POPPLER_CROP_PADDING_Y,
): Promise<PopplerStrip> {
  const rect = getAnswerStripRect(rowCount, dpi, FIXED_LAYOUT, padX, padY);
  const page = await withRenderLock(() => renderRegion(pdfBytes, pageNumber, dpi, rect));
  return { ...page, rect };
}

/** Explicit manifest rectangles replace independently inferred row indices. */
export function plannedAnswerRect(rect: AnswerRect, dpi = OCR_DPI): CropRect {
  const scale = dpi / 72;
  return { x: Math.round(rect.x * scale), y: Math.round(rect.y * scale),
    width: Math.round(rect.width * scale), height: Math.round(rect.height * scale) };
}

export function getPlannedStripRect(rectangles: AnswerRect[], dpi = OCR_DPI, padX = POPPLER_CROP_PADDING_X, padY = POPPLER_CROP_PADDING_Y): CropRect {
  if (!rectangles.length) throw new Error("렌더링할 manifest 답안 영역이 없습니다.");
  const cells = rectangles.map(rect => plannedAnswerRect(rect, dpi));
  const x = Math.min(...cells.map(c => c.x)) - bandPx(dpi);
  const y = Math.min(...cells.map(c => c.y));
  const right = Math.max(...cells.map(c => c.x + c.width)) + bandPx(dpi);
  const bottom = Math.max(...cells.map(c => c.y + c.height));
  return expandRect({ x, y, width: right - x, height: bottom - y }, padX, padY, dpi, FIXED_LAYOUT);
}

export async function renderPdfPlannedAnswerStrip(pdfBytes: PdfInput, pageNumber: number, rectangles: AnswerRect[], dpi = OCR_DPI, padX = POPPLER_CROP_PADDING_X, padY = POPPLER_CROP_PADDING_Y): Promise<PopplerStrip> {
  const rect = getPlannedStripRect(rectangles, dpi, padX, padY);
  const page = await withRenderLock(() => renderRegion(pdfBytes, pageNumber, dpi, rect));
  return { ...page, rect };
}

export function getPlannedCellRectInStrip(strip: PopplerStrip, answerRect: AnswerRect, dpi = OCR_DPI, padX = POPPLER_CROP_PADDING_X, padY = POPPLER_CROP_PADDING_Y): CropRect {
  const cell = expandRect(plannedAnswerRect(answerRect, dpi), padX, padY, dpi, FIXED_LAYOUT);
  return { ...cell, x: cell.x - strip.rect.x, y: cell.y - strip.rect.y };
}

export async function cropPlannedStripCell(strip: PopplerStrip, answerRect: AnswerRect, dpi = OCR_DPI) {
  const rect = getPlannedCellRectInStrip(strip, answerRect, dpi);
  const image = await loadImage(strip.png);
  if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > image.width || rect.y + rect.height > image.height) {
    throw new Error("manifest 답안 영역이 렌더 범위를 벗어났습니다.");
  }
  const canvas = createCanvas(rect.width, rect.height);
  try {
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff"; context.fillRect(0, 0, rect.width, rect.height);
    context.drawImage(image, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    return canvas.toBuffer("image/png");
  } finally { canvas.width = 1; canvas.height = 1; }
}

export async function detectPlannedAnswerOverflow(strip: PopplerStrip, rectangles: AnswerRect[], dpi = OCR_DPI): Promise<AnswerOverflow[]> {
  const image = await loadImage(strip.png);
  return rectangles.map((answerRect, row) => {
    const cell = getPlannedCellRectInStrip(strip, answerRect, dpi);
    const raw = plannedAnswerRect(answerRect, dpi);
    const width = Math.max(1, bandPx(dpi) - guardPx(dpi));
    const left = { x: raw.x - bandPx(dpi) - strip.rect.x, y: cell.y, width, height: cell.height };
    const right = { x: cell.x + cell.width + guardPx(dpi), y: cell.y, width, height: cell.height };
    const leftInk = countDarkPixels(image, left), rightInk = countDarkPixels(image, right);
    return { row, leftInk, rightInk, overflow: leftInk + rightInk >= POPPLER_OVERFLOW_INK_THRESHOLD };
  });
}

/** Crop one answer cell out of a strip rendered by renderPdfAnswerStrip. */
export async function cropStripRow(
  stripPng: Buffer,
  rowIndex: number,
  dpi = OCR_DPI,
  padX = POPPLER_CROP_PADDING_X,
  padY = POPPLER_CROP_PADDING_Y,
) {
  const rect = getAnswerCellRectInStrip(rowIndex, dpi, FIXED_LAYOUT, padX, padY);
  const image = await loadImage(stripPng);
  const right = Math.min(rect.x + rect.width, image.width);
  const bottom = Math.min(rect.y + rect.height, image.height);
  if (rect.x < 0 || rect.y < 0 || right <= rect.x || bottom <= rect.y) {
    throw new Error(`답안 영역이 렌더 범위를 벗어났습니다: row=${rowIndex}`);
  }

  const canvas = createCanvas(rect.width, rect.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, rect.width, rect.height);
  context.drawImage(image, rect.x, rect.y, right - rect.x, bottom - rect.y, 0, 0, right - rect.x, bottom - rect.y);
  return canvas.toBuffer("image/png");
}

export type AnswerOverflow = {
  row: number;
  overflow: boolean;
  leftInk: number;
  rightInk: number;
};

type StripImage = Awaited<ReturnType<typeof loadImage>>;

function countDarkPixels(image: StripImage, rect: CropRect) {
  if (rect.x < 0 || rect.y < 0 || rect.x >= image.width || rect.y >= image.height) return 0;
  const width = Math.max(1, Math.min(rect.width, image.width - rect.x));
  const height = Math.max(1, Math.min(rect.height, image.height - rect.y));

  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, rect.x, rect.y, width, height, 0, 0, width, height);

  const { data } = context.getImageData(0, 0, width, height);
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    const luminance = 0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2];
    if (luminance < INK_LUMINANCE_THRESHOLD) count += 1;
  }
  return count;
}

function measureRowOverflow(
  image: StripImage,
  rowIndex: number,
  dpi: number,
  padX: number,
  padY: number,
): AnswerOverflow {
  const bands = getAnswerOverflowBandsInStrip(rowIndex, dpi, FIXED_LAYOUT, padX, padY);
  const leftInk = countDarkPixels(image, bands.left);
  const rightInk = countDarkPixels(image, bands.right);
  return {
    row: rowIndex,
    leftInk,
    rightInk,
    overflow: leftInk + rightInk >= POPPLER_OVERFLOW_INK_THRESHOLD,
  };
}

/**
 * 답안칸 좌우 밴드의 잉크를 세어 답안이 답안칸을 벗어났는지 판단합니다.
 * 스트립 PNG는 한 번만 디코딩하고 행마다 밴드만 잘라 셉니다.
 */
export async function detectAnswerOverflowForRows(
  stripPng: Buffer,
  rowCount: number,
  dpi = OCR_DPI,
  padX = POPPLER_CROP_PADDING_X,
  padY = POPPLER_CROP_PADDING_Y,
): Promise<AnswerOverflow[]> {
  const image = await loadImage(stripPng);
  return Array.from({ length: rowCount }, (_, row) => measureRowOverflow(image, row, dpi, padX, padY));
}

export async function detectAnswerOverflow(
  stripPng: Buffer,
  rowIndex: number,
  dpi = OCR_DPI,
  padX = POPPLER_CROP_PADDING_X,
  padY = POPPLER_CROP_PADDING_Y,
): Promise<AnswerOverflow> {
  const image = await loadImage(stripPng);
  return measureRowOverflow(image, rowIndex, dpi, padX, padY);
}

export { FIXED_LAYOUT };

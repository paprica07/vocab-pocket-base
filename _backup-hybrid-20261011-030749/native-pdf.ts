import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";
import fontkit from "@pdf-lib/fontkit";
import { Platform } from "react-native";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib/dist/pdf-lib.esm.js";
import {
  WORKSHEET_LAYOUT, assertWorksheetManifest, buildWorksheetManifest, wrapWorksheetText, worksheetPdfMarker,
  type PdfQuestion, type WorksheetManifest,
} from "./worksheet-layout";
export { WORKSHEET_LAYOUT } from "./worksheet-layout";
export type { PdfQuestion, WorksheetManifest } from "./worksheet-layout";

const koreanFont = require("../assets/fonts/NotoSansCJK-Regular.otf");
let cachedFontBytes: Uint8Array | null = null;
async function loadFontBytes() {
  if (cachedFontBytes) return cachedFontBytes;
  const asset = Asset.fromModule(koreanFont);
  await asset.downloadAsync();
  if (!asset.localUri) throw new Error("Korean font could not be loaded");
  if (Platform.OS === "web") {
    const response = await fetch(asset.localUri);
    cachedFontBytes = new Uint8Array(await response.arrayBuffer());
    return cachedFontBytes;
  }
  const base64 = await FileSystem.readAsStringAsync(asset.localUri, { encoding: FileSystem.EncodingType.Base64 });
  const binary = globalThis.atob ? globalThis.atob(base64) : base64;
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  cachedFontBytes = bytes;
  return cachedFontBytes;
}
function toBase64(bytes: Uint8Array) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return globalThis.btoa(binary);
}

async function createPdf(input: PdfQuestion[] | WorksheetManifest, answerMode: boolean, options: { inputText?: string; examId?: string } = {}) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const korean = await pdf.embedFont(await loadFontBytes(), { subset: false });
  const latin = await pdf.embedFont(StandardFonts.Helvetica);
  const measure = (text: string) => korean.widthOfTextAtSize(text, WORKSHEET_LAYOUT.fontSize);
  const manifest = Array.isArray(input) ? buildWorksheetManifest(input, measure, options) : input;
  assertWorksheetManifest(manifest);
  const { pageWidth, pageHeight, margin, numberX, promptX, separatorX, answerX, lineHeight, fontSize } = WORKSHEET_LAYOUT;
  const title = answerMode ? "Vocab Pocket 답안지" : "Vocab Pocket 시험지";
  const subtitle = answerMode ? "시험지의 정답을 확인하세요." : "영어 단어를 보고 뜻을 적어 보세요.";
  const pages = Array.from({ length: manifest.pageCount }, () => {
    const page = pdf.addPage([pageWidth, pageHeight]);
    page.drawText(title, { x: margin, y: pageHeight - margin, size: 21, font: korean, color: rgb(0.04, 0.49, 0.64) });
    page.drawText(subtitle, { x: margin, y: pageHeight - margin - 25, size: 10, font: korean, color: rgb(0.4, 0.44, 0.46) });
    return page;
  });
  manifest.questions.forEach(question => {
    const page = pages[question.pageNumber - 1];
    const y = question.baselineY;
    page.drawText(`${question.number}.`, { x: numberX, y, size: fontSize, font: latin, color: rgb(0.07, 0.09, 0.11) });
    if (answerMode) {
      const lines = wrapWorksheetText(question.answer || "답안 없음", measure, pageWidth - answerX - margin);
      // Do not silently move following questions or clip long key text to fit a saved exam.
      if (lines.length * lineHeight + WORKSHEET_LAYOUT.rowGap > question.rowHeight) {
        throw new Error(`${question.number}번 정답이 저장된 시험지 행보다 깁니다. 답안지 배치를 확인해 주세요.`);
      }
      lines.forEach((line, i) => page.drawText(line, { x: promptX, y: y - i * lineHeight, size: fontSize, font: korean, color: rgb(0.07, 0.09, 0.11) }));
    } else {
      question.promptLines.forEach((line, i) => page.drawText(line, { x: promptX, y: y - i * lineHeight, size: fontSize, font: korean, color: rgb(0.07, 0.09, 0.11) }));
      page.drawText("—", { x: separatorX, y, size: fontSize, font: latin, color: rgb(0.45, 0.48, 0.5) });
      page.drawText("___________________________", { x: answerX, y, size: fontSize, font: latin, color: rgb(0.45, 0.48, 0.5) });
    }
    const bottom = y - question.rowHeight + 2;
    page.drawLine({ start: { x: margin, y: bottom }, end: { x: pageWidth - margin, y: bottom }, thickness: 0.5, color: rgb(0.88, 0.89, 0.91) });
  });
  // Identity/version only: no answer keys are embedded in the blank exam.
  pdf.setSubject(worksheetPdfMarker(manifest, answerMode ? "answer" : "exam"));
  return { base64: toBase64(await pdf.save()), manifest };
}

export function createExamPdfWithManifest(questions: PdfQuestion[], options: { inputText?: string; examId?: string } = {}) {
  return createPdf(questions, false, options);
}
/** Existing base64 API retained. New grading callers retain the manifest returned above. */
export async function createExamPdf(questions: PdfQuestion[] | WorksheetManifest) {
  return (await createPdf(questions, false)).base64;
}
export async function createAnswerPdf(input: string[] | WorksheetManifest) {
  if (!Array.isArray(input)) return (await createPdf(input, true)).base64;
  // Legacy standalone string[] contract: no saved exam identity is claimed.
  // Repeated meanings and wrapped answers remain printable exactly as before.
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const korean = await pdf.embedFont(await loadFontBytes(), { subset: false });
  const latin = await pdf.embedFont(StandardFonts.Helvetica);
  const l = WORKSHEET_LAYOUT;
  const addPage = () => {
    const page = pdf.addPage([l.pageWidth, l.pageHeight]);
    page.drawText("Vocab Pocket 답안지", { x: l.margin, y: l.pageHeight - l.margin, size: 21, font: korean, color: rgb(0.04, 0.49, 0.64) });
    page.drawText("시험지의 정답을 확인하세요.", { x: l.margin, y: l.pageHeight - l.margin - 25, size: 10, font: korean, color: rgb(0.4, 0.44, 0.46) });
    return page;
  };
  let page = addPage(), y: number = l.pageHeight - l.margin - l.headerHeight;
  input.forEach((answer, index) => {
    const lines = wrapWorksheetText(answer || "답안 없음", text => korean.widthOfTextAtSize(text, l.fontSize), l.pageWidth - l.answerX - l.margin);
    const height = lines.length * l.lineHeight + l.rowGap;
    if (y < l.margin + height + 10) { page = addPage(); y = l.pageHeight - l.margin - l.headerHeight; }
    page.drawText(`${index + 1}.`, { x: l.numberX, y, size: l.fontSize, font: latin, color: rgb(0.07, 0.09, 0.11) });
    lines.forEach((line, i) => page.drawText(line, { x: l.promptX, y: y - i * l.lineHeight, size: l.fontSize, font: korean, color: rgb(0.07, 0.09, 0.11) }));
    y -= height;
    page.drawLine({ start: { x: l.margin, y: y + 2 }, end: { x: l.pageWidth - l.margin, y: y + 2 }, thickness: 0.5, color: rgb(0.88, 0.89, 0.91) });
  });
  return toBase64(await pdf.save());
}

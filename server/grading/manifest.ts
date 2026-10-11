import { assertWorksheetManifest, WORKSHEET_LAYOUT, WORKSHEET_LAYOUT_VERSION } from "../../lib/worksheet-layout";
import type { OcrQuestion, WorksheetInput, WorksheetManifest, WorksheetPlacement } from "./types";
import { getPdfDocumentInfo, type PdfInput } from "./poppler-render";

export function inputQuestions(input: WorksheetInput): OcrQuestion[] {
  return Array.isArray(input) ? input : input.questions.map(q => ({ number: q.number, term: q.term, expected: q.expected, answerKey: q.expected }));
}
export type PlacedOcrQuestion = OcrQuestion & WorksheetPlacement;
export async function validatePdfManifest(pdfBytes: PdfInput, input: WorksheetInput): Promise<{ manifest: WorksheetManifest; questions: PlacedOcrQuestion[] }> {
  if (Array.isArray(input)) throw new Error("저장된 layout manifest가 없습니다. 행 위치를 추정하지 않고 확인 대상으로 유지합니다.");
  assertWorksheetManifest(input);
  const info = await getPdfDocumentInfo(pdfBytes);
  const marker = JSON.parse(info.subject || "null") as Record<string, unknown> | null; 
  
  if (!marker || marker.app !== "vocab-pocket" || marker.kind !== "exam" || marker.layoutVersion !== WORKSHEET_LAYOUT_VERSION ||
    marker.examId !== input.examId || marker.planId !== input.planId || info.pageCount !== input.pageCount ||
    info.pages.some(page => Math.abs(page.width - WORKSHEET_LAYOUT.pageWidth) > 0.02 || Math.abs(page.height - WORKSHEET_LAYOUT.pageHeight) > 0.02 || page.rotation === undefined || page.rotation % 360 !== 0)) {
    throw new Error("PDF와 manifest의 시험지 ID·버전·페이지 규격이 일치하지 않습니다. 확인이 필요합니다.");
  }
  return { manifest: input, questions: input.questions.map(q => ({ ...q, answerKey: q.expected })) };
}

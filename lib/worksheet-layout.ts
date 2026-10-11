import type { Word } from "./vocab-utils";

export const WORKSHEET_LAYOUT_VERSION = "fixed-layout-v2";
export const WORKSHEET_LAYOUT = {
  pageWidth: 595.28, pageHeight: 841.89, margin: 42, headerHeight: 55,
  numberX: 42, promptX: 70, separatorX: 300, answerX: 330, answerRight: 553,
  rowGap: 8, lineHeight: 18, fontSize: 12,
} as const;
export type QuestionDirection = "engkor" | "koreng";
export type PdfQuestion = {
  number: number; prompt: string; answer: string; direction?: QuestionDirection;
  sourceTerm?: string; sourceMeaning?: string;
};
/** PDF points, top-left origin; the crop does not depend on prompt width. */
export type AnswerRect = { x: number; y: number; width: number; height: number };
export type WorksheetPlacement = {
  pageNumber: number; rowIndex: number; baselineY: number; rowHeight: number; answerRect: AnswerRect;
};
export type WorksheetQuestion = PdfQuestion & WorksheetPlacement & {
  direction: QuestionDirection; sourceTerm: string; sourceMeaning: string; wordIdentity: string;
  term: string; expected: string; promptLines: string[];
};
export type WorksheetManifest = {
  layoutVersion: typeof WORKSHEET_LAYOUT_VERSION; examId: string; planId: string;
  pageCount: number; inputSnapshot?: string; questions: WorksheetQuestion[];
};
export const canonicalWorksheetInput = (text: string) => text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).join("\n");

/** Corruption/version binding checksum, NOT a signature or authentication mechanism. */
function checksum(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}
export function manifestPlanId(manifest: Omit<WorksheetManifest, "planId"> | WorksheetManifest) {
  return checksum(JSON.stringify([
    manifest.layoutVersion, manifest.examId, manifest.pageCount, manifest.inputSnapshot ?? null,
    manifest.questions.map(q => [q.number, q.prompt, q.answer, q.direction, q.sourceTerm, q.sourceMeaning,
      q.wordIdentity, q.term, q.expected, q.promptLines, q.pageNumber, q.rowIndex, q.baselineY, q.rowHeight,
      q.answerRect.x, q.answerRect.y, q.answerRect.width, q.answerRect.height]),
  ]));
}
export function answerRectAt(baselineY: number): AnswerRect {
  return { x: WORKSHEET_LAYOUT.answerX, y: WORKSHEET_LAYOUT.pageHeight - baselineY - WORKSHEET_LAYOUT.fontSize - 3,
    width: WORKSHEET_LAYOUT.answerRight - WORKSHEET_LAYOUT.answerX, height: WORKSHEET_LAYOUT.fontSize + 10 };
}
export function wrapWorksheetText(text: string, measure: (text: string) => number, maxWidth: number) {
  const lines: string[] = []; let current = "";
  for (const character of text) {
    if (measure(current + character) > maxWidth && current) { lines.push(current); current = character; }
    else current += character;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}
export function buildWorksheetManifest(
  questions: PdfQuestion[], measure: (text: string) => number,
  options: { examId?: string; inputText?: string } = {},
): WorksheetManifest {
  let pageNumber = 1, rowIndex = 0;
  let baselineY: number = WORKSHEET_LAYOUT.pageHeight - WORKSHEET_LAYOUT.margin - WORKSHEET_LAYOUT.headerHeight;
  const planned = questions.map(question => {
    const direction = question.direction ?? (/[\uac00-\ud7a3]/.test(question.prompt) ? "koreng" : "engkor");
    const sourceTerm = question.sourceTerm ?? (direction === "engkor" ? question.prompt : question.answer);
    const sourceMeaning = question.sourceMeaning ?? (direction === "engkor" ? question.answer : question.prompt);
    const promptLines = wrapWorksheetText(question.prompt, measure, WORKSHEET_LAYOUT.separatorX - WORKSHEET_LAYOUT.promptX - 12);
    const rowHeight = Math.max(1, promptLines.length) * WORKSHEET_LAYOUT.lineHeight + WORKSHEET_LAYOUT.rowGap;
    const first = WORKSHEET_LAYOUT.pageHeight - WORKSHEET_LAYOUT.margin - WORKSHEET_LAYOUT.headerHeight;
    if (rowHeight + WORKSHEET_LAYOUT.margin + 10 > first) throw new Error("문항이 한 페이지의 인쇄 영역보다 큽니다. 문항을 확인해 주세요.");
    if (baselineY < WORKSHEET_LAYOUT.margin + rowHeight + 10) { pageNumber += 1; rowIndex = 0; baselineY = first; }
    const result: WorksheetQuestion = { ...question, direction, sourceTerm, sourceMeaning,
      wordIdentity: sourceTerm.toLowerCase(), term: question.prompt, expected: question.answer, promptLines,
      pageNumber, rowIndex, baselineY, rowHeight, answerRect: answerRectAt(baselineY) };
    baselineY -= rowHeight; rowIndex += 1;
    return result;
  });
  const base: Omit<WorksheetManifest, "planId"> = { layoutVersion: WORKSHEET_LAYOUT_VERSION, examId: options.examId ?? `vp-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`,
    pageCount: pageNumber, ...(options.inputText !== undefined ? { inputSnapshot: canonicalWorksheetInput(options.inputText) } : {}), questions: planned };
  const manifest: WorksheetManifest = { ...base, planId: manifestPlanId(base) };
  assertWorksheetManifest(manifest);
  return manifest;
}

export function assertWorksheetManifest(value: unknown, context: { examId?: string; inputText?: string; words?: Word[] } = {}): asserts value is WorksheetManifest {
  const fail = () => { throw new Error("시험지 manifest가 유효하지 않거나 현재 시험지와 다릅니다. 시험지를 다시 생성해 주세요."); };
  if (!value || typeof value !== "object") return fail();
  const m = value as WorksheetManifest;
  if (m.layoutVersion !== WORKSHEET_LAYOUT_VERSION || typeof m.examId !== "string" || !/^vp-[A-Za-z0-9-]+$/.test(m.examId) ||
    !Number.isInteger(m.pageCount) || m.pageCount < 1 || !Array.isArray(m.questions) || m.questions.length > 200 ||
    (context.examId !== undefined && m.examId !== context.examId) ||
    (context.inputText !== undefined && m.inputSnapshot !== canonicalWorksheetInput(context.inputText))) return fail();
  let page = 1, row = 0;
  let baseline: number = WORKSHEET_LAYOUT.pageHeight - WORKSHEET_LAYOUT.margin - WORKSHEET_LAYOUT.headerHeight;
  const identities = new Set<string>();
  for (let i = 0; i < m.questions.length; i += 1) {
    const q = m.questions[i];
    if (!q || q.number !== i + 1 || !["engkor", "koreng"].includes(q.direction) ||
      [q.prompt, q.answer, q.sourceTerm, q.sourceMeaning, q.wordIdentity, q.term, q.expected].some(s => typeof s !== "string") ||
      !q.sourceTerm.trim() || !q.sourceMeaning.trim() || q.wordIdentity !== q.sourceTerm.toLowerCase() || identities.has(q.wordIdentity) ||
      !Array.isArray(q.promptLines) || !q.promptLines.length || q.promptLines.some(s => typeof s !== "string") || q.promptLines.join("") !== q.prompt ||
      q.term !== q.prompt || q.expected !== q.answer ||
      (q.direction === "engkor" ? q.prompt !== q.sourceTerm || q.answer !== q.sourceMeaning : q.prompt !== q.sourceMeaning || q.answer !== q.sourceTerm)) return fail();
    identities.add(q.wordIdentity);
    const height = q.promptLines.length * WORKSHEET_LAYOUT.lineHeight + WORKSHEET_LAYOUT.rowGap;
    const first = WORKSHEET_LAYOUT.pageHeight - WORKSHEET_LAYOUT.margin - WORKSHEET_LAYOUT.headerHeight;
    if (height + WORKSHEET_LAYOUT.margin + 10 > first) return fail();
    if (baseline < WORKSHEET_LAYOUT.margin + height + 10) { page += 1; row = 0; baseline = first; }
    const rect = answerRectAt(baseline);
    if (q.pageNumber !== page || q.rowIndex !== row || q.baselineY !== baseline || q.rowHeight !== height ||
      !q.answerRect || Object.entries(rect).some(([key, number]) => q.answerRect[key as keyof AnswerRect] !== number)) return fail();
    baseline -= height; row += 1;
  }
  if (m.pageCount !== page || typeof m.planId !== "string" || m.planId !== manifestPlanId(m)) return fail();
  if (context.words) {
    const byTerm = new Map(context.words.map(word => [word.term.toLowerCase(), word]));
    if (byTerm.size !== m.questions.length || context.words.length !== m.questions.length ||
      m.questions.some(q => { const w = byTerm.get(q.wordIdentity); return !w || w.term !== q.sourceTerm || w.meaning !== q.sourceMeaning; })) return fail();
  }
}
export function orderWordsByWorksheetManifest(words: Word[], manifest: WorksheetManifest): Word[] {
  assertWorksheetManifest(manifest, { words });
  const byTerm = new Map(words.map(word => [word.term.toLowerCase(), word]));
  return manifest.questions.map(q => byTerm.get(q.wordIdentity)!);
}
/** Diagnostic only. Server grading uses explicit manifest placements, not this count. */
export function fixedRowsPerPage() {
  const first = WORKSHEET_LAYOUT.pageHeight - WORKSHEET_LAYOUT.margin - WORKSHEET_LAYOUT.headerHeight;
  const height = WORKSHEET_LAYOUT.lineHeight + WORKSHEET_LAYOUT.rowGap;
  return Math.max(1, Math.floor((first - WORKSHEET_LAYOUT.margin - height - 10) / height) + 1);
}
/** Public PDF marker contains no answers. Not a cryptographic authenticity proof. */
export function worksheetPdfMarker(manifest: WorksheetManifest, kind: "exam" | "answer") {
  return JSON.stringify({ app: "vocab-pocket", kind, layoutVersion: manifest.layoutVersion, examId: manifest.examId, planId: manifest.planId });
}

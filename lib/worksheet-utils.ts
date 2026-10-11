import type { Word } from "./vocab-utils";

export type WorksheetKind = "worksheet" | "answer";

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;");
}

export function buildWorksheetHtml(words: Word[], kind: WorksheetKind) {
  const title = kind === "worksheet" ? "Vocab Pocket 시험지" : "Vocab Pocket 답안지";
  const rows = words.map((word, index) => {
    const answer = kind === "answer" ? `<span class="answer">${escapeHtml(word.meaning)}</span>` : "<span class=\"blank\">____________________________</span>";
    return `<div class="row"><span class="number">${index + 1}.</span><span class="term">${escapeHtml(word.term)}</span><span class="dash">—</span>${answer}</div>`;
  }).join("");

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { margin: 28px; } body { font-family: -apple-system, BlinkMacSystemFont, Arial, sans-serif; color: #11181c; }
    h1 { color: #0a7ea4; font-size: 24px; margin: 0 0 6px; } p { color: #687076; font-size: 12px; margin: 0 0 20px; }
    .row { font-size: 15px; padding: 10px 0; border-bottom: 1px solid #e5e7eb; }
    .number { display: inline-block; width: 30px; color: #687076; } .term { display: inline-block; width: 145px; font-weight: 700; }
    .dash { color: #9ba1a6; margin-right: 10px; } .blank { color: #687076; } .answer { color: #0a7ea4; font-weight: 600; }
  </style></head><body><h1>${title}</h1><p>${kind === "worksheet" ? "영어 단어를 보고 뜻을 적어 보세요." : "시험지의 답을 확인하세요."}</p>${rows}</body></html>`;
}

export function extractAnswerLines(text: string) {
  const answers = new Map<number, string>();
  const normalized = text.replace(/\r/g, "\n");
  const linePattern = /(?:^|\n)\s*(\d{1,3})\s*[.)、:-]\s*([^\n]{1,160})/g;
  for (const match of normalized.matchAll(linePattern)) {
    const number = Number(match[1]);
    const answer = match[2].replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
    if (number > 0 && answer) answers.set(number, answer);
  }
  return [...answers.entries()].sort(([a], [b]) => a - b).map(([number, answer]) => ({ number, answer }));
}

/**
 * Normalize only presentation differences. It deliberately does not apply
 * fuzzy matching, stemming, synonym expansion, or substring matching.
 */
export function normalizeGradingAnswer(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, "")
    .replace(/[\p{P}\p{S}]/gu, "");
}

export function splitAcceptedAnswers(answerString: string) {
  return answerString
    .split(/[,，/／;；|]/u)
    .map((item) => normalizeGradingAnswer(item))
    .filter(Boolean);
}

export function isStrictCorrectAnswer(input: string, answerString: string) {
  const normalizedInput = normalizeGradingAnswer(input);
  if (!normalizedInput) return false;
  return splitAcceptedAnswers(answerString).some((candidate) => candidate === normalizedInput);
}

export function gradeAnswers(words: Word[], answers: { number: number; answer: string }[]) {
  const answerMap = new Map(answers.map((item) => [item.number, item.answer]));
  const results = words.map((word, index) => {
    const answer = answerMap.get(index + 1) ?? "";
    const correct = isStrictCorrectAnswer(answer, word.meaning);
    return { number: index + 1, term: word.term, expected: word.meaning, answer, correct };
  });
  return { results, score: results.filter((item) => item.correct).length, total: results.length };
}

export function normalizePdfText(value: string) {
  return value.replace(/\\n/g, "\n").replace(/\\r/g, "\n").replace(/\\([()\\])/g, "$1");
}

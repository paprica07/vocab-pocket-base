import type { Word } from "./vocab-utils";
import { assertWorksheetManifest, orderWordsByWorksheetManifest, type WorksheetManifest } from "./worksheet-layout";

export type WorksheetGradeRow = {
  number: number; term: string; expected: string; answer: string; correct: boolean;
  confidence?: number; needsReview?: boolean; source?: "ocr" | "gemini"; note?: string;
};

/** Both gates must opt in. Missing/old manifests preserve AI-only; PDF mismatch never retries AI-only. */
export async function gradeUploadedWorksheet(options: {
  storageKey: string;
  words: Word[];
  manifest?: WorksheetManifest;
  hybridEnabled: boolean;
  capabilities: () => Promise<{ hybridEnabled: boolean }>;
  aiOnly: (input: { storageKey: string; words: Word[]; questions?: Array<{ number: number; prompt: string; answer: string; direction: "engkor" | "koreng" }> }) => Promise<{ results: WorksheetGradeRow[] }>;
  hybrid: (input: { storageKey: string; manifest: WorksheetManifest }) => Promise<{ results: WorksheetGradeRow[]; fallback?: { status: string; message?: string } }>;
}) {
  let manifest: WorksheetManifest | undefined;
  if (options.manifest) {
    try { assertWorksheetManifest(options.manifest, { words: options.words }); manifest = options.manifest; }
    catch { /* Never use or regenerate invalid saved placements. */ }
  }
  if (options.hybridEnabled && manifest) {
    let serverEnabled = false;
    try { serverEnabled = (await options.capabilities()).hybridEnabled; }
    catch { /* Older servers do not have this query; their existing AI-only is preserved. */ }
    if (serverEnabled) {
      const response = await options.hybrid({ storageKey: options.storageKey, manifest });
      return { ...response, mode: "hybrid" as const };
    }
  }
  return {
    ...await options.aiOnly({
      storageKey: options.storageKey,
      words: manifest ? orderWordsByWorksheetManifest(options.words, manifest) : options.words,
      questions: manifest?.questions.map(({ number, prompt, answer, direction }) => ({ number, prompt, answer, direction })),
    }),
    mode: "ai-only" as const,
  };
}

export function summarizeWorksheetResults(rows: WorksheetGradeRow[]) {
  const results = rows.map(row => ({ ...row, correct: row.correct && !row.needsReview }));
  return { results, score: results.filter(row => row.correct && !row.needsReview).length,
    total: results.length, reviewCount: results.filter(row => row.needsReview).length };
}

export function worksheetResultLabel(row: WorksheetGradeRow) {
  return row.needsReview ? "확인 필요" : row.correct ? "정답" : `오답 · ${row.expected}`;
}

export function worksheetConfidencePercent(row: WorksheetGradeRow) {
  const value = row.confidence ?? 0;
  if (!Number.isFinite(value)) return 0;
  // OCR/hybrid has an explicit 0–100 contract. Preserve 0–1 AI-only values too.
  const percent = row.source ? value : value <= 1 ? value * 100 : value;
  return Math.round(Math.max(0, Math.min(100, percent)));
}

import { WORKSHEET_LAYOUT, type WorksheetManifest, type WorksheetPlacement } from "../../lib/worksheet-layout";
export type { WorksheetManifest, WorksheetPlacement } from "../../lib/worksheet-layout";
export type WorksheetInput = WorksheetManifest | OcrQuestion[];

export type OcrScript = "eng" | "kor";

export type OcrQuestion = {
  number: number;
  term: string;
  expected: string;
  /** The answer text, not the prompt text, determines the OCR language. */
  answerKey: string;
};

export type OcrQuestionResult = {
  number: number;
  term: string;
  expected: string;
  answer: string;
  correct: boolean;
  confidence: number;
  needsReview: boolean;
  source: "ocr";
  note: string;
};

/** Same result fields as OCR/AI-only; only source is widened for hybrid results. */
export type HybridQuestionResult = Omit<OcrQuestionResult, "source"> & {
  source: "ocr" | "gemini";
};

export type FixedLayout = {
  pageWidth: number;
  pageHeight: number;
  margin: number;
  headerHeight: number;
  numberX: number;
  promptX: number;
  separatorX: number;
  answerX: number;
  answerRight: number;
  lineHeight: number;
  rowGap: number;
  fontSize: number;
};

// One source of truth for client PDF and both server renderers.
export const FIXED_LAYOUT: FixedLayout = WORKSHEET_LAYOUT;

export const OCR_DPI = 150;
/** 영어(라틴 문자) 답안의 확인 요청 기준입니다(기준 미만이면 확인 대상). */
export const OCR_CONFIDENCE_REVIEW_THRESHOLD = 70;
/**
 * 한글 답안의 확인 요청 기준입니다(기준 이하면 확인 대상).
 *
 * 손글씨 검증에서 한글은 모양이 비슷한 자모 오인식(여정→여전, 예측하다→예즉하다)이
 * 신뢰도 75~85로 나와 영어 기준(70)을 그대로 두면 조용한 오채점이 발생했습니다.
 */
export const OCR_CONFIDENCE_REVIEW_THRESHOLD_KOR = 85;

/**
 * OCR 신뢰도가 확인 대상인지 판단합니다.
 *
 * 영어는 기존 규칙(기준 70 미만)을 그대로 유지하고, 한글은 기준 85 이하를 확인 대상으로 봅니다.
 * 손글씨 검증에서 한글 오인식이 정확히 85.0으로 나온 사례가 있어 경계값을 포함했습니다.
 */
export function isReviewConfidence(confidence: number, script: OcrScript) {
  return script === "kor"
    ? confidence <= OCR_CONFIDENCE_REVIEW_THRESHOLD_KOR
    : confidence < OCR_CONFIDENCE_REVIEW_THRESHOLD;
}

/** 확인 요청 사유에 넣을 기준 설명입니다. */
export function reviewThresholdLabel(script: OcrScript) {
  return script === "kor"
    ? `한글 ${OCR_CONFIDENCE_REVIEW_THRESHOLD_KOR}% 이하`
    : `영어 ${OCR_CONFIDENCE_REVIEW_THRESHOLD}% 미만`;
}

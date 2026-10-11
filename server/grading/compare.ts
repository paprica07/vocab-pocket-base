import { isStrictCorrectAnswer, normalizeGradingAnswer, splitAcceptedAnswers } from "../../lib/worksheet-utils";
import {
  isReviewConfidence,
  reviewThresholdLabel,
  type OcrQuestion,
  type OcrQuestionResult,
  type OcrScript,
} from "./types";

const ASCII_DIGIT = /[0-9]/;
const HANGUL = /[\u3131-\u318e\uac00-\ud7a3]/u;
const LATIN = /[A-Za-z]/;

/**
 * OCR이 혼동하기 쉬운 숫자↔글자 쌍입니다(정규화 후 소문자 기준).
 * 예: word8 → words, level10 → levell0.
 */
const DIGIT_LETTER_CONFUSIONS: Record<string, string> = {
  "0": "o",
  "1": "li",
  "2": "z",
  "3": "e",
  "4": "a",
  "5": "s",
  "6": "g",
  "7": "t",
  "8": "s",
  "9": "gq",
};

/**
 * 정답과 길이가 같고, 다른 위치가 모두 숫자↔글자 혼동 쌍인지 확인합니다.
 * 이 경우 확정 오답으로 처리하지 않고 확인 대상으로 돌립니다.
 */
export function isDigitLetterConfusion(input: string, answerString: string) {
  const normalizedInput = normalizeGradingAnswer(input);
  if (!normalizedInput) return false;
  return splitAcceptedAnswers(answerString).some((candidate) => {
    if (candidate.length !== normalizedInput.length) return false;
    let differences = 0;
    for (let index = 0; index < candidate.length; index += 1) {
      if (candidate[index] === normalizedInput[index]) continue;
      const confusable = DIGIT_LETTER_CONFUSIONS[candidate[index]];
      if (!confusable || !confusable.includes(normalizedInput[index])) return false;
      differences += 1;
    }
    return differences > 0;
  });
}

/**
 * 영문 OCR이 정답과 정확히 한 번만 삽입·삭제·치환된 경우를 확인합니다.
 * 고신뢰도 오독을 확정 오답으로 통과시키지 않기 위한 보수적 guard입니다.
 */
export function isSingleEnglishEdit(input: string, answerString: string) {
  const inputText = normalizeGradingAnswer(input);
  const answerText = normalizeGradingAnswer(answerString);
  if (!inputText || !answerText || inputText === answerText) return false;
  if (Math.abs(inputText.length - answerText.length) > 1) return false;

  const row = Array.from({ length: answerText.length + 1 }, (_, index) => index);
  for (let inputIndex = 1; inputIndex <= inputText.length; inputIndex += 1) {
    let previousDiagonal = row[0];
    row[0] = inputIndex;
    for (let answerIndex = 1; answerIndex <= answerText.length; answerIndex += 1) {
      const previousCell = row[answerIndex];
      row[answerIndex] = inputText[inputIndex - 1] === answerText[answerIndex - 1]
        ? previousDiagonal
        : 1 + Math.min(previousDiagonal, row[answerIndex], row[answerIndex - 1]);
      previousDiagonal = previousCell;
    }
  }
  return row[answerText.length] === 1;
}

/**
 * 정답 키에 없는 ASCII 숫자가 OCR 결과에 섞였는지 확인합니다.
 *
 * 실제 손글씨 검증에서 한글 답안 `학교`가 `-25교`로, 신뢰도 88로 인식되어
 * 확인 없이 오답으로 확정된 사례가 있었습니다. 키에 숫자가 없는데 결과에 숫자가
 * 섞였다면 잡음으로 보고 확인 대상으로 돌립니다. 키에 숫자가 있는 답안(`word2`)은
 * 그대로 두어 기존 동작을 유지합니다.
 */
export function hasUnexpectedDigits(input: string, answerString: string) {
  const inputDigits = [...input].filter((character) => ASCII_DIGIT.test(character));
  if (inputDigits.length === 0) return false;
  const allowedDigits = new Set(
    splitAcceptedAnswers(answerString).flatMap((candidate) => [...candidate].filter((character) => ASCII_DIGIT.test(character))),
  );
  return inputDigits.some((digit) => !allowedDigits.has(digit));
}

/**
 * 정규화 후 비교할 문자가 남지 않는지 확인합니다.
 * 엄격 비교는 구두점·기호·공백을 제거하므로, 기호만 인식된 결과는 비교 대상이 없습니다.
 */
export function hasNoComparableText(input: string) {
  const trimmed = input.trim();
  return trimmed.length > 0 && normalizeGradingAnswer(trimmed).length === 0;
}

/**
 * OCR 결과의 문자 체계가 정답 키와 명백히 다른지 확인합니다.
 *
 * 키가 한글만 또는 라틴 문자만으로 이루어진 경우에만 적용하고, 키 자체가 혼합이거나
 * 판단할 수 없으면 적용하지 않습니다. 숫자·기호만 인식된 결과는 별도 규칙이 처리합니다.
 */
export function hasScriptMismatch(input: string, answerString: string) {
  const keyText = splitAcceptedAnswers(answerString).join("");
  const keyHasHangul = HANGUL.test(keyText);
  const keyHasLatin = LATIN.test(keyText);
  if (keyHasHangul === keyHasLatin) return false;
  const inputHasHangul = HANGUL.test(input);
  const inputHasLatin = LATIN.test(input);
  if (!inputHasHangul && !inputHasLatin) return false;
  return keyHasHangul ? !inputHasHangul : !inputHasLatin;
}

export type OcrNoiseReason = "digit" | "symbol-only" | "script";

/**
 * 신뢰도가 높아도 확정하지 않고 확인 대상으로 돌려야 하는 OCR 잡음을 판별합니다.
 * 정답 키와 다르다는 이유만으로 결과를 정답으로 보정하지는 않습니다.
 */
export function detectOcrNoise(input: string, answerString: string): OcrNoiseReason | null {
  const cleanInput = input.trim();
  if (!cleanInput) return null;
  if (hasNoComparableText(cleanInput)) return "symbol-only";
  if (hasUnexpectedDigits(cleanInput, answerString)) return "digit";
  if (hasScriptMismatch(cleanInput, answerString)) return "script";
  return null;
}

/**
 * OCR 결과를 엄격 비교로 판정합니다.
 *
 * 확인 요청 기준 신뢰도는 답안 문자 체계에 따라 달라집니다(`reviewConfidenceThreshold`).
 * 그 외 규칙(엄격 비교, 숫자 혼동, 빈 답안)은 그대로입니다.
 */
export function judgeOcrAnswer(
  question: OcrQuestion,
  answer: string,
  confidence: number,
  script: OcrScript,
): OcrQuestionResult {
  const cleanAnswer = answer.trim();
  const lowConfidence = isReviewConfidence(confidence, script);
  const matched = isStrictCorrectAnswer(cleanAnswer, question.expected);
  const ambiguous = !matched && isDigitLetterConfusion(cleanAnswer, question.expected);
  const nearEnglishMisread = script === "eng" && confidence >= 70 && !matched
    && isSingleEnglishEdit(cleanAnswer, question.expected);
  const noise = matched ? null : detectOcrNoise(cleanAnswer, question.expected);
  const needsReview = !cleanAnswer || lowConfidence || ambiguous || nearEnglishMisread || noise !== null;
  const correct = !needsReview && matched;

  let note = "자체 OCR로 인식하고 엄격 비교했습니다.";
  if (!cleanAnswer) note = "답안을 인식하지 못했습니다.";
  else if (lowConfidence) {
    note = `OCR 신뢰도가 기준(${reviewThresholdLabel(script)})에 해당합니다(${Math.round(confidence)}%). 확인이 필요합니다.`;
  }
  else if (ambiguous) note = "숫자와 글자를 혼동했을 가능성이 있습니다. 확인이 필요합니다.";
  else if (nearEnglishMisread) note = "영문 OCR 결과가 정답과 한 글자 차이입니다. 확인이 필요합니다.";
  else if (noise === "digit") note = "정답 키에 없는 숫자가 OCR 결과에 섞여 있습니다. 확인이 필요합니다.";
  else if (noise === "symbol-only") note = "OCR 결과에 비교할 수 있는 문자가 없습니다. 확인이 필요합니다.";
  else if (noise === "script") note = "OCR 결과의 문자 체계가 정답 키와 다릅니다. 확인이 필요합니다.";
  else if (!correct) note = "정규화 후 정답 후보와 완전히 일치하지 않습니다.";

  return {
    number: question.number,
    term: question.term,
    expected: question.expected,
    answer: cleanAnswer,
    correct,
    confidence,
    needsReview,
    source: "ocr",
    note,
  };
}

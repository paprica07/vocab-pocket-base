import { describe, expect, it } from "vitest";
import { getAnswerCropRect } from "../server/grading/crop";
import { judgeOcrAnswer } from "../server/grading/compare";
import { selectOcrScript } from "../server/grading/ocr";

const question = {
  number: 2,
  term: "journey",
  expected: "여행",
  answerKey: "여행",
};

describe("Phase 1 OCR layer", () => {
  it("routes OCR from the answer key script", () => {
    expect(selectOcrScript("journey")).toBe("eng");
    expect(selectOcrScript("여행")).toBe("kor");
  });

  it("uses the fixed answer cell and never the prompt area", () => {
    const first = getAnswerCropRect(0);
    const second = getAnswerCropRect(1);
    expect(first.x).toBeGreaterThan(300 * (150 / 72));
    expect(first.width).toBeGreaterThan(0);
    expect(second.y).toBeGreaterThan(first.y);
    expect(second.y - first.y).toBeGreaterThan(0);
  });

  it("connects OCR output to strict comparison", () => {
    expect(judgeOcrAnswer(question, " 여행. ", 96, "kor")).toMatchObject({
      correct: true,
      needsReview: false,
      source: "ocr",
    });
    expect(judgeOcrAnswer(question, "여행량", 96, "kor")).toMatchObject({
      correct: false,
      needsReview: false,
    });
    expect(judgeOcrAnswer(question, "여행", 42, "kor")).toMatchObject({
      correct: false,
      needsReview: true,
    });
    expect(judgeOcrAnswer(question, "", 0, "kor")).toMatchObject({
      correct: false,
      needsReview: true,
    });
  });
});

describe("Phase 1.5 script specific review threshold", () => {
  const korean = { number: 2, term: "journey", expected: "여정", answerKey: "여정" };
  const english = { number: 2, term: "여정", expected: "journey", answerKey: "journey" };

  it("keeps the English threshold at 70", () => {
    expect(judgeOcrAnswer(english, "journey", 70, "eng")).toMatchObject({ correct: true, needsReview: false });
    expect(judgeOcrAnswer(english, "journey", 69, "eng")).toMatchObject({ correct: false, needsReview: true });
  });

  it("treats 85 이하 as a review item for Korean answers", () => {
    expect(judgeOcrAnswer(korean, "여정", 86, "kor")).toMatchObject({ correct: true, needsReview: false });
    expect(judgeOcrAnswer(korean, "여정", 85, "kor")).toMatchObject({ correct: false, needsReview: true });
    expect(judgeOcrAnswer(korean, "여정", 84, "kor")).toMatchObject({ correct: false, needsReview: true });
  });

  it("does not let an English misread through below the Korean threshold", () => {
    // 한 글자 오독은 confidence가 높아도 확인 대상으로 보냅니다.
    expect(judgeOcrAnswer(english, "journy", 84, "eng")).toMatchObject({ correct: false, needsReview: true });
  });

  it("sends high-confidence one-edit English misreads to review", () => {
    expect(judgeOcrAnswer({ number: 12, term: "수확량", expected: "harvest", answerKey: "harvest" }, "horvest", 80, "eng"))
      .toMatchObject({ correct: false, needsReview: true });
    expect(judgeOcrAnswer({ number: 16, term: "관찰하다", expected: "observe", answerKey: "observe" }, "Ooserve", 73, "eng"))
      .toMatchObject({ correct: false, needsReview: true });
    expect(judgeOcrAnswer({ number: 1, term: "x", expected: "observe", answerKey: "observe" }, "observe", 90, "eng"))
      .toMatchObject({ correct: true, needsReview: false });
  });

  it("turns a Korean misread with high confidence into a review item", () => {
    // 손글씨 검증에서 조용한 오채점이던 사례들입니다.
    for (const [expected, misread, confidence] of [
      ["여정", "여전", 85],
      ["여정", "여저", 75],
      ["예측하다", "예즉하다", 84],
    ] as const) {
      const judged = judgeOcrAnswer({ number: 1, term: "x", expected, answerKey: expected }, misread, confidence, "kor");
      expect(judged).toMatchObject({ correct: false, needsReview: true });
    }
  });
});

describe("Phase 2 OCR noise guard", () => {
  const korean = { number: 5, term: "school", expected: "학교", answerKey: "학교" };
  const english = { number: 2, term: "강", expected: "river", answerKey: "river" };

  it("sends a high confidence Korean answer with extra digits to review", () => {
    // 실제 손글씨 검증에서 `학교`가 `-25교`, 신뢰도 88로 인식되어 확정 오답이 되던 사례입니다.
    const judged = judgeOcrAnswer(korean, "-25교", 88, "kor");
    expect(judged).toMatchObject({ correct: false, needsReview: true });
    expect(judged.note).toContain("숫자");
  });

  it("keeps a correctly read answer as correct", () => {
    expect(judgeOcrAnswer(korean, " 학교 ", 96, "kor")).toMatchObject({ correct: true, needsReview: false });
  });

  it("keeps a genuine wrong answer as a confirmed wrong answer", () => {
    expect(judgeOcrAnswer(korean, "여행", 96, "kor")).toMatchObject({ correct: false, needsReview: false });
    expect(judgeOcrAnswer({ number: 1, term: "x", expected: "여행", answerKey: "여행" }, "여행량", 96, "kor")).toMatchObject({
      correct: false,
      needsReview: false,
    });
    expect(judgeOcrAnswer({ number: 1, term: "x", expected: "journey", answerKey: "journey" }, "journy", 84, "eng")).toMatchObject({
      correct: false,
      needsReview: true,
    });
  });

  it("keeps the existing low confidence review policy", () => {
    expect(judgeOcrAnswer(korean, "학교", 42, "kor")).toMatchObject({ correct: false, needsReview: true });
    expect(judgeOcrAnswer(english, "river", 31, "eng")).toMatchObject({ correct: false, needsReview: true });
    expect(judgeOcrAnswer({ number: 8, term: "창문", expected: "window", answerKey: "window" }, "window", 0, "eng")).toMatchObject({
      correct: false,
      needsReview: true,
    });
  });

  it("does not disturb answers whose key contains digits", () => {
    const digitKey = { number: 1, term: "word8", expected: "word8", answerKey: "word8" };
    expect(judgeOcrAnswer(digitKey, "word8", 90, "eng")).toMatchObject({ correct: true, needsReview: false });
    expect(judgeOcrAnswer(digitKey, "world", 90, "eng")).toMatchObject({ correct: false, needsReview: false });
  });

  it("sends symbol only and script mismatched results to review", () => {
    expect(judgeOcrAnswer({ number: 11, term: "flower", expected: "꽃", answerKey: "꽃" }, "=", 95, "kor")).toMatchObject({
      correct: false,
      needsReview: true,
    });
    expect(judgeOcrAnswer(korean, "school", 95, "kor")).toMatchObject({ correct: false, needsReview: true });
  });
});

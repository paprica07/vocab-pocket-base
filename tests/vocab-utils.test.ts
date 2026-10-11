import { describe, expect, it } from "vitest";

import { isCorrectAnswer, parseWords, removeBuiltInWords } from "../lib/vocab-utils";

describe("vocab utils", () => {
  it("parses 영어:뜻 lines and keeps a colon inside the meaning", () => {
    const result = parseWords("curious: 호기심이 많은\nclock: 시계: 벽시계\n\n");

    expect(result.words).toHaveLength(2);
    expect(result.words[0]).toMatchObject({ term: "curious", meaning: "호기심이 많은" });
    expect(result.words[1]).toMatchObject({ term: "clock", meaning: "시계: 벽시계" });
    expect(result.invalidLines).toEqual([]);
  });

  it("skips malformed and duplicate terms while reporting their line numbers", () => {
    const result = parseWords("apple: 사과\n잘못된줄\nAPPLE: 중복\nbanana:");

    expect(result.words).toHaveLength(1);
    expect(result.words[0].term).toBe("apple");
    expect(result.invalidLines).toEqual(["2번째 줄", "3번째 줄", "4번째 줄"]);
  });

  it("normalizes case, whitespace, punctuation, and multiple accepted meanings", () => {
    expect(isCorrectAnswer("  Bright! ", "bright")).toBe(true);
    expect(isCorrectAnswer("호기심이 많은", "관심 많은, 호기심이 많은")).toBe(true);
    expect(isCorrectAnswer("unknown", "bright")).toBe(false);
    expect(isCorrectAnswer("", "bright")).toBe(false);
  });

  it("removes the old eight starter words without touching user words", () => {
    const result = removeBuiltInWords([
      { id: "sample-1", term: "curious", meaning: "호기심이 많은" },
      { id: "user-1", term: "Curious", meaning: "사용자가 추가한 뜻" },
      { id: "user-2", term: "focus", meaning: "집중하다" },
    ]);

    expect(result.map((word) => word.id)).toEqual(["user-1", "user-2"]);
  });
});

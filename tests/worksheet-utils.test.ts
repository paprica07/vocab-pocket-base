import { describe, expect, it } from "vitest";

import { buildWorksheetHtml, extractAnswerLines, gradeAnswers } from "../lib/worksheet-utils";

describe("worksheet utils", () => {
  const words = [
    { id: "1", term: "bright", meaning: "밝은" },
    { id: "2", term: "steady", meaning: "꾸준한, 안정된" },
  ];

  it("builds a worksheet and answer HTML document", () => {
    expect(buildWorksheetHtml(words, "worksheet")).toContain("bright");
    expect(buildWorksheetHtml(words, "worksheet")).toContain("________________");
    const answerHtml = buildWorksheetHtml(words, "answer");
    expect(answerHtml).toContain("Vocab Pocket 답안지");
    expect(answerHtml).toContain("bright");
    expect(answerHtml).toContain("밝은");
    expect(answerHtml).not.toContain("________________");
  });

  it("extracts numbered answers and grades accepted meanings", () => {
    const answers = extractAnswerLines("1. 밝은\n2. 안정된");
    const result = gradeAnswers(words, answers);

    expect(result.score).toBe(2);
    expect(result.results.every((item) => item.correct)).toBe(true);
  });
});

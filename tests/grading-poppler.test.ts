import { describe, expect, it } from "vitest";
import { getAnswerCropRect } from "../server/grading/crop";
import { judgeOcrAnswer } from "../server/grading/compare";
import { buildOcrWhitelist } from "../server/grading/ocr";
import { gradeFixedLayoutPdfWithPoppler, rowsPerPage } from "../server/grading/poppler-pipeline";
import {
  POPPLER_CROP_PADDING_X,
  POPPLER_CROP_PADDING_Y,
  detectAnswerOverflowForRows,
  getAnswerCellRectInStrip,
  getAnswerOverflowBandsInStrip,
  getAnswerStripRect,
  isPopplerAvailableSync,
  renderPdfAnswerStrip,
} from "../server/grading/poppler-render";
import { OCR_DPI } from "../server/grading/types";
import { createExamPdfWithManifest, type WorksheetFixtureRow } from "./helpers/actual-worksheet";

const popplerAvailable = isPopplerAvailableSync();

type Row = WorksheetFixtureRow;
type WordPair = { term: string; meaning: string };

/** 30 real vocabulary pairs, used by the two page mapping test. */
const TWO_PAGE_WORDS: [string, string][] = [
  ["apple", "사과"],
  ["journey", "여정"],
  ["curious", "호기심"],
  ["improve", "향상시키다"],
  ["harvest", "수확"],
  ["confident", "자신감 있는"],
  ["observe", "관찰하다"],
  ["predict", "예측하다"],
  ["compare", "비교하다"],
  ["describe", "묘사하다"],
  ["increase", "증가하다"],
  ["decrease", "감소하다"],
  ["discover", "발견하다"],
  ["protect", "보호하다"],
  ["support", "지지하다"],
  ["produce", "생산하다"],
  ["receive", "받다"],
  ["decide", "결정하다"],
  ["explain", "설명하다"],
  ["prepare", "준비하다"],
  ["remember", "기억하다"],
  ["continue", "계속하다"],
  ["consider", "고려하다"],
  ["imagine", "상상하다"],
  ["introduce", "소개하다"],
  ["recommend", "추천하다"],
  ["understand", "이해하다"],
  ["develop", "개발하다"],
  ["manage", "관리하다"],
  ["deliver", "전달하다"],
];

describe("Phase 1.5 OCR whitelist", () => {
  it("keeps the letter-only whitelist for plain English words", () => {
    const whitelist = buildOcrWhitelist("eng", "journey");
    expect(whitelist).toContain("a");
    expect(whitelist).toContain("Z");
    expect(whitelist).not.toMatch(/[0-9]/);
  });

  it("allows digits only when the answer key contains one", () => {
    expect(buildOcrWhitelist("eng", "word2")).toMatch(/[0-9]/);
    expect(buildOcrWhitelist("kor", "뜻2")).toBeUndefined();
  });
});

describe("Phase 1.5 digit and letter ambiguity", () => {
  const question = { number: 1, term: "word8", expected: "word8", answerKey: "word8" };

  it("accepts a correctly read digit answer", () => {
    expect(judgeOcrAnswer(question, "word8", 90, "eng")).toMatchObject({ correct: true, needsReview: false });
  });

  it("sends a digit/letter confusion to review instead of confirming it wrong", () => {
    const judged = judgeOcrAnswer(question, "words", 90, "eng");
    expect(judged.correct).toBe(false);
    expect(judged.needsReview).toBe(true);
    expect(judged.note).toContain("숫자");
  });

  it("still confirms a clearly different answer as wrong", () => {
    expect(judgeOcrAnswer(question, "world", 90, "eng")).toMatchObject({ correct: false, needsReview: false });
  });
});

describe("Phase 1.5 Poppler renderer geometry", () => {
  it("retains 26 rows per page only as a legacy diagnostic", () => {
    expect(rowsPerPage()).toBe(26);
  });

  it("keeps the answer cell aligned with the pdf.js crop rect", () => {
    const first = getAnswerCropRect(0);
    const strip = getAnswerStripRect(1);
    const cell = getAnswerCellRectInStrip(0);

    // Cell = the pdf.js answer cell, widened by the Poppler padding only.
    expect(cell.width).toBe(first.width + POPPLER_CROP_PADDING_X * 2);
    expect(cell.height).toBe(first.height + POPPLER_CROP_PADDING_Y * 2);
    expect(cell.x).toBeGreaterThan(0);
    expect(cell.x + cell.width).toBeLessThan(strip.width);
  });

  it("maps every row inside the multi row strip", () => {
    const cellWidth = getAnswerCropRect(0).width;
    const strip = getAnswerStripRect(5);
    let previousY = -1;
    for (let row = 0; row < 5; row += 1) {
      const cell = getAnswerCellRectInStrip(row);
      expect(cell.y).toBeGreaterThan(previousY);
      expect(cell.y + cell.height).toBeLessThanOrEqual(strip.height);
      expect(cell.width).toBe(cellWidth + POPPLER_CROP_PADDING_X * 2);
      previousY = cell.y;
    }
  });

  it("places the overflow bands outside the answer cell", () => {
    const strip = getAnswerStripRect(1);
    const cell = getAnswerCellRectInStrip(0);
    const bands = getAnswerOverflowBandsInStrip(0);

    expect(bands.left.x + bands.left.width).toBeLessThanOrEqual(cell.x);
    expect(bands.right.x).toBeGreaterThanOrEqual(cell.x + cell.width);
    expect(bands.right.x + bands.right.width).toBeLessThanOrEqual(strip.width);
  });
});

describe.skipIf(!popplerAvailable)("Phase 1.5 Poppler pipeline", () => {
  it(
    "renders only the answer strip for rows in an actual app-generated worksheet",
    async () => {
      const { pdfBytes } = await createExamPdfWithManifest([
        { prompt: "curious", answer: "호기심이 많은" },
        { prompt: "journey", answer: "여정" },
        { prompt: "improve", answer: "향상시키다" },
      ]);
      const strip = await renderPdfAnswerStrip(pdfBytes, 1, 3, OCR_DPI);
      const rect = getAnswerStripRect(3, OCR_DPI);
      expect(strip.width).toBe(rect.width);
      expect(strip.height).toBe(rect.height);
      expect(strip.png.length).toBeGreaterThan(0);
    },
    60_000,
  );

  it(
    "does not report overflow for answers written inside the actual app answer cell",
    async () => {
      const rows: Row[] = [
        { prompt: "curious", answer: "호기심이 많은" },
        { prompt: "journey", answer: "여정" },
        { prompt: "improve", answer: "향상시키다" },
      ];
      const { pdfBytes } = await createExamPdfWithManifest(rows);
      const strip = await renderPdfAnswerStrip(pdfBytes, 1, rows.length, OCR_DPI);
      const overflows = await detectAnswerOverflowForRows(strip.png, rows.length, OCR_DPI);
      expect(overflows.map((item) => item.overflow)).toEqual([false, false, false]);
    },
    60_000,
  );

  it(
    "reports overflow when student ink leaves the actual app answer cell",
    async () => {
      const rows: Row[] = [
        { prompt: "curious", answer: "호기심이 많은" },
        { prompt: "journey", answer: "여정" },
      ];
      const { pdfBytes } = await createExamPdfWithManifest(rows, { answerX: 310 });
      const strip = await renderPdfAnswerStrip(pdfBytes, 1, rows.length, OCR_DPI);
      const overflows = await detectAnswerOverflowForRows(strip.png, rows.length, OCR_DPI);
      expect(overflows.every((item) => item.overflow)).toBe(true);
    },
    60_000,
  );

  it(
    "grades filled answers with Poppler + Tesseract using the saved app manifest",
    async () => {
      const worksheet = await createExamPdfWithManifest([
        { prompt: "curious", answer: "호기심이 많은" },
        { prompt: "여행", answer: "journey" },
      ]);
      const results = await gradeFixedLayoutPdfWithPoppler(worksheet.pdfBytes, worksheet.manifest, OCR_DPI);

      expect(results).toHaveLength(2);
      expect(results.map((item) => item.source)).toEqual(["ocr", "ocr"]);
      for (const result of results) {
        expect(result.correct).toBe(true);
        expect(result.needsReview).toBe(false);
        expect(result.confidence).toBeGreaterThanOrEqual(70);
      }
    },
    180_000,
  );

  it(
    "keeps digits in English answers instead of truncating them",
    async () => {
      const worksheet = await createExamPdfWithManifest([
        { prompt: "두 번째 단어", answer: "word2" },
        { prompt: "열 번째 단계", answer: "test10" },
        { prompt: "일곱 번째 항목", answer: "item7" },
      ]);
      const results = await gradeFixedLayoutPdfWithPoppler(worksheet.pdfBytes, worksheet.manifest, OCR_DPI);

      expect(results.map((item) => item.answer)).toEqual(["word2", "test10", "item7"]);
      for (const item of results) {
        if (item.confidence < 70) {
          expect(item.correct).toBe(false);
          expect(item.needsReview).toBe(true);
        }
      }
    },
    180_000,
  );

  it(
    "sends every answer that left the cell to review without retaining a correct result",
    async () => {
      const worksheet = await createExamPdfWithManifest([
        { prompt: "curious", answer: "호기심이 많은" },
        { prompt: "journey", answer: "여정" },
      ], { answerX: 310 });
      const results = await gradeFixedLayoutPdfWithPoppler(worksheet.pdfBytes, worksheet.manifest, OCR_DPI);

      expect(results.every((item) => item.needsReview)).toBe(true);
      expect(results.every((item) => !item.correct)).toBe(true);
      expect(results[0].note).toContain("답안칸");
    },
    180_000,
  );

  it(
    "maps all 30 questions of a two-page random mixed worksheet generated by the app",
    async () => {
      const source: WordPair[] = TWO_PAGE_WORDS.map(([term, meaning]) => ({ term, meaning }));
      const sortKey = (row: WordPair) => row.term.split("").reduce((sum, character) => sum + character.charCodeAt(0), 0);
      const rows: Row[] = [...source]
        .sort((a, b) => sortKey(a) - sortKey(b))
        .map((row, index) => (index % 2 === 0 ? { prompt: row.term, answer: row.meaning } : { prompt: row.meaning, answer: row.term }));
      const worksheet = await createExamPdfWithManifest(rows);
      const results = await gradeFixedLayoutPdfWithPoppler(worksheet.pdfBytes, worksheet.manifest, OCR_DPI);

      expect(worksheet.manifest.pageCount).toBe(2);
      expect(worksheet.manifest.questions.map((question) => question.pageNumber)).toEqual([
        ...Array.from({ length: 26 }, () => 1),
        ...Array.from({ length: 4 }, () => 2),
      ]);
      expect(results).toHaveLength(30);
      expect(results.map((item) => item.number)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1));
      expect(results.filter((item) => !item.correct).map((item) => ({ n: item.number, a: item.answer }))).toEqual([]);
      expect(results.every((item) => !item.needsReview)).toBe(true);
    },
    300_000,
  );
});

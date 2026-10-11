import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../server/_core/env";
import { GeminiDailyQuotaError, invokeLLM, type InvokeParams, type InvokeResult } from "../server/_core/llm";
import { applyGeminiFallback } from "../server/grading/gemini-fallback";
import type { ReviewCrop } from "../server/grading/review-crops";
import type { OcrQuestionResult } from "../server/grading/types";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB2kAAAAASUVORK5CYII=", "base64");
const originals: OcrQuestionResult[] = [
  { number: 7, term: "여정", expected: "journey", answer: "journey", correct: true, confidence: 96, needsReview: false, source: "ocr", note: "정답" },
  { number: 2, term: "사과", expected: "apple", answer: "banana", correct: false, confidence: 96, needsReview: false, source: "ocr", note: "오답" },
  { number: 19, term: "journey", expected: "여정", answer: "여전", correct: false, confidence: 85, needsReview: true, source: "ocr", note: "확인" },
  { number: 5, term: "수확량", expected: "yield", answer: "yeld", correct: false, confidence: 45, needsReview: true, source: "ocr", note: "확인" },
];
const crops = originals.map((item, index): ReviewCrop => ({
  index, question: { number: item.number, term: item.term, expected: item.expected, answerKey: item.expected },
  pageNumber: 1, rowIndex: index, png, touchesBoundary: false,
}));
const entry = (number: number, answer: string, correct = true, needsReview = false, confidence = 96) => ({
  number, answer, correct, needsReview, confidence, note: "이미지에서 판독",
});
const reply = (results: unknown[]): InvokeResult => ({
  id: "mock", model: "mock", created: 0,
  choices: [{ index: 0, message: { role: "assistant", content: JSON.stringify({ results }) }, finish_reason: "STOP" }],
});

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe("Phase 2 review-only fallback", () => {
  it("batches only review images/keys once and preserves confirmed correct AND incorrect results", async () => {
    const before = structuredClone(originals);
    const invoke = vi.fn(async (_params: InvokeParams) => reply([entry(5, "YIELD."), entry(19, "여정")]));
    const out = await applyGeminiFallback(originals, crops, invoke);
    expect(invoke).toHaveBeenCalledTimes(1);
    const request = invoke.mock.calls[0][0];
    expect(request.model).toBe("gemini-3.5-flash");
    const content = request.messages[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    expect(content.filter((item) => item.type === "image_url")).toHaveLength(2);
    const metadata = content.filter((item) => item.type === "text").slice(1).map((item) => JSON.parse(item.text!.split("question: ")[1]));
    expect(metadata.map((item) => item.number)).toEqual([19, 5]);
    expect(metadata.map((item) => item.answerKey)).toEqual(["여정", "yield"]);
    expect(content.filter((item) => item.type === "image_url").every((item) => item.image_url!.url.startsWith("data:image/png;base64,"))).toBe(true);
    expect(out.results.slice(0, 2)).toEqual(originals.slice(0, 2));
    expect(out.results.map((item) => item.number)).toEqual([7, 2, 19, 5]);
    expect(out.results.slice(2).every((item) => item.source === "gemini" && item.correct && !item.needsReview)).toBe(true);
    expect(out.fallback).toMatchObject({ batchCalls: 1, sentCount: 2, updatedCount: 2, resolvedCount: 2, status: "completed" });
    expect(originals).toEqual(before);
  });

  it("makes zero requests for no review items", async () => {
    const invoke = vi.fn();
    const out = await applyGeminiFallback(originals.slice(0, 2), crops, invoke);
    expect(invoke).not.toHaveBeenCalled();
    expect(out.results).toEqual(originals.slice(0, 2));
    expect(out.fallback).toMatchObject({ status: "skipped", batchCalls: 0 });
  });

  it("keeps crop-failed items local and merges only valid partial replies", async () => {
    const invoke = vi.fn(async () => reply([entry(19, "여정")]));
    const out = await applyGeminiFallback(originals, [crops[2]], invoke);
    expect(out.results[2].source).toBe("gemini");
    expect(out.results[3]).toEqual(originals[3]);
    expect(out.fallback.status).toBe("partial");
  });

  it("does not call Gemini if all review crops failed", async () => {
    const invoke = vi.fn();
    const out = await applyGeminiFallback(originals, [], invoke);
    expect(invoke).not.toHaveBeenCalled();
    expect(out.results).toEqual(originals);
    expect(out.fallback.errorCode).toBe("crop_failed");
  });

  it("ignores unsolicited confirmed/unknown numbers and preserves local keys", async () => {
    const out = await applyGeminiFallback(originals, crops, async () => reply([
      entry(7, "WRONG", false), entry(999, "x", false), { ...entry(19, "여정"), term: "changed", expected: "changed" },
    ]));
    expect(out.results[0]).toEqual(originals[0]);
    expect(out.results[2]).toMatchObject({ number: 19, term: "journey", expected: "여정", source: "gemini" });
    expect(out.results[3]).toEqual(originals[3]);
  });

  it("rejects duplicate IDs, non-booleans and out-of-range confidence without losing other results", async () => {
    const out = await applyGeminiFallback(originals, crops, async () => reply([
      entry(19, "여정"), entry(19, "여정"), { ...entry(5, "yield"), confidence: 101 },
    ]));
    expect(out.results).toEqual(originals);
    const malformed = await applyGeminiFallback(originals, crops, async () => reply([{ ...entry(19, "여정"), correct: "true" }, entry(5, "yield")]));
    expect(malformed.results[2]).toEqual(originals[2]);
    expect(malformed.results[3].source).toBe("gemini");
  });

  it("rejects spelling/substring/semantic grading errors even if Gemini claims correct", async () => {
    const out = await applyGeminiFallback(originals, crops, async () => reply([entry(19, "여행"), entry(5, "yeld")]));
    expect(out.results).toEqual(originals);
    expect(out.fallback.errorCode).toBe("invalid_response");
    const harvest = { ...originals[2], expected: "수확량" };
    const out2 = await applyGeminiFallback([harvest], [{ ...crops[2], index: 0, question: { ...crops[2].question, expected: "수확량", answerKey: "수확량" } }], async () => reply([entry(19, "수확")]));
    expect(out2.results[0]).toEqual(harvest);
  });

  it("accepts an actual wrong answer as Gemini-confirmed wrong", async () => {
    const out = await applyGeminiFallback(originals, crops, async () => reply([entry(19, "여전", false)]));
    expect(out.results[2]).toMatchObject({ source: "gemini", correct: false, needsReview: false, answer: "여전" });
  });

  it("keeps Gemini uncertainty, low confidence, and truncated crops under review", async () => {
    const out = await applyGeminiFallback(originals, crops, async () => reply([entry(19, "여정", false, true), entry(5, "yield", true, false, 45)]));
    expect(out.results.slice(2).every((item) => item.needsReview && !item.correct && item.source === "gemini")).toBe(true);
    const clipped = await applyGeminiFallback(originals, [{ ...crops[2], touchesBoundary: true }], async () => reply([entry(19, "여정")]));
    expect(clipped.results[2]).toMatchObject({ needsReview: true, correct: false, source: "gemini" });
  });

  it("allows a clearly empty answer to be confirmed wrong but not correct", async () => {
    const out = await applyGeminiFallback(originals, crops, async () => reply([entry(19, "", false)]));
    expect(out.results[2]).toMatchObject({ source: "gemini", answer: "", correct: false, needsReview: false });
  });

  it.each(["quota", "429", "network", "missing-key"])("preserves EVERY OCR result after %s failure", async (kind) => {
    const invoke = vi.fn(async () => {
      if (kind === "quota") throw new GeminiDailyQuotaError();
      if (kind === "429") throw new Error("Gemini API failed: 429 Too Many Requests – private body");
      if (kind === "missing-key") throw new Error("GEMINI_API_KEY is not configured");
      throw new Error("network failed");
    });
    const out = await applyGeminiFallback(originals, crops, invoke);
    expect(out.results).toEqual(originals);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(out.fallback.status).toBe("failed");
    expect(out.fallback.errorCode).toBe(kind === "quota" ? "daily_quota" : kind === "429" ? "rate_limit" : "request_failed");
    expect(out.fallback.message).not.toContain("private body");
  });

  it("preserves OCR on malformed JSON or missing results", async () => {
    for (const content of ["not JSON", "{}", "null"]) {
      const response = reply([]);
      response.choices[0].message.content = content;
      const out = await applyGeminiFallback(originals, crops, async () => response);
      expect(out.results).toEqual(originals);
      expect(out.fallback.status).toBe("failed");
    }
  });
});

describe("existing invokeLLM transport reuse (mocked HTTP only)", () => {
  const oldKey = ENV.geminiApiKey;
  afterEach(() => { ENV.geminiApiKey = oldKey; });
  const success = () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"results":[]}' }] }, finishReason: "STOP" }] }), { status: 200 });

  it("sends PNG crops inline with correct MIME, without downloading/uploading them", async () => {
    ENV.geminiApiKey = "test-placeholder";
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => success());
    vi.stubGlobal("fetch", fetchMock);
    await invokeLLM({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }] }] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.contents[0].parts[0].inline_data).toEqual({ mime_type: "image/png", data: png.toString("base64") });
  });

  it("still downloads existing HTTP PDF attachments the same way", async () => {
    ENV.geminiApiKey = "test-placeholder";
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.endsWith("input.pdf") ? new Response("pdf-data") : success());
    vi.stubGlobal("fetch", fetchMock);
    await invokeLLM({ messages: [{ role: "user", content: [{ type: "file_url", file_url: { url: "https://example.test/input.pdf", mime_type: "application/pdf" } }] }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
    expect(body.contents[0].parts[0].inline_data.mime_type).toBe("application/pdf");
  });

  it("reuses real daily quota detection with zero retries", async () => {
    ENV.geminiApiKey = "test-placeholder";
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { details: [{ violations: [{ quotaId: "GenerateRequestsPerDay" }] }] } }), { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const out = await applyGeminiFallback(originals, crops);
    expect(out.results).toEqual(originals);
    expect(out.fallback.errorCode).toBe("daily_quota");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reuses existing 429 backoff and preserves OCR after the final 429", async () => {
    ENV.geminiApiKey = "test-placeholder";
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('{"error":{}}', { status: 429, statusText: "Too Many Requests" }));
    vi.stubGlobal("fetch", fetchMock);
    const promise = applyGeminiFallback(originals, crops);
    await vi.runAllTimersAsync();
    const out = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(5); // initial + existing MAX_RETRIES=4
    expect(out.fallback).toMatchObject({ batchCalls: 1, errorCode: "rate_limit" });
    expect(out.results).toEqual(originals);
  });

  it("recovers using the same batch after a transient 429", async () => {
    ENV.geminiApiKey = "test-placeholder";
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({ results: [entry(19, "여정"), entry(5, "yield")] }) }] } }],
    }), { status: 200 }));
    fetchMock.mockImplementationOnce(async () => new Response('{"error":{}}', { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    const promise = applyGeminiFallback(originals, crops);
    await vi.runAllTimersAsync();
    const out = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][1]?.body).toBe(fetchMock.mock.calls[1][1]?.body);
    expect(out.fallback).toMatchObject({ batchCalls: 1, updatedCount: 2, status: "completed" });
    expect(out.results.slice(0, 2)).toEqual(originals.slice(0, 2));
  });
});

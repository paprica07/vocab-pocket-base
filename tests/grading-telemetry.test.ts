import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV } from "../server/_core/env";
import {
  GeminiDailyQuotaError,
  invokeLLM,
  type LlmTelemetryEvent,
} from "../server/_core/llm";

const originalApiKey = ENV.geminiApiKey;
const privatePrompt = "private-term private-answer";
const privateProviderBody = "provider-private-response";

const successPayload = (text = "ok") => ({
  candidates: [
    {
      index: 0,
      content: { parts: [{ text }] },
      finishReason: "STOP",
    },
  ],
  usageMetadata: {
    promptTokenCount: 12,
    candidatesTokenCount: 3,
    totalTokenCount: 15,
  },
});

const successResponse = (text = "ok") => {
  const body = JSON.stringify(successPayload(text));
  return new Response(body, {
    status: 200,
    headers: { "content-length": String(Buffer.byteLength(body)) },
  });
};

const invoke = (telemetry?: (event: LlmTelemetryEvent) => void) =>
  invokeLLM({
    messages: [{ role: "user", content: privatePrompt }],
    telemetry,
  });

const eventsOf = <Type extends LlmTelemetryEvent["type"]>(
  events: LlmTelemetryEvent[],
  type: Type,
): Extract<LlmTelemetryEvent, { type: Type }>[] =>
  events.filter(
    (event): event is Extract<LlmTelemetryEvent, { type: Type }> =>
      event.type === type,
  );

describe("Gemini transport telemetry (mocked HTTP only)", () => {
  beforeEach(() => {
    ENV.geminiApiKey = "test-api-key-private";
  });

  afterEach(() => {
    ENV.geminiApiKey = originalApiKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("emits request, headers, json body, completion, and usage without sensitive content", async () => {
    const events: LlmTelemetryEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => successResponse()),
    );

    const result = await invoke((event) => events.push(event));

    expect(result.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
    });
    expect(events.map((event) => event.type)).toEqual([
      "request_created",
      "http_attempt_start",
      "http_headers_received",
      "http_body_parsed",
      "http_complete",
      "usage",
    ]);
    expect(eventsOf(events, "request_created")[0]).toMatchObject({
      requestBytes: expect.any(Number),
      imageCount: 0,
      inlineDataCount: 0,
    });
    expect(eventsOf(events, "http_headers_received")[0]).toMatchObject({
      attempt: 1,
      status: 200,
      timeout: false,
    });
    expect(eventsOf(events, "http_body_parsed")[0]).toMatchObject({
      attempt: 1,
      status: 200,
      parser: "response_json",
      parsed: true,
      responseBytes: expect.any(Number),
    });
    expect(eventsOf(events, "usage")[0]).toMatchObject({
      attempt: 1,
      promptTokens: 12,
      completionTokens: 3,
      totalTokens: 15,
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(privatePrompt);
    expect(serialized).not.toContain("test-api-key-private");
    expect(serialized).not.toContain("generativelanguage.googleapis.com");
  });

  it("keeps the existing request behavior when telemetry is omitted", async () => {
    const fetchMock = vi.fn(async () => successResponse("no callback"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(invoke()).resolves.toMatchObject({
      choices: [{ message: { content: "no callback" } }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not change a successful request when the telemetry callback throws", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => successResponse("still succeeds")),
    );

    await expect(
      invoke(async () => {
        throw new Error("telemetry observer failure");
      }),
    ).resolves.toMatchObject({
      choices: [{ message: { content: "still succeeds" } }],
    });
  });

  it("records a body read longer than 180 seconds without turning it into a timeout", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const slowResponse = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ "content-length": "20" }),
      json: async () => {
        now += 180_001;
        return successPayload();
      },
    } as unknown as Response;
    const events: LlmTelemetryEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => slowResponse),
    );

    await invoke((event) => events.push(event));

    expect(eventsOf(events, "http_headers_received")[0]).toMatchObject({
      elapsedMs: 0,
      timeout: false,
    });
    expect(eventsOf(events, "http_body_parsed")[0]).toMatchObject({
      bodyReadMs: 180_001,
      timeout: false,
    });
    expect(eventsOf(events, "http_complete")[0]).toMatchObject({
      elapsedMs: 180_001,
      bodyReadMs: 180_001,
      timeout: false,
    });
  });

  it("records a generic 429 clone-text parse, retry wait, and second successful attempt", async () => {
    vi.useFakeTimers();
    const events: LlmTelemetryEvent[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(privateProviderBody, {
          status: 429,
          statusText: "Too Many Requests",
        }),
      )
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal("fetch", fetchMock);

    const pending = invoke((event) => events.push(event));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      choices: [{ message: { content: "ok" } }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(eventsOf(events, "http_body_parsed")[0]).toMatchObject({
      attempt: 1,
      status: 429,
      parser: "retry_429_clone_text",
      parsed: true,
    });
    expect(eventsOf(events, "retry_wait")[0]).toMatchObject({
      attempt: 1,
      status: 429,
      delayMs: 2_000,
      reason: "http_429",
    });
    expect(
      eventsOf(events, "http_attempt_start").map((event) => event.attempt),
    ).toEqual([1, 2]);
    expect(JSON.stringify(events)).not.toContain(privateProviderBody);
  });

  it("does not report missing Content-Length as a zero-byte response", async () => {
    const events: LlmTelemetryEvent[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(successPayload()), { status: 200 })));
    await invoke(event => events.push(event));
    expect(eventsOf(events, "http_body_parsed")[0].responseBytes).toBeUndefined();
    expect(eventsOf(events, "http_complete")[0].responseBytes).toBeUndefined();
  });

  it("records a retry for 503 while preserving the existing backoff policy", async () => {
    vi.useFakeTimers();
    const events: LlmTelemetryEvent[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(successResponse());
    vi.stubGlobal("fetch", fetchMock);

    const pending = invoke((event) => events.push(event));
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toMatchObject({
      choices: [{ message: { content: "ok" } }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(eventsOf(events, "retry_wait")[0]).toMatchObject({
      attempt: 1,
      status: 503,
      delayMs: 2_000,
      reason: "http_5xx",
    });
  });

  it("stops immediately for daily quota and never schedules a retry", async () => {
    const events: LlmTelemetryEvent[] = [];
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              details: [
                { violations: [{ quotaId: "GenerateRequestsPerDay" }] },
              ],
            },
          }),
          { status: 429 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(invoke((event) => events.push(event))).rejects.toBeInstanceOf(
      GeminiDailyQuotaError,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(eventsOf(events, "retry_wait")).toHaveLength(0);
    expect(eventsOf(events, "http_complete")[0]).toMatchObject({
      attempt: 1,
      status: 429,
      outcome: "daily_quota",
    });
  });

  it("preserves provider errors while telemetry excludes raw provider error text", async () => {
    const events: LlmTelemetryEvent[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(privateProviderBody, {
            status: 400,
            statusText: "Bad Request",
          }),
      ),
    );

    await expect(invoke((event) => events.push(event))).rejects.toThrow(
      `Gemini API failed: 400 Bad Request – ${privateProviderBody}`,
    );

    expect(eventsOf(events, "http_body_parsed")[0]).toMatchObject({
      status: 400,
      parser: "error_text",
      parsed: true,
    });
    expect(JSON.stringify(events)).not.toContain(privateProviderBody);
  });

  it("records timeout attempt errors without leaking the mocked transport error", async () => {
    vi.useFakeTimers();
    const events: LlmTelemetryEvent[] = [];
    const transportError = "mocked-transport-private-error";
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(new Error(transportError));
            },
            { once: true },
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = invoke((event) => events.push(event));
    const rejected = expect(pending).rejects.toThrow(transportError);
    await vi.runAllTimersAsync();
    await rejected;

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(eventsOf(events, "http_attempt_error")).toHaveLength(5);
    expect(
      eventsOf(events, "http_attempt_error").every(
        (event) => event.timeout && event.errorKind === "timeout",
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain(transportError);
  });

  it("keeps the AI-only PDF file_url inline_data request contract", async () => {
    const events: LlmTelemetryEvent[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("worksheet.pdf")) return new Response("pdf-data");
      return successResponse();
    });
    vi.stubGlobal("fetch", fetchMock);

    await invokeLLM({
      messages: [
        {
          role: "user",
          content: [
            {
              type: "file_url",
              file_url: {
                url: "https://example.test/worksheet.pdf",
                mime_type: "application/pdf",
              },
            },
          ],
        },
      ],
      telemetry: (event) => events.push(event),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const request = JSON.parse(
      (fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1]
        .body as string,
    );
    expect(request.contents[0].parts[0].inline_data).toEqual({
      mime_type: "application/pdf",
      data: Buffer.from("pdf-data").toString("base64"),
    });
    expect(eventsOf(events, "request_created")[0]).toMatchObject({
      imageCount: 0,
      inlineDataCount: 1,
    });
    expect(JSON.stringify(events)).not.toContain("pdf-data");
  });
});

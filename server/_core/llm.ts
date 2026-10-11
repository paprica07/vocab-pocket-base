import { ENV } from "./env";

export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?:
      | "audio/mpeg"
      | "audio/wav"
      | "application/pdf"
      | "audio/mp4"
      | "video/mp4";
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

/** Safe transport metadata only; never includes prompts, images, URLs, or provider error bodies. */
export type LlmTelemetryEvent =
  | {
      type: "request_created";
      requestBytes: number;
      imageCount: number;
      inlineDataCount: number;
    }
  | {
      type: "http_attempt_start";
      attempt: number;
    }
  | {
      type: "http_headers_received";
      attempt: number;
      status: number;
      elapsedMs: number;
      timeout: boolean;
    }
  | {
      type: "http_body_parsed";
      attempt: number;
      status: number;
      parser: "retry_429_clone_text" | "response_json" | "error_text";
      bodyReadMs: number;
      responseBytes?: number;
      parsed: boolean;
      timeout: boolean;
    }
  | {
      type: "http_complete";
      attempt: number;
      status: number;
      elapsedMs: number;
      bodyReadMs?: number;
      responseBytes?: number;
      timeout: boolean;
      outcome: "response" | "retry" | "daily_quota";
    }
  | {
      type: "retry_wait";
      attempt: number;
      status?: number;
      elapsedMs: number;
      delayMs: number;
      reason: "http_429" | "http_5xx" | "request_error";
      timeout: boolean;
    }
  | {
      type: "http_attempt_error";
      attempt: number;
      elapsedMs: number;
      timeout: boolean;
      errorKind: "timeout" | "request_error";
    }
  | {
      type: "usage";
      attempt: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };

/** Telemetry observers are best-effort; observer failures never affect an LLM request. */
export type LlmTelemetryCallback = (
  event: LlmTelemetryEvent,
) => void;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  model?: string;
  thinking?: Record<string, unknown>;
  reasoning?: Record<string, unknown>;
  telemetry?: LlmTelemetryCallback;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | {
      type: "json_schema";
      json_schema: JsonSchema;
    };

type GeminiPart =
  | { text: string }
  | {
      inline_data: {
        mime_type: string;
        data: string;
      };
    };

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

const ensureArray = (
  value: MessageContent | MessageContent[],
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const MAX_INLINE_FILE_BYTES = 50 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 180_000;
const MAX_RETRIES = 4;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const emitTelemetry = (
  telemetry: LlmTelemetryCallback | undefined,
  event: LlmTelemetryEvent,
): void => {
  if (!telemetry) return;

  try {
    const result = telemetry(event) as unknown;
    if (
      result &&
      typeof (result as { catch?: unknown }).catch === "function"
    ) {
      void (result as Promise<unknown>).catch(() => undefined);
    }
  } catch {
    // Metrics must remain strictly observational.
  }
};

const elapsedMs = (startedAt: number): number =>
  Math.max(0, Date.now() - startedAt);

const responseBytesFromHeaders = (
  response: Response,
): number | undefined => {
  const header = response.headers.get("content-length");
  if (header === null || !header.trim()) return undefined;
  const length = Number(header);
  return Number.isFinite(length) && length >= 0
    ? length
    : undefined;
};

const fetchWithTimeout = async (
  url: string,
  init: RequestInit = {},
  onTimeout?: () => void,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => {
      try {
        onTimeout?.();
      } catch {
        // Timeout notification is observational only.
      }
      controller.abort();
    },
    REQUEST_TIMEOUT_MS,
  );

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const parseRetryAfter = (value: string | null): number | undefined => {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const at = Date.parse(value);
  return Number.isNaN(at)
    ? undefined
    : Math.max(0, at - Date.now());
};

const parseGeminiErrorPayload = (
  text: string,
): Record<string, unknown> | null => {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const parseGeminiRetryDelay = (
  text: string,
): number | undefined => {
  const payload = parseGeminiErrorPayload(text);
  const error = payload?.error;

  if (!error || typeof error !== "object") {
    return undefined;
  }

  const details = (error as Record<string, unknown>).details;

  if (!Array.isArray(details)) {
    return undefined;
  }

  const retryInfo = details.find((detail) => {
    if (!detail || typeof detail !== "object") {
      return false;
    }

    const type = String(
      (detail as Record<string, unknown>)["@type"] ?? "",
    );

    return type.includes("RetryInfo");
  });

  if (!retryInfo || typeof retryInfo !== "object") {
    return undefined;
  }

  const retryDelay = (
    retryInfo as Record<string, unknown>
  ).retryDelay;

  return typeof retryDelay === "string"
    ? parseRetryAfter(retryDelay)
    : undefined;
};

const isDailyQuotaExhausted = (
  text: string,
): boolean => {
  const payload = parseGeminiErrorPayload(text);
  const error = payload?.error;

  if (!error || typeof error !== "object") {
    return false;
  }

  const details = (error as Record<string, unknown>).details;

  if (!Array.isArray(details)) {
    return false;
  }

  return details.some((detail) => {
    if (!detail || typeof detail !== "object") {
      return false;
    }

    const violations = (
      detail as Record<string, unknown>
    ).violations;

    if (!Array.isArray(violations)) {
      return false;
    }

    return violations.some((violation) => {
      if (!violation || typeof violation !== "object") {
        return false;
      }

      const item = violation as Record<string, unknown>;

      const quotaMetric = String(
        item.quotaMetric ?? "",
      );

      const quotaId = String(
        item.quotaId ?? "",
      );

      return (
        quotaMetric.includes("PerDay") ||
        quotaId.includes("PerDay")
      );
    });
  });
};

const formatKoreaDateTime = (
  timestampMs: number,
): string =>
  new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(timestampMs));

const formatRemainingTime = (
  milliseconds: number,
): string => {
  let totalSeconds = Math.max(
    0,
    Math.ceil(milliseconds / 1000),
  );

  const hours = Math.floor(totalSeconds / 3600);
  totalSeconds %= 3600;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];

  if (hours > 0) {
    parts.push(`${hours}시간`);
  }

  if (minutes > 0) {
    parts.push(`${minutes}분`);
  }

  if (seconds > 0 || parts.length === 0) {
    parts.push(`${seconds}초`);
  }

  return parts.join(" ");
};

export class GeminiDailyQuotaError extends Error {
  constructor(retryAfterMs?: number) {
    if (retryAfterMs && retryAfterMs > 0) {
      const resetAt = Date.now() + retryAfterMs;

      super(
        `오늘 Gemini 무료 사용량을 모두 사용했습니다.\n` +
        `다시 사용할 수 있는 예상 시간: ${formatKoreaDateTime(resetAt)} (한국 시간)\n` +
        `남은 시간: 약 ${formatRemainingTime(retryAfterMs)}`,
      );
    } else {
      super(
        "오늘 Gemini 무료 사용량을 모두 사용했습니다. " +
        "Google이 초기화 예정 시간을 전달하지 않았습니다.",
      );
    }

    this.name = "GeminiDailyQuotaError";
  }
}

type GeminiFetchResult = {
  response: Response;
  attempt: number;
  startedAt: number;
};

const fetchGeminiWithBackoff = async (
  url: string,
  init: RequestInit,
  telemetry?: LlmTelemetryCallback,
): Promise<GeminiFetchResult> => {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const attemptNumber = attempt + 1;
    const startedAt = Date.now();
    let timedOut = false;
    emitTelemetry(telemetry, {
      type: "http_attempt_start",
      attempt: attemptNumber,
    });

    try {
      const response = await fetchWithTimeout(
        url,
        init,
        () => {
          timedOut = true;
        },
      );
      const headersElapsedMs = elapsedMs(startedAt);
      const responseBytes = responseBytesFromHeaders(response);
      emitTelemetry(telemetry, {
        type: "http_headers_received",
        attempt: attemptNumber,
        status: response.status,
        elapsedMs: headersElapsedMs,
        timeout: timedOut,
      });

      if (response.status === 429) {
        const bodyStartedAt = Date.now();
        let errorText = "";
        let parsed = false;
        try {
          errorText = await response.clone().text();
          parsed = true;
        } catch {
          // Existing retry behavior treats an unreadable cloned body as empty.
        }
        const bodyReadMs = elapsedMs(bodyStartedAt);
        const retryBodyBytes = parsed
          ? Buffer.byteLength(errorText)
          : responseBytes;
        emitTelemetry(telemetry, {
          type: "http_body_parsed",
          attempt: attemptNumber,
          status: response.status,
          parser: "retry_429_clone_text",
          bodyReadMs,
          responseBytes: retryBodyBytes,
          parsed,
          timeout: timedOut,
        });

        const retryAfterMs =
          parseRetryAfter(
            response.headers.get("retry-after"),
          ) ??
          parseGeminiRetryDelay(errorText);

        if (isDailyQuotaExhausted(errorText)) {
          emitTelemetry(telemetry, {
            type: "http_complete",
            attempt: attemptNumber,
            status: response.status,
            elapsedMs: elapsedMs(startedAt),
            bodyReadMs,
            responseBytes: retryBodyBytes,
            timeout: timedOut,
            outcome: "daily_quota",
          });
          throw new GeminiDailyQuotaError(
            retryAfterMs,
          );
        }

        if (attempt === MAX_RETRIES) {
          return {
            response,
            attempt: attemptNumber,
            startedAt,
          };
        }

        await response.body
          ?.cancel()
          .catch(() => undefined);

        const cap = Math.min(
          2_000 * 2 ** attempt,
          30_000,
        );

        const delay = Math.min(
          Math.max(cap, retryAfterMs ?? 0),
          30_000,
        );

        emitTelemetry(telemetry, {
          type: "http_complete",
          attempt: attemptNumber,
          status: response.status,
          elapsedMs: elapsedMs(startedAt),
          bodyReadMs,
          responseBytes: retryBodyBytes,
          timeout: timedOut,
          outcome: "retry",
        });
        emitTelemetry(telemetry, {
          type: "retry_wait",
          attempt: attemptNumber,
          status: response.status,
          elapsedMs: elapsedMs(startedAt),
          delayMs: delay,
          reason: "http_429",
          timeout: timedOut,
        });
        await sleep(delay);
        continue;
      }

      if (
        response.ok ||
        ![500, 502, 503, 504].includes(response.status) ||
        attempt === MAX_RETRIES
      ) {
        return {
          response,
          attempt: attemptNumber,
          startedAt,
        };
      }

      const retryAfterMs = parseRetryAfter(
        response.headers.get("retry-after"),
      );

      await response.body
        ?.cancel()
        .catch(() => undefined);

      const cap = Math.min(
        2_000 * 2 ** attempt,
        30_000,
      );

      const delay = Math.min(
        Math.max(cap, retryAfterMs ?? 0),
        30_000,
      );

      emitTelemetry(telemetry, {
        type: "http_complete",
        attempt: attemptNumber,
        status: response.status,
        elapsedMs: elapsedMs(startedAt),
        bodyReadMs: 0,
        responseBytes,
        timeout: timedOut,
        outcome: "retry",
      });
      emitTelemetry(telemetry, {
        type: "retry_wait",
        attempt: attemptNumber,
        status: response.status,
        elapsedMs: elapsedMs(startedAt),
        delayMs: delay,
        reason: "http_5xx",
        timeout: timedOut,
      });
      await sleep(delay);
    } catch (error) {
      if (error instanceof GeminiDailyQuotaError) {
        throw error;
      }

      lastError = error;
      const elapsed = elapsedMs(startedAt);
      emitTelemetry(telemetry, {
        type: "http_attempt_error",
        attempt: attemptNumber,
        elapsedMs: elapsed,
        timeout: timedOut,
        errorKind: timedOut ? "timeout" : "request_error",
      });

      if (attempt === MAX_RETRIES) {
        throw error;
      }

      const cap = Math.min(
        500 * 2 ** attempt,
        30_000,
      );

      emitTelemetry(telemetry, {
        type: "retry_wait",
        attempt: attemptNumber,
        elapsedMs: elapsed,
        delayMs: cap,
        reason: "request_error",
        timeout: timedOut,
      });
      await sleep(cap);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Gemini request failed");
};

const fileToInlinePart = async (
  part: ImageContent | FileContent,
): Promise<GeminiPart> => {
  // Hybrid grading uses local PNG crops. No upload URL or extra file fetch is
  // needed. Existing HTTP image/PDF handling below remains unchanged.
  if (part.type === "image_url" && part.image_url.url.startsWith("data:")) {
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url.url);
    if (!match) throw new Error("지원하지 않는 이미지 데이터 URL입니다.");
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.length === 0 || bytes.length > MAX_INLINE_FILE_BYTES) {
      throw new Error("이미지 데이터가 비어 있거나 Gemini 첨부 크기 제한을 초과합니다.");
    }
    return { inline_data: { mime_type: match[1], data: bytes.toString("base64") } };
  }

  const mimeType =
    part.type === "file_url"
      ? part.file_url.mime_type ?? "application/octet-stream"
      : "image/jpeg";

  const url =
    part.type === "file_url"
      ? part.file_url.url
      : part.image_url.url;

  const response = await fetchWithTimeout(url, {
    headers: {
      Accept: mimeType,
    },
  });

  if (!response.ok) {
    throw new Error(
      `첨부 파일 다운로드 실패: ${response.status} ${response.statusText}`,
    );
  }

  const contentLength = Number(
    response.headers.get("content-length") ?? 0,
  );

  if (contentLength > MAX_INLINE_FILE_BYTES) {
    throw new Error(
      "첨부 파일이 Gemini API의 50MB 제한을 초과합니다.",
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length > MAX_INLINE_FILE_BYTES) {
    throw new Error(
      "첨부 파일이 Gemini API의 50MB 제한을 초과합니다.",
    );
  }

  return {
    inline_data: {
      mime_type: mimeType,
      data: bytes.toString("base64"),
    },
  };
};

const normalizeMessageParts = async (
  message: Message,
): Promise<GeminiPart[]> => {
  const parts = ensureArray(message.content);

  return Promise.all(
    parts.map(async (part): Promise<GeminiPart> => {
      if (typeof part === "string") {
        return { text: part };
      }

      if (part.type === "text") {
        return { text: part.text };
      }

      return fileToInlinePart(part);
    }),
  );
};

const buildGeminiContents = async (
  messages: Message[],
): Promise<GeminiContent[]> => {
  const contents: GeminiContent[] = [];
  const systemTexts: string[] = [];

  for (const message of messages) {
    const parts = await normalizeMessageParts(message);

    if (message.role === "system") {
      const text = parts
        .filter(
          (part): part is { text: string } =>
            "text" in part,
        )
        .map((part) => part.text)
        .join("\n");

      if (text) {
        systemTexts.push(text);
      }

      continue;
    }

    const role =
      message.role === "assistant"
        ? "model"
        : "user";

    contents.push({
      role,
      parts,
    });
  }

  if (systemTexts.length > 0) {
    const systemPart: GeminiPart = {
      text: systemTexts.join("\n\n"),
    };

    if (contents.length > 0) {
      contents[0].parts.unshift(systemPart);
    } else {
      contents.push({
        role: "user",
        parts: [systemPart],
      });
    }
  }

  return contents;
};

const getResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: Pick<
  InvokeParams,
  | "responseFormat"
  | "response_format"
  | "outputSchema"
  | "output_schema"
>): ResponseFormat | undefined => {
  const explicit =
    responseFormat ?? response_format;

  if (explicit) {
    return explicit;
  }

  const schema =
    outputSchema ?? output_schema;

  if (schema) {
    return {
      type: "json_schema",
      json_schema: schema,
    };
  }

  return undefined;
};

const getGenerationConfig = (
  format: ResponseFormat | undefined,
  maxTokens: number | undefined,
): Record<string, unknown> => {
  const config: Record<string, unknown> = {};

  if (typeof maxTokens === "number") {
    config.max_output_tokens = maxTokens;
  }

  if (!format) {
    return config;
  }

  if (format.type === "json_object") {
    config.response_mime_type = "application/json";
  }

  if (format.type === "json_schema") {
    config.response_mime_type = "application/json";
    config.response_schema =
      format.json_schema.schema;
  }

  return config;
};

export async function invokeLLM(
  params: InvokeParams,
): Promise<InvokeResult> {
  if (!ENV.geminiApiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured",
    );
  }

  if (
    params.tools?.length ||
    params.toolChoice ||
    params.tool_choice
  ) {
    throw new Error(
      "Gemini migration does not support tool calling in invokeLLM yet.",
    );
  }

  const model =
    params.model ?? "gemini-3.5-flash";

  const contents = await buildGeminiContents(
    params.messages,
  );

  const responseFormat =
    getResponseFormat(params);

  const generationConfig =
    getGenerationConfig(
      responseFormat,
      params.max_tokens ?? params.maxTokens,
    );

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const requestBody = JSON.stringify({
    contents,
    ...(Object.keys(generationConfig).length > 0
      ? { generationConfig }
      : {}),
  });
  const inlineData = contents.flatMap((content) =>
    content.parts.filter(
      (part): part is Extract<GeminiPart, { inline_data: unknown }> =>
        "inline_data" in part,
    ),
  );
  emitTelemetry(params.telemetry, {
    type: "request_created",
    requestBytes: Buffer.byteLength(requestBody),
    imageCount: inlineData.filter((part) =>
      part.inline_data.mime_type.startsWith("image/"),
    ).length,
    inlineDataCount: inlineData.length,
  });

  const { response, attempt, startedAt } =
    await fetchGeminiWithBackoff(
      endpoint,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": ENV.geminiApiKey,
          "content-type": "application/json",
        },
        body: requestBody,
      },
      params.telemetry,
    );

  if (!response.ok) {
    const bodyStartedAt = Date.now();
    let errorText = "";
    let parsed = false;
    try {
      errorText = await response.text();
      parsed = true;
    } finally {
      const bodyReadMs = elapsedMs(bodyStartedAt);
      const responseBytes = parsed
        ? Buffer.byteLength(errorText)
        : responseBytesFromHeaders(response);
      emitTelemetry(params.telemetry, {
        type: "http_body_parsed",
        attempt,
        status: response.status,
        parser: "error_text",
        bodyReadMs,
        responseBytes,
        parsed,
        timeout: false,
      });
      emitTelemetry(params.telemetry, {
        type: "http_complete",
        attempt,
        status: response.status,
        elapsedMs: elapsedMs(startedAt),
        bodyReadMs,
        responseBytes,
        timeout: false,
        outcome: "response",
      });
    }

    throw new Error(
      `Gemini API failed: ${response.status} ${response.statusText} – ${errorText}`,
    );
  }

  const bodyStartedAt = Date.now();
  let parsed = false;
  let data!: {
    candidates?: Array<{
      index?: number;
      content?: {
        role?: string;
        parts?: Array<{
          text?: string;
        }>;
      };
      finishReason?: string;
    }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  try {
    data = (await response.json()) as typeof data;
    parsed = true;
  } finally {
    const bodyReadMs = elapsedMs(bodyStartedAt);
    const responseBytes = responseBytesFromHeaders(response);
    emitTelemetry(params.telemetry, {
      type: "http_body_parsed",
      attempt,
      status: response.status,
      parser: "response_json",
      bodyReadMs,
      responseBytes,
      parsed,
      timeout: false,
    });
    emitTelemetry(params.telemetry, {
      type: "http_complete",
      attempt,
      status: response.status,
      elapsedMs: elapsedMs(startedAt),
      bodyReadMs,
      responseBytes,
      timeout: false,
      outcome: "response",
    });
  }

  const candidate = data.candidates?.[0];

  const content =
    candidate?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("") ?? "";

  if (!content) {
    throw new Error(
      "Gemini API returned no text content",
    );
  }

  const usage = data.usageMetadata
    ? {
        prompt_tokens:
          data.usageMetadata.promptTokenCount ?? 0,
        completion_tokens:
          data.usageMetadata.candidatesTokenCount ?? 0,
        total_tokens:
          data.usageMetadata.totalTokenCount ?? 0,
      }
    : undefined;

  if (usage) {
    emitTelemetry(params.telemetry, {
      type: "usage",
      attempt,
      promptTokens: usage.prompt_tokens,
      completionTokens: usage.completion_tokens,
      totalTokens: usage.total_tokens,
    });
  }

  return {
    id: `${model}-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: candidate?.index ?? 0,
        message: {
          role: "assistant",
          content,
        },
        finish_reason:
          candidate?.finishReason ?? null,
      },
    ],
    usage,
  };
}

export type ModelInfo = {
  id: string;
  object: string;
  created: number;
  owned_by: string;
};

export type ModelsResponse = {
  object: string;
  data: ModelInfo[];
};

export async function listLLMModels(): Promise<ModelsResponse> {
  if (!ENV.geminiApiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured",
    );
  }

  const response = await fetchWithTimeout(
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100",
    {
      headers: {
        "x-goog-api-key": ENV.geminiApiKey,
      },
    },
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Gemini models failed: ${response.status} ${response.statusText} – ${errorText}`,
    );
  }

  const payload = (await response.json()) as {
    models?: Array<{
      name?: string;
    }>;
  };

  return {
    object: "list",
    data: (payload.models ?? []).map(
      (item) => ({
        id: (item.name ?? "").replace(
          /^models\//,
          "",
        ),
        object: "model",
        created: 0,
        owned_by: "google",
      }),
    ),
  };
}

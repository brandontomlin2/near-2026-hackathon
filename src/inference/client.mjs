// Inference client for the swarm agents.
//
// Two modes, chosen by MOCK_INFERENCE:
//   mock (default, MOCK_INFERENCE unset, "1" or "true"): deterministic replies
//     computed from a hash of the request. No network, no keys. A judge with
//     no account can run the whole demo and get the same transcript twice.
//   live (MOCK_INFERENCE "0" or "false"): NEAR AI Cloud, which speaks the
//     OpenAI chat-completions protocol at https://cloud-api.near.ai/v1.
//     Reads NEAR_AI_API_KEY and NEAR_AI_MODEL. NEAR_AI_BASE_URL overrides the
//     endpoint, which the tests use to point at a local server.
//
// The key never appears in errors, logs or returned objects.

import { createHash } from "node:crypto";

export const DEFAULT_BASE_URL = "https://cloud-api.near.ai/v1";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 8_000;
const MOCK_MODEL = "mock";

export class InferenceError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: number, code?: string, retryable?: boolean, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "InferenceError";
    this.status = details.status;
    this.code = details.code ?? "inference_error";
    this.retryable = details.retryable ?? false;
  }
}

/**
 * Parse MOCK_INFERENCE. Unset means mock, so a fresh clone never reaches the
 * network by accident.
 * @param {string | undefined} raw
 * @returns {"mock" | "live"}
 */
export function parseMode(raw) {
  const value = (raw ?? "1").trim().toLowerCase();
  if (value === "" || value === "1" || value === "true") return "mock";
  if (value === "0" || value === "false") return "live";
  throw new InferenceError(
    `MOCK_INFERENCE must be 1 or 0, got ${JSON.stringify(raw)}`,
    { code: "bad_config" },
  );
}

/**
 * @typedef {{ role: "system" | "user" | "assistant", content: string }} Message
 *
 * @typedef {object} ChatRequest
 * @property {Message[]} messages Ordered conversation. At least one message.
 * @property {string} [system] Convenience: prepended as a system message.
 * @property {number} [temperature]
 * @property {number} [maxTokens]
 * @property {number | string} [seed] Mixed into the mock hash. Passed to the
 *   live API as `seed` when numeric.
 *
 * @typedef {object} ChatResponse
 * @property {string} content Assistant text.
 * @property {"mock" | "live"} mode
 * @property {string} model
 * @property {string} id Provider response id, or `mock-<hash>` in mock mode.
 * @property {{ promptTokens: number, completionTokens: number }} usage
 *
 * @typedef {(request: NormalizedRequest, hash: string) => string} MockResponder
 *
 * @typedef {object} NormalizedRequest
 * @property {Message[]} messages
 * @property {string} model
 * @property {number | undefined} temperature
 * @property {number | undefined} maxTokens
 * @property {number | string | undefined} seed
 */

/**
 * Validate and flatten a request so mock and live see the same shape.
 * @param {ChatRequest} request
 * @param {string} model
 * @returns {NormalizedRequest}
 */
export function normalizeRequest(request, model) {
  if (!request || typeof request !== "object") {
    throw new InferenceError("request must be an object", { code: "bad_request" });
  }
  const messages = [];
  if (request.system !== undefined) {
    if (typeof request.system !== "string") {
      throw new InferenceError("system must be a string", { code: "bad_request" });
    }
    messages.push({ role: "system", content: request.system });
  }
  if (!Array.isArray(request.messages)) {
    throw new InferenceError("messages must be an array", { code: "bad_request" });
  }
  for (const [index, message] of request.messages.entries()) {
    const ok = message
      && typeof message === "object"
      && ["system", "user", "assistant"].includes(message.role)
      && typeof message.content === "string";
    if (!ok) {
      throw new InferenceError(
        `messages[${index}] must be { role: system|user|assistant, content: string }`,
        { code: "bad_request" },
      );
    }
    messages.push({ role: message.role, content: message.content });
  }
  if (messages.length === 0) {
    throw new InferenceError("at least one message is required", { code: "bad_request" });
  }
  return {
    messages,
    model,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    seed: request.seed,
  };
}

/**
 * Stable hash of everything that should change a mock reply.
 * @param {NormalizedRequest} request
 * @returns {string} 64-char hex sha256
 */
export function hashRequest(request) {
  const canonical = JSON.stringify({
    model: request.model,
    messages: request.messages,
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? null,
    seed: request.seed ?? null,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

const OPENERS = [
  "Noted.",
  "Hm.",
  "Fine.",
  "Interesting.",
  "Let me think.",
  "Right.",
  "Well.",
  "Okay.",
];

const BODIES = [
  "On {topic}, I would rather watch than commit.",
  "I have a question about {topic}: who checked it?",
  "Everyone keeps circling {topic}. I say we push on it.",
  "I can connect two of you on {topic} if that helps.",
  "{topic} again. The last time went about as expected.",
  "I will remember {topic}. It changes how I read the room.",
  "Count me in on {topic}, within reason.",
  "Show me the numbers on {topic} before I agree.",
];

const CLOSERS = [
  "",
  " That is all for now.",
  " Reply if you disagree.",
  " Logging it.",
];

/**
 * Pick a topic word from the last user message so the mock reply relates to
 * the prompt. Falls back to "this" for prompts with no long words.
 * @param {Message[]} messages
 */
function pickTopic(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user") ?? messages.at(-1);
  const words = last.content
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 5 && w.length <= 16);
  if (words.length === 0) return "this";
  let best = words[0];
  for (const word of words) {
    if (word.length > best.length) best = word;
  }
  return best;
}

/**
 * Default mock responder: a short, deterministic sentence built from the
 * request hash. Same request, same bytes, every run.
 * @type {MockResponder}
 */
export function defaultMockResponder(request, hash) {
  const byte = (i) => Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16);
  const opener = OPENERS[byte(0) % OPENERS.length];
  const body = BODIES[byte(1) % BODIES.length].replace("{topic}", pickTopic(request.messages));
  const closer = CLOSERS[byte(2) % CLOSERS.length];
  return `${opener} ${body}${closer}`;
}

function estimateTokens(messages) {
  return messages.reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);
}

/**
 * @param {{ model?: string, responder?: MockResponder }} [options]
 */
export function createMockClient(options = {}) {
  const model = options.model ?? MOCK_MODEL;
  const responder = options.responder ?? defaultMockResponder;
  return {
    mode: /** @type {const} */ ("mock"),
    model,
    /** @param {ChatRequest} request @returns {Promise<ChatResponse>} */
    async chat(request) {
      const normalized = normalizeRequest(request, model);
      const hash = hashRequest(normalized);
      const content = responder(normalized, hash);
      if (typeof content !== "string") {
        throw new InferenceError("mock responder must return a string", { code: "bad_responder" });
      }
      return {
        content,
        mode: "mock",
        model,
        id: `mock-${hash.slice(0, 16)}`,
        usage: {
          promptTokens: estimateTokens(normalized.messages),
          completionTokens: Math.ceil(content.length / 4),
        },
      };
    },
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function count(value) {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Read a response body for an error message without ever echoing more than a
 * short prefix. Provider bodies can be large or contain the request.
 */
async function errorSnippet(response, secret) {
  try {
    const text = await response.text();
    const redacted = secret ? text.split(secret).join("[redacted]") : text;
    return redacted.slice(0, 200).replace(/\s+/g, " ").trim();
  } catch {
    return "";
  }
}

/**
 * @param {{
 *   apiKey: string,
 *   model: string,
 *   baseUrl?: string,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 *   fetch?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 * }} options
 */
export function createLiveClient(options) {
  if (!options || typeof options.apiKey !== "string" || options.apiKey.trim().length === 0) {
    throw new InferenceError("live mode needs NEAR_AI_API_KEY", { code: "missing_api_key" });
  }
  if (typeof options.model !== "string" || options.model.length === 0) {
    throw new InferenceError("live mode needs NEAR_AI_MODEL", { code: "missing_model" });
  }
  const apiKey = options.apiKey.trim();
  const model = options.model;
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new InferenceError("maxRetries must be a non-negative integer", { code: "bad_config" });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InferenceError("timeoutMs must be a positive number", { code: "bad_config" });
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const wait = options.sleep ?? sleep;
  const url = `${baseUrl}/chat/completions`;

  async function send(body) {
    let response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause && cause.name === "TimeoutError";
      throw new InferenceError(
        timedOut ? `request to ${url} timed out after ${timeoutMs}ms` : `request to ${url} failed`,
        { code: timedOut ? "timeout" : "network", retryable: true, cause },
      );
    }
    if (!response.ok) {
      const snippet = await errorSnippet(response, apiKey);
      throw new InferenceError(
        `NEAR AI Cloud returned HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
        { status: response.status, code: "http_error", retryable: isRetryableStatus(response.status) },
      );
    }
    let data;
    try {
      data = await response.json();
    } catch (cause) {
      if (cause && cause.name === "TimeoutError") {
        throw new InferenceError(`reading response from ${url} timed out after ${timeoutMs}ms`, {
          code: "timeout", retryable: true, cause,
        });
      }
      throw new InferenceError("NEAR AI Cloud returned a non-JSON body", { code: "bad_response", cause });
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new InferenceError("NEAR AI Cloud response has no non-empty choices[0].message.content", {
        code: "bad_response",
      });
    }
    return {
      content,
      mode: /** @type {const} */ ("live"),
      model: typeof data.model === "string" ? data.model : model,
      id: typeof data.id === "string" ? data.id : "",
      usage: {
        promptTokens: count(data?.usage?.prompt_tokens),
        completionTokens: count(data?.usage?.completion_tokens),
      },
    };
  }

  return {
    mode: /** @type {const} */ ("live"),
    model,
    baseUrl,
    /** @param {ChatRequest} request @returns {Promise<ChatResponse>} */
    async chat(request) {
      const normalized = normalizeRequest(request, model);
      const body = { model, messages: normalized.messages };
      if (normalized.temperature !== undefined) body.temperature = normalized.temperature;
      if (normalized.maxTokens !== undefined) body.max_tokens = normalized.maxTokens;
      if (typeof normalized.seed === "number") body.seed = normalized.seed;

      let attempt = 0;
      for (;;) {
        try {
          return await send(body);
        } catch (error) {
          const retryable = error instanceof InferenceError && error.retryable;
          if (!retryable || attempt >= maxRetries) throw error;
          await wait(Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS));
          attempt += 1;
        }
      }
    },
  };
}

/**
 * Build the client the environment asks for. Pass `env` in tests; defaults to
 * process.env. Everything else can be overridden explicitly.
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   responder?: MockResponder,
 *   fetch?: typeof fetch,
 *   timeoutMs?: number,
 *   maxRetries?: number,
 * }} [options]
 */
export function createInferenceClient(options = {}) {
  const env = options.env ?? process.env;
  const mode = parseMode(env.MOCK_INFERENCE);
  if (mode === "mock") {
    return createMockClient({ responder: options.responder, model: env.NEAR_AI_MODEL || MOCK_MODEL });
  }
  return createLiveClient({
    apiKey: env.NEAR_AI_API_KEY ?? "",
    model: env.NEAR_AI_MODEL ?? "",
    baseUrl: env.NEAR_AI_BASE_URL || DEFAULT_BASE_URL,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
  });
}

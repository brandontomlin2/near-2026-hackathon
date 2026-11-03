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
// The key never appears in errors, logs or returned objects. Neither does the
// base URL's userinfo: a URL with credentials is refused when the client is made.
//
// Reply text is bounded: control and bidi characters become U+FFFD and the text
// is cut at MAX_CONTENT_BYTES, both with the helpers in src/util/text.mjs, so a
// reply can neither drive the terminal nor grow a sheet or share card without
// limit. Live requests always carry max_tokens (DEFAULT_MAX_TOKENS unless the
// caller sets one).

import { createHash } from "node:crypto";
import { inspect } from "node:util";
import { capUtf8Bytes, replaceUnsafeChars } from "../util/text.mjs";

export const DEFAULT_BASE_URL = "https://cloud-api.near.ai/v1";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;
// Largest response body the client will buffer. A chat completion is a few KiB;
// 4 MiB leaves room for very long replies while bounding memory per request.
export const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
// Sent as max_tokens on every live request that does not set maxTokens. Sheets are
// under 200 words and swarm replies one or two sentences, so this is generous.
export const DEFAULT_MAX_TOKENS = 1024;
// Upper bound on reply text, in UTF-8 bytes, whatever the provider or responder returns.
export const MAX_CONTENT_BYTES = 32 * 1024;
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

/** The one place reply text is made safe to store and print: no control or bidi characters, bounded size. */
function boundContent(content) {
  return capUtf8Bytes(replaceUnsafeChars(content), MAX_CONTENT_BYTES);
}

// Provider-supplied labels (model, id) are printed too (infer --json); same treatment, short cap.
const MAX_LABEL_BYTES = 200;
function boundLabel(value, fallback) {
  return typeof value === "string" ? capUtf8Bytes(replaceUnsafeChars(value), MAX_LABEL_BYTES) : fallback;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validate the endpoint. A URL carrying userinfo (http://user:secret@host) is refused
 * outright, and the message never echoes the value, so credentials cannot leak into
 * the "request to <url> failed" errors or logs.
 * @param {string} raw
 * @returns {string} the base URL without a trailing slash
 */
function checkBaseUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new InferenceError("NEAR_AI_BASE_URL must be an absolute http(s) URL", { code: "bad_config" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InferenceError("NEAR_AI_BASE_URL must be an absolute http(s) URL", { code: "bad_config" });
  }
  // Plain http would send the bearer key and the prompt in cleartext. It is only allowed to a
  // loopback host (the local test stub). The message never echoes the URL.
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new InferenceError("NEAR_AI_BASE_URL must use https:// unless the host is loopback (localhost, 127.0.0.1, ::1)", { code: "bad_config" });
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new InferenceError("NEAR_AI_BASE_URL must not contain credentials (user:password@host); the key goes in NEAR_AI_API_KEY", {
      code: "bad_config",
    });
  }
  return raw.replace(/\/+$/, "");
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
      const raw = responder(normalized, hash);
      if (typeof raw !== "string") {
        throw new InferenceError("mock responder must return a string", { code: "bad_responder" });
      }
      const content = boundContent(raw);
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

function redact(text, secret) {
  return secret ? text.split(secret).join("[redacted]") : text;
}

/**
 * Keep an underlying error as `cause` only in a form that cannot show the
 * key. A fetch implementation or proxy may quote request headers in its
 * message, and console.error prints the whole cause chain.
 */
function scrubCause(cause, secret) {
  if (!inspect(cause, { depth: 10 }).includes(secret)) return cause;
  const copy = new Error(redact(String(cause?.message ?? cause), secret));
  if (cause?.name) copy.name = cause.name;
  if (cause?.code !== undefined) copy.code = cause.code;
  return copy;
}

/**
 * Buffer a response body up to `maxBytes`. Past that, abort the request and
 * throw response_too_large. The error carries no body, header or key.
 * @param {Response} response
 * @param {number} maxBytes
 * @param {AbortController} controller
 * @returns {Promise<string>}
 */
async function readBodyCapped(response, maxBytes, controller) {
  const tooLarge = () => {
    controller.abort();
    return new InferenceError(`NEAR AI Cloud response body exceeded the ${maxBytes} byte limit`, {
      code: "response_too_large",
    });
  };
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      const error = tooLarge();
      await reader.cancel().catch(() => {});
      throw error;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Read a response body for an error message without ever echoing more than a
 * short prefix. Provider bodies can be large or contain the request.
 */
async function errorSnippet(response, secret, maxBytes, controller) {
  try {
    const text = await readBodyCapped(response, maxBytes, controller);
    // Error text reaches stderr: no terminal control characters from the provider either.
    return replaceUnsafeChars(redact(text, secret)).slice(0, 200).replace(/\s+/g, " ").trim();
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
 *   maxResponseBytes?: number,
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
  const baseUrl = checkBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) {
    throw new InferenceError("maxRetries must be a non-negative integer", { code: "bad_config" });
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new InferenceError("timeoutMs must be a positive number", { code: "bad_config" });
  }
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new InferenceError("maxResponseBytes must be a positive integer", { code: "bad_config" });
  }
  const doFetch = options.fetch ?? globalThis.fetch;
  const wait = options.sleep ?? sleep;
  const url = `${baseUrl}/chat/completions`;

  async function send(body) {
    const controller = new AbortController();
    let response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), controller.signal]),
      });
    } catch (cause) {
      const timedOut = cause && cause.name === "TimeoutError";
      throw new InferenceError(
        timedOut ? `request to ${url} timed out after ${timeoutMs}ms` : `request to ${url} failed`,
        { code: timedOut ? "timeout" : "network", retryable: true, cause: scrubCause(cause, apiKey) },
      );
    }
    if (!response.ok) {
      const snippet = await errorSnippet(response, apiKey, maxResponseBytes, controller);
      throw new InferenceError(
        `NEAR AI Cloud returned HTTP ${response.status}${snippet ? `: ${snippet}` : ""}`,
        { status: response.status, code: "http_error", retryable: isRetryableStatus(response.status) },
      );
    }
    let data;
    try {
      data = JSON.parse(await readBodyCapped(response, maxResponseBytes, controller));
    } catch (cause) {
      if (cause instanceof InferenceError) throw cause;
      if (cause && cause.name === "TimeoutError") {
        throw new InferenceError(`reading response from ${url} timed out after ${timeoutMs}ms`, {
          code: "timeout", retryable: true, cause: scrubCause(cause, apiKey),
        });
      }
      // No cause here: V8's SyntaxError quotes the first bytes of the body,
      // which is whatever the provider or a proxy sent. The content type is
      // the useful diagnostic (an HTML error page, usually).
      throw new InferenceError(
        `NEAR AI Cloud returned a non-JSON body (content-type ${response.headers.get("content-type") ?? "unknown"})`,
        { code: "bad_response" },
      );
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") {
      throw new InferenceError("NEAR AI Cloud response has no non-empty choices[0].message.content", {
        code: "bad_response",
      });
    }
    return {
      content: boundContent(content),
      mode: /** @type {const} */ ("live"),
      model: boundLabel(data.model, model),
      id: boundLabel(data.id, ""),
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
      // max_tokens is always sent. The default lives here and not in the callers because the
      // mock hash covers maxTokens: a caller adding it would move every mock transcript.
      const body = { model, messages: normalized.messages, max_tokens: normalized.maxTokens ?? DEFAULT_MAX_TOKENS };
      if (normalized.temperature !== undefined) body.temperature = normalized.temperature;
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
 *   maxResponseBytes?: number,
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
    maxResponseBytes: options.maxResponseBytes,
  });
}

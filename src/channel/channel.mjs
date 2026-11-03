// The shared channel: one ordered, in-memory log that every agent posts to and
// reads from. Serializable to JSONL; no file I/O here, callers handle files.
// Entries carry no timestamp so the same run gives the same bytes.

import { canonicalJson, sha256Hex } from "../anchor/hash.mjs";

export const MAX_TEXT_LENGTH = 500;
const AUTHOR_RE = /^[a-z][a-z0-9_-]{0,31}$/;

export class ChannelError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = "ChannelError";
    this.code = details.code ?? "channel_error";
  }
}

function badPost(message) {
  return new ChannelError(message, { code: "bad_post" });
}

/**
 * @typedef {{ seq: number, round: number, author: string, text: string, replyTo?: number }} Entry
 */

/**
 * @param {{ id?: string, entries?: Entry[] }} [options]
 */
export function createChannel({ id = "shared", entries } = {}) {
  if (typeof id !== "string" || id.trim() === "") {
    throw new ChannelError("channel id must be a non-empty string", { code: "bad_config" });
  }
  /** @type {Entry[]} */
  const log = [];

  const copy = (entry) => ({ ...entry });

  function find(seq) {
    return Number.isInteger(seq) && seq >= 1 ? log[seq - 1] : undefined;
  }

  function post({ round, author, text, replyTo } = {}) {
    if (!Number.isInteger(round) || round < 0) {
      throw badPost("round must be an integer >= 0");
    }
    const last = log[log.length - 1];
    if (last && round < last.round) {
      throw badPost(`round ${round} is before the last round ${last.round}`);
    }
    if (typeof author !== "string" || !AUTHOR_RE.test(author)) {
      throw badPost("author must match /^[a-z][a-z0-9_-]{0,31}$/");
    }
    if (typeof text !== "string" || text.trim() === "") {
      throw badPost("text must be a non-empty string");
    }
    const trimmed = text.trim();
    if (trimmed.length > MAX_TEXT_LENGTH) {
      throw badPost(`text is longer than ${MAX_TEXT_LENGTH} characters`);
    }
    const entry = { seq: log.length + 1, round, author, text: trimmed };
    if (replyTo !== undefined) {
      const parent = find(replyTo);
      if (!parent) throw badPost(`replyTo ${String(replyTo)} is not an existing seq`);
      if (parent.round > round) throw badPost("replyTo points at a later round");
      entry.replyTo = replyTo;
    }
    log.push(entry);
    return copy(entry);
  }

  const channel = {
    id,
    post,

    /** @param {{ round?: number, author?: string, since?: number }} [filter] */
    read({ round, author, since } = {}) {
      return log
        .filter(
          (e) =>
            (round === undefined || e.round === round) &&
            (author === undefined || e.author === author) &&
            (since === undefined || e.seq > since),
        )
        .map(copy);
    },

    /** Root first chain ending at `seq`. */
    thread(seq) {
      let current = find(seq);
      if (!current) throw new ChannelError(`unknown seq ${String(seq)}`, { code: "unknown_seq" });
      const chain = [];
      while (current) {
        chain.push(copy(current));
        current = current.replyTo === undefined ? undefined : find(current.replyTo);
      }
      return chain.reverse();
    },

    roundDigest(round) {
      return sha256Hex(canonicalJson(log.filter((e) => e.round === round)));
    },

    entries() {
      return log.map(copy);
    },

    get size() {
      return log.length;
    },

    get length() {
      return log.length;
    },

    toJSONL() {
      return log.map((e) => `${canonicalJson(e)}\n`).join("");
    },
  };

  if (entries !== undefined) {
    if (!Array.isArray(entries)) {
      throw new ChannelError("entries must be an array", { code: "bad_log" });
    }
    entries.forEach((e, i) => {
      if (e === null || typeof e !== "object" || e.seq !== i + 1) {
        throw new ChannelError(`entry ${i + 1} has a missing or out-of-order seq`, {
          code: "bad_log",
        });
      }
      try {
        post({ round: e.round, author: e.author, text: e.text, replyTo: e.replyTo });
      } catch (err) {
        throw new ChannelError(`entry ${i + 1} is invalid: ${err.message}`, {
          code: "bad_log",
          cause: err,
        });
      }
    });
  }

  return channel;
}

/**
 * Rebuild a channel from JSONL, with the same validation as post().
 * @param {string} jsonl
 * @param {{ id?: string }} [options]
 */
export function loadChannel(jsonl, { id } = {}) {
  if (typeof jsonl !== "string") {
    throw new ChannelError("log must be a string", { code: "bad_log" });
  }
  const lines = jsonl.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  const entries = lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new ChannelError(`line ${i + 1} is not valid JSON`, { code: "bad_log", cause: err });
    }
  });
  return createChannel({ id, entries });
}

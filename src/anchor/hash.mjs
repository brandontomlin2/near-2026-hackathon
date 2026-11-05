// Hashing helpers for character sheets and channel digests.
//
// A sheet is normalized before hashing so that the same words always give the
// same hash, whatever line endings or trailing spaces an editor left behind.

import { createHash } from "node:crypto";

export const SHEET_HASH_RE = /^[0-9a-f]{64}$/;

export class HashError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "HashError";
    this.code = details.code ?? "hash_error";
  }
}

/**
 * Deterministic JSON: object keys sorted recursively, arrays in order, no
 * whitespace. Throws on undefined, non-finite numbers and non-JSON types.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new HashError("canonicalJson: non-finite number", { code: "bad_json" });
      }
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new HashError("canonicalJson: only plain objects and arrays can be hashed", {
          code: "bad_json",
        });
      }
      const keys = Object.keys(value).sort();
      const parts = keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
      return `{${parts.join(",")}}`;
    }
    default:
      throw new HashError(`canonicalJson: unsupported type ${typeof value}`, {
        code: "bad_json",
      });
  }
}

/**
 * @param {string} text
 * @returns {string} lowercase 64-char hex SHA-256 of the UTF-8 bytes
 */
export function sha256Hex(text) {
  if (typeof text !== "string") {
    throw new HashError("sha256Hex: text must be a string", { code: "bad_text" });
  }
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * NFC, LF line endings, no trailing whitespace per line, no leading or
 * trailing blank space, exactly one final newline.
 * @param {string} text
 * @returns {string}
 */
export function normalizeSheet(text) {
  if (typeof text !== "string") {
    throw new HashError("sheet must be a string", { code: "bad_sheet" });
  }
  const body = text
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim();
  if (body === "") {
    throw new HashError("sheet is empty after normalizing", { code: "bad_sheet" });
  }
  return `${body}\n`;
}

/**
 * The one official sheet hash: sha256 (lowercase hex) of normalizeSheet(text).
 * The summarizer, the anchor module, the memory loop and the transfer check all call it.
 * @param {string} text
 * @returns {string}
 */
export function hashSheet(text) {
  return sha256Hex(normalizeSheet(text));
}

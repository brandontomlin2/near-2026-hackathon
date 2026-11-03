// Text safety shared by every path that stores or shows model output: the HTML
// pages, the transcript and events files, and the CLIs' stdout.

// C0/C1 controls (except tab, LF, CR) and bidi overrides/isolates. A model could use
// them to reorder or hide the text around it (trojan-source style), clear the
// terminal (ESC [2J), retitle it or plant a hyperlink (OSC sequences). Show U+FFFD instead.
export const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g;

/**
 * Replace every unsafe character with U+FFFD. Length-preserving (each is one UTF-16 unit).
 * @param {unknown} value
 * @returns {string}
 */
export function replaceUnsafeChars(value) {
  return String(value).replace(UNSAFE_CHARS, "�");
}

/**
 * Cut `text` so its UTF-8 encoding is at most `maxBytes`, never splitting a code point.
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function capUtf8Bytes(text, maxBytes) {
  if (!Number.isInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative integer");
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const n = Buffer.byteLength(ch, "utf8");
    if (bytes + n > maxBytes) break;
    bytes += n;
    end += ch.length;
  }
  return text.slice(0, end);
}

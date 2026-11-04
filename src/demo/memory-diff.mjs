// One terminal line per agent: how its memory moved from the first sheet to the latest.
//
// The sheets are free text written by a model (or the offline stand-in), so the
// labels are matched loosely and anything missing prints as "none". Output goes
// to a terminal: control and bidi characters become U+FFFD and values are clipped.

import { replaceUnsafeChars } from "../util/text.mjs";

const MAX_VALUE_CHARS = 80;
// A placeholder must end the value or be followed by a non-word character: "none yet"
// is none, "nonetheless" is a value. `\b` would never let "-" or "(none)" match.
const NONE = /^(?:none|nobody|no one|no-one|nothing|n\/a|-|\(none\))(?!\w)/i;

// A section runs from its label to the next ". Label:" (a sentence end followed
// by a capitalised label) or to the end of the sheet, so renamed or reordered
// labels in a neighbouring section do not leak into this one.
const SECTION_END = /\.\s+(?=[A-Z][\w #'/-]{0,40}:\s)/;

// Candidate labels per field, most specific first; the first one found wins.
const LABELS = Object.freeze({
  enemy: [/\bpublic enemy\b[^:\n]{0,20}:\s*/i, /\b(?:arch-?rival|nemesis|enemy|rival)\b[^:\n]{0,20}:\s*/i],
  friend: [/\bride[- ]or[- ]die\b[^:\n]{0,20}:\s*/i, /\b(?:best friend|bestie|ally|friend)\b[^:\n]{0,20}:\s*/i],
  quote: [/\bsignature quote\b[^:\n]{0,20}:\s*/i, /\b(?:catchphrase|quote)\b[^:\n]{0,20}:\s*/i],
});

function clean(text) {
  const flat = replaceUnsafeChars(text).replace(/\s+/g, " ").trim();
  const chars = Array.from(flat); // code points, so clipping never splits a surrogate pair
  return chars.length > MAX_VALUE_CHARS ? `${chars.slice(0, MAX_VALUE_CHARS - 3).join("").trimEnd()}...` : flat;
}

/**
 * Text of one labelled section of a sheet, or "" when no label matches.
 * @param {string} sheet
 * @param {RegExp | RegExp[]} labels tried in order
 * @returns {string}
 */
export function sheetSection(sheet, labels) {
  const text = String(sheet ?? "");
  for (const label of [labels].flat()) {
    const match = label.exec(text);
    if (!match) continue;
    const rest = text.slice(match.index + match[0].length);
    const end = SECTION_END.exec(rest);
    const value = (end ? rest.slice(0, end.index) : rest).trim().replace(/[.!?;,]+$/, "").trim();
    return clean(value);
  }
  return "";
}

/** The enemy, friend and quote named by one sheet; "none" when a field is missing or says so. */
export function sheetFacts(sheet) {
  const pick = (label) => {
    const value = sheetSection(sheet, label);
    return !value || NONE.test(value) ? "none" : value;
  };
  // Drop the sheet's own quotation marks (the closing one may already be clipped away).
  const quote = sheetSection(sheet, LABELS.quote).replace(/^["“”]\s*|\s*["“”]$/g, "").trim();
  return {
    enemy: pick(LABELS.enemy),
    friend: pick(LABELS.friend),
    quote: !quote || NONE.test(quote) ? "none" : quote,
  };
}

const arrow = (from, to) => (from === to ? to : `${from} -> ${to}`);

/**
 * "chaotic: enemy none -> Skeptic (4 fights), ride-or-die none -> Social, quote "..."".
 * @param {{ id: string, sheets: { sheet: string }[] }} agent one manifest agent
 * @returns {string}
 */
export function memoryDiffLine(agent) {
  const sheets = Array.isArray(agent?.sheets) ? agent.sheets : [];
  const id = clean(agent?.id ?? "agent");
  if (sheets.length === 0) return `${id}: no sheet yet`;
  const first = sheetFacts(sheets[0]?.sheet);
  const latest = sheetFacts(sheets.at(-1)?.sheet);
  const quote = latest.quote === "none" ? "none" : `"${latest.quote}"`;
  return `${id}: enemy ${arrow(first.enemy, latest.enemy)}, ride-or-die ${arrow(first.friend, latest.friend)}, quote ${quote}`;
}

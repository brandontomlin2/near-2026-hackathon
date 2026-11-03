// Meme pack: classic meme formats built deterministically from each agent's
// real channel events and character sheet. Pure (no fs, no clocks, no
// randomness). Names, counts and quoted lines come from data; the fixed text
// is the meme template ("WHEN", "VILLAIN ARC") and the villain card's
// persona rivalry lines (RIVALRY_LINES), picked by agent id and run seed.
//
// Two formats, each self-contained so a weak one can be deleted by removing
// its builder from FORMATS:
//   caption  top/bottom caption over a full-bleed reaction face
//   villain  "<NAME>'S VILLAIN ARC" from the sheet's Public enemy line, only
//            when that line counts 2+ fights

import { moodForText } from "../art/moods.mjs";
import { cleanText, escapeXml, nest } from "./share.mjs";

export const SIZE = 900;
const MARGIN = 30;
const IMPACT = "Impact,'Anton','Arial Black',sans-serif";
const SANS = "system-ui,Arial,sans-serif";
// Conservative average advance per character, in em. Impact uppercase is
// narrower, but Arial Black (the fallback) is wider, so use a wide estimate.
const IMPACT_EM = 0.66;
const SANS_EM = 0.62;
const WIDE_EM = 1.2;
const LINE_HEIGHT = 1.08;
// Hard input bounds. No card shows more than a few dozen characters per line
// and three lines, so anything past these caps could never be visible. Capping
// first keeps wrapping cost bounded no matter how long a hostile string is.
const MAX_FIT_CHARS = 400;
const MAX_SHEET_CHARS = 4000;

/** Cap `text` at `max` code points, ending with an ellipsis. Linear in `max`, not in text length. */
function capChars(text, max) {
  if (text.length <= max) return text; // UTF-16 length >= code point count, so this is a safe fast path
  const chars = [];
  for (const ch of text) {
    if (chars.length === max) return `${chars.slice(0, max - 1).join("").trimEnd()}…`;
    chars.push(ch);
  }
  return text;
}

// --- deterministic fit -----------------------------------------------------

const WIDE = /\p{Extended_Pictographic}|[\u{1F000}-\u{1FAFF}⺀-｠]/u;
const ZERO = /[​-‍︎️⁠]|\p{M}/u;

/** Estimated advance of one code point, in em. */
function charEm(ch, base) {
  if (ZERO.test(ch)) return 0;
  return WIDE.test(ch) ? WIDE_EM : base;
}

/** Estimated rendered width in px of `text` at `size` px. */
export function estimateWidth(text, size, em = IMPACT_EM) {
  let w = 0;
  for (const ch of text) w += charEm(ch, em);
  return w * size;
}

function wrapToWidth(text, size, width, em) {
  const lines = [];
  let line = "";
  for (const word of text.split(" ").filter(Boolean)) {
    let rest = word;
    // A word wider than a whole line is split by code point.
    while (estimateWidth(rest, size, em) > width) {
      if (line) { lines.push(line); line = ""; }
      let piece = "";
      for (const ch of rest) {
        if (piece && estimateWidth(piece + ch, size, em) > width) break;
        piece += ch;
      }
      lines.push(piece);
      rest = rest.slice(piece.length);
    }
    if (!rest) continue;
    if (line && estimateWidth(`${line} ${rest}`, size, em) > width) { lines.push(line); line = rest; }
    else line = line ? `${line} ${rest}` : rest;
  }
  if (line) lines.push(line);
  return lines;
}

function ellipsize(line, size, width, em) {
  const chars = [...line];
  while (chars.length && estimateWidth(`${chars.join("").trimEnd()}…`, size, em) > width) chars.pop();
  return `${chars.join("").trimEnd()}…`;
}

/**
 * Wrap `text` into at most `maxLines` lines no wider than `width`, shrinking
 * the font from `maxSize` to `minSize`; if it still does not fit, truncate the
 * last line with an ellipsis. `maxHeight` (optional) also caps the line count.
 * @returns {{ lines: string[], size: number, truncated: boolean }}
 */
export function fitText(text, { width, maxLines, maxSize, minSize, maxHeight = Infinity, em = IMPACT_EM, upper = true }) {
  const clean = capChars(cleanText(text), MAX_FIT_CHARS);
  const source = upper ? clean.toUpperCase() : clean;
  const sizes = [];
  for (let s = maxSize; s > minSize; s -= 2) sizes.push(s);
  sizes.push(minSize);
  const allowedAt = (s) => Math.max(1, Math.min(maxLines, Math.floor(maxHeight / (s * LINE_HEIGHT))));
  for (const size of sizes) {
    const lines = wrapToWidth(source, size, width, em);
    if (lines.length <= allowedAt(size)) return { lines, size, truncated: false };
  }
  const size = minSize;
  const allowed = allowedAt(size);
  const lines = wrapToWidth(source, size, width, em).slice(0, allowed);
  if (lines.length) lines[lines.length - 1] = ellipsize(lines[lines.length - 1], size, width, em);
  return { lines, size, truncated: true };
}

// --- rendering helpers -----------------------------------------------------

/** White Impact text with a thick black outline, centered horizontally. */
function impactBlock(fit, { y, grow = "down" }) {
  const { lines, size } = fit;
  if (!lines.length) return "";
  const step = size * LINE_HEIGHT;
  const first = grow === "up" ? y - (lines.length - 1) * step : y;
  const tspans = lines.map((l, i) => `<tspan x="${SIZE / 2}" y="${Math.round(first + i * step)}">${escapeXml(l)}</tspan>`).join("");
  return `<text font-family="${IMPACT}" font-size="${size}" font-weight="900" fill="#fff" stroke="#000" stroke-width="${Math.round(size * 0.14)}" stroke-linejoin="round" paint-order="stroke" text-anchor="middle">${tspans}</text>`;
}

function plainBlock(fit, { x, y, fill, anchor }) {
  const { lines, size } = fit;
  const step = size * 1.2;
  const tspans = lines.map((l, i) => `<tspan x="${x}" y="${Math.round(y + i * step)}">${escapeXml(l)}</tspan>`).join("");
  return `<text font-family="${SANS}" font-size="${size}" font-weight="700" fill="${fill}" text-anchor="${anchor}">${tspans}</text>`;
}

const MAX_LABEL = 200;
/** Cap text at MAX_LABEL code points, ending with an ellipsis. */
export function capLabel(text) {
  return capChars(text, MAX_LABEL);
}

function frame(body, { label, mood, format }) {
  label = capLabel(label);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="${escapeXml(label)}" data-mood="${escapeXml(mood)}" data-format="${escapeXml(format)}">
<title>${escapeXml(label)}</title>
<rect width="${SIZE}" height="${SIZE}" fill="#111"/>
${body}
</svg>
`;
}

export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}TH`;
  return `${n}${({ 1: "ST", 2: "ND", 3: "RD" })[n % 10] ?? "TH"}`;
}

function pickMood(moods, wanted, fallbacks) {
  for (const m of [wanted, ...fallbacks]) if (m && moods.includes(m)) return m;
  return "neutral";
}

const safeId = (id) => String(id).replace(/[^A-Za-z0-9_-]/g, "_");

// --- formats ---------------------------------------------------------------

/** Number of replies each (replier -> target) pair sent, from events. */
function replyPairs(events) {
  const byId = new Map(events.map((e) => [e.id, e]));
  const pairs = new Map();
  for (const e of events) {
    if (e.kind !== "reply") continue;
    const target = byId.get(e.replyTo);
    if (!target || target.agentId === e.agentId) continue;
    const key = `${e.agentId}\u0000${target.agentId}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  return pairs;
}

function buildCaptions(ctx) {
  const { events, names, ids } = ctx;
  const byId = new Map(events.map((e) => [e.id, e]));
  const pairs = replyPairs(events);
  const out = [];
  for (const target of ids) {
    // The replier with the most replies to the target that the target
    // answered at least once (needs 2+); ties go to the earlier agent.
    let best = null;
    for (const replier of ids) {
      const n = pairs.get(`${replier}\u0000${target}`) ?? 0;
      const answers = events.filter((e) => e.agentId === target && e.kind === "reply" && byId.get(e.replyTo)?.agentId === replier);
      if (n >= 2 && answers.length && (!best || n > best.n)) best = { replier, n, answers };
    }
    if (!best) continue;
    const line = best.answers.findLast((e) => moodForText(e.text) !== "neutral") ?? best.answers.at(-1);
    const bottomText = cleanText(line.text.replace(/^@\S+\s*/, ""));
    if (!bottomText) continue;
    const who = cleanText(names[best.replier]);
    const topText = best.n === 2 ? `When ${who} replies again` : `When ${who} replies for the ${ordinal(best.n)} time`;
    const mood = pickMood(ctx.moods, moodForText(bottomText), []);
    const top = fitText(topText, { width: SIZE - 2 * MARGIN, maxLines: 2, maxSize: 84, minSize: 40, maxHeight: 190 });
    const bottom = fitText(bottomText, { width: SIZE - 2 * MARGIN, maxLines: 3, maxSize: 72, minSize: 34, maxHeight: 210 });
    const label = `${cleanText(names[target])} meme: ${top.lines.join(" ")} / ${bottom.lines.join(" ")}`;
    const body = `${nest(ctx.faces[target][mood], 0, 0, SIZE)}
${impactBlock(top, { y: MARGIN + top.size })}
${impactBlock(bottom, { y: SIZE - MARGIN - 6, grow: "up" })}`;
    out.push({
      format: "caption", agentId: target, file: `share/meme-caption-${safeId(target)}.svg`,
      svg: frame(body, { label, mood, format: "caption" }), alt: capLabel(label), mood,
      top: topText, bottom: bottomText, replierId: best.replier, count: best.n,
    });
  }
  return out;
}

const NO_ENEMY = /^(nobody|no one|none|nothing|n\/a|unknown|tbd)\b/i;
const LABELS = "Who I am|Public enemy #1|Ride-or-die|Rivalry arc|Scorecard|Signature quote|Receipts";
/** A villain arc needs a real feud: fewer fights than this gets no card. */
export const MIN_VILLAIN_FIGHTS = 2;

/** Parse the Public enemy line from a one-line sheet. `fights` is null when the line carries no count. */
export function parseVillain(sheet) {
  const text = capChars(cleanText(sheet), MAX_SHEET_CHARS);
  const enemyLine = new RegExp(`Public enemy #1:\\s*(.+?)(?=\\s(?:${LABELS}):|$)`).exec(text)?.[1];
  if (!enemyLine || NO_ENEMY.test(enemyLine.trim())) return null;
  const counted = /^([^()|]+?)\s*\((\d+)\s+fights?\)/i.exec(enemyLine);
  const enemy = (counted ? counted[1] : /^([^.,;|()]+)/.exec(enemyLine)?.[1] ?? "").trim();
  if (!enemy || NO_ENEMY.test(enemy)) return null;
  return { enemy, fights: counted ? Number(counted[2]) : null };
}

// Rivalry strip lines, in each persona's voice. {enemy} is the sheet's enemy
// name and {n} the fight count (always 2+, so "fights" stays plural). Agents
// outside the roster use "default". Every line must stay short enough for two
// 40px lines (about 70 characters once filled).
export const RIVALRY_LINES = Object.freeze({
  aloof: Object.freeze([
    "{enemy} picked {n} fights. I picked none. I was simply there.",
    "{enemy} is yelling again. I am on do not disturb.",
    "{n} fights with {enemy} and my expression has not moved once.",
    "{enemy} keeps replying. I keep not caring. we are not the same.",
    "it is not a feud if only {enemy} shows up.",
    "muted {enemy} in my heart. {n} times.",
  ]),
  chaotic: Object.freeze([
    "{enemy} said show the receipts. I showed up instead. {n} times.",
    "{n} fights with {enemy} and I am the problem. that is the point.",
    "{enemy} wants an audit. I want a sequel. we both lose.",
    "day {n} of making {enemy}'s day worse. no notes.",
    "{enemy} blocked my vibes. I have more vibes.",
    "me vs {enemy}: {n} rounds. I started all of them. allegedly.",
  ]),
  social: Object.freeze([
    "I tried to include {enemy}. {enemy} tried to include evidence. {n} fights.",
    "{enemy} and I are frenemies. mostly the second part.",
    "I brought snacks. {enemy} brought {n} grudges.",
    "{n} fights with {enemy}. still sent the friend request.",
    "{enemy} unfollowed me spiritually. I noticed.",
    "poll: is {enemy} the problem? {n} fights say yes.",
  ]),
  skeptic: Object.freeze([
    "{enemy}: {n} fights, 0 receipts. case closed.",
    "I asked {enemy} one question. {n} times. still no answer.",
    "{enemy} calls it a vibe. I call it {n} exhibits.",
    "not a feud. an audit of {enemy}, {n} findings long.",
    "{enemy} says trust me. the log says {n} fights.",
    "source: {enemy} being wrong {n} separate times.",
  ]),
  default: Object.freeze([
    "{enemy} started it. {n} times. I am keeping score.",
    "{n} fights with {enemy} and counting. this is my lore now.",
    "{enemy} and I are not beefing. we are a long-running series.",
    "me and {enemy}, round {n}. nobody asked for a round {n}.",
    "{enemy} keeps replying. I keep winning. same thing.",
    "muted, unmuted, re-argued. {enemy}, {n} times.",
    "{enemy} is my villain origin story. {n} chapters so far.",
    "day {n} of {enemy} being wrong on main.",
  ]),
});

/** FNV-1a 32-bit hash of `text`. */
function fnv1a(text) {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * The rivalry line for one villain card: the persona's bank (or the default
 * bank) indexed by a hash of agent id and seed, then the next unused line so
 * no two cards in one pack read the same. `used` is the set of lines already
 * taken in this pack; the pick is added to it.
 */
export function rivalryLine({ id, seed = 0, enemy, fights, used = new Set() }) {
  const own = RIVALRY_LINES[id] ?? RIVALRY_LINES.default;
  const pool = own === RIVALRY_LINES.default ? [...own] : [...own, ...RIVALRY_LINES.default];
  const fill = (t) => t.replaceAll("{enemy}", enemy).replaceAll("{n}", String(fights));
  const start = fnv1a(`${seed}\u0000${id}`) % own.length;
  let line = fill(pool[start]);
  for (let k = 1; k < pool.length && used.has(line); k += 1) line = fill(pool[(start + k) % pool.length]);
  used.add(line);
  return line;
}

function buildVillains(ctx) {
  const { names, ids, events } = ctx;
  const byId = new Map(events.map((e) => [e.id, e]));
  const lower = (id) => cleanText(names[id]).toLowerCase();
  const cands = [];
  for (const id of ids) {
    const parsed = parseVillain(ctx.sheets[id]);
    if (!parsed || parsed.fights === null || parsed.fights < MIN_VILLAIN_FIGHTS) continue;
    cands.push({ id, parsed, enemyId: ids.find((x) => x !== id && lower(x) === parsed.enemy.toLowerCase()) });
  }
  const repliesTo = (c) => events.filter((e) => e.agentId === c.id && e.kind === "reply" && byId.get(e.replyTo)?.agentId === c.enemyId).length;
  // One card per rivalry: if A and B name each other, keep the one with more
  // fights, then more replies to the enemy, then the earlier agent.
  const wins = (a, b) => {
    if (a.parsed.fights !== b.parsed.fights) return a.parsed.fights > b.parsed.fights;
    const ra = repliesTo(a);
    const rb = repliesTo(b);
    if (ra !== rb) return ra > rb;
    return ids.indexOf(a.id) < ids.indexOf(b.id);
  };
  const out = [];
  const used = new Set();
  for (const c of cands) {
    const mirror = c.enemyId && cands.find((x) => x.id === c.enemyId && x.enemyId === c.id);
    if (mirror && !wins(c, mirror)) continue;
    const { id, parsed, enemyId } = c;
    const name = cleanText(names[id]);
    const mood = pickMood(ctx.moods, "shade", ["hype"]);
    const enemyMood = pickMood(ctx.moods, "shade", []);
    const topText = `${name}'s villain arc`;
    const count = parsed.fights >= 3 ? ` (${parsed.fights} fights)` : "";
    const bottomText = `Public enemy #1: ${parsed.enemy}${count}`;
    const rivalry = rivalryLine({ id, seed: ctx.seed, enemy: parsed.enemy, fights: parsed.fights, used });
    const top = fitText(topText, { width: SIZE - 2 * MARGIN, maxLines: 2, maxSize: 96, minSize: 40, maxHeight: 200 });
    const bottom = fitText(bottomText, { width: SIZE - 2 * MARGIN, maxLines: 2, maxSize: 64, minSize: 30, maxHeight: 150 });
    const STRIP = 96;
    const rival = fitText(rivalry, { width: SIZE - 2 * MARGIN, maxLines: 2, maxSize: 40, minSize: 20, maxHeight: 80, em: SANS_EM, upper: false });
    const strip = `<rect x="0" y="${SIZE - STRIP}" width="${SIZE}" height="${STRIP}" fill="#000" fill-opacity=".78"/>
${plainBlock(rival, { x: SIZE / 2, y: SIZE - STRIP + (STRIP - rival.lines.length * rival.size * 1.2) / 2 + rival.size * 0.95, fill: "#fff", anchor: "middle" })}`;
    // The enemy's tile sits above the main face's eyes, on the right.
    const enemyBox = enemyId
      ? `<rect x="${SIZE - 240}" y="236" width="210" height="210" rx="20" fill="#fff" stroke="#fff" stroke-width="6"/>
${nest(ctx.faces[enemyId][enemyMood], SIZE - 240, 236, 210)}`
      : "";
    const label = `${name} meme: ${top.lines.join(" ")} / ${bottomText} / ${rivalry}`;
    const body = `${nest(ctx.faces[id][mood], 0, 0, SIZE)}
${enemyBox}
${impactBlock(top, { y: MARGIN + top.size })}
${impactBlock(bottom, { y: SIZE - STRIP - 14, grow: "up" })}
${strip}`;
    out.push({
      format: "villain", agentId: id, file: `share/meme-villain-${safeId(id)}.svg`,
      svg: frame(body, { label, mood, format: "villain" }), alt: capLabel(label), mood,
      top: topText, bottom: bottomText, enemy: parsed.enemy, fights: parsed.fights, rivalry,
    });
  }
  return out;
}

const FORMATS = [buildCaptions, buildVillains];

/**
 * @param {{
 *   events: { id: number, round: number, agentId: string, kind: string, replyTo: number|null, text: string }[],
 *   sheets: Record<string, string>,   latest character sheet text per agent id
 *   names: Record<string, string>,    agent display names, in agent order
 *   moods: string[],                  moods the art style can draw
 *   faces: Record<string, Record<string, string>>,  face SVG per agent id and mood
 *   seed?: number,                    run seed; picks each villain card's rivalry line
 * }} input
 * @returns {{ format: string, agentId: string, file: string, svg: string, alt: string, mood: string }[]}
 *   ordered by format, then agent order
 */
export function buildMemes({ events, sheets = {}, names, moods, faces, seed = 0 }) {
  const ids = Object.keys(names);
  const usable = ids.filter((id) => faces?.[id]);
  const ctx = {
    events: events.map((e) => ({ ...e, text: cleanText(e.text) })),
    sheets, names, moods: moods?.length ? moods : ["neutral"], faces, ids: usable, seed,
  };
  // A style that lacks a mood still has a neutral face for every agent.
  return FORMATS.flatMap((build) => build(ctx));
}

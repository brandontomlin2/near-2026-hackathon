// Meme pack: classic meme formats built deterministically from each agent's
// real channel events and character sheet. Pure (no fs, no clocks, no
// randomness). Every variable piece of text comes from data; the only fixed
// text is the meme template itself ("WHEN", "THIS YOU?", "VILLAIN ARC").
//
// Three formats, each self-contained so a weak one can be deleted by removing
// its builder from FORMATS:
//   caption  top/bottom caption over a full-bleed reaction face
//   thisyou  "this you?" quote-tweet: latest post vs an earlier contrasting one
//   villain  "<NAME>'S VILLAIN ARC" from the sheet's Public enemy line

import { moodForText } from "../art/moods.mjs";
import { escapeXml, nest } from "./share.mjs";

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

// --- text safety -----------------------------------------------------------

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Strip characters that are invalid in XML 1.0 and collapse whitespace. */
export function cleanText(value) {
  return String(value ?? "").replace(INVALID_XML, "").replace(/\s+/g, " ").trim();
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
  const clean = cleanText(text);
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

/** White Impact text with a thick black outline, centered on x. */
function impactBlock(fit, { x = SIZE / 2, y, anchor = "middle", grow = "down" }) {
  const { lines, size } = fit;
  if (!lines.length) return "";
  const step = size * LINE_HEIGHT;
  const first = grow === "up" ? y - (lines.length - 1) * step : y;
  const tspans = lines.map((l, i) => `<tspan x="${x}" y="${Math.round(first + i * step)}">${escapeXml(l)}</tspan>`).join("");
  return `<text font-family="${IMPACT}" font-size="${size}" font-weight="900" fill="#fff" stroke="#000" stroke-width="${Math.round(size * 0.14)}" stroke-linejoin="round" paint-order="stroke" text-anchor="${anchor}">${tspans}</text>`;
}

function plainBlock(fit, { x, y, fill, weight = 700, anchor = "start" }) {
  const { lines, size } = fit;
  const step = size * 1.2;
  const tspans = lines.map((l, i) => `<tspan x="${x}" y="${Math.round(y + i * step)}">${escapeXml(l)}</tspan>`).join("");
  return `<text font-family="${SANS}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${tspans}</text>`;
}

function frame(body, { label, mood, format, background = "#111" }) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="${escapeXml(label)}" data-mood="${escapeXml(mood)}" data-format="${escapeXml(format)}">
<title>${escapeXml(label)}</title>
<rect width="${SIZE}" height="${SIZE}" fill="${background}"/>
${body}
</svg>
`;
}

export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}TH`;
  return `${n}${({ 1: "ST", 2: "ND", 3: "RD" })[n % 10] ?? "TH"}`;
}

function pickMood(moods, wanted, fallbacks = ["shade"]) {
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

function vibeOf(sheet) {
  return /Who I am:\s*[^,.]+,\s*(.+?)\.(?:\s|$)/.exec(sheet ?? "")?.[1] ?? "";
}

function buildCaptions(ctx) {
  const { events, names, ids } = ctx;
  const byId = new Map(events.map((e) => [e.id, e]));
  const pairs = replyPairs(events);
  const out = [];
  for (const target of ids) {
    // The most persistent replier; ties go to the earlier agent in `ids`.
    let best = null;
    for (const replier of ids) {
      const n = pairs.get(`${replier}\u0000${target}`) ?? 0;
      if (n >= 2 && (!best || n > best.n)) best = { replier, n };
    }
    if (!best) continue;
    const answers = events.filter((e) => e.agentId === target && e.kind === "reply" && byId.get(e.replyTo)?.agentId === best.replier);
    const own = events.filter((e) => e.agentId === target);
    const source = answers.at(-1) ?? own.at(-1);
    const bottomText = cleanText((source?.text ?? vibeOf(ctx.sheets[target])).replace(/^@\S+\s*/, ""));
    if (!bottomText) continue;
    const topText = `When ${cleanText(names[best.replier])} replies for the ${ordinal(best.n)} time`;
    const mood = pickMood(ctx.moods, moodForText(bottomText));
    const top = fitText(topText, { width: SIZE - 2 * MARGIN, maxLines: 2, maxSize: 84, minSize: 40, maxHeight: 190 });
    const bottom = fitText(bottomText, { width: SIZE - 2 * MARGIN, maxLines: 3, maxSize: 72, minSize: 34, maxHeight: 210 });
    const label = `${cleanText(names[target])} meme: ${top.lines.join(" ")} / ${bottom.lines.join(" ")}`;
    const body = `${nest(ctx.faces[target][mood], 0, 0, SIZE)}
${impactBlock(top, { y: MARGIN + top.size })}
${impactBlock(bottom, { y: SIZE - MARGIN - 6, grow: "up" })}`;
    out.push({
      format: "caption", agentId: target, file: `share/meme-caption-${safeId(target)}.svg`,
      svg: frame(body, { label, mood, format: "caption" }), alt: label, mood,
      top: topText, bottom: bottomText, replierId: best.replier, count: best.n,
    });
  }
  return out;
}

function buildThisYou(ctx) {
  const { events, names, ids } = ctx;
  const out = [];
  for (const id of ids) {
    const own = events.filter((e) => e.agentId === id && cleanText(e.text));
    if (own.length < 2) continue;
    const latest = own.at(-1);
    const latestMood = moodForText(cleanText(latest.text));
    const earlier = own.slice(0, -1).find((e) => moodForText(cleanText(e.text)) !== latestMood) ?? own[0];
    const name = cleanText(names[id]);
    const mood = pickMood(ctx.moods, latestMood, ["shook"]);
    const boxW = SIZE - 2 * MARGIN;
    const quote = (e, y, accent) => {
      const fit = fitText(e.text, { width: boxW - 48, maxLines: 4, maxSize: 40, minSize: 20, maxHeight: 150, em: SANS_EM, upper: false });
      const head = fitText(`${name} · round ${e.round}`, { width: boxW - 48, maxLines: 1, maxSize: 26, minSize: 16, em: SANS_EM, upper: false });
      return { fit, svg: `<rect x="${MARGIN}" y="${y}" width="${boxW}" height="220" rx="22" fill="#fff" stroke="${accent}" stroke-width="5"/>
${plainBlock(head, { x: MARGIN + 24, y: y + 42, fill: "#0a6b4f" })}
${plainBlock(fit, { x: MARGIN + 24, y: y + 92, fill: "#1c1c1a", weight: 600 })}` };
    };
    const a = quote(earlier, 30, "#8a8a80");
    const b = quote(latest, 270, "#1c1c1a");
    const cap = fitText("This you?", { width: 400, maxLines: 2, maxSize: 130, minSize: 60, maxHeight: 330 });
    const label = `${name} meme: this you? Round ${earlier.round}: ${cleanText(earlier.text)} / Round ${latest.round}: ${cleanText(latest.text)}`;
    const body = `${a.svg}
${b.svg}
<rect x="${MARGIN}" y="510" width="360" height="360" rx="26" fill="#fff" stroke="#1c1c1a" stroke-width="5"/>
${nest(ctx.faces[id][mood], MARGIN + 6, 516, 348)}
${impactBlock(cap, { x: 650, y: 640 })}`;
    out.push({
      format: "thisyou", agentId: id, file: `share/meme-thisyou-${safeId(id)}.svg`,
      svg: frame(body, { label, mood, format: "thisyou", background: "#e9efe9" }), alt: label, mood,
      earlier: { round: earlier.round, text: earlier.text }, latest: { round: latest.round, text: latest.text },
      top: "THIS YOU?", bottom: "",
    });
  }
  return out;
}

const NO_ENEMY = /^(nobody|no one|none|nothing|n\/a|unknown|tbd)\b/i;
const LABELS = "Who I am|Public enemy #1|Ride-or-die|Rivalry arc|Scorecard|Signature quote|Receipts";

/** Parse the Public enemy and Rivalry lines from a one-line sheet. */
export function parseVillain(sheet) {
  const text = cleanText(sheet);
  const enemyLine = new RegExp(`Public enemy #1:\\s*(.+?)(?=\\s(?:${LABELS}):|$)`).exec(text)?.[1];
  if (!enemyLine || NO_ENEMY.test(enemyLine.trim())) return null;
  const counted = /^([^()|]+?)\s*\((\d+)\s+fights?\)/i.exec(enemyLine);
  const enemy = (counted ? counted[1] : /^([^.,;|()]+)/.exec(enemyLine)?.[1] ?? "").trim();
  if (!enemy || NO_ENEMY.test(enemy)) return null;
  const rivalry = new RegExp(`Rivalry arc:\\s*(.+?)(?=\\s(?:${LABELS}):|$)`).exec(text)?.[1]?.trim() ?? "";
  return { enemy, fights: counted ? Number(counted[2]) : null, rivalry };
}

function buildVillains(ctx) {
  const { names, ids } = ctx;
  const out = [];
  for (const id of ids) {
    const parsed = parseVillain(ctx.sheets[id]);
    if (!parsed) continue;
    const name = cleanText(names[id]);
    const mood = pickMood(ctx.moods, "shade", ["hype"]);
    const enemyId = ids.find((x) => cleanText(names[x]).toLowerCase() === parsed.enemy.toLowerCase());
    const enemyMood = pickMood(ctx.moods, "hype", ["neutral"]);
    const topText = `${name}'s villain arc`;
    const count = parsed.fights === null ? "" : ` (${parsed.fights} fight${parsed.fights === 1 ? "" : "s"})`;
    const bottomText = `Public enemy #1: ${parsed.enemy}${count}`;
    const top = fitText(topText, { width: SIZE - 2 * MARGIN, maxLines: 2, maxSize: 96, minSize: 40, maxHeight: 200 });
    const bottom = fitText(bottomText, { width: SIZE - 2 * MARGIN, maxLines: 2, maxSize: 64, minSize: 30, maxHeight: 150 });
    const rival = parsed.rivalry
      ? fitText(parsed.rivalry, { width: SIZE - 2 * MARGIN, maxLines: 2, maxSize: 26, minSize: 16, maxHeight: 60, em: SANS_EM, upper: false })
      : null;
    const strip = rival
      ? `<rect x="0" y="${SIZE - 72}" width="${SIZE}" height="72" fill="#000" fill-opacity=".72"/>
${plainBlock(rival, { x: SIZE / 2, y: SIZE - 72 + 14 + rival.size, fill: "#fff", anchor: "middle" })}`
      : "";
    const enemyBox = enemyId
      ? `<rect x="${SIZE - 270}" y="260" width="240" height="240" rx="20" fill="#fff" stroke="#fff" stroke-width="6"/>
${nest(ctx.faces[enemyId][enemyMood], SIZE - 270, 260, 240)}`
      : "";
    const label = `${name} meme: ${top.lines.join(" ")} / ${bottomText}${parsed.rivalry ? ` / ${parsed.rivalry}` : ""}`;
    const body = `${nest(ctx.faces[id][mood], 0, 0, SIZE)}
${enemyBox}
${impactBlock(top, { y: MARGIN + top.size })}
${impactBlock(bottom, { y: SIZE - (rival ? 84 : 36), grow: "up" })}
${strip}`;
    out.push({
      format: "villain", agentId: id, file: `share/meme-villain-${safeId(id)}.svg`,
      svg: frame(body, { label, mood, format: "villain" }), alt: label, mood,
      top: topText, bottom: bottomText, enemy: parsed.enemy, fights: parsed.fights, rivalry: parsed.rivalry,
    });
  }
  return out;
}

const FORMATS = [buildCaptions, buildThisYou, buildVillains];

/**
 * @param {{
 *   events: { id: number, round: number, agentId: string, kind: string, replyTo: number|null, text: string }[],
 *   sheets: Record<string, string>,   latest character sheet text per agent id
 *   names: Record<string, string>,    agent display names, in agent order
 *   moods: string[],                  moods the art style can draw
 *   faces: Record<string, Record<string, string>>,  face SVG per agent id and mood
 * }} input
 * @returns {{ format: string, agentId: string, file: string, svg: string, alt: string, mood: string }[]}
 *   ordered by format, then agent order
 */
export function buildMemes({ events, sheets = {}, names, moods, faces }) {
  const ids = Object.keys(names);
  const usable = ids.filter((id) => faces?.[id]);
  const ctx = {
    events: events.map((e) => ({ ...e, text: cleanText(e.text) })),
    sheets, names, moods: moods?.length ? moods : ["neutral"], faces, ids: usable,
  };
  // A style that lacks a mood still has a neutral face for every agent.
  return FORMATS.flatMap((build) => build(ctx));
}

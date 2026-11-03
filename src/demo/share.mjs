// Share cards: one self-contained SVG per channel message. The reaction face
// is nested as an <svg> element, so the card has no external references and
// needs no scripts. Output is deterministic: no clocks, no randomness.

import { escapeHtml } from "../viewer/render.mjs";

const WIDTH = 900;
const FACE = 300;
const PAD = 40;
const TEXT_X = PAD + FACE + 36;
const WRAP = 22;
const LINE_H = 40;

/** Escape for XML text and attribute values (same five characters as HTML). */
export const escapeXml = escapeHtml;

const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Strip characters that are invalid in XML 1.0 (and lone surrogates) and collapse whitespace. */
export function cleanText(value) {
  return String(value ?? "").replace(INVALID_XML, "").replace(/\s+/g, " ").trim();
}

/** Greedy word wrap; a word longer than `width` is split. */
export function wrapText(text, width = WRAP) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    // Lengths are UTF-16 units (as before), but a word is only ever cut
    // between code points so a surrogate pair is never split.
    let w = word;
    while (w.length > width) {
      if (line) { lines.push(line); line = ""; }
      let piece = "";
      for (const ch of w) {
        if (piece && piece.length + ch.length > width) break;
        piece += ch;
      }
      lines.push(piece);
      w = w.slice(piece.length);
    }
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines;
}

/** Turn a style SVG into a nested <svg> placed at x,y with the given size. */
export function nest(faceSvg, x, y, size) {
  return faceSvg.trim().replace(/^<\?xml[^>]*\?>\s*/, "").replace(/^<svg\b((?:[^>"']|"[^"]*"|'[^']*')*)>/, (_, attrs) => {
    const rest = attrs.replace(/\s(?:x|y|width|height)=(?:"[^"]*"|'[^']*')/g, "");
    return `<svg${rest} x="${x}" y="${y}" width="${size}" height="${size}">`;
  });
}

/**
 * @param {{ agentName: string, text: string, mood: string, round: number, faceSvg: string }} card
 * @returns {string} one standalone SVG document
 */
export function renderShareCard(card) {
  const agentName = cleanText(card.agentName);
  const text = cleanText(card.text);
  const mood = cleanText(card.mood);
  const round = cleanText(String(card.round));
  const { faceSvg } = card;
  const lines = wrapText(text);
  const textBlock = lines.length * LINE_H;
  const height = Math.max(FACE + 2 * PAD + 40, textBlock + 2 * PAD + 150);
  const quoteY = PAD + 56;
  const nameY = quoteY + textBlock + 24;
  const tspans = lines
    .map((l, i) => `<tspan x="${TEXT_X}" y="${quoteY + i * LINE_H}">${escapeXml(l)}</tspan>`)
    .join("");
  const label = `${agentName} says: ${text}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${height}" width="${WIDTH}" height="${height}" role="img" aria-label="${escapeXml(label)}" data-mood="${escapeXml(mood)}">
<rect width="${WIDTH}" height="${height}" rx="28" fill="#fffdf6"/>
<rect x="6" y="6" width="${WIDTH - 12}" height="${height - 12}" rx="24" fill="none" stroke="#1c1c1a" stroke-width="4"/>
${nest(faceSvg, PAD, PAD + 20, FACE)}
<text x="${TEXT_X}" y="${PAD + 16}" font-family="system-ui,Arial,sans-serif" font-size="18" fill="#6a6a60">round ${escapeXml(round)} · ${escapeXml(mood)}</text>
<text font-family="system-ui,Arial,sans-serif" font-size="32" font-weight="700" fill="#1c1c1a">${tspans}</text>
<text x="${TEXT_X}" y="${nameY}" font-family="system-ui,Arial,sans-serif" font-size="24" font-weight="700" fill="#0a6b4f">${escapeXml(agentName)}</text>
<text x="${WIDTH - PAD}" y="${height - 24}" text-anchor="end" font-family="system-ui,Arial,sans-serif" font-size="16" fill="#6a6a60">Personality NFT</text>
</svg>
`;
}

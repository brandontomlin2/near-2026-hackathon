// Deterministic layered SVG renderer (PRODUCT.md, "Rendering").
// Integers only, no randomness, no timestamps: same traits => same bytes.

import { assertTraits } from "../traits/validate.mjs";
import { range } from "./styles/shared.mjs";

const PALETTES = Object.freeze({
  cool: { bg: "#e4e8ee", line: "#5b6b82", ring: "#8fa3bf", accent: "#3b6ea8", ink: "#2a3140" },
  neon: { bg: "#14001f", line: "#ff2bd6", ring: "#39ff14", accent: "#fff200", ink: "#00f0ff" },
  warm: { bg: "#ffe9cf", line: "#e8741a", ring: "#f5a65b", accent: "#c4410c", ink: "#5a2208" },
  muted: { bg: "#e9e2cf", line: "#6f8a5f", ring: "#a39a7c", accent: "#8a6a3f", ink: "#3d3524" },
});

function background(risk, p) {
  const s = `stroke="${p.line}" stroke-opacity="0.5" fill="none"`;
  let body;
  if (risk === "low") {
    body = range(36)
      .map((i) => `<circle cx="${20 + (i % 6) * 43}" cy="${20 + Math.floor(i / 6) * 43}" r="2" fill="${p.line}" fill-opacity="0.5"/>`)
      .join("");
  } else if (risk === "high") {
    const pts = range(17).map((i) => `${i * 16},${i % 2 ? 40 : 16}`).join(" ");
    body = [0, 1, 2, 3, 4, 5].map((r) => `<polyline points="${pts}" transform="translate(0 ${r * 44})" ${s} stroke-width="3"/>`).join("");
  } else if (risk === "mid") {
    body = range(8).map((i) => `<path d="M0 ${16 + i * 32} Q64 ${i * 32} 128 ${16 + i * 32} T256 ${16 + i * 32}" ${s} stroke-width="2"/>`).join("");
  } else {
    body = range(9)
      .map((i) => `<path d="M${i * 32} 0V256M0 ${i * 32}H256" ${s} stroke-width="1"/>`)
      .join("");
  }
  return `<g id="background"><rect width="256" height="256" fill="${p.bg}"/>${body}</g>`;
}

function rings(depth, p) {
  const body = range(depth)
    .map((i) => `<circle cx="128" cy="140" r="${56 + i * 5}" fill="none" stroke="${p.ring}" stroke-width="2"/>`)
    .join("");
  return `<g id="rings">${body}</g>`;
}

function glyph(role, p) {
  let body;
  if (role === "observer") {
    body = `<circle cx="148" cy="128" r="14" fill="none" stroke="${p.accent}" stroke-width="3"/><path d="M158 138L172 168" stroke="${p.accent}" stroke-width="2"/>`;
  } else if (role === "trickster") {
    body = `<path d="M84 96L96 50L128 80L160 50L172 96Z" fill="${p.accent}"/><circle cx="96" cy="48" r="6" fill="${p.line}"/><circle cx="160" cy="48" r="6" fill="${p.line}"/>`;
  } else if (role === "connector") {
    body = `<path d="M128 92V60" stroke="${p.accent}" stroke-width="3"/><circle cx="128" cy="56" r="6" fill="${p.accent}"/><path d="M170 60h48v28h-30l-8 10v-10h-10z" fill="${p.bg}" stroke="${p.accent}" stroke-width="2"/>`;
  } else {
    body = `<circle cx="182" cy="62" r="18" fill="none" stroke="${p.accent}" stroke-width="4"/><path d="M195 75L216 98" stroke="${p.accent}" stroke-width="5"/>`;
  }
  return `<g id="glyph">${body}</g>`;
}

function face(voice, p) {
  const head = `<circle cx="128" cy="140" r="48" fill="${p.bg}" stroke="${p.ink}" stroke-width="3"/>`;
  const eye = (x) => `<circle cx="${x}" cy="128" r="5" fill="${p.ink}"/>`;
  const st = `stroke="${p.ink}" stroke-width="3" fill="none"`;
  let body;
  if (voice === "dry") {
    body = `${eye(110)}${eye(146)}<path d="M102 124H118M138 124H154" ${st}/><path d="M112 164H144" ${st}/>`;
  } else if (voice === "loud") {
    body = `${eye(110)}${eye(146)}<path d="M100 154Q128 190 156 154Z" fill="${p.ink}"/>`;
  } else if (voice === "open") {
    body = `${eye(110)}${eye(146)}<path d="M108 156Q128 176 148 156" ${st}/>`;
  } else {
    body = `${eye(110)}${eye(146)}<path d="M138 114L156 108" ${st}/><path d="M112 164H144" ${st}/>`;
  }
  return `<g id="face">${head}${body}</g>`;
}

/**
 * @param {import("../traits/validate.mjs").Traits} traits
 * @returns {string}
 */
export function renderSvg(traits) {
  const t = assertTraits(traits);
  const p = PALETTES[t.temperament];
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">`,
    background(t.risk, p),
    rings(t.memory_depth, p),
    glyph(t.role, p),
    face(t.voice, p),
    `</svg>`,
  ].join("\n") + "\n";
}

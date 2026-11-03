// "Bighead Sticker Pack": bold vector reaction stickers. Huge head, thick ink
// outlines, flat fills with one hard cel-shadow, a fat white die-cut edge.
//
// Traits: temperament -> palette, role -> the character and its joke,
// risk -> background pattern, voice -> mouth baseline (and mouth width in the
// other moods), memory_depth -> that many data-ring stars along the edges.
// Pure and deterministic; integers only.

import { assertTraits, assertMood, rarityTier, defsPrefix, svgOpen, range } from "./shared.mjs";

const INK = "#1b1226";
const GOLD = "#ffc21a";
const MOUTH_DARK = "#4a1230";
const PINK = "#ff6f91";
const WATER = "#7fd6ff";
const GLASS = "#e6f6ff";

const PALETTES = {
  cool: { bg: "#4f7fd1", bg2: "#6b97e0", skin: "#cfe0f2", shade: "#9db8d9", acc: "#2b4f9e", acc2: "#8fd3ff" },
  neon: { bg: "#ff2ec4", bg2: "#ff6fd8", skin: "#b8ff3a", shade: "#7fe01c", acc: "#12d8ff", acc2: "#ffe500" },
  warm: { bg: "#ffcf3d", bg2: "#ffe27a", skin: "#ffb15a", shade: "#ef7f2a", acc: "#e8402f", acc2: "#fff1b8" },
  muted: { bg: "#d6c79a", bg2: "#e6dab4", skin: "#aebd8e", shade: "#7f9468", acc: "#7a5a35", acc2: "#efe4c2" },
};

const TIER_STAR = { common: "#fff3d6", rare: "#bfe3ff", epic: "#d9a8ff", legendary: GOLD };
const VOICE_WIDTH = { dry: 0.8, loud: 1.2, open: 1, flat: 0.9 };

// ---------------------------------------------------------------- primitives

const r = Math.round;
const strokeAttrs = (sw) => `stroke="${INK}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"`;
const path = (d, fill, sw = 7) => `<path d="${d}" fill="${fill}" ${sw ? strokeAttrs(sw) : ""}/>`;
const line = (d, sw = 7, col = INK) =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
const fat = (d, w, col) => line(d, w + 6, INK) + line(d, w, col);
const ell = (cx, cy, rx, ry, fill, sw = 7) =>
  `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}" ${sw ? strokeAttrs(sw) : ""}/>`;
const circ = (cx, cy, rr, fill, sw = 7) => ell(cx, cy, rr, rr, fill, sw);

const poly = (pts, fill, sw = 7) => path(`M${pts.map(([x, y]) => `${r(x)} ${r(y)}`).join(" L")} Z`, fill, sw);

function star(cx, cy, ro, ri, pts, fill, sw = 4) {
  const out = [];
  for (let i = 0; i < pts * 2; i++) {
    const a = (Math.PI * i) / pts - Math.PI / 2;
    const rad = i % 2 === 0 ? ro : ri;
    out.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
  }
  return poly(out, fill, sw);
}

function sparkle(cx, cy, s, fill = "#fff", sw = 4) {
  return path(
    `M${cx} ${cy - s} Q${cx} ${cy} ${cx + s} ${cy} Q${cx} ${cy} ${cx} ${cy + s} Q${cx} ${cy} ${cx - s} ${cy} Q${cx} ${cy} ${cx} ${cy - s} Z`,
    fill,
    sw,
  );
}

function heart(cx, cy, s, fill) {
  const k = (v) => r(v * s);
  return path(
    `M${cx} ${cy + k(0.9)} C${cx - k(1.7)} ${cy - k(0.1)} ${cx - k(0.9)} ${cy - k(1.2)} ${cx} ${cy - k(0.4)} C${cx + k(0.9)} ${cy - k(1.2)} ${cx + k(1.7)} ${cy - k(0.1)} ${cx} ${cy + k(0.9)} Z`,
    fill,
    6,
  );
}

function drop(x, y, s, fill = WATER) {
  const k = (v) => r(v * s);
  return path(
    `M${x} ${y - k(14)} C${x + k(4)} ${y - k(6)} ${x + k(10)} ${y} ${x + k(10)} ${y + k(8)} A${k(10)} ${k(10)} 0 0 1 ${x - k(10)} ${y + k(8)} C${x - k(10)} ${y} ${x - k(4)} ${y - k(6)} ${x} ${y - k(14)} Z`,
    fill,
    5,
  ) + circ(x - k(4), y + k(6), Math.max(2, k(2)), "#fff", 0);
}

function spiral(cx, cy, R, turns = 2.5) {
  const pts = [];
  const steps = 30;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * turns * 2 * Math.PI;
    const rad = (R * i) / steps;
    pts.push(`${r(cx + rad * Math.cos(a))} ${r(cy + rad * Math.sin(a))}`);
  }
  return line(`M${pts.join(" L")}`, 5);
}

const brow = (x1, y1, x2, y2, bend = 0, sw = 10) =>
  line(`M${x1} ${y1} Q${r((x1 + x2) / 2)} ${r((y1 + y2) / 2 - bend)} ${x2} ${y2}`, sw);

// Shared context so ids stay unique and prefixed.
function makeCtx(prefix) {
  return { prefix, defs: [], n: 0, id(name) { return `${prefix}-${name}${this.n++}`; } };
}

/** A big cartoon eye. lid = fraction of the eyeball covered from the top. */
function eye(ctx, o) {
  const { cx, cy, rx, ry, lid = 0, slant = 0, px = 0, py = 0, pr = 12, lidCol = "#999", iris = null, ir = 0, pupil = true, extra = "", glint = true } = o;
  const id = ctx.id("e");
  ctx.defs.push(`<clipPath id="${id}"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/></clipPath>`);
  let inner = "";
  if (iris) inner += circ(cx + px, cy + py, ir, iris, 0);
  if (pupil) {
    inner += circ(cx + px, cy + py, pr, INK, 0);
    if (glint) {
      inner += circ(cx + px - r(pr * 0.38), cy + py - r(pr * 0.4), Math.max(2, r(pr * 0.34)), "#fff", 0);
      inner += circ(cx + px + r(pr * 0.4), cy + py + r(pr * 0.4), Math.max(1, r(pr * 0.16)), "#fff", 0);
    }
  }
  inner += extra;
  if (lid > 0) {
    const ly = r(cy - ry + 2 * ry * lid);
    const x0 = cx - rx - 4;
    const x1 = cx + rx + 4;
    inner += `<path d="M${x0} ${cy - ry - 4} L${x1} ${cy - ry - 4} L${x1} ${ly + slant} L${x0} ${ly - slant} Z" fill="${lidCol}"/>`;
    inner += line(`M${x0} ${ly - slant} L${x1} ${ly + slant}`, 7);
  }
  return `${ell(cx, cy, rx, ry, "#fff", 0)}<g clip-path="url(#${id})">${inner}</g>${ell(cx, cy, rx, ry, "none", 7)}`;
}

// ---------------------------------------------------------------- mouths

const grinD = (mx, my, w, topSag, botSag) => {
  const x0 = r(mx - w / 2);
  const x1 = r(mx + w / 2);
  return `M${x0} ${my} Q${mx} ${my + 2 * topSag} ${x1} ${my} Q${mx} ${my + 2 * botSag} ${x0} ${my} Z`;
};

const ovalD = (cx, cy, rx, ry) => `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`;

/**
 * Open mouth: dark inside, optional tongue and teeth.
 * teeth: "none" | "top" | "all"; k = tooth divider count.
 */
function openMouth(ctx, shapeD, { mx, ty, by, w, teeth = "none", k = 0, tongue = false, topSag = 4, botSag = 0, flatDividers = false }) {
  const id = ctx.id("m");
  ctx.defs.push(`<clipPath id="${id}"><path d="${shapeD}"/></clipPath>`);
  const h = by - ty;
  const x0 = r(mx - w / 2);
  let inner;
  if (teeth === "all") {
    inner = `<rect x="${x0 - 2}" y="${ty - 8}" width="${w + 4}" height="${h + 16}" fill="#fff"/>`;
    for (let i = 1; i <= k; i++) {
      const t = i / (k + 1);
      const xx = r(x0 + t * w);
      if (flatDividers) {
        inner += line(`M${xx} ${ty - 8} L${xx} ${by + 8}`, 3);
      } else {
        const yt = r(ty + 2 * t * (1 - t) * 2 * topSag * 0.5);
        const yb = r(ty + 2 * t * (1 - t) * 2 * botSag * 0.5 * 1);
        inner += line(`M${xx} ${yt} L${xx} ${yb}`, 3);
      }
    }
  } else {
    inner = `<rect x="${x0 - 2}" y="${ty - 8}" width="${w + 4}" height="${h + 16}" fill="${MOUTH_DARK}"/>`;
    if (tongue) inner += ell(mx + r(w * 0.1), by - 2, r(w * 0.26), r(h * 0.45), PINK, 4);
    if (teeth === "top") {
      const th = Math.max(8, r(h * 0.3));
      inner += `<rect x="${x0 - 2}" y="${ty - 8}" width="${w + 4}" height="${th + 8}" fill="#fff"/>`;
      inner += line(`M${x0} ${ty + th} L${x0 + w} ${ty + th}`, 3);
      for (let i = 1; i <= k; i++) inner += line(`M${r(x0 + (i * w) / (k + 1))} ${ty} L${r(x0 + (i * w) / (k + 1))} ${ty + th}`, 3);
    }
  }
  return `<g clip-path="url(#${id})">${inner}</g>${path(shapeD, "none", 7)}`;
}

/** Baseline mouth for a voice at (mx, my). The "voice" trait lives here. */
function voiceMouth(ctx, voice, mx, my) {
  switch (voice) {
    case "dry":
      return line(`M${mx - 24} ${my - 3} L${mx + 22} ${my + 3}`, 8);
    case "flat":
      return line(`M${mx - 32} ${my} L${mx + 32} ${my}`, 8);
    case "loud": {
      const y = my - 12;
      const tongue = ell(mx + 26, y + 30, 14, 20, PINK, 5);
      return tongue + openMouth(ctx, grinD(mx, y, 116, 4, 30), { mx, ty: y, by: y + 30, w: 116, teeth: "all", k: 9, topSag: 4, botSag: 30 });
    }
    default: {
      const y = my - 8;
      return openMouth(ctx, grinD(mx, y, 96, 4, 22), { mx, ty: y, by: y + 22, w: 96, teeth: "top", k: 4, tongue: true });
    }
  }
}

// ---------------------------------------------------------------- scene parts

const SHOULDERS = "M10 256 Q14 212 70 206 L186 206 Q242 212 246 256 Z";

function head(ctx, pal, { cx = 128, cy = 152, rx = 98, ry = 98 }) {
  const id = ctx.id("hd");
  ctx.defs.push(`<clipPath id="${id}"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/></clipPath>`);
  return (
    ell(cx, cy, rx, ry, pal.shade, 0) +
    `<g clip-path="url(#${id})">${ell(cx - 20, cy - 14, rx, ry, pal.skin, 0)}</g>` +
    ell(cx, cy, rx, ry, "none", 9)
  );
}

function bubble(x, y, w, h, tailX, tailY, fill = "#fff") {
  const bx = x + r(w * 0.3);
  const tail = `M${bx} ${y + h - 2} L${tailX} ${tailY} L${bx + 22} ${y + h - 2} Z`;
  return path(tail, fill, 6) + `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r(h / 2.4)}" fill="${fill}" ${strokeAttrs(6)}/>` + `<path d="M${bx + 3} ${y + h - 1} L${bx + 19} ${y + h - 1}" stroke="${fill}" stroke-width="7"/>`;
}

const typingDots = (cx, cy, gap = 17, rr = 6) => [-1, 0, 1].map((i) => circ(cx + i * gap, cy, rr, INK, 0)).join("");

function steam(x, y) {
  return fat(`M${x} ${y} Q${x - 9} ${y - 12} ${x} ${y - 24} Q${x + 9} ${y - 36} ${x} ${y - 48}`, 5, "#fff");
}

function fist(cx, cy, pal) {
  return (
    ell(cx, cy, 30, 27, pal.skin, 7) +
    line(`M${cx - 18} ${cy - 2} Q${cx - 6} ${cy - 10} ${cx + 4} ${cy - 2}`, 4) +
    line(`M${cx - 8} ${cy + 8} Q${cx + 2} ${cy + 1} ${cx + 12} ${cy + 8}`, 4) +
    ell(cx - 26, cy + 4, 11, 15, pal.skin, 6)
  );
}

const finger = (d, pal) => fat(d, 26, pal.skin);

// ---------------------------------------------------------------- roles
// Each role returns { head, tf, headExtra, sil, silT, back, faceT, top }
//   tf        transform for the head group
//   silT/sil  die-cut silhouette extras (inside tf / absolute)
//   back      drawn in the glyph layer, behind the head
//   faceT     drawn over the head, inside tf
//   top       drawn last, absolute coordinates

const L = 90;
const R = 166;
const EY = 140;

function observer(ctx, pal, t, mood) {
  const f = VOICE_WIDTH[t.voice];
  const lid = { cool: pal.shade };
  const monocleAt = (cx, cy, rot = 0, s = 1) => {
    const ro = r(44 * s);
    return (
      `<g transform="rotate(${rot} ${cx} ${cy})">` +
      circ(cx, cy, ro, "#ffffff", 0).replace('fill="#ffffff"', 'fill="#ffffff" fill-opacity="0.25"') +
      circ(cx, cy, ro, "none", 14) +
      circ(cx, cy, ro, "none", 0).replace('fill="none"', `fill="none" stroke="${GOLD}" stroke-width="7"`) +
      line(`M${cx - r(26 * s)} ${cy - r(14 * s)} L${cx - r(12 * s)} ${cy - r(28 * s)}`, 6, "#fff") +
      `</g>`
    );
  };
  const out = { tf: "", silT: "", sil: "", back: "", faceT: "", top: "" };
  const eyeBase = { rx: 32, ry: 36, lidCol: lid.cool };
  const flatBrows = brow(58, 108, 118, 108, 0) + brow(138, 108, 198, 108, 0);
  switch (mood) {
    case "neutral":
      out.faceT =
        eye(ctx, { ...eyeBase, cx: L, cy: EY, lid: 0.52, py: 8, pr: 13 }) +
        eye(ctx, { ...eyeBase, cx: R, cy: EY, lid: 0.52, py: 8, pr: 13 }) +
        flatBrows +
        voiceMouth(ctx, t.voice, 128, 202) +
        monocleAt(R, EY) +
        fat(`M192 174 Q238 190 226 256`, 4, GOLD);
      out.silT = `<path d="M192 174 Q238 190 226 256"/>`;
      break;
    case "hype":
      out.faceT =
        eye(ctx, { ...eyeBase, cx: L, cy: EY, lid: 0.28, py: 4, pr: 14 }) +
        eye(ctx, { ...eyeBase, cx: R, cy: EY, lid: 0.28, py: 4, pr: 14 }) +
        brow(58, 110, 118, 106, 0) +
        brow(136, 84, 198, 72, 6) +
        line(`M${128 - r(22 * f)} 206 Q128 206 ${128 + r(30 * f)} 192`, 8) +
        line(`M${128 + r(30 * f) + 2} 190 L${128 + r(30 * f) + 10} 184`, 5) +
        monocleAt(R, EY) +
        fat(`M192 174 Q238 190 226 256`, 4, GOLD) +
        sparkle(222, 84, 14, "#fff", 4);
      out.silT = `<path d="M192 174 Q238 190 226 256"/>`;
      break;
    case "shade":
      out.faceT =
        eye(ctx, { ...eyeBase, cx: L, cy: EY, lid: 0.42, px: 19, py: 4, pr: 13 }) +
        eye(ctx, { ...eyeBase, cx: R, cy: EY, lid: 0.42, px: 19, py: 4, pr: 13 }) +
        brow(58, 106, 118, 108, 0) +
        brow(138, 108, 198, 104, 0) +
        monocleAt(R, EY) +
        fat(`M192 174 Q238 190 226 256`, 4, GOLD) +
        steam(120, 170) +
        steam(140, 176);
      out.silT = `<path d="M192 174 Q238 190 226 256"/>`;
      out.top =
        ell(128, 240, 56, 12, "#fff", 7) +
        path("M92 190 L164 190 Q162 236 128 236 Q94 236 92 190 Z", "#fff", 7) +
        `<path d="M94 204 L162 204" stroke="${pal.acc}" stroke-width="8"/>` +
        circ(171, 212, 12, "none", 7) +
        line("M100 194 L156 194", 4, "#c9d2e0");
      out.sil = ell(128, 240, 56, 12, "#000", 0) + `<path d="M92 190 L164 190 Q162 236 128 236 Q94 236 92 190 Z"/>`;
      break;
    default:
      out.faceT =
        eye(ctx, { ...eyeBase, cx: L, cy: EY, rx: 33, ry: 40, pr: 6 }) +
        eye(ctx, { ...eyeBase, cx: R, cy: EY, rx: 33, ry: 40, pr: 6 }) +
        brow(56, 90, 118, 80, 8) +
        brow(138, 80, 200, 90, 8) +
        ell(128, 206, 11, 15, MOUTH_DARK, 7) +
        drop(36, 100, 1.4);
      out.top =
        monocleAt(212, 52, -25, 0.75) +
        line("M196 80 L190 98", 5) + line("M214 88 L214 106", 5) + line("M232 80 L238 98", 5) +
        fat(`M212 68 Q240 90 230 120`, 4, GOLD);
      break;
  }
  return out;
}

function trickster(ctx, pal, t, mood) {
  const f = VOICE_WIDTH[t.voice];
  const tf = "rotate(-9 128 170)";
  const cap =
    path("M54 92 Q16 76 34 36 Q70 54 98 72 Z", pal.acc2, 7) +
    path("M202 92 Q240 76 222 36 Q186 54 158 72 Z", pal.acc, 7) +
    circ(34, 36, 10, GOLD, 5) + circ(222, 36, 10, GOLD, 5) +
    path("M38 100 Q40 44 128 40 Q216 44 218 100 Z", pal.acc, 8) +
    path("M34 102 Q128 74 222 102", "none", 0).replace('fill="none"', `fill="none" stroke="${INK}" stroke-width="22" stroke-linecap="round"`) +
    line("M34 102 Q128 74 222 102", 14, pal.acc2) +
    poly([[128, 44], [140, 62], [128, 80], [116, 62]], pal.acc2, 5) + circ(128, 34, 9, GOLD, 5);
  const out = { tf, silT: `<path d="M54 92 Q16 76 34 36 Q70 54 98 72 Z"/><path d="M202 92 Q240 76 222 36 Q186 54 158 72 Z"/><path d="M38 100 Q40 44 128 40 Q216 44 218 100 Z"/><circle cx="34" cy="36" r="10"/><circle cx="222" cy="36" r="10"/><circle cx="128" cy="34" r="9"/>`, sil: "", back: "", faceT: "", top: "" };
  const big = { cx: 88, cy: 146, rx: 38, ry: 42 };
  const tiny = { cx: 172, cy: 152, rx: 15, ry: 16 };
  const star8 = (cx, cy, ro, ri) => star(cx, cy, ro, ri, 8, "#ffe500", 6);
  let face = "";
  switch (mood) {
    case "neutral":
      face =
        eye(ctx, { ...big, pr: 8, px: 6, py: 2 }) +
        eye(ctx, { ...tiny, pr: 5, glint: false }) +
        voiceMouth(ctx, t.voice, 128, 198);
      break;
    case "hype":
      face =
        star8(86, 146, 40, 24) + circ(86, 146, 11, INK, 0) + circ(82, 142, 4, "#fff", 0) +
        star8(170, 146, 40, 24) + circ(170, 146, 11, INK, 0) + circ(166, 142, 4, "#fff", 0) +
        brow(46, 100, 112, 112, -4) + brow(144, 112, 210, 100, -4) +
        openMouth(ctx, ovalD(128, 204, r(30 * f), 28), { mx: 128, ty: 176, by: 232, w: r(60 * f), teeth: "top", k: 3, tongue: true }) +
        drop(222, 120, 1.2, "#ffb0b0");
      break;
    case "shade":
      face =
        eye(ctx, { cx: 88, cy: 150, rx: 34, ry: 28, lid: 0.42, slant: 10, lidCol: pal.shade, py: 6, pr: 9 }) +
        eye(ctx, { cx: 168, cy: 150, rx: 30, ry: 24, lid: 0.45, slant: -10, lidCol: pal.shade, py: 6, pr: 9 }) +
        brow(52, 110, 120, 134, 0, 11) + brow(138, 134, 206, 110, 0, 11) +
        openMouth(ctx, grinD(128, 188, r(128 * f), 22, 42), { mx: 128, ty: 188, by: 188 + 42, w: r(128 * f), teeth: "all", k: 11, topSag: 22, botSag: 42 });
      out.top =
        fat("M84 262 L128 206", 22, pal.skin) + fat("M172 262 L128 206", 22, pal.skin) +
        line("M118 220 L136 220", 4) + line("M104 236 L120 236", 4) + line("M140 236 L154 236", 4);
      out.sil = `<path d="M84 262 L128 206 L172 262" fill="none"/>`;
      break;
    default:
      face =
        eye(ctx, { ...big, pupil: false, extra: spiral(88, 146, 34) }) +
        eye(ctx, { ...tiny, pupil: false, extra: spiral(172, 152, 14, 2) }) +
        brow(52, 100, 118, 98, 4) +
        openMouth(ctx, grinD(128, 196, r(104 * f), 4, 24), { mx: 128, ty: 196, by: 196 + 24, w: r(104 * f), teeth: "all", k: 8, topSag: 4, botSag: 24 }) +
        drop(30, 150, 1.5) + drop(228, 118, 1.3) +
        line("M16 190 L4 196", 5) + line("M240 160 L252 156", 5);
  }
  out.faceT = cap + face;
  return out;
}

function connector(ctx, pal, t, mood) {
  const f = VOICE_WIDTH[t.voice];
  const tf = "rotate(7 128 170)";
  const antenna = fat("M170 64 L184 24", 8, "#c9d2e0") + circ(186, 18, 10, GOLD, 6);
  const badge = (cx, cy) => circ(cx, cy, 16, "#ff2d2d", 6) + line(`M${cx - 5} ${cy - 5} L${cx} ${cy - 10} L${cx} ${cy + 9}`, 5, "#fff");
  const out = {
    tf,
    silT: `<path d="M170 64 L184 24"/><circle cx="186" cy="18" r="10"/><circle cx="208" cy="22" r="16"/>`,
    sil: "", back: "", faceT: "", top: "",
  };
  const cheeks = ell(46, 186, 16, 10, "#ff7a9a", 0) + ell(210, 186, 16, 10, "#ff7a9a", 0);
  const bigEye = (cx, o = {}) =>
    eye(ctx, { cx, cy: 142, rx: 34, ry: 42, iris: pal.acc, ir: 27, pr: 15, ...o, extra: o.extra ?? sparkle(cx + 14, 130, 9, "#fff", 0) });
  const worried = brow(54, 112, 112, 96, 0) + brow(144, 96, 202, 112, 0);
  let face = "";
  const bubbleBack = (inner) => `<g>${inner}</g>`;
  switch (mood) {
    case "neutral":
      face = bigEye(L - 4) + bigEye(R + 4) + brow(52, 92, 112, 90, 6) + brow(144, 90, 204, 92, 6) + cheeks + voiceMouth(ctx, t.voice, 128, 204);
      out.back = bubbleBack(bubble(10, 8, 86, 46, 70, 82) + typingDots(53, 31));
      break;
    case "hype":
      face =
        heart(L - 4, 142, 34, "#ff2d55") + circ(L - 12, 126, 6, "#fff", 0) +
        heart(R + 4, 142, 34, "#ff2d55") + circ(R - 4, 126, 6, "#fff", 0) +
        brow(52, 92, 112, 84, 6) + brow(144, 84, 204, 92, 6) + cheeks +
        openMouth(ctx, grinD(128, 192, r(112 * f), 4, 28), { mx: 128, ty: 192, by: 220, w: r(112 * f), teeth: "top", k: 5, tongue: true, topSag: 4, botSag: 28 });
      out.back =
        bubble(42, 2, 80, 30, 92, 70, pal.acc2) + heart(82, 18, 10, "#ff2d55") +
        bubble(8, 28, 92, 36, 70, 86, "#fff") + heart(32, 47, 9, "#ff2d55") + heart(54, 47, 9, "#ff2d55") + heart(76, 47, 9, "#ff2d55");
      break;
    case "shade":
      face =
        eye(ctx, { cx: L - 2, cy: 142, rx: 32, ry: 36, px: -13, py: -6, pr: 8 }) +
        eye(ctx, { cx: R + 2, cy: 142, rx: 32, ry: 36, px: -13, py: -6, pr: 8 }) +
        worried +
        openMouth(ctx, `M${128 - r(44 * f)} 190 L${128 + r(44 * f)} 190 L${128 + r(44 * f)} 214 L${128 - r(44 * f)} 214 Z`, { mx: 128, ty: 190, by: 214, w: r(88 * f), teeth: "all", k: 7, flatDividers: true }) +
        line(`M${128 - r(44 * f)} 202 L${128 + r(44 * f)} 202`, 3) +
        drop(214, 100, 1.7);
      out.back = bubble(10, 8, 86, 46, 70, 82) + typingDots(53, 31);
      break;
    default:
      face =
        bigEye(L - 4, { iris: pal.acc2, ir: 29, pr: 19, extra: sparkle(L + 12, 128, 10, "#fff", 0) }) +
        bigEye(R + 4, { iris: pal.acc2, ir: 29, pr: 19, extra: sparkle(R + 20, 128, 10, "#fff", 0) }) +
        ell(L - 4, 170, 26, 8, WATER, 0).replace('fill="' + WATER + '"', `fill="${WATER}" fill-opacity="0.8"`) +
        ell(R + 4, 170, 26, 8, WATER, 0).replace('fill="' + WATER + '"', `fill="${WATER}" fill-opacity="0.8"`) +
        worried +
        line(`M${128 - r(36 * f)} 208 Q${128 - r(18 * f)} 196 128 208 Q${128 + r(18 * f)} 220 ${128 + r(36 * f)} 208`, 8) +
        drop(52, 214, 1.1) + drop(204, 218, 1.1);
      out.back =
        bubble(6, 4, 96, 58, 74, 84) +
        line("M46 26 Q46 14 56 14 Q68 14 68 25 Q68 33 56 38 L56 42", 7) + circ(56, 52, 4, INK, 0);
  }
  out.faceT = antenna + badge(208, 22) + face;
  // Antenna and badge sit behind nothing: they are part of the head group.
  return out;
}

function auditor(ctx, pal, t, mood) {
  const f = VOICE_WIDTH[t.voice];
  const tf = "translate(-14 0)";
  const out = { tf, silT: "", sil: "", back: "", faceT: "", top: "", headBox: { cx: 128, cy: 152, rx: 94, ry: 102 } };
  const frame = "#2a1d3a";
  const lens = (cx, cy, fill = GLASS) => circ(cx, cy, 38, fill, 0);
  const glare = (cx, cy, id, full) => {
    const bars = full
      ? `<path d="M${cx - 40} ${cy - 10} L${cx - 10} ${cy - 40} L${cx + 6} ${cy - 40} L${cx - 40} ${cy + 6} Z" fill="#fff"/><path d="M${cx - 40} ${cy + 22} L${cx + 22} ${cy - 40} L${cx + 40} ${cy - 40} L${cx - 40} ${cy + 40} Z" fill="#fff"/><path d="M${cx + 8} ${cy + 40} L${cx + 40} ${cy + 8} L${cx + 40} ${cy + 26} L${cx + 26} ${cy + 40} Z" fill="#fff"/>`
      : `<path d="M${cx - 38} ${cy - 4} L${cx - 6} ${cy - 38} L${cx + 6} ${cy - 38} L${cx - 38} ${cy + 8} Z" fill="#fff"/>`;
    return `<g clip-path="url(#${id})">${bars}</g>`;
  };
  const glasses = (opts) => {
    const idL = ctx.id("gl");
    const idR = ctx.id("gl");
    ctx.defs.push(`<clipPath id="${idL}"><circle cx="${L - 4}" cy="${EY}" r="38"/></clipPath><clipPath id="${idR}"><circle cx="${R + 4}" cy="${EY}" r="38"/></clipPath>`);
    const { full = true, crack = false, leftOnly = false, inner = ["", ""], tilt = 0 } = opts;
    return (
      `<g transform="rotate(${tilt} 128 ${EY})">` +
      lens(L - 4, EY, full ? "#cfeaff" : GLASS) + inner[0] + (full ? glare(L - 4, EY, idL, true) : glare(L - 4, EY, idL, false)) +
      (leftOnly ? "" : lens(R + 4, EY, full ? "#cfeaff" : GLASS) + inner[1] + (full ? glare(R + 4, EY, idR, true) : glare(R + 4, EY, idR, false))) +
      (crack ? line(`M${L - 20} ${EY - 30} L${L - 6} ${EY - 8} L${L - 18} ${EY + 4} L${L - 2} ${EY + 30}`, 4) + line(`M${L - 6} ${EY - 8} L${L + 22} ${EY - 4}`, 4) + line(`M${R + 24} ${EY - 26} L${R + 8} ${EY - 4} L${R + 22} ${EY + 10}`, 4) : "") +
      circ(L - 4, EY, 38, "none", 10).replace(INK, frame) +
      (leftOnly ? "" : circ(R + 4, EY, 38, "none", 10).replace(INK, frame)) +
      line(`M${L + 32} ${EY - 4} Q128 ${EY - 14} ${R - 32} ${EY - 4}`, 8).replace(INK, frame) +
      line(`M${L - 42} ${EY - 6} L36 ${EY - 10}`, 7).replace(INK, frame) +
      line(`M${R + 42} ${EY - 6} L220 ${EY - 10}`, 7).replace(INK, frame) +
      `</g>`
    );
  };
  const FX = 210;
  const HAND = pal.acc2;
  const fistFx = (cx, cy) =>
    ell(cx, cy, 34, 27, HAND, 7) +
    line(`M${cx - 6} ${cy - 14} Q${cx - 10} ${cy - 2} ${cx - 6} ${cy + 10}`, 4) +
    line(`M${cx + 8} ${cy - 14} Q${cx + 4} ${cy - 2} ${cx + 8} ${cy + 10}`, 4) +
    line(`M${cx + 21} ${cy - 10} Q${cx + 18} ${cy} ${cx + 21} ${cy + 8}`, 4) +
    ell(cx - 24, cy + 2, 13, 17, HAND, 6);
  const nail = (cx, cy) => `<path d="M${cx - 7} ${cy + 10} L${cx - 7} ${cy + 2} Q${cx - 7} ${cy - 6} ${cx} ${cy - 6} Q${cx + 7} ${cy - 6} ${cx + 7} ${cy + 2} L${cx + 7} ${cy + 10} Z" fill="#fff4f0" ${strokeAttrs(3)}/>`;
  // THE hand: fist bottom-right, one long index finger straight up to eye level.
  const raised =
    path(`M${FX - 12} 226 L${FX - 12} 128 Q${FX - 12} 114 ${FX} 114 Q${FX + 12} 114 ${FX + 12} 128 L${FX + 12} 226 Z`, HAND, 7) +
    nail(FX, 124) +
    line(`M${FX - 8} 160 L${FX + 8} 160`, 4) + line(`M${FX - 8} 184 L${FX + 8} 184`, 4) +
    fistFx(FX, 236) +
    line("M192 108 L182 98", 6) + line(`M${FX} 98 L${FX} 82`, 6) + line("M236 108 L246 98", 6);
  const raisedSil = `<path d="M${FX - 12} 226 L${FX - 12} 128 Q${FX - 12} 114 ${FX} 114 Q${FX + 12} 114 ${FX + 12} 128 L${FX + 12} 226 Z"/><ellipse cx="${FX}" cy="236" rx="34" ry="27"/>`;
  const smugMouth = (mx, my, w = 1) => voiceMouth(ctx, t.voice, mx, my) + line(`M${mx + r(34 * w)} ${my - 2} Q${mx + r(40 * w)} ${my - 4} ${mx + r(42 * w)} ${my - 10}`, 5);
  // Lopsided smug smirk pulled up on one side, with a dimple tick.
  const smirk = () =>
    line(`M104 206 Q130 210 150 200 Q158 196 162 186`, 9) +
    line(`M164 200 Q170 194 172 186`, 5) +
    line(`M96 202 L102 208`, 5);
  switch (mood) {
    case "neutral":
      out.faceT =
        glasses({ full: true }) +
        brow(54, 84, 112, 66, 8) + brow(144, 98, 204, 94, 0) +
        (t.voice === "flat" ? smirk() : smugMouth(122, 202));
      out.top = raised;
      out.sil = raisedSil;
      break;
    case "hype": {
      const smileEye = (cx) => line(`M${cx - 18} ${EY + 10} Q${cx} ${EY - 16} ${cx + 18} ${EY + 10}`, 9);
      out.faceT =
        glasses({ full: false, inner: [smileEye(L - 4), smileEye(R + 4)] }) +
        brow(54, 80, 112, 74, 6) + brow(144, 74, 204, 80, 6) +
        line(`M${96 - r(10 * f)} 198 Q112 220 ${128 + r(14 * f)} 196`, 8) +
        line(`M${128 + r(14 * f) + 1} 194 L${128 + r(14 * f) + 8} 186`, 5) +
        sparkle(R + 24, EY - 26, 12, "#fff", 4);
      const pushD = "M206 234 L122 158";
      out.top =
        fat(pushD, 26, HAND) + nail(122, 158).replace("<path", `<path transform="rotate(-48 122 158)"`) +
        fistFx(214, 242) + line("M108 146 L100 136", 6) + line("M120 140 L120 126", 6);
      out.sil = `<path d="${pushD}"/><ellipse cx="214" cy="242" rx="34" ry="27"/>`;
      break;
    }
    case "shade": {
      const sq = (cx) => eye(ctx, { cx, cy: EY + 4, rx: 25, ry: 25, lid: 0.5, slant: 6, lidCol: pal.shade, px: 5, py: 6, pr: 8 });
      out.faceT =
        glasses({ full: false, leftOnly: true, inner: [sq(L - 4), ""] }) +
        brow(52, 86, 116, 108, 0, 11) +
        line(`M${128 - r(30 * f)} 210 Q128 190 ${128 + r(30 * f)} 210`, 8);
      const mx = 176;
      const my = 140;
      const idM = ctx.id("mg");
      ctx.defs.push(`<clipPath id="${idM}"><circle cx="${mx}" cy="${my}" r="50"/></clipPath>`);
      out.top =
        fat(`M212 176 L238 252`, 16, GOLD) +
        circ(mx, my, 50, GLASS, 0) +
        `<g clip-path="url(#${idM})">${ell(mx, my, 44, 36, "#fff", 0)}${circ(mx - 6, my + 4, 18, pal.acc, 0)}${circ(mx - 6, my + 4, 10, INK, 0)}${circ(mx - 12, my - 2, 4, "#fff", 0)}<path d="M${mx - 56} ${my - 56} L${mx + 56} ${my - 56} L${mx + 56} ${my - 10} L${mx - 56} ${my - 22} Z" fill="${pal.shade}"/>${line(`M${mx - 56} ${my - 22} L${mx + 56} ${my - 10}`, 8)}</g>` +
        circ(mx, my, 50, "none", 14).replace(INK, frame) +
        circ(mx, my, 50, "none", 0).replace('fill="none"', `fill="none" stroke="${GOLD}" stroke-width="6"`) +
        fist(236, 240, pal);
      out.sil = `<circle cx="176" cy="140" r="50"/><path d="M212 176 L238 252"/><ellipse cx="236" cy="240" rx="30" ry="27"/>`;
      break;
    }
    default: {
      const wide = (cx) => eye(ctx, { cx, cy: EY, rx: 28, ry: 31, pr: 5, py: 2 });
      out.faceT =
        glasses({ full: false, crack: true, tilt: -12, inner: [wide(L - 4), wide(R + 4)] }) +
        brow(52, 84, 112, 76, 8) + brow(144, 76, 204, 84, 8) +
        openMouth(ctx, ovalD(122, 208, r(15 * f), 19), { mx: 122, ty: 189, by: 227, w: r(30 * f), tongue: true }) +
        drop(34, 112, 1.3) + drop(224, 98, 1.1);
      const d1 = "M210 232 L210 164";
      const d2 = "M210 164 L232 198";
      out.top =
        line(d1, 32, INK) + line(d2, 32, INK) + line(d1, 24, HAND) + line(d2, 24, HAND) +
        line("M200 172 L220 160", 4) + ell(233, 202, 6, 5, "#fff4f0", 3) +
        fistFx(FX, 238) + line("M232 150 L240 142", 5) + line("M246 180 L254 176", 5);
      out.sil = `<path d="${d1}"/><path d="${d2}"/><ellipse cx="${FX}" cy="238" rx="34" ry="27"/>`;
    }
  }
  return out;
}

const ROLES = { observer, trickster, connector, auditor };

// ---------------------------------------------------------------- layers

function background(pal, risk) {
  let g = `<rect width="256" height="256" fill="${pal.bg}"/>`;
  const c = pal.bg2;
  switch (risk) {
    case "low":
      for (const y of [28, 92, 156, 220]) {
        for (const x of [(y / 64) % 2 === 0 ? 32 : 96, (y / 64) % 2 === 0 ? 160 : 224]) g += circ(x + (y === 92 ? 0 : 0), y, 11, c, 0);
      }
      for (const [x, y] of [[96, 28], [224, 28], [32, 92], [160, 92], [96, 156], [224, 156], [32, 220], [160, 220]]) g += circ(x, y, 11, c, 0);
      break;
    case "high":
      for (let y = 8; y < 270; y += 36) {
        const pts = range(9).map((i) => `${i * 32} ${y + (i % 2 === 0 ? 0 : 22)}`);
        g += line(`M${pts.join(" L")}`, 12, c);
      }
      break;
    case "mid":
      for (const rad of [60, 100, 140, 180, 220]) g += `<circle cx="128" cy="150" r="${rad}" fill="none" stroke="${c}" stroke-width="16"/>`;
      break;
    default:
      for (let i = 0; i <= 256; i += 32) {
        g += `<path d="M${i} 0 L${i} 256 M0 ${i} L256 ${i}" stroke="${c}" stroke-width="6" fill="none"/>`;
      }
  }
  return `<g id="background">${g}</g>`;
}

function rings(depth, tier) {
  const ys = [84, 108, 132, 156, 180, 204];
  const slots = range(12).map((i) => (i % 2 === 0 ? [10, ys[i >> 1]] : [246, ys[i >> 1]]));
  return `<g id="rings">${range(depth)
    .map((i) => {
      const [x, y] = slots[i];
      return star(x, y, 9, 4, 5, TIER_STAR[tier], 3).replace("<path ", `<path data-ring="${i}" `);
    })
    .join("")}</g>`;
}

function render(traits, { mood } = {}) {
  const t = assertTraits(traits);
  const m = assertMood(mood);
  const pal = PALETTES[t.temperament];
  const prefix = defsPrefix("sticker", t, m);
  const ctx = makeCtx(prefix);
  const role = ROLES[t.role](ctx, pal, t, m);
  const hd = role.headBox ?? {};
  const tf = role.tf ? ` transform="${role.tf}"` : "";
  const headEl = head(ctx, pal, hd);
  const hb = { cx: 128, cy: 152, rx: 98, ry: 98, ...hd };

  const silShapes =
    `<path d="${SHOULDERS}"/><g${tf}><ellipse cx="${hb.cx}" cy="${hb.cy}" rx="${hb.rx}" ry="${hb.ry}"/>${role.silT}</g>${role.sil}`;
  const glyph =
    `<g id="glyph">` +
    `<g transform="translate(4 6)" fill="#000" fill-opacity="0.3" stroke="#000" stroke-opacity="0.3" stroke-width="24" stroke-linejoin="round">${silShapes}</g>` +
    `<g fill="#fff" stroke="#fff" stroke-width="24" stroke-linejoin="round" stroke-linecap="round">${silShapes}</g>` +
    `<g${tf}>${role.back}</g>` +
    `</g>`;
  // Backs that belong to the head (bubbles) must not rotate with it for connector; keep them absolute.
  const glyphAbs = role.back ? glyph.replace(`<g${tf}>${role.back}</g>`, `<g>${role.back}</g>`) : glyph;

  const face =
    `<g id="face">` +
    path(SHOULDERS, pal.acc, 8) +
    `<g${tf}>${headEl}${role.faceT}</g>` +
    role.top +
    `</g>`;

  return [
    svgOpen("sticker", rarityTier(t.memory_depth), m),
    `<defs>${ctx.defs.join("")}</defs>`,
    background(pal, t.risk),
    rings(t.memory_depth, rarityTier(t.memory_depth)),
    glyphAbs,
    face,
    "</svg>",
    "",
  ].join("\n");
}

export const style = Object.freeze({
  name: "sticker",
  title: "Bighead Sticker Pack",
  description:
    "Reaction-sticker bigheads: huge cropped faces, thick ink outlines, flat fills with one cel shadow and a fat white die-cut edge. Each agent is a one-second joke that reads at pfp size.",
  render,
});

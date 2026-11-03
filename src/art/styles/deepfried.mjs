// "Deep-Fried Reaction": crude, bold, MS-Paint-confident cartoon heads on a
// blown-out background, then over-saturated, posterized, grained and bloomed
// on purpose with SVG filters. The crude face carries the 48px pfp, the
// frying is seasoning. Original characters only.
//
//   role        -> the character (head shape, props, the one-second joke)
//   temperament -> palette (then fried)
//   risk        -> background pattern (plus zoom lines)
//   voice       -> neutral mouth baseline (moods override / modulate it)
//   memory_depth-> that many sticker marks (data-ring) around the edge

import { assertTraits, assertMood, rarityTier, traitSeed, defsPrefix, svgOpen, range } from "./shared.mjs";

const INK = "#0a0a0a";
const f = (v) => String(Math.round(v * 10) / 10);
const rad = (deg) => (deg * Math.PI) / 180;

const PAL = Object.freeze({
  cool: { b1: "#4aa0ff", b2: "#0a1650", skin: "#c4dcf4", skin2: "#7fa6d6", acc: "#64f0ff", acc2: "#ffffff", ray: "#cfeaff" },
  neon: { b1: "#ff2bd6", b2: "#2a0070", skin: "#c4ff1a", skin2: "#5fd400", acc: "#00f0ff", acc2: "#ffee00", ray: "#ffffff" },
  warm: { b1: "#ff3b0a", b2: "#5a0014", skin: "#ffd23a", skin2: "#ff8a1a", acc: "#fff27a", acc2: "#ff2a6a", ray: "#ffe08a" },
  muted: { b1: "#8fae5a", b2: "#26331a", skin: "#e6cf98", skin2: "#a8844e", acc: "#f0e6a0", acc2: "#c8603a", ray: "#e8f0c0" },
});

// How hard each mood is fried. sat: saturate, tbl: posterize steps,
// gain/off: grain, bloom: glow blur, disp: crunch displacement.
const FRY = Object.freeze({
  neutral: { cg: .92, cb: .68, sat: 3, kern: "0 -1 0 -1 5 -1 0 -1 0", tbl: "0 .25 .5 .75 1", gain: 0.3, off: 0.45, bloom: 5, disp: 3 },
  hype: { cg: .84, cb: .5, sat: 5, kern: "-1 -1 -1 -1 9 -1 -1 -1 -1", tbl: "0 .33 .67 1", gain: 0.4, off: 0.3, bloom: 8, disp: 4 },
  shade: { cg: .95, cb: .78, sat: 2, kern: "0 -1 0 -1 5 -1 0 -1 0", tbl: "0 .2 .4 .6 .8 1", gain: 0.25, off: 0.5, bloom: 3, disp: 2 },
  shook: { cg: .78, cb: .42, sat: 6, kern: "-1 -1 -1 -1 9 -1 -1 -1 -1", tbl: "0 .33 .67 1", gain: 0.45, off: 0.25, bloom: 9, disp: 5 },
});

const HEAD = Object.freeze({
  observer: "M44 138C44 84 84 60 128 60C174 60 214 86 214 138C214 188 176 214 128 214C80 214 44 190 44 138Z",
  trickster: "M54 128C48 78 90 52 132 56C184 60 210 96 204 144C200 196 164 226 118 222C72 218 58 176 54 128Z",
  connector: "M40 140C40 88 80 58 128 58C178 58 218 90 218 142C218 196 176 222 128 222C80 222 40 194 40 140Z",
  auditor: "M52 100C52 70 70 62 128 62C186 62 206 70 206 100L210 160C210 204 180 218 128 218C76 218 46 204 46 160Z",
});
const TILT = Object.freeze({ observer: -4, trickster: 10, connector: -8, auditor: 3 });

// ---------- primitives ----------
const stroke = (w) => `stroke="${INK}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`;
const ell = (cx, cy, rx, ry, fill, w = 5) =>
  `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" fill="${fill}"${w ? " " + stroke(w) : ""}/>`;
const circ = (cx, cy, r, fill, w = 5, extra = "") =>
  `<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(r)}" fill="${fill}"${w ? " " + stroke(w) : ""}${extra}/>`;
const path = (d, fill = "none", w = 6, extra = "") => `<path d="${d}" fill="${fill}"${w ? " " + stroke(w) : ""}${extra}/>`;
const line = (x1, y1, x2, y2, w = 8, col = INK, extra = "") =>
  `<path d="M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round"${extra}/>`;
const cpath = (d, col, w, extra = "") =>
  `<path d="${d}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra}/>`;
const chain = (d) => cpath(d, INK, 10, ' stroke-dasharray="0 9"') + cpath(d, "#ffc400", 5, ' stroke-dasharray="0 9"');
const MONO_CHAIN = "M186 158Q168 224 214 196";
const capsule = (x1, y1, x2, y2, w, fill) => line(x1, y1, x2, y2, w + 8, INK) + line(x1, y1, x2, y2, w, fill);
const glint = (x, y, r) => circ(x - r * 0.35, y - r * 0.35, r * 0.32, "#fff", 0);
const pupil = (x, y, r) => circ(x, y, r, INK, 0) + glint(x, y, r);
const pt = (x, y) => `${f(x)} ${f(y)}`;

const star = (x, y, s, fill, w = 3, extra = "") => {
  const q = s * 0.28;
  const d = `M${pt(x, y - s)}L${pt(x + q, y - q)}L${pt(x + s, y)}L${pt(x + q, y + q)}L${pt(x, y + s)}L${pt(x - q, y + q)}L${pt(x - s, y)}L${pt(x - q, y - q)}Z`;
  return path(d, fill, w, extra);
};
const heart = (x, y, s, fill = "#ff2a5a", w = 4) =>
  path(
    `M${pt(x, y + s * 0.9)}C${pt(x - s * 1.5, y - s * 0.2)} ${pt(x - s * 0.6, y - s * 1.1)} ${pt(x, y - s * 0.3)}C${pt(x + s * 0.6, y - s * 1.1)} ${pt(x + s * 1.5, y - s * 0.2)} ${pt(x, y + s * 0.9)}Z`,
    fill,
    w,
  );
const drop = (x, y, s = 1) =>
  path(
    `M${pt(x, y - 14 * s)}Q${pt(x + 11 * s, y + 2 * s)} ${pt(x, y + 10 * s)}Q${pt(x - 11 * s, y + 2 * s)} ${pt(x, y - 14 * s)}Z`,
    "#5fd8ff",
    4,
  ) + circ(x - 3 * s, y + 2 * s, 2.5 * s, "#fff", 0);

/** Spiral eye: white disc with an ink spiral. */
const spiralEye = (cx, cy, rx, ry) => {
  const pts = range(31).map((i) => {
    const t = i / 30;
    const a = rad(i * 40);
    return `${pt(cx + Math.cos(a) * rx * 0.85 * t, cy + Math.sin(a) * ry * 0.85 * t)}`;
  });
  return ell(cx, cy, rx, ry, "#fff") + path(`M${pts.join("L")}`, "none", 5);
};

/** Eyeball with optional heavy lid (frac = share of the eye the lid covers). */
const eye = (cx, cy, rx, ry, { px = cx, py = cy, pr = 10, lid = 0, skin = "#fff" } = {}) => {
  let s = ell(cx, cy, rx, ry, "#fff") + pupil(px, py, pr);
  if (lid > 0) {
    const yc = cy - ry + 2 * ry * lid;
    const dy = (yc - cy) / ry;
    const hx = rx * Math.sqrt(Math.max(0, 1 - dy * dy));
    s += path(`M${pt(cx - hx, yc)}A${f(rx)} ${f(ry)} 0 ${yc > cy ? 1 : 0} 1 ${pt(cx + hx, yc)}Z`, skin, 5);
  }
  return s;
};

// ---------- mouths ----------
const flatMouth = () => line(96, 186, 160, 186, 8);
const pursedMouth = () => path("M106 184L144 184Q152 184 154 176", "none", 8);

/** Wide white grin with many teeth. Tongue lolls out when asked. */
const grinMouth = ({ tongue = true } = {}) => {
  const half = (y) => 58 * Math.sqrt(Math.max(0, 1 - ((y - 160) / 54) ** 2));
  let s = "";
  if (tongue) s += path("M134 204Q150 240 168 204Z", "#ff5a86", 6);
  s += path("M70 160Q128 176 186 160Q184 212 128 214Q72 212 70 160Z", "#fff", 6);
  for (const x of [86, 100, 114, 128, 142, 156, 170]) {
    const yEnd = 160 + 54 * Math.sqrt(Math.max(0, 1 - ((x - 128) / 58) ** 2)) - 4;
    s += line(x, 170, x, yEnd, 3.5);
  }
  s += line(128 - half(188) + 4, 188, 128 + half(188) - 4, 188, 3.5);
  return s;
};

/** Giant open smile. */
const openMouth = (k = 1) => {
  const w = 50 * k;
  const d = `M${pt(128 - w, 164)}Q${pt(128, 164 + 60 * k)} ${pt(128 + w, 164)}Q${pt(128, 176)} ${pt(128 - w, 164)}Z`;
  return (
    path(d, "#b0102a", 6) +
    ell(128, 164 + 20 * k, 17 * k, 8 * k, "#ff6a8a", 0) +
    path(`M${pt(128 - w + 6, 166)}Q${pt(128, 180)} ${pt(128 + w - 6, 166)}L${pt(128 + w - 10, 176)}Q${pt(128, 190)} ${pt(128 - w + 10, 176)}Z`, "#fff", 0)
  );
};

const voiceMouth = (voice) =>
  ({ dry: flatMouth, loud: () => grinMouth({ tongue: true }), open: () => openMouth(1), flat: pursedMouth })[voice]();

/** Non-neutral mouths keep the role/mood joke; voice only stretches them. */
const modMouth = (voice, inner, cy = 184) => {
  const sx = { dry: 0.88, loud: 1.12, open: 1, flat: 0.94 }[voice];
  if (sx === 1) return inner;
  return `<g transform="translate(128 ${cy}) scale(${sx} 1) translate(-128 -${cy})">${inner}</g>`;
};

// ---------- characters ----------
// Each returns { behind, front, over }: behind = before the head (in the tilt
// group), front = on the head, over = outside the tilt group (flying bits).

const monocle = (cx, cy, r, { glare = false } = {}) =>
  circ(cx, cy, r, "#bff6ff", 0, ' fill-opacity=".35"') +
  cpath(`M${f(cx - r)} ${f(cy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`, INK, 14) +
  cpath(`M${f(cx - r)} ${f(cy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`, "#ffc400", 7) +
  line(cx - r * 0.5, cy - r * 0.35, cx - r * 0.2, cy - r * 0.6, 5, "#fff");

const beam = (id, x, y, side, half, thick) => {
  const ex = side < 0 ? -140 : 400;
  const ey = y - 70 - (side < 0 ? 0 : 20);
  return (
    path(`M${pt(x, y - thick)}L${pt(ex, ey - half)}L${pt(ex, ey + half)}L${pt(x, y + thick)}Z`, `url(#${id}-beam${side < 0 ? "L" : "R"})`, 0) +
    line(x, y, ex, ey, thick, "#fff", ' stroke-opacity=".95"')
  );
};
const flare = (id, x, y, r) => circ(x, y, r, `url(#${id}-flare)`, 0);
const flareStar = (x, y, s) =>
  path(`M${pt(x - s, y)}L${pt(x, y - s * 0.12)}L${pt(x + s, y)}L${pt(x, y + s * 0.12)}Z`, "#fff", 0) +
  path(`M${pt(x, y - s * 0.7)}L${pt(x + s * 0.09, y)}L${pt(x, y + s * 0.7)}L${pt(x - s * 0.09, y)}Z`, "#fff", 0);

function observer(c) {
  const { mood, voice, pal, id } = c;
  const L = [92, 128], R = [164, 128];
  const bags = path("M72 162Q92 170 112 162", "none", 4) + path("M144 164Q164 172 184 164", "none", 4);
  let front = "";
  let over = "";
  if (mood === "neutral") {
    front += eye(L[0], L[1], 26, 28, { py: 136, lid: 0.55, skin: pal.skin });
    front += eye(R[0], R[1], 26, 28, { py: 136, lid: 0.55, skin: pal.skin });
    front += bags + line(64, 106, 118, 108, 9) + line(138, 108, 192, 106, 9);
    front += voiceMouth(voice);
    front += monocle(164, 128, 37);
    front += chain(MONO_CHAIN);
  } else if (mood === "hype") {
    front += eye(L[0], L[1], 26, 28, { px: 98, py: 134, lid: 0.3, skin: pal.skin });
    front += eye(R[0], R[1], 26, 28, { px: 168, py: 134, lid: 0.3, skin: pal.skin });
    front += bags + line(64, 110, 118, 112, 9) + path("M140 92Q166 72 194 88", "none", 9);
    front += modMouth(voice, path("M98 186Q132 190 162 170L168 162", "none", 8));
    front += monocle(164, 128, 37);
    front += chain(MONO_CHAIN);
    front += beam(id, 164, 128, 1, 34, 12) + flare(id, 164, 128, 46) + flareStar(184, 106, 58);
    front += circ(150, 150, 6, "#fff", 0, ' fill-opacity=".7"') + circ(120, 176, 10, "#ffe45a", 0, ' fill-opacity=".6"') + circ(96, 196, 5, "#fff", 0, ' fill-opacity=".7"');
  } else if (mood === "shade") {
    front += eye(L[0], L[1], 26, 28, { px: 76, py: 134, lid: 0.45, skin: pal.skin });
    front += eye(R[0], R[1], 26, 28, { px: 148, py: 134, lid: 0.45, skin: pal.skin });
    front += bags + line(64, 104, 118, 114, 9) + line(138, 114, 192, 104, 9);
    front += modMouth(voice, line(90, 188, 150, 188, 8));
    front += monocle(164, 128, 37);
    front += chain(MONO_CHAIN);
    front +=
      ell(178, 226, 36, 8, "#e8e8f0", 5) +
      path("M148 172L206 172Q206 216 177 216Q148 216 148 172Z", "#fff", 6) +
      line(152, 186, 202, 186, 5, pal.acc) +
      path("M206 180Q230 180 226 198Q222 208 204 206", "none", 7) +
      cpath("M162 156q-9 -10 0 -18q9 -8 0 -16", "#fff", 6);
  } else {
    front += eye(L[0], L[1], 28, 32, { pr: 5 });
    front += eye(R[0], R[1], 28, 32, { pr: 5 });
    front += path("M62 88Q92 62 122 84", "none", 9) + path("M134 84Q164 62 194 90", "none", 9);
    front += ell(128, 188, 8, 11, INK, 0) + ell(128, 188, 8, 11, "none", 4);
    over += monocle(214, 52, 30) + chain("M196 76Q172 80 180 100T160 130") + line(190, 96, 168, 108, 5, "#fff") + line(204, 100, 186, 116, 5, "#fff") + line(214, 94, 200, 110, 5, "#fff");
    over += line(194, 100, 188, 112, 5, "#fff") + line(210, 100, 208, 116, 5, "#fff") + line(226, 98, 230, 110, 5, "#fff");
    front += drop(204, 100, 1.1);
  }
  return { behind: "", front, over };
}

function trickster(c) {
  const { mood, voice, pal, id } = c;
  const L = [88, 122], R = [172, 130];
  const horn = (d, col) => path(d, "none", 30) + path(d, "none", 0, ` stroke="${col}" stroke-width="20" stroke-linecap="round"`);
  const bell = (x, y) => circ(x, y, 11, "#ffd400", 5) + line(x - 4, y - 5, x - 1, y - 8, 3, "#fff");
  const hat =
    `<g transform="translate(0 -22)">` +
    horn("M80 94Q44 74 26 104", pal.acc2) +
    horn("M178 94Q212 70 232 102", pal.acc2) +
    horn("M126 80Q116 52 146 34", pal.acc) +
    bell(26, 108) + bell(234, 106) + bell(148, 32) +
    path("M60 104Q128 62 200 104Q198 120 190 124Q128 86 70 126Z", pal.acc, 6) +
    circ(100, 100, 4, INK, 0) + circ(128, 92, 4, INK, 0) + circ(158, 98, 4, INK, 0) +
    `</g>`;
  let front = "";
  let over = "";
  const brows = (a, b) => path(a, "none", 9) + path(b, "none", 9);
  if (mood === "neutral") {
    front += eye(L[0], L[1], 32, 36, { px: 96, py: 116, pr: 7 });
    front += eye(R[0], R[1], 11, 11, { px: 172, py: 132, pr: 5 });
    front += brows("M52 76Q86 54 124 78", "M150 112L194 120");
    front += (voice === "loud" ? "" : "") + voiceMouth(voice);
  } else if (mood === "hype") {
    front += eye(L[0], L[1], 32, 36, { pr: 7 });
    front += eye(R[0], R[1], 11, 11, { pr: 5 });
    front += flare(id, L[0], L[1], 48) + flare(id, R[0], R[1], 26);
    front += brows("M52 70Q86 48 124 72", "M148 104Q172 92 196 108");
    front += beam(id, L[0], L[1], -1, 60, 14) + beam(id, R[0], R[1], 1, 40, 8);
    front += circ(L[0], L[1], 10, "#fff", 0) + circ(R[0], R[1], 5, "#fff", 0);
    const mouth = path("M66 156Q128 138 190 156Q198 232 128 234Q60 232 66 156Z", "#7a0a1a", 7) +
      path("M72 160Q128 144 184 160L180 178Q128 164 76 178Z", "#fff", 0) +
      ell(128, 218, 28, 14, "#ff5a86", 0);
    front += modMouth(voice, mouth, 190);
  } else if (mood === "shade") {
    front += eye(L[0], L[1], 32, 36, { px: 100, py: 128, pr: 7, lid: 0.55, skin: pal.skin });
    front += eye(R[0], R[1], 11, 11, { px: 172, py: 134, pr: 5, lid: 0.3, skin: pal.skin });
    front += brows("M52 96L122 126", "M196 112L148 130");
    const grin =
      path("M66 168Q128 226 190 160Q130 190 66 168Z", "#fff", 6) +
      path("M80 174L88 184L96 178L106 188L116 182L128 190L140 184L152 188L162 180L172 182L180 170", "none", 3.5);
    front += modMouth(voice, grin, 180);
  } else {
    front += spiralEye(L[0], L[1], 32, 36);
    front += spiralEye(R[0], R[1], 12, 12);
    front += brows("M52 72Q86 56 124 80", "M150 108Q172 96 196 110");
    front += modMouth(voice, grinMouth({ tongue: false }), 186);
    over += drop(30, 100, 1.3) + drop(226, 90, 1.1) + drop(36, 170, 1) + drop(222, 168, 1);
    over += line(46, 70, 28, 52, 6, "#fff") + line(210, 54, 226, 36, 6, "#fff") + line(40, 126, 18, 128, 6, "#fff") + line(216, 128, 240, 126, 6, "#fff");
  }
  return { behind: "", front: front + hat, over };
}

function connector(c) {
  const { mood, voice, pal, id } = c;
  const L = [90, 124], R = [166, 124];
  const antenna =
    capsule(128, 80, 140, 34, 5, "#9aa3b2") + circ(141, 32, 8, "#ffd400", 4) +
    circ(160, 30, 15, "#ff1a2a", 5) + cpath("M155 23L161 21L161 38", "#fff", 4);
  const blush = ell(58, 170, 14, 9, "#ff5a8a", 0, ) + ell(198, 170, 14, 9, "#ff5a8a", 0);
  const brows = (a, b) => path(a, "none", 9) + path(b, "none", 9);
  const bigEye = (cx, cy) =>
    eye(cx, cy, 30, 34, { py: cy + 2, pr: 21 }) + circ(cx - 8, cy - 11, 8, "#fff", 0) + circ(cx + 9, cy + 10, 4, "#fff", 0);
  let front = blush;
  let over = "";
  if (mood === "neutral") {
    front += bigEye(L[0], L[1]) + bigEye(R[0], R[1]);
    front += star(120, 100, 9, pal.acc2, 2) + star(194, 98, 9, pal.acc2, 2);
    front += brows("M62 84Q90 68 118 84", "M138 84Q166 68 194 84");
    front += voiceMouth(voice);
  } else if (mood === "hype") {
    front += eye(L[0], L[1], 30, 34, { pr: 0 }) + eye(R[0], R[1], 30, 34, { pr: 0 });
    front += heart(L[0], L[1] + 2, 24) + heart(R[0], R[1] + 2, 24) + circ(L[0], L[1], 46, `url(#${id}-flarePink)`, 0) + circ(R[0], R[1], 46, `url(#${id}-flarePink)`, 0);
    front += circ(L[0] - 10, L[1] - 8, 5, "#fff", 0) + circ(R[0] - 10, R[1] - 8, 5, "#fff", 0);
    front += brows("M60 80Q90 56 120 80", "M136 80Q166 56 196 80");
    front += modMouth(voice, openMouth(1.15), 190);
    over += heart(30, 80, 11, "#ff2a5a", 3) + heart(228, 70, 9, "#ff2a5a", 3);
  } else if (mood === "shade") {
    front += eye(L[0], L[1], 25, 27, { px: 84, py: 116, pr: 6 }) + eye(R[0], R[1], 25, 27, { px: 160, py: 116, pr: 6 });
    front += brows("M64 100L114 84", "M142 84L192 100");
    const teeth =
      `<rect x="86" y="168" width="84" height="30" rx="10" fill="#fff" ${stroke(6)}/>` +
      line(100, 170, 100, 196, 3.5) + line(114, 170, 114, 196, 3.5) + line(128, 170, 128, 196, 3.5) + line(142, 170, 142, 196, 3.5) + line(156, 170, 156, 196, 3.5) +
      line(88, 183, 168, 183, 3.5) + line(78, 172, 84, 176, 5) + line(178, 172, 172, 176, 5);
    front += modMouth(voice, teeth, 183);
    front += drop(196, 98, 2);
  } else {
    front += eye(L[0], L[1], 33, 37, { py: 126, pr: 25 }) + eye(R[0], R[1], 33, 37, { py: 126, pr: 25 });
    for (const [x, y] of [L, R]) front += circ(x - 9, y - 11, 9, "#fff", 0) + circ(x + 10, y + 8, 5, "#fff", 0) + circ(x - 3, y + 20, 3, "#fff", 0);
    front += 
    front += line(78, 158, 74, 200, 6, "#5fd8ff") + line(176 + 8, 158, 188, 200, 6, "#5fd8ff") + line(96, 162, 94, 182, 6, "#5fd8ff");
    front += brows("M60 90L114 70", "M142 70L196 90");
    front += modMouth(voice, path("M88 190Q100 174 112 190T136 190T168 190", "none", 8), 188);
  }
  return { behind: antenna, front, over };
}

function auditor(c) {
  const { mood, voice, pal, id } = c;
  const L = [92, 128], R = [164, 128];
  const frame = (cx, cy, r, fill, op) =>
    circ(cx, cy, r, fill, 7, ` fill-opacity="${op}"`);
  const glare = (cx, cy) => line(cx - 16, cy + 8, cx + 4, cy - 14, 8, "#9fe3ff") + line(cx - 6, cy + 20, cx + 16, cy - 4, 4, "#9fe3ff");
  const arms = line(62, 124, 50, 118, 6) + line(194, 124, 206, 118, 6);
  const bridge = path("M122 124Q128 118 134 124", "none", 6);
  const fistBlock = (x, y) =>
    `<rect x="${f(x - 23)}" y="${f(y)}" width="46" height="44" rx="16" fill="${pal.skin}" ${stroke(6)}/>` +
    line(x - 9, y + 16, x - 9, y + 32, 4) + line(x + 5, y + 16, x + 5, y + 32, 4) +
    capsule(x - 20, y + 14, x - 28, y + 30, 12, pal.skin);
  // One connected hand: ink pass for every part, then skin pass over the seams.
  const raisedHand = (segs, { nail = true } = {}) => {
    const fx = 226, fy = 176;
    const fist = (fill, w) => `<rect x="${fx - 24}" y="${fy}" width="48" height="48" rx="18" fill="${fill}"${w ? ` stroke="${INK}" stroke-width="${w}"` : ""}/>`;
    let g = fist(INK, 8);
    for (const [x1, y1, x2, y2, w] of segs) g += line(x1, y1, x2, y2, w + 8, INK);
    g += fist(pal.skin, 0);
    for (const [x1, y1, x2, y2, w] of segs) g += line(x1, y1, x2, y2, w, pal.skin);
    g += cpath(`M${fx - 12} ${fy + 16}Q${fx - 6} ${fy + 22} ${fx - 12} ${fy + 30}`, INK, 4) + cpath(`M${fx} ${fy + 16}Q${fx + 6} ${fy + 22} ${fx} ${fy + 30}`, INK, 4) + cpath(`M${fx + 12} ${fy + 16}Q${fx + 18} ${fy + 22} ${fx + 12} ${fy + 30}`, INK, 4);
    g += capsule(fx - 22, fy + 24, fx - 12, fy + 38, 12, pal.skin);
    const last = segs[segs.length - 1];
    if (nail) g += `<ellipse cx="${f(last[2])}" cy="${f(last[3] + (last[3] < last[1] ? 6 : -6))}" rx="6" ry="5" fill="#fff" fill-opacity=".85"/>`;
    return g;
  };
  const magnifier = (cx, cy, r) =>
    capsule(cx - r * 0.7, cy + r * 0.7, cx - r * 1.7, cy + r * 1.9, 12, "#a8662a") +
    circ(cx, cy, r, "#bff6ff", 0, ' fill-opacity=".45"') + circ(cx, cy, r, "none", 14) +
    cpath(`M${f(cx - r)} ${f(cy)}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`, "#c8d0d8", 7) +
    line(cx - r * 0.5, cy - r * 0.3, cx - r * 0.2, cy - r * 0.6, 5, "#fff");
  let front = "";
  let behind = "";
  if (mood === "neutral") {
    front += frame(L[0], L[1], 31, "#fff", 1) + frame(R[0], R[1], 29, "#fff", 1) + glare(L[0], L[1]) + glare(R[0], R[1]);
    front += arms + bridge;
    front += path("M62 88Q90 62 120 82", "none", 10) + line(142, 98, 190, 106, 10);
    front += voiceMouth(voice);
    front += raisedHand([[226, 190, 226, 112, 22]]);
    front += cpath("M208 100L198 90", "#fff", 5) + cpath("M226 94L226 80", "#fff", 5) + cpath("M244 100L254 90", "#fff", 5);
  } else if (mood === "hype") {
    front += frame(L[0], L[1] - 8, 31, "#fff", 0.4) + frame(R[0], R[1] - 8, 29, "#fff", 0.4) + glare(L[0], L[1] - 8) + glare(R[0], R[1] - 8);
    front += path("M72 126Q92 106 112 126", "none", 8) + path("M144 126Q164 106 184 126", "none", 8);
    front += line(62, 116, 50, 110, 6) + line(194, 116, 206, 110, 6) + path("M122 116Q128 110 134 116", "none", 6);
    front += path("M62 80Q90 56 120 76", "none", 10) + path("M142 74Q166 56 192 78", "none", 10);
    front += modMouth(voice, path("M92 176Q128 204 168 170", "none", 8) + path("M168 170L174 164", "none", 5) + circ(80, 174, 4, "#ff6a8a", 0) + circ(184, 168, 4, "#ff6a8a", 0), 184);
    front += flare(id, L[0], L[1] - 8, 40) + flare(id, R[0], R[1] - 8, 40) + flareStar(L[0], L[1] - 8, 44) + flareStar(R[0], R[1] - 8, 44);
    front += `<rect x="116" y="28" width="48" height="42" rx="16" fill="${pal.skin}" ${stroke(7)} transform="rotate(-12 140 49)"/>` + line(128, 44, 128, 58, 4) + line(142, 44, 142, 58, 4) + line(156, 44, 156, 58, 4);
    front += capsule(138, 60, 129, 104, 14, pal.skin) + `<ellipse cx="128" cy="106" rx="5" ry="4" fill="#fff" fill-opacity=".85"/>`;
  } else if (mood === "shade") {
    front += frame(R[0], R[1], 29, "#fff", 0.3) + eye(R[0], R[1], 20, 22, { px: 156, py: 130, pr: 6, lid: 0.55, skin: pal.skin });
    front += frame(L[0], L[1], 31, "#fff", 0.3);
    front += arms + bridge + line(64, 94, 118, 110, 10) + line(140, 110, 192, 94, 10);
    front += modMouth(voice, path("M98 196Q128 170 160 196", "none", 9), 190);
    front += circ(L[0], L[1], 41, pal.skin, 0, ' fill-opacity=".0"');
    front += magnifier(L[0], L[1], 42);
    front += ell(L[0], L[1], 33, 26, "#fff", 6) + pupil(L[0] - 4, L[1] + 4, 13) + path(`M${pt(L[0] - 33, L[1])}A33 26 0 0 1 ${pt(L[0] + 33, L[1])}L${pt(L[0] + 33, L[1] - 8)}L${pt(L[0] - 33, L[1] - 8)}Z`, "none", 0);
    front += path(`M${pt(L[0] - 33, L[1] - 4)}A33 26 0 0 1 ${pt(L[0] + 33, L[1] - 4)}Z`, pal.skin, 6);
    front += fistBlock(24, 222).replace(/x="[^"]+"/, `x="4"`).replace(`y="222"`, `y="218"`);
  } else {
    front += `<g transform="rotate(-12 128 130)">` + frame(L[0], L[1] + 14, 31, "#fff", 0.45) + frame(R[0], R[1] - 4, 29, "#fff", 0.45) + arms + bridge + `</g>`;
    front += eye(88, 144, 15, 19, { pr: 4 }) + eye(168, 118, 14, 18, { pr: 4 });
    front += cpath("M150 98L162 112L152 122L166 136L158 148", INK, 6) + cpath("M150 98L162 112L152 122L166 136L158 148", "#fff", 2);
    front += path("M62 76Q90 56 118 74", "none", 10) + path("M142 70Q170 50 196 74", "none", 10);
    front += modMouth(voice, path("M108 176Q128 168 150 176Q152 208 128 210Q106 208 108 176Z", "#5a0a14", 6) + ell(128, 200, 10, 6, "#ff6a8a", 0), 190);
    behind += "";
    front += raisedHand([[226, 190, 224, 134, 22], [224, 134, 242, 156, 18]], { nail: false });
    front += drop(46, 100, 1.2);
  }
  return { behind, front, over: "" };
}

const CHARACTERS = { observer, trickster, connector, auditor };

// ---------- glyph layer (behind the head) ----------
function glyphLayer(role, mood, pal, id) {
  if (role === "observer") {
    const bubble =
      ell(56, 50, 42, 26, "#fff", 5) + circ(84, 84, 7, "#fff", 4) + circ(94, 98, 4, "#fff", 3);
    if (mood === "hype") return bubble + circ(40, 52, 4, INK, 0) + circ(56, 52, 4, INK, 0) + path("M36 62Q56 74 76 58", "none", 4);
    if (mood === "shook") return bubble + line(42, 36, 42, 54, 6) + circ(42, 64, 3.5, INK, 0) + line(70, 36, 70, 54, 6) + circ(70, 64, 3.5, INK, 0);
    return bubble + circ(38, 52, 5, INK, 0) + circ(56, 52, 5, INK, 0) + circ(74, 52, 5, INK, 0);
  }
  if (role === "trickster") {
    const bits = [
      [24, 34, 0], [230, 36, 1], [18, 190, 2], [236, 200, 0], [60, 238, 1], [196, 240, 2], [104, 24, 1], [246, 140, 2],
    ];
    return bits
      .map(([x, y, k], i) => {
        const col = i % 2 ? pal.acc : pal.acc2;
        if (k === 0) return path(`M${pt(x, y - 12)}L${pt(x + 12, y + 10)}L${pt(x - 12, y + 10)}Z`, col, 4);
        if (k === 1) return `<rect x="${x - 10}" y="${y - 6}" width="20" height="12" rx="2" fill="${col}" ${stroke(4)} transform="rotate(${20 + i * 17} ${x} ${y})"/>`;
        return circ(x, y, 9, col, 4);
      })
      .join("");
  }
  if (role === "connector") {
    const bubble = (x, y, w, h, tail) =>
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#fff" ${stroke(5)}/>` +
      (tail ? path(`M${x + 18} ${y + h - 2}L${x + 6} ${y + h + 18}L${x + 36} ${y + h - 2}`, "#fff", 5) : "");
    const dots = (x, y) => circ(x, y, 5, "#8b8f99", 0) + circ(x + 16, y, 5, "#8b8f99", 0) + circ(x + 32, y, 5, "#8b8f99", 0);
    if (mood === "hype")
      return (
        bubble(160, 100, 88, 34, true) + heart(204, 118, 8, "#ff2a5a", 3) +
        bubble(154, 56, 88, 34, false) + heart(198, 74, 8, "#ff2a5a", 3) +
        bubble(160, 12, 80, 34, false) + dots(184, 29).replace(/#8b8f99/g, "#ff2a5a")
      );
    if (mood === "shook")
      return (
        bubble(144, 12, 100, 62, true) +
        path("M180 30Q180 22 194 22Q208 22 208 34Q208 44 194 48L194 54", "none", 7) + circ(194, 64, 4, INK, 0)
      );
    if (mood === "shade") return bubble(150, 16, 90, 36, true) + circ(178, 34, 4, "#8b8f99", 0) + circ(194, 34, 4, "#8b8f99", 0) + circ(210, 34, 4, "#8b8f99", 0);
    return bubble(150, 14, 92, 40, true) + circ(178, 34, 7, "#555a66", 0) + circ(196, 34, 5, "#8b8f99", 0) + circ(212, 34, 4, "#b7bbc4", 0);
  }
  // auditor stamp
  const ring = (dash) => circ(46, 52, 30, "none", 0, ` stroke="#ff1a2a" stroke-width="7"${dash ? ' stroke-dasharray="9 7"' : ""}`);
  if (mood === "hype") return ring(false).replace(/#ff1a2a/, "#18e060") + path("M30 54L42 66L64 38", "none", 0, ' stroke="#18e060" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"');
  if (mood === "shook") return ring(true) + line(46, 36, 46, 56, 8, "#ff1a2a") + circ(46, 68, 4.5, "#ff1a2a", 0);
  return ring(false) + line(32, 38, 60, 66, 9, "#ff1a2a") + line(60, 38, 32, 66, 9, "#ff1a2a");
}

// ---------- background ----------
function backgroundLayer(t, pal, mood, seed, id) {
  const n = 24;
  const start = seed % 15;
  const R = 220;
  const wedges = range(n)
    .filter((i) => i % 2 === 0)
    .map((i) => {
      const a = start + i * (360 / n);
      const b = a + 360 / n;
      return `M128 128L${pt(128 + R * Math.cos(rad(a)), 128 + R * Math.sin(rad(a)))}L${pt(128 + R * Math.cos(rad(b)), 128 + R * Math.sin(rad(b)))}Z`;
    })
    .join("");
  const rayOp = mood === "shade" ? ".18" : mood === "neutral" ? ".26" : ".4";
  let s = `<rect width="256" height="256" fill="url(#${id}-bg)"/>`;
  s += `<path d="${wedges}" fill="${pal.ray}" fill-opacity="${rayOp}"/>`;
  const a = pal.acc;
  if (t.risk === "low") {
    const dots = [[28, 30, 9], [220, 26, 7], [124, 20, 6], [24, 120, 7], [236, 112, 9], [30, 214, 8], [224, 226, 10], [128, 238, 6], [80, 236, 5]];
    s += dots.map(([x, y, r]) => circ(x, y, r, a, 0, ' fill-opacity=".85"')).join("");
  } else if (t.risk === "high") {
    const zig = (y) => `M-10 ${y}` + range(10).map((i) => `L${-10 + (i + 1) * 30} ${y + (i % 2 ? 14 : -14)}`).join("");
    s += [26, 82, 176, 232].map((y) => path(zig(y), "none", 0, ` stroke="${a}" stroke-width="9" stroke-linejoin="miter" stroke-opacity=".9"`)).join("");
  } else if (t.risk === "mid") {
    s += [48, 76, 104, 132, 160, 188].map((r) => circ(128, 128, r, "none", 0, ` stroke="${a}" stroke-width="7" stroke-opacity=".75"`)).join("");
  } else {
    const g = range(9).map((i) => i * 32);
    s += g.map((v) => `<path d="M${v} 0V256M0 ${v}H256" stroke="${a}" stroke-width="3" stroke-opacity=".7" fill="none"/>`).join("");
  }
  return s + `<rect width="256" height="256" fill="url(#${id}-vig)"/>`;
}

// ---------- rings: sticker marks ----------
function ringsLayer(t, pal, seed) {
  const n = t.memory_depth;
  return range(n)
    .map((i) => {
      const ang = rad(-90 + i * (360 / n) + (seed % 11));
      const rr = 112 + ((i * 37 + seed) % 9) - 4;
      const x = 128 + rr * Math.cos(ang);
      const y = 128 + rr * Math.sin(ang);
      const k = i % 3;
      const s = 10 + (i % 3) * 2;
      const mark = ` data-ring="${i}"`;
      if (k === 0) return star(x, y, s + 3, pal.acc2, 3, mark);
      if (k === 1)
        return path(`M${pt(x - s, y - s)}L${pt(x + s, y + s)}M${pt(x + s, y - s)}L${pt(x - s, y + s)}`, "none", 0, ` stroke="#ff1a2a" stroke-width="7" stroke-linecap="round"${mark}`);
      return path(
        `M${pt(x, y + s)}C${pt(x - s, y + s)} ${pt(x - s * 0.8, y - s * 0.2)} ${pt(x, y - s * 1.2)}C${pt(x + s * 0.2, y - s * 0.2)} ${pt(x + s * 0.5, y - s * 0.4)} ${pt(x + s * 0.5, y + s * 0.1)}C${pt(x + s * 0.9, y + s * 0.4)} ${pt(x + s * 0.7, y + s)} ${pt(x, y + s)}Z`,
        "#ff7a1a",
        3,
        mark,
      );
    })
    .join("");
}

// ---------- defs ----------
function defsBlock(id, pal, mood, seed) {
  const m = FRY[mood];
  const s1 = (seed % 97) + 1;
  const s2 = ((seed >>> 8) % 97) + 1;
  const table = (fn) => ["R", "G", "B"].map((c) => `<feFunc${c} type="discrete" tableValues="${m.tbl}"/>`).join("");
  const filt = (name, { disp, bloom, scale }) =>
    `<filter id="${id}-${name}" x="0" y="0" width="256" height="256" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
    `<feTurbulence type="fractalNoise" baseFrequency="${scale}" numOctaves="2" seed="${s1}" result="n"/>` +
    `<feDisplacementMap in="SourceGraphic" in2="n" scale="${disp}" xChannelSelector="R" yChannelSelector="G" result="d"/>` +
    `<feConvolveMatrix in="d" order="3" kernelMatrix="${m.kern}" preserveAlpha="true" result="k"/>` +
    `<feColorMatrix in="k" type="saturate" values="${m.sat}" result="s"/>` +
    `<feComponentTransfer in="s" result="ct"><feFuncR type="linear" slope="1.7" intercept="-.32"/><feFuncG type="linear" slope="1.7" intercept="-.32"/><feFuncB type="linear" slope="1.7" intercept="-.32"/></feComponentTransfer>` +
    `<feColorMatrix in="ct" type="matrix" values="1.3 .2 0 0 .08 0 ${m.cg} 0 0 0 0 0 ${m.cb} 0 -.05 0 0 0 1 0" result="cc"/>` +
    `<feComponentTransfer in="cc" result="p">${table()}</feComponentTransfer>` +
    (bloom
      ? `<feGaussianBlur in="p" stdDeviation="${bloom}" result="b"/>` +
        `<feColorMatrix in="b" type="matrix" values="0 0 0 0.9 0 0 0 0 0.35 0 0 0 0 0 0 0 0 0 1.4 0" result="g"/>` +
        `<feMerge result="c"><feMergeNode in="g"/><feMergeNode in="p"/></feMerge>`
      : `<feOffset in="p" result="c"/>`) +
    `<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="1" seed="${s2}" result="gn"/>` +
    `<feColorMatrix in="gn" type="matrix" values="${m.gain} ${m.gain} ${m.gain} 0 ${m.off} ${m.gain} ${m.gain} ${m.gain} 0 ${m.off} ${m.gain} ${m.gain} ${m.gain} 0 ${m.off} 0 0 0 0 1" result="gm"/>` +
    `<feComposite in="gm" in2="c" operator="in" result="gk"/>` +
    `<feBlend in="gk" in2="c" mode="multiply"/>` +
    `</filter>`;
  return (
    `<defs>` +
    `<radialGradient id="${id}-bg" cx=".5" cy=".5" r=".75"><stop offset="0" stop-color="${pal.b1}"/><stop offset="1" stop-color="${pal.b2}"/></radialGradient>` +
    `<radialGradient id="${id}-vig" cx=".5" cy=".5" r=".72"><stop offset=".5" stop-color="#1a0400" stop-opacity="0"/><stop offset="1" stop-color="#1a0400" stop-opacity=".9"/></radialGradient>` +
    `<radialGradient id="${id}-skin" cx=".4" cy=".35" r=".8"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"/><stop offset=".45" stop-color="${pal.skin}"/><stop offset="1" stop-color="${pal.skin2}"/></radialGradient>` +
    `<radialGradient id="${id}-flare"><stop offset="0" stop-color="#ffffff"/><stop offset=".25" stop-color="#fff2a0" stop-opacity=".95"/><stop offset=".55" stop-color="#ff3a1a" stop-opacity=".6"/><stop offset="1" stop-color="#ff3a1a" stop-opacity="0"/></radialGradient>` +
    `<radialGradient id="${id}-flarePink"><stop offset="0" stop-color="#ffffff" stop-opacity=".9"/><stop offset=".3" stop-color="#ff8ac0" stop-opacity=".75"/><stop offset="1" stop-color="#ff3a90" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="${id}-beamL" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset=".3" stop-color="#ff5a2a"/><stop offset="1" stop-color="#ff0030" stop-opacity=".35"/></linearGradient>` +
    `<linearGradient id="${id}-beamR" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#ffffff"/><stop offset=".3" stop-color="#ff5a2a"/><stop offset="1" stop-color="#ff0030" stop-opacity=".35"/></linearGradient>` +
    filt("bgfry", { disp: m.disp + 3, bloom: 0, scale: 0.05 }) +
    filt("fry", { disp: m.disp, bloom: m.bloom, scale: 0.35 }) +
    `</defs>`
  );
}

function render(traits, { mood: moodIn } = {}) {
  const t = assertTraits(traits);
  const mood = assertMood(moodIn);
  const id = defsPrefix("deepfried", t, mood);
  const pal = PAL[t.temperament];
  const seed = traitSeed(t);
  const tilt = TILT[t.role] + ((seed % 3) - 1);
  const ctx = { mood, voice: t.voice, pal, id };
  const ch = CHARACTERS[t.role](ctx);
  const lean = t.role === "connector" ? `translate(128 150) scale(1.08) rotate(${tilt}) translate(-128 -150)` : `rotate(${tilt} 128 150)`;
  const head = path(HEAD[t.role], `url(#${id}-skin)`, 7);
  const body = `<g transform="${lean}">${ch.behind}${head}${ch.front}</g>${ch.over}`;
  return [
    svgOpen("deepfried", rarityTier(t.memory_depth), mood),
    defsBlock(id, pal, mood, seed),
    `<g id="background"><g filter="url(#${id}-bgfry)">${backgroundLayer(t, pal, mood, seed, id)}</g></g>`,
    `<g id="rings"><g filter="url(#${id}-fry)">${ringsLayer(t, pal, seed)}</g></g>`,
    `<g id="glyph"><g filter="url(#${id}-fry)">${glyphLayer(t.role, mood, pal, id)}</g></g>`,
    `<g id="face"><g filter="url(#${id}-fry)">${body}</g></g>`,
    `</svg>`,
  ].join("\n") + "\n";
}

export const style = Object.freeze({
  name: "deepfried",
  title: "Deep-Fried Reaction",
  description:
    "Crude, bold, MS-Paint-confident cartoon heads on a blown-out zoom-line background, then deep-fried on purpose: over-saturated, posterized, grainy, bloomed, with lens flares and laser eyes when the mood calls for it.",
  render,
});

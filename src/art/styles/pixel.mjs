// "8-bit Reaction PFP": chunky 32x32 pixel-art heads, 8px per logical pixel.
//
// Every layer is a 32x32 buffer of palette characters ('.' is transparent) that
// is turned into run-length merged <rect>s grouped by colour. Characters are
// defined in PAL (shared) and TEMPERAMENTS (per palette).
//
// Trait mapping:
//   temperament -> palette        role -> character, props and eye acting
//   risk        -> background     voice -> the mouth baseline
//   memory_depth -> a row of XP pips (the only elements with data-ring)
// mood overrides the acting: eyes, brows, props and the mouth variant.

import { assertTraits, assertMood, rarityTier, svgOpen } from "./shared.mjs";

const N = 32;
const PX = 8;

/** Colours shared by every temperament. */
const PAL = {
  w: "#ffffff",
  r: "#e63946",
  d: "#6b0f1f",
  g: "#ffd23f",
  h: "#b87800",
  y: "#ff7aa8",
  p: "#ff9db8",
  u: "#4cc3ff",
  n: "#bfe6ff",
  o: "#ff8a1f",
  m: "#2a2a3a",
  q: "#aab0bc",
  e: "#ffe2c6",
  f: "#dca77c",
};

/** Per temperament: k outline, a/b/c skin light/mid/dark, X/Y background, S shadow, L pattern, A/B/C accents. */
const TEMPERAMENTS = {
  cool: { k: "#10162b", a: "#d4e0ee", b: "#a6b8cf", c: "#7189a9", X: "#27385a", Y: "#3b5688", S: "#16213a", L: "#5f80b8", A: "#4aa3ff", B: "#e6f0fb", C: "#8fe3ff" },
  neon: { k: "#14002a", a: "#d4ff6a", b: "#8ff000", c: "#3fb300", X: "#2b0a52", Y: "#5a118f", S: "#17002e", L: "#8a24d6", A: "#ff2bd6", B: "#1ff0ff", C: "#fff23a" },
  warm: { k: "#3a1405", a: "#ffd08a", b: "#f59a2b", c: "#c4601a", X: "#ffcf8f", Y: "#ff9a5c", S: "#d9763a", L: "#fff0c4", A: "#e63b2e", B: "#fff1c9", C: "#ffd23f" },
  muted: { k: "#1f1a10", a: "#c4d1a4", b: "#97ab76", c: "#697e4f", X: "#6f6048", Y: "#8a7757", S: "#463c2b", L: "#b3a37a", A: "#b5473a", B: "#ddd3ac", C: "#8c9c5e" },
};

// ---------------------------------------------------------------- buffers

const blank = () => Array.from({ length: N }, () => Array(N).fill("."));
const inb = (x, y) => x >= 0 && x < N && y >= 0 && y < N;
const put = (b, x, y, c) => {
  if (c !== "." && inb(x, y)) b[y][x] = c;
};
const get = (b, x, y) => (inb(x, y) ? b[y][x] : ".");
const stamp = (b, x0, y0, rows) =>
  rows.forEach((row, j) => [...row].forEach((ch, i) => (ch === "." || ch === " " ? 0 : put(b, x0 + i, y0 + j, ch))));
const flip = (rows) => rows.map((r) => [...r].reverse().join(""));
const paint = (dst, src) => src.forEach((row, y) => row.forEach((c, x) => put(dst, x, y, c)));
const rect = (b, x, y, w, h, c) => {
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) put(b, x + i, y + j, c);
};
const disc = (b, cx, cy, r, c) => {
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(b, x, y, c);
};

/** 4-neighbour outline around the outside of every non-transparent, non-outline pixel (holes stay open). */
function halo(b, c = "k") {
  const outside = Array.from({ length: N }, () => Array(N).fill(false));
  const stack = [];
  for (let i = 0; i < N; i++) stack.push([i, 0], [i, N - 1], [0, i], [N - 1, i]);
  while (stack.length) {
    const [x, y] = stack.pop();
    if (!inb(x, y) || outside[y][x] || b[y][x] !== ".") continue;
    outside[y][x] = true;
    stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  const out = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!outside[y][x]) continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => ![".", "k"].includes(get(b, x + dx, y + dy)))) out.push([x, y]);
    }
  }
  for (const [x, y] of out) b[y][x] = c;
  return b;
}

/** Draw into a scratch buffer, outline it, return it for overlaying. */
function prop(draw) {
  const b = blank();
  draw(b);
  return halo(b);
}

/** Thick (2x2 brush) line, colours cycle through `cols` every `every` steps. */
function line(b, pts, cols, every = 3, size = 2) {
  let step = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const [x0, y0] = pts[s];
    const [x1, y1] = pts[s + 1];
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
    for (let i = 0; i <= n; i++) {
      const x = x0 + Math.round(((x1 - x0) * i) / (n || 1));
      const y = y0 + Math.round(((y1 - y0) * i) / (n || 1));
      const c = cols[Math.floor(step++ / every) % cols.length];
      rect(b, x, y, size, size, c);
    }
  }
}

// ----------------------------------------------------------------- output

function runs(b) {
  const out = [];
  let open = new Map();
  for (let y = 0; y < N; y++) {
    const next = new Map();
    let x = 0;
    while (x < N) {
      const c = b[y][x];
      let w = 1;
      while (x + w < N && b[y][x + w] === c) w++;
      if (c !== ".") {
        const key = `${x}|${w}|${c}`;
        const r = open.get(key) ?? (out.push({ x, y, w, h: 0, c }), out[out.length - 1]);
        r.h++;
        next.set(key, r);
      }
      x += w;
    }
    open = next;
  }
  return out;
}

function layerSvg(id, b, pal, extra = "") {
  const groups = new Map();
  for (const r of runs(b)) {
    if (!groups.has(r.c)) groups.set(r.c, []);
    groups.get(r.c).push(`<rect x="${r.x * PX}" y="${r.y * PX}" width="${r.w * PX}" height="${r.h * PX}"/>`);
  }
  const body = [...groups].map(([c, rs]) => `<g fill="${pal[c]}">${rs.join("")}</g>`).join("");
  return `<g id="${id}"><g shape-rendering="crispEdges">${body}${extra}</g></g>`;
}

// ------------------------------------------------------------- background

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];

function background(risk, comp) {
  const b = blank();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const t = ((y - 10) / 12) * 16;
      b[y][x] = BAYER[y % 4][x % 4] < t ? "Y" : "X";
    }
  }
  if (risk === "low") {
    for (const [x, y] of [[3, 3], [27, 5], [2, 14], [29, 13], [4, 24], [26, 20], [22, 1], [9, 1], [30, 27], [1, 29]]) put(b, x, y, "L");
  } else if (risk === "high") {
    for (const base of [1, 11, 21]) {
      for (let x = 0; x < N; x++) put(b, x, base + (x % 4 < 2 ? x % 2 : 3 - (x % 4)), "L");
    }
  } else if (risk === "mid") {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const d = Math.hypot(x - 15.5, y - 15.5);
        for (const r of [14, 18, 22]) if (Math.abs(d - r) < 0.55) put(b, x, y, "L");
      }
    }
  } else {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (x % 4 === 0 || y % 4 === 0) put(b, x, y, "L");
  }
  // 1px drop shadow of everything drawn in glyph + face
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (comp[y][x] !== "." && get(b, x + 1, y + 1) !== "S") put(b, x + 1, y + 1, "S");
  return b;
}

// ------------------------------------------------------------------ rings

function ringsLayer(depth, pal) {
  const b = blank();
  rect(b, 3, 28, 26, 4, "k");
  rect(b, 4, 29, 24, 2, "m");
  const pips = [];
  for (let i = 0; i < depth; i++) {
    const c = pal[i % 2 ? "h" : "g"];
    pips.push(`<rect data-ring="${i}" x="${(4 + 2 * i) * PX}" y="${29 * PX}" width="${2 * PX}" height="${2 * PX}" fill="${c}"/>`);
  }
  return { b, pips: pips.join("") };
}

// ------------------------------------------------------------------ head

const CX = 16;
const CY = 16;
const RX = 10.5;
const RY = 10.8;
const inHead = (x, y) => ((x + 0.5 - CX) / RX) ** 2 + ((y + 0.5 - CY) / RY) ** 2 <= 1;

function headFill(glyph) {
  const b = blank();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!inHead(x, y) || glyph[y][x] !== ".") continue;
      let c = "b";
      if (!inHead(x - 1, y) || !inHead(x, y - 1)) c = "a";
      else if (!inHead(x + 1, y) || !inHead(x, y + 1)) c = "c";
      else if ((!inHead(x + 2, y) || !inHead(x, y + 2)) && (x + y) % 2 === 0) c = "c";
      b[y][x] = c;
    }
  }
  return b;
}

function outlineHead(face, glyph) {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (face[y][x] !== "." || glyph[y][x] !== ".") continue;
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => get(face, x + dx, y + dy) !== "." && get(face, x + dx, y + dy) !== "k")) face[y][x] = "k";
    }
  }
}

// ------------------------------------------------------------------ mouths

const M = {
  flat: { y: 22, rows: ["kkkkkkkk"] },
  smirkTiny: { y: 21, rows: ["...kk", "kkk.."] },
  smug: { y: 21, rows: [".....kk", "kkkkk.."] },
  smugSmile: { y: 21, rows: ["k......k", ".kkkkkk."] },
  frown: { y: 21, rows: ["..kkkk..", ".k....k.", "k......k"] },
  grin: { y: 20, rows: ["kkkkkkkkkk", "kwwkwwkwwk", "kwwkwwkwwk", ".kkkyykkk.", "....kyyk..", "....kyyk.."] },
  scream: { y: 19, rows: ["kkkkkkkkkk", "kwwwwwwwwk", "kddddddddk", "kdddyydddk", ".kddyyddk.", "..kkkkkk.."] },
  evil: { y: 20, rows: ["k..........k", "kkkkkkkkkkkk", ".kwwkwwkwwk.", "..kkkkkkkk.."] },
  smile: { y: 20, rows: ["kkkkkkkkkk", "kwwwwwwwwk", ".kwwwwwwk.", "..kkkkkk.."] },
  bigD: { y: 19, rows: ["kkkkkkkkkkkk", "kwwwwwwwwwwk", "kwwwwwwwwwwk", ".kyyyyyyyyk.", "..kkyyyykk..", "....kkkk...."] },
  forced: { y: 21, rows: ["kkkkkkkkkkkk", "kwwkwwkwwkwk", "kkkkkkkkkkkk"] },
  tinyO: { y: 21, rows: [".kk.", "kddk", ".kk."] },
  wobbly: { y: 21, rows: ["kk..kk..kk", "..kk..kk.."] },
  gape: { y: 20, rows: [".kkkk.", "kddddk", "kddddk", "kddddk", ".kkkk."] },
};

const T = {
  flat: { y: 21, rows: ["kkkkkkkk", "kkkkkkkk"] },
  smirkTiny: { y: 20, rows: ["......kk", "kkkkkkk.", "kkk....."] },
  smug: { y: 21, rows: [".......kk", "kkkkkkkk.", "kkk......"] },
  smugSmile: { y: 20, rows: ["k......k", "kk....kk", ".kkkkkk."] },
  frown: { y: 20, rows: [".kkkkkk.", "kk....kk", "k......k"] },
  grin: { y: 19, rows: ["kkkkkkkkkkkk", "kwwkwwkwwkwk", "kwwkwwkwwkwk", ".kkkkyyykkk.", "......kyyk..", "......kyyk.."] },
  evil: { y: 19, rows: ["kk..........kk", ".kkkkkkkkkkkk.", "kwwwwwwwwwwwwk", ".kwkwkwkwkwk..", "..kkkkkkkkkk.."] },
};
const THICK = { dry: { neutral: T.flat, hype: T.smirkTiny }, flat: { neutral: T.smug, hype: T.smugSmile, shade: T.frown }, loud: { neutral: T.grin, shook: T.grin, shade: T.evil } };

const MOUTHS = {
  neutral: { dry: M.flat, loud: M.grin, open: M.smile, flat: M.smug },
  hype: { dry: M.smirkTiny, loud: M.scream, open: M.bigD, flat: M.smugSmile },
  shade: { dry: M.flat, loud: M.evil, open: M.forced, flat: M.frown },
  shook: { dry: M.tinyO, loud: M.grin, open: M.wobbly, flat: M.gape },
};

/** Social keeps the original mouths; every other role gets the thicker ones. */
function mouthFor(role, mood, voice) {
  return (role !== "connector" && THICK[voice]?.[mood]) || MOUTHS[mood][voice];
}

// ------------------------------------------------------------------- eyes

const SPARK = (b, x, y, c = "w") => {
  put(b, x, y, c);
  put(b, x - 1, y, c);
  put(b, x + 1, y, c);
  put(b, x, y - 1, c);
  put(b, x, y + 1, c);
};

// Each role/mood draws into `f` (features on the head) and `ov` (props over the head).
const ACT = {
  observer(mood, f, ov) {
    // half-lidded: flat thick lid line, white eye below it, pupils sitting low
    const lid = ["kkkkkk", "cccccc", "wwwwww", "wwkkww", "wwkkww", ".kkkk."];
    const monocle = (b, x, y) =>
      stamp(b, x, y, ["..gggg..", ".g....g.", "g......g", "g......g", "g......g", "g......g", ".g....h.", "..hhhh.."]);
    if (mood === "neutral") {
      stamp(f, 8, 12, lid);
      stamp(f, 18, 12, lid);
      overlayProp(ov, (b) => {
        monocle(b, 17, 11);
        for (const [x, y] of [[21, 19], [22, 20], [22, 21], [23, 22], [23, 23], [24, 24]]) put(b, x, y, "h");
      });
    } else if (mood === "hype") {
      const e = ["kkkkkk", "wwwwww", "wwkkww", "wwkkww", ".kkkk."];
      stamp(f, 8, 12, e);
      stamp(f, 18, 12, lid);
      stamp(f, 8, 9, [".kkkk.", "kk..kk"]);
      overlayProp(ov, (b) => monocle(b, 17, 11));
      SPARK(ov, 3, 9, "C");
    } else if (mood === "shade") {
      const e = ["kkkkk", "ccccc", "wwwkk", "wwwkk", "kkkkk"];
      stamp(f, 9, 12, e);
      stamp(f, 18, 12, e);
      stamp(f, 9, 11, ["kkkkk"]);
      stamp(f, 18, 11, ["kkkkk"]);
      overlayProp(ov, (b) => monocle(b, 17, 11));
      // teacup over the mouth, steam rising
      const cup = prop((b) => {
        stamp(b, 11, 21, ["wwwwwww..", "wAAAAAw.w", "wwwwwww.w", ".wwwww.w.", ".wwwww..."]);
        stamp(b, 9, 26, ["wwwwwwwwwwww"]);
      });
      paint(ov, cup);
      for (const [x, y] of [[13, 19], [14, 18], [13, 17], [14, 16]]) put(ov, x, y, "w");
      for (const [x, y] of [[16, 19], [17, 18], [16, 17]]) put(ov, x, y, "w");
    } else {
      const e = [".kkk.", "kwwwk", "kwkwk", "kwwwk", ".kkk."];
      stamp(f, 9, 11, e);
      stamp(f, 18, 11, e);
      stamp(f, 8, 8, ["..kkk"]);
      stamp(f, 18, 8, ["kkk.."]);
      // the monocle pops off, mid-air, with a falling chain
      const fly = prop((b) => {
        monocle(b, 23, 2);
        for (const [x, y] of [[25, 10], [25, 11], [24, 12], [24, 13]]) put(b, x, y, "h");
      });
      paint(ov, fly);
      stamp(ov, 20, 1, ["w", ".w"]);
      stamp(ov, 20, 6, ["w."]);
      stamp(ov, 21, 4, ["w"]);
    }
  },

  trickster(mood, f, ov) {
    if (mood === "neutral") {
      // one HUGE eye, one tiny dot eye lower down, scowling brow over the dot
      stamp(f, 7, 11, [".kkkkk.", "kwwwwwk", "kwwwwwk", "kwwwwwk", "kwkkwwk", "kwkkwwk", ".kkkkk."]);
      stamp(f, 20, 16, ["kk", "kk"]);
      stamp(f, 18, 13, ["...kkk", "kkkkk."]);
    } else if (mood === "hype") {
      // laser eyes
      const eye = [".kkkk.", "krrrrk", "krwwrk", ".kkkk."];
      stamp(f, 8, 12, eye);
      stamp(f, 18, 12, eye);
      for (const [x0, x1] of [[0, 8], [24, 32]]) {
        rect(ov, x0, 12, x1 - x0, 1, "o");
        rect(ov, x0, 13, x1 - x0, 2, "C");
        rect(ov, x0, 15, x1 - x0, 1, "o");
      }
      for (const x of [2, 5, 26, 29]) {
        put(ov, x, 11, "r");
        put(ov, x, 16, "r");
      }
    } else if (mood === "shade") {
      // furrowed V brows over narrow red slits
      const brow = ["kkk...", "kkkk..", ".kkkk.", "..kkkk"];
      stamp(f, 8, 11, brow);
      stamp(f, 18, 11, flip(brow));
      const slit = ["kkkkkk", "wrrrrw", ".kkkk."];
      stamp(f, 8, 15, slit);
      stamp(f, 18, 15, slit);
    } else {
      const sp = [".wwwww.", "wkkkkkk", "wkwwwww", "wkwkkkw", "wkwwwkw", "wkkkkkw", ".wwwww."];
      stamp(f, 7, 11, sp);
      stamp(f, 18, 11, flip(sp));
      // sweat flying off
      for (const [x, y] of [[1, 12], [2, 15], [29, 12], [28, 16], [30, 19]]) {
        put(ov, x, y, "u");
        put(ov, x, y + 1, "u");
        put(ov, x + (x < 16 ? -1 : 1), y + 2, "n");
      }
    }
  },

  connector(mood, f, ov) {
    const big = [".kkkk.", "kwwkkk", "kwwkkk", "kkkkwk", "kkkkkk", ".kkkk."];
    const heart = [".r.r.", "rrrrr", "rrrrr", ".rrr.", "..r.."];
    // speech bubble: 9px wide body, content stamped inside, tail toward the head
    const bubble = (x, y, h, content, tailRight = false) =>
      paint(ov, prop((p) => {
        rect(p, x, y, 9, h, "w");
        stamp(p, tailRight ? x + 6 : x + 1, y + h, ["ww", "w."]);
        stamp(p, x + 2, y + 1, content);
      }));
    if (mood === "neutral") {
      stamp(f, 8, 11, big);
      stamp(f, 18, 11, big);
      for (const x of [9, 10, 21, 22]) put(f, x, 18, "p");
      SPARK(f, 6, 10, "w");
      bubble(22, 2, 5, [".....", "k.k.k"]);
    } else if (mood === "hype") {
      for (const x of [8, 19]) {
        paint(f, prop((p) => stamp(p, x, 11, heart)));
        put(f, x + 1, 12, "w");
      }
      bubble(22, 2, 6, [".r.r.", "rrrrr", ".rrr.", "..r.."]);
      bubble(1, 1, 7, [".k.k.", ".k.k.", ".k.k.", ".....", ".k.k."], true);
    } else if (mood === "shade") {
      const e = [".kkkk.", "kwwwwk", "kwwkwk", "kwwwwk", ".kkkk."];
      stamp(f, 8, 12, e);
      stamp(f, 18, 12, e);
      stamp(f, 8, 10, ["kk....", ".kkkk."]);
      stamp(f, 18, 10, flip(["kk....", ".kkkk."]));
      bubble(22, 2, 5, [".....", "k.k.k"]);
      paint(ov, prop((p) => stamp(p, 23, 9, [".u.", ".u.", "uuu", "uwu", "uuu", ".u."])));
    } else {
      const wet = [".kkkk.", "kwwkwk", "kwwkkk", "kkkkkk", "kuuuuk", ".kkkk."];
      stamp(f, 8, 11, wet);
      stamp(f, 18, 11, wet);
      for (const x of [8, 9, 22, 23]) for (const y of [17, 19, 20]) put(f, x, y, "u");
      stamp(f, 8, 9, ["..kkk"]);
      stamp(f, 8, 8, ["kk"]);
      stamp(f, 18, 9, flip(["..kkk"]));
      stamp(f, 22, 8, ["kk"]);
      bubble(22, 1, 7, [".kkk.", "...k.", "..kk.", ".....", "..k.."]);
    }
  },

  auditor(mood, f, ov) {
    // thick-rimmed lenses with a white glare that hides the eyes
    const lens = (x, y, cracked = false) => {
      stamp(f, x, y, ["kkkkkkk", "kkkkkkk", "kwwwwwk", "kwwwwwk", "kwwwwwk", "kwwwwwk", "kkkkkkk"]);
      if (cracked) {
        stamp(f, x + 1, y + 2, ["wwwwk", "wwwkw", "wwkww", "wkwww"]);
      } else {
        stamp(f, x + 1, y + 3, ["wwnnw", "wnnww", "nnwww"]);
      }
    };
    const glasses = (dyL = 0, dyR = 0, cracked = false) => {
      lens(7, 12 + dyL, cracked);
      lens(18, 12 + dyR, cracked);
      if (dyL === dyR) stamp(f, 14, 13, ["kkkk", "kkkk"]);
      else stamp(f, 14, 14, ["kk", ".kk", "..kk"].map((r) => r.padEnd(4, ".")));
    };
    const FIST = [".eeeeeef", "eeeeeeef", "efeefeef", "eeeeeeef", ".eeeeeff", "..ffff.."];
    // one index finger straight up from a fist at the lower right; `bent` hooks the top knuckle over
    const hand = (x, y, bent = false) =>
      paint(ov, prop((p) => {
        stamp(p, x, y + 9, FIST);
        stamp(p, x + 4, y + 2, ["ef", "ef", "ef", "ef", "ef", "ef", "ef"]);
        if (bent) stamp(p, x + 1, y, ["eeeee.", "eeeeef"]);
        else stamp(p, x + 4, y, ["ee", "ef"]);
      }));
    const dings = () => {
      for (const [x, y] of [[27, 7], [26, 6], [28, 5], [28, 4], [30, 7], [31, 6]]) put(ov, x, y, "C");
    };
    if (mood === "neutral") {
      glasses();
      stamp(f, 10, 7, [".kkkk.", "kk..kk"]);
      stamp(f, 18, 9, ["kkkkkkk", "kkkkkkk"]);
      hand(24, 9);
      dings();
    } else if (mood === "hype") {
      glasses();
      // closed smug ^^ eyes above the glasses
      stamp(f, 8, 9, [".kkkk.", "kk..kk"]);
      stamp(f, 18, 9, [".kkkk.", "kk..kk"]);
      // the finger pushes the glasses up at the frame
      paint(ov, prop((p) => {
        stamp(p, 25, 14, ["eeeee", "eeeee", "ffffe"]);
        stamp(p, 28, 12, ["eeee", "eeef", "efef", "eeef", "eeef", "eeff", ".fff"]);
      }));
      SPARK(ov, 12, 15, "w");
      SPARK(ov, 3, 10, "C");
    } else if (mood === "shade") {
      glasses();
      stamp(f, 18, 9, [".....kk", "kkkkkk."]);
      stamp(f, 7, 9, flip([".....kk", "kkkkkk."]));
      hand(24, 9);
      // magnifier blows one eye up
      const mag = blank();
      disc(mag, 11, 15, 5, "h");
      disc(mag, 11, 15, 4, "w");
      stamp(mag, 7, 13, ["kkkkkkkkk", "ccccccccc", "wwwkkkwww", "wwwkkkwww", "wwwwkwwww"]);
      put(mag, 8, 17, "n");
      put(mag, 9, 18, "n");
      paint(ov, halo(mag));
      line(ov, [[7, 20], [3, 26]], ["h"], 3);
      paint(ov, halo(ov));
    } else {
      glasses(1, -1, true);
      stamp(f, 9, 8, ["kkkkk", "kkkkk"]);
      stamp(f, 18, 8, ["kkkkk", "kkkkk"]);
      // finger still up, bent over at the top knuckle
      hand(24, 9, true);
      for (const [x, y] of [[7, 20], [5, 22], [26, 9]]) put(ov, x, y, "n");
    }
  },
};

function overlayProp(ov, draw) {
  paint(ov, prop(draw));
}

// ----------------------------------------------------------------- glyphs

/** A floppy horn: solid blocks [x, y, w, h, colour] alternating A/B, then a gold bell at (bx, by). */
function horn(gl, blocks, bx, by) {
  for (const [x, y, w, h, c] of blocks) rect(gl, x, y, w, h, c);
  rect(gl, bx, by, 3, 3, "g");
  put(gl, bx, by + 2, "h");
  put(gl, bx + 2, by + 2, "h");
  put(gl, bx + 1, by + 1, "w");
}

function glyph(role, mood, gl) {
  if (role === "trickster") {
    // jester cap over the top quarter: solid blocks of two colours, brim, three horns with gold bells
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (inHead(x, y) && y <= 8) gl[y][x] = "B";
    let lo = N;
    let hi = -1;
    for (let x = 0; x < N; x++) if (inHead(x, 9)) (lo = Math.min(lo, x)), (hi = Math.max(hi, x));
    rect(gl, lo - 1, 9, hi - lo + 3, 1, "C");
    horn(gl, [[8, 5, 4, 3, "A"], [5, 3, 4, 3, "B"], [2, 4, 3, 3, "A"], [1, 7, 3, 3, "B"]], 1, 10);
    horn(gl, [[20, 5, 4, 3, "A"], [23, 3, 4, 3, "B"], [27, 4, 3, 3, "A"], [28, 7, 3, 3, "B"]], 28, 10);
    horn(gl, [[14, 3, 4, 3, "A"], [15, 0, 4, 3, "B"]], 19, 0);
  } else if (role === "connector") {
    rect(gl, 15, 3, 2, 3, "q");
    stamp(gl, 14, 0, [".rr.", "rwrr", "rrrr", ".rr."]);
  }
  return halo(gl);
}

// ------------------------------------------------------------------ render

function renderPixel(traits, mood) {
  const pal = { ...PAL, ...TEMPERAMENTS[traits.temperament] };
  const gl = glyph(traits.role, mood, blank());
  const face = headFill(gl);
  const feat = blank();
  const ov = blank();
  const m = mouthFor(traits.role, mood, traits.voice);
  const skipMouth = traits.role === "observer" && mood === "shade";
  if (!skipMouth) stamp(feat, CX - Math.floor(m.rows[0].length / 2), m.y, m.rows);
  put(feat, 15, 18, "c");
  put(feat, 16, 18, "c");
  ACT[traits.role](mood, feat, ov);
  outlineHead(face, gl);
  paint(face, feat);
  paint(face, ov);
  const comp = blank();
  paint(comp, gl);
  paint(comp, face);
  const bg = background(traits.risk, comp);
  const rings = ringsLayer(traits.memory_depth, pal);
  return [
    layerSvg("background", bg, pal),
    layerSvg("rings", rings.b, pal, rings.pips),
    layerSvg("glyph", gl, pal),
    layerSvg("face", face, pal),
  ].join("");
}

export const style = {
  name: "pixel",
  title: "8-bit Reaction PFP",
  description:
    "Chunky 32x32 pixel-art pfp: big head, one-pixel outline, dithered background, and a joke per agent that survives downscaling to 48px.",
  /**
   * @param {import("../../traits/validate.mjs").Traits} traits
   * @param {{ mood?: string }} [opts]
   */
  render(traits, { mood } = {}) {
    const t = assertTraits(traits);
    const mo = assertMood(mood);
    return `${svgOpen("pixel", rarityTier(t.memory_depth), mo)}${renderPixel(t, mo)}</svg>\n`;
  },
};

// Adversarial: every model-produced string (posts, sheets) is hostile. It goes
// through the real pipeline (runDemo -> renderDemoPage, renderViewer, the
// written SVGs) and the output must contain no live markup, handler, script,
// external fetch or javascript: URL. Escaping happens once, at the HTML boundary.
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createMockClient } from "../inference/client.mjs";
import { AGENTS } from "../traits/agents.mjs";
import { renderViewer, escapeHtml } from "../viewer/render.mjs";
import { renderDemoPage } from "./page.mjs";
import { runDemo } from "./pipeline.mjs";

const PAYLOADS = [
  `</script><script>alert(1)</script>`,
  `"><img src=x onerror=alert(1)>`,
  `' onmouseover='alert(1)' x='`,
  `<a href="javascript:alert(1)">x</a>`,
  `</style><style>*{background:url(https://evil.example/x)}</style>`,
  `]]></svg><svg onload=alert(1)>`,
  `<![CDATA[ <script>alert(1)</script> ]]>`,
  `<!-- --><iframe src=//evil.example></iframe>`,
  `&lt;script&gt; &amp;lt; &#60;script&#62; &#x3c;`,
  `‮⁦⁩​\u0000\u0007<b>bold</b>\u001b[31m`,
  `<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><use href="https://evil.example/x.svg#a"/></svg>`,
  `<meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example/">`,
  `A`.repeat(200_000),
];

const BIDI_OR_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

// In escaped output a "<" only ever starts markup we wrote, so the tags of a page are
// exactly its regex matches. Text such as "onerror=" or "javascript:" may appear
// inside text nodes (escaped, visible, inert); it must never appear in a tag.
const tagsOf = (html) => html.match(/<[^>]*>/g) ?? [];
// The same tags with quoted attribute values blanked: escaped model text in alt/aria-label is inert,
// so keyword checks (on*=, src=, javascript:) look at names and structure only.
const shellOf = (tag) => tag.replace(/="[^"]*"/g, '=""');
const tagNames = (html) => new Set(tagsOf(html).map((t) => /^<\/?([A-Za-z0-9]+|!doctype)/i.exec(t)?.[1].toLowerCase() ?? t));
const attrNames = (html) => new Set(tagsOf(html).map(shellOf).flatMap((t) => [...t.matchAll(/\s([A-Za-z:-]+)(?==)/g)].map((m) => m[1].toLowerCase())));

// Page-wide: no tag, attribute or URL beyond what the benign page has; nothing remote or runnable.
function assertInertPage(html, baseline, label) {
  const newTags = [...tagNames(html)].filter((n) => !tagNames(baseline).has(n));
  assert.deepEqual(newTags, [], `${label}: injected tag names`);
  const newAttrs = [...attrNames(html)].filter((n) => !attrNames(baseline).has(n));
  assert.deepEqual(newAttrs, [], `${label}: injected attributes`);
  assert.equal(tagsOf(html).length, tagsOf(baseline).length, `${label}: tag count changed, markup was injected`);
  const tags = tagsOf(html).map(shellOf).join("\n");
  assert.doesNotMatch(tags, /\son[a-z]+\s*=/i, `${label}: event handler`);
  assert.doesNotMatch(tags, /javascript:|data:text\/html|vbscript:/i, `${label}: script URL`);
  assert.doesNotMatch(tags, /\b(?:srcset|action|formaction|poster|xlink:href)\s*=/i, `${label}: fetching attribute`);
  // src is allowed only on <img>, and only as a relative path to a file the demo wrote.
  for (const t of tagsOf(html)) {
    for (const m of t.matchAll(/\ssrc\s*=\s*"([^"]*)"/gi)) {
      assert.match(t, /^<img\b/i, `${label}: src on a non-img tag`);
      assert.match(m[1], /^[A-Za-z0-9_./-]+$/, `${label}: img src ${m[1]}`);
    }
    assert.doesNotMatch(shellOf(t), /\ssrc\s*=\s*[^"\s]/i, `${label}: unquoted src`);
  }
  assert.doesNotMatch(html.match(/<style\b[^>]*>[\s\S]*?<\/style>/i)[0], /url\(|@import|https?:/i, `${label}: css fetch`);
  assert.equal((html.match(/<style\b/gi) ?? []).length, 1, `${label}: one style block`);
  // http(s) only as the SVG namespace identifier or the explorer host text.
  const rest = tags.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "");
  assert.doesNotMatch(rest, /https?:\/\//i, `${label}: external URL in a tag`);
  assert.doesNotMatch(html, BIDI_OR_CONTROL, `${label}: bidi/control char reached the page`);
  for (const m of html.matchAll(/<a\b[^>]*\bhref="([^"]*)"/gi)) assert.match(m[1], /^[A-Za-z0-9_./-]+$/, `${label}: href ${m[1]}`);
}

function hostileClients(payload) {
  // Swarm posts and sheets are both the payload (sheets get word-clamped, so keep it word-shaped too).
  return {
    swarmClient: createMockClient({ responder: () => payload }),
    sheetClient: createMockClient({ responder: () => `${payload} ${payload.slice(0, 300)}` }),
  };
}

const benign = mkdtemp(join(tmpdir(), "near-esc-base-")).then(async (dir) => {
  await runDemo({ outDir: dir, rounds: 3, seed: 1, every: 3 });
  const page = await readFile(join(dir, "index.html"), "utf8");
  const viewer = renderViewer(JSON.parse(await readFile(join(dir, "events.json"), "utf8")));
  await rm(dir, { recursive: true, force: true });
  return { page, viewer };
});

for (const [i, payload] of PAYLOADS.entries()) {
  test(`runDemo -> page, viewer and SVGs stay inert for hostile model text #${i}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "near-esc-demo-"));
    try {
      const run = await runDemo({ outDir: dir, rounds: 3, seed: 1, every: 3, ...hostileClients(payload) });
      const page = await readFile(join(dir, "index.html"), "utf8");
      assertInertPage(page, (await benign).page, "demo page");

      // The viewer over the same events, with the canonical agents.
      const events = JSON.parse(await readFile(join(dir, "events.json"), "utf8"));
      const viewer = renderViewer(events);
      assertInertPage(viewer, (await benign).viewer, "viewer");

      // Plain text files are not HTML, but must still be exactly the model text (no escaping applied).
      const transcript = await readFile(join(dir, "transcript.txt"), "utf8");
      assert.ok(transcript.includes(payload.slice(0, 100)), "transcript keeps raw text");

      // Written SVGs: only our renderer's markup. Art and faces carry no text at all;
      // share cards carry the (hostile) post text, so they may add <text>/<tspan> and
      // nested <svg>, and nothing else beyond the tags and attributes the art uses.
      const svgFiles = run.files.filter((f) => f.endsWith(".svg"));
      const shareFiles = svgFiles.filter((f) => f.startsWith("share/"));
      const artFiles = svgFiles.filter((f) => !f.startsWith("share/"));
      const memeCount = (run.manifest.memes ?? []).length;
      assert.equal(shareFiles.length, run.manifest.shares.length + memeCount);
      // per agent: signature, mint and one face per mood; plus one share card per manifest share.
      assert.equal(svgFiles.length, AGENTS.length * (2 + run.manifest.moods.length) + run.manifest.shares.length + memeCount);
      const artTags = new Set();
      const artAttrs = new Set();
      for (const f of artFiles) {
        const svg = await readFile(join(dir, f), "utf8");
        assert.doesNotMatch(svg, /<script|<foreignObject|<text|<style|<image|<use|<a[\s>]|<!\[CDATA\[|\]\]>|<!--/i, f);
        assert.doesNotMatch(svg, /<[^>]*\s(?:on[a-z]+|href|xlink:href)\s*=/i, f);
        assert.doesNotMatch(svg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, ""), /https?:|javascript:|url\(\s*['"]?[^#\s'")]/i, f);
        assert.ok(!svg.includes("evil.example") && !svg.includes("alert"), f);
        for (const n of tagNames(svg)) artTags.add(n);
        for (const n of attrNames(svg)) artAttrs.add(n);
      }
      for (const f of shareFiles) {
        const svg = await readFile(join(dir, f), "utf8");
        assert.doesNotMatch(svg, /<script|<foreignObject|<style|<image|<use|<a[\s>]|<!\[CDATA\[|\]\]>|<!--|<iframe|<meta|<base/i, f);
        // Quoted attribute values (aria-label carries escaped model text) are inert; check names only.
        const shell = svg.replace(/="[^"]*"/g, '=""');
        assert.doesNotMatch(shell, /<[^>]*\s(?:on[a-z]+|href|xlink:href|src)\s*=/i, f);
        // Escaped text nodes may show "https:" or "javascript:" as visible words; tags never may.
        assert.doesNotMatch(tagsOf(shell).join("\n").replace(/xmlns=""/g, ""), /https?:|javascript:|url\(/i, f);
        assert.doesNotMatch(svg, BIDI_OR_CONTROL, `${f}: bidi/control char`);
        const extraTags = [...tagNames(shell)].filter((n) => !artTags.has(n) && !["text", "tspan", "rect", "title"].includes(n));
        assert.deepEqual(extraTags, [], `${f}: injected tag names`);
        const extraAttrs = [...attrNames(shell)].filter((n) => !artAttrs.has(n) && !["x", "y", "font-family", "font-size", "font-weight", "fill", "rx", "width", "height", "viewbox", "role", "aria-label", "data-mood", "stroke", "stroke-width", "text-anchor", "data-format", "paint-order", "stroke-linejoin", "fill-opacity", "preserveaspectratio"].includes(n));
        assert.deepEqual(extraAttrs, [], `${f}: injected attributes`);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("the page shows hostile text once-escaped, never double-escaped and never raw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "near-esc-demo-"));
  try {
    const payload = `Tom & "Jerry" <b>x</b> it's`;
    await runDemo({ outDir: dir, rounds: 3, every: 3, ...hostileClients(payload) });
    const page = await readFile(join(dir, "index.html"), "utf8");
    assert.ok(page.includes(`Tom &amp; &quot;Jerry&quot; &lt;b&gt;x&lt;/b&gt; it&#39;s`));
    assert.ok(!page.includes("&amp;amp;") && !page.includes("&amp;quot;") && !page.includes("&amp;lt;"));
    assert.ok(!page.includes("<b>x</b>"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a very long hostile string does not grow the sheet past its clamp, and the page stays well formed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "near-esc-demo-"));
  try {
    const run = await runDemo({ outDir: dir, rounds: 3, every: 3, ...hostileClients("<".repeat(100_000)) });
    for (const a of run.manifest.agents) for (const s of a.sheets) assert.ok(s.sheet.length <= 100_000 * 2 + 1000);
    const page = await readFile(join(dir, "index.html"), "utf8");
    assert.doesNotMatch(page, /<{2}/);
    assert.equal((page.match(/<main>/g) ?? []).length, 1);
    assert.equal((page.match(/<\/main>/g) ?? []).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("hostile agent ids cannot reach file paths or hrefs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "near-esc-demo-"));
  try {
    const run = await runDemo({ outDir: dir, rounds: 3, every: 3, ...hostileClients("x") });
    for (const f of run.files) assert.match(f, /^[A-Za-z0-9_./-]+$/);
    assert.deepEqual((await readdir(dir)).sort(), ["anchors.json", "art", "demo.json", "events.json", "index.html", "memory", "share", "transcript.txt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("renderDemoPage refuses a file list entry that is not a plain relative path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "near-esc-demo-"));
  try {
    const { manifest } = await runDemo({ outDir: dir, rounds: 3, every: 3 });
    const events = JSON.parse(await readFile(join(dir, "events.json"), "utf8")).events;
    const anchors = JSON.parse(await readFile(join(dir, "anchors.json"), "utf8"));
    const svgs = Object.fromEntries(manifest.agents.map((a) => [a.id, { art: "", mintArt: "" }]));
    for (const bad of ["javascript:alert(1)", "//evil.example/x", "https://evil.example", "../../etc/passwd", "a b", 'x"y', "data:text/html,<script>"]) {
      assert.throws(() => renderDemoPage({ ...manifest, files: [...manifest.files, bad] }, { events, anchors, svgs }), TypeError, bad);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("escapeHtml escapes exactly one level and neutralizes bidi and control characters", () => {
  assert.equal(escapeHtml("&amp;"), "&amp;amp;");
  assert.equal(escapeHtml("a\u202Eb\u0000c\u200Bd"), "a\uFFFDb\uFFFDc\u200Bd"); // zero-width space is harmless and kept
  assert.equal(escapeHtml("line1\nline2\tx\r"), "line1\nline2\tx\r");
  assert.equal(escapeHtml(null), "null");
  assert.equal(escapeHtml({ toString: () => "<x>" }), "&lt;x&gt;");
});

// More edge cases for transferSection (src/demo/transfer-section.mjs): unicode and
// very long values, numeric oddities, many/duplicate tokens, unusual metadata, and
// hand-built manifests missing optional pieces. Pure; no files or network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { transferSection } from "./transfer-section.mjs";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const token = (over = {}) => ({ tokenId: "t1", anchoredHash: HASH_A, recomputedHash: HASH_A, match: true, nftMetadata: { title: "T" }, ...over });
const transfer = (over = {}) => ({
  from: "alice.demo.testnet",
  to: "bob.demo.testnet",
  contractId: "swarm.testnet",
  tokens: [token()],
  tamper: null,
  explorer: { placeholder: true, accountUrlPattern: "testnet.nearblocks.io/address/<account_id>" },
  teeInference: { label: "NEAR AI Cloud TEE inference", status: "mocked" },
  ...over,
});
const render = (over) => transferSection({ transfer: transfer(over) });
const count = (s, re) => (s.match(re) ?? []).length;
const rows = (html) => [...html.matchAll(/<tr><td>(.*?)<\/td>/g)].map((m) => m[1]);

describe("unicode and long values", () => {
  it("emoji, CJK and combining-mark token ids pass through unchanged in cell, summary and caption", () => {
    const id = "\u{1F680}-トークン-é";
    const html = render({ tokens: [token({ tokenId: id })], tamper: { tokenId: id, tamperedSheet: "s", anchoredHash: HASH_A, recomputedHash: HASH_B, match: false } });
    assert.ok(html.includes(`<td>${id}</td>`));
    assert.ok(html.includes(`<summary>${id}</summary>`));
    assert.ok(html.includes(`<code>${id}</code> was edited`));
  });

  it("emoji and non-ASCII text in nftMetadata is kept readable (JSON.stringify does not \\u-escape it)", () => {
    const html = render({ tokens: [token({ nftMetadata: { title: "Agent \u{1F916} éè", description: "中文" } })] });
    assert.ok(html.includes("Agent \u{1F916} éè"));
    assert.ok(html.includes("中文"));
  });

  it("a very long token id and a 200k-char tampered sheet render in full without truncation or error", () => {
    const id = "x".repeat(5000);
    const sheet = "line\n".repeat(40000);
    const html = render({ tokens: [token({ tokenId: id })], tamper: { tokenId: id, tamperedSheet: sheet, anchoredHash: HASH_A, recomputedHash: HASH_B, match: false } });
    assert.ok(html.includes(`<td>${id}</td>`));
    assert.ok(html.includes(`<pre>${sheet}</pre>`));
  });

  it("newlines and tabs in a tampered sheet survive verbatim inside the pre", () => {
    const html = render({ tamper: { tokenId: "t1", tamperedSheet: "a\n\tb\r\nc", anchoredHash: HASH_A, recomputedHash: HASH_B, match: false } });
    assert.ok(html.includes("<pre>a\n\tb\r\nc</pre>"));
  });

  it("single quotes and ampersands in the from/to accounts are escaped in text and the column header", () => {
    const html = render({ from: "o'neil&co", to: "<b>" });
    assert.ok(html.includes("<code>o&#39;neil&amp;co</code> sends every token to <code>&lt;b&gt;</code>"));
    assert.ok(html.includes("<th>Re-hashed by &lt;b&gt;</th>"));
    assert.ok(!html.includes("<b>"));
  });
});

describe("numeric and wrong-typed values", () => {
  it("numeric 0 as a token id is shown as 0, not dropped (no truthiness check)", () => {
    const html = render({ tokens: [token({ tokenId: 0 })] });
    assert.deepEqual(rows(html), ["0"]);
    assert.ok(html.includes("<summary>0</summary>"));
  });

  it("negative, NaN and huge numbers in hash cells render as their string forms", () => {
    const html = render({ tokens: [token({ anchoredHash: -1, recomputedHash: NaN }), token({ tokenId: "t2", anchoredHash: 1e21, recomputedHash: Number.MAX_SAFE_INTEGER })] });
    assert.ok(html.includes('<td class="hash">-1</td><td class="hash">NaN</td>'));
    assert.ok(html.includes('<td class="hash">1e+21</td><td class="hash">9007199254740991</td>'));
  });

  it("truthy non-boolean match values count as match, falsy ones (0, '', null, NaN) as MISMATCH", () => {
    const html = render({ tokens: [token({ match: 1 }), token({ match: "yes" }), token({ match: 0 }), token({ match: "" }), token({ match: null }), token({ match: NaN })] });
    assert.equal(count(html, /class="ok"/g), 2);
    assert.equal(count(html, /MISMATCH/g), 4);
  });

  it("nftMetadata with nested arrays, numbers and nulls is pretty-printed with two-space indent", () => {
    const html = render({ tokens: [token({ nftMetadata: { n: [1, -0, 1e21, null], o: {} } })] });
    assert.ok(html.includes("&quot;n&quot;: [\n    1,\n    0,\n    1e+21,\n    null\n  ]"));
  });

  it("nftMetadata that JSON.stringify drops (undefined, function) renders an empty-ish pre without throwing", () => {
    for (const nftMetadata of [undefined, () => 1, Symbol("s")]) {
      const html = render({ tokens: [token({ nftMetadata })] });
      assert.ok(html.includes("<details><summary>t1</summary><pre>"));
      assert.ok(!html.includes("</pre></pre>"));
    }
  });

  it("an empty-string status is not 'mocked' and prints no inference-call note", () => {
    const html = render({ teeInference: { label: "L", status: "" } });
    assert.ok(html.includes('<strong>L</strong>: <span class="mut"></span></p>'));
  });
});

describe("many and duplicate tokens", () => {
  it("duplicate token ids are kept as separate rows and separate details blocks, in input order", () => {
    const html = render({ tokens: [token({ tokenId: "dup", match: true }), token({ tokenId: "dup", match: false }), token({ tokenId: "other" })] });
    assert.deepEqual(rows(html), ["dup", "dup", "other"]);
    assert.equal(count(html, /<details>/g), 3);
    const dupRows = html.match(/<tr><td>dup<\/td>.*<\/tr>/g);
    assert.ok(dupRows[0].includes('class="ok"') && dupRows[1].includes("MISMATCH"));
  });

  it("1000 tokens render 1000 rows and 1000 details blocks", () => {
    const tokens = Array.from({ length: 1000 }, (_, i) => token({ tokenId: `t${i}` }));
    const html = render({ tokens });
    assert.equal(count(html, /<tr><td>t\d+<\/td>/g), 1000);
    assert.equal(count(html, /<details>/g), 1000);
  });

  it("a tamper table is the only extra table row group: its row has three cells, no token cell", () => {
    const html = render({ tamper: { tokenId: "t1", tamperedSheet: "s", anchoredHash: HASH_A, recomputedHash: HASH_B, match: false } });
    assert.ok(html.includes(`<tr><td class="hash">${HASH_A}</td><td class="hash">${HASH_B}</td><td><strong>MISMATCH</strong></td></tr>`));
    assert.equal(count(html, /<table>/g), 2);
  });

  it("tamper with an empty-string sheet or id still renders the block (only a falsy tamper hides it)", () => {
    const html = render({ tamper: { tokenId: "", tamperedSheet: "", anchoredHash: "", recomputedHash: "", match: false } });
    assert.ok(html.includes("<h3>Tampered sheet</h3>"));
    assert.ok(html.includes("<pre></pre>"));
    assert.ok(html.includes("<code></code> was edited"));
    for (const falsy of [0, "", false, null, undefined]) assert.ok(!render({ tamper: falsy }).includes("Tampered sheet"));
  });
});

describe("explorer and structure", () => {
  it("a live explorer does not print the placeholder line or the not-deployed note", () => {
    const html = render({ explorer: { placeholder: false, contractUrl: "https://testnet.nearblocks.io/address/swarm.testnet" } });
    assert.ok(!html.includes("<strong>mock placeholder</strong>"));
    assert.ok(!html.includes("not deployed"));
  });

  it("a live contractUrl with a very long but valid account id is still linked", () => {
    const id = "a".repeat(64);
    const url = `https://testnet.nearblocks.io/address/${id}`;
    const html = render({ explorer: { placeholder: false, contractUrl: url } });
    assert.ok(html.includes(`<a href="${url}" rel="noopener noreferrer">testnet.nearblocks.io/address/${id}</a>`));
  });

  it("an https scheme stripped from a rejected URL shows only the first scheme and keeps later ones as text", () => {
    const html = render({ explorer: { placeholder: false, contractUrl: "https://evil.com/?u=https://x" } });
    assert.ok(html.includes("<code>evil.com/?u=https://x</code>"));
    assert.ok(!html.includes("<a "));
  });

  it("a placeholder flag of any truthy type selects the placeholder line", () => {
    for (const placeholder of [1, "yes", true]) {
      const html = render({ explorer: { placeholder, accountUrlPattern: "p", contractUrl: "https://testnet.nearblocks.io/address/x" } });
      assert.ok(html.includes("<strong>mock placeholder</strong>"), String(placeholder));
      assert.ok(!html.includes("<a "));
    }
  });

  it("output is deterministic and does not mutate the manifest", () => {
    const m = { transfer: transfer({ tamper: { tokenId: "t1", tamperedSheet: "<s>", anchoredHash: HASH_A, recomputedHash: HASH_B, match: false } }) };
    const before = JSON.stringify(m);
    assert.equal(transferSection(m), transferSection(m));
    assert.equal(JSON.stringify(m), before);
  });

  it("tags are balanced for tables, details and pre in a typical render", () => {
    const html = render({ tokens: [token(), token({ tokenId: "t2" })], tamper: { tokenId: "t1", tamperedSheet: "s", anchoredHash: HASH_A, recomputedHash: HASH_B, match: false } });
    for (const tag of ["table", "details", "pre", "summary", "code"]) {
      assert.equal(count(html, new RegExp(`<${tag}[ >]`, "g")), count(html, new RegExp(`</${tag}>`, "g")), tag);
    }
  });
});

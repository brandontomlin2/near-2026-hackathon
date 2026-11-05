// Edge-case tests for transferSection (src/demo/transfer-section.mjs): missing data,
// hostile strings, verdict formatting and the explorer line. Pure; no files or network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildTransfer } from "./transfer-verify.mjs";
import { transferSection } from "./transfer-section.mjs";
import { hashSheet } from "../anchor/hash.mjs";

const agent = (id, sheet, extra = {}) => ({ id, name: `name-${id}`, personality: "Aloof", traits: { role: "scout" }, sheets: [{ sheet }], ...extra });
const anchorFor = (id, sheet) => ({ tokenId: id, args: { sheet_hash: hashSheet(sheet) } });
const build = (agents, calls, opts = { contractId: "c.testnet", mode: "mock" }) => buildTransfer(agents, { calls }, opts);
const render = (transfer) => transferSection({ transfer });
const count = (s, re) => (s.match(re) ?? []).length;
const hrefs = (html) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);

const live = (contractId) => build([], [], { contractId, mode: "live" });

describe("empty and missing transfer", () => {
  it("returns an empty string for undefined/empty manifests and falsy transfers", () => {
    assert.equal(transferSection(undefined), "");
    assert.equal(transferSection({}), "");
    assert.equal(transferSection({ transfer: undefined }), "");
    assert.equal(transferSection({ transfer: 0 }), "");
    assert.equal(transferSection({ transfer: "" }), "");
  });

  it("empty tokens and null tamper: header, empty table, no tampered block, metadata and testnet still present", () => {
    const html = render(build([], []));
    assert.match(html, /<h2>Transfer: memory travels with the NFT<\/h2>/);
    assert.match(html, /<th>Token<\/th>/);
    assert.equal(count(html, /<tr><td/g), 0);
    assert.ok(!html.includes("Tampered sheet"));
    assert.ok(!html.includes("<details>"));
    assert.ok(html.includes("<h3>Mint metadata</h3>") && html.includes("<h3>On testnet</h3>"));
  });

  it("tokens: null behaves like no tokens", () => {
    const t = build([], []);
    t.tokens = null;
    const html = render(t);
    assert.equal(count(html, /<tr><td/g), 0);
    assert.ok(html.includes("<h3>On testnet</h3>"));
  });

  it("tamper: undefined is treated like null", () => {
    const t = build([agent("a", "s")], [anchorFor("a", "s")]);
    delete t.tamper;
    assert.ok(!render(t).includes("Tampered sheet"));
  });
});

describe("verdict formatting", () => {
  it("renders one row per token with match and MISMATCH verdicts and the tamper row", () => {
    const t = build([agent("a", "sa"), agent("b", "sb")], [anchorFor("a", "sa"), anchorFor("b", "different")]);
    const html = render(t);
    assert.equal(count(html, /<span class="ok">match<\/span>/g), 1 + 0); // a only; tamper is a mismatch
    assert.equal(count(html, /<strong>MISMATCH<\/strong>/g), 2); // b + tamper row
    assert.ok(html.includes(`<td>a</td><td class="hash">${t.tokens[0].anchoredHash}</td><td class="hash">${t.tokens[0].recomputedHash}</td><td><span class="ok">match</span></td>`));
    assert.ok(html.includes(`<td>b</td>`));
  });

  it("only a strictly truthy match is green; match absent or false is MISMATCH", () => {
    const t = build([agent("a", "sa")], [anchorFor("a", "sa")]);
    t.tokens[0].match = undefined;
    t.tamper.match = false;
    const html = render(t);
    assert.equal(count(html, /class="ok"/g), 0);
    assert.equal(count(html, /MISMATCH/g), 2);
  });

  it("the tampered sheet is shown in a pre and the tamper verdict is MISMATCH for real buildTransfer input", () => {
    const t = build([agent("a", "sheet text")], [anchorFor("a", "sheet text")]);
    const html = render(t);
    assert.match(html, /<h3>Tampered sheet<\/h3>/);
    assert.ok(html.includes(`<pre>${t.tamper.tamperedSheet}</pre>`));
    assert.equal(t.tamper.match, false);
    const tamperBlock = html.slice(html.indexOf("Tampered sheet"), html.indexOf("Mint metadata"));
    assert.ok(tamperBlock.includes("<strong>MISMATCH</strong>") && !tamperBlock.includes('class="ok"'));
  });

  it("from/to and the re-hash column header name the simulated accounts", () => {
    const html = render(build([], []));
    assert.ok(html.includes("<code>alice.demo.testnet</code> sends every token to <code>bob.demo.testnet</code>"));
    assert.ok(html.includes("<th>Re-hashed by bob.demo.testnet</th>"));
  });

  it("nftMetadata is pretty-printed JSON inside details keyed by token id", () => {
    const t = build([agent("a", "s")], [anchorFor("a", "s")]);
    const html = render(t);
    assert.ok(html.includes("<details><summary>a</summary><pre>"));
    assert.ok(html.includes("&quot;title&quot;: &quot;name-a&quot;"));
    assert.ok(html.includes("memory_depth"));
  });
});

describe("TEE inference line", () => {
  it('"(this demo makes no inference call)" only when status is exactly "mocked"', () => {
    const mocked = render(build([], [], { contractId: "c.testnet", mode: "mock" }));
    assert.ok(mocked.includes('<span class="mut">mocked</span> (this demo makes no inference call)'));
    const liveHtml = render(live("c.testnet"));
    assert.ok(liveHtml.includes('<span class="mut">live (unattested)</span></p>'));
    assert.ok(!liveHtml.includes("no inference call"));
    for (const status of ["Mocked", "mocked ", "mock", ""]) {
      const t = build([], []);
      t.teeInference.status = status;
      assert.ok(!render(t).includes("no inference call"), JSON.stringify(status));
    }
  });

  it("never claims attestation or verification", () => {
    for (const html of [render(build([], [])), render(live("c.testnet"))]) {
      assert.doesNotMatch(html, /attested(?!\))|TEE verified/i);
    }
  });
});

describe("explorer line", () => {
  it("mock placeholder: bold placeholder text, contract id as code, pattern shown, no link", () => {
    const html = render(build([], [], { contractId: "swarm.testnet", mode: "mock" }));
    assert.ok(html.includes("<strong>mock placeholder</strong>"));
    assert.ok(html.includes("<code>swarm.testnet</code> is not deployed"));
    assert.ok(html.includes("<code>testnet.nearblocks.io/address/&lt;account_id&gt;</code>"));
    assert.deepEqual(hrefs(html), []);
  });

  it("live: a plain account id becomes a rel=noopener noreferrer link to testnet nearblocks", () => {
    for (const id of ["swarm.testnet", "a-b_c.d1.testnet", "0123"]) {
      const html = render(live(id));
      const url = `https://testnet.nearblocks.io/address/${id}`;
      assert.ok(html.includes(`<a href="${url}" rel="noopener noreferrer">testnet.nearblocks.io/address/${id}</a>`), id);
      assert.ok(!html.includes("<strong>mock placeholder</strong>"));
    }
  });

  it("live with unsafe or odd contract ids shows plain code text, never an anchor", () => {
    const bad = ["Foo.testnet", "a/b", "a?x=1", "a#frag", "a b", "a\nb", "a@evil.com", "a:80", "é.testnet", 'a"onmouseover="x', "<script>alert(1)</script>", ""];
    for (const id of bad) {
      const html = render(live(id));
      assert.deepEqual(hrefs(html), [], JSON.stringify(id));
      assert.match(html, /Explorer page for the contract: <code>/, JSON.stringify(id));
    }
  });

  it("hand-crafted contractUrl values that are not the testnet nearblocks address form are never linked", () => {
    const urls = [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "http://testnet.nearblocks.io/address/x.testnet",
      "https://nearblocks.io/address/x.testnet",
      "https://testnet.nearblocks.io.evil.com/address/x.testnet",
      "https://testnet.nearblocks.io@evil.com/address/x.testnet",
      "https://evil.com/https://testnet.nearblocks.io/address/x.testnet",
      "https://testnet.nearblocks.io/address/x.testnet/../../evil",
      "https://testnet.nearblocks.io/address/x.testnet/",
      "https://testnet.nearblocks.io/address/x.testnet?next=//evil.com",
      "https://testnet.nearblocks.io/address/x.testnet#frag",
      "https://testnet.nearblocks.io/address/x.testnet\n",
      "https://testnet.nearblocks.io/address/",
      "https://testnet.nearblocks.io/txns/abc",
      "https://testnet.nearblocks.io:8443/address/x.testnet",
      "//testnet.nearblocks.io/address/x.testnet",
      " https://testnet.nearblocks.io/address/x.testnet",
      "https://testnet.nearblocks.io/address/X.testnet",
      "https://testnet.nearblocks.io/address/x.testnet%2F..%2Fevil",
      'https://testnet.nearblocks.io/address/x"onclick="alert(1)',
    ];
    for (const contractUrl of urls) {
      const t = live("x.testnet");
      t.explorer.contractUrl = contractUrl;
      const html = render(t);
      assert.deepEqual(hrefs(html), [], JSON.stringify(contractUrl));
      assert.ok(html.includes("Explorer page for the contract: <code>"), JSON.stringify(contractUrl));
      assert.ok(!/<script|onclick="|<img/i.test(html), JSON.stringify(contractUrl));
    }
  });

  it("a rejected URL is shown with its scheme stripped, escaped, inside code", () => {
    const t = live("x.testnet");
    t.explorer.contractUrl = 'http://evil.com/"><script>alert(1)</script>';
    const html = render(t);
    assert.ok(html.includes("<code>evil.com/&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;</code>"));
    assert.ok(!html.includes("<script"));
  });

  it("placeholder wins over a contractUrl: a placeholder explorer is never linked", () => {
    const t = build([], [], { contractId: "c.testnet", mode: "mock" });
    t.explorer.contractUrl = "https://testnet.nearblocks.io/address/c.testnet";
    assert.deepEqual(hrefs(render(t)), []);
  });
});

describe("hostile strings are escaped everywhere", () => {
  const XSS = `"><script>alert(1)</script><img src=x onerror=alert(1)>'`;
  const ESCAPED_SCRIPT = "&lt;script&gt;alert(1)&lt;/script&gt;";
  const noRawMarkup = (html) => {
    assert.ok(!/<script|<img|<svg|<iframe/i.test(html), "raw tag leaked");
    assert.ok(!html.includes('"><'), "attribute break-out leaked");
  };

  it("tokenId (row cell, details summary, tamper caption)", () => {
    const html = render(build([agent(XSS, "s")], [{ tokenId: XSS, args: { sheet_hash: hashSheet("s") } }]));
    noRawMarkup(html);
    assert.ok(count(html, new RegExp(ESCAPED_SCRIPT.replace(/[()]/g, "\\$&"), "g")) >= 3);
  });

  it("from, to, and contractId in mock mode", () => {
    const t = build([], [], { contractId: XSS, mode: "mock" });
    t.from = XSS;
    t.to = XSS;
    const html = render(t);
    noRawMarkup(html);
    assert.ok(html.includes(ESCAPED_SCRIPT));
  });

  it("anchoredHash and recomputedHash in both the token and tamper tables", () => {
    const t = build([agent("a", "s")], [anchorFor("a", "s")]);
    t.tokens[0].anchoredHash = XSS;
    t.tokens[0].recomputedHash = XSS;
    t.tamper.anchoredHash = XSS;
    t.tamper.recomputedHash = XSS;
    const html = render(t);
    noRawMarkup(html);
    assert.equal(count(html, /&lt;script&gt;/g), 4);
  });

  it("tamperedSheet with markup and a closing pre tag stays inside the pre as text", () => {
    const t = build([agent("a", "s")], [anchorFor("a", "s")]);
    t.tamper.tamperedSheet = `</pre><script>alert(1)</script>`;
    const html = render(t);
    assert.ok(html.includes("<pre>&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;</pre>"));
    noRawMarkup(html);
  });

  it("nftMetadata strings (title, description, extra) are escaped inside the JSON pre", () => {
    const t = build([agent("a", "s", { name: XSS, personality: XSS })], [anchorFor("a", "s")]);
    const html = render(t);
    noRawMarkup(html);
    assert.ok(html.includes(ESCAPED_SCRIPT));
  });

  it("nftMetadata that is undefined or null renders without crashing", () => {
    for (const nftMetadata of [undefined, null, "str", 5]) {
      const t = build([agent("a", "s")], [anchorFor("a", "s")]);
      t.tokens[0].nftMetadata = nftMetadata;
      const html = render(t);
      assert.ok(html.includes("<details><summary>a</summary><pre>"), String(nftMetadata));
    }
  });

  it("teeInference label and status are escaped", () => {
    const t = build([], []);
    t.teeInference = { label: XSS, status: XSS };
    const html = render(t);
    noRawMarkup(html);
    assert.ok(html.includes(`<strong>${"&quot;&gt;&lt;script&gt;"}`));
  });

  it("explorer accountUrlPattern is escaped in the placeholder line", () => {
    const t = build([], []);
    t.explorer.accountUrlPattern = XSS;
    noRawMarkup(render(t));
  });

  it("control and bidi characters in ids are neutralised", () => {
    const id = "ev‮il\u0000\u001b[31m";
    const html = render(build([agent(id, "s")], [{ tokenId: id, args: { sheet_hash: hashSheet("s") } }]));
    assert.ok(!/[‮\u0000\u001b]/.test(html));
  });

  it("ampersands and entities in values are double-escaped, not interpreted", () => {
    const t = build([agent("a&amp;b", "s")], [anchorFor("a&amp;b", "s")]);
    const html = render(t);
    assert.ok(html.includes("<td>a&amp;amp;b</td>"));
  });
});

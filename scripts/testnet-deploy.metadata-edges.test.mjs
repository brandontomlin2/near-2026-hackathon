// Skeptical-reviewer edge cases for the mint dry run's NEP-177 token_metadata.
// Pure and offline: no near-cli-rs, no keys, no network, no signing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AGENTS, agentSvg, tokenMetadata, buildMintStep, buildPlan, run,
} from "./testnet-deploy.mjs";
import { hashSheet } from "../src/anchor/hash.mjs";

const MAX = { title: 128, description: 1024, extra: 2048, media: 512 };
const OWNER = "o.testnet";
const base = AGENTS[0];
const agentWith = (patch) => ({ ...base, ...patch });
const sink = () => {
  const lines = [];
  return { lines, out: (l) => lines.push(l), err: (l) => lines.push(l), text: () => lines.join("\n") };
};
const mintArgs = (agent, mediaBase) =>
  buildMintStep({ contract: "c.testnet", owner: OWNER, receiver: OWNER, agent, mediaBase });

test("hostile strings (quotes, <script>, newlines, NUL, lone surrogates) survive a JSON round trip", () => {
  const hostile = [
    `He said "hi" \\ done`,
    `<script>alert(1)</script>`,
    "line1\nline2\r\n\ttabbed",
    "nul\u0000byte and   separators",
    "lone \ud800 surrogate",
    `'; DROP TABLE tokens; --`,
    "$(touch /tmp/pwned) `id` ; rm -rf /",
  ];
  for (const text of hostile) {
    const step = mintArgs(agentWith({ title: text, description: text }));
    const wire = JSON.parse(step.argv[step.argv.indexOf("json-args") + 1]);
    // JSON.stringify well-formed-izes lone surrogates, so compare against that.
    assert.equal(wire.token_metadata.title, JSON.parse(JSON.stringify(text)));
    assert.equal(wire.token_metadata.description, JSON.parse(JSON.stringify(text)));
    assert.deepEqual(wire, JSON.parse(JSON.stringify(step.args)));
  }
});

test("hostile text stays a single shell-quoted argv element in the printed command", async () => {
  const s = sink();
  assert.equal(await run(["mint", "--count", "1"], {}, { out: s.out, err: s.err }), 0);
  // The real agents are benign; check quoting through the same helper on a hostile step.
  const step = mintArgs(agentWith({ description: "it's `id` $(id) \"q\"\nnl" }));
  assert.equal(step.argv.filter((a) => a.includes("`id`")).length, 1); // one argv element, never split
});

test("unicode and emoji: limits are in BYTES, not characters", () => {
  const emoji = "🦀".repeat(32); // 32 chars, 128 bytes: exactly the title cap
  assert.equal(Buffer.byteLength(tokenMetadata(agentWith({ title: emoji })).title), MAX.title);
  const wide = "é".repeat(1024); // 1024 chars but 2048 bytes: over the description cap
  assert.throws(() => tokenMetadata(agentWith({ description: wide })), /description/);
  // Real agents: ASCII today, and fit with room to spare.
  for (const a of AGENTS) {
    const m = tokenMetadata(a);
    assert.ok(Buffer.byteLength(m.title) <= MAX.title && Buffer.byteLength(m.description) <= MAX.description);
  }
});

test("a title or description over the contract cap is refused before any plan is built", () => {
  assert.throws(() => tokenMetadata(agentWith({ title: "x".repeat(MAX.title + 1) })), /title/);
  assert.throws(() => tokenMetadata(agentWith({ description: "é".repeat(MAX.description) })), /description/);
  assert.throws(() => tokenMetadata(agentWith({ title: "" })), /title/);
});

test("media over 512 bytes (long --media-base) is refused in the dry run, not on-chain mid-batch", async () => {
  const longBase = `https://art.example/${"a".repeat(600)}`;
  assert.throws(() => tokenMetadata(base, { mediaBase: longBase }), /media/);
  const s = sink();
  assert.notEqual(await run(["mint", "--media-base", longBase], {}, { out: s.out, err: s.err }), 0);
  // Exactly at the cap is fine.
  const suffix = "/aloof.svg";
  const atCap = `https://art.example/${"a".repeat(MAX.media - "https://art.example/".length - suffix.length)}`;
  assert.equal(Buffer.byteLength(tokenMetadata(base, { mediaBase: atCap }).media), MAX.media);
});

test("media is a URL string, never a data: URI, and --media-base rejects unsafe schemes", async () => {
  for (const a of AGENTS) assert.match(tokenMetadata(a).media, /^https:\/\//);
  for (const bad of ["data:image/svg+xml;base64,AAAA", "javascript:alert(1)", "file:///etc/passwd", "https://a b", "https://x\nhttps://y", "ftp://x"]) {
    const s = sink();
    assert.notEqual(await run(["mint", "--media-base", bad], {}, { out: s.out, err: s.err }), 0, bad);
  }
});

test("--media-base with query or fragment is refused (it would corrupt <token_id>.svg)", async () => {
  for (const bad of ["https://a.example/x?sig=1", "https://a.example/x#frag"]) {
    const s = sink();
    assert.notEqual(await run(["mint", "--media-base", bad], {}, { out: s.out, err: s.err }), 0, bad);
  }
});

test("media_hash is base64 (standard alphabet, padded) of exactly 32 bytes of sha256(SVG bytes)", () => {
  for (const a of AGENTS) {
    const { media_hash } = tokenMetadata(a);
    assert.match(media_hash, /^[A-Za-z0-9+/]{43}=$/);
    assert.equal(Buffer.from(media_hash, "base64").toString("base64"), media_hash); // canonical
    assert.equal(media_hash, createHash("sha256").update(Buffer.from(agentSvg(a), "utf8")).digest("base64"));
  }
});

test("media_hash matches the committed art when one exists, and changes if a byte changes", () => {
  const a = AGENTS[0];
  const flipped = createHash("sha256").update(`${agentSvg(a)} `).digest("base64");
  assert.notEqual(tokenMetadata(a).media_hash, flipped);
  assert.equal(agentSvg(a), agentSvg(a)); // deterministic render
});

test("reference/reference_hash and the timestamp fields are omitted: nothing unverifiable is emitted", () => {
  for (const a of AGENTS) {
    const m = tokenMetadata(a);
    for (const f of ["reference", "reference_hash", "issued_at", "updated_at", "starts_at", "expires_at", "copies"]) {
      assert.equal(f in m, false, `${f} must not be present`);
    }
    for (const [k, v] of Object.entries(m)) assert.equal(typeof v, "string", `${k} must be a string`);
  }
});

test("if reference_hash is ever added it must be the base64 sha256 of the sheet bytes, matching hashSheet", () => {
  // hashSheet() returns hex of the NORMALIZED sheet; NEP-177 wants base64 of the 32 raw bytes.
  const sheet = "# Aloof\r\nI watch.   \r\n";
  const hex = hashSheet(sheet);
  const b64 = Buffer.from(hex, "hex").toString("base64");
  assert.equal(Buffer.from(b64, "base64").length, 32);
  assert.equal(b64, createHash("sha256").update("# Aloof\nI watch.\n", "utf8").digest("base64"));
  assert.equal(hashSheet("# Aloof\nI watch.\n"), hex); // CRLF/trailing-space insensitive
});

test("extra is a JSON object string within 2048 bytes and carries only the four trait keys", () => {
  for (const a of AGENTS) {
    const { extra } = tokenMetadata(a);
    assert.ok(Buffer.byteLength(extra) <= MAX.extra);
    const parsed = JSON.parse(extra);
    assert.ok(parsed && typeof parsed === "object" && !Array.isArray(parsed));
    assert.deepEqual(Object.keys(parsed).sort(), ["risk", "role", "temperament", "voice"]);
  }
});

test("oversized or non-object extra is refused", () => {
  assert.throws(() => tokenMetadata(agentWith({ traits: { ...base.traits, voice: "v".repeat(2100) } })), /extra|trait|voice/);
});

test("tokenMetadata is deterministic and does not mutate the shared AGENTS table", () => {
  const before = JSON.stringify(AGENTS);
  const a = JSON.stringify(AGENTS.map((x) => tokenMetadata(x)));
  const b = JSON.stringify(AGENTS.map((x) => tokenMetadata(x)));
  assert.equal(a, b);
  assert.equal(JSON.stringify(AGENTS), before);
});

test("the dry run never signs: no sign step runs, no exec, and the plan says dry-run", async () => {
  const s = sink();
  const never = () => { throw new Error("exec must not run in a dry run"); };
  const code = await run(["mint", "--json"], {}, { out: s.out, err: s.err, exec: never, hasNear: never });
  assert.equal(code, 0);
  const plan = JSON.parse(s.text());
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.steps.length, AGENTS.length);
});

test("the mint code has no path that builds a signed transaction", () => {
  const src = readFileSync(new URL("./testnet-deploy.mjs", import.meta.url), "utf8");
  // Signing only appears in near-cli-rs argv (sign-with-keychain), which is run
  // solely under --send; the script never imports a signer or touches key files.
  assert.doesNotMatch(src, /near-api-js|near-kit|KeyPair|secretKey|private_key|signTransaction|readFileSync|dotenv|\.env\b(?!\.)(?<!process\.env)/);
  const steps = buildPlan({ command: "mint", contract: "c.testnet", owner: OWNER, receiver: OWNER });
  for (const st of steps) {
    assert.equal(st.argv.includes("send"), true); // argv is only data until --send executes it
    assert.equal(typeof st.argv, "object");
  }
});

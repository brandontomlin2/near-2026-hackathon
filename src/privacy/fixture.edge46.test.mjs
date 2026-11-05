// Edge-case behaviour of the synthetic attestation fixture as a user sees it through
// `npm run attest:check`: it must never claim a live TEE attestation.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { HashError } from "../anchor/hash.mjs";
import { checkAttestation } from "./attestation.mjs";
import { MOCK_MODEL, MOCK_SIGNING_ADDRESS, TAMPERED_ADDRESS, TDX_V4_QUOTE_LENGTH, mockAttestation } from "./fixture.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts", "attest-check.mjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "edge46-fixture-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(...args) {
  // cwd is a temp dir: nothing is written into the repo.
  const r = spawnSync(process.execPath, [script, ...args], { cwd: tmp, encoding: "utf8", timeout: 60000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// Phrases that would claim a real attestation. The honest negatives ("not a live TEE", "NOT VERIFIED") are fine.
const CLAIMS = [/\bverified by (intel|nvidia)/i, /attestation verified/i, /\bTEE[- ]verified\b/i, /\bgenuine\b/i, /\bPASSED? attestation/i];

test("default run: fixture notice first, CONSISTENT, NOT VERIFIED, exit 0, no live-TEE claim", () => {
  const r = run();
  assert.equal(r.code, 0);
  assert.equal(r.err, "");
  assert.match(r.out.split("\n")[0], /fixture.*not a live TEE report/);
  assert.match(r.out, /CONSISTENT, NOT VERIFIED/);
  assert.match(r.out, /Whether the report came from a real TEE rather than being hand written/);
  for (const re of CLAIMS) assert.doesNotMatch(r.out, re);
});

test("--tamper prints REJECT, exits 1, still says fixture", () => {
  const r = run("--tamper");
  assert.equal(r.code, 1);
  assert.match(r.out, /REJECT/);
  assert.match(r.out, /not a live TEE report/);
  for (const re of CLAIMS) assert.doesNotMatch(r.out, re);
});

test("--unreadable-quote exits 2 and combining flags exits 2 with a clear message", () => {
  assert.equal(run("--unreadable-quote").code, 2);
  const both = run("--tamper", "--unreadable-quote");
  assert.equal(both.code, 2);
  assert.match(both.err, /cannot be combined/);
  assert.equal(both.out, "");
});

test("a typo'd flag is a usage error, not a clean pass", () => {
  const r = run("--tampr");
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown argument "--tampr"/);
  assert.equal(r.out, "");
});

test("the fixture's own data says synthetic everywhere and never looks like a real quote", () => {
  const { report, chatSignature } = mockAttestation({ requestBody: "{}" });
  const text = JSON.stringify(report);
  assert.equal(report.synthetic, true);
  assert.equal(Buffer.from(report.model_attestations[0].intel_quote, "hex").length, TDX_V4_QUOTE_LENGTH);
  // 632 bytes is header + body with no signature section: it cannot be a signed quote.
  assert.equal(chatSignature.signature, "0x" + "00".repeat(65));
  assert.ok(text.includes('\\"synthetic\\":true'));
});

test("edge inputs: empty body works, unicode body is deterministic, missing body throws", () => {
  const empty = mockAttestation({ requestBody: "" });
  assert.match(empty.report.nonce, /^[0-9a-f]{64}$/);
  const uni = '{"messages":[{"content":"héllo 日本語 😈"}]}';
  assert.deepEqual(mockAttestation({ requestBody: uni }), mockAttestation({ requestBody: uni }));
  assert.notEqual(mockAttestation({ requestBody: uni }).report.nonce, empty.report.nonce);
  assert.throws(() => mockAttestation({}), HashError);
});

test("an empty model name does not crash, and a custom model flows into the report and signature text", () => {
  assert.doesNotThrow(() => mockAttestation({ requestBody: "x", model: "" }));
  const m = mockAttestation({ requestBody: "x", model: "other-model" });
  assert.equal(m.report.model_attestations[0].model_name, "other-model");
  assert.ok(m.chatSignature.text.startsWith("other-model:"));
});

test("the fixture still passes the checker offline only as 'consistent', and a swapped address rejects", () => {
  const body = JSON.stringify({ model: MOCK_MODEL });
  const { report, chatSignature } = mockAttestation({ requestBody: body });
  const ok = checkAttestation(report, { requestBody: body, model: MOCK_MODEL, chatSignature });
  assert.notEqual(ok.verdict, "reject");
  assert.match(ok.summary, /NOT VERIFIED/);
  assert.notEqual(TAMPERED_ADDRESS, MOCK_SIGNING_ADDRESS);
  report.model_attestations[0].signing_address = TAMPERED_ADDRESS;
  assert.equal(checkAttestation(report, { requestBody: body, model: MOCK_MODEL, chatSignature }).verdict, "reject");
});

// `npm run attest:check` runs scripts/attest-check.mjs against the bundled
// fixture, offline. Locks the npm script, the output, the exit codes and the
// "fixture, not a live TEE" wording in docs/privacy.md and the README.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runOffline } from "./test-helpers/run-offline.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(root, "scripts/attest-check.mjs");
const NOTICE = "Checking the bundled fixture attestation (src/privacy/fixture.mjs), not a live TEE report.";

test("package.json wires attest:check to the script the docs name", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["attest:check"], "node scripts/attest-check.mjs");
});

test("attest:check is offline, says it checks the fixture, prints CONSISTENT, NOT VERIFIED and exits 0", async () => {
  const result = await runOffline([script]);
  assert.deepEqual(result.violations, [], `attest:check touched the network: ${result.violations.join("; ")}`);
  assert.equal(result.code, 0, result.stderr);
  const lines = result.stdout.split("\n");
  assert.equal(lines[0], NOTICE, "first line must say it is the fixture, not a live TEE");
  assert.match(result.stdout, /^pass {9}structure: 1 node attestation\(s\) present$/m);
  assert.doesNotMatch(result.stdout, /^fail /m);
  assert.match(result.stdout, /^CONSISTENT, NOT VERIFIED: offline fields agree, but no TEE signature or certificate was checked\.$/m);
  assert.doesNotMatch(result.stdout, /^REJECT:/m);
  const notVerified = result.stdout.split("Not verified:\n")[1];
  assert.ok(notVerified, "output must end with a Not verified list");
  assert.match(notVerified, /real TEE rather than being hand written/);
});

test("attest:check --tamper is offline, prints REJECT and exits 1", async () => {
  const result = await runOffline([script, "--tamper"]);
  assert.deepEqual(result.violations, [], `attest:check --tamper touched the network: ${result.violations.join("; ")}`);
  assert.equal(result.code, 1);
  assert.equal(result.stdout.split("\n")[0], NOTICE);
  assert.match(result.stdout, /^fail {9}node\[0\]\.quote-binding: /m);
  assert.match(result.stdout, /^REJECT: node\[0\]\.quote-binding, signature-signer\.$/m);
  assert.doesNotMatch(result.stdout, /^CONSISTENT/m);
});

test("attest:check --unreadable-quote exits 2, not 0: consistent but the binding is unread", async () => {
  const result = await runOffline([script, "--unreadable-quote"]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /^unverifiable node\[0\]\.quote-binding: /m);
  assert.match(result.stdout, /^CONSISTENT, NOT VERIFIED, BINDING UNREAD: /m);
  assert.doesNotMatch(result.stdout, /^REJECT:/m);
});

test("docs/privacy.md and the README say attest:check checks a fixture, not a live TEE", async () => {
  const privacy = await readFile(join(root, "docs/privacy.md"), "utf8");
  assert.ok(privacy.includes("Run `npm run attest:check` (add `-- --tamper` to see a reject)."));
  assert.ok(privacy.includes("not a live TEE: no\nreport is fetched, no network call is made"));
  assert.doesNotMatch(privacy, /Needs wiring by the integrator|Suggested `package\.json` line/);
  const readme = await readFile(join(root, "README.md"), "utf8");
  const caveats = readme.split("## Mock caveats and status\n")[1].split(/\n## /)[0];
  assert.ok(caveats.includes("Privacy check. `npm run attest:check` runs the offline attestation consistency check"));
  assert.ok(caveats.includes("not against a live NEAR AI Cloud TEE report"));
  assert.ok(caveats.includes("It prints `CONSISTENT, NOT VERIFIED` and exits 0, or with `-- --tamper` prints `REJECT` and exits 1"));
  assert.ok(caveats.includes("[`docs/privacy.md`](docs/privacy.md)"));
});

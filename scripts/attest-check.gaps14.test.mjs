// Further behaviour of `node scripts/attest-check.mjs`: determinism, stderr silence,
// the effect of --tamper on exactly the checks that depend on the signing address,
// and that unrecognised arguments do not switch the check into the tamper path.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runOffline } from "./test-helpers/run-offline.mjs";

const script = fileURLToPath(new URL("./attest-check.mjs", import.meta.url));

const rows = (stdout) =>
  Object.fromEntries(
    stdout.split("\n").filter((l) => /^(pass|fail|warn|skip)\S*\s+\S+: /.test(l)).map((l) => {
      const m = l.match(/^(\S+)\s+(\S+): /);
      return [m[2], m[1]];
    }),
  );

test("two clean runs print byte-identical output, with nothing on stderr", async () => {
  const a = await runOffline([script]);
  const b = await runOffline([script]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(a.stderr, "");
  assert.equal(a.stdout, b.stdout);
});

test("--tamper changes only the signing-address checks: the others keep their clean-run status", async () => {
  const clean = rows((await runOffline([script])).stdout);
  const tampered = rows((await runOffline([script, "--tamper"])).stdout);
  assert.equal(tampered["node[0].signing-key"], "fail");
  assert.equal(tampered["signature-signer"], "fail");
  for (const id of ["structure", "nonce-format", "nonce-echo", "node[0].signing-algo", "node[0].model", "signature-text"]) {
    assert.equal(tampered[id], clean[id], id);
    assert.equal(clean[id], "pass", id);
  }
  assert.deepEqual(Object.keys(clean).filter((id) => clean[id] === "fail"), []);
});

test("an unrecognised argument (e.g. a --tamper typo) exits 2 with one stderr line and runs no check", async () => {
  for (const args of [["--tampr"], ["--tamper", "stray"]]) {
    const odd = await runOffline([script, ...args]);
    assert.equal(odd.code, 2, args.join(" "));
    assert.equal(odd.stdout, "");
    assert.equal(odd.stderr, `attest-check: unknown argument ${JSON.stringify(args.at(-1))} (usage: node scripts/attest-check.mjs [--tamper])\n`);
  }
});

test("the verdict line is followed by the Not verified list in both outcomes", async () => {
  for (const args of [[], ["--tamper"]]) {
    const r = await runOffline([script, ...args]);
    const [head, list] = r.stdout.split("\nNot verified:\n");
    assert.ok(list, args.join(" "));
    assert.match(head, /\n\n(CONSISTENT, NOT VERIFIED|REJECT)/);
    assert.equal(list.trimEnd().split("\n").length, 5);
    assert.ok(list.split("\n").every((l) => l === "" || l.startsWith("  - ")));
  }
});

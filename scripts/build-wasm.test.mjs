import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILD_COMMAND, CONTRACTS, buildAll, missingTools } from "./build-wasm.mjs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("build:wasm script exists and points at the build script", () => {
  assert.equal(pkg.scripts["build:wasm"], "node scripts/build-wasm.mjs");
  assert.equal(BUILD_COMMAND, "npm run build:wasm");
});

test("buildAll runs cargo near build non-reproducible-wasm in both contract dirs, with a timeout", () => {
  const calls = [];
  const spawn = (cmd, args, opts) => (calls.push({ cmd, args, opts }), { status: 0 });
  const res = buildAll({ root: "/r", spawn, log: () => {}, timeout: 123 });
  assert.equal(res.length, 2);
  assert.deepEqual(calls.map((c) => c.opts.cwd), ["/r/contracts/personality-nft", "/r/contracts/yield-vault"]);
  for (const c of calls) {
    assert.equal(c.cmd, "cargo");
    assert.deepEqual(c.args, ["near", "build", "non-reproducible-wasm"]);
    assert.equal(c.opts.timeout, 123);
  }
  assert.deepEqual(CONTRACTS.map((c) => c.wasm.split("/").pop()), ["personality_nft.wasm", "yield_vault.wasm"]);
});

test("buildAll stops at the first failure", () => {
  let n = 0;
  const res = buildAll({ spawn: () => (n++, { status: 1 }), log: () => {} });
  assert.equal(n, 1);
  assert.equal(res[0].ok, false);
});

test("live Missing/help text points at npm run build:wasm", () => {
  for (const f of ["yield-live.mjs", "yield-live-once.mjs"]) {
    assert.match(readFileSync(new URL(`./${f}`, import.meta.url), "utf8"), /npm run build:wasm/, f);
  }
});

test("missingTools names cargo and cargo-near when absent, nothing when present", () => {
  const enoent = () => ({ error: new Error("ENOENT") });
  const m = missingTools({ spawn: enoent });
  assert.equal(m.length, 1);
  assert.match(m[0], /^cargo /);
  assert.deepEqual(missingTools({ spawn: () => ({ status: 0 }) }), []);
  const noNear = missingTools({ spawn: (c, a) => ({ status: a[0] === "near" ? 1 : 0 }) });
  assert.match(noNear[0], /cargo-near/);
});

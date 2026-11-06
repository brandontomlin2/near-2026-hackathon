// preflight --require-ready: exit 3 (with the MISSING names on stderr) when READY FOR LIVE is no,
// exit 1 still wins on a FAIL, and the flag is accepted only by dry-run and preflight.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./yield-live.mjs";

const EXAMPLE = new URL("../config/yield-vault.live.example.json", import.meta.url).pathname;
const T = { timeout: 60_000 };

async function run(args, io = {}) {
  const out = [];
  const errs = [];
  const code = await main(args, { log: (...a) => out.push(a.join(" ")), err: (s) => errs.push(s), env: {}, ...io });
  return { code, stdout: out.join("\n"), stderr: errs.join("\n") };
}

test("preflight without --require-ready: example config is not ready but exits 0", T, async () => {
  const r = await run(["preflight"]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /READY FOR LIVE: no/);
  assert.equal(r.stderr, "");
});

test("preflight --require-ready: example config exits 3 and names the MISSING items on stderr", T, async () => {
  const r = await run(["preflight", "--require-ready"]);
  assert.equal(r.code, 3);
  assert.match(r.stdout, /READY FOR LIVE: no/);
  assert.match(r.stderr, /^yield-live: not ready for live \(--require-ready\): .*config complete \(no placeholders\)/);
});

test("preflight --require-ready --json: same exit 3, JSON on stdout", T, async () => {
  const r = await run(["preflight", "--require-ready", "--json"]);
  assert.equal(r.code, 3);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.ready_for_live, false);
  assert.ok(doc.missing.includes("config complete (no placeholders)"));
});

test("preflight --require-ready: a FAIL still exits 1, not 3", T, async () => {
  const c = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  c.owner_id = "Bad_Owner.testnet"; // not a valid account id: the config check FAILs
  const file = join(mkdtempSync(join(tmpdir(), "ylive74-")), "live.json");
  writeFileSync(file, JSON.stringify(c));
  const r = await run(["preflight", "--config", file, "--require-ready"]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^FAIL\s+config fields and ids/m);
});

test("--require-ready is still refused outside a command that knows it", T, async () => {
  const r = await run(["--require-ready"]);
  assert.equal(r.code, 2);
});

// Regression: `verify.sh --live` runs the "deploy nft" stage inside a fresh clone,
// where contracts/personality-nft/target/ (gitignored) does not exist. The stage
// must still pass as a dry run. Runs the exact args verify.sh passes, offline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function plannedArgs() {
  const sh = readFileSync(join(root, "scripts/verify.sh"), "utf8");
  const line = sh.split("\n").find((l) => /^planned "deploy nft" "deploy:nft" /.test(l));
  assert.ok(line, 'verify.sh must have a planned "deploy nft" "deploy:nft" line');
  const rest = line.replace(/^planned "deploy nft" "deploy:nft" /, "").trim().split(/\s+/);
  const kind = rest.shift();
  assert.equal(kind, "live");
  return rest;
}

function deployScriptArgs() {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const cmd = pkg.scripts["deploy:nft"];
  assert.match(cmd, /^node scripts\/testnet-deploy\.mjs deploy$/);
  return cmd.split(/\s+/).slice(1);
}

function run(extra, wasm) {
  return spawnSync("node", [...deployScriptArgs(), ...extra, "--wasm", wasm], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
    env: {
      ...process.env,
      NEAR_NETWORK: "testnet",
      NEAR_CONTRACT_ACCOUNT_ID: "nft-x.testnet",
      NEAR_ACCOUNT_ID: "owner-x.testnet",
    },
  });
}

test("verify.sh deploy nft stage passes when the wasm was never built (fresh clone)", () => {
  const dir = mkdtempSync(join(tmpdir(), "live60-deploy-"));
  try {
    const wasm = join(dir, "missing.wasm");
    const r = run(plannedArgs(), wasm);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const out = r.stdout + r.stderr;
    assert.match(out, /new_default_meta/);
    assert.match(out, /nft-x\.testnet/);
    assert.doesNotMatch(out, /wasm not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without the extra args the same missing-wasm dry run fails (proves the guard)", () => {
  const dir = mkdtempSync(join(tmpdir(), "live60-deploy-"));
  try {
    const r = run([], join(dir, "missing.wasm"));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /wasm not found/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

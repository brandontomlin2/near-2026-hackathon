#!/usr/bin/env node
// Offline build of BOTH wasms the approved live run needs (npm run build:wasm):
//   contracts/personality-nft  -> target/near/personality_nft.wasm
//   contracts/yield-vault      -> target/near/yield_vault.wasm (+ yield_vault_abi.json)
// Each is `cargo near build non-reproducible-wasm` in its own directory, with a timeout.
// Never runs near, reads no key, signs and sends nothing. The wasms stay gitignored.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD_TIMEOUT_MS = 10 * 60 * 1000;
export const BUILD_COMMAND = "npm run build:wasm";
export const CONTRACTS = [
  { name: "personality-nft", dir: "contracts/personality-nft", wasm: "contracts/personality-nft/target/near/personality_nft.wasm" },
  { name: "yield-vault", dir: "contracts/yield-vault", wasm: "contracts/yield-vault/target/near/yield_vault.wasm" },
];

/** Build every contract in order. Returns [{name, ok, detail}]; stops at the first failure. */
export function buildAll({ root = ROOT, spawn = spawnSync, log = console.log, timeout = BUILD_TIMEOUT_MS } = {}) {
  const results = [];
  for (const c of CONTRACTS) {
    log(`building ${c.name}: cargo near build non-reproducible-wasm (${c.dir})`);
    const r = spawn("cargo", ["near", "build", "non-reproducible-wasm"], { cwd: resolve(root, c.dir), encoding: "utf8", timeout, stdio: ["ignore", "inherit", "inherit"] });
    const failed = r.error || r.status !== 0;
    const detail = failed ? (r.error?.message ?? `cargo near exited ${r.status}`) : c.wasm;
    results.push({ name: c.name, ok: !failed, detail });
    if (failed) break;
    if (!existsSync(resolve(root, c.wasm)) && spawn === spawnSync) {
      results[results.length - 1] = { name: c.name, ok: false, detail: `${c.wasm} not found after build` };
      break;
    }
  }
  return results;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const results = buildAll();
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);
  process.exit(results.length === CONTRACTS.length && results.every((r) => r.ok) ? 0 : 1);
}

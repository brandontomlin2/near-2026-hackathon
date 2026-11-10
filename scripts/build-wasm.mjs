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

/** Names of missing build tools, probed with `--version` (cargo, then the cargo-near subcommand). */
export function missingTools({ spawn = spawnSync } = {}) {
  const probes = [["cargo", ["--version"], "cargo (install Rust: https://rustup.rs)"], ["cargo", ["near", "--version"], "cargo-near (install: cargo install cargo-near)"]];
  const missing = [];
  for (const [cmd, args, label] of probes) {
    const r = spawn(cmd, args, { encoding: "utf8", stdio: "ignore", timeout: 30000 });
    if (r.error || r.status !== 0) missing.push(label);
    if (r.error && args[0] === "--version") break; // no cargo: the cargo-near probe cannot work either
  }
  return missing;
}

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
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`${BUILD_COMMAND}: offline build of target/near/personality_nft.wasm and yield_vault.wasm. Needs cargo and cargo-near; signs and sends nothing.`);
    process.exit(0);
  }
  const missing = missingTools();
  if (missing.length) {
    console.error(`Missing: ${missing.join("; ")}. Nothing was built. The offline demos (npm run yield:demo) do not need Rust or the wasms.`);
    process.exit(1);
  }
  const results = buildAll();
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);
  process.exit(results.length === CONTRACTS.length && results.every((r) => r.ok) ? 0 : 1);
}

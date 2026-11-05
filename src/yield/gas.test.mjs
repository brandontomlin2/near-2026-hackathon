import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXECUTE_SWAP_GAS, EXECUTE_SWAP_GAS_CLI, EXECUTE_SWAP_TGAS, TGAS } from "./gas.mjs";

const libRs = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../contracts/yield-vault/src/lib.rs"), "utf8");

test("execute_swap gas equals the contract MIN_EXECUTE_GAS", () => {
  const m = /MIN_EXECUTE_GAS\s*:\s*Gas\s*=\s*Gas::from_tgas\(\s*(\d+)\s*\)/.exec(libRs);
  assert.ok(m, "MIN_EXECUTE_GAS not found in lib.rs");
  const rustTgas = Number(m[1]);
  assert.equal(EXECUTE_SWAP_TGAS, rustTgas);
  assert.equal(EXECUTE_SWAP_GAS, BigInt(rustTgas) * 10n ** 12n);
  assert.equal(EXECUTE_SWAP_GAS, BigInt(rustTgas) * TGAS);
  assert.equal(EXECUTE_SWAP_GAS_CLI, `${rustTgas}.0 Tgas`);
});

// Single source for the execute_swap prepaid gas. Mirrors MIN_EXECUTE_GAS in
// contracts/yield-vault/src/lib.rs (checked with `env::prepaid_gas() >= MIN_EXECUTE_GAS`),
// so prepaying exactly the minimum passes. gas.test.mjs locks this to the Rust constant.

export const TGAS = 10n ** 12n;
export const EXECUTE_SWAP_TGAS = 280;
export const EXECUTE_SWAP_GAS = BigInt(EXECUTE_SWAP_TGAS) * TGAS;
export const EXECUTE_SWAP_GAS_CLI = `${EXECUTE_SWAP_TGAS}.0 Tgas`;

// The execute_swap call: how it is printed (dry run) and how it is sent (testnet only,
// behind --send and --i-approve). The spawner is injectable and the tests never run near-cli-rs.

import { isValidAccountId } from "../anchor/anchor.mjs";
import { EXECUTE_SWAP_GAS_CLI } from "./gas.mjs";
import { vaultArgs } from "./proposal.mjs";

export const NETWORK = "testnet";
export const METHOD = "execute_swap";
export const GAS = EXECUTE_SWAP_GAS_CLI;
export const DEPOSIT = "0 NEAR";

export class RefusalError extends Error {
  /** @param {string} message @param {number} [exitCode] */
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "RefusalError";
    this.exitCode = exitCode;
  }
}

/** The one mainnet-account rule: a named account under .near. Shared with the snapshot parser. */
export function isMainnetAccountId(v) {
  return typeof v === "string" && /\.near$/i.test(v.trim());
}

/** Refuse mainnet before anything else: NEAR_NETWORK=mainnet, or a vault or runner id under .near. */
export function assertNotMainnet(env) {
  if ((env.NEAR_NETWORK ?? "").trim().toLowerCase() === "mainnet") throw new RefusalError("refused: NEAR_NETWORK=mainnet. This tool only ever targets testnet.");
  for (const name of ["YIELD_VAULT_ACCOUNT_ID", "YIELD_RUNNER_ACCOUNT_ID"]) {
    const v = env[name];
    if (isMainnetAccountId(v)) throw new RefusalError(`refused: ${name} ends in .near (mainnet). This tool only ever targets testnet.`);
  }
}

/** The send gate. Everything must hold; the message never echoes an account id value. */
export function assertSendAllowed(env, { approve, agent }) {
  assertNotMainnet(env);
  if (!approve) throw new RefusalError("--send needs --i-approve (explicit human approval). Nothing was sent.", 2);
  if (!agent) throw new RefusalError("--send needs --agent <id>: each vault belongs to one agent. Nothing was sent.", 2);
  if (env.NEAR_NETWORK !== NETWORK) throw new RefusalError(`--send needs NEAR_NETWORK=${NETWORK} set explicitly. Nothing was sent.`);
  for (const name of ["YIELD_VAULT_ACCOUNT_ID", "YIELD_RUNNER_ACCOUNT_ID"]) {
    const v = env[name];
    if (!isValidAccountId(v) || !v.endsWith(`.${NETWORK}`)) {
      throw new RefusalError(`--send needs ${name} set to a named .${NETWORK} account (value not shown). Nothing was sent.`);
    }
  }
  if (env.YIELD_VAULT_ACCOUNT_ID === env.YIELD_RUNNER_ACCOUNT_ID) {
    throw new RefusalError("--send needs the vault and the runner to be different accounts (value not shown). Nothing was sent.");
  }
}

/** near-cli-rs argv for one execute_swap. */
export function buildExecuteSwapArgv({ vault, runner, proposal }) {
  return [
    "contract", "call-function", "as-transaction", vault, METHOD,
    "json-args", JSON.stringify(vaultArgs(proposal)),
    "prepaid-gas", GAS,
    "attached-deposit", DEPOSIT,
    "sign-as", runner,
    "network-config", NETWORK,
    "sign-with-keychain", "send",
  ];
}

const shellQuote = (arg) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`);

export function formatCommand(argv) {
  return ["near", ...argv.map(shellQuote)].join(" ");
}

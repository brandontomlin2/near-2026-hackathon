// The yield vault's live testnet path as a list of UNSIGNED transactions. Pure: no network, no
// signing, no child processes. A config file goes in, an ordered plan comes out, and the plan is
// validated against the contract source (contracts/yield-vault/src/lib.rs): method names, argument
// names, #[payable] / #[private], 1-yocto rules and the MIN_*_GAS constants. The near-cli-rs command
// on each step is text for a human; nothing here ever runs it.

import { readFileSync } from "node:fs";

import { isValidAccountId } from "../anchor/anchor.mjs";
import { EXECUTE_SWAP_GAS, EXECUTE_SWAP_TGAS } from "./gas.mjs";
import { vaultArgs } from "./proposal.mjs";
import { checkProposal, validateVaultConfig } from "./rules.mjs";
import { RefusalError, assertNotMainnet, buildExecuteSwapArgv, formatCommand } from "./send.mjs";
import { EXCHANGE, PLANNER_STRATEGY, WNEAR, defaultVaultConfig, plannerVaultConfig } from "./strategies.mjs";

export const NETWORK = "testnet";
export const AGENT_IDS = Object.freeze(["aloof", "chaotic", "social", "skeptic"]);
export const CONTRACT_SOURCE_URL = new URL("../../contracts/yield-vault/src/lib.rs", import.meta.url);
export const PLACEHOLDER_MARK = "<FILL_ME>";

export const YOCTO_PER_NEAR = 10n ** 24n;
export const TGAS = 10n ** 12n;
// NEAR caps prepaid gas per transaction at 1 PGas (testnet runtime config max_total_prepaid_gas = 1000000000000000).
// https://docs.near.org/protocol/transactions/gas
export const MAX_TX_GAS = 1000n * TGAS;
/** NEAR storage staking: 1e19 yoctoNEAR per byte (1 NEAR per 100 KB). */
export const YOCTO_PER_BYTE = 10n ** 19n;

// ------------------------------------------------------------------------------------ amounts

/** "0.1" -> 10^23 as BigInt. Decimal strings only (no floats, no exponents, at most 24 decimals). */
export function parseNear(text) {
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,24})?$/.test(text)) {
    throw new Error(`not a NEAR amount: ${JSON.stringify(text)} (decimal string, at most 24 decimals)`);
  }
  const [int, frac = ""] = text.split(".");
  return BigInt(int) * YOCTO_PER_NEAR + BigInt(frac.padEnd(24, "0"));
}

/** yocto (BigInt or decimal string) -> shortest exact NEAR decimal string. */
export function formatNear(yocto) {
  const y = BigInt(yocto);
  const int = y / YOCTO_PER_NEAR;
  const frac = (y % YOCTO_PER_NEAR).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : `${int}`;
}

const isUint = (v) => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);

// -------------------------------------------------------------------------- base58 / key checks

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Byte length of a base58 string, or null when it is not base58. */
export function base58ByteLength(s) {
  if (typeof s !== "string" || s === "") return null;
  let n = 0n;
  let lead = 0;
  let leading = true;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    if (leading && i === 0) lead++;
    else leading = false;
    n = n * 58n + BigInt(i);
  }
  let bytes = 0;
  while (n > 0n) {
    bytes++;
    n >>= 8n;
  }
  return lead + bytes;
}

const SECRET_KEY_NAME = /(private|secret|seed|mnemonic|passphrase|password)/i;

/** Throws RefusalError for any field that looks like secret material. Never echoes a value. */
function assertNoSecrets(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((v, i) => assertNoSecrets(v, `${path}[${i}]`));
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_NAME.test(k)) throw new RefusalError(`refused: config field ${path}.${k} looks like a secret (private/secret/seed). The config takes public keys only.`, 2);
      assertNoSecrets(v, `${path}.${k}`);
    }
    return;
  }
  if (typeof value === "string") {
    const m = /^(ed25519|secp256k1):(.*)$/.exec(value.trim());
    if (m && m[2] !== PLACEHOLDER_MARK) {
      const len = base58ByteLength(m[2]);
      if (len !== null && len > 33) throw new RefusalError(`refused: config field ${path} holds a key longer than a public key (private key?). The config takes public keys only.`, 2);
    }
  }
}

/** null when `key` is a well-formed ed25519 public key (or the placeholder), else a reason. */
function publicKeyProblem(key, allowPlaceholder) {
  if (typeof key !== "string") return "must be a string";
  if (key === `ed25519:${PLACEHOLDER_MARK}`) return allowPlaceholder ? null : "is still the placeholder";
  const m = /^ed25519:(.+)$/.exec(key);
  if (!m) return "must look like ed25519:<base58 public key>";
  return base58ByteLength(m[1]) === 32 ? null : "is not a 32-byte base58 ed25519 public key";
}

// ------------------------------------------------------------------------------------- config

const SECTION_KEYS = {
  top: ["placeholders", "network", "owner_id", "vault_id", "runner_id", "nft_contract_id", "token_id", "agent", "vault_profile", "ref_exchange_id", "wasm_path", "public_keys", "funding", "ref_storage_deposit_near", "token_storage_deposit_near", "deposit", "swap", "limits"],
  public_keys: ["vault", "runner"],
  funding: ["vault_initial_near", "runner_initial_near"],
  deposit: ["token_id", "amount"],
  swap: ["pool_id", "token_in", "token_out", "amount_in", "min_amount_out"],
  limits: ["max_deposit_near_per_tx", "max_total_near"],
};

export function loadLiveConfig(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Paths of values that are still placeholders (the `placeholders` flag, <FILL_ME>, the yield-demo ids). */
export function findPlaceholders(config) {
  const out = [];
  if (config?.placeholders === true) out.push("placeholders (flag is true)");
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
    else if (typeof v === "string" && (v.includes(PLACEHOLDER_MARK) || v.includes("yield-demo"))) out.push(path);
  };
  walk(config, "");
  return out;
}

/** `id` is <name>.<parent> with a non-empty <name> that holds no dot (NEAR lets only a direct parent create an account). */
function isDirectChild(parent, id) {
  if (!id.endsWith(`.${parent}`)) return false;
  const name = id.slice(0, -parent.length - 1);
  return name !== "" && !name.includes(".");
}

const isTestnetId = (id) => isValidAccountId(id) && id.endsWith(".testnet");

/** The only vault_profile: the Yield Optimizer planner's vault (what `npm run yield:demo` executes against). */
export const PLANNER_PROFILE = "yield-optimizer";

/**
 * The VaultConfig the `new` call takes, with runners = [runner_id]: the agent's own defaultVaultConfig,
 * or with vault_profile "yield-optimizer" the planner's vault (pools 0, 1 and 747), the same vault
 * `npm run yield:demo` plans its execute_swap against.
 */
export function vaultConfigFor(config) {
  if (config.vault_profile === PLANNER_PROFILE) return plannerVaultConfig({ runner: config.runner_id });
  return defaultVaultConfig(config.agent, { runner: config.runner_id });
}

/** The tokens the vault ever holds or receives: the swap pair, token_in first. */
export function liveTokens(config) {
  return [...new Set([config.swap.token_in, config.swap.token_out])];
}

/**
 * Problems with a live config (empty = fine). Throws RefusalError (exit 2 in the CLI) for mainnet,
 * `.near` ids and anything that looks like a private key or seed: those are never "problems".
 * Placeholders are problems unless `allowPlaceholders` (dry-run lists them as warnings instead).
 */
export function validateLiveConfig(config, { allowPlaceholders = false } = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return ["config must be a JSON object"];
  assertNoSecrets(config);
  assertNotMainnet({ NEAR_NETWORK: config.network });
  const everyString = [];
  (function collect(v) {
    if (typeof v === "string") everyString.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(collect);
  })(config);
  if (everyString.some((s) => /\.near$/i.test(s.trim()))) throw new RefusalError("refused: the config holds an id ending in .near (mainnet). This tool only ever targets testnet.", 2);

  const problems = [];
  const add = (m) => problems.push(m);
  for (const [section, keys] of Object.entries(SECTION_KEYS)) {
    const obj = section === "top" ? config : config[section];
    if (obj === undefined) continue;
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      add(`${section} must be an object`);
      continue;
    }
    for (const k of Object.keys(obj)) if (!keys.includes(k)) add(`unknown field ${section === "top" ? k : `${section}.${k}`}`);
  }
  if (config.network !== NETWORK) add(`network must be "${NETWORK}"`);
  if (config.placeholders !== undefined && typeof config.placeholders !== "boolean") add("placeholders must be a boolean");
  if (!allowPlaceholders) for (const p of findPlaceholders(config)) add(`placeholder not filled in: ${p}`);

  const isPh = (v) => allowPlaceholders && typeof v === "string" && v.includes(PLACEHOLDER_MARK);
  for (const f of ["owner_id", "vault_id", "runner_id", "nft_contract_id", "ref_exchange_id"]) {
    if (!isTestnetId(config[f])) add(`${f} must be a valid named .testnet account id`);
  }
  const { owner_id: owner, vault_id: vault, runner_id: runner } = config;
  if (isTestnetId(owner) && isTestnetId(vault) && !isDirectChild(owner, vault)) add("vault_id must be a direct sub-account of owner_id, <name>.<owner_id> with no dot in <name> (so the owner can create it)");
  if (isTestnetId(owner) && isTestnetId(runner) && !isDirectChild(owner, runner)) add("runner_id must be a direct sub-account of owner_id, <name>.<owner_id> with no dot in <name> (so the owner can create it)");
  if (vault !== undefined && vault === runner) add("runner_id must differ from vault_id");
  if (owner !== undefined && (owner === vault || owner === runner)) add("owner_id must differ from vault_id and runner_id");
  if (!isPh(config.token_id) && !(typeof config.token_id === "string" && /^[a-z0-9_-]{1,64}$/.test(config.token_id))) add("token_id must be 1-64 chars of [a-z0-9_-]");
  if (!AGENT_IDS.includes(config.agent)) add(`agent must be one of ${AGENT_IDS.join(", ")}`);
  if (config.vault_profile !== undefined) {
    if (config.vault_profile !== PLANNER_PROFILE) add(`vault_profile must be "${PLANNER_PROFILE}" when set`);
    else if (config.agent !== PLANNER_STRATEGY) add(`vault_profile "${PLANNER_PROFILE}" needs agent "${PLANNER_STRATEGY}": the vault contract has no fifth strategy, the planner's vault carries ${PLANNER_STRATEGY}`);
  }
  if (typeof config.wasm_path !== "string" || config.wasm_path === "") add("wasm_path must be a non-empty string");
  if (config.ref_exchange_id !== EXCHANGE) add(`ref_exchange_id must be ${EXCHANGE} (the exchange the vault config and fixtures are for)`);

  for (const f of ["vault", "runner"]) {
    const why = publicKeyProblem(config.public_keys?.[f], allowPlaceholders);
    if (why) add(`public_keys.${f} ${why}`);
  }

  const nearField = (path, v) => {
    try {
      return parseNear(v);
    } catch (e) {
      add(`${path}: ${e.message}`);
      return null;
    }
  };
  const vaultFund = nearField("funding.vault_initial_near", config.funding?.vault_initial_near);
  const runnerFund = nearField("funding.runner_initial_near", config.funding?.runner_initial_near);
  if (vaultFund !== null && vaultFund === 0n) add("funding.vault_initial_near must be > 0");
  if (runnerFund !== null && runnerFund === 0n) add("funding.runner_initial_near must be > 0");
  const refDep = nearField("ref_storage_deposit_near", config.ref_storage_deposit_near);
  if (refDep !== null && refDep === 0n) add("ref_storage_deposit_near must be > 0 (register_on_ref needs a deposit)");
  const tokDep = nearField("token_storage_deposit_near", config.token_storage_deposit_near);
  if (tokDep !== null && tokDep === 0n) add("token_storage_deposit_near must be > 0");
  nearField("limits.max_deposit_near_per_tx", config.limits?.max_deposit_near_per_tx);
  nearField("limits.max_total_near", config.limits?.max_total_near);

  if (!isTestnetId(config.deposit?.token_id)) add("deposit.token_id must be a valid named .testnet account id");
  if (!isUint(config.deposit?.amount) || config.deposit?.amount === "0") add("deposit.amount must be a positive decimal integer string (base units)");
  const sw = config.swap ?? {};
  if (!Number.isSafeInteger(sw.pool_id) || sw.pool_id < 0) add("swap.pool_id must be a non-negative integer");
  for (const f of ["token_in", "token_out"]) if (!isTestnetId(sw[f])) add(`swap.${f} must be a valid named .testnet account id`);
  for (const f of ["amount_in", "min_amount_out"]) if (!isUint(sw[f]) || sw[f] === "0") add(`swap.${f} must be a positive decimal integer string (base units)`);

  // Cross-checks against the VaultConfig and the vault's hard rules.
  if (AGENT_IDS.includes(config.agent) && isTestnetId(runner)) {
    const vc = vaultConfigFor(config);
    for (const p of validateVaultConfig(vc)) add(`vault config: ${p}`);
    if (isUint(config.deposit?.amount) && isTestnetId(config.deposit?.token_id)) {
      const known = new Set(vc.allowed_pools.flatMap((p) => [p.token_a, p.token_b]));
      if (!known.has(config.deposit.token_id)) add(`deposit.token_id ${config.deposit.token_id} is in no allowed pool of the ${config.agent} vault; ft_on_transfer would refund it`);
      if (sw.token_in !== config.deposit.token_id) add("swap.token_in must be the deposited token (the vault only holds deposit.token_id)");
      else if (isUint(sw.amount_in) && BigInt(sw.amount_in) > BigInt(config.deposit.amount)) add("swap.amount_in exceeds deposit.amount");
    }
    if (isUint(sw.amount_in) && isUint(sw.min_amount_out) && isUint(config.deposit?.amount) && Number.isSafeInteger(sw.pool_id) && isTestnetId(sw.token_in) && isTestnetId(sw.token_out)) {
      const hard = checkProposal(vaultArgs(sw).proposal, vc, { balances: { [config.deposit.token_id]: config.deposit.amount } }, runner, Date.now());
      if (!hard.ok) add(`swap would fail the vault's hard rules (${hard.code}): ${hard.reason}`);
    }
  }
  return problems;
}

// ----------------------------------------------------------------------------- near-cli text

const tgasText = (gas) => `${BigInt(gas) / TGAS} Tgas`;
const depositText = (yocto) => {
  const y = BigInt(yocto);
  return y === 0n ? "0 NEAR" : y === 1n ? "1 yoctoNEAR" : `${formatNear(y)} NEAR`;
};

/**
 * The near-cli-rs command a human would run for a step (TEXT ONLY, never executed). All the
 * near-cli-rs syntax lives in this one helper so it is easy to fix.
 */
export function nearCliFor(step, { network = NETWORK, owner_id: owner } = {}) {
  const actions = step.actions;
  const kinds = actions.map((a) => a.type).join("+");
  if (kinds === "ViewCall") {
    const a = actions[0];
    return formatCommand(["contract", "call-function", "as-read-only", step.receiver_id, a.method_name, "json-args", JSON.stringify(a.args), "network-config", network, "now"]);
  }
  if (kinds === "CreateAccount+Transfer+AddKey") {
    return formatCommand([
      "account", "create-account", "fund-myself", step.receiver_id, depositText(actions[1].deposit_yocto),
      "use-manually-provided-public-key", actions[2].public_key, "sign-as", step.signer_id, "network-config", network, "sign-with-keychain", "send",
    ]);
  }
  if (kinds === "DeployContract+FunctionCall") {
    const [d, f] = actions;
    return formatCommand([
      "contract", "deploy", step.receiver_id, "use-file", d.wasm_path, "with-init-call", f.method_name, "json-args", JSON.stringify(f.args),
      "prepaid-gas", tgasText(f.gas), "attached-deposit", depositText(f.deposit_yocto), "network-config", network, "sign-with-keychain", "send",
    ]);
  }
  if (kinds === "FunctionCall") {
    const f = actions[0];
    if (f.method_name === "execute_swap" && f.gas === String(EXECUTE_SWAP_GAS) && f.deposit_yocto === "0") {
      return formatCommand(buildExecuteSwapArgv({ vault: step.receiver_id, runner: step.signer_id, proposal: f.args.proposal }));
    }
    return formatCommand([
      "contract", "call-function", "as-transaction", step.receiver_id, f.method_name, "json-args", JSON.stringify(f.args),
      "prepaid-gas", tgasText(f.gas), "attached-deposit", depositText(f.deposit_yocto), "sign-as", step.signer_id, "network-config", network, "sign-with-keychain", "send",
    ]);
  }
  if (kinds === "DeleteAccount") {
    return formatCommand(["account", "delete-account", step.receiver_id, "beneficiary", actions[0].beneficiary_id ?? owner, "network-config", network, "sign-with-keychain", "send"]);
  }
  throw new Error(`no near-cli-rs rendering for actions ${kinds}`);
}

// ------------------------------------------------------------------------------------- plan

const call = (method_name, args, tgas, deposit = 0n) => ({
  type: "FunctionCall",
  method_name,
  args,
  deposit_yocto: BigInt(deposit).toString(),
  gas: (BigInt(tgas) * TGAS).toString(),
});
const viewCall = (method_name, args = {}) => ({ type: "ViewCall", method_name, args });

/** Marker for an argument only known at run time: the result of a view step. */
export const RUNTIME_MARKER = /^<READ (\w+)\(([^)]*)\) at step ([\w-]+)>$/;
const runtimeMarker = (method, arg, stepId) => `<READ ${method}(${arg}) at step ${stepId}>`;

/** The ordered, unsigned plan for a config. Throws if the config does not validate (placeholders allowed). */
export function buildLivePlan(config) {
  const problems = validateLiveConfig(config, { allowPlaceholders: true });
  if (problems.length) throw new Error(`invalid live config: ${problems.join("; ")}`);
  const { owner_id: owner, vault_id: vault, runner_id: runner, ref_exchange_id: ref } = config;
  const vc = vaultConfigFor(config);
  const proposal = vaultArgs(config.swap).proposal;
  const tokens = liveTokens(config);
  const dep = BigInt(config.deposit.amount);
  const tokDep = parseNear(config.token_storage_deposit_near);
  const steps = [];
  const used = new Map();
  const step = (id, phase, title, signer_id, receiver_id, actions, expect, extra = {}) => {
    const n = (used.get(id) ?? 0) + 1;
    used.set(id, n);
    const view = actions[0].type === "ViewCall";
    const deposit = view ? 0n : actions.reduce((s, a) => s + BigInt(a.deposit_yocto ?? 0), 0n);
    const s = { id: n > 1 ? `${id}-${n}` : id, title, phase, signer_id: view ? null : signer_id, receiver_id, actions, ...(view ? { view: true } : {}), expect, cost_near: formatNear(deposit) };
    s.near_cli = nearCliFor(s, { owner_id: owner });
    steps.push({ ...s, ...extra });
    return s.id;
  };
  const create = (id, account, fundNear, pk, who) =>
    step(id, "setup", `create and fund the ${who} account`, owner, account, [{ type: "CreateAccount" }, { type: "Transfer", deposit_yocto: parseNear(fundNear).toString() }, { type: "AddKey", public_key: pk, access: "FullAccess" }], `${account} exists with ${fundNear} NEAR and the ${who} key`);

  create("create-vault", vault, config.funding.vault_initial_near, config.public_keys.vault, "vault");
  create("create-runner", runner, config.funding.runner_initial_near, config.public_keys.runner, "runner");
  step("deploy-init", "setup", "deploy the vault wasm and call new in one transaction", vault, vault, [
    { type: "DeployContract", wasm_path: config.wasm_path },
    call("new", { owner_id: owner, nft_contract_id: config.nft_contract_id, token_id: config.token_id, ref_exchange_id: ref, config: vc }, 100),
  ], "both actions succeed (new is only callable by the vault account itself, so it must be this transaction)");
  step("view-config", "check", "read the stored config", null, vault, [viewCall("get_config")], `runners == [${runner}], strategy == ${config.agent}${config.vault_profile === PLANNER_PROFILE ? ` (the ${PLANNER_PROFILE} planner vault: pools 0, 1 and 747)` : ""}`);
  step("view-state", "check", "read the vault state", null, vault, [viewCall("get_state")], "paused == false, nothing in flight");

  for (const t of tokens) {
    step("storage-bounds", "check", `read ${t}'s storage bounds`, null, t, [viewCall("storage_balance_bounds")], `min <= ${config.token_storage_deposit_near} NEAR (token_storage_deposit_near)`);
    step("storage-deposit", "fund", `register the vault on ${t}`, owner, t, [call("storage_deposit", { account_id: vault, registration_only: true }, 30, tokDep)], `${t} storage_balance_of(${vault}) is not null`);
    step("storage-deposit", "fund", `register the owner on ${t} (so withdrawals can land)`, owner, t, [call("storage_deposit", { account_id: owner, registration_only: true }, 30, tokDep)], `${t} storage_balance_of(${owner}) is not null`);
  }
  const manual = [];
  if (config.deposit.token_id === WNEAR) {
    step("wrap-near", "fund", `wrap ${formatNear(dep)} NEAR into wNEAR`, owner, WNEAR, [call("near_deposit", {}, 30, dep)], `owner holds at least ${config.deposit.amount} wNEAR (ft_balance_of)`);
  } else {
    manual.push(`the owner must already hold ${config.deposit.amount} base units of ${config.deposit.token_id} (the plan can only wrap NEAR into ${WNEAR}, so it cannot fund this token)`);
  }
  step("ref-bounds", "check", "read Ref's storage bounds", null, ref, [viewCall("storage_balance_bounds")], "min <= ref_storage_deposit_near; note per-token storage Ref needs");
  step("register-on-ref", "fund", "pay the vault's Ref storage", owner, vault, [call("register_on_ref", {}, 100, parseNear(config.ref_storage_deposit_near))], "registered_on_ref event; Ref storage_balance_of(vault) is not null");
  step("ref-storage-of", "check", "read the vault's Ref storage balance", null, ref, [viewCall("storage_balance_of", { account_id: vault })], "total >= storage_balance_bounds.min");
  step("deposit-into-vault", "fund", `deposit ${config.deposit.amount} of ${config.deposit.token_id} into the vault`, owner, config.deposit.token_id, [call("ft_transfer_call", { receiver_id: vault, amount: config.deposit.amount, msg: "" }, 100, 1n)], "vault ft_on_transfer accepts the owner's deposit (token is in an allowed pool): deposit event, nothing refunded");
  step("view-balance", "check", "read the vault's tracked balance", null, vault, [viewCall("get_balance", { token_id: config.deposit.token_id })], `== ${config.deposit.amount}`);
  step("check-proposal", "check", "run the swap rules without side effects", null, vault, [viewCall("check_proposal", { proposal, runner_id: runner })], "ok == true");
  step("execute-swap", "swap", `runner swaps ${proposal.amount_in} ${proposal.token_in} -> ${proposal.token_out} on pool ${proposal.pool_id}`, runner, vault, [call("execute_swap", { proposal }, EXECUTE_SWAP_TGAS)], "swap_executed event; balance of token_out >= min_amount_out");
  step("view-state", "check", "read the vault state after the swap", null, vault, [viewCall("get_state")], "no swap in flight, swaps_executed == 1, nothing stranded");
  step("ref-deposit-out", "check", "read what is left on Ref for token_out", null, ref, [viewCall("get_deposit", { account_id: vault, token_id: proposal.token_out })], "0 (the chain withdrew it back to the vault)");
  const outBal = step("view-balance", "check", "read the vault's token_out balance", null, vault, [viewCall("get_balance", { token_id: proposal.token_out })], `>= ${proposal.min_amount_out}`);
  const inBal = step("view-balance", "check", "read the vault's unswapped token_in balance", null, vault, [viewCall("get_balance", { token_id: proposal.token_in })], `${BigInt(config.deposit.amount) - BigInt(proposal.amount_in)} if the swap took exactly amount_in (Ref may accept less)`);

  // The amounts below are only knowable at run time (the swap output, whatever Ref accepted), so they are
  // runtime values: a marker in args and a runtime_args entry naming the view step whose result fills it.
  step("withdraw-out", "withdraw", `owner withdraws the whole token_out balance of ${proposal.token_out}`, owner, vault, [call("withdraw", { token_id: proposal.token_out, amount: runtimeMarker("get_balance", proposal.token_out, outBal) }, 100, 1n)], "withdraw event; owner ft_balance_of(token_out) rose; the vault's token_out balance is 0", { runtime_args: { amount: { from_step: outBal, path: "result" } } });
  step("withdraw-rest", "withdraw", `owner withdraws the unswapped ${proposal.token_in} balance`, owner, vault, [call("withdraw", { token_id: proposal.token_in, amount: runtimeMarker("get_balance", proposal.token_in, inBal) }, 100, 1n)], "withdraw event; vault get_balance(token_in) == 0. Skip this step if the value read is 0 (withdraw rejects a zero amount).", { runtime_args: { amount: { from_step: inBal, path: "result" } } });
  step("owner-balance", "check", "read the owner's token_out balance", null, proposal.token_out, [viewCall("ft_balance_of", { account_id: owner })], `>= ${proposal.min_amount_out}`);

  step("pause", "rollback", "pause the vault", owner, vault, [call("pause", {}, 30, 1n)], "paused event");
  step("revoke-runners", "rollback", "revoke every runner", owner, vault, [call("revoke_all_runners", {}, 30, 1n)], "runner_revoked event; get_config().runners == []");
  step("withdraw-ref-storage", "rollback", "pull the Ref storage balance back to the vault account", owner, vault, [call("withdraw_ref_storage", {}, 100, 1n)], "ref_storage_withdraw event; NEAR returns to the vault account");
  const free = step("view-withdrawable", "check", "read how much NEAR the owner can withdraw", null, vault, [viewCall("get_withdrawable_near")], "the amount withdraw_near takes next (account balance minus storage cost minus a 0.1 NEAR reserve)");
  step("withdraw-near", "rollback", "send the free NEAR from the vault to the owner", owner, vault, [call("withdraw_near", { amount: runtimeMarker("get_withdrawable_near", "", free) }, 30, 1n)], "near_withdrawn event. Skip this step if the value read is 0. Optional: delete-vault sends the remaining NEAR to the owner anyway.", { runtime_args: { amount: { from_step: free, path: "result" } } });
  step("pre-delete-state", "check", "read the vault state before deleting it", null, vault, [viewCall("get_state")], "balances, stranded_on_ref, unverified_on_ref all empty or zero; swap_in_flight, recovery_in_flight, release_in_flight false");
  for (const t of tokens) {
    step("pre-delete-ref-deposit", "check", `read what Ref still holds of ${t} for the vault`, null, ref, [viewCall("get_deposit", { account_id: vault, token_id: t })], "0");
  }
  step("delete-vault", "rollback", "delete the vault account (destroys any tokens it still holds on token contracts or Ref)", vault, vault, [{ type: "DeleteAccount", beneficiary_id: owner }], `${vault} no longer exists. Deleting it destroys any tokens still held for it on the token contracts or on Ref; only run it after the pre-delete checks are clean. The beneficiary ${owner} receives the remaining NEAR, so withdraw_near is only needed if you keep the account. The vault's per-token storage deposits (${config.token_storage_deposit_near} NEAR each) and any Ref storage still locked by token entries are forfeited: the plan has no storage_unregister step.`);
  step("delete-runner", "rollback", "delete the runner account", runner, runner, [{ type: "DeleteAccount", beneficiary_id: owner }], `${runner} no longer exists; its NEAR went to ${owner}`);

  return {
    network: NETWORK,
    unsigned: true,
    owner_id: owner,
    vault_id: vault,
    runner_id: runner,
    limits: { max_deposit_per_tx_yocto: parseNear(config.limits.max_deposit_near_per_tx).toString(), max_total_yocto: parseNear(config.limits.max_total_near).toString() },
    manual,
    steps,
  };
}

/**
 * Where the pre-send path ends. Steps [0, count) are setup: deploy, fund, the one small execute_swap
 * and its read-back. Everything after (withdraw, rollback and their checks) is deferred until
 * after the agent send, because it empties, pauses or deletes the vault the agent send needs.
 */
export function setupStepCount(plan) {
  const at = plan.steps.findIndex((s) => s.actions.some((a) => a.type === "FunctionCall" && a.method_name === "execute_swap"));
  if (at < 0) throw new Error("the plan has no execute_swap step");
  const end = at + 2; // the swap and the get_state read-back right after it
  if (plan.steps[at + 1]?.id !== "view-state-2") throw new Error("the plan has no read-back after the execute_swap step");
  return end;
}

// --------------------------------------------------------------------------- Rust source parse

/** Replace comments and string literals with blanks so braces and keywords inside them cannot confuse the parser. */
function stripRust(src) {
  let out = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') i += src[i] === "\\" ? 2 : 1;
      i++;
      out += '""';
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Index of the delimiter closing the one at `open` (same kind, nested), or -1. */
function matching(text, open) {
  const pair = { "(": ")", "{": "}", "[": "]" }[text[open]];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === text[open]) depth++;
    else if (text[i] === pair && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of text) {
    if ("<([".includes(ch)) depth++;
    else if (">)]".includes(ch)) depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Attributes written directly above the item that starts at `idx`. */
function attributesBefore(text, idx) {
  const attrs = [];
  let pos = idx;
  for (;;) {
    while (pos > 0 && /\s/.test(text[pos - 1])) pos--;
    if (text[pos - 1] !== "]") break;
    let depth = 0;
    let i = pos - 1;
    for (; i >= 0; i--) {
      if (text[i] === "]") depth++;
      else if (text[i] === "[" && --depth === 0) break;
    }
    if (i < 1 || text[i - 1] !== "#") break;
    attrs.push(text.slice(i - 1, pos).replace(/\s+/g, ""));
    pos = i - 1;
  }
  return attrs;
}

/**
 * pub fn items inside the `#[near] impl YieldVault` blocks of the contract source.
 * @returns {Map<string, { name: string, payable: boolean, private: boolean, init: boolean, view: boolean, args: string[], argTypes: Record<string,string>, optional: string[], oneYocto: boolean, depositRequired: boolean }>}
 */
export function parseContractMethods(rustSource) {
  const src = stripRust(rustSource);
  const methods = new Map();
  const implRe = /#\[near\]\s*impl\s+YieldVault\s*\{/g;
  let im;
  while ((im = implRe.exec(src))) {
    const open = im.index + im[0].length - 1;
    const close = matching(src, open);
    const block = src.slice(open, close);
    const fnRe = /\bpub\s+fn\s+(\w+)\s*\(/g;
    let fm;
    while ((fm = fnRe.exec(block))) {
      const attrs = attributesBefore(block, fm.index);
      const argOpen = fm.index + fm[0].length - 1;
      const argClose = matching(block, argOpen);
      const rawArgs = splitTopLevel(block.slice(argOpen + 1, argClose).replace(/#\[[^\]]*\]/g, ""));
      const view = rawArgs.some((a) => /^&\s*self$/.test(a));
      const args = [];
      const argTypes = {};
      const optional = [];
      for (const a of rawArgs) {
        if (/^(&\s*(mut\s+)?)?self$/.test(a)) continue;
        const c = a.indexOf(":");
        const name = a.slice(0, c).trim().replace(/^mut\s+/, "");
        const type = a.slice(c + 1).trim();
        args.push(name);
        argTypes[name] = type;
        if (/^Option\s*</.test(type)) optional.push(name);
      }
      const bodyOpen = block.indexOf("{", argClose);
      const body = block.slice(bodyOpen, matching(block, bodyOpen));
      methods.set(fm[1], {
        name: fm[1],
        payable: attrs.includes("#[payable]"),
        private: attrs.includes("#[private]"),
        init: attrs.includes("#[init]"),
        view,
        args,
        argTypes,
        optional,
        oneYocto: /\b(assert_one_yocto|owner_one_yocto)\s*\(/.test(body),
        depositRequired: /require!\(\s*!\s*\w+\.is_zero\(\)/.test(body),
      });
    }
  }
  return methods;
}

/** MIN_*_GAS constants as yocto-gas BigInts, by constant name. */
export function parseMinGas(rustSource) {
  const out = {};
  for (const m of stripRust(rustSource).matchAll(/pub\s+const\s+(MIN_\w+_GAS)\s*:\s*Gas\s*=\s*Gas::from_tgas\(\s*(\d+)\s*\)/g)) out[m[1]] = BigInt(m[2]) * TGAS;
  return out;
}

export const MIN_GAS_CONSTANT = Object.freeze({
  execute_swap: "MIN_EXECUTE_GAS",
  withdraw: "MIN_WITHDRAW_GAS",
  register_on_ref: "MIN_REGISTER_GAS",
  recover_from_ref: "MIN_RECOVER_GAS",
  force_release_lock: "MIN_FORCE_RELEASE_GAS",
  withdraw_ref_storage: "MIN_STORAGE_WITHDRAW_GAS",
  sync_balance: "MIN_SYNC_GAS",
});

/** Parses lib.rs (default: the repo's) into { methods, minGas }. */
export function loadContractSpec(path = CONTRACT_SOURCE_URL) {
  const src = readFileSync(path, "utf8");
  return { methods: parseContractMethods(src), minGas: parseMinGas(src) };
}

// ------------------------------------------------------------------- non-vault method table

// Methods the plan may call on Ref and the token contracts. Hand-written from NEP-141 / NEP-145 / Ref's
// public interface (the same names the vault itself calls). Anything else is flagged.
const EXTERNAL_METHODS = {
  storage_deposit: { required: [], optional: ["account_id", "registration_only"], deposit: "positive" },
  storage_withdraw: { required: [], optional: ["amount"], deposit: "one" },
  ft_transfer_call: { required: ["receiver_id", "amount", "msg"], optional: ["memo"], deposit: "one" },
  ft_transfer: { required: ["receiver_id", "amount"], optional: ["memo"], deposit: "one" },
  near_deposit: { required: [], optional: [], deposit: "positive" },
  storage_balance_of: { view: true, required: ["account_id"], optional: [] },
  storage_balance_bounds: { view: true, required: [], optional: [] },
  get_deposit: { view: true, required: ["account_id", "token_id"], optional: [] },
  get_deposits: { view: true, required: ["account_id"], optional: [] },
  ft_balance_of: { view: true, required: ["account_id"], optional: [] },
};

// ----------------------------------------------------------------------------- plan validation

/**
 * Checks a plan against the contract source. `contractMethods` comes from parseContractMethods;
 * `opts.minGas` from parseMinGas (needed for the MIN_*_GAS checks).
 * @returns {string[]} problems, empty when the plan is consistent with the contract
 */
export function validatePlan(plan, contractMethods, { minGas = {} } = {}) {
  const problems = [];
  const owner = plan.owner_id;
  const vault = plan.vault_id;
  const maxDeposit = BigInt(plan.limits.max_deposit_per_tx_yocto);
  const maxTotal = BigInt(plan.limits.max_total_yocto);
  let outflow = 0n;

  const checkArgs = (where, spec, args) => {
    const given = Object.keys(args ?? {});
    for (const a of spec.required) if (!given.includes(a)) problems.push(`${where}: missing argument ${a}`);
    for (const a of given) if (!spec.required.includes(a) && !spec.optional.includes(a)) problems.push(`${where}: unexpected argument ${a}`);
  };
  const checkU128 = (where, spec, args) => {
    for (const [name, type] of Object.entries(spec.argTypes ?? {})) {
      if (/\bU128\b/.test(type) && !/^Option/.test(type) && args && name in args && !isUint(args[name]) && !(typeof args[name] === "string" && RUNTIME_MARKER.test(args[name]))) problems.push(`${where}: argument ${name} must be a decimal string (U128)`);
    }
  };
  const vaultSpec = (m) => {
    const c = contractMethods.get(m);
    return c ? { ...c, required: c.args.filter((a) => !c.optional.includes(a)) } : null;
  };

  const index = new Map(plan.steps.map((st, i) => [st.id, i]));
  for (const [i, s] of plan.steps.entries()) {
    const at = (m) => `${s.id}: ${m}`;
    problems.push(...runtimeProblems(plan, s, i, index));
    if (/\.near$/i.test(s.receiver_id ?? "") || /\.near$/i.test(s.signer_id ?? "")) problems.push(at("mainnet (.near) account"));
    if (!s.actions?.length) {
      problems.push(at("no actions"));
      continue;
    }
    let txGas = 0n;
    let txDeposit = 0n;
    for (const a of s.actions) {
      if (a.type === "ViewCall") {
        if (!s.view) problems.push(at("ViewCall in a step not marked view"));
        if ("gas" in a || "deposit_yocto" in a) problems.push(at("a view call carries gas or a deposit"));
        if (s.receiver_id === vault) {
          const spec = vaultSpec(a.method_name);
          if (!spec) problems.push(at(`view method ${a.method_name} does not exist on the vault`));
          else {
            if (!spec.view) problems.push(at(`${a.method_name} is not a view (&self) method`));
            checkArgs(at(a.method_name), spec, a.args);
            checkU128(at(a.method_name), spec, a.args);
          }
        } else {
          const spec = EXTERNAL_METHODS[a.method_name];
          if (!spec) problems.push(at(`unknown method ${a.method_name} on ${s.receiver_id}`));
          else {
            if (!spec.view) problems.push(at(`${a.method_name} is not a view method`));
            checkArgs(at(a.method_name), spec, a.args);
          }
        }
      } else if (a.type === "FunctionCall") {
        if (s.view) problems.push(at("a view step holds a FunctionCall"));
        const gas = isUint(a.gas) ? BigInt(a.gas) : null;
        const dep = isUint(a.deposit_yocto) ? BigInt(a.deposit_yocto) : null;
        if (gas === null) problems.push(at(`${a.method_name}: gas must be a decimal string`));
        if (dep === null) problems.push(at(`${a.method_name}: deposit_yocto must be a decimal string`));
        if (gas === null || dep === null) continue;
        txGas += gas;
        txDeposit += dep;
        const where = at(a.method_name);
        if (s.receiver_id === vault) {
          const spec = vaultSpec(a.method_name);
          if (!spec) {
            problems.push(at(`method ${a.method_name} does not exist on the vault`));
            continue;
          }
          if (spec.private) problems.push(where + " is #[private]; only the contract itself can call it");
          if (spec.view) problems.push(where + " is a view method, not a transaction");
          checkArgs(where, spec, a.args);
          checkU128(where, spec, a.args);
          if (!spec.payable && dep !== 0n) problems.push(`${where}: deposit > 0 on a method that is not #[payable]`);
          if (spec.payable && spec.oneYocto && dep !== 1n) problems.push(`${where}: needs exactly 1 yoctoNEAR, got ${dep}`);
          if (spec.payable && !spec.oneYocto && spec.depositRequired && dep === 0n) problems.push(`${where}: needs a deposit > 0`);
          const constant = MIN_GAS_CONSTANT[a.method_name];
          if (constant) {
            if (minGas[constant] === undefined) problems.push(`${where}: ${constant} not found in the contract source`);
            else if (gas < minGas[constant]) problems.push(`${where}: gas ${gas} is below ${constant} (${minGas[constant]})`);
          }
          const role = spec.init ? vault : a.method_name === "execute_swap" ? plan.runner_id : owner;
          if (s.signer_id !== role) problems.push(`${where}: must be signed by ${role}`);
        } else {
          const spec = EXTERNAL_METHODS[a.method_name];
          if (!spec) {
            problems.push(at(`unknown method ${a.method_name} on ${s.receiver_id}`));
            continue;
          }
          if (spec.view) problems.push(`${where} is a view method, not a transaction`);
          checkArgs(where, spec, a.args);
          if (spec.deposit === "one" && dep !== 1n) problems.push(`${where}: needs exactly 1 yoctoNEAR, got ${dep}`);
          if (spec.deposit === "positive" && dep === 0n) problems.push(`${where}: needs a deposit > 0`);
        }
      } else if (a.type === "Transfer") {
        if (!isUint(a.deposit_yocto)) problems.push(at("Transfer deposit_yocto must be a decimal string"));
        else txDeposit += BigInt(a.deposit_yocto);
      } else if (a.type === "AddKey") {
        if (publicKeyProblem(a.public_key, true)) problems.push(at(`AddKey public_key ${publicKeyProblem(a.public_key, true)}`));
        if (a.access !== "FullAccess") problems.push(at("AddKey access must be FullAccess"));
      } else if (a.type === "DeleteAccount") {
        if (a.beneficiary_id !== owner) problems.push(at("DeleteAccount beneficiary must be the owner"));
        if (s.signer_id !== s.receiver_id) problems.push(at("an account can only be deleted by itself"));
      } else if (!["CreateAccount", "DeployContract"].includes(a.type)) {
        problems.push(at(`unknown action type ${a.type}`));
      }
    }
    if (txGas > MAX_TX_GAS) problems.push(at(`transaction gas ${txGas} is above the 1000 TGas (1 PGas) per-transaction limit`));
    if (txDeposit > maxDeposit) problems.push(at(`deposit ${formatNear(txDeposit)} NEAR is above limits.max_deposit_near_per_tx (${formatNear(maxDeposit)})`));
    if (!s.view && s.signer_id === owner) outflow += txDeposit;
  }
  problems.push(...orderingProblems(plan));
  if (outflow > maxTotal) problems.push(`NEAR leaving the owner (${formatNear(outflow)}) is above limits.max_total_near (${formatNear(maxTotal)})`);
  return problems;
}

/** Totals for display: transaction and view counts, deposits, gas and the owner's NEAR outflow. */
export function planTotals(plan) {
  let deposit = 0n;
  let security = 0n; // 1-yocto security deposits
  let gas = 0n;
  let outflow = 0n;
  let outflowSecurity = 0n;
  let transactions = 0;
  let views = 0;
  for (const s of plan.steps) {
    if (s.view) {
      views++;
      continue;
    }
    transactions++;
    const d = s.actions.reduce((x, a) => x + BigInt(a.deposit_yocto ?? 0), 0n);
    const one = BigInt(s.actions.filter((a) => a.type === "FunctionCall" && a.deposit_yocto === "1").length);
    deposit += d;
    security += one;
    gas += s.actions.reduce((x, a) => x + BigInt(a.gas ?? 0), 0n);
    if (s.signer_id === plan.owner_id) {
      outflow += d;
      outflowSecurity += one;
    }
  }
  return {
    transactions,
    views,
    // NEAR without the 1-yocto security deposits, the yocto count of those, and the exact totals.
    deposit_near: formatNear(deposit - security),
    deposit_security_yocto: security.toString(),
    deposit_yocto: deposit.toString(),
    owner_outflow_near: formatNear(outflow - outflowSecurity),
    owner_outflow_security_yocto: outflowSecurity.toString(),
    owner_outflow_yocto: outflow.toString(),
    gas_tgas: (gas / TGAS).toString(),
  };
}

/** "8.525 NEAR + 7 yocto (1-yocto security deposits)" */
export function formatSplit(near, securityYocto) {
  return `${near} NEAR + ${securityYocto} yocto (1-yocto security deposits)`;
}

// ------------------------------------------------------------------------------- built ABI

/** cargo-near writes <name>_abi.json next to <name>.wasm. */
export function abiPathFor(wasmPath) {
  return wasmPath.replace(/\.wasm$/, "") + "_abi.json";
}

const abiOptional = (schema) =>
  Array.isArray(schema?.type) ? schema.type.includes("null") : [...(schema?.anyOf ?? []), ...(schema?.oneOf ?? [])].some((x) => x?.type === "null");

/**
 * Method table from a NEAR ABI document (body.functions[]), shaped like parseContractMethods.
 * ABI has no 1-yocto / deposit-required info, so those two flags are taken from `sourceMethods`.
 */
export function parseAbiMethods(abi, sourceMethods = new Map()) {
  const out = new Map();
  for (const f of abi?.body?.functions ?? []) {
    const args = f.params?.args ?? [];
    const src = sourceMethods.get(f.name);
    out.set(f.name, {
      name: f.name,
      payable: (f.modifiers ?? []).includes("payable"),
      private: (f.modifiers ?? []).includes("private"),
      init: (f.modifiers ?? []).includes("init"),
      view: f.kind === "view",
      args: args.map((a) => a.name),
      argTypes: src?.argTypes ?? {}, // the ABI types U128 as a plain string; the Rust type is more precise
      optional: args.filter((a) => abiOptional(a.type_schema)).map((a) => a.name),
      oneYocto: src?.oneYocto ?? false,
      depositRequired: src?.depositRequired ?? false,
    });
  }
  return out;
}

/**
 * Disagreements between the lib.rs parse and the ABI cargo-near built, over the non-callback
 * methods (name, view/call, payable, init, arg names). A disagreement means a parser bug or a stale ABI.
 */
export function compareMethods(sourceMethods, abiMethods) {
  const problems = [];
  for (const [name, s] of sourceMethods) {
    const a = abiMethods.get(name);
    if (!a) {
      if (!s.private) problems.push(`${name}: in lib.rs but not in the ABI (stale build?)`);
      continue;
    }
    if (s.private !== a.private) problems.push(`${name}: #[private] differs (lib.rs ${s.private}, ABI ${a.private})`);
    if (s.private || a.private) continue;
    if (s.view !== a.view) problems.push(`${name}: view/call differs (lib.rs ${s.view ? "view" : "call"}, ABI ${a.view ? "view" : "call"})`);
    if (s.payable !== a.payable) problems.push(`${name}: #[payable] differs (lib.rs ${s.payable}, ABI ${a.payable})`);
    if (s.init !== a.init) problems.push(`${name}: #[init] differs (lib.rs ${s.init}, ABI ${a.init})`);
    if (s.args.join(",") !== a.args.join(",")) problems.push(`${name}: args differ (lib.rs [${s.args}], ABI [${a.args}])`);
  }
  for (const [name, a] of abiMethods) if (!a.private && !sourceMethods.has(name) && name !== "contract_source_metadata") problems.push(`${name}: in the ABI but not parsed from lib.rs (parser bug?)`);
  return problems;
}

// ------------------------------------------------------------- runtime values and ordering

/** Problems with the step's runtime markers: every marker is declared, every declaration is backed by an earlier view. */
function runtimeProblems(plan, s, i, index) {
  const out = [];
  const at = (m) => `${s.id}: ${m}`;
  const declared = s.runtime_args ?? {};
  const calls = s.actions.filter((a) => a.type === "FunctionCall");
  for (const a of calls) {
    for (const [name, v] of Object.entries(a.args ?? {})) {
      if (typeof v !== "string" || !v.startsWith("<READ ")) continue;
      const m = RUNTIME_MARKER.exec(v);
      if (!m) {
        out.push(at(`${a.method_name}.${name} holds a malformed runtime marker`));
        continue;
      }
      const ref = declared[name];
      if (!ref) {
        out.push(at(`${a.method_name}.${name} is a runtime marker but runtime_args does not declare it`));
        continue;
      }
      const [, method, arg, fromId] = m;
      if (ref.from_step !== fromId) out.push(at(`runtime_args.${name} reads step ${ref.from_step} but the marker names ${fromId}`));
      if (ref.path !== "result") out.push(at(`runtime_args.${name}.path must be "result"`));
      const j = index.get(ref.from_step);
      const from = j === undefined ? null : plan.steps[j];
      if (!from) out.push(at(`runtime_args.${name} reads step ${ref.from_step}, which does not exist`));
      else {
        if (j >= i) out.push(at(`runtime_args.${name} reads step ${ref.from_step}, which does not come earlier`));
        const view = from.actions[0];
        if (!from.view || view.method_name !== method) out.push(at(`runtime_args.${name} must read a ${method} view, step ${ref.from_step} is not one`));
        else if (from.receiver_id !== plan.vault_id) out.push(at(`runtime_args.${name} must read the vault's ${method}`));
        else if (method === "get_balance" && (view.args.token_id !== arg || a.args.token_id !== arg)) out.push(at(`runtime_args.${name} must read get_balance for the token being withdrawn (${a.args.token_id})`));
        else if (method === "get_withdrawable_near" && arg !== "") out.push(at(`runtime marker for get_withdrawable_near takes no argument`));
      }
    }
  }
  for (const name of Object.keys(declared)) {
    if (!calls.some((a) => typeof a.args?.[name] === "string" && RUNTIME_MARKER.test(a.args[name]))) out.push(at(`runtime_args.${name} is declared but the call holds no marker for it`));
  }
  return out;
}

/** Steps that must come before others: accounts, registrations, the deploy, the rollback order. */
function orderingProblems(plan) {
  const out = [];
  const { vault_id: vault, owner_id: owner, steps } = plan;
  const calls = (i, method) => steps[i].actions.filter((a) => a.type === "FunctionCall" && (method === undefined || a.method_name === method));
  const firstIdx = (pred) => steps.findIndex(pred);
  const registeredBefore = (i, token, account) => steps.slice(0, i).some((s) => s.receiver_id === token && s.actions.some((a) => a.type === "FunctionCall" && a.method_name === "storage_deposit" && a.args?.account_id === account));
  const calledBefore = (i, method, receiver) => steps.slice(0, i).some((s) => s.receiver_id === receiver && s.actions.some((a) => a.type === "FunctionCall" && a.method_name === method));
  const deployIdx = firstIdx((s) => s.actions.some((a) => a.type === "DeployContract") && s.receiver_id === vault);
  const createIdx = firstIdx((s) => s.receiver_id === vault && s.actions.some((a) => a.type === "CreateAccount"));
  if (deployIdx < 0) out.push("order: no step deploys the vault wasm");
  if (createIdx < 0) out.push("order: no step creates the vault account");
  else if (deployIdx >= 0 && createIdx > deployIdx) out.push("order: the vault account must be created before the deploy");

  for (const [i, s] of steps.entries()) {
    const at = (m) => `${s.id}: order: ${m}`;
    if (s.receiver_id === vault && i !== deployIdx && deployIdx >= 0 && i < deployIdx && s.actions[0].type !== "CreateAccount") out.push(at("the vault is used before deploy-init"));
    for (const a of calls(i)) {
      if (s.receiver_id === vault) {
        if (a.method_name === "execute_swap") {
          for (const t of [a.args?.proposal?.token_in, a.args?.proposal?.token_out]) {
            if (!registeredBefore(i, t, vault)) out.push(at(`the vault must be registered on ${t} (storage_deposit) before execute_swap`));
          }
          if (!calledBefore(i, "register_on_ref", vault)) out.push(at("register_on_ref must come before execute_swap"));
        }
        if (a.method_name === "withdraw" && !registeredBefore(i, a.args?.token_id, owner)) out.push(at(`the owner must be registered on ${a.args?.token_id} (storage_deposit) before withdraw`));
        if (a.method_name === "withdraw_near" && !calledBefore(i, "withdraw_ref_storage", vault)) out.push(at("withdraw_ref_storage must come before withdraw_near"));
      } else if (a.method_name === "ft_transfer_call" && a.args?.receiver_id === vault) {
        if (!registeredBefore(i, s.receiver_id, vault)) out.push(at(`the vault must be registered on ${s.receiver_id} (storage_deposit) before the deposit into it`));
        if (!calledBefore(i, "register_on_ref", vault)) out.push(at("register_on_ref must come before the deposit into the vault"));
      } else if (a.method_name === "near_deposit" && !registeredBefore(i, s.receiver_id, s.signer_id)) {
        out.push(at(`${s.signer_id} must be registered on ${s.receiver_id} (storage_deposit) before near_deposit`));
      }
    }
  }

  const deleteIdx = firstIdx((s) => s.receiver_id === vault && s.actions.some((a) => a.type === "DeleteAccount"));
  const pre = steps.map((s, i) => [s, i]).filter(([s]) => s.id.startsWith("pre-delete"));
  if (deleteIdx >= 0) {
    if (!pre.some(([s]) => s.actions[0].method_name === "get_state" && s.receiver_id === vault)) out.push("order: no pre-delete get_state check before deleting the vault");
    for (const [s, i] of pre) if (i > deleteIdx) out.push(`${s.id}: order: pre-delete checks must come before delete-vault`);
    const firstPre = Math.min(...pre.map(([, j]) => j));
    for (const m of ["pause", "revoke_all_runners", "withdraw"]) {
      steps.forEach((s, i) => {
        if (s.receiver_id === vault && calls(i, m).length && i > firstPre) out.push(`${s.id}: order: ${m} must come before the pre-delete checks`);
      });
    }
  }
  return out;
}

// Read-only NEAR JSON-RPC client and the online preflight checks. It can only ever send the
// "query" method with request_type "call_function" or "view_account" and finality "final": a
// hard assertion in assertReadOnlyRequest throws for anything else, so this module cannot sign
// or broadcast. No keys, no headers beyond content-type. fetch is injectable; tests never use the network.

import { findPlaceholders, formatNear, parseNear, vaultConfigFor } from "./live-plan.mjs";

/** The testnet RPC docs.near.org lists. */
export const DEFAULT_RPC = "https://test.rpc.fastnear.com";
export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_REQUESTS = 20;
export const NO_CODE_HASH = "11111111111111111111111111111111";

export class RpcError extends Error {
  /** @param {string} message @param {string} [kind] */
  constructor(message, kind = "rpc") {
    super(message);
    this.name = "RpcError";
    this.kind = kind;
  }
}

/** Throws unless `body` is exactly a read-only query. Called on every request just before it is sent. */
export function assertReadOnlyRequest(body) {
  const p = body?.params;
  const fail = (why) => {
    throw new Error(`refused: not a read-only RPC request (${why})`);
  };
  if (body?.method !== "query") fail("method must be query");
  if (p === null || typeof p !== "object") fail("params missing");
  if (!["call_function", "view_account"].includes(p.request_type)) fail("request_type must be call_function or view_account");
  if (p.finality !== "final") fail("finality must be final");
  const allowed = p.request_type === "call_function"
    ? ["request_type", "finality", "account_id", "method_name", "args_base64"]
    : ["request_type", "finality", "account_id"];
  for (const k of Object.keys(p)) if (!allowed.includes(k)) fail(`unexpected param ${k}`);
  for (const k of allowed) if (typeof p[k] !== "string") fail(`param ${k} must be a string`);
}

/** Known mainnet RPC hosts that do not say "mainnet" in the name (hosts containing "mainnet" are caught by name). */
export const MAINNET_HOSTS = Object.freeze(["rpc.mainnet.near.org", "free.rpc.fastnear.com", "rpc.mainnet.fastnear.com", "archival-rpc.mainnet.near.org", "rpc.near.org"]);

/** The RPC URL must be https and must not be a mainnet endpoint. Throws RangeError otherwise. */
export function assertRpcUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new RangeError("rpc url is not a valid URL");
  }
  if (u.protocol !== "https:") throw new RangeError("rpc url must be https");
  if (/mainnet/i.test(url) || MAINNET_HOSTS.includes(u.hostname.toLowerCase())) throw new RangeError("rpc url must not be a mainnet endpoint");
  return u.toString();
}

/**
 * @param {{ url?: string, fetch?: typeof fetch, timeoutMs?: number, maxRequests?: number }} [o]
 */
export function createRpc({ url = DEFAULT_RPC, fetch: fetchFn = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS, maxRequests = MAX_REQUESTS } = {}) {
  const endpoint = assertRpcUrl(url);
  let count = 0;
  async function query(params) {
    const body = { jsonrpc: "2.0", id: "yield-live", method: "query", params: { ...params, finality: "final" } };
    assertReadOnlyRequest(body);
    if (++count > maxRequests) throw new RpcError(`request budget of ${maxRequests} exhausted`, "budget");
    let res;
    try {
      res = await fetchFn(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new RpcError(`request failed: ${e?.name === "TimeoutError" ? `timeout after ${timeoutMs} ms` : e?.message ?? e}`, "network");
    }
    if (!res.ok) throw new RpcError(`HTTP ${res.status}`, "http");
    const json = await res.json();
    if (json.error) {
      const cause = json.error.cause?.name ?? json.error.name ?? "";
      throw new RpcError(`${json.error.name ?? "error"} ${cause}`.trim(), cause === "UNKNOWN_ACCOUNT" ? "unknown_account" : "rpc");
    }
    if (typeof json.result?.error === "string") throw new RpcError(json.result.error.slice(0, 200), /does not exist/.test(json.result.error) ? "unknown_account" : "rpc");
    return json.result;
  }
  return {
    get requests() {
      return count;
    },
    /** call_function on a view method; resolves to the parsed JSON result. */
    async view(accountId, methodName, args = {}) {
      const r = await query({ request_type: "call_function", account_id: accountId, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
      return JSON.parse(Buffer.from(r.result).toString("utf8"));
    },
    /** view_account; resolves to the account record, or null when the account does not exist. */
    async account(accountId) {
      try {
        return await query({ request_type: "view_account", account_id: accountId });
      } catch (e) {
        if (e instanceof RpcError && e.kind === "unknown_account") return null;
        throw e;
      }
    },
  };
}

/**
 * The online checks. Each returns {status, name, detail}; a failed request becomes a WARN
 * (the network is not the config's fault), a wrong observed value a FAIL.
 * @returns {Promise<{status: string, name: string, detail: string}[]>}
 */
export async function onlineChecks(config, plan, rpc) {
  const checks = [];
  const add = (status, name, detail = "") => checks.push({ status, name, detail });
  const guard = async (name, fn) => {
    try {
      await fn();
    } catch (e) {
      add("WARN", name, `could not read: ${e instanceof RpcError ? e.message : e?.message ?? e}`);
    }
  };
  const ref = config.ref_exchange_id;
  const vc = vaultConfigFor(config);
  const tokens = [...new Set(vc.allowed_pools.flatMap((p) => [p.token_a, p.token_b]))];
  const placeholders = findPlaceholders(config);
  const isPh = (path) => placeholders.some((p) => p === path || p.startsWith(`${path}.`));

  // A mainnet RPC would say wrap.testnet does not exist: the endpoint must really be testnet.
  await guard("online: RPC is testnet (wrap.testnet exists)", async () => {
    const w = await rpc.account("wrap.testnet");
    add(w ? "PASS" : "FAIL", "online: RPC is testnet (wrap.testnet exists)", w ? "wrap.testnet exists" : "wrap.testnet does not exist on this endpoint: not a testnet RPC");
  });

  await guard("online: Ref exchange has code", async () => {
    const a = await rpc.account(ref);
    if (!a) add("FAIL", "online: Ref exchange has code", `${ref} does not exist`);
    else if (!a.code_hash || a.code_hash === NO_CODE_HASH) add("FAIL", "online: Ref exchange has code", `${ref} exists but has no contract code`);
    else add("PASS", "online: Ref exchange has code", `${ref} code_hash ${a.code_hash}`);
  });

  const need = parseNear(config.ref_storage_deposit_near);
  await guard("online: Ref storage_balance_bounds.min <= ref_storage_deposit_near", async () => {
    const b = await rpc.view(ref, "storage_balance_bounds", {});
    const min = BigInt(b.min);
    add(min <= need ? "PASS" : "FAIL", "online: Ref storage_balance_bounds.min <= ref_storage_deposit_near", `min ${formatNear(min)} NEAR, config ${formatNear(need)} NEAR`);
  });

  await guard("online: Ref whitelists every pool token", async () => {
    const list = await rpc.view(ref, "get_whitelisted_tokens", {});
    const missing = tokens.filter((t) => !list.includes(t));
    add(missing.length ? "FAIL" : "PASS", "online: Ref whitelists every pool token", missing.length ? `not whitelisted: ${missing.join(", ")}` : `${tokens.length} tokens whitelisted`);
  });

  await guard("online: Ref pool matches the config", async () => {
    const poolId = config.swap.pool_id;
    const cfgPool = vc.allowed_pools.find((p) => p.pool_id === poolId);
    const pool = await rpc.view(ref, "get_pool", { pool_id: poolId });
    const ids = pool.token_account_ids ?? [];
    const same = cfgPool && ids.length === 2 && ids.includes(cfgPool.token_a) && ids.includes(cfgPool.token_b);
    if (!same) return add("FAIL", "online: Ref pool matches the config", `pool ${poolId} has tokens [${ids.join(", ")}], config expects ${cfgPool ? `${cfgPool.token_a} / ${cfgPool.token_b}` : "no such allowed pool"}`);
    const amounts = (pool.amounts ?? []).map((a) => BigInt(a));
    if (amounts.length !== 2 || amounts.some((a) => a === 0n)) return add("FAIL", "online: Ref pool matches the config", `pool ${poolId} has empty reserves [${amounts.join(", ")}]`);
    const reserveIn = amounts[ids.indexOf(config.swap.token_in)];
    const share = (BigInt(config.swap.amount_in) * 10000n) / reserveIn; // bps
    add(share > 100n ? "WARN" : "PASS", "online: Ref pool matches the config", `pool ${poolId} tokens match, reserves [${amounts.join(", ")}], amount_in is ${share === 0n ? "under 0.01" : Number(share) / 100}% of the token_in reserve${share > 100n ? " (above 1%: heavy price impact)" : ""}`);
  });

  const tokDep = parseNear(config.token_storage_deposit_near);
  for (const t of tokens) {
    await guard(`online: token ${t}`, async () => {
      const meta = await rpc.view(t, "ft_metadata", {});
      const b = await rpc.view(t, "storage_balance_bounds", {});
      const min = BigInt(b.min);
      add(min <= tokDep ? "PASS" : "FAIL", `online: token ${t}`, `decimals ${meta.decimals}, storage_balance_bounds.min ${formatNear(min)} NEAR, config ${formatNear(tokDep)} NEAR`);
    });
  }

  if (isPh("owner_id")) add("WARN", "online: owner account funded", "skipped: owner_id is a placeholder");
  else {
    await guard("online: owner account funded", async () => {
      const a = await rpc.account(config.owner_id);
      const needY = BigInt(planOutflow(plan)) + parseNear("1");
      if (!a) add("FAIL", "online: owner account funded", `${config.owner_id} does not exist`);
      else add(BigInt(a.amount) >= needY ? "PASS" : "FAIL", "online: owner account funded", `balance ${formatNear(a.amount)} NEAR, needs ${formatNear(needY)} NEAR (planned outflow + 1 NEAR margin)`);
    });
  }
  for (const [path, id] of [["vault_id", config.vault_id], ["runner_id", config.runner_id]]) {
    const name = `online: ${path} not created yet`;
    if (isPh(path)) add("WARN", name, `skipped: ${path} is a placeholder`);
    else {
      await guard(name, async () => {
        const a = await rpc.account(id);
        add(a ? "FAIL" : "PASS", name, a ? `${id} already exists (create-account would fail)` : `${id} does not exist yet`);
      });
    }
  }
  add("MANUAL", "Ref swap, withdraw, storage_deposit, storage_withdraw and the token's ft_on_transfer callback path: not checkable read-only", "they change state; only a real testnet run proves them");
  return checks;
}

function planOutflow(plan) {
  let sum = 0n;
  for (const s of plan.steps) if (!s.view && s.signer_id === plan.owner_id) sum += s.actions.reduce((x, a) => x + BigInt(a.deposit_yocto ?? 0), 0n);
  return sum;
}

// Token wallets: the JS side of the contract's wallet methods.
//
// Each personality token owns a NEAR balance held by the contract and keyed by
// token id, so it moves with the token on transfer (contracts/personality-nft/
// src/wallet.rs). This module does two things, and never signs, reads keys or
// opens a connection:
//
// 1. prepareWalletCall builds the arguments, deposit and gas for one of the
//    contract's wallet methods, testnet only, ready for a caller that signs.
// 2. createWalletLedger is an offline model of the same rules (who may spend,
//    allowance, balance, transfer voids an old grant), used by the demo to show
//    what the wallets would hold after a run. It refuses exactly what the
//    contract refuses, with the same messages.
//
// Amounts are yoctoNEAR as decimal strings (1 NEAR = 10^24 yoctoNEAR).

import { isValidAccountId } from "../anchor/anchor.mjs";

export const WALLET_METHODS = Object.freeze({
  deposit: "wallet_deposit",
  send: "wallet_send",
  setAgent: "wallet_set_agent",
  revokeAgent: "wallet_revoke_agent",
  agentPay: "wallet_agent_pay",
  view: "token_wallet",
});

// 0.01 NEAR: generous storage for one agent grant; the contract refunds the rest.
export const GRANT_DEPOSIT_YOCTO = "10000000000000000000000";
export const ONE_YOCTO = "1";
export const DEFAULT_GAS = "50000000000000"; // 50 Tgas: a transfer plus its callback
export const MAX_WALLET_MEMO_LEN = 256;

const TOKEN_RE = /^[a-z0-9_-]+$/;
const YOCTO_RE = /^(0|[1-9]\d*)$/;
const U128_MAX = (1n << 128n) - 1n;

export class WalletError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = "WalletError";
    this.code = details.code ?? "wallet_error";
  }
}

/** yoctoNEAR decimal string -> bigint, refusing anything that is not a u128. */
export function toYocto(value, what = "amount") {
  const s = typeof value === "bigint" ? value.toString() : value;
  if (typeof s !== "string" || !YOCTO_RE.test(s)) {
    throw new WalletError(`${what} must be a decimal string of yoctoNEAR`, { code: "bad_amount" });
  }
  const n = BigInt(s);
  if (n > U128_MAX) throw new WalletError(`${what} does not fit in a u128`, { code: "bad_amount" });
  return n;
}

/** 0.001 NEAR -> "1000000000000000000000". Up to 24 decimals. */
export function nearToYocto(near) {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(String(near));
  if (!m) throw new WalletError(`not a NEAR amount: ${JSON.stringify(near)}`, { code: "bad_amount" });
  return (BigInt(m[1]) * 10n ** 24n + BigInt((m[2] ?? "").padEnd(24, "0") || "0")).toString();
}

function checkToken(tokenId) {
  if (typeof tokenId !== "string" || tokenId.length === 0 || tokenId.length > 64 || !TOKEN_RE.test(tokenId)) {
    throw new WalletError("tokenId must be 1-64 chars of [a-z0-9_-]", { code: "bad_token" });
  }
}

function checkAccount(id, what) {
  if (!isValidAccountId(id)) throw new WalletError(`${what} is not a valid NEAR account id`, { code: "bad_account" });
}

function checkMemo(memo) {
  if (memo === undefined || memo === null) return;
  if (typeof memo !== "string") throw new WalletError("memo must be a string", { code: "bad_memo" });
  if (Buffer.byteLength(memo, "utf8") > MAX_WALLET_MEMO_LEN) {
    throw new WalletError(`memo is too long (max ${MAX_WALLET_MEMO_LEN} bytes)`, { code: "bad_memo" });
  }
}

/**
 * Build one wallet call. Never signs.
 * @param {object} p
 * @param {string} p.contractId
 * @param {string} p.network Must be "testnet".
 * @param {"deposit"|"send"|"setAgent"|"revokeAgent"|"agentPay"} p.kind
 * @param {string} p.tokenId
 * @param {string} [p.amountYocto] deposit, send and agentPay
 * @param {string} [p.receiverId] send
 * @param {string} [p.agentId] setAgent
 * @param {string} [p.payeeId] setAgent
 * @param {string} [p.allowanceYocto] setAgent
 * @param {string} [p.memo]
 * @param {string} [p.gas]
 */
export function prepareWalletCall(p) {
  const { contractId, network, kind, tokenId, amountYocto, receiverId, agentId, payeeId, allowanceYocto, memo, gas } = p ?? {};
  checkAccount(contractId, "contractId");
  if (network !== "testnet") {
    throw new WalletError(`network ${JSON.stringify(network)} refused: testnet only`, { code: "network_refused" });
  }
  checkToken(tokenId);
  checkMemo(memo);
  if (gas !== undefined && (typeof gas !== "string" || !/^[1-9]\d*$/.test(gas))) {
    throw new WalletError("gas must be a decimal string", { code: "bad_config" });
  }
  const withMemo = (args) => (memo === undefined || memo === null ? args : { ...args, memo });
  const positive = (v, what) => {
    if (toYocto(v, what) === 0n) throw new WalletError(`${what} must be greater than 0`, { code: "bad_amount" });
    return v;
  };
  let methodName;
  let args;
  let depositYocto;
  switch (kind) {
    case "deposit":
      methodName = WALLET_METHODS.deposit;
      depositYocto = positive(amountYocto, "amountYocto");
      args = withMemo({ token_id: tokenId });
      break;
    case "send":
      checkAccount(receiverId, "receiverId");
      if (receiverId === contractId) throw new WalletError("cannot send to the contract account itself", { code: "bad_account" });
      methodName = WALLET_METHODS.send;
      depositYocto = ONE_YOCTO;
      args = withMemo({ token_id: tokenId, receiver_id: receiverId, amount: positive(amountYocto, "amountYocto") });
      break;
    case "setAgent":
      checkAccount(agentId, "agentId");
      checkAccount(payeeId, "payeeId");
      if (payeeId === contractId) throw new WalletError("the payee cannot be the contract account itself", { code: "bad_account" });
      toYocto(allowanceYocto, "allowanceYocto");
      if (memo !== undefined && memo !== null) throw new WalletError("setAgent takes no memo", { code: "bad_memo" });
      methodName = WALLET_METHODS.setAgent;
      depositYocto = GRANT_DEPOSIT_YOCTO;
      args = { token_id: tokenId, agent_id: agentId, payee_id: payeeId, allowance: allowanceYocto };
      break;
    case "revokeAgent":
      if (memo !== undefined && memo !== null) throw new WalletError("revokeAgent takes no memo", { code: "bad_memo" });
      methodName = WALLET_METHODS.revokeAgent;
      depositYocto = ONE_YOCTO;
      args = { token_id: tokenId };
      break;
    case "agentPay":
      methodName = WALLET_METHODS.agentPay;
      depositYocto = "0";
      args = withMemo({ token_id: tokenId, amount: positive(amountYocto, "amountYocto") });
      break;
    default:
      throw new WalletError(`unknown wallet call kind ${JSON.stringify(kind)}`, { code: "bad_kind" });
  }
  return Object.freeze({
    network: "testnet",
    contractId,
    methodName,
    args: Object.freeze(args),
    gas: gas ?? DEFAULT_GAS,
    depositYocto,
    signing: "required",
  });
}

/**
 * Offline model of the contract's wallet rules.
 * @param {{ owners: Record<string, string> }} init token id -> owner account
 */
export function createWalletLedger({ owners } = {}) {
  if (!owners || typeof owners !== "object") throw new WalletError("owners is required", { code: "bad_config" });
  const tokens = new Map();
  for (const [tokenId, owner] of Object.entries(owners)) {
    checkToken(tokenId);
    checkAccount(owner, "owner");
    tokens.set(tokenId, { owner, balance: 0n, grant: null });
  }
  const get = (tokenId) => {
    const t = tokens.get(tokenId);
    if (!t) throw new WalletError("token not found", { code: "unknown_token" });
    return t;
  };
  const requireOwner = (t, by) => {
    if (by !== t.owner) throw new WalletError("only the token owner can manage its wallet", { code: "not_owner" });
  };
  const debit = (t, amount) => {
    if (amount === 0n) throw new WalletError("amount must be greater than 0", { code: "bad_amount" });
    if (amount > t.balance) throw new WalletError("amount exceeds the token's wallet balance", { code: "insufficient" });
    t.balance -= amount;
  };
  return {
    deposit(tokenId, amountYocto) {
      const t = get(tokenId);
      const amount = toYocto(amountYocto);
      if (amount === 0n) throw new WalletError("attach the NEAR to deposit", { code: "bad_amount" });
      if (t.balance + amount > U128_MAX) throw new WalletError("wallet balance overflow", { code: "bad_amount" });
      t.balance += amount;
      return t.balance.toString();
    },
    send(tokenId, by, amountYocto) {
      const t = get(tokenId);
      requireOwner(t, by);
      debit(t, toYocto(amountYocto));
      return t.balance.toString();
    },
    setAgent(tokenId, by, { agentId, payeeId, allowanceYocto }) {
      const t = get(tokenId);
      requireOwner(t, by);
      checkAccount(agentId, "agentId");
      checkAccount(payeeId, "payeeId");
      t.grant = { agentId, payeeId, allowance: toYocto(allowanceYocto, "allowanceYocto"), grantedBy: by };
    },
    agentPay(tokenId, by, amountYocto) {
      const t = get(tokenId);
      if (!t.grant) throw new WalletError("the token has no agent grant", { code: "no_grant" });
      if (by !== t.grant.agentId) throw new WalletError("only the granted agent can pay", { code: "not_agent" });
      if (t.grant.grantedBy !== t.owner) {
        throw new WalletError("the agent grant was made by a previous owner", { code: "stale_grant" });
      }
      const amount = toYocto(amountYocto);
      if (amount > t.grant.allowance) throw new WalletError("amount exceeds the agent's allowance", { code: "allowance" });
      debit(t, amount);
      t.grant.allowance -= amount;
      return { balance: t.balance.toString(), payeeId: t.grant.payeeId };
    },
    transfer(tokenId, from, to) {
      const t = get(tokenId);
      requireOwner(t, from);
      checkAccount(to, "receiver");
      t.owner = to;
    },
    /** Same shape as the contract's token_wallet view. */
    view(tokenId) {
      const t = tokens.get(tokenId);
      if (!t) return null;
      const active = t.grant && t.grant.grantedBy === t.owner;
      return {
        token_id: tokenId,
        owner_id: t.owner,
        balance: t.balance.toString(),
        agent: active
          ? { agent_id: t.grant.agentId, payee_id: t.grant.payeeId, allowance: t.grant.allowance.toString() }
          : null,
      };
    },
  };
}

/** Placeholder accounts and prices the offline demo uses. Nothing is deployed there. */
export const DEMO_WALLET = Object.freeze({
  owner: "alice.demo.testnet",
  newOwner: "bob.demo.testnet",
  agent: "swarm-runner.demo.testnet",
  payee: "inference.demo.testnet",
  fans: "fans.demo.testnet",
  startYocto: nearToYocto("0.05"),
  allowanceYocto: nearToYocto("0.03"),
  postPriceYocto: nearToYocto("0.001"),
  sheetPriceYocto: nearToYocto("0.002"),
  tipYocto: nearToYocto("0.002"),
});

/**
 * The demo's wallet economy, computed offline from a swarm run:
 * the owner funds each token and lets the swarm runner pay inference for it;
 * every line a token speaks and every sheet it writes is paid from its own
 * wallet; every reply it gets earns it a tip from fans. Then the tokens move
 * to a new owner and the old grant stops working.
 *
 * @param {object} p
 * @param {string} p.contractId
 * @param {{ id: string, name: string }[]} p.agents
 * @param {{ id: string, agentId: string, round: number, kind: string, replyTo?: string|null }[]} p.events
 * @param {Record<string, number[]>} p.sheetRounds token id -> rounds a sheet was written
 * @param {number} p.rounds
 */
export function simulateDemoWallets({ contractId, agents, events, sheetRounds, rounds }) {
  const cfg = DEMO_WALLET;
  const ledger = createWalletLedger({ owners: Object.fromEntries(agents.map((a) => [a.id, cfg.owner])) });
  const nameOf = new Map(agents.map((a) => [a.id, a.name]));
  const byId = new Map(events.map((e) => [e.id, e]));
  const calls = [];
  const entries = new Map(agents.map((a) => [a.id, []]));
  const totals = new Map(agents.map((a) => [a.id, { tips: 0n, inference: 0n, tipCount: 0, paidCount: 0 }]));
  const call = (by, round, prepared) =>
    calls.push({
      by,
      round,
      tokenId: prepared.args.token_id,
      method: prepared.methodName,
      args: prepared.args,
      depositYocto: prepared.depositYocto,
      gas: prepared.gas,
      status: "dry-run",
      transactionHash: null,
    });
  const base = { contractId, network: "testnet" };

  for (const a of agents) {
    const memo = "starting balance";
    const balance = ledger.deposit(a.id, cfg.startYocto);
    call(cfg.owner, 0, prepareWalletCall({ ...base, kind: "deposit", tokenId: a.id, amountYocto: cfg.startYocto, memo }));
    entries.get(a.id).push({ round: 0, kind: "deposit", from: cfg.owner, amountYocto: cfg.startYocto, memo, balanceYocto: balance });
    ledger.setAgent(a.id, cfg.owner, { agentId: cfg.agent, payeeId: cfg.payee, allowanceYocto: cfg.allowanceYocto });
    call(cfg.owner, 0, prepareWalletCall({ ...base, kind: "setAgent", tokenId: a.id, agentId: cfg.agent, payeeId: cfg.payee, allowanceYocto: cfg.allowanceYocto }));
  }

  const pay = (tokenId, round, amountYocto, memo) => {
    const { balance, payeeId } = ledger.agentPay(tokenId, cfg.agent, amountYocto);
    call(cfg.agent, round, prepareWalletCall({ ...base, kind: "agentPay", tokenId, amountYocto, memo }));
    entries.get(tokenId).push({ round, kind: "agent_pay", to: payeeId, amountYocto, memo, balanceYocto: balance });
    const t = totals.get(tokenId);
    t.inference += BigInt(amountYocto);
    t.paidCount += 1;
  };

  for (let round = 1; round <= rounds; round++) {
    for (const e of events.filter((x) => x.round === round)) {
      if (!nameOf.has(e.agentId)) continue;
      pay(e.agentId, round, cfg.postPriceYocto, `inference: ${e.kind} round ${round}`);
      const target = e.kind === "reply" ? byId.get(e.replyTo) : null;
      if (target && nameOf.has(target.agentId) && target.agentId !== e.agentId) {
        const memo = `tip: reply from ${nameOf.get(e.agentId)} round ${round}`;
        const balance = ledger.deposit(target.agentId, cfg.tipYocto);
        call(cfg.fans, round, prepareWalletCall({ ...base, kind: "deposit", tokenId: target.agentId, amountYocto: cfg.tipYocto, memo }));
        entries.get(target.agentId).push({ round, kind: "deposit", from: cfg.fans, amountYocto: cfg.tipYocto, memo, balanceYocto: balance });
        const t = totals.get(target.agentId);
        t.tips += BigInt(cfg.tipYocto);
        t.tipCount += 1;
      }
    }
    for (const a of agents) {
      if ((sheetRounds[a.id] ?? []).includes(round)) pay(a.id, round, cfg.sheetPriceYocto, `inference: sheet round ${round}`);
    }
  }

  const before = agents.map((a) => ledger.view(a.id));
  // The tokens change hands: each wallet goes with its token, and the grant
  // alice made stops working for the new owner.
  const staleGrantRefused = [];
  for (const a of agents) {
    ledger.transfer(a.id, cfg.owner, cfg.newOwner);
    try {
      ledger.agentPay(a.id, cfg.agent, cfg.postPriceYocto);
      staleGrantRefused.push(false);
    } catch (err) {
      if (err.code !== "stale_grant") throw err;
      staleGrantRefused.push(true);
    }
  }
  const after = agents.map((a) => ledger.view(a.id));

  return {
    network: "testnet",
    contractId,
    signed: false,
    accounts: { owner: cfg.owner, newOwner: cfg.newOwner, agent: cfg.agent, payee: cfg.payee, fans: cfg.fans },
    prices: {
      startYocto: cfg.startYocto,
      allowanceYocto: cfg.allowanceYocto,
      postPriceYocto: cfg.postPriceYocto,
      sheetPriceYocto: cfg.sheetPriceYocto,
      tipYocto: cfg.tipYocto,
    },
    tokens: agents.map((a, i) => {
      const t = totals.get(a.id);
      return {
        tokenId: a.id,
        name: a.name,
        startYocto: cfg.startYocto,
        tipsYocto: t.tips.toString(),
        tipCount: t.tipCount,
        inferenceYocto: t.inference.toString(),
        paidCount: t.paidCount,
        balanceYocto: before[i].balance,
        allowanceLeftYocto: before[i].agent?.allowance ?? "0",
        afterTransfer: {
          owner: after[i].owner_id,
          balanceYocto: after[i].balance,
          agentActive: after[i].agent !== null,
          staleGrantRefused: staleGrantRefused[i],
        },
        entries: entries.get(a.id),
      };
    }),
    calls,
  };
}

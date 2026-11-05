#!/usr/bin/env node
// Shade Agent runner plan, DRY RUN. Offline and unsigned: prints the payloads a Shade Agent runner
// would build for the Yield vault. The proposal is the first rule-checked call from `npm run yield:demo`.
//
//   npm run yield:shade:dry-run
//   npm run yield:shade:dry-run -- --json
//
// Nothing is signed, sent or written. No network, no key, no .env is read.

import { fileURLToPath } from "node:url";

import { EXECUTE_SWAP_TGAS } from "../src/yield/gas.mjs";
import { RefusalError, assertNotMainnet } from "../src/yield/send.mjs";
import { runDemo } from "../src/yield/demo.mjs";
import { buildShadePlan, renderShadePlan } from "../src/yield/shade/plan.mjs";
import { loadSnapshot } from "../src/yield-optimizer/snapshot.mjs";
import { DEFAULT_SNAPSHOT } from "./yield-optimizer.mjs";

const USAGE = `Usage: node scripts/yield-shade-dry-run.mjs [--json] [--agent-contract ID] [--path P]   (--flag=value also works)
  (no flag)            human-readable Shade Agent runner plan
  --json               print only the plan JSON (dry_run true, signed false, sent false)
  --agent-contract ID  agent contract account (testnet ids only; default is a placeholder)
  --path P             MPC derivation path (default yield-vault-1)
  -h, --help           print this help and exit 0
The proposal is the first rule-checked call of \`npm run yield:demo\`. Always a DRY RUN: offline, no keys,
nothing signed, sent or written. Refused (exit 1): --sign, --send, --broadcast, --i-approve, --mainnet,
--network other than testnet, NEAR_NETWORK=mainnet, any .near account. MOCK_INFERENCE and NEAR_AI_* are ignored.
Context: docs/yield-shade-agent-plan.md. Exit 0 ok, 1 refused, 2 usage error.`;

class UsageError extends Error {}

const REFUSED_FLAGS = new Set(["--sign", "--send", "--broadcast", "--i-approve", "--mainnet"]);

function parseArgs(argv) {
  const o = { json: false, help: false, agentContract: undefined, path: undefined, network: undefined, refused: null };
  if (argv.some((a) => a === "--help" || a === "-h")) return { ...o, help: true };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    let inline; // value from the --flag=value form
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    if (eq > 0) {
      inline = a.slice(eq + 1);
      a = a.slice(0, eq);
    }
    const value = () => {
      if (inline !== undefined) {
        if (inline === "") throw new UsageError(`${a} needs a value`);
        return inline;
      }
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) throw new UsageError(`${a} needs a value`);
      i++;
      return v;
    };
    if (inline !== undefined && !["--agent-contract", "--path", "--network"].includes(a) && !REFUSED_FLAGS.has(a)) {
      throw new UsageError(`unknown argument ${JSON.stringify(argv[i]).slice(0, 40)}`);
    }
    if (a === "--json") o.json = true;
    else if (a === "--agent-contract") o.agentContract = value();
    else if (a === "--path") o.path = value();
    else if (a === "--network") o.network = value();
    else if (REFUSED_FLAGS.has(a)) o.refused ??= a;
    else throw new UsageError(`unknown argument ${JSON.stringify(a).slice(0, 40)}`);
  }
  return o;
}

const row = (k, v) => `  ${k.padEnd(20)}${v}`;
const j = (v) => JSON.stringify(v);

export function renderHuman(plan) {
  const d = plan.derivation;
  const tx = plan.execute_swap;
  const act = tx.actions[0];
  const sign = plan.mpc.mpcSign;
  const req = plan.mpc.agentRequestSignature;
  const auth = plan.authorization;
  const key = auth.executorAddKey.action;
  const src = plan.proposal_source;
  return [
    "SHADE AGENT RUNNER PLAN - DRY RUN - offline, nothing signed, nothing sent",
    `Details: docs/yield-shade-agent-plan.md. ${plan.notice}`,
    "",
    "== proposal ==",
    row("source", `${src.from} (agent ${src.agent}, rule check ${src.rule_check})`),
    row("proposal", j(act.args.proposal)),
    "",
    "== derivation (MPC chain signatures) ==",
    row("agent contract", `${d.predecessor} (the predecessor the MPC contract derives from)`),
    row("path", d.path),
    row("domain_id", `${d.domain_id} (ed25519)`),
    row("root key", d.root_key),
    row("derived key", d.derived_key),
    "",
    "== runner authorization ==",
    row("add_runner", `${auth.addRunner.signerId} -> ${auth.addRunner.receiverId}.add_runner ${j(auth.addRunner.args)}, deposit ${auth.addRunner.deposit} yocto`),
    row("AddKey", `${auth.executorAddKey.signerId} adds ${key.publicKey}`),
    row("", `function-call key: receiver ${key.permission.receiverId}, methods ${j(key.permission.methodNames)}, allowance ${key.permission.allowance} yocto`),
    "",
    "== execute_swap tx (unsigned) ==",
    row("signer", tx.signerId),
    row("receiver", tx.receiverId),
    row("method", act.methodName),
    row("args", j(act.args)),
    row("gas", `${act.gas} (${EXECUTE_SWAP_TGAS} Tgas)`),
    row("deposit", act.deposit),
    row("nonce", `${tx.nonce} (${tx.nonceNote})`),
    row("tx hash (hex)", tx.txHashHex),
    row("tx hash (base58)", tx.txHashBase58),
    "",
    "== MPC sign request ==",
    row("receiver", sign.receiverId),
    row("method", sign.methodName),
    row("args", j(sign.args)),
    row("deposit", `${sign.deposit} yocto`),
    row("gas", sign.gas),
    "",
    "== agent contract request_signature (UNCONFIRMED) ==",
    row("receiver", req.receiverId),
    row("method", req.methodName),
    row("args", j(req.args)),
    row("confirmed", String(req.confirmed)),
    `  ${req.note}`,
    "",
    "== revocation ==",
    row("revoke_runner", `${auth.revocation.revokeRunner.signerId} -> ${auth.revocation.revokeRunner.receiverId}.revoke_runner ${j(auth.revocation.revokeRunner.args)}, deposit ${auth.revocation.revokeRunner.deposit} yocto`),
    row("revoke_all_runners", `${auth.revocation.revokeAllRunners.note}`),
    row("DeleteKey", `${auth.revocation.deleteKey.signerId} deletes ${auth.revocation.deleteKey.action.publicKey}`),
    "",
    `dry_run: ${plan.dry_run}, signed: ${plan.signed}, sent: ${plan.sent}`,
  ].join("\n");
}

/** @param {string[]} argv @param {{ env?: object, log?: (s: string) => void, err?: (s: string) => void }} [io] */
export async function main(argv = process.argv.slice(2), io = {}) {
  const { env = process.env, log = console.log, err = (s) => console.error(s) } = io;
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`yield:shade:dry-run: ${e.message} (see --help)`);
    return 2;
  }
  if (opts.help) {
    log(USAGE);
    return 0;
  }
  try {
    if (opts.refused) throw new RefusalError(`refused: ${opts.refused} is not allowed. Dry run only; nothing is signed, sent or sent to mainnet.`);
    assertNotMainnet(env);
    if (opts.network !== undefined && opts.network !== "testnet") throw new RefusalError("refused: network must be testnet. This tool never targets mainnet.");

    const { calls } = await runDemo({ rhea: loadSnapshot(DEFAULT_SNAPSHOT), rheaSource: "src/yield-optimizer/fixtures/rhea-testnet-snapshot.json" });
    const first = calls.calls[0];
    if (!first) throw new RefusalError("refused: yield:demo planned no rule-checked call to build a plan from");
    const plan = buildShadePlan({
      env: {},
      agentContract: opts.agentContract,
      path: opts.path,
      proposal: first.args.proposal,
      proposalSource: { from: "npm run yield:demo", agent: first.agent, rule_check: "ok" },
    });
    log(opts.json ? renderShadePlan(plan).trimEnd() : renderHuman(plan));
    return 0;
  } catch (e) {
    if (!(e instanceof RefusalError)) throw e;
    err(`yield:shade:dry-run: ${e.message}`);
    return e.exitCode;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code;
  });
}

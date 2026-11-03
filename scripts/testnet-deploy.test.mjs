import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AGENTS,
  GAS,
  INIT_METHOD,
  MINT_DEPOSIT,
  MINT_METHOD,
  NETWORK,
  UsageError,
  buildDeployStep,
  buildMintStep,
  buildPlan,
  parseArgs,
  parseCount,
  run,
  shellQuote,
  tokenMetadata,
  validateAccountId,
} from "./testnet-deploy.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "testnet-deploy.mjs");
const OWNER = "agent-owner.testnet";
const CONTRACT = "personality.agent-owner.testnet";
const WASM = "/tmp/personality_nft.wasm";

function collector() {
  const lines = [];
  const errors = [];
  return {
    lines,
    errors,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    text: () => lines.join("\n"),
  };
}

// Any call here means the script tried to talk to near-cli-rs.
function forbiddenExec() {
  throw new Error("near-cli-rs must not be invoked in this test");
}

test("validateAccountId accepts testnet names and rejects malformed ones without echoing them", () => {
  for (const ok of ["alice.testnet", "a1-b_c.testnet", "sub.alice.testnet", "a".repeat(64)]) {
    assert.equal(validateAccountId(ok, "X"), ok);
  }
  for (const bad of ["", "A.testnet", "a", "-alice.testnet", "alice-.testnet", "a..b", "a".repeat(65), undefined]) {
    assert.throws(() => validateAccountId(bad, "NEAR_ACCOUNT_ID"), UsageError);
  }
  const secretLike = "ed25519:5Kd3NBUAdUnhyzenEwVLy9pBKxSwXvE9FMPyR4UKZvpe6E3AgLr";
  assert.throws(
    () => validateAccountId(secretLike, "NEAR_ACCOUNT_ID"),
    (err) => err instanceof UsageError && !err.message.includes(secretLike),
  );
});

test("parseCount accepts 1 to the agent count and rejects everything else", () => {
  assert.equal(parseCount("1"), 1);
  assert.equal(parseCount(String(AGENTS.length)), AGENTS.length);
  for (const bad of ["0", "5", "-1", "1.5", "x", ""]) {
    assert.throws(() => parseCount(bad), UsageError);
  }
});

test("agents match PRODUCT.md: four unique ids, four trait keys each, in contract order", () => {
  assert.equal(AGENTS.length, 4);
  assert.deepEqual(AGENTS.map((a) => a.token_id), ["aloof", "chaotic", "social", "skeptic"]);
  for (const agent of AGENTS) {
    assert.deepEqual(Object.keys(agent.traits), ["temperament", "role", "risk", "voice"]);
  }
  assert.equal(AGENTS[0].traits.role, "observer");
});

test("tokenMetadata puts traits in extra as compact JSON the contract can search", () => {
  const meta = tokenMetadata(AGENTS[0]);
  assert.equal(meta.title, "Aloof");
  assert.equal(meta.extra, '{"temperament":"cool","role":"observer","risk":"low","voice":"dry"}');
});

test("buildDeployStep runs the init call on testnet, signed by the contract account", () => {
  const step = buildDeployStep({ contract: CONTRACT, owner: OWNER, wasm: WASM });
  assert.deepEqual(step.argv, [
    "--quiet", "contract", "deploy", CONTRACT,
    "use-file", WASM,
    "with-init-call", INIT_METHOD,
    "json-args", JSON.stringify({ owner_id: OWNER }),
    "prepaid-gas", GAS,
    "attached-deposit", "0 NEAR",
    "network-config", "testnet",
    "sign-with-keychain", "send",
  ]);
  assert.equal(step.signer, CONTRACT);
  assert.equal(step.method, INIT_METHOD);
});

test("buildMintStep builds one nft_mint call per agent with its trait metadata", () => {
  const step = buildMintStep({ contract: CONTRACT, owner: OWNER, receiver: OWNER, agent: AGENTS[1] });
  const args = JSON.parse(step.argv[step.argv.indexOf("json-args") + 1]);
  assert.deepEqual(args, {
    token_id: "chaotic",
    receiver_id: OWNER,
    token_metadata: tokenMetadata(AGENTS[1]),
  });
  assert.deepEqual(step.argv.slice(0, 6), ["--quiet", "contract", "call-function", "as-transaction", CONTRACT, MINT_METHOD]);
  assert.equal(step.argv[step.argv.indexOf("attached-deposit") + 1], MINT_DEPOSIT);
  assert.equal(step.argv[step.argv.indexOf("sign-as") + 1], OWNER);
  assert.equal(step.argv[step.argv.indexOf("network-config") + 1], NETWORK);
  assert.equal(step.argv.at(-1), "send");
  assert.ok(!step.argv.includes("mainnet"));
});

test("buildPlan: deploy is one step, mint defaults to all agents and honours count and receiver", () => {
  assert.equal(buildPlan({ command: "deploy", contract: CONTRACT, owner: OWNER, wasm: WASM }).length, 1);
  const all = buildPlan({ command: "mint", contract: CONTRACT, owner: OWNER, receiver: OWNER });
  assert.deepEqual(all.map((s) => s.name), ["mint aloof", "mint chaotic", "mint social", "mint skeptic"]);
  const three = buildPlan({ command: "mint", contract: CONTRACT, owner: OWNER, receiver: "friend.testnet", count: 3 });
  assert.equal(three.length, 3);
  assert.equal(JSON.parse(three[2].argv[three[2].argv.indexOf("json-args") + 1]).receiver_id, "friend.testnet");
  assert.throws(() => buildPlan({ command: "burn", contract: CONTRACT, owner: OWNER }), UsageError);
});

test("parseArgs rejects conflicting or incomplete options", () => {
  assert.throws(() => parseArgs([]), UsageError);
  assert.throws(() => parseArgs(["mint", "--send", "--dry-run"]), UsageError);
  assert.throws(() => parseArgs(["deploy", "--count", "2"]), UsageError);
  assert.throws(() => parseArgs(["mint", "--wasm", "x.wasm"]), UsageError);
  assert.throws(() => parseArgs(["mint", "--count"]), UsageError);
  assert.throws(() => parseArgs(["mint", "--bogus"]), UsageError);
  const opts = parseArgs(["mint"]);
  assert.equal(opts.send, false);
  assert.equal(opts.command, "mint");
});

test("shellQuote leaves plain tokens alone and quotes JSON safely", () => {
  assert.equal(shellQuote("testnet"), "testnet");
  assert.equal(shellQuote('{"a":1}'), `'{"a":1}'`);
  assert.equal(shellQuote("it's"), `'it'\\''s'`);
});

test("dry run is the default: prints every command and signs nothing", async () => {
  const c = collector();
  const code = await run(["mint", "--count", "2"], { NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: CONTRACT }, {
    exec: forbiddenExec,
    hasNear: () => { throw new Error("must not probe near in dry run"); },
    out: c.out,
    err: c.err,
  });
  assert.equal(code, 0);
  const text = c.text();
  assert.match(text, /^dry-run: nothing is signed or sent/m);
  assert.equal(text.match(/command  near --quiet contract call-function as-transaction/g).length, 2);
  assert.ok(text.includes(`"token_id":"aloof"`));
  assert.ok(text.includes(`"token_id":"chaotic"`));
  assert.ok(!text.includes("skeptic"));
  assert.ok(!/ed25519:/.test(text));
});

test("dry run prints placeholders when no env is set, and does not fail", async () => {
  const c = collector();
  const code = await run(["deploy", "--wasm", "/definitely/not/built.wasm"], {}, {
    exec: forbiddenExec, out: c.out, err: c.err,
  });
  assert.equal(code, 0);
  assert.match(c.text(), /owner: <NEAR_ACCOUNT_ID>/);
  assert.match(c.text(), /warning: wasm not found/);
});

test("dry run --json prints the plan as parseable JSON with the exact argv", async () => {
  const c = collector();
  const code = await run(["deploy", "--json"], { NEAR_ACCOUNT_ID: OWNER }, { exec: forbiddenExec, out: c.out, err: c.err });
  assert.equal(code, 0);
  const plan = JSON.parse(c.text());
  assert.equal(plan.mode, "dry-run");
  assert.equal(plan.network, "testnet");
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].command[0], "near");
  assert.equal(plan.steps[0].method, INIT_METHOD);
});

test("mainnet and other networks are refused, in both modes", async () => {
  for (const argv of [["mint"], ["mint", "--send"]]) {
    const c = collector();
    const code = await run(argv, { NEAR_NETWORK: "mainnet", NEAR_ACCOUNT_ID: OWNER }, {
      exec: forbiddenExec, out: c.out, err: c.err,
    });
    assert.equal(code, 2);
    assert.match(c.errors.join("\n"), /refuses other networks/);
  }
});

test("--send refuses to run without a valid NEAR_ACCOUNT_ID and never calls near", async () => {
  const c = collector();
  const code = await run(["mint", "--send"], {}, { exec: forbiddenExec, hasNear: () => true, out: c.out, err: c.err });
  assert.equal(code, 2);
  assert.match(c.errors.join("\n"), /NEAR_ACCOUNT_ID is unset/);
});

test("--send stops before any transaction when near-cli-rs is missing or has no keychain key", async () => {
  const noBinary = collector();
  assert.equal(await run(["mint", "--send", "--media-base", "https://art.example"], { NEAR_ACCOUNT_ID: OWNER }, {
    exec: forbiddenExec, hasNear: () => false, out: noBinary.out, err: noBinary.err,
  }), 1);

  const calls = [];
  const noKey = collector();
  const exec = (bin, argv) => {
    calls.push(argv);
    return argv.includes("get-public-key") ? 1 : 0;
  };
  const code = await run(["mint", "--send", "--media-base", "https://art.example"], { NEAR_ACCOUNT_ID: OWNER }, {
    exec, hasNear: () => true, out: noKey.out, err: noKey.err,
  });
  assert.equal(code, 1);
  assert.equal(calls.length, 1, "only the keychain probe may run");
  assert.deepEqual(calls[0].slice(0, 5), ["--quiet", "account", "get-public-key", "from-keychain", OWNER]);
  assert.ok(!calls.some((argv) => argv.includes("send")));
  assert.match(noKey.errors.join("\n"), /never reads or creates keys/);
});

test("--send deploy checks the wasm first and does not sign if it is missing", async () => {
  const c = collector();
  const code = await run(["deploy", "--send", "--wasm", "/no/such/file.wasm"], {
    NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: CONTRACT,
  }, { exec: forbiddenExec, hasNear: () => true, out: c.out, err: c.err });
  assert.equal(code, 1);
  assert.match(c.errors.join("\n"), /npm run build:contract/);
});

test("--send probes every signer, then sends mints in order; stops at the first failed mint", async () => {
  const probes = [];
  const sent = [];
  const c = collector();
  const exec = (bin, argv, opts) => {
    assert.equal(bin, "near");
    if (opts?.quiet) {
      probes.push(argv[4]); // account id in `get-public-key from-keychain <acct>`
      return 0;
    }
    sent.push(argv);
    return sent.length === 2 ? 9 : 0; // second mint fails
  };
  const code = await run(["mint", "--send", "--media-base", "https://art.example", "--count", "3"], {
    NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: CONTRACT,
  }, { exec, hasNear: () => true, out: c.out, err: c.err });
  assert.equal(code, 9);
  assert.deepEqual(probes, [OWNER]);
  assert.equal(sent.length, 2, "third mint must not be attempted after the second fails");
  assert.ok(sent.every((argv) => argv.includes(MINT_METHOD) && argv.at(-1) === "send"));
  assert.ok(c.errors.join("\n").includes("stopping"));
});

test("--send deploy signs the init call on the contract account with the wasm given", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "near-deploy-test-"));
  const wasm = path.join(dir, "personality_nft.wasm");
  writeFileSync(wasm, "\0asm");
  try {
    const sent = [];
    const c = collector();
    const exec = (_bin, argv, opts) => {
      if (!opts?.quiet) sent.push(argv);
      return 0;
    };
    const code = await run(["deploy", "--send", "--wasm", wasm], {
      NEAR_ACCOUNT_ID: OWNER, NEAR_CONTRACT_ACCOUNT_ID: CONTRACT,
    }, { exec, hasNear: () => true, out: c.out, err: c.err });
    assert.equal(code, 0, c.errors.join("\n"));
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].slice(0, 4), ["--quiet", "contract", "deploy", CONTRACT]);
    assert.equal(sent[0][sent[0].indexOf("use-file") + 1], wasm);
    assert.equal(sent[0].at(-1), "send");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI dry run works with no near binary on PATH and no env", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "mint"], {
    env: { PATH: path.dirname(process.execPath) },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.match(/^ {2}command {2}near /gm).length, AGENTS.length);
  assert.match(result.stdout, /dry-run: nothing is signed or sent/);
});

test("CLI --send without env exits 2 and prints usage, not a transaction", () => {
  const result = spawnSync(process.execPath, [SCRIPT, "deploy", "--send"], {
    env: { PATH: path.dirname(process.execPath) },
    encoding: "utf8",
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /NEAR_ACCOUNT_ID is unset/);
});

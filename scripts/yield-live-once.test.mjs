// yield:live:once is the one offline entry for the approved live run. These tests prove it never
// runs near (a recorder `near` sits first on PATH), refuses sends and mainnet, never prints or
// opens key material, exits non-zero when not ready, and prints the ordered commands when ready.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CREDENTIALS_DIR, NFT_WASM, environmentChecks, main, onPath } from "./yield-live-once.mjs";

const SCRIPT = fileURLToPath(new URL("./yield-live-once.mjs", import.meta.url));
const EXAMPLE = fileURLToPath(new URL("../config/yield-vault.live.example.json", import.meta.url));
const KEY = "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp";
const SECRET = "ed25519:SECRETSENTINEL4tqzK3pXw9vYb2mN8cR5dF7gH1jL6aQ0sT";
const MEDIA = "https://media.example/agents";
const T = { timeout: 60_000 };
const IDS = { owner_id: "alice.testnet", vault_id: "vault.alice.testnet", runner_id: "run.alice.testnet", nft_contract_id: "nft.alice.testnet" };

const tmp = () => mkdtempSync(join(tmpdir(), "ylonce74-"));

/** A bin dir whose `near` only records that it was called. */
function recorder() {
  const dir = tmp();
  const log = join(dir, "near-called.log");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "near"), `#!/bin/sh\necho "$@" >> '${log}'\nexit 0\n`);
  chmodSync(join(bin, "near"), 0o755);
  return { bin, log, called: () => existsSync(log) };
}

function filledConfig(extra = {}) {
  const c = JSON.parse(readFileSync(EXAMPLE, "utf8"));
  Object.assign(c, { placeholders: false, ...IDS, token_id: "chaotic", agent: "chaotic" }, extra);
  c.public_keys = { vault: KEY, runner: KEY };
  const file = join(tmp(), "live.json");
  writeFileSync(file, JSON.stringify(c));
  return file;
}

/** A home with an unreadable (chmod 000) legacy credential file per signer, each holding a secret. */
function homeWithKeys(ids = Object.values(IDS)) {
  const home = tmp();
  const dir = join(home, CREDENTIALS_DIR);
  mkdirSync(dir, { recursive: true });
  for (const id of ids) {
    const f = join(dir, `${id}.json`);
    writeFileSync(f, JSON.stringify({ account_id: id, public_key: KEY, private_key: SECRET }));
    chmodSync(f, 0o000); // opening it would throw EACCES; existence must be enough
  }
  return home;
}

function rootWithNftWasm() {
  const root = tmp();
  mkdirSync(join(root, NFT_WASM, ".."), { recursive: true });
  writeFileSync(join(root, NFT_WASM), "\0asm");
  return root;
}

/** In-process run of a fully ready setup; `over` replaces any part. preflight is stubbed (no built wasm here). */
async function runReady(over = {}) {
  const rec = over.rec ?? recorder();
  const calls = [];
  const out = [];
  const errs = [];
  const io = {
    log: (...a) => out.push(a.join(" ")),
    err: (s) => errs.push(s),
    env: { PATH: rec.bin, NEAR_NETWORK: "testnet", ...over.env },
    home: over.home ?? homeWithKeys(),
    root: over.root ?? rootWithNftWasm(),
    preflight: async (argv, pio) => {
      calls.push(argv);
      pio.log("READY FOR LIVE: yes (stub)");
      return over.preflightCode ?? 0;
    },
  };
  const argv = over.argv ?? ["--config", over.config ?? filledConfig(), "--media-base", MEDIA];
  // Any child process spawned through PATH would hit the recorder too.
  const savedPath = process.env.PATH;
  process.env.PATH = `${rec.bin}${delimiter}${savedPath}`;
  try {
    const code = await main(argv, io);
    return { code, stdout: out.join("\n"), stderr: errs.join("\n"), calls, rec };
  } finally {
    process.env.PATH = savedPath;
  }
}

function spawnOnce(args, env = {}) {
  const rec = recorder();
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 50_000,
    env: { PATH: `${rec.bin}${delimiter}${process.env.PATH}`, HOME: homeWithKeys(), ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, rec };
}

test("ready: prints NFT deploy, one mint, vault steps through the swap, then STOP; near never runs", T, async () => {
  const r = await runReady();
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.rec.called(), false, "near was invoked");
  assert.deepEqual(r.calls, [["preflight", "--config", r.calls[0][2], "--require-ready"]]);
  const s = r.stdout;
  const at = (needle) => {
    const i = s.indexOf(needle);
    assert.ok(i >= 0, `missing ${needle}`);
    return i;
  };
  const order = [
    at("READY FOR LIVE (offline checks)"),
    at("near contract deploy nft.alice.testnet use-file contracts/personality-nft/target/near/personality_nft.wasm with-init-call new_default_meta"),
    at("near contract call-function as-transaction nft.alice.testnet nft_mint json-args '{\"token_id\":\"chaotic\""),
    at("near account create-account fund-myself vault.alice.testnet"),
    at("near contract deploy vault.alice.testnet use-file contracts/yield-vault/target/near/yield_vault.wasm with-init-call new"),
    at(" execute_swap json-args "),
    at("STOP. The swap is plan step 19."),
  ];
  assert.deepEqual([...order].sort((a, b) => a - b), order, "sections out of order");
  assert.equal((s.match(/ nft_mint /g) ?? []).length, 1, "exactly one mint");
  assert.equal((s.match(/ execute_swap /g) ?? []).length, 1, "exactly one swap");
  assert.match(s, /media\.example\/agents\/chaotic\.svg/);
  const mint = s.split("\n").find((l) => l.includes(" nft_mint "));
  assert.match(mint, /"receiver_id":"alice\.testnet"/);
  assert.match(mint, /attached-deposit '0\.05 NEAR' sign-as alice\.testnet network-config testnet sign-with-keychain send$/);
  assert.match(s, /with-init-call new_default_meta json-args '\{"owner_id":"alice\.testnet"\}'/);
  const vaultNew = s.split("\n").find((l) => l.includes("with-init-call new json-args"));
  assert.match(vaultNew, /"owner_id":"alice\.testnet","nft_contract_id":"nft\.alice\.testnet","token_id":"chaotic"/);
  assert.match(s.split("\n").find((l) => l.includes(" execute_swap ")), /sign-as run\.alice\.testnet network-config testnet/);
  assert.match(s, /^manual: the NFT contract account nft\.alice\.testnet must already exist/m);
  for (const line of s.split("\n").filter((l) => l.trimStart().startsWith("near "))) {
    assert.match(line, /network-config testnet /, line);
    assert.doesNotMatch(line, / --quiet\b/);
  }
  assert.doesNotMatch(s, /mainnet/i);
  assert.match(s, /Nothing was signed or sent; near was not run\./);
});

test("ready: the setup list has no withdraw, pause, revoke or delete command and points at --teardown", T, async () => {
  const r = await runReady();
  assert.equal(r.code, 0, r.stderr);
  const cmds = r.stdout.split("\n").filter((l) => l.trimStart().startsWith("near "));
  assert.ok(cmds.length >= 20, "setup-through-swap commands are printed");
  for (const l of cmds) assert.doesNotMatch(l, /withdraw|pause|revoke|delete-account|delete_account|unregister/i, l);
  assert.doesNotMatch(r.stdout, /plan step (2[1-9]|3\d) /, "no teardown step in the setup list");
  assert.match(r.stdout, /This list is setup through the swap only\./);
  assert.match(r.stdout, /STOP\. The swap is plan step 19\. Plan steps 21-36 \(16 more: withdraw and rollback\) are deferred until AFTER the agent send/);
  assert.match(r.stdout, /npm run yield:live:once -- .* --teardown/);
  assert.match(r.stdout, /npm run yield:live:dry-run -- .* --rollback/);
});

test("--teardown: ready prints only the after-swap list (withdraw, rollback); not ready still exits 3", T, async () => {
  const r = await runReady({ argv: ["--config", filledConfig(), "--media-base", MEDIA, "--teardown"] });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.rec.called(), false, "near was invoked");
  const cmds = r.stdout.split("\n").filter((l) => l.trimStart().startsWith("near "));
  assert.ok(cmds.some((l) => /withdraw/.test(l)), "withdraw is in the teardown list");
  assert.ok(cmds.some((l) => /delete-account/.test(l)), "account deletion is in the teardown list");
  assert.equal(cmds.filter((l) => / execute_swap | nft_mint /.test(l)).length, 0, "no swap or mint in teardown");
  assert.doesNotMatch(r.stdout, /with-init-call/);
  assert.match(r.stdout, /plan step 24 \[withdraw\]/);
  assert.doesNotMatch(r.stdout, /plan step (1|19|20) \[/);
  const bad = await runReady({ argv: ["--config", filledConfig(), "--teardown"] });
  assert.equal(bad.code, 3, "teardown needs the same checks (here --media-base)");
  assert.doesNotMatch(bad.stdout, /near (account|contract)/);
});

test("ready: no secret from a key file or env is printed, and key files are never opened", T, async () => {
  const r = await runReady({ env: { NEAR_PRIVATE_KEY: SECRET, NEAR_SEED_PHRASE: "sentinel seed words never shown" } });
  assert.equal(r.code, 0, r.stderr);
  for (const out of [r.stdout, r.stderr]) {
    assert.ok(!out.includes(SECRET));
    assert.ok(!out.includes("SECRETSENTINEL"));
    assert.ok(!out.includes("sentinel seed"));
    assert.doesNotMatch(out, /private_key/);
  }
  assert.match(r.stdout, /credential file: owner: present \(not opened\)/);
});

test("not ready: each missing piece alone exits 3, names it, prints no command", T, async () => {
  const cases = [
    ["near-cli-rs on PATH", { env: { PATH: tmp() } }],
    ["NEAR_NETWORK=testnet", { env: { NEAR_NETWORK: "" } }],
    ["--media-base", { argv: ["--config", filledConfig()] }],
    ["personality NFT wasm", { root: tmp() }],
    ["credential file: runner", { home: homeWithKeys([IDS.owner_id, IDS.vault_id, IDS.nft_contract_id]) }],
    ["config token_id is a personality NFT", { config: filledConfig({ token_id: "aloof" }) }],
    ["config token_id is a personality NFT", { config: filledConfig({ token_id: "7", agent: undefined }) }],
    ["NEAR_ACCOUNT_ID agrees with config owner_id", { env: { NEAR_ACCOUNT_ID: "someone-else.testnet" } }],
    ["config filled in (no placeholders)", { config: filledConfig({ placeholders: true }) }],
    ["yield:live:preflight --require-ready", { preflightCode: 3 }],
  ];
  for (const [name, over] of cases) {
    const r = await runReady(over);
    assert.equal(r.code, 3, `${name}: ${r.stderr}`);
    assert.ok(r.stderr.includes(name), `${name} not named: ${r.stderr}`);
    assert.match(r.stdout, /NOT READY FOR LIVE\. Nothing was signed or sent; near was not run\./);
    assert.doesNotMatch(r.stdout, /^\s*\d+\. .*\n\s+near /m, `${name}: a command was printed`);
    assert.ok(!r.stdout.includes("someone-else"), "an env value was printed");
    assert.equal(r.rec.called(), false);
  }
});

test("--keys-in-os-keychain turns a missing credential file into a MANUAL line", T, async () => {
  const r = await runReady({ home: tmp(), argv: ["--config", filledConfig(), "--media-base", MEDIA, "--keys-in-os-keychain"] });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^manual: credential file: vault: /m);
});

test("the legacy <id>/<public key>.json layout counts as present; an empty <id>/ does not", T, () => {
  const home = tmp();
  for (const id of Object.values(IDS)) mkdirSync(join(home, CREDENTIALS_DIR, id), { recursive: true });
  const check = () => environmentChecks({ config: { ...IDS, token_id: "chaotic" }, opts: { mediaBase: MEDIA }, env: {}, home, root: tmp() });
  assert.equal(check().filter((r) => r.name.startsWith("credential file") && r.status === "ok").length, 0);
  for (const id of Object.values(IDS)) {
    const f = join(home, CREDENTIALS_DIR, id, `${KEY.replace(":", "_")}.json`);
    writeFileSync(f, SECRET);
    chmodSync(f, 0o000);
  }
  assert.equal(check().filter((r) => r.name.startsWith("credential file") && r.status === "ok").length, 4);
});

test("preflight FAIL exits 1 and prints no command", T, async () => {
  const r = await runReady({ preflightCode: 1 });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /preflight exited 1/);
  assert.doesNotMatch(r.stdout, / nft_mint /);
});

test("onPath scans PATH without running anything; a non-executable file does not count", T, () => {
  const rec = recorder();
  assert.equal(onPath("near", rec.bin), true);
  const plain = tmp();
  writeFileSync(join(plain, "near"), "not executable");
  assert.equal(onPath("near", plain), false);
  assert.equal(onPath("near", ""), false);
  assert.equal(rec.called(), false);
});

test("subprocess, example config: real preflight, recorder near on PATH, exit 3, near never runs", T, () => {
  const r = spawnOnce([], { NEAR_NETWORK: "testnet" });
  assert.equal(r.code, 3, r.stderr);
  assert.equal(r.rec.called(), false, "near was invoked");
  assert.match(r.stdout, /READY FOR LIVE: no/);
  assert.match(r.stdout, /OK\s+near-cli-rs on PATH: found \(not run\)/);
  assert.match(r.stderr, /yield:live:once: not ready for live: /);
  assert.ok(!(r.stdout + r.stderr).includes("SECRETSENTINEL"));
});

test("subprocess: --send / --i-approve / signing flags are refused with exit 2 before anything runs", T, () => {
  for (const args of [["--send"], ["--i-approve"], ["--send", "--i-approve"], ["--sign-with-keychain"], ["--private-key", "x"], ["--online"]]) {
    const r = spawnOnce(args, { NEAR_NETWORK: "testnet" });
    assert.equal(r.code, 2, `${args}: ${r.stderr}`);
    assert.equal(r.stdout, "", `${args} printed on stdout`);
    assert.match(r.stderr, /never signs, sends or runs near/);
    assert.equal(r.rec.called(), false);
  }
});

test("subprocess: mainnet is refused with exit 2 (env and config)", T, () => {
  for (const env of [{ NEAR_NETWORK: "mainnet" }, { NEAR_NETWORK: "Mainnet" }, { NEAR_NETWORK: "betanet" }, { NEAR_ACCOUNT_ID: "alice.near" }, { NEAR_CONTRACT_ACCOUNT_ID: "nft.near" }, { YIELD_VAULT_ACCOUNT_ID: "v.near" }]) {
    const r = spawnOnce([], env);
    assert.equal(r.code, 2, `${JSON.stringify(env)}: ${r.stderr}`);
    assert.equal(r.stdout, "");
    assert.ok(!r.stderr.includes("alice.near") && !r.stderr.includes("nft.near"), "value echoed");
    assert.equal(r.rec.called(), false);
  }
  const r = spawnOnce(["--config", filledConfig({ owner_id: "alice.near" })], { NEAR_NETWORK: "testnet" });
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.stdout, / nft_mint /);
  assert.equal(r.rec.called(), false);
});

test("subprocess: --help exits 0, but not past a send flag; unknown flags exit 2", T, () => {
  assert.equal(spawnOnce(["--help"]).code, 0);
  assert.equal(spawnOnce(["--help", "--send"]).code, 2);
  assert.equal(spawnOnce(["--bogus"]).code, 2);
});

test("READY=no messaging: names accounts, key location, the approved run, and that nothing is sent", T, async () => {
  const r = await runReady({ home: homeWithKeys([]) });
  assert.equal(r.code, 3, r.stderr);
  for (const id of Object.values(IDS)) assert.ok(r.stdout.includes(id), `account ${id} not named`);
  assert.match(r.stdout, /no ~\/\.near-credentials\/testnet\/\S+\.json/);
  assert.match(r.stdout, /Put the keys in the near-cli-rs keychain: ~\/\.near-credentials\/testnet\/<account>\.json/);
  assert.match(r.stdout, /--keys-in-os-keychain/);
  assert.match(r.stdout, /Approved run \(the only one\): deploy the yield vault, mint ONE personality NFT, make ONE small Rhea \(Ref\) testnet swap\./);
  assert.match(r.stdout, /Faucet test NEAR only, testnet only\./);
  assert.match(r.stdout, /Nothing is signed or sent until READY FOR LIVE is yes and the owner runs the printed commands by hand\./);
  assert.equal(r.rec.called(), false);
});

test("subprocess, example config: the READY=no output carries the approved-run and key-location facts", T, () => {
  const r = spawnOnce([], { NEAR_NETWORK: "testnet" });
  assert.equal(r.code, 3, r.stderr);
  assert.match(r.stdout, /Approved run \(the only one\)/);
  assert.match(r.stdout, /Faucet test NEAR only/);
  assert.match(r.stdout, /Testnet accounts that need keys: /);
  assert.match(r.stdout, /~\/\.near-credentials\/testnet\//);
});

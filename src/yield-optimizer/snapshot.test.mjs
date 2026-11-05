// Behaviour tests for snapshot validation (snapshot.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlan } from "./plan.mjs";
import { quoteOut } from "../yield/pools.mjs";
import { MOCK_EPOCH_MS } from "../yield/mock.mjs";
import { dayOf } from "../yield/rules.mjs";
import { PLACEHOLDER_RUNNER, PLACEHOLDER_VAULT } from "../yield/strategies.mjs";
import { defaultSnapshot, loadSnapshot, parseSnapshot, rulesView, SnapshotError } from "./snapshot.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/scenario.hand-built.json", import.meta.url));
const raw = () => JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const rejects = (mutate, re) => {
  const r = raw();
  mutate(r);
  assert.throws(() => parseSnapshot(r), (e) => e instanceof SnapshotError && (!re || re.test(e.message)), String(re));
};

describe("parseSnapshot", () => {
  it("parses the scenario into pools.mjs-shaped BigInt pools and a now_ms", () => {
    const s = parseSnapshot(raw());
    assert.equal(s.pools.length, 3);
    assert.equal(typeof s.pools[0].reserve_a, "bigint");
    assert.deepEqual(Object.keys(s.pools[0]).sort(), ["pool_id", "pool_kind", "reserve_a", "reserve_b", "token_a", "token_b", "total_fee"]);
    // The pool is readable by the one quote function.
    assert.ok(quoteOut(s.pools[0], s.pools[0].token_a, 10n ** 24n) > 0n);
    assert.equal(s.now_ms, Date.parse("2026-11-04T12:00:00Z"));
    assert.equal(s.block_height, null);
    assert.equal(s.tokens["wnear.fixture.testnet"].symbol, "wnear");
    assert.equal(s.tokens["wnear.fixture.testnet"].ref_price, 3.1);
    assert.equal(s.tokens["ghost.fixture.testnet"].ref_price, null);
    assert.equal(s.vault.state.balances.get("usdc.fixture.testnet"), 500_000_000n);
    assert.equal(s.vault_id, "yield-vault.fixture.testnet");
  });

  it("rejects non-object JSON values", () => {
    for (const v of [[], null, 5, "x", true]) {
      assert.throws(() => parseSnapshot(v), SnapshotError);
    }
  });

  it("rejects a mock_usd_price that overflows to Infinity", () =>
    rejects((r) => (r.tokens["wnear.fixture.testnet"].mock_usd_price = "9".repeat(400)), /mock_usd_price must be a finite number > 0/));
  it("rejects control characters in ids and symbols (they would reach the terminal)", () => {
    rejects((r) => (r.vault.vault_id = "vault.testnet\n\u001b[2Jfake"), /vault_id must not contain control characters/);
    rejects((r) => (r.tokens["wnear.fixture.testnet"].symbol = "w\u001b[31m"), /symbol must not contain control characters/);
    rejects((r) => {
      r.tokens["evil\nid.testnet"] = { decimals: 6, mock_usd_price: "1.00" };
    }, /token id with control characters/);
  });
  it("rejects missing pools", () => rejects((r) => delete r.pools, /pools must be an array/));
  it("rejects an empty reserve", () => rejects((r) => (r.pools[0].reserve_b = "0"), /empty reserve/));
  it("rejects a non-SIMPLE_POOL", () => rejects((r) => (r.pools[0].pool_kind = "STABLE_SWAP"), /SIMPLE_POOL/));
  it("rejects an amount that is not a decimal string", () => {
    rejects((r) => (r.pools[0].reserve_a = 1000), /decimal string/);
    rejects((r) => (r.pools[0].reserve_a = "1.5"), /decimal string/);
    rejects((r) => (r.pools[0].reserve_a = "-3"), /decimal string/);
    rejects((r) => (r.vault.state.balances[0][1] = "0x10"), /decimal string/);
  });
  it("rejects an amount above u128", () => {
    rejects((r) => (r.pools[0].reserve_a = (2n ** 128n).toString()), /exceeds u128/);
    // u128 max itself is accepted.
    const r = raw();
    r.pools[0].reserve_a = (2n ** 128n - 1n).toString();
    assert.doesNotThrow(() => parseSnapshot(r));
  });
  it("rejects duplicate pool ids", () => rejects((r) => (r.pools[1].pool_id = 17), /pool_id twice/));
  it("rejects an unknown token in a pool", () =>
    rejects((r) => (r.pools[0].token_a = "nobody.fixture.testnet"), /no entry in tokens/));
  it("rejects a pool listing the same token twice", () =>
    rejects((r) => (r.pools[0].token_b = "wnear.fixture.testnet"), /same token twice/));
  it("rejects an invalid config (bad strategy)", () =>
    rejects((r) => (r.vault.config.strategy = "yolo"), /not a valid VaultConfig: ERR_BAD_CONFIG: strategy/));
  it("rejects an invalid config (zero max_trade)", () =>
    rejects((r) => (r.vault.config.limits[0].max_trade = "0"), /ERR_BAD_CONFIG: max_trade/));
  it("rejects a duplicate balance token", () =>
    rejects((r) => r.vault.state.balances.push(["wnear.fixture.testnet", "1"]), /lists wnear\.fixture\.testnet twice/));
  it("rejects a bad taken_at", () => rejects((r) => (r.taken_at = "not a date"), /taken_at/));
  it("needs exactly one clock: taken_at or now_ms", () => {
    rejects((r) => delete r.taken_at, /exactly one of taken_at/);
    rejects((r) => (r.now_ms = 5), /exactly one of taken_at/);
    const r = raw();
    delete r.taken_at;
    r.now_ms = MOCK_EPOCH_MS;
    assert.equal(parseSnapshot(r).now_ms, MOCK_EPOCH_MS);
    assert.equal(parseSnapshot(r).taken_at, null);
    rejects((x) => { delete x.taken_at; x.now_ms = -1; }, /now_ms/);
    rejects((x) => { delete x.taken_at; x.now_ms = "5"; }, /now_ms/);
  });
  it("rejects a missing vault section", () => rejects((r) => delete r.vault, /vault must be an object/));
  it("rejects a bad _block_height", () => rejects((r) => (r._block_height = "x"), /_block_height/));
  it("reads _block_height and _source when present", () => {
    const r = raw();
    r._block_height = 276143441;
    const s = parseSnapshot(r);
    assert.equal(s.block_height, 276143441);
    assert.match(s.source, /hand-built/);
  });
  it("rejects a taken_at without Z or an offset (local-time ambiguity)", () =>
    rejects((r) => (r.taken_at = "2026-11-04T12:00:00"), /taken_at/));
  it("rejects an impossible calendar date instead of rolling it over", () =>
    rejects((r) => (r.taken_at = "2026-02-30T00:00:00Z"), /not a real calendar date/));
  it("rejects an impossible time of day", () =>
    rejects((r) => (r.taken_at = "2026-11-04T24:00:00Z"), /not a real calendar date/));
  it("accepts an explicit offset", () => {
    const raw = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    raw.taken_at = "2026-11-04T06:00:00-06:00";
    assert.equal(parseSnapshot(raw).now_ms, Date.parse("2026-11-04T12:00:00Z"));
  });
  it("rejects a non-boolean paused flag", () => rejects((r) => (r.vault.state.paused = "no"), /paused/));
  it("rejects a non-positive or malformed mock_usd_price, accepts null as no price", () => {
    rejects((r) => (r.tokens["wnear.fixture.testnet"].mock_usd_price = "0"), /mock_usd_price/);
    rejects((r) => (r.tokens["wnear.fixture.testnet"].mock_usd_price = 3), /mock_usd_price/);
    rejects((r) => (r.tokens["wnear.fixture.testnet"].mock_usd_price = "-1"), /mock_usd_price/);
    const r = raw();
    r.tokens["wnear.fixture.testnet"].mock_usd_price = null;
    assert.equal(parseSnapshot(r).tokens["wnear.fixture.testnet"].ref_price, null);
  });
  it("uses an explicit token symbol when given", () => {
    const r = raw();
    r.tokens["wnear.fixture.testnet"].symbol = "wNEAR";
    assert.equal(parseSnapshot(r).tokens["wnear.fixture.testnet"].symbol, "wNEAR");
  });

  it("a snapshot with zero pools parses and plans to hold", () => {
    const r = raw();
    r.pools = [];
    const plan = buildPlan(parseSnapshot(r));
    assert.equal(plan.json.decision, "hold");
    assert.equal(plan.json.reason, "snapshot has no pools");
    assert.equal(plan.json.call, null);
  });
});

describe("loadSnapshot", () => {
  let dir;
  const write = (name, text) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, text);
    return f;
  };
  before(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-snapshot-"));
  });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("loads the committed hand-built scenario", () => {
    assert.equal(loadSnapshot(FIXTURE).pools.length, 3);
  });
  it("rejects an empty file", () => {
    assert.throws(() => loadSnapshot(write("empty.json", "")), (e) => e instanceof SnapshotError && /is empty/.test(e.message));
  });
  it("rejects a whitespace-only file", () => {
    assert.throws(() => loadSnapshot(write("ws.json", " \n\t \n")), (e) => e instanceof SnapshotError && /is empty/.test(e.message));
  });
  it("rejects invalid JSON", () => {
    assert.throws(() => loadSnapshot(write("bad.json", "{ nope")), (e) => e instanceof SnapshotError && /not valid JSON/.test(e.message));
  });
  it("rejects a missing file", () => {
    assert.throws(() => loadSnapshot(path.join(dir, "absent.json")), (e) => e instanceof SnapshotError && /cannot read snapshot/.test(e.message));
  });
  it("rejects a directory", () => {
    assert.throws(() => loadSnapshot(dir), SnapshotError);
  });
  it("rejects non-object JSON ([] and null)", () => {
    assert.throws(() => loadSnapshot(write("arr.json", "[]")), (e) => e instanceof SnapshotError && /JSON object/.test(e.message));
    assert.throws(() => loadSnapshot(write("null.json", "null")), (e) => e instanceof SnapshotError && /JSON object/.test(e.message));
  });
  it("rejects a structurally invalid snapshot file", () => {
    const r = raw();
    delete r.vault;
    assert.throws(() => loadSnapshot(write("novault.json", JSON.stringify(r))), SnapshotError);
  });
});

describe("rulesView (the adapter onto src/yield/rules.mjs)", () => {
  it("maps the snapshot vault to the rules.mjs shapes", () => {
    const v = rulesView(parseSnapshot(raw()));
    assert.equal(v.nowMs, Date.parse("2026-11-04T12:00:00Z"));
    assert.equal(v.state.paused, false);
    assert.equal(v.state.in_flight, false);
    assert.equal(v.state.recovery_in_flight, false);
    assert.equal(v.state.spent.day, 20761);
    assert.deepEqual({ ...v.state.spent.amounts }, { "wnear.fixture.testnet": 100_000_000_000_000_000_000_000_000n });
    assert.equal(v.state.balances["usdc.fixture.testnet"], 500_000_000n);
    assert.equal(v.state.balances.toString, undefined);
  });

  it("carries the swap and recovery in-flight flags", () => {
    const r = raw();
    r.vault.state.swap_in_flight = true;
    r.vault.state.recovery_in_flight = true;
    const v = rulesView(parseSnapshot(r));
    assert.equal(v.state.in_flight, true);
    assert.equal(v.state.recovery_in_flight, true);
  });

  it("taken_at lands on the same UTC day as the contract's ns / NS_PER_DAY", () => {
    for (const [at, day] of [["2026-11-04T00:00:00Z", 20761], ["2026-11-04T23:59:59Z", 20761], ["2026-11-05T00:00:00Z", 20762], ["2026-11-04T23:30:00-05:00", 20762]]) {
      const r = raw();
      r.taken_at = at;
      const s = parseSnapshot(r);
      assert.equal(dayOf(rulesView(s).nowMs), day, at);
      assert.equal(Math.floor((s.now_ms * 1_000_000) / 86_400_000_000_000), day, at);
    }
  });
});

describe("defaultSnapshot (the shared Ref market)", () => {
  const s = defaultSnapshot();

  it("loadSnapshot(null) and loadSnapshot() give it", () => {
    assert.deepEqual(loadSnapshot(null).pools.map((p) => p.pool_id), s.pools.map((p) => p.pool_id));
    assert.equal(loadSnapshot().vault_id, PLACEHOLDER_VAULT);
  });

  it("reads the committed Ref fixture, labelled by block height and source, with the demo ids and the mock clock", () => {
    const ref = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../yield/fixtures/ref-testnet-pools.json", import.meta.url)), "utf8"));
    assert.equal(s.block_height, ref._block_height);
    assert.equal(s.source, ref._source);
    assert.deepEqual(s.pools.map((p) => p.pool_id), ref.pools.map((p) => p.pool_id));
    assert.equal(s.pools[1].reserve_a, BigInt(ref.pools[1].reserve_a));
    assert.equal(s.vault_id, PLACEHOLDER_VAULT);
    assert.equal(s.runner_id, PLACEHOLDER_RUNNER);
    assert.equal(s.now_ms, MOCK_EPOCH_MS);
    assert.equal(s.taken_at, null);
  });

  it("reference prices are the fixture's mock_usd_price; null stays null", () => {
    assert.equal(s.tokens["wrap.testnet"].ref_price, 3);
    assert.equal(s.tokens["nusdt.ft-fin.testnet"].ref_price, 1);
    assert.equal(s.tokens["rft.tokenfactory.testnet"].ref_price, null);
    assert.equal(s.tokens["wrap.testnet"].symbol, "wrap");
  });

  it("the planner vault allows pools 0, 1 and 747 for the demo runner and funds every traded token", () => {
    const v = rulesView(s);
    assert.deepEqual(v.config.allowed_pools.map((p) => p.pool_id), [0, 1, 747]);
    assert.deepEqual(v.config.runners, [PLACEHOLDER_RUNNER]);
    assert.deepEqual(v.config.limits.map((l) => l.token_id).sort(), ["nusdc.ft-fin.testnet", "nusdt.ft-fin.testnet", "rft.tokenfactory.testnet", "usdc.fakes.testnet", "usdt.fakes.testnet", "wrap.testnet"]);
    for (const l of v.config.limits) assert.ok(v.state.balances[l.token_id] > l.max_trade, l.token_id);
    assert.equal(v.nowMs, MOCK_EPOCH_MS);
    assert.equal(v.state.spent.day, dayOf(MOCK_EPOCH_MS));
  });
});

describe("mainnet (.near) accounts are refused", () => {
  it("rejects a .near vault_id, runner_id and config.runners entry, case-insensitively", () => {
    rejects((r) => { r.vault.vault_id = "yield-vault.near"; }, /vault\.vault_id ends in \.near \(mainnet\)\. This tool only ever targets testnet\./);
    rejects((r) => { r.vault.runner_id = "runner.near"; }, /vault\.runner_id ends in \.near/);
    rejects((r) => { r.vault.vault_id = "X.NEAR"; }, /vault\.vault_id ends in \.near/);
    rejects((r) => { r.vault.config.runners = ["ok.testnet", "bot.near"]; }, /vault\.config\.runners\[1\] ends in \.near/);
  });
  it("still accepts the committed hand-built scenario and .testnet / .near.testnet ids", () => {
    parseSnapshot(raw());
    const r = raw();
    r.vault.vault_id = "a.near.testnet";
    parseSnapshot(r);
  });
});

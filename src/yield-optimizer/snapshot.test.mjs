// Behaviour tests for snapshot validation (snapshot.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildPlan } from "./plan.mjs";
import { loadSnapshot, parseSnapshot, SnapshotError } from "./snapshot.mjs";

const FIXTURE = fileURLToPath(new URL("./fixtures/rhea-testnet-snapshot.json", import.meta.url));
const raw = () => JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
const rejects = (mutate, re) => {
  const r = raw();
  mutate(r);
  assert.throws(() => parseSnapshot(r), (e) => e instanceof SnapshotError && (!re || re.test(e.message)), String(re));
};

describe("parseSnapshot", () => {
  it("parses the fixture into BigInt amounts and a now_ns", () => {
    const s = parseSnapshot(raw());
    assert.equal(s.pools.length, 3);
    assert.equal(typeof s.pools[0].reserves[0], "bigint");
    assert.equal(s.now_ns, BigInt(Date.parse("2026-11-04T12:00:00Z")) * 1_000_000n);
    assert.equal(s.vault.state.balances.get("usdc.fixture.testnet"), 500_000_000n);
    assert.equal(s.vault_id, "yield-vault.fixture.testnet");
  });

  it("rejects non-object JSON values", () => {
    for (const v of [[], null, 5, "x", true]) {
      assert.throws(() => parseSnapshot(v), SnapshotError);
    }
  });

  it("rejects missing pools", () => rejects((r) => delete r.pools, /pools must be an array/));
  it("rejects an empty reserve", () => rejects((r) => (r.pools[0].amounts[1] = "0"), /empty reserve/));
  it("rejects a non-SIMPLE_POOL", () => rejects((r) => (r.pools[0].pool_kind = "STABLE_SWAP"), /SIMPLE_POOL/));
  it("rejects an amount that is not a decimal string", () => {
    rejects((r) => (r.pools[0].amounts[0] = 1000), /decimal string/);
    rejects((r) => (r.pools[0].amounts[0] = "1.5"), /decimal string/);
    rejects((r) => (r.pools[0].amounts[0] = "-3"), /decimal string/);
    rejects((r) => (r.vault.state.balances[0][1] = "0x10"), /decimal string/);
  });
  it("rejects an amount above u128", () => {
    rejects((r) => (r.pools[0].amounts[0] = (2n ** 128n).toString()), /exceeds u128/);
    // u128 max itself is accepted.
    const r = raw();
    r.pools[0].amounts[0] = (2n ** 128n - 1n).toString();
    assert.doesNotThrow(() => parseSnapshot(r));
  });
  it("rejects duplicate pool ids", () => rejects((r) => (r.pools[1].pool_id = 17), /pool_id twice/));
  it("rejects an unknown token in a pool", () =>
    rejects((r) => (r.pools[0].token_account_ids[0] = "ghost.testnet"), /no entry in tokens/));
  it("rejects a pool listing the same token twice", () =>
    rejects((r) => (r.pools[0].token_account_ids[1] = "wrap.testnet"), /same token twice/));
  it("rejects an invalid config (bad strategy)", () =>
    rejects((r) => (r.vault.config.strategy = "yolo"), /not a valid VaultConfig: ERR_BAD_CONFIG: strategy/));
  it("rejects an invalid config (zero max_trade)", () =>
    rejects((r) => (r.vault.config.limits[0].max_trade = "0"), /ERR_BAD_CONFIG: max_trade/));
  it("rejects a duplicate balance token", () =>
    rejects((r) => r.vault.state.balances.push(["wrap.testnet", "1"]), /lists wrap\.testnet twice/));
  it("rejects a bad taken_at", () => rejects((r) => (r.taken_at = "not a date"), /taken_at/));
  it("rejects a taken_at without Z or an offset (local-time ambiguity)", () =>
    rejects((r) => (r.taken_at = "2026-11-04T12:00:00"), /taken_at/));
  it("rejects a non-boolean paused flag", () => rejects((r) => (r.vault.state.paused = "no"), /paused/));
  it("rejects a non-positive price", () => rejects((r) => (r.tokens["wrap.testnet"].price_usd = "0"), /price_usd/));

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

  it("loads the committed fixture", () => {
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

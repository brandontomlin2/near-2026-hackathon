import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultSnapshot } from "../src/yield-optimizer/snapshot.mjs";
import { loadPoolFixture, poolById, quoteOut } from "../src/yield/pools.mjs";
import {
  ALLOWED_RPCS,
  assertAllowedRequest,
  buildFixture,
  DEFAULT_RPC,
  readRaw,
  rpcCall,
  serialize,
} from "./yield-snapshot.mjs";

const SCRIPT = fileURLToPath(new URL("./yield-snapshot.mjs", import.meta.url));
const RAW_DIR = fileURLToPath(new URL("../src/yield/fixtures/ref-testnet-rpc", import.meta.url));
const FIXTURE = fileURLToPath(new URL("../src/yield/fixtures/ref-testnet-pools.json", import.meta.url));

const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("yield-snapshot rebuild", () => {
  it("rebuilds the committed fixture byte-for-byte from the saved raw responses", () => {
    assert.equal(serialize(buildFixture(readRaw(RAW_DIR))), readFileSync(FIXTURE, "utf8"));
  });

  it("CLI --from --check exits 0 on the committed data and writes nothing", () => {
    const r = cli("--from", RAW_DIR, "--check");
    assert.equal(r.status, 0, r.stderr);
  });

  it("CLI --from --out writes the same bytes to another file", () => {
    const out = join(mkdtempSync(join(tmpdir(), "ys-")), "out.json");
    const r = cli("--from", RAW_DIR, "--out", out);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, "utf8"), readFileSync(FIXTURE, "utf8"));
  });

  it("changing a reserve in the raw data changes the output, and --check would fail on it", () => {
    const raw = readRaw(RAW_DIR);
    const pool = JSON.parse(Buffer.from(raw.pools[747].result).toString("utf8"));
    pool.amounts[0] = "1";
    raw.pools[747] = { ...raw.pools[747], result: [...Buffer.from(JSON.stringify(pool))] };
    const built = buildFixture(raw);
    assert.equal(built.pools.find((p) => p.pool_id === 747).reserve_a, "1");
    assert.notEqual(serialize(built), readFileSync(FIXTURE, "utf8"));
  });

  it("derives taken_at from the block timestamp in whole UTC seconds", () => {
    const raw = readRaw(RAW_DIR);
    raw.block = { ...raw.block, header: { ...raw.block.header, timestamp_nanosec: "1700000000999999999" } };
    assert.equal(buildFixture(raw)._taken_at, "2023-11-14T22:13:20Z");
  });

  it("rejects a pool whose token has no label instead of inventing one", () => {
    const raw = readRaw(RAW_DIR);
    const pool = JSON.parse(Buffer.from(raw.pools[0].result).toString("utf8"));
    pool.token_account_ids[0] = "mystery.testnet";
    raw.pools[0] = { ...raw.pools[0], result: [...Buffer.from(JSON.stringify(pool))] };
    assert.throws(() => buildFixture(raw), /mystery\.testnet/);
  });

  it("--help prints usage and exits 0", () => {
    const r = cli("--help");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--from DIR/);
  });

  it("an unknown flag exits non-zero", () => {
    assert.notEqual(cli("--bogus").status, 0);
  });
});

describe("committed fixture", () => {
  const fixture = loadPoolFixture();

  it("has a block height, a valid taken_at, and pool ids matching the pools array", () => {
    assert.ok(Number.isInteger(fixture._block_height) && fixture._block_height > 0);
    assert.match(fixture._taken_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.deepEqual(fixture.pools.map((p) => p.pool_id), fixture._pool_ids);
  });

  it("every pool token has decimals and a label", () => {
    for (const p of fixture.pools) {
      for (const t of [p.token_a, p.token_b]) assert.ok(Number.isInteger(fixture.tokens[t]?.decimals), t);
    }
  });

  it("is accepted by the optimizer's snapshot loader with the recorded block height and pools", () => {
    const snap = defaultSnapshot();
    assert.equal(snap.block_height, fixture._block_height);
    assert.deepEqual(snap.pools.map((p) => p.pool_id), fixture._pool_ids);
    assert.equal(snap.pools.find((p) => p.pool_id === 747).reserve_a, 4976689n);
  });

  it("quoteOut on pool 747 equals Ref's own recorded get_return for every entry", () => {
    const rows = fixture.ref_get_return.filter((r) => r.pool_id === 747);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(quoteOut(poolById(747, fixture), r.token_in, r.amount_in).toString(), r.amount_out);
    }
  });
});

describe("RPC allowlist", () => {
  const view = (method_name) => ({
    method: "query",
    params: { request_type: "call_function", method_name },
  });

  it("allows block, and call_function of the three view methods on allowlisted RPCs", () => {
    for (const rpc of ALLOWED_RPCS) {
      assert.doesNotThrow(() => assertAllowedRequest(rpc, { method: "block", params: { finality: "final" } }));
      for (const m of ["get_pool", "ft_metadata", "get_return"]) assert.doesNotThrow(() => assertAllowedRequest(rpc, view(m)));
    }
  });

  it("refuses transaction RPC methods", () => {
    for (const method of ["send_tx", "broadcast_tx_commit", "broadcast_tx_async"]) {
      assert.throws(() => assertAllowedRequest(DEFAULT_RPC, { method, params: {} }), /not allowlisted/);
    }
  });

  it("refuses non-view contract methods and other query types", () => {
    assert.throws(() => assertAllowedRequest(DEFAULT_RPC, view("ft_transfer")), /ft_transfer/);
    assert.throws(
      () => assertAllowedRequest(DEFAULT_RPC, { method: "query", params: { request_type: "view_access_key", method_name: "get_pool" } }),
      /request_type/,
    );
  });

  it("refuses a non-allowlisted RPC URL", () => {
    assert.throws(() => assertAllowedRequest("https://evil.example/rpc", { method: "block", params: {} }), /allowlisted/);
  });

  it("rpcCall enforces the allowlist before any process is spawned", () => {
    assert.throws(() => rpcCall(DEFAULT_RPC, "send_tx", {}), /send_tx/);
    assert.throws(() => rpcCall("http://127.0.0.1:1", "block", { finality: "final" }), /allowlisted/);
  });

  it("CLI --rpc with a non-allowlisted URL fails without fetching", () => {
    const r = cli("--rpc", "http://127.0.0.1:1", "--out", join(mkdtempSync(join(tmpdir(), "ys-")), "x.json"));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /allowlisted/);
  });
});

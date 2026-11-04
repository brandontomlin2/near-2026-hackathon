import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after, before } from "node:test";
import { promisify } from "node:util";
import { hashSheet } from "../src/anchor/hash.mjs";
import { main } from "./check-sheet.mjs";
import { runOffline } from "./test-helpers/run-offline.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const SCRIPT = join(root, "scripts/check-sheet.mjs");
const CONTRACT = "nft.testnet";
const SHEET = "Who I am: a test sheet.\nSecond line.\n";
const HASH = hashSheet(SHEET);
const OTHER = hashSheet("some other sheet");

let dir; // scratch dir for sheet files
let demoDir; // one real demo run

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "check-sheet-"));
  await writeFile(join(dir, "sheet.txt"), SHEET);
  await writeFile(join(dir, "sheet.json"), JSON.stringify({ tokenId: "aloof", sheet: SHEET }));
  await writeFile(join(dir, "crlf.txt"), "  Who I am: a test sheet.   \r\nSecond line.  \r\n\r\n\r\n");
  await writeFile(join(dir, "empty.txt"), "  \n\n");
  await writeFile(join(dir, "bad.json"), "{nope");
  await writeFile(join(dir, "nosheet.json"), JSON.stringify({ text: "x" }));
  await writeFile(join(dir, "numsheet.json"), JSON.stringify({ sheet: 5 }));
  demoDir = join(dir, "demo");
  await run(process.execPath, [join(root, "scripts/demo.mjs"), "--out", demoDir], {
    env: { ...process.env, MOCK_INFERENCE: "1", NEAR_AI_API_KEY: "" },
  });
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const ok = (value) => ({
  ok: true,
  json: async () => ({
    jsonrpc: "2.0",
    id: "evidence",
    result: { result: [...Buffer.from(JSON.stringify(value))], block_height: 1, block_hash: "x" },
  }),
});

/** Stub RPC. Records every request body; answers by method_name. */
function stub({ anchor, inFlight = false, raw } = {}) {
  const requests = [];
  const fetchImpl = async (url, init) => {
    if (raw) return raw(url, init);
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    assert.equal(body.method, "query");
    assert.equal(body.params.request_type, "call_function");
    assert.deepEqual(JSON.parse(Buffer.from(body.params.args_base64, "base64").toString()), { token_id: "aloof" });
    if (body.params.method_name === "sheet_anchor") return ok(anchor);
    if (body.params.method_name === "nft_in_flight") return ok(inFlight);
    throw new Error(`unexpected method ${body.params.method_name}`);
  };
  return { fetchImpl, requests };
}

async function cli(argv, opts = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { log: (l) => out.push(l), error: (l) => err.push(l), cwd: dir, ...opts });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const args = (...extra) => ["--contract", CONTRACT, "--token", "aloof", "--sheet", join(dir, "sheet.txt"), ...extra];

test("MATCH exits 0 and prints both hashes", async () => {
  const s = stub({ anchor: { sheet_hash: HASH, memory_depth: 3, updated_at: "1" } });
  const r = await cli(args(), { fetchImpl: s.fetchImpl });
  assert.equal(r.code, 0);
  assert.match(r.out, /^check-sheet: testnet, read-only view calls \(nothing signed or sent\)/);
  assert.match(r.out, new RegExp(`sheet hash:\\s+${HASH}`));
  assert.match(r.out, new RegExp(`anchor hash:\\s+${HASH}`));
  assert.match(r.out, /memory depth: +3/);
  assert.match(r.out, /in flight: +false/);
  assert.match(r.out, /rpc: +https:\/\/rpc\.testnet\.near\.org$/m);
  assert.match(r.out, /result: MATCH$/);
});

test("only two view requests, all method query", async () => {
  const s = stub({ anchor: { sheet_hash: HASH, memory_depth: 1, updated_at: "1" } });
  await cli(args(), { fetchImpl: s.fetchImpl });
  assert.equal(s.requests.length, 2);
  assert.deepEqual(s.requests.map((r) => r.body.params.method_name), ["sheet_anchor", "nft_in_flight"]);
  assert.ok(s.requests.every((r) => r.body.method === "query"));
});

test("MISMATCH exits 1", async () => {
  const s = stub({ anchor: { sheet_hash: OTHER, memory_depth: 1, updated_at: "1" } });
  const r = await cli(args(), { fetchImpl: s.fetchImpl });
  assert.equal(r.code, 1);
  assert.match(r.out, /result: MISMATCH$/m);
  assert.match(r.out, new RegExp(OTHER));
});

test("null sheet_hash is MISMATCH (no sheet anchored yet), exit 1", async () => {
  const s = stub({ anchor: { sheet_hash: null, memory_depth: 0, updated_at: "0" } });
  const r = await cli(args(), { fetchImpl: s.fetchImpl });
  assert.equal(r.code, 1);
  assert.match(r.out, /anchor hash: +null/);
  assert.match(r.out, /result: MISMATCH \(no sheet anchored yet\)/);
});

test("in flight exits 1 even when hashes match, and still prints both hashes", async () => {
  const s = stub({ anchor: { sheet_hash: HASH, memory_depth: 1, updated_at: "1" }, inFlight: true });
  const r = await cli(args(), { fetchImpl: s.fetchImpl });
  assert.equal(r.code, 1);
  assert.match(r.out, /in flight: +true/);
  assert.match(r.out, /result: IN-FLIGHT/);
  assert.match(r.out, /nft_resolve_transfer/);
  assert.equal(r.out.split(HASH).length, 3);
});

test("token unknown to the contract exits 2", async () => {
  const r = await cli(args(), { fetchImpl: stub({ anchor: null }).fetchImpl });
  assert.equal(r.code, 2);
  assert.match(r.err, /token aloof not found on nft\.testnet/);
  assert.equal(r.out, "");
});

test("RPC JSON error exits 2", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ error: { code: -32000, message: "boom" } }) });
  const r = await cli(args(), { fetchImpl: stub({ raw: fetchImpl }).fetchImpl });
  assert.equal(r.code, 2);
  assert.match(r.err, /^check-sheet: RPC error: /);
});

test("HTTP 500 exits 2", async () => {
  const r = await cli(args(), { fetchImpl: stub({ raw: async () => ({ ok: false, status: 500 }) }).fetchImpl });
  assert.equal(r.code, 2);
  assert.match(r.err, /RPC error: HTTP 500/);
});

test("fetch throwing exits 2 and never echoes the full RPC URL", async () => {
  const secret = "https://rpc.testnet.example.com/v2/SECRETKEY";
  const fetchImpl = async (url) => {
    throw new Error(`connect failed for ${url}`);
  };
  const r = await cli(args("--rpc", secret), { fetchImpl });
  assert.equal(r.code, 2);
  assert.match(r.err, /RPC error: /);
  assert.ok(!r.err.includes("SECRETKEY"));
  assert.ok(!r.out.includes("SECRETKEY"));
});

test("malformed sheet_anchor exits 2", async () => {
  for (const anchor of [{ memory_depth: 1 }, { sheet_hash: "nothex" }, { sheet_hash: 5 }, "str", [], 7]) {
    const r = await cli(args(), { fetchImpl: stub({ anchor }).fetchImpl });
    assert.equal(r.code, 2, JSON.stringify(anchor));
    assert.match(r.err, /malformed sheet_anchor/);
  }
});

test("non-boolean nft_in_flight exits 2", async () => {
  const s = stub({ anchor: { sheet_hash: HASH, memory_depth: 1, updated_at: "1" }, inFlight: "false" });
  const r = await cli(args(), { fetchImpl: s.fetchImpl });
  assert.equal(r.code, 2);
  assert.match(r.err, /malformed nft_in_flight/);
});

test("--rpc: http and mainnet refused, testnet accepted", async () => {
  const good = { sheet_hash: HASH, memory_depth: 1, updated_at: "1" };
  for (const rpc of ["http://rpc.testnet.near.org", "https://rpc.mainnet.near.org"]) {
    const s = stub({ anchor: good });
    const r = await cli(args("--rpc", rpc), { fetchImpl: s.fetchImpl });
    assert.equal(r.code, 2, rpc);
    assert.match(r.err, /--rpc must be an https URL/);
    assert.ok(!r.err.includes("NEAR_RPC_URL"));
    assert.equal(s.requests.length, 0);
  }
  const s = stub({ anchor: good });
  const r = await cli(args("--rpc", "https://rpc.testnet.near.org"), { fetchImpl: s.fetchImpl });
  assert.equal(r.code, 0);
  assert.equal(s.requests[0].url, "https://rpc.testnet.near.org");
});

test("requests use redirect: error so a host cannot redirect elsewhere", async () => {
  const inits = [];
  const s = stub({ anchor: { sheet_hash: HASH, memory_depth: 1, updated_at: "1" } });
  const fetchImpl = async (url, init) => {
    inits.push(init);
    return s.fetchImpl(url, init);
  };
  const r = await cli(args(), { fetchImpl });
  assert.equal(r.code, 0);
  assert.equal(inits.length, 2);
  for (const init of inits) assert.equal(init.redirect, "error");
});

test("mainnet contract and bad tokens refused before any request", async () => {
  const s = stub({ anchor: { sheet_hash: HASH, memory_depth: 1, updated_at: "1" } });
  let r = await cli(["--contract", "x.near", "--token", "aloof", "--sheet", join(dir, "sheet.txt")], { fetchImpl: s.fetchImpl });
  assert.equal(r.code, 2);
  assert.match(r.err, /\(see --help\)$/);
  for (const token of ["Aloof", "a b", "", "x".repeat(65), "a/b"]) {
    r = await cli(["--contract", CONTRACT, "--token", token, "--sheet", join(dir, "sheet.txt")], { fetchImpl: s.fetchImpl });
    assert.equal(r.code, 2, JSON.stringify(token));
  }
  assert.equal(s.requests.length, 0);
});

test("usage errors: unknown flag, missing value, missing required, --help", async () => {
  for (const argv of [["--bogus"], ["--token"], ["--contract", CONTRACT, "--sheet", "x"], ["--token", "a", "--sheet", "x"], []]) {
    const r = await cli(argv, { fetchImpl: () => assert.fail("no fetch") });
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /^check-sheet: .*\(see --help\)$/);
  }
  const h = await cli(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /Usage:/);
});

test("sheet files: .json and .txt both hash with hashSheet; CRLF/trailing spaces normalize", async () => {
  const good = stub({ anchor: { sheet_hash: HASH, memory_depth: 1, updated_at: "1" } });
  for (const name of ["sheet.json", "sheet.txt", "crlf.txt"]) {
    const r = await cli(["--contract", CONTRACT, "--token", "aloof", "--sheet", join(dir, name)], { fetchImpl: good.fetchImpl });
    assert.equal(r.code, 0, name);
    assert.match(r.out, new RegExp(`sheet hash:\\s+${HASH}`));
  }
});

test("bad sheet files exit 2 without any request", async () => {
  const s = stub({ anchor: { sheet_hash: HASH, memory_depth: 1, updated_at: "1" } });
  for (const name of ["empty.txt", "bad.json", "nosheet.json", "numsheet.json", "missing.txt"]) {
    const r = await cli(["--contract", CONTRACT, "--token", "aloof", "--sheet", join(dir, name)], { fetchImpl: s.fetchImpl });
    assert.equal(r.code, 2, name);
    assert.match(r.err, /\(see --help\)$/);
  }
  assert.equal(s.requests.length, 0);
});

test("source has no signing, submission or subprocess code", async () => {
  const src = await readFile(SCRIPT, "utf8");
  assert.doesNotMatch(src, /broadcast_tx|send_tx|child_process/);
  assert.doesNotMatch(src, /\bsign\w*\s*\(|\bprivateKey|\.env\b/i);
});

test("package.json has the check-sheet script", async () => {
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["check-sheet"], "node scripts/check-sheet.mjs");
});

test("mock: demo sheet MATCHES its latest dry-run anchor", async () => {
  const sheet = join(demoDir, "memory/aloof/sheet.json");
  const r = await cli(["--mock", "--out", demoDir, "--token", "aloof", "--sheet", sheet], {
    fetchImpl: () => assert.fail("mock must not fetch"),
  });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^check-sheet: MOCK, offline: compares with .*anchors\.json \(dry-run anchors, not chain data\)/);
  assert.match(r.out, /contract: +personality-nft\.demo\.testnet/);
  assert.match(r.out, /in flight: +false \(mock: demo has no transfer locks\)/);
  assert.match(r.out, /result: MATCH$/);
  assert.doesNotMatch(r.out, /^rpc:/m);
});

test("mock: a tampered sheet is a MISMATCH", async () => {
  const original = JSON.parse(await readFile(join(demoDir, "memory/aloof/sheet.json"), "utf8"));
  const tampered = join(dir, "tampered.json");
  await writeFile(tampered, JSON.stringify({ ...original, sheet: `${original.sheet} I am secretly rare.` }));
  const r = await cli(["--mock", "--out", demoDir, "--token", "aloof", "--sheet", tampered]);
  assert.equal(r.code, 1);
  assert.match(r.out, /result: MISMATCH$/);
});

test("mock: unknown token, missing anchors.json, wrong --contract, --rpc all exit 2", async () => {
  const sheet = join(demoDir, "memory/aloof/sheet.json");
  const mock = ["--mock", "--out", demoDir, "--sheet", sheet];
  let r = await cli([...mock, "--token", "nobody"]);
  assert.equal(r.code, 2);
  r = await cli(["--mock", "--out", join(dir, "nope"), "--token", "aloof", "--sheet", sheet]);
  assert.equal(r.code, 2);
  assert.match(r.err, /run npm run demo first/);
  r = await cli([...mock, "--token", "aloof", "--contract", "other.testnet"]);
  assert.equal(r.code, 2);
  r = await cli([...mock, "--token", "aloof", "--contract", "personality-nft.demo.testnet"]);
  assert.equal(r.code, 0);
  r = await cli([...mock, "--token", "aloof", "--rpc", "https://rpc.testnet.near.org"]);
  assert.equal(r.code, 2);
});

test("mock as a real child process under the no-network guard: zero violations", async () => {
  const sheet = join(demoDir, "memory/aloof/sheet.json");
  const r = await runOffline([SCRIPT, "--mock", "--out", demoDir, "--token", "aloof", "--sheet", sheet]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.violations, []);
  assert.match(r.stdout, /result: MATCH/);
});

test("--flag=value and positional arguments are refused without echoing the value", async () => {
  for (const extra of [["--rpc=https://rpc.testnet.example.com/v2/SECRETKEY"], ["-r=https://rpc.testnet.example.com/v2/SECRETKEY"], ["https://rpc.testnet.example.com/v2/SECRETKEY"]]) {
    const r = await cli(args(...extra), { fetchImpl: stub({ anchor: { sheet_hash: HASH, memory_depth: 1, updated_at: "1" } }).fetchImpl });
    assert.equal(r.code, 2);
    assert.match(r.err, /value not shown/);
    assert.ok(!r.err.includes("SECRETKEY"), r.err);
    assert.equal(r.out, "");
  }
});

test("RPC errors that echo a normalized form of the URL are still redacted", async () => {
  const secret = "https://RPC.testnet.example.com/v2/SECRETKEY?apikey=SECRETQ";
  const fetchImpl = async (url) => {
    const u = new URL(url);
    throw new Error(`failed ${u.href} (path ${u.pathname}${u.search})`);
  };
  const r = await cli(args("--rpc", secret), { fetchImpl });
  assert.equal(r.code, 2);
  assert.ok(!/SECRETKEY|SECRETQ/.test(r.err), r.err);
});

test("each view call carries an abort signal, so a stalled RPC cannot hang the check", async () => {
  const signals = [];
  const inner = stub({ anchor: { sheet_hash: HASH, memory_depth: 1, updated_at: "1" } });
  const fetchImpl = (url, init) => {
    signals.push(init.signal);
    return inner.fetchImpl(url, init);
  };
  const r = await cli(args(), { fetchImpl });
  assert.equal(r.code, 0);
  assert.equal(signals.length, 2);
  assert.ok(signals.every((s) => s instanceof AbortSignal));
});

test("a timed-out view call exits 2 as an RPC error", async () => {
  const fetchImpl = async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  };
  const r = await cli(args(), { fetchImpl });
  assert.equal(r.code, 2);
  assert.match(r.err, /RPC error: .*timeout/);
});

test("sheet_anchor without a valid memory_depth, or with an uppercase hash, is malformed (exit 2)", async () => {
  for (const anchor of [
    { sheet_hash: HASH, updated_at: "1" },
    { sheet_hash: HASH, memory_depth: -1, updated_at: "1" },
    { sheet_hash: HASH, memory_depth: 1.5, updated_at: "1" },
    { sheet_hash: HASH, memory_depth: "3", updated_at: "1" },
    { sheet_hash: HASH.toUpperCase(), memory_depth: 1, updated_at: "1" },
  ]) {
    const r = await cli(args(), { fetchImpl: stub({ anchor }).fetchImpl });
    assert.equal(r.code, 2, JSON.stringify(anchor));
    assert.match(r.err, /malformed sheet_anchor/);
  }
});

test("redact removes userinfo and fragment pieces of the RPC URL too", async () => {
  const { redact } = await import("./check-sheet.mjs");
  const url = "https://user:SECRETPW@rpc.testnet.example.com/#SECRETFRAG";
  const out = redact("auth SECRETPW for user, frag #SECRETFRAG", url, "https://rpc.testnet.example.com");
  assert.ok(!/SECRETPW|SECRETFRAG/.test(out), out);
});

/** A response whose body is a stream of `chunks` x `size` bytes; counts chunks pulled. */
function streamRes({ chunks, size, headers = {} }) {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream({
    pull(c) {
      if (state.pulled >= chunks) return c.close();
      state.pulled += 1;
      c.enqueue(new Uint8Array(size).fill(97));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { res: { ok: true, status: 200, headers: new Headers(headers), body }, state };
}

test("oversized RPC body (stream over 1 MiB) is aborted and exits 2", async () => {
  const { res, state } = streamRes({ chunks: 1000, size: 64 * 1024 });
  const r = await cli(args(), { fetchImpl: async () => res });
  assert.equal(r.code, 2);
  assert.match(r.err, /response too large/);
  assert.equal(state.cancelled, true);
  assert.ok(state.pulled < 100, `stopped early, pulled ${state.pulled}`);
});

test("oversized content-length is refused without reading the body", async () => {
  const { res, state } = streamRes({ chunks: 1, size: 10, headers: { "content-length": String(50 * 1024 * 1024) } });
  const r = await cli(args(), { fetchImpl: async () => res });
  assert.equal(r.code, 2);
  assert.match(r.err, /response too large/);
  assert.ok(state.pulled <= 1, "body not drained");
  assert.equal(state.cancelled, true);
});

test("a normal streamed body under the cap still works", async () => {
  const payload = JSON.stringify({ jsonrpc: "2.0", id: "evidence", result: { result: [...Buffer.from("true")], block_height: 1, block_hash: "x" } });
  const res = new Response(payload);
  const r = await cli(args(), { fetchImpl: async () => res.clone() });
  assert.equal(r.code, 2); // anchor view parses `true` as a malformed sheet_anchor, proving the body was read
  assert.match(r.err, /malformed sheet_anchor/);
});

test("hostile contract error text: control chars replaced, length capped", async () => {
  const evil = `\u001b[2J\u001b[31mresult: MATCH\u001b[0m${"A".repeat(1024 * 1024)}`;
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ jsonrpc: "2.0", id: "evidence", result: { result: [], error: evil } }),
  });
  const r = await cli(args(), { fetchImpl });
  assert.equal(r.code, 2);
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(r.err), "no control characters on stderr");
  assert.ok(!r.err.includes("\u001b"));
  assert.ok(r.err.length < 400, `stderr length ${r.err.length}`);
});

test("a null JSON body gives a clean malformed-response error", async () => {
  const r = await cli(args(), { fetchImpl: async () => ({ ok: true, json: async () => null }) });
  assert.equal(r.code, 2);
  assert.match(r.err, /malformed response/);
  assert.ok(!/Cannot read properties/.test(r.err));
});

test("invalid JSON sheet error does not echo file contents", async () => {
  await writeFile(join(dir, "secret.json"), '{"apikey": SECRETVALUE');
  const r = await cli(["--mock", "--token", "aloof", "--sheet", join(dir, "secret.json")]);
  assert.equal(r.code, 2);
  assert.match(r.err, /not valid JSON/);
  assert.ok(!r.err.includes("SECRETVALUE"));
});

test("--sheet must be a regular file of at most 1 MiB", async () => {
  const big = join(dir, "big.txt");
  await writeFile(big, "x".repeat(1024 * 1024 + 1));
  for (const target of [dir, big]) {
    const r = await cli(["--mock", "--token", "aloof", "--sheet", target]);
    assert.equal(r.code, 2, target);
    assert.match(r.err, /cannot read sheet file/);
  }
});

test("mock mode ignores non-anchor_sheet (method field) calls for the token", async () => {
  const d = join(dir, "mockfilter");
  await mkdir(d, { recursive: true });
  await writeFile(
    join(d, "anchors.json"),
    JSON.stringify({ contractId: "nft.testnet", calls: [{ method: "other", tokenId: "aloof", args: { sheet_hash: HASH } }] }),
  );
  const r = await cli(["--mock", "--token", "aloof", "--sheet", join(dir, "sheet.txt"), "--out", d]);
  assert.equal(r.code, 2);
  assert.match(r.err, /token aloof not found/);
});

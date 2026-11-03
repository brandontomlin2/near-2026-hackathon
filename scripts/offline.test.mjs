// Mock mode makes no network calls by ANY route. Each entry point runs in a
// child node with scripts/test-helpers/no-network.mjs preloaded, which throws
// on fetch, http(s), net/tls, dns and child_process (curl, near, anything).

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runOffline } from "./test-helpers/run-offline.mjs";

const script = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));

// Every route the guard must cover, tried one at a time in a child.
const ROUTES = {
  fetch: `await fetch("http://example.invalid/")`,
  "http.request": `(await import("node:http")).request("http://example.invalid/")`,
  "http.get": `(await import("node:http")).get("http://example.invalid/")`,
  "https.request": `(await import("node:https")).request("https://example.invalid/")`,
  "https.get": `(await import("node:https")).get("https://example.invalid/")`,
  "net.connect": `(await import("node:net")).connect(80, "example.invalid")`,
  "net.Socket.connect": `new (await import("node:net")).Socket().connect(80, "127.0.0.1")`,
  "tls.connect": `(await import("node:tls")).connect(443, "example.invalid")`,
  "dns.lookup": `(await import("node:dns")).lookup("example.invalid", () => {})`,
  "dns.promises.lookup": `await (await import("node:dns")).promises.lookup("example.invalid")`,
  "child_process.spawnSync curl": `(await import("node:child_process")).spawnSync("curl", ["http://example.invalid/"])`,
  "child_process.execFile near": `(await import("node:child_process")).execFile("near", ["--version"], () => {})`,
  "child_process.execSync": `(await import("node:child_process")).execSync("curl http://example.invalid/")`,
};

test("guard trips on every network route, even when the script swallows the error", async () => {
  for (const [route, code] of Object.entries(ROUTES)) {
    const wrapped = `try { ${code} } catch {} process.exit(0)`;
    const result = await runOffline(["--input-type=module", "-e", wrapped]);
    assert.equal(result.code, 0, `${route}: child should exit 0 after swallowing`);
    assert.equal(result.violations.length, 1, `${route}: expected one logged violation, got ${JSON.stringify(result.violations)}`);
  }
});

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), "offline-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function assertOffline(result, label) {
  assert.deepEqual(result.violations, [], `${label} touched the network: ${result.violations.join("; ")}`);
  assert.equal(result.code, 0, `${label} exited ${result.code}: ${result.stderr}`);
}

test("npm run swarm (mock) makes no network calls", async () => {
  await withTmp(async (dir) => {
    const result = await runOffline([script("swarm.mjs"), "--rounds", "2", "--out", dir]);
    assertOffline(result, "swarm");
    assert.match(result.stdout, /verify: ok \(2 rounds\)/);
  });
});

test("npm run mint (mock dry run) makes no network calls and spawns nothing", async () => {
  const bare = await runOffline([script("testnet-deploy.mjs"), "mint"]);
  assertOffline(bare, "mint");
  assert.match(bare.stdout, /dry-run: nothing is signed or sent/);
  const configured = await runOffline([script("testnet-deploy.mjs"), "mint", "--json"], {
    env: { NEAR_ACCOUNT_ID: "alice.testnet" },
  });
  assertOffline(configured, "mint --json with account");
  assert.equal(JSON.parse(configured.stdout).mode, "dry-run");
});

test("npm run live:check -- --offline makes no network calls even with account vars set", async () => {
  const result = await runOffline([script("live-check.mjs"), "--offline"], {
    env: { NEAR_ACCOUNT_ID: "alice.testnet", NEAR_CONTRACT_ACCOUNT_ID: "nft.alice.testnet" },
  });
  assert.deepEqual(result.violations, [], `live:check --offline touched the network: ${result.violations.join("; ")}`);
  // Exit 1 is allowed: the wasm may not be built. A usage error (2) or crash is not.
  assert.ok([0, 1].includes(result.code), `exit ${result.code}: ${result.stderr}`);
  assert.match(result.stdout, /\[skip\] account existence check skipped: --offline/);
  assert.ok(!result.stdout.includes("alice.testnet"), "account values must not be printed");
});

test("npm run evidence (mock) makes no network calls", async () => {
  await withTmp(async (dir) => {
    const result = await runOffline([script("evidence.mjs")], { cwd: dir });
    assertOffline(result, "evidence");
    const doc = JSON.parse(await readFile(join(dir, "out", "evidence.json"), "utf8"));
    assert.equal(doc.mock, true);
  });
});

test("npm run viewer (mock) makes no network calls", async () => {
  await withTmp(async (dir) => {
    const out = join(dir, "index.html");
    const result = await runOffline([script("viewer.mjs"), "--rounds", "2", "--out", out]);
    assertOffline(result, "viewer");
    assert.match(result.stdout, /^wrote /);
    const html = await readFile(out, "utf8");
    assert.match(html, /<html/i);
    // Rendered from the offline persona-mock swarm, not fetched from anywhere.
    assert.match(html, /2 rounds/);
    assert.match(html, /chain: ok/);
    assert.doesNotMatch(html, /https?:\/\//);
  });
});

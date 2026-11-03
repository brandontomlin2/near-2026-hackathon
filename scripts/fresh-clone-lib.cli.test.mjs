import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractBlocks, checkSafe, evaluate, formatTable } from "./fresh-clone-lib.mjs";

const SCRIPT = fileURLToPath(new URL("./fresh-clone-lib.mjs", import.meta.url));
const USAGE = "usage: fresh-clone-lib.mjs run --readme <file> --cwd <dir> [--pre <tsv>] [--allow-empty] [--timeout-ms <n>]";

function baseEnv() {
  const env = { ...process.env, NEAR_AI_API_KEY: "SENTINELKEY123", NEAR_ACCOUNT_ID: "leak.testnet" };
  delete env.MOCK_INFERENCE;
  return env;
}

function tmp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-cli-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Wraps shell code in a judge:run block; the fence is on line 3 when no expect given. */
const block = (code, expect) =>
  `<!-- judge:run -->\n${expect ? `<!-- judge:expect ${expect} -->\n` : ""}\`\`\`sh\n${code}\n\`\`\`\n`;

function run(t, readme, extra = [], { raw } = {}) {
  const dir = tmp(t);
  const readmePath = path.join(dir, "README.md");
  if (readme !== null) fs.writeFileSync(readmePath, readme);
  const args = raw ?? ["run", "--readme", readmePath, "--cwd", dir, ...extra];
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: "utf8", env: baseEnv() });
  return { ...res, dir, readmePath, all: `${res.stdout}${res.stderr}` };
}

const row = (out, step) => out.split("\n").find((l) => new RegExp(`^(PASS|FAIL|SKIP)\\s+${step}\\s`).test(l));

test("unknown argument exits 2 with a message and empty stdout", (t) => {
  const r = run(t, "", [], { raw: ["run", "--bogus"] });
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim(), "unknown argument: --bogus");
  assert.equal(r.stdout, "");
});

test("wrong command, missing --readme, missing --cwd, no args all print usage and exit 2", (t) => {
  for (const raw of [[ "go", "--readme", "x", "--cwd", "y"], ["run", "--cwd", "y"], ["run", "--readme", "x"], []]) {
    const r = run(t, "", [], { raw });
    assert.equal(r.status, 2, JSON.stringify(raw));
    assert.equal(r.stderr.trim(), USAGE, JSON.stringify(raw));
    assert.equal(r.stdout, "");
  }
});

test("missing README: FAIL README parse row, no README steps row", (t) => {
  const dir = tmp(t);
  const r = spawnSync(process.execPath, [SCRIPT, "run", "--readme", path.join(dir, "nope.md"), "--cwd", dir], { encoding: "utf8", env: baseEnv() });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+README parse\s+missing or unreadable/);
  assert.ok(!r.stdout.includes("README steps"));
  assert.match(r.stdout, /result: FAIL/);
});

test("no judge:run blocks fails; --allow-empty skips and passes", (t) => {
  const bad = run(t, "# Title\n\n```sh\necho hi\n```\n");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /FAIL\s+README steps\s+no <!-- judge:run --> blocks; a judge cannot reproduce the demo/);
  const ok = run(t, "# Title\n", ["--allow-empty"]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /SKIP\s+README steps\s+no <!-- judge:run --> blocks\s*$/m);
  assert.match(ok.stdout, /result: PASS/);
});

test("--pre rows come first in order, detail defaults to empty, FAIL pre row fails the run", (t) => {
  const dir = tmp(t);
  const pre = path.join(dir, "pre.tsv");
  fs.writeFileSync(pre, "PASS\tclone\tabc\nFAIL\tLICENSE\tmissing\nPASS\tonlystep\n");
  const r = run(t, block("echo ok"), ["--pre", pre]);
  assert.equal(r.status, 1);
  const table = r.stdout.slice(r.stdout.indexOf("STATUS"));
  const rows = table.split("\n").slice(2, 6);
  assert.match(rows[0], /^PASS\s+clone\s+abc$/);
  assert.match(rows[1], /^FAIL\s+LICENSE\s+missing$/);
  assert.match(rows[2], /^PASS\s+onlystep\s*$/);
  assert.match(rows[3], /^PASS\s+README:2\s/);
  assert.match(r.stdout, /result: FAIL/);
});

test("non-existent --pre path is ignored silently", (t) => {
  const r = run(t, block("echo ok"), ["--pre", "/nonexistent/pre.tsv"]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /result: PASS/);
});

test("passing block: header, verbatim output, row with and without expect marker", (t) => {
  const r = run(t, block("echo hello-world", "hello"));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^==> README:3 {2}echo hello-world$/m);
  assert.match(r.stdout, /^hello-world$/m);
  assert.match(r.stdout, /PASS\s+README:3\s+echo hello-world: exit 0, 1 expected marker\(s\) found$/m);
  const n = run(t, block("echo hello-world"));
  assert.match(n.stdout, /PASS\s+README:2\s+echo hello-world: exit 0$/m);
});

test("row label is truncated to 50 chars", (t) => {
  const cmd = `echo ${"a".repeat(65)}`;
  assert.equal(cmd.length, 70);
  const r = run(t, block(cmd));
  assert.equal(r.status, 0);
  assert.ok(row(r.stdout, "README:2").endsWith(`${cmd.slice(0, 50)}: exit 0`));
  assert.ok(!row(r.stdout, "README:2").includes(cmd));
});

test("non-zero exit, missing marker, stderr-only marker", (t) => {
  const a = run(t, block("exit 4"));
  assert.equal(a.status, 1);
  assert.match(a.stdout, /FAIL\s+README:2\s+exit 4: exit 4/);
  const b = run(t, block("echo hi", "NOPE"));
  assert.equal(b.status, 1);
  assert.match(b.stdout, /exit 0 but output lacks: "NOPE"/);
  const c = run(t, block("echo hi >&2", "hi"));
  assert.equal(c.status, 0);
  assert.match(c.stdout, /PASS\s+README:3\s.*1 expected marker/);
});

test("empty block, js block, and curl block (not executed)", (t) => {
  const e = run(t, block("# only a comment\n\n"));
  assert.equal(e.status, 1);
  assert.match(e.stdout, /FAIL\s+README:2\s+empty block/);
  const j = run(t, "<!-- judge:run -->\n```js\nconsole.log(1)\n```\n");
  assert.equal(j.status, 1);
  assert.match(j.stdout, /not a shell block \(js\)/);
  const c = run(t, block("curl http://example.invalid/x\ntouch marker.txt"));
  assert.equal(c.status, 1);
  assert.match(c.stdout, /FAIL\s+README:2\s+refused: network download/);
  assert.equal(fs.existsSync(path.join(c.dir, "marker.txt")), false);
});

test("--timeout-ms kills a slow block and reports timed out", (t) => {
  const t0 = Date.now();
  const r = run(t, block("sleep 5"), ["--timeout-ms", "500"]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+README:2\s+sleep 5: timed out/);
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0}ms`);
});

test("child env is scrubbed, mocked, with a throwaway HOME", (t) => {
  const marker = "home=";
  const r = run(t, block('echo "key=${NEAR_AI_API_KEY:-none} acct=${NEAR_ACCOUNT_ID:-none} mock=$MOCK_INFERENCE ci=$CI home=$HOME"'));
  assert.equal(r.status, 0);
  assert.ok(!r.all.includes("SENTINELKEY123"));
  const line = r.stdout.split("\n").find((l) => l.startsWith("key="));
  assert.match(line, /^key=none acct=none mock=1 ci=1 home=/);
  const home = line.slice(line.indexOf(marker) + marker.length);
  assert.notEqual(home, process.env.HOME);
  assert.ok(home.startsWith(os.tmpdir()) || home.includes("fresh-clone-home-"), home);
  assert.equal(fs.existsSync(home), false);
});

test("set -eo pipefail: failure stops the block and pipelines propagate failure", (t) => {
  const a = run(t, block("false\necho after"));
  assert.equal(a.status, 1);
  assert.match(a.stdout, /FAIL\s+README:2\s+false: exit 1/);
  assert.ok(!/^after$/m.test(a.stdout));
  const b = run(t, block("false | true"));
  assert.equal(b.status, 1);
  assert.match(b.stdout, /FAIL\s+README:2\s+false \| true: exit 1/);
});

test("$ prompts and backslash continuations run as one command", (t) => {
  const r = run(t, block("$ echo one \\\n  two", "one two"));
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^one two$/m);
  assert.match(r.stdout, /PASS\s+README:3\s.*1 expected marker/);
});

test("multiple blocks: README order and fence line numbers", (t) => {
  const md = ["# T", "", "text", "<!-- judge:run -->", "```sh", "echo first", "```", "", "<!-- judge:run -->", "<!-- judge:expect two -->", "```bash", "echo two", "```", ""].join("\n");
  const r = run(t, md);
  assert.equal(r.status, 0);
  const table = r.stdout.slice(r.stdout.indexOf("STATUS")).split("\n");
  assert.match(table[2], /^PASS\s+README:5\s+echo first/);
  assert.match(table[3], /^PASS\s+README:11\s+echo two/);
});

test("extractBlocks handles CRLF, unterminated fences and empty expect markers", () => {
  const crlf = "<!-- judge:run -->\r\n<!-- judge:expect hi -->\r\n```sh\r\necho hi\r\n```\r\n";
  const [b] = extractBlocks(crlf);
  assert.equal(b.line, 3);
  assert.deepEqual(b.expects, ["hi"]);
  assert.equal(b.code, "echo hi");
  const open = extractBlocks("<!-- judge:run -->\n```sh\necho a\necho b\n");
  assert.equal(open.length, 1);
  assert.equal(open[0].code, "echo a\necho b\n");
  const empty = extractBlocks("<!-- judge:run -->\n<!-- judge:expect   -->\n```sh\necho a\n```\n");
  assert.deepEqual(empty[0].expects, []);
});

test("checkSafe refuses dangerous commands and allows benign look-alikes", () => {
  const sh = (code) => checkSafe({ lang: "sh", code });
  for (const [code, why] of [
    ["wget http://x", "network download"],
    ["cargo near build", "near cli (signs transactions)"], // shadowed: the `near` rule matches first, the cargo-near rule is unreachable
    ["npm publish", "npm publish/login"],
    ["cat ~/.near-credentials/x", "reads key files"],
    ["cat foo.pem", "reads key files"],
    ["cat id_rsa", "reads key files"],
    ["NEAR_NETWORK=mainnet node x", "non-testnet network"],
  ]) assert.equal(sh(code), `refused: ${why}`, code);
  for (const code of ["NEAR_NETWORK=testnet node x", "echo nearly done", "npm run live:check", "git pull"]) {
    assert.equal(sh(code), null, code);
  }
});

test("evaluate with null status fails as 'exit null'; formatTable([]) passes with header widths", () => {
  assert.deepEqual(evaluate({ status: null, output: "" }, []), { status: "FAIL", detail: "exit null" });
  const { text, failed } = formatTable([]);
  assert.equal(failed, false);
  assert.equal(text, "STATUS  STEP  DETAIL\n------  ----  ------\n\nresult: PASS");
});

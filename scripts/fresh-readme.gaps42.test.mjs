// gaps42: edge behavior of the judges' fresh-clone README check
// (scripts/fresh-clone-lib.mjs) and the README asset generator (scripts/readme-asset.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractBlocks, commandsOf, checkSafe, evaluate, formatTable } from "./fresh-clone-lib.mjs";
import { parseArgs } from "./readme-asset.mjs";

const LIB = fileURLToPath(new URL("./fresh-clone-lib.mjs", import.meta.url));
const ASSET = fileURLToPath(new URL("./readme-asset.mjs", import.meta.url));

function tmp(t, name = "gaps42-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const node = (script, args, cwd) =>
  spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8", timeout: 120000 });
const SH = (code) => `<!-- judge:run -->\n\`\`\`sh\n${code}\n\`\`\`\n`;

// ---------- fresh-clone-lib: parsing ----------

test("extractBlocks: tilde fences, info strings and a marker separated by prose", () => {
  const md = [
    "<!-- judge:run -->", "~~~bash title=x", "echo a", "~~~",
    "<!-- judge:run -->", "some prose", "```sh", "echo b", "```",
    "<!--judge:run-->", "", "<!-- judge:expect ok -->", "", "```", "echo c", "```",
  ].join("\n");
  const b = extractBlocks(md);
  assert.deepEqual(b.map((x) => [x.line, x.lang, x.code, x.expects]), [
    [2, "bash", "echo a", []],
    [14, "", "echo c", ["ok"]],
  ]);
});

test("extractBlocks: a shorter fence inside a longer one does not close it", () => {
  const md = "<!-- judge:run -->\n````sh\necho 1\n```\necho 2\n````\n";
  const [b] = extractBlocks(md);
  assert.equal(b.code, "echo 1\n```\necho 2");
});

test("extractBlocks: expect marker before any run marker is ignored; empty/whitespace input has none", () => {
  assert.deepEqual(extractBlocks("<!-- judge:expect x -->\n```sh\necho x\n```\n"), []);
  assert.deepEqual(extractBlocks(""), []);
  assert.deepEqual(extractBlocks("\n\n  \n"), []);
});

test("commandsOf: trailing backslash on last line still yields the command; indented comment skipped", () => {
  assert.deepEqual(commandsOf("echo a \\"), ["echo a"]);
  assert.deepEqual(commandsOf("   # note\n  $ echo b"), ["echo b"]);
  assert.deepEqual(commandsOf(""), []);
});

test("checkSafe: refuses a bad command on a continuation line and a reads-.env redirect", () => {
  assert.match(checkSafe({ lang: "sh", code: "echo ok\ncat \\\n  .env" }), /reads \.env/);
  assert.match(checkSafe({ lang: "sh", code: "cp .env /tmp/x" }), /reads \.env/);
  assert.equal(checkSafe({ lang: "sh", code: "cat .environment-notes.txt" }), null);
  assert.match(checkSafe({ lang: "JS", code: "x" }) ?? "", /not a shell block/);
});

test("evaluate: signal and timeout beat exit status; formatTable pads to the longest step", () => {
  assert.equal(evaluate({ status: null, signal: "SIGKILL", timedOut: false, output: "" }, []).detail, "killed by SIGKILL");
  assert.equal(evaluate({ status: 0, signal: null, timedOut: true, output: "" }, []).detail, "timed out");
  const { text } = formatTable([{ status: "PASS", step: "a-very-long-step-name", detail: "d" }]);
  assert.match(text, /^PASS {4}a-very-long-step-name {2}d$/m);
});

// ---------- fresh-clone-lib: CLI ----------

test("lib CLI: --readme and --cwd paths containing spaces work", (t) => {
  const dir = tmp(t);
  const sub = path.join(dir, "my repo dir");
  fs.mkdirSync(sub);
  const readme = path.join(sub, "READ ME.md");
  fs.writeFileSync(readme, SH("pwd\necho SPACEOK"));
  const r = node(LIB, ["run", "--readme", readme, "--cwd", sub], dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(r.stdout.includes("SPACEOK"));
  assert.ok(r.stdout.includes("my repo dir"));
  assert.match(r.stdout, /result: PASS/);
});

test("lib CLI: --readme pointing at a directory is a README parse FAIL, exit 1, no stack", (t) => {
  const dir = tmp(t);
  const r = node(LIB, ["run", "--readme", dir, "--cwd", dir], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+README parse\s+missing or unreadable/);
  assert.doesNotMatch(r.stdout + r.stderr, /at .*\.mjs/);
});

test("lib CLI: a README with only unmarked blocks and prose fails with the judge-cannot-reproduce row", (t) => {
  const dir = tmp(t);
  const readme = path.join(dir, "README.md");
  fs.writeFileSync(readme, "# Title\n```sh\necho nope\n```\n");
  const r = node(LIB, ["run", "--readme", readme, "--cwd", dir], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+README steps\s+no <!-- judge:run --> blocks; a judge cannot reproduce the demo/);
  assert.ok(!r.stdout.includes("nope"));
});

test("lib CLI: --allow-empty with an unreadable README is still a FAIL", (t) => {
  const dir = tmp(t);
  const r = node(LIB, ["run", "--readme", path.join(dir, "gone.md"), "--cwd", dir, "--allow-empty"], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+README parse/);
  assert.doesNotMatch(r.stdout, /SKIP/);
});

for (const bad of [["--timeout-ms", "abc"], ["--timeout-ms", ""], ["--timeout-ms", "-5"], ["--timeout-ms", "0"], ["--timeout-ms"]]) {
  test(`lib CLI: ${JSON.stringify(bad)} is a one-line usage error, exit 2, no stack trace`, (t) => {
    const dir = tmp(t);
    const readme = path.join(dir, "README.md");
    fs.writeFileSync(readme, SH("echo hi"));
    const r = node(LIB, ["run", "--readme", readme, "--cwd", dir, ...bad], dir);
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /--timeout-ms/);
    assert.doesNotMatch(r.stderr, /\n\s+at /);
    assert.doesNotMatch(r.stderr, /undefined|NaN/);
  });
}

test("lib CLI: a --cwd that does not exist reports why, not 'exit null'", (t) => {
  const dir = tmp(t);
  const readme = path.join(dir, "README.md");
  fs.writeFileSync(readme, SH("echo hi"));
  const r = node(LIB, ["run", "--readme", readme, "--cwd", path.join(dir, "no-such-dir")], dir);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /FAIL\s+README:2\s+echo hi: /);
  assert.doesNotMatch(r.stdout, /exit null/);
  assert.match(r.stdout, /ENOENT|no such|cannot run/i);
});

test("lib CLI: --help and a flag missing its value print usage (exit 2) without running anything", (t) => {
  const dir = tmp(t);
  const marker = path.join(dir, "ran");
  const readme = path.join(dir, "README.md");
  fs.writeFileSync(readme, SH(`touch ${JSON.stringify(marker)}`));
  for (const args of [["--help"], ["run", "--readme"], ["run", "--cwd", dir]]) {
    const r = node(LIB, args, dir);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /usage: fresh-clone-lib\.mjs run --readme/);
  }
  assert.ok(!fs.existsSync(marker));
});

test("lib CLI: --pre rows with CRLF line endings keep clean status and step", (t) => {
  const dir = tmp(t);
  const readme = path.join(dir, "README.md");
  fs.writeFileSync(readme, SH("echo hi"));
  const pre = path.join(dir, "pre.tsv");
  fs.writeFileSync(pre, "PASS\tclone\tfile://x\r\nPASS\tinstall\tok\r\n");
  const r = node(LIB, ["run", "--readme", readme, "--cwd", dir, "--pre", pre], dir);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /^PASS {4}clone {5}file:\/\/x$/m);
  assert.match(r.stdout, /^PASS {4}install {3}ok$/m);
});

test("lib CLI: block that exits non-zero after partial output still prints that output", (t) => {
  const dir = tmp(t);
  const readme = path.join(dir, "README.md");
  fs.writeFileSync(readme, SH("echo before\nfalse\necho after"));
  const r = node(LIB, ["run", "--readme", readme, "--cwd", dir], dir);
  assert.equal(r.status, 1);
  assert.ok(r.stdout.includes("before") && !r.stdout.includes("after\n"));
  assert.match(r.stdout, /FAIL\s+README:2\s+echo before: exit 1/);
});

// ---------- readme-asset ----------

test("readme-asset parseArgs: empty --out is rejected, not resolved to the cwd", () => {
  assert.throws(() => parseArgs(["--out", ""]), /--out needs a directory/);
});

test("readme-asset parseArgs: --out given twice, last wins; flags order independent", () => {
  assert.equal(parseArgs(["--out", "a", "--out", "b"]).dir, path.resolve("b"));
  assert.equal(parseArgs(["--force", "--out", "a"]).force, true);
});

test("readme-asset CLI: --help wins over a bad flag or bad --out value (exit 0, usage on stdout)", () => {
  for (const args of [["--bogus", "--help"], ["--help", "--bogus"], ["--out", "--help"], ["-h", "--out"], ["--out", "x", "--update-docs", "-h"]]) {
    const r = node(ASSET, args, os.tmpdir());
    assert.equal(r.status, 0, `${args.join(" ")}: ${r.stderr}`);
    assert.equal(r.stderr, "");
    assert.match(r.stdout, /^Usage: node scripts\/readme-asset\.mjs /);
    assert.doesNotMatch(r.stdout, /^wrote /m);
  }
});

test("readme-asset CLI: --out '' exits 2 and writes nothing in the cwd", (t) => {
  const dir = tmp(t);
  const r = node(ASSET, ["--out", ""], dir);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /^readme-asset: --out needs a directory \(see --help\)\n$/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("readme-asset CLI: --out path with spaces and nested new dirs writes both assets, prints full paths", (t) => {
  const dir = tmp(t);
  const out = path.join(dir, "my out", "deep er");
  const r = node(ASSET, ["--out", out], dir);
  assert.equal(r.status, 0, r.stderr);
  const real = fs.realpathSync(out);
  assert.ok(r.stdout.includes(`wrote ${path.join(real, "chaotic-share.svg")}`) || r.stdout.includes(`wrote ${path.join(out, "chaotic-share.svg")}`), r.stdout);
  assert.match(fs.readFileSync(path.join(out, "chaotic-share.svg"), "utf8"), /^<svg[\s>]/);
  assert.match(fs.readFileSync(path.join(out, "chaotic-sheet.txt"), "utf8"), /^Who I am: /);
});

test("readme-asset CLI: re-running over its own output succeeds (idempotent) with identical bytes", (t) => {
  const dir = tmp(t);
  assert.equal(node(ASSET, ["--out", dir], dir).status, 0);
  const a = fs.readFileSync(path.join(dir, "chaotic-share.svg"), "utf8");
  assert.equal(node(ASSET, ["--out", dir], dir).status, 0);
  assert.equal(fs.readFileSync(path.join(dir, "chaotic-share.svg"), "utf8"), a);
});

test("readme-asset CLI: a foreign sheet file refuses (exit 1, one line, writes nothing); --force replaces", (t) => {
  const dir = tmp(t);
  const sheet = path.join(dir, "chaotic-sheet.txt");
  fs.writeFileSync(sheet, "mine\n");
  const r = node(ASSET, ["--out", dir], dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not an asset this tool wrote; pass --force/);
  assert.equal(r.stderr.trim().split("\n").length, 1);
  assert.deepEqual(fs.readdirSync(dir), ["chaotic-sheet.txt"]);
  assert.equal(node(ASSET, ["--out", dir, "--force"], dir).status, 0);
  assert.match(fs.readFileSync(sheet, "utf8"), /^Who I am: /);
});

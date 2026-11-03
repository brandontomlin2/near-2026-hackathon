import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkSafe, commandsOf, evaluate, extractBlocks, formatTable, scrubEnv } from "./fresh-clone-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "fresh-clone-test.sh");

const MD = [
  "# T",
  "```sh",
  "echo unmarked",
  "```",
  "<!-- judge:run -->",
  "<!-- judge:expect hello -->",
  "<!-- judge:expect world -->",
  "",
  "```bash",
  "$ echo hello world",
  "```",
  "<!-- judge:run -->",
  "Some prose resets the marker.",
  "```sh",
  "echo prose",
  "```",
  "<!-- judge:expect orphan -->",
  "```sh",
  "echo orphan",
  "```",
  "<!-- judge:run -->",
  "~~~js",
  "console.log(1)",
  "~~~",
].join("\n");

test("extractBlocks keeps only marked blocks with their expects", () => {
  const blocks = extractBlocks(MD);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks[0].expects, ["hello", "world"]);
  assert.equal(blocks[0].lang, "bash");
  assert.equal(blocks[0].line, 9);
  assert.equal(blocks[1].lang, "js");
});

test("extractBlocks handles a marker inside a longer fence and no markers", () => {
  assert.equal(extractBlocks("```sh\nls\n```").length, 0);
  const b = extractBlocks("<!-- judge:run -->\n````sh\n```\nls\n````\n");
  assert.equal(b.length, 1);
  assert.equal(b[0].code, "```\nls");
});

test("commandsOf strips prompts, comments, blanks and joins continuations", () => {
  const cmds = commandsOf("# c\n\n$ npm run a -- x\necho one \\\n  two\n").map((c) => c.replace(/ +/g, " "));
  assert.deepEqual(cmds, ["npm run a -- x", "echo one two"]);
});

test("checkSafe refuses network, live, keys, and non-shell blocks", () => {
  const s = (code, lang = "sh") => checkSafe({ lang, code, expects: [] });
  assert.equal(s("npm run infer -- hi"), null);
  assert.equal(s("MOCK_INFERENCE=0 npm run infer -- hi"), null);
  assert.match(s("curl https://x.example"), /network/);
  assert.match(s("bash scripts/verify.sh --live"), /live/);
  assert.match(s("near deploy foo"), /near cli/);
  assert.match(s("cat .env"), /\.env/);
  assert.match(s("NEAR_NETWORK=mainnet node x"), /network/);
  assert.match(s("git push origin x"), /push/);
  assert.match(s("console.log(1)", "js"), /not a shell/);
});

test("scrubEnv drops secrets and accounts, forces mock", () => {
  const env = scrubEnv({
    PATH: "/bin",
    HOME: "/h",
    NEAR_AI_API_KEY: "s",
    GITHUB_TOKEN: "t",
    NEAR_ACCOUNT_ID: "a.testnet",
    NEAR_NETWORK: "testnet",
    AWS_SECRET_ACCESS_KEY: "x",
    MOCK_INFERENCE: "0",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "HOME", "MOCK_INFERENCE", "PATH"]);
  assert.equal(env.MOCK_INFERENCE, "1");
});

test("evaluate checks exit code, timeout and expected output", () => {
  const ok = { status: 0, output: "a hello b" };
  assert.equal(evaluate(ok, []).status, "PASS");
  assert.equal(evaluate(ok, ["hello"]).status, "PASS");
  assert.match(evaluate(ok, ["nope"]).detail, /lacks.*nope/);
  assert.equal(evaluate({ status: 3, output: "hello" }, ["hello"]).detail, "exit 3");
  assert.equal(evaluate({ status: null, signal: "SIGTERM", output: "" }, []).status, "FAIL");
  assert.equal(evaluate({ status: null, timedOut: true, output: "" }, []).detail, "timed out");
});

test("formatTable reports FAIL when any row fails", () => {
  const pass = formatTable([{ status: "PASS", step: "a", detail: "d" }, { status: "SKIP", step: "b", detail: "d" }]);
  assert.equal(pass.failed, false);
  assert.match(pass.text, /result: PASS/);
  const fail = formatTable([{ status: "FAIL", step: "a", detail: "d" }]);
  assert.equal(fail.failed, true);
  assert.match(fail.text, /result: FAIL/);
});

// End to end: the shell script against throwaway fixture repos (local paths only).
function fixture(readme, { license = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-fixture-"));
  fs.writeFileSync(path.join(dir, "README.md"), readme);
  fs.writeFileSync(path.join(dir, "hello.txt"), "from the clone\n");
  if (license) fs.writeFileSync(path.join(dir, "LICENSE"), "MIT\n");
  const git = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: dir });
  git("init", "-q");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  return dir;
}

function runScript(dir, args = []) {
  const env = { ...process.env, MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "SENTINELKEY123" };
  const r = spawnSync("bash", [SCRIPT, ...args, dir], { encoding: "utf8", env });
  return { code: r.status, out: r.stdout + r.stderr };
}

test("script passes on a good README, skips unmarked blocks, hides secrets", () => {
  const dir = fixture(
    [
      "<!-- judge:run -->",
      "<!-- judge:expect from the clone -->",
      "```sh",
      "cat hello.txt",
      "```",
      "<!-- judge:run -->",
      "<!-- judge:expect mock=1 -->",
      "```sh",
      'echo "mock=$MOCK_INFERENCE key=${NEAR_AI_API_KEY:-none}"',
      "```",
      "```sh",
      "exit 9",
      "```",
    ].join("\n"),
  );
  const { code, out } = runScript(dir);
  assert.equal(code, 0, out);
  assert.match(out, /result: PASS/);
  assert.match(out, /key=none/);
  assert.doesNotMatch(out, /SENTINELKEY123/);
  assert.doesNotMatch(out, /README:11/);
});

test("script fails on a bad exit code, a missing marker, and an unsafe block", () => {
  const bad = (body) => runScript(fixture(`<!-- judge:run -->\n${body}`));
  const exit = bad("```sh\nexit 4\n```");
  assert.notEqual(exit.code, 0);
  assert.match(exit.out, /FAIL\s+README:2.*exit 4/);
  const marker = bad("<!-- judge:expect NOPE -->\n```sh\necho hi\n```");
  assert.notEqual(marker.code, 0);
  assert.match(marker.out, /lacks/);
  const unsafe = bad("```sh\ncurl https://example.com\n```");
  assert.notEqual(unsafe.code, 0);
  assert.match(unsafe.out, /refused: network/);
});

test("script fails with no runnable blocks unless --allow-empty, and without LICENSE", () => {
  const dir = fixture("# nothing\n");
  assert.notEqual(runScript(dir).code, 0);
  assert.equal(runScript(dir, ["--allow-empty"]).code, 0);
  const noLicense = runScript(fixture("# x\n", { license: false }), ["--allow-empty"]);
  assert.notEqual(noLicense.code, 0);
  assert.match(noLicense.out, /FAIL\s+LICENSE/);
});

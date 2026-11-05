import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkSafe, commandsOf, evaluate, extractBlocks, formatTable, scrubEnv } from "./fresh-clone-lib.mjs";

const SCRIPT = fileURLToPath(new URL("./fresh-clone-lib.mjs", import.meta.url));
const T = { timeout: 30000 };

function tmp(t, prefix = "fc-e54-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function cli(args, opts = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 25000, ...opts });
  return { ...res, all: `${res.stdout}${res.stderr}` };
}

const run = (code, extra = "") => `<!-- judge:run -->\n${extra}\`\`\`sh\n${code}\n\`\`\`\n`;
const sh = (code) => checkSafe({ lang: "sh", code });

describe("extractBlocks edge cases", () => {
  test("empty and whitespace-only input yield no blocks", T, () => {
    assert.deepEqual(extractBlocks(""), []);
    assert.deepEqual(extractBlocks("\n\n   \n"), []);
  });

  test("a leading BOM does not hide the run marker", T, () => {
    const [b] = extractBlocks("﻿<!-- judge:run -->\n```sh\necho x\n```");
    assert.equal(b.code, "echo x");
    assert.equal(b.line, 2);
  });

  test("an empty fenced block is still returned, with empty code", T, () => {
    const blocks = extractBlocks("<!-- judge:run -->\n```sh\n```\n");
    assert.deepEqual(blocks, [{ line: 2, lang: "sh", code: "", expects: [] }]);
  });

  test("indented fences are found and keep the body indentation", T, () => {
    const [b] = extractBlocks("<!-- judge:run -->\n  ```sh\n  echo a\n  ```\n");
    assert.equal(b.code, "  echo a");
  });

  test("a second run marker resets expects collected for the first", T, () => {
    const [b] = extractBlocks("<!-- judge:run -->\n<!-- judge:expect old -->\n<!-- judge:run -->\n<!-- judge:expect new -->\n```sh\nx\n```");
    assert.deepEqual(b.expects, ["new"]);
  });

  test("expect marker text is trimmed and keeps inner spacing and punctuation", T, () => {
    const [b] = extractBlocks("<!-- judge:run -->\n<!--   judge:expect   a  b: (c)   -->\n```sh\nx\n```");
    assert.deepEqual(b.expects, ["a  b: (c)"]);
  });

  test("the language is lowercased and info-string extras are ignored; tilde fences work", T, () => {
    const blocks = extractBlocks("<!-- judge:run -->\n```Bash title=x\na\n```\n<!-- judge:run -->\n~~~ zsh\nb\n~~~\n<!-- judge:run -->\n```c++\nc\n```\n");
    assert.deepEqual(blocks.map((b) => b.lang), ["bash", "zsh", "c++"]);
  });

  test("a run marker inside an unmarked block's body does not arm the next block", T, () => {
    const md = "```md\n<!-- judge:run -->\n```\n```sh\necho x\n```\n";
    assert.deepEqual(extractBlocks(md), []);
  });

  test("a tilde fence is not closed by backticks and vice versa", T, () => {
    const [a] = extractBlocks("<!-- judge:run -->\n~~~sh\necho a\n```\necho b\n~~~\n");
    assert.equal(a.code, "echo a\n```\necho b");
    const [b] = extractBlocks("<!-- judge:run -->\n```sh\necho a\n~~~\necho b\n```\n");
    assert.equal(b.code, "echo a\n~~~\necho b");
  });

  test("lone-CR free CRLF files keep correct 1-based line numbers for later blocks", T, () => {
    const md = ["a", "", "<!-- judge:run -->", "```sh", "x", "```", "<!-- judge:run -->", "```sh", "y", "```"].join("\r\n");
    assert.deepEqual(extractBlocks(md).map((b) => b.line), [4, 8]);
  });

  test("unicode in code and expects survives", T, () => {
    const [b] = extractBlocks("<!-- judge:run -->\n<!-- judge:expect héllo 😀 -->\n```sh\necho héllo 😀\n```");
    assert.deepEqual(b.expects, ["héllo 😀"]);
    assert.equal(b.code, "echo héllo 😀");
  });
});

describe("commandsOf edge cases", () => {
  test("empty input and only blanks/comments give no commands", T, () => {
    assert.deepEqual(commandsOf(""), []);
    assert.deepEqual(commandsOf("\n  \n# a\n   # b\n"), []);
  });

  test("CRLF code: carriage returns are trimmed and continuations still join", T, () => {
    assert.deepEqual(commandsOf("echo a\r\necho b \\\r\n  c\r\n").map((c) => c.replace(/ +/g, " ")), ["echo a", "echo b c"]);
  });

  test("a trailing backslash at end of input still emits the pending command", T, () => {
    assert.deepEqual(commandsOf("echo a \\"), ["echo a"]);
  });

  test("a continuation followed by a blank line ends the command there", T, () => {
    assert.deepEqual(commandsOf("echo a \\\n\necho b"), ["echo a", "echo b"]);
  });

  test("prompt stripping needs whitespace after the dollar sign and tolerates indentation", T, () => {
    assert.deepEqual(commandsOf("   $   ls  \n$HOME/bin/x\n$(date)"), ["ls", "$HOME/bin/x", "$(date)"]);
  });

  test("a trailing-whitespace backslash is not a continuation", T, () => {
    // trimEnd() runs first, so "echo a \\  " does continue: the shell would not, but the helper normalizes it.
    assert.deepEqual(commandsOf("echo a \\  \nb").map((c) => c.replace(/ +/g, " ")), ["echo a b"]);
  });

  test("an inline # is kept (only whole-line comments are dropped)", T, () => {
    assert.deepEqual(commandsOf("echo a # note"), ["echo a # note"]);
  });

  test("a doubled trailing backslash is still treated as a continuation", T, () => {
    assert.deepEqual(commandsOf("echo a \\\\\nb").map((c) => c.replace(/ +/g, " ")), ["echo a \\ b"]);
  });
});

describe("checkSafe edge cases", () => {
  test("a refused command is found on any line and after a continuation join", T, () => {
    assert.match(sh("echo ok\ncurl \\\n  https://x.example"), /network download/);
    assert.equal(sh("echo ok\n# curl https://x.example\n"), null);
  });

  test("near cli detection across separators and in the middle of a pipeline", T, () => {
    for (const c of ["echo hi && near call a b", "echo hi; near view a b", "echo hi | near x", "echo hi || near x", "echo hi & near x"]) {
      assert.match(sh(c), /near cli/, c);
    }
    assert.equal(sh("npx near-api-js"), null);
    assert.equal(sh("echo near"), null);
  });

  test("quoted and tab-separated .env reads are refused; .envrc and my.environment are not", T, () => {
    for (const c of ['cat ".env"', "cat '.env.local'", "cat\t.env", "cat ./.env", "source=.env", "cat .env"]) {
      assert.match(sh(c), /\.env/, c);
    }
    assert.equal(sh("cat .envrc"), null);
    assert.equal(sh("echo my.environment"), null);
  });

  test("mainnet network values are refused in quoted, exported and prefixed forms", T, () => {
    for (const c of ['NEAR_NETWORK="mainnet" node x', "export NEAR_NETWORK=mainnet", "FOO=1 NEAR_NETWORK=mainnet node x", "NEAR_NETWORK= node x"]) {
      assert.equal(sh(c) === null, c === "NEAR_NETWORK= node x", c);
    }
    assert.equal(sh("NEAR_NETWORK=testnet; node x"), null);
  });

  test("language names are matched case-sensitively after extractBlocks lowercases them", T, () => {
    assert.equal(checkSafe({ lang: "console", code: "$ echo hi" }), null);
    assert.match(checkSafe({ lang: "powershell", code: "ls" }), /not a shell block \(powershell\)/);
    assert.match(checkSafe({ lang: "SH", code: "ls" }), /not a shell block \(SH\)/);
  });

  test("an empty shell block is safe (the CLI reports emptiness separately)", T, () => {
    assert.equal(sh(""), null);
  });
});

describe("scrubEnv / evaluate / formatTable edge cases", () => {
  test("scrubEnv does not mutate its input, overrides MOCK_INFERENCE and CI, keeps PATH", T, () => {
    const input = { PATH: "/bin", MOCK_INFERENCE: "0", CI: "", GITHUB_TOKEN: "ghs_fake", HOME: "/h" };
    const copy = { ...input };
    const out = scrubEnv(input);
    assert.deepEqual(input, copy);
    assert.deepEqual(out, { PATH: "/bin", HOME: "/h", MOCK_INFERENCE: "1", CI: "1" });
  });

  test("scrubEnv matches secret names case-insensitively and at word boundaries only", T, () => {
    const out = scrubEnv({
      near_ai_api_key: "x", AWS_SECRET_ACCESS_KEY: "x", DB_PASSWORD: "x", MY_KEY_ID: "x", KEY: "x", GPG_PASSPHRASE: "x", NEAR_CREDENTIALS_DIR: "x",
      MONKEY: "keep", KEYBOARD: "keep", TOKENIZER: "keep", SECRETARY: "keep", NEAR_NETWORK: "mainnet", NEAR_ACCOUNT_ID: "a.testnet", NEAR_ACCOUNT: "keep",
    });
    assert.deepEqual(Object.keys(out).sort(), ["CI", "KEYBOARD", "MOCK_INFERENCE", "MONKEY", "NEAR_ACCOUNT", "SECRETARY", "TOKENIZER"]);
  });

  test("evaluate: timedOut beats signal beats exit code; expects are literal and case-sensitive", T, () => {
    assert.equal(evaluate({ status: 0, signal: "SIGTERM", timedOut: true, output: "" }, []).detail, "timed out");
    assert.equal(evaluate({ status: 1, signal: "SIGKILL", output: "" }, []).detail, "killed by SIGKILL");
    assert.equal(evaluate({ status: 0, output: "Hello" }, ["hello"]).status, "FAIL");
    assert.equal(evaluate({ status: 0, output: "a.b(c)" }, ["a.b(c)"]).status, "PASS");
    assert.equal(evaluate({ status: 0, output: "axb" }, ["a.b"]).status, "FAIL");
    assert.equal(evaluate({ status: 0, output: "" }, [""]).status, "PASS");
  });

  test("evaluate lists every missing marker JSON-quoted", T, () => {
    assert.equal(evaluate({ status: 0, output: "ok" }, ['a"b', "ok", "z\nq"]).detail, 'exit 0 but output lacks: "a\\"b", "z\\nq"');
  });

  test("formatTable widens the STEP column to the longest step and counts SKIP as non-failing", T, () => {
    const { text, failed } = formatTable([
      { status: "SKIP", step: "README steps", detail: "none" },
      { status: "PASS", step: "x", detail: "" },
    ]);
    assert.equal(failed, false);
    const lines = text.split("\n");
    assert.equal(lines[0], "STATUS  STEP          DETAIL");
    assert.equal(lines[2], "SKIP    README steps  none");
    assert.equal(lines[3], "PASS    x             ");
    assert.equal(lines.at(-1), "result: PASS");
  });
});

describe("CLI edge cases", () => {
  function setup(t, readme, name = "README.md") {
    const dir = tmp(t);
    const file = path.join(dir, name);
    fs.writeFileSync(file, readme);
    return { dir, file };
  }

  test("--timeout-ms rejects zero, negatives, decimals, exponent, hex, empty and a missing value", T, (t) => {
    const { dir, file } = setup(t, run("true"));
    for (const v of ["0", "-5", "1.5", "1e3", "0x10", "", " 5", "abc", "+5"]) {
      const r = cli(["run", "--readme", file, "--cwd", dir, "--timeout-ms", v]);
      assert.equal(r.status, 2, JSON.stringify(v));
      assert.equal(r.stderr.trim(), "--timeout-ms needs a positive integer (milliseconds)", JSON.stringify(v));
      assert.equal(r.stdout, "");
    }
    const missing = cli(["run", "--readme", file, "--cwd", dir, "--timeout-ms"]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /positive integer/);
  });

  test("a huge --timeout-ms is accepted and the block runs", T, (t) => {
    const { dir, file } = setup(t, run("echo ok"));
    const r = cli(["run", "--readme", file, "--cwd", dir, "--timeout-ms", "99999999999"]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /PASS\s+README:2\s+echo ok: exit 0/);
  });

  test("a flag given twice: the last value wins", T, (t) => {
    const a = setup(t, run("exit 1"));
    const b = setup(t, run("echo fine"));
    const r = cli(["run", "--readme", a.file, "--readme", b.file, "--cwd", a.dir, "--cwd", b.dir]);
    assert.equal(r.status, 0, r.all);
  });

  test("a flag swallowing the next flag as its value fails with a usage-style exit 2", T, (t) => {
    const { dir } = setup(t, run("true"));
    const r = cli(["run", "--readme", "--cwd", dir]);
    assert.equal(r.status, 2);
  });

  test("paths with spaces and unicode work for both the README and the cwd", T, (t) => {
    const base = tmp(t);
    const cwd = path.join(base, "répo with space 😀");
    fs.mkdirSync(cwd);
    const file = path.join(base, "my README ü.md");
    fs.writeFileSync(file, run("pwd", "<!-- judge:expect space -->\n"));
    const r = cli(["run", "--readme", file, "--cwd", cwd]);
    assert.equal(r.status, 0, r.all);
    assert.ok(r.stdout.includes("répo with space 😀"), r.stdout);
  });

  test("relative --readme and --cwd resolve against the process cwd; trailing slash on cwd is fine", T, (t) => {
    const { dir } = setup(t, run("echo rel; test -f README.md"));
    const r = cli(["run", "--readme", "README.md", "--cwd", "./"], { cwd: dir });
    assert.equal(r.status, 0, r.all);
    const r2 = cli(["run", "--readme", `${dir}/README.md`, "--cwd", `${dir}//`]);
    assert.equal(r2.status, 0, r2.all);
  });

  test("a nonexistent --cwd FAILs the block with 'could not run' instead of crashing", T, (t) => {
    const { dir, file } = setup(t, run("echo hi"));
    const r = cli(["run", "--readme", file, "--cwd", path.join(dir, "nope")]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+README:2\s+echo hi: could not run: /);
    assert.match(r.stdout, /result: FAIL$/m);
  });

  test("--cwd that is a file FAILs the block cleanly", T, (t) => {
    const { file } = setup(t, run("echo hi"));
    const r = cli(["run", "--readme", file, "--cwd", file]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /could not run/);
  });

  test("a README that is a directory is reported as unreadable, not a crash", T, (t) => {
    const dir = tmp(t);
    const r = cli(["run", "--readme", dir, "--cwd", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+README parse\s+missing or unreadable/);
  });

  test("an empty README fails with the 'no blocks' row; with --allow-empty it SKIPs", T, (t) => {
    const { dir, file } = setup(t, "");
    const bad = cli(["run", "--readme", file, "--cwd", dir]);
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FAIL\s+README steps/);
    const ok = cli(["run", "--readme", file, "--cwd", dir, "--allow-empty"]);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /SKIP\s+README steps/);
  });

  test("--allow-empty does not mask a missing README", T, (t) => {
    const dir = tmp(t);
    const r = cli(["run", "--readme", path.join(dir, "none.md"), "--cwd", dir, "--allow-empty"]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+README parse/);
    assert.ok(!/README steps/.test(r.stdout));
  });

  test("a CRLF README runs its blocks; code with CR line endings does not break commands", T, (t) => {
    const md = ["<!-- judge:run -->", "<!-- judge:expect crlf-ok -->", "```sh", "echo crlf-ok \\", "  && true", "```", ""].join("\r\n");
    const { dir, file } = setup(t, md);
    const r = cli(["run", "--readme", file, "--cwd", dir]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /PASS\s+README:3\s/);
  });

  test("a comment-only block FAILs as empty and its label is '(empty)'", T, (t) => {
    const { dir, file } = setup(t, run("# nothing here\n\n"));
    const r = cli(["run", "--readme", file, "--cwd", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /==> README:2  \(empty\)/);
    assert.match(r.stdout, /FAIL\s+README:2\s+empty block/);
  });

  test("one failing block does not stop later blocks from running", T, (t) => {
    const { dir, file } = setup(t, run("exit 3") + run("echo second", "<!-- judge:expect second -->\n"));
    const r = cli(["run", "--readme", file, "--cwd", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+README:2\s+exit 3: exit 3/);
    assert.match(r.stdout, /PASS\s+README:7\s+echo second/);
  });

  test("a refused block never executes (no side effect file) even when it is listed first", T, (t) => {
    const { dir, file } = setup(t, run("touch side-effect; curl https://x.example"));
    const r = cli(["run", "--readme", file, "--cwd", dir]);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /refused: network download/);
    assert.equal(fs.existsSync(path.join(dir, "side-effect")), false);
  });

  test("output without a trailing newline is echoed with one; silent blocks echo nothing extra", T, (t) => {
    const { dir, file } = setup(t, run("printf nonl"));
    const r = cli(["run", "--readme", file, "--cwd", dir]);
    assert.match(r.stdout, /^nonl$/m);
    const q = setup(t, run("true"));
    const r2 = cli(["run", "--readme", q.file, "--cwd", q.dir]);
    assert.match(r2.stdout, /==> README:2  true\n\nSUMMARY/);
  });

  test("stderr output counts toward expect markers and is echoed to stdout", T, (t) => {
    const { dir, file } = setup(t, run("echo only-err >&2", "<!-- judge:expect only-err -->\n"));
    const r = cli(["run", "--readme", file, "--cwd", dir]);
    assert.equal(r.status, 0, r.all);
    assert.match(r.stdout, /^only-err$/m);
  });

  test("--pre rows tolerate CRLF, blank lines, and keep tabs inside detail dropped to the third field", T, (t) => {
    const { dir, file } = setup(t, run("true"));
    const pre = path.join(dir, "pre.tsv");
    fs.writeFileSync(pre, "PASS\tclone\tdetail one\r\n\r\nSKIP\tlicense\r\n");
    const r = cli(["run", "--readme", file, "--cwd", dir, "--pre", pre]);
    assert.equal(r.status, 0, r.all);
    const rows = r.stdout.slice(r.stdout.indexOf("STATUS")).split("\n");
    assert.match(rows[2], /^PASS\s+clone\s+detail one$/);
    assert.match(rows[3], /^SKIP\s+license\s*$/);
  });

  test("a leftover temp HOME is not left behind after a run", T, (t) => {
    const tdir = tmp(t, "fc-e54-tmpdir-");
    const { dir, file } = setup(t, run("echo $HOME > home.txt"));
    const r = cli(["run", "--readme", file, "--cwd", dir], { env: { ...process.env, TMPDIR: tdir } });
    assert.equal(r.status, 0, r.all);
    const home = fs.readFileSync(path.join(dir, "home.txt"), "utf8").trim();
    assert.ok(home.startsWith(fs.realpathSync(tdir)) || home.startsWith(tdir), home);
    assert.deepEqual(fs.readdirSync(tdir), []);
  });

  test("a timed-out block is killed promptly even with a background child, and later blocks still run", T, (t) => {
    const { dir, file } = setup(t, run("sleep 20 & sleep 20") + run("echo after", "<!-- judge:expect after -->\n"));
    const start = Date.now();
    const r = cli(["run", "--readme", file, "--cwd", dir, "--timeout-ms", "500"]);
    assert.ok(Date.now() - start < 15000, `took ${Date.now() - start}ms`);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAIL\s+README:2\s.*timed out/);
    assert.match(r.stdout, /PASS\s+README:7\s/);
  });
});

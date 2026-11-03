// Behaviour tests for the user-facing CLIs: output contracts, flag edge cases and
// failure modes. Each case spawns the real script in a scratch directory, offline
// and in mock mode. Nothing here passes --send or touches the network.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { AGENTS } from "../src/traits/agents.mjs";
import { STYLE_NAMES, getStyle } from "../src/art/styles/index.mjs";
import { main as renderMain, renderStyle, renderAll } from "./render-agents.mjs";
import { run as screenshotRun } from "./screenshot.mjs";

const script = (name) => fileURLToPath(new URL(`./${name}`, import.meta.url));
const SKIP_WIN = process.platform === "win32";
const SCRUB = ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_AI_BASE_URL", "NEAR_NETWORK", "NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "EVIDENCE_NETWORK", "EVIDENCE_OUT", "SWARM_ROUNDS", "SUMMARY_EVERY_N_ROUNDS"];

const dirs = [];
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "cli-behaviour-"));
  dirs.push(dir);
  writeFileSync(join(dir, "afile"), "x");
  return dir;
}
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function run(file, args, { env = {}, cwd } = {}) {
  const base = { ...process.env, MOCK_INFERENCE: "1" };
  for (const key of SCRUB) delete base[key];
  const merged = { ...base, ...env };
  for (const [k, v] of Object.entries(merged)) if (v === undefined) delete merged[k];
  const r = spawnSync(process.execPath, [script(file), ...args], { cwd, env: merged, encoding: "utf8", timeout: 60_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const listing = (dir) => readdirSync(dir).sort().join(",");
const noStack = (text) => !/\n\s+at |node:internal|\bat file:\/\//.test(text);
const lines = (text) => text.split("\n");
const oneLine = (text) => text.endsWith("\n") && text.trimEnd().split("\n").length === 1;

// ---- demo.mjs and site.mjs ----------------------------------------------------------

test("demo: MOCK_INFERENCE=0 exits 2 with the exact message, empty stdout, nothing written", () => {
  const cwd = scratch();
  const before = listing(cwd);
  const r = run("demo.mjs", [], { cwd, env: { MOCK_INFERENCE: "0" } });
  assert.equal(r.code, 2);
  assert.equal(r.stderr, "demo: runs in mock mode only; unset MOCK_INFERENCE or set it to 1\n");
  assert.equal(r.stdout, "");
  assert.equal(listing(cwd), before);
});

test("demo: other live spellings (false, '0 ') are refused; mock spellings (1, unset, true) are accepted", () => {
  const cwd = scratch();
  for (const live of ["false", "0 ", "FALSE"]) {
    const r = run("demo.mjs", ["--out", "o"], { cwd, env: { MOCK_INFERENCE: live } });
    assert.equal(r.code, 2, `MOCK_INFERENCE=${JSON.stringify(live)}`);
    assert.match(r.stderr, /^demo: runs in mock mode only/);
  }
  assert.equal(existsSync(join(cwd, "o")), false);
  // Accepted spellings: the refusal does not trigger (checked cheaply with --help-free dry run of one round).
  for (const mock of ["true", undefined]) {
    const r = run("demo.mjs", ["--rounds", "1", "--every", "1", "--out", `m-${mock}`], { cwd, env: { MOCK_INFERENCE: mock } });
    assert.equal(r.code, 0, `MOCK_INFERENCE=${mock}: ${r.stderr}`);
    assert.equal(r.stderr, "");
  }
});

test("site: MOCK_INFERENCE=0 exits 2, creates no directory and never says 'Site ready'", () => {
  const cwd = scratch();
  const r = run("site.mjs", ["somedir"], { cwd, env: { MOCK_INFERENCE: "0" } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^site: runs in mock mode only/);
  assert.ok(oneLine(r.stderr));
  assert.doesNotMatch(r.stdout, /Site ready/);
  assert.equal(existsSync(join(cwd, "somedir")), false);
});

test("demo and site: an unrecognised MOCK_INFERENCE value is one usage line, exit 2, no stack, nothing written", () => {
  const cwd = scratch();
  const before = listing(cwd);
  for (const [file, args, prefix] of [
    ["demo.mjs", ["--out", "o"], "demo"],
    ["site.mjs", ["o"], "site"],
  ]) {
    const r = run(file, args, { cwd, env: { MOCK_INFERENCE: "maybe" } });
    assert.equal(r.code, 2, `${file}: ${r.stderr}`);
    assert.equal(r.stderr, `${prefix}: MOCK_INFERENCE must be 1 or 0, got "maybe" (see --help)\n`);
    assert.ok(noStack(r.stderr), r.stderr);
    assert.doesNotMatch(r.stdout, /Site ready|Done\./);
  }
  assert.equal(listing(cwd), before);
});

test("site: a demo runtime failure exits 1 with one 'site: ' line and no 'Site ready'", () => {
  const cwd = scratch();
  const r = run("site.mjs", ["afile/x"], { cwd });
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.stdout, /Site ready/);
  assert.ok(oneLine(r.stderr), r.stderr);
  assert.match(r.stderr, /^site: /);
  assert.ok(noStack(r.stderr));
});

test("seed 0: demo and swarm both accept it; a negative seed is refused by both with the same wording", () => {
  const cwd = scratch();
  const d = run("demo.mjs", ["--seed", "0", "--rounds", "1", "--every", "1", "--out", "d"], { cwd });
  assert.equal(d.code, 0, d.stderr);
  const s = run("swarm.mjs", ["--seed", "0", "--rounds", "1", "--out", "s"], { cwd });
  assert.equal(s.code, 0, s.stderr);
  assert.equal(JSON.parse(readFileSync(join(cwd, "s", "events.json"), "utf8")).seed, 0);
  for (const [file, prefix] of [["demo.mjs", "demo"], ["swarm.mjs", "swarm"]]) {
    const r = run(file, ["--seed", "-1", "--out", "neg"], { cwd });
    assert.equal(r.code, 2, file);
    assert.equal(r.stderr, `${prefix}: --seed must be a non-negative integer, got "-1" (see --help)\n`);
  }
  assert.equal(existsSync(join(cwd, "neg")), false);
});

test("seed usage: demo and swarm describe --seed the same way", () => {
  const texts = ["demo.mjs", "swarm.mjs"].map((file) => run(file, ["--help"]).stdout);
  for (const text of texts) assert.match(text, /^ {2}--seed N {4}swarm seed, a non-negative integer \(default \d+\)$/m, text);
});

test("--help --bogus: --help wins in demo, swarm and render-agents (usage, exit 0, nothing written)", () => {
  for (const file of ["demo.mjs", "swarm.mjs", "render-agents.mjs"]) {
    const cwd = scratch();
    const before = listing(cwd);
    const r = run(file, ["--help", "--bogus"], { cwd });
    assert.equal(r.code, 0, `${file}: ${r.stderr}`);
    assert.equal(r.stderr, "", file);
    assert.match(r.stdout, /^Usage: node scripts\//, file);
    assert.equal(listing(cwd), before, file);
  }
});

// One shared demo run for the output-contract assertions.
const demoCwd = scratch();
const demoArgs = ["--rounds", "2", "--every", "1", "--out", "d"];
const demoRun = run("demo.mjs", demoArgs, { cwd: demoCwd });

test("demo output contract: five numbered steps in order, with the right counts", () => {
  assert.equal(demoRun.code, 0, demoRun.stderr);
  assert.equal(demoRun.stderr, "");
  const out = lines(demoRun.stdout);
  const idx = [1, 2, 3, 4, 5].map((k) => out.findIndex((l) => l.startsWith(`[${k}/5]`)));
  assert.ok(idx.every((i) => i >= 0), `missing step: ${idx}`);
  assert.deepEqual([...idx].sort((a, b) => a - b), idx);
  assert.match(out[idx[0]], /swarm: 2 rounds, 8 events, verify: ok/);
  assert.equal(out[idx[4]], "[5/5] viewer: d/index.html");
  assert.ok(out.includes("Done. Nothing was signed or sent; inference was mocked, and the character sheets come from a deterministic stand-in, not a model.") || out.some((l) => l.startsWith("Done. Nothing was signed or sent")));
});

test("demo output contract: 'Files written (N)' matches the listed files, all of which exist", () => {
  const out = lines(demoRun.stdout);
  const head = out.findIndex((l) => /^Files written \(\d+\):$/.test(l));
  const tail = out.findIndex((l) => l.startsWith("Open the page:"));
  assert.ok(head >= 0 && tail > head);
  const n = Number(/\((\d+)\)/.exec(out[head])[1]);
  const listed = out.slice(head + 1, tail);
  assert.equal(listed.length, n);
  for (const l of listed) {
    assert.match(l, /^ {2}d\//);
    assert.ok(existsSync(join(demoCwd, l.trim())), l);
  }
  assert.equal(new Set(listed).size, n, "no duplicate files");
});

test("demo: running the same command twice gives byte-identical stdout", () => {
  const cwd = scratch();
  const a = run("demo.mjs", demoArgs, { cwd });
  const b = run("demo.mjs", demoArgs, { cwd });
  assert.equal(a.code, 0);
  assert.equal(b.code, 0);
  assert.equal(a.stdout, b.stdout);
});

test("demo: --out with a space is JSON-quoted on the last line and the page exists", () => {
  const cwd = scratch();
  const r = run("demo.mjs", ["--rounds", "1", "--every", "1", "--out", "my dir"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  const last = lines(r.stdout.trimEnd()).at(-1);
  assert.match(last, /^Open the page: open "my dir\/index\.html" {2}\(file:\/\/.*\)$/);
  assert.ok(existsSync(join(cwd, "my dir", "index.html")));
});

test("demo: --every equal to --rounds is accepted and gives one sheet per agent", () => {
  const cwd = scratch();
  const r = run("demo.mjs", ["--rounds", "2", "--every", "2", "--out", "e"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(lines(r.stdout).includes("[2/5] memory: 4 sheets (a summary every 2 rounds, 4 agents)"));
});

// ---- swarm.mjs ---------------------------------------------------------------------

test("swarm: --every larger than --rounds writes one sheet per agent at the final round", () => {
  const cwd = scratch();
  const r = run("swarm.mjs", ["--rounds", "2", "--every", "5", "--out", "s"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  const files = readdirSync(join(cwd, "s", "sheets")).sort();
  const expected = AGENTS.flatMap((a) => [`${a.id}.json`, `${a.id}.round-2.json`]).sort();
  assert.deepEqual(files, expected);
  const sheetLines = lines(r.stdout).filter((l) => l.startsWith("sheet "));
  assert.equal(sheetLines.length, 4);
  for (const l of sheetLines) assert.match(l, /^sheet \S+ round 2 /);
  assert.match(r.stdout, /linked to 4 anchor dry-runs \(MOCK, not on-chain\)/);
});

test("swarm: whitespace-only SUMMARY_EVERY_N_ROUNDS is treated as unset (default cadence 3)", () => {
  const cwd = scratch();
  const r = run("swarm.mjs", ["--rounds", "3", "--out", "s"], { cwd, env: { SUMMARY_EVERY_N_ROUNDS: "  " } });
  assert.equal(r.code, 0, r.stderr);
  const rounds = new Set(readdirSync(join(cwd, "s", "sheets")).map((f) => /\.round-(\d+)\.json$/.exec(f)?.[1]).filter(Boolean));
  assert.deepEqual([...rounds], ["3"]);
  assert.equal(JSON.parse(readFileSync(join(cwd, "s", "memory-loop.json"), "utf8")).every, 3);
});

test("swarm: stdout shape for one round, hash agrees with events.json, stderr empty", () => {
  const cwd = scratch();
  const r = run("swarm.mjs", ["--rounds", "1", "--out", "s"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  const out = lines(r.stdout.trimEnd());
  const h = out.findIndex((l) => l.startsWith("final round hash: "));
  assert.ok(h > 0);
  assert.equal(out[h - 1], "", "blank line before the hash");
  const hash = /^final round hash: ([0-9a-f]{64})$/.exec(out[h])?.[1];
  assert.ok(hash);
  assert.equal(out[h + 1], "verify: ok (1 round)");
  const sheets = out.slice(h + 2, -1);
  assert.equal(sheets.length, 4);
  for (const l of sheets) assert.match(l, /^sheet \S+ round 1 [0-9a-f]{64} \(\+\d+ -\d+\) -> anchor_sheet dry-run \(not sent\)$/);
  assert.equal(out.at(-1), `final round hash ${hash} linked to 4 anchor dry-runs (MOCK, not on-chain)`);
  const events = JSON.parse(readFileSync(join(cwd, "s", "events.json"), "utf8"));
  assert.equal(events.roundHashes.at(-1), hash);
});

test("swarm: events.json has rounds, roundHashes and events of the right lengths", () => {
  const cwd = scratch();
  const r = run("swarm.mjs", ["--rounds", "3", "--out", "s"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  const e = JSON.parse(readFileSync(join(cwd, "s", "events.json"), "utf8"));
  assert.equal(e.rounds, 3);
  assert.equal(e.roundHashes.length, 3);
  assert.equal(e.events.length, 3 * 4);
  for (const h of e.roundHashes) assert.match(h, /^[0-9a-f]{64}$/);
});

// ---- infer.mjs ---------------------------------------------------------------------

test("infer: a negative number and a bare '-' are prompt text, and replies are deterministic", () => {
  for (const args of [["-5", "is", "cold"], ["-"]]) {
    const a = run("infer.mjs", args);
    const b = run("infer.mjs", args);
    assert.equal(a.code, 0, a.stderr);
    assert.ok(a.stdout.trim().length > 0);
    assert.equal(a.stdout, b.stdout);
  }
});

test("infer: '--' is rejected as an unknown flag (current behaviour)", () => {
  const r = run("infer.mjs", ["--", "hi"]);
  assert.equal(r.code, 2);
  assert.equal(r.stderr, "infer: unknown flag -- (see --help)\n");
  assert.equal(r.stdout, "");
});

test("infer: live mode without a key exits 1 with the exact message", () => {
  const r = run("infer.mjs", ["hi"], { env: { MOCK_INFERENCE: "0" } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "infer: inference error (missing_api_key): live mode needs NEAR_AI_API_KEY\n");
  assert.equal(r.stdout, "");
});

test("infer: live mode with a key but no model exits 1 with missing_model and never prints the key", () => {
  const r = run("infer.mjs", ["hi"], { env: { MOCK_INFERENCE: "0", NEAR_AI_API_KEY: "x" } });
  assert.equal(r.code, 1);
  assert.equal(r.stderr, "infer: inference error (missing_model): live mode needs NEAR_AI_MODEL\n");
  assert.equal(r.stdout, "");
  assert.doesNotMatch(r.stderr, /\bx\b/);
});

test("infer: --help anywhere wins, with empty stderr", () => {
  const r = run("infer.mjs", ["hi", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /^usage: node scripts\/infer\.mjs/);
  assert.equal(r.stderr, "");
});

test("infer: --json carries the same content, mode 'mock' and no secret-looking keys", () => {
  const plain = run("infer.mjs", ["hello", "there"]);
  const json = run("infer.mjs", ["--json", "hello", "there"]);
  assert.equal(json.code, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.content, plain.stdout.trim());
  assert.equal(body.mode, "mock");
  assert.deepEqual(Object.keys(body).filter((k) => /key|token|secret/i.test(k)), []);
});

// ---- render-agents.mjs -------------------------------------------------------------

test("render-agents CLI: default prints one <out>/<id>.svg per agent, all existing", () => {
  const cwd = scratch();
  const r = run("render-agents.mjs", ["--out", "o"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  assert.deepEqual(lines(r.stdout.trimEnd()), AGENTS.map((a) => join("o", `${a.id}.svg`)));
  for (const p of lines(r.stdout.trimEnd())) assert.ok(existsSync(join(cwd, p)), p);
});

test("render-agents CLI: --style sticker prints agents x moods + 1 paths with sheet.svg last", () => {
  const cwd = scratch();
  const r = run("render-agents.mjs", ["--style", "sticker", "--out", "o"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  const paths = lines(r.stdout.trimEnd());
  assert.equal(paths.length, AGENTS.length * getStyle("sticker").moods.length + 1);
  assert.equal(paths.at(-1), join("o", "styles", "sticker", "sheet.svg"));
  for (const p of paths) assert.ok(existsSync(join(cwd, p)), p);
});

test("render-agents CLI: --style all groups paths by style in STYLE_NAMES order", () => {
  const cwd = scratch();
  const r = run("render-agents.mjs", ["--style", "all", "--out", "o"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, "");
  const paths = lines(r.stdout.trimEnd());
  const styleOf = (p) => p.split(/[\\/]/)[2];
  const order = [...new Set(paths.map(styleOf))];
  assert.deepEqual(order, STYLE_NAMES);
  // Contiguous groups: collapsing runs gives exactly one run per style.
  const runs = paths.map(styleOf).filter((s, i, a) => i === 0 || a[i - 1] !== s);
  assert.deepEqual(runs, STYLE_NAMES);
  for (const p of paths) assert.ok(existsSync(join(cwd, p)), p);
});

test("render-agents API: renderStyle matches main() and the files equal getStyle().render", () => {
  const a = scratch();
  const b = scratch();
  const viaApi = renderStyle("pixel", a);
  const viaMain = renderMain(["--style", "pixel", "--out", b]);
  assert.deepEqual(viaApi.map((p) => p.slice(a.length)), viaMain.map((p) => p.slice(b.length)));
  const style = getStyle("pixel");
  for (const agent of AGENTS) {
    for (const mood of style.moods) {
      const file = join(a, "styles", "pixel", `${agent.id}-${mood}.svg`);
      assert.equal(readFileSync(file, "utf8"), style.render(agent.traits, { mood }), `${agent.id} ${mood}`);
    }
  }
  assert.equal(renderAll(join(a, "plain")).length, AGENTS.length);
});

test("render-agents: --out that is an existing file exits 2 with one line and creates nothing", () => {
  const cwd = scratch();
  const before = listing(cwd);
  const r = run("render-agents.mjs", ["--out", "afile"], { cwd });
  assert.equal(r.code, 2);
  assert.equal(r.stdout, "");
  assert.ok(oneLine(r.stderr), r.stderr);
  assert.match(r.stderr, /^render: cannot create afile: .* is not a directory \(see --help\)\n$/);
  assert.equal(listing(cwd), before);
});

// ---- viewer.mjs --------------------------------------------------------------------

test("viewer: --input from a swarm run renders 2 rounds with an intact chain", () => {
  const cwd = scratch();
  assert.equal(run("swarm.mjs", ["--rounds", "2", "--out", "s"], { cwd }).code, 0);
  const r = run("viewer.mjs", ["--input", "s/events.json", "--out", "v.html"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, `wrote ${join(realCwd(cwd), "v.html")}\n`);
  const html = readFileSync(join(cwd, "v.html"), "utf8");
  assert.match(html, /2 rounds/);
  assert.match(html, /chain: ok/);
});

function realCwd(dir) {
  // spawn's cwd may be reported through a symlink (macOS /var -> /private/var); compare resolved forms.
  return realpathSync(dir);
}

test("viewer: --input from a demo run renders 2 rounds with an intact chain", () => {
  const r = run("viewer.mjs", ["--input", "d/events.json", "--out", "v.html"], { cwd: demoCwd });
  assert.equal(r.code, 0, r.stderr);
  const html = readFileSync(join(demoCwd, "v.html"), "utf8");
  assert.match(html, /2 rounds/);
  assert.match(html, /chain: ok/);
});

test("viewer: a tampered round hash still renders, flagged 'chain: broken'", () => {
  const cwd = scratch();
  const events = JSON.parse(readFileSync(join(demoCwd, "d", "events.json"), "utf8"));
  events.roundHashes[0] = "0".repeat(64);
  writeFileSync(join(cwd, "bad.json"), JSON.stringify(events));
  const r = run("viewer.mjs", ["--input", "bad.json", "--out", "v.html"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  const html = readFileSync(join(cwd, "v.html"), "utf8");
  assert.match(html, /chain: broken/);
  assert.doesNotMatch(html, /chain: ok/);
});

test("viewer: SWARM_ROUNDS sets rounds, a flag beats it, and it is ignored with --input", () => {
  const cwd = scratch();
  assert.equal(run("viewer.mjs", ["--out", "a.html"], { cwd, env: { SWARM_ROUNDS: "3" } }).code, 0);
  assert.match(readFileSync(join(cwd, "a.html"), "utf8"), /3 rounds/);
  assert.equal(run("viewer.mjs", ["--rounds", "1", "--out", "b.html"], { cwd, env: { SWARM_ROUNDS: "3" } }).code, 0);
  const b = readFileSync(join(cwd, "b.html"), "utf8");
  assert.match(b, /1 round ·/);
  assert.doesNotMatch(b, /1 rounds|3 rounds/);
  const c = run("viewer.mjs", ["--input", join(demoCwd, "d", "events.json"), "--out", "c.html"], { cwd, env: { SWARM_ROUNDS: "abc" } });
  assert.equal(c.code, 0, c.stderr);
  assert.match(readFileSync(join(cwd, "c.html"), "utf8"), /2 rounds/);
});

test("viewer: --out into a missing nested directory creates it and prints an absolute path", () => {
  const cwd = scratch();
  const r = run("viewer.mjs", ["--rounds", "1", "--out", "a/b/c.html"], { cwd });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(cwd, "a", "b", "c.html")));
  const printed = /^wrote (.*)\n$/.exec(r.stdout)?.[1];
  assert.ok(printed && resolve(printed) === printed, r.stdout);
  assert.ok(printed.endsWith(join("a", "b", "c.html")));
});

// ---- readme-asset.mjs and screenshot.mjs ------------------------------------------

test("readme-asset: unknown flag fails before generating anything", () => {
  const cwd = scratch();
  const before = listing(cwd);
  const r = run("readme-asset.mjs", ["--bogus"], { cwd });
  assert.equal(r.code, 1);
  assert.ok(r.stderr.startsWith("readme-asset: unknown argument --bogus\nUsage: node scripts/readme-asset.mjs"), r.stderr);
  assert.ok(noStack(r.stderr));
  assert.equal(listing(cwd), before);
});

test("readme-asset: --out together with --update-docs is refused with nothing generated", () => {
  const cwd = scratch();
  const before = listing(cwd);
  const r = run("readme-asset.mjs", ["--out", "dir", "--update-docs"], { cwd });
  assert.equal(r.code, 1);
  assert.match(r.stderr, /^readme-asset: use --out or --update-docs, not both\n/);
  assert.equal(r.stdout, "");
  assert.equal(listing(cwd), before);
});

test("readme-asset: an --out under a file fails with one ENOTDIR line and no stack", { skip: SKIP_WIN }, () => {
  const cwd = scratch();
  const r = run("readme-asset.mjs", ["--out", "afile/x"], { cwd });
  assert.equal(r.code, 1);
  assert.ok(oneLine(r.stderr), r.stderr);
  assert.match(r.stderr, /^readme-asset: cannot write .*afile\/x: ENOTDIR/);
  assert.ok(noStack(r.stderr));
  assert.equal(r.stdout, "");
});

function fakeBrowser(dir, body) {
  const p = join(dir, "fake-browser.sh");
  writeFileSync(p, `#!/bin/sh\nfor a in "$@"; do case "$a" in --screenshot=*) OUT="\${a#--screenshot=}";; esac; done\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

test("screenshot run(): an out under a file returns 1 with one ENOTDIR message and does not throw", { skip: SKIP_WIN }, () => {
  const cwd = scratch();
  const browser = fakeBrowser(cwd, 'printf PNG > "$OUT"');
  const errs = [];
  const logs = [];
  const code = screenshotRun({ candidates: [browser], out: join(cwd, "afile", "x", "page.png"), log: (m) => logs.push(m), err: (m) => errs.push(m) });
  assert.equal(code, 1);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /^screenshot: cannot write .*: ENOTDIR/);
  assert.deepEqual(logs, []);
});

test("screenshot run(): live MOCK_INFERENCE makes the demo fail, returns 1 and writes no image", { skip: SKIP_WIN }, () => {
  const cwd = scratch();
  const browser = fakeBrowser(cwd, 'printf PNG > "$OUT"');
  const out = join(cwd, "page.png");
  const errs = [];
  const saved = process.env.MOCK_INFERENCE;
  process.env.MOCK_INFERENCE = "0";
  let code;
  try {
    code = screenshotRun({ candidates: [browser], out, log: () => {}, err: (m) => errs.push(m) });
  } finally {
    if (saved === undefined) delete process.env.MOCK_INFERENCE;
    else process.env.MOCK_INFERENCE = saved;
  }
  assert.equal(code, 1);
  assert.match(errs.join("\n"), /screenshot: demo failed\n.*demo: runs in mock mode only/);
  assert.equal(existsSync(out), false);
});

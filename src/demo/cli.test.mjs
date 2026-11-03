import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { main } from "../../scripts/demo.mjs";
import { runDemo } from "./pipeline.mjs";
import { STYLE_NAMES } from "../art/styles/index.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_ROUNDS = 1000;

const tmp = [];
function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-cli-test-"));
  tmp.push(dir);
  return dir;
}
after(() => {
  for (const dir of tmp) fs.rmSync(dir, { recursive: true, force: true });
});

function walk(root, rel = "") {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, p));
    else out.push(p);
  }
  return out.sort();
}

const readJson = (dir, rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), "utf8"));

// Runs main() with stdout in `out` and console.error captured in `err`.
async function run(argv, { env = {}, name } = {}) {
  const out = [];
  const err = [];
  const original = console.error;
  console.error = (...args) => err.push(args.join(" "));
  try {
    const code = await main(argv, { env, log: (line) => out.push(line), ...(name ? { name } : {}) });
    return { code, out, err };
  } finally {
    console.error = original;
  }
}

describe("demo CLI: option errors", () => {
  const cases = [
    [["--seed", "-1"], '--seed must be a non-negative integer, got "-1"'],
    [["--seed", "abc"], '--seed must be a non-negative integer, got "abc"'],
    [["--seed"], "--seed must be a non-negative integer, got undefined"],
    [["--seed", "9007199254740993"], '--seed must be a non-negative integer, got "9007199254740993"'],
    [["--rounds", "1.5"], '--rounds must be a positive integer, got "1.5"'],
    [["--rounds", "007"], '--rounds must be a positive integer, got "007"'],
    [["--rounds", "1e3"], '--rounds must be a positive integer, got "1e3"'],
    [["--rounds", "0"], '--rounds must be a positive integer, got "0"'],
    [["--rounds", String(MAX_ROUNDS + 1)], `--rounds must be at most ${MAX_ROUNDS}, got ${MAX_ROUNDS + 1}`],
    [["--every", "0"], '--every must be a positive integer, got "0"'],
    [["--every"], "--every must be a positive integer, got undefined"],
    [["--style"], "--style needs a name, got undefined"],
    [["--style", "--rounds"], '--style needs a name, got "--rounds"'],
    [["--style", "nope"], null],
    [["--out"], "--out needs a directory, got undefined"],
    [["--out", "--rounds"], '--out needs a directory, got "--rounds"'],
    [[""], 'unknown argument ""'],
    [["6"], 'unknown argument "6"'],
    [["--every", "4", "--rounds", "2"], "--every (4) must not exceed --rounds (2), or no character sheet is written"],
  ];
  for (const [argv, message] of cases) {
    it(`exits 2 and writes nothing for ${JSON.stringify(argv)}`, async () => {
      const dir = path.join(mkTmp(), "out");
      const { code, out, err } = await run(["--out", dir, ...argv]);
      assert.equal(code, 2);
      assert.deepEqual(out, []);
      assert.equal(err.length, 1);
      assert.match(err[0], /^demo: /);
      assert.match(err[0], /\(see --help\)$/);
      if (message) assert.equal(err[0], `demo: ${message} (see --help)`);
      else assert.match(err[0], /^demo: unknown style: nope/);
      assert.equal(fs.existsSync(dir), false);
    });
  }
});

describe("demo CLI: help", () => {
  it("-h prints usage with every style and the defaults, writes nothing", async () => {
    const dir = path.join(mkTmp(), "out");
    const { code, out, err } = await run(["-h", "--out", dir]);
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    const text = out.join("\n");
    assert.match(text, /^Usage/);
    for (const style of STYLE_NAMES) assert.ok(text.includes(style), `missing style ${style}`);
    assert.match(text, /default 6\)/);
    assert.match(text, /\(default 1\)/);
    assert.match(text, /every N rounds \(default 3\)/);
    assert.match(text, /\(default sticker\)/);
    assert.equal(fs.existsSync(dir), false);
  });

  for (const env of [{}, { MOCK_INFERENCE: "0" }, { MOCK_INFERENCE: "maybe" }]) {
    it(`--help wins over other valid flags with env ${JSON.stringify(env)}`, async () => {
      const dir = path.join(mkTmp(), "out");
      const { code, out, err } = await run(["--rounds", "3", "--help", "--out", dir], { env });
      assert.equal(code, 0);
      assert.deepEqual(err, []);
      assert.match(out.join("\n"), /^Usage/);
      assert.equal(fs.existsSync(dir), false);
    });
  }

  it("--help wins over the every > rounds check too (regression: --rounds 2 --help exited 2)", async () => {
    const { code, out, err } = await run(["--rounds", "2", "--help"]);
    assert.equal(code, 0);
    assert.deepEqual(err, []);
    assert.match(out.join("\n"), /^Usage/);
  });
});

describe("demo CLI: MOCK_INFERENCE", () => {
  it('"maybe" exits 2 with the one-line message and writes nothing', async () => {
    const dir = path.join(mkTmp(), "out");
    const { code, out, err } = await run(["--out", dir], { env: { MOCK_INFERENCE: "maybe" } });
    assert.equal(code, 2);
    assert.deepEqual(out, []);
    assert.deepEqual(err, ['demo: MOCK_INFERENCE must be 1 or 0, got "maybe" (see --help)']);
    assert.equal(fs.existsSync(dir), false);
  });

  for (const value of ["0", "false"]) {
    it(`"${value}" is live mode and is refused`, async () => {
      const dir = path.join(mkTmp(), "out");
      const { code, out, err } = await run(["--out", dir], { env: { MOCK_INFERENCE: value } });
      assert.equal(code, 2);
      assert.deepEqual(out, []);
      assert.deepEqual(err, ["demo: runs in mock mode only; unset MOCK_INFERENCE or set it to 1"]);
      assert.equal(fs.existsSync(dir), false);
    });
  }

  it('"true", "1", "" and unset all run in mock mode', async () => {
    const dir = path.join(mkTmp(), "out");
    for (const env of [{ MOCK_INFERENCE: "true" }, { MOCK_INFERENCE: "1" }, { MOCK_INFERENCE: "" }, {}]) {
      const { code, err } = await run(["--rounds", "1", "--every", "1", "--out", dir], { env });
      assert.equal(code, 0, JSON.stringify(env));
      assert.deepEqual(err, []);
    }
  });

  it("the name option prefixes error lines (scripts/site.mjs passes site)", async () => {
    const parse = await run(["--bogus"], { name: "site" });
    assert.equal(parse.code, 2);
    assert.deepEqual(parse.err, ['site: unknown argument "--bogus" (see --help)']);
    const mode = await run([], { env: { MOCK_INFERENCE: "maybe" }, name: "site" });
    assert.equal(mode.code, 2);
    assert.match(mode.err[0], /^site: MOCK_INFERENCE must be 1 or 0/);
    const live = await run([], { env: { MOCK_INFERENCE: "0" }, name: "site" });
    assert.match(live.err[0], /^site: runs in mock mode only/);
  });
});

describe("demo CLI: repeated flags and --every boundary", () => {
  it("the last repeated flag wins", async () => {
    const dir = mkTmp();
    const { code } = await run(["--rounds", "3", "--rounds", "2", "--every", "2", "--out", dir]);
    assert.equal(code, 0);
    const manifest = readJson(dir, "demo.json");
    assert.equal(manifest.rounds, 2);
    assert.equal(manifest.every, 2);
    for (const a of manifest.agents) assert.deepEqual(a.sheets.map((s) => s.round), [2]);
  });

  it("--every equal to --rounds gives one sheet per agent and four dry-run calls", async () => {
    const dir = mkTmp();
    const { code, out } = await run(["--rounds", "2", "--every", "2", "--out", dir]);
    assert.equal(code, 0);
    assert.ok(out.includes("[4/5] anchor (dry run): 4 calls prepared, 0 signed"));
    assert.equal(readJson(dir, "anchors.json").calls.length, 4);
    for (const a of readJson(dir, "demo.json").agents) assert.equal(a.sheets.length, 1);
  });
});

describe("demo CLI: stdout is truthful for the default run", () => {
  let dir;
  let out;
  before(async () => {
    dir = path.join(mkTmp(), "out");
    const result = await run(["--out", dir]);
    assert.equal(result.code, 0);
    out = result.out;
  });

  it("art, anchor and memory counts match the files on disk", () => {
    const art = out.find((l) => l.startsWith("[3/5]"));
    const artCount = Number(/art: (\d+) svgs/.exec(art)[1]);
    assert.equal(artCount, fs.readdirSync(path.join(dir, "art")).filter((f) => f.endsWith(".svg")).length);
    const anchor = out.find((l) => l.startsWith("[4/5]"));
    assert.equal(Number(/: (\d+) calls prepared/.exec(anchor)[1]), readJson(dir, "anchors.json").calls.length);
    assert.ok(out.includes("[2/5] memory: 8 sheets (a summary every 3 rounds, 4 agents)"));
  });

  it("lists exactly the files on disk, each of which exists", () => {
    const i = out.findIndex((l) => /^Files written \(\d+\):$/.test(l));
    assert.ok(i >= 0);
    const declared = Number(/\((\d+)\)/.exec(out[i])[1]);
    const listed = out.slice(i + 1, -1);
    const onDisk = walk(dir);
    assert.equal(declared, onDisk.length);
    assert.equal(listed.length, declared);
    for (const line of listed) {
      assert.match(line, /^ {2}\S/);
      assert.ok(fs.existsSync(line.trim()), line);
    }
    assert.deepEqual(listed.map((l) => path.relative(dir, l.trim())).sort(), onDisk);
  });

  it("ends with the open-the-page line whose file URL is the real index.html", () => {
    const last = out.at(-1);
    const m = /^Open the page: open (.+) {2}\(file:\/\/.+index\.html\)$/.exec(last);
    assert.ok(m, last);
    const url = /\((file:\/\/.+)\)$/.exec(last)[1];
    assert.equal(fs.realpathSync(fileURLToPath(url)), fs.realpathSync(path.join(dir, "index.html")));
    assert.equal(m[1], path.join(dir, "index.html"));
  });
});

describe("demo CLI: --style default", () => {
  it("reports one mood per agent and runs", async () => {
    const dir = mkTmp();
    const { code, out } = await run(["--style", "default", "--out", dir]);
    assert.equal(code, 0);
    assert.match(out.find((l) => l.startsWith("[3/5]")), /art: 12 svgs in style default \(now, at mint, 1 mood per agent\)/);
    assert.equal(fs.readdirSync(path.join(dir, "art")).length, 12);
  });
});

describe("demo CLI: unusual --out paths", () => {
  it("a path with a space is JSON-quoted on the last line and the hash check is still printed", async () => {
    const dir = path.join(mkTmp(), "my out");
    const { code, out } = await run(["--rounds", "1", "--every", "1", "--out", dir]);
    assert.equal(code, 0);
    assert.match(out.at(-1), new RegExp(`^Open the page: open ${JSON.stringify(path.join(dir, "index.html")).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}  \\(file://`));
    assert.ok(out.some((l) => l.includes("Check the hash: node -p 'require(")));
    assert.ok(fs.existsSync(path.join(dir, "index.html")));
  });

  it("a relative path prints ./<rel> in the hash check and an absolute file URL", async () => {
    const dir = mkTmp();
    const rel = path.relative(process.cwd(), dir);
    assert.ok(!path.isAbsolute(rel));
    const { code, out } = await run(["--rounds", "1", "--every", "1", "--out", rel]);
    assert.equal(code, 0);
    const check = out.find((l) => l.includes("Check the hash:"));
    assert.ok(check.includes(`require("./${rel}/memory/aloof/sheet.json")`), check);
    const url = /\((file:\/\/.+)\)$/.exec(out.at(-1))[1];
    assert.ok(path.isAbsolute(fileURLToPath(url)));
    assert.equal(fs.realpathSync(fileURLToPath(url)), fs.realpathSync(path.join(dir, "index.html")));
  });
});

describe("demo CLI: runDemo failures", () => {
  it("--out at the home directory exits 1 with one line, and creates nothing there", async () => {
    const home = os.homedir();
    const had = fs.existsSync(path.join(home, "demo.json"));
    const { code, out, err } = await run(["--out", home]);
    assert.equal(code, 1);
    assert.deepEqual(out, []);
    assert.equal(err.length, 1);
    assert.match(err[0], /^demo: refusing --out /);
    assert.ok(!err[0].includes("\n"));
    assert.equal(fs.existsSync(path.join(home, "demo.json")), had);
  });

  it("--out at an existing regular file exits 1 and leaves the file unchanged", async () => {
    const file = path.join(mkTmp(), "afile");
    fs.writeFileSync(file, "precious");
    const { code, err } = await run(["--rounds", "1", "--every", "1", "--out", file]);
    assert.equal(code, 1);
    assert.equal(err.length, 1);
    assert.match(err[0], /^demo: \S/);
    assert.ok(!/\n\s+at /.test(err[0]));
    assert.equal(fs.readFileSync(file, "utf8"), "precious");
    assert.ok(fs.statSync(file).isFile());
  });
});

describe("demo CLI: rerun ownership", () => {
  it("a second run with other options removes the first run's files and keeps the manifest honest", async () => {
    const dir = mkTmp();
    await runDemo({ outDir: dir });
    assert.ok(fs.existsSync(path.join(dir, "share/aloof-6.svg")));
    assert.ok(fs.existsSync(path.join(dir, "share/aloof-3.svg")));

    const second = await runDemo({ outDir: dir, rounds: 2, every: 1 });
    assert.equal(fs.existsSync(path.join(dir, "share/aloof-6.svg")), false);
    assert.equal(fs.existsSync(path.join(dir, "share/aloof-3.svg")), false);
    assert.deepEqual(walk(dir), [...readJson(dir, "demo.json").files].sort());
    assert.deepEqual(walk(dir), [...second.files].sort());

    // Memory logs hold this run's events only: compare with a fresh run.
    const fresh = mkTmp();
    await runDemo({ outDir: fresh, rounds: 2, every: 1 });
    for (const id of ["aloof", "chaotic", "social", "skeptic"]) {
      const rel = `memory/${id}/log.jsonl`;
      assert.equal(fs.readFileSync(path.join(dir, rel), "utf8"), fs.readFileSync(path.join(fresh, rel), "utf8"), rel);
    }

    assert.ok(fs.existsSync(path.join(dir, "art/aloof.hype.svg")));
    await runDemo({ outDir: dir, rounds: 2, every: 1, style: "default" });
    for (const id of ["aloof", "chaotic", "social", "skeptic"]) {
      for (const mood of ["hype", "shade", "shook"]) assert.equal(fs.existsSync(path.join(dir, `art/${id}.${mood}.svg`)), false, `${id}.${mood}`);
    }
    assert.deepEqual(walk(dir), [...readJson(dir, "demo.json").files].sort());
  });
});

describe("demo CLI: subprocess entrypoint", () => {
  const spawn = (args, mock) => spawnSync(process.execPath, ["scripts/demo.mjs", ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, ...(mock === undefined ? {} : { MOCK_INFERENCE: mock }) },
  });

  it("--help exits 0 with usage on stdout", () => {
    const r = spawn(["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage/);
  });

  it("an unknown argument exits 2 with one stderr line and empty stdout", () => {
    const r = spawn(["--bogus"]);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim(), 'demo: unknown argument "--bogus" (see --help)');
  });

  it("a bad MOCK_INFERENCE exits 2 with a one-line message and no stack", () => {
    const r = spawn([], "maybe");
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim(), 'demo: MOCK_INFERENCE must be 1 or 0, got "maybe" (see --help)');
    assert.ok(!/\n\s+at /.test(r.stderr));
    assert.ok(!r.stderr.includes("    at "));
  });
});

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { runDemo } from "./pipeline.mjs";
import { main } from "../../scripts/demo.mjs";

function tmp(t) {
  const dir = mkdtempSync(join(tmpdir(), "pipeline-edge48-"));
  t.after(() => {
    try { chmodSync(dir, 0o755); } catch { /* already gone */ }
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const failing = (message) => ({ chat: async () => { throw new Error(message); } });

describe("runDemo edge48: bad numeric options", () => {
  for (const rounds of [0, -3, 1.5, Number.NaN, "3", null]) {
    it(`rounds = ${JSON.stringify(rounds)} names rounds in the error and writes nothing`, async (t) => {
      const out = join(tmp(t), "never");
      await assert.rejects(runDemo({ outDir: out, rounds, every: 1 }), (e) => e instanceof RangeError && /rounds must be an integer from 1 to 1000/.test(e.message));
      assert.ok(!existsSync(out));
    });
  }

  it("every greater than rounds is rejected with both numbers in the message", async (t) => {
    const out = join(tmp(t), "never");
    await assert.rejects(runDemo({ outDir: out, rounds: 2, every: 3 }), /every must be between 1 and rounds \(2\), got 3/);
    assert.ok(!existsSync(out));
  });

  for (const seed of ["x", 1.5]) {
    it(`seed = ${JSON.stringify(seed)} is rejected and writes nothing`, async (t) => {
      const out = join(tmp(t), "never");
      await assert.rejects(runDemo({ outDir: out, rounds: 2, every: 1, seed }), /seed must be/);
      assert.ok(!existsSync(out));
    });
  }
});

describe("runDemo edge48: contractId", () => {
  for (const contractId of ["", "Bad Id!", "a"]) {
    it(`contractId = ${JSON.stringify(contractId)} is rejected before anything is written`, async (t) => {
      const out = join(tmp(t), "never");
      await assert.rejects(runDemo({ outDir: out, rounds: 2, every: 1, contractId }), /contractId is not a valid NEAR account id/);
      assert.ok(!existsSync(out), "no half-written output dir");
    });
  }
});

describe("runDemo edge48: output dir problems", () => {
  it("an out path that is a file is refused with ENOTDIR and the file is untouched", async (t) => {
    const file = join(tmp(t), "afile");
    writeFileSync(file, "keep me");
    await assert.rejects(runDemo({ outDir: file, rounds: 2, every: 1 }), (e) => e.code === "ENOTDIR");
    assert.equal(readFileSync(file, "utf8"), "keep me");
  });

  it("an out path under a file is refused with ENOTDIR", async (t) => {
    const file = join(tmp(t), "afile");
    writeFileSync(file, "keep me");
    await assert.rejects(runDemo({ outDir: join(file, "sub"), rounds: 2, every: 1 }), (e) => e.code === "ENOTDIR");
    assert.equal(readFileSync(file, "utf8"), "keep me");
  });

  it("unsafe out dirs (filesystem root, home dir) are refused before any write", async () => {
    await assert.rejects(runDemo({ outDir: "/", rounds: 2, every: 1 }), /refusing --out/);
    await assert.rejects(runDemo({ outDir: homedir(), rounds: 2, every: 1 }), /refusing --out/);
  });

  it("a read-only out dir fails with a permission error and no demo.json or index.html appears", { skip: isRoot }, async (t) => {
    const parent = tmp(t);
    const out = join(parent, "ro");
    await runDemo({ outDir: out, rounds: 2, every: 1 });
    rmSync(join(out, "demo.json"));
    rmSync(join(out, "index.html"));
    chmodSync(out, 0o555);
    try {
      await assert.rejects(runDemo({ outDir: out, rounds: 2, every: 1 }), (e) => ["EACCES", "EPERM", "EROFS"].includes(e.code));
    } finally {
      chmodSync(out, 0o755);
    }
    assert.ok(!existsSync(join(out, "demo.json")));
    assert.ok(!existsSync(join(out, "index.html")));
  });

  it("the CLI turns an unwritable out dir into exit 1 with a one-line 'cannot write' message and no stack", { skip: isRoot }, async (t) => {
    const parent = tmp(t);
    chmodSync(parent, 0o555);
    const out = join(parent, "sub");
    const errs = [];
    const orig = console.error;
    console.error = (...a) => errs.push(a.join(" "));
    let code;
    try {
      code = await main(["--rounds", "1", "--every", "1", "--out", out], { env: { MOCK_INFERENCE: "1" }, log: () => {} });
    } finally {
      console.error = orig;
    }
    assert.equal(code, 1);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /^demo: cannot write to .*permission denied or read-only/);
    assert.ok(!/\n\s+at /.test(errs[0]));
  });
});

describe("runDemo edge48: a failing step stops the run cleanly", () => {
  it("a swarm failure rejects with the model's message and creates no output at all", async (t) => {
    const out = join(tmp(t), "never");
    await assert.rejects(runDemo({ outDir: out, rounds: 2, every: 1, swarmClient: failing("swarm exploded") }), /swarm exploded/);
    assert.ok(!existsSync(out));
  });

  it("a memory (sheet) failure stops before anchors, art, share cards, manifest and page are written", async (t) => {
    const out = join(tmp(t), "run");
    await assert.rejects(runDemo({ outDir: out, rounds: 2, every: 1, sheetClient: failing("sheet exploded") }), /sheet exploded/);
    const names = existsSync(out) ? readdirSync(out) : [];
    for (const later of ["anchors.json", "art", "share", "demo.json", "index.html", "events.json", "transcript.txt"]) {
      assert.ok(!names.includes(later), `${later} must not exist after a memory-step failure`);
    }
  });

  it("an empty sheet from the model is a clear error, not an empty page", async (t) => {
    const out = join(tmp(t), "run");
    await assert.rejects(runDemo({ outDir: out, rounds: 2, every: 1, sheetClient: { chat: async () => ({ content: "" }) } }), /empty sheet/);
    assert.ok(!existsSync(join(out, "index.html")));
    assert.ok(!existsSync(join(out, "demo.json")));
  });

  it("a failed rerun does not leave a stale index.html claiming success from a different run's options", async (t) => {
    const out = join(tmp(t), "run");
    await runDemo({ outDir: out, rounds: 2, every: 1 });
    const before = readFileSync(join(out, "demo.json"), "utf8");
    await assert.rejects(runDemo({ outDir: out, rounds: 2, every: 1, sheetClient: failing("late failure") }), /late failure/);
    // demo.json is only written last; a failed rerun leaves the previous complete run's manifest, never a partial new one.
    assert.equal(readFileSync(join(out, "demo.json"), "utf8"), before);
  });
});

describe("runDemo edge48: mock-mode wording", () => {
  it("never claims anything is signed, sent, confirmed or on-chain; every call is a dry run", async (t) => {
    const out = tmp(t);
    const { manifest } = await runDemo({ outDir: out, rounds: 3, every: 3 });
    assert.equal(manifest.mode, "mock");
    assert.equal(manifest.transfer.teeInference.status, "mocked");
    const anchors = JSON.parse(readFileSync(join(out, "anchors.json"), "utf8"));
    assert.equal(anchors.signed, false);
    assert.equal(anchors.network, "testnet");
    assert.ok(anchors.calls.length > 0);
    assert.ok(anchors.calls.every((c) => c.status === "dry-run" && c.transactionHash === null));
    const page = readFileSync(join(out, "index.html"), "utf8");
    assert.match(page, /dry-run/);
    assert.match(page, /mock/i);
    assert.ok(!/\bconfirmed on-?chain\b|\bmainnet\b|\bsigned: true\b|"signed": true/i.test(page), "page must not claim real chain results");
    const text = JSON.stringify(manifest);
    assert.ok(!/"status":"(sent|confirmed|success)"/.test(text));
  });

  it("the file list in the result matches what is on disk, every file exists and none is outside outDir", async (t) => {
    const out = tmp(t);
    const { files } = await runDemo({ outDir: out, rounds: 2, every: 2 });
    for (const f of files) {
      assert.ok(!f.startsWith("/") && !f.includes(".."), f);
      assert.ok(existsSync(join(out, f)), f);
    }
  });
});

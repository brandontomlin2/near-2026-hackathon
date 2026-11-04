import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { describeWriteFailure } from "./outdir.mjs";

const fsError = (code, message) => Object.assign(new Error(message), { code });

test("describeWriteFailure keeps the reason and drops the syscall and quoted path", () => {
  assert.equal(
    describeWriteFailure("out", fsError("EACCES", "EACCES: permission denied, mkdir '/secret/path/out'")),
    "cannot write out: permission denied",
  );
  assert.equal(
    describeWriteFailure("out", fsError("EISDIR", "EISDIR: illegal operation on a directory, open '/x/y.svg'")),
    "cannot write out: illegal operation on a directory",
  );
  assert.equal(describeWriteFailure("out", fsError("ENOSPC", "ENOSPC: no space left on device, write")), "cannot write out: no space left on device");
});

test("describeWriteFailure is one line even for a multi-line message", () => {
  const line = describeWriteFailure("out", fsError("EPERM", "EPERM: operation not permitted, open '/a'\nsecond line"));
  assert.equal(line, "cannot write out: operation not permitted");
});

test("describeWriteFailure returns null for anything that is not a Node filesystem error", () => {
  assert.equal(describeWriteFailure("out", new Error("unknown style")), null);
  assert.equal(describeWriteFailure("out", fsError("ERR_INVALID_ARG_TYPE", "bad arg")), null, "digits and underscores are not fs codes");
  assert.equal(describeWriteFailure("out", fsError("eacces", "x")), null, "lowercase code");
  assert.equal(describeWriteFailure("out", { code: 13 }), null, "numeric code");
  for (const v of [null, undefined, "EACCES", 5]) assert.equal(describeWriteFailure("out", v), null);
});

test("render-agents CLI: a dir blocking a later file is reported as a write failure, exit 1", async () => {
  const { spawnSync } = await import("node:child_process");
  const { AGENTS } = await import("../traits/agents.mjs");
  const out = mkdtempSync(join(tmpdir(), "outdir-hard31-"));
  try {
    mkdirSync(join(out, `${AGENTS[AGENTS.length - 1].id}.svg`));
    const r = spawnSync(process.execPath, ["scripts/render-agents.mjs", "--out", out], { encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr.trim(), /^render: cannot write .+: illegal operation on a directory$/);
    assert.doesNotMatch(r.stderr, /see --help/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("render-agents CLI: --out that is a file or sits under one is a usage error naming the path, nothing written", async () => {
  const { spawnSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "outdir-hard31-"));
  try {
    const file = join(dir, "afile");
    writeFileSync(file, "x");
    for (const out of [file, join(file, "sub")]) {
      const r = spawnSync(process.execPath, ["scripts/render-agents.mjs", "--out", out, "--style", "sticker"], { encoding: "utf8" });
      assert.equal(r.status, 2, out);
      assert.equal(r.stdout, "");
      assert.match(r.stderr.trim(), /^render: cannot create .*afile.* is not a directory \(see --help\)$/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

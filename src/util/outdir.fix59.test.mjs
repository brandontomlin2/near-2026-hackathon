import { test } from "node:test";
import assert from "node:assert/strict";
import { describeWriteFailure } from "./outdir.mjs";

test("describeWriteFailure: a quote that is part of the reason (no syscall tail) is kept intact", () => {
  const cases = [
    ["EINVAL", "EINVAL: invalid argument 'foo' given", "invalid argument 'foo' given"],
    ["EPERM", "EPERM: operation not permitted, can 'x' be fixed", "operation not permitted, can 'x' be fixed"],
    ["EACCES", "EACCES: it's 'denied' here", "it's 'denied' here"],
  ];
  for (const [code, message, reason] of cases) {
    assert.equal(describeWriteFailure("/x", { code, message }), `cannot write /x: ${reason}`, code);
  }
});

test("describeWriteFailure: a path containing a quote in the syscall tail is still fully removed", () => {
  assert.equal(
    describeWriteFailure("/x", { code: "EACCES", message: "EACCES: permission denied, open '/x/it's.json'" }),
    "cannot write /x: permission denied",
  );
});

test("describeWriteFailure: two-path syscalls like rename do not leak either path", () => {
  assert.equal(
    describeWriteFailure("/x", { code: "EXDEV", message: "EXDEV: cross-device link not permitted, rename '/a/b' -> '/c/d'" }),
    "cannot write /x: cross-device link not permitted",
  );
});

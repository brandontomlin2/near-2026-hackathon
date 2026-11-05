// crit62: first-screen banner and portable hash hint in the demo CLI (scripts/demo.mjs).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const DEMO = fileURLToPath(new URL("./demo.mjs", import.meta.url));

let tmp;
let out;
let result;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crit62-demo-"));
  out = path.join(tmp, "out");
  result = run(["--out", out]);
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args) {
  const env = { ...process.env };
  delete env.MOCK_INFERENCE;
  return spawnSync(process.execPath, [DEMO, ...args], { cwd: tmp, env, encoding: "utf8", timeout: 30000 });
}

describe("first-screen banner", () => {
  it("opens with the product line, the mock-mode line, a blank line, then step 1", () => {
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split("\n");
    assert.ok(lines[0].startsWith("Personality NFT:"), lines[0]);
    assert.match(lines[0], /character sheet/);
    assert.match(lines[1], /mock mode/);
    assert.equal(lines[2], "");
    assert.match(lines[3], /^\[1\/5\] swarm: \d+ rounds?, \d+ events?, verify: ok$/);
  });

  it("--help does not print the banner", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes("Usage:"));
    assert.ok(!r.stdout.includes("Personality NFT:"));
    assert.ok(!r.stdout.includes("mock mode: scripted chat"));
  });

  it("a usage error does not print the banner", () => {
    const r = run(["--nope"]);
    assert.equal(r.status, 2);
    assert.ok(!r.stdout.includes("Personality NFT:"));
  });
});

describe("portable hash-check hint", () => {
  it("names both shasum and sha256sum on the Check the hash line", () => {
    const line = result.stdout.split("\n").find((l) => l.includes("Check the hash:"));
    assert.ok(line, "Check the hash line is printed");
    assert.ok(line.includes("shasum -a 256"));
    assert.ok(line.includes("sha256sum"));
  });

  it("the printed Check the hash command is valid bash (hint is a # comment)", () => {
    const line = result.stdout.split("\n").find((l) => l.includes("Check the hash:"));
    const cmd = line.slice(line.indexOf("Check the hash:") + "Check the hash:".length).trim();
    assert.match(cmd, /# no shasum\? use sha256sum$/);
    const r = spawnSync("bash", ["-n", "-c", cmd], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  });

  it("the printed pipeline (sha256 of the sheet plus the newline node -p adds) equals the recorded sheetHash", () => {
    const file = JSON.parse(fs.readFileSync(path.join(out, "memory/aloof/sheet.json"), "utf8"));
    const printed = createHash("sha256").update(`${file.sheet}\n`).digest("hex");
    assert.equal(printed, file.sheetHash);
  });
});

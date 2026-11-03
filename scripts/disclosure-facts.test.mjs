// Pins docs/DISCLOSURE.md to what git reports about the first commit.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, TZ: "UTC" } }).trim();
const disclosure = readFile(new URL("../docs/DISCLOSURE.md", import.meta.url), "utf8");

const haveHistory = () => {
  try {
    return git("rev-parse", "--is-shallow-repository") === "false" && git("rev-list", "--count", "HEAD") !== "0";
  } catch {
    return false;
  }
};

test("DISCLOSURE.md first-commit timestamp equals git's UTC time", { skip: !haveHistory() && "needs full git history" }, async () => {
  const [sha, utc] = git("log", "--reverse", "--format=%h %cd", "--date=iso-strict-local", "--max-parents=0")
    .split("\n")[0]
    .split(" ");
  const text = await disclosure;
  assert.match(utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.ok(text.includes(`\`${sha}\``), `first commit ${sha} named`);
  assert.ok(text.includes(`committed at ${utc} (UTC)`), `UTC timestamp ${utc} stated`);
  const stored = execFileSync("git", ["log", "--reverse", "--format=%cd", "--date=iso-strict", "--max-parents=0"], { cwd: root, encoding: "utf8" }).split("\n")[0];
  assert.ok(text.includes(stored), `stored form ${stored} stated`);
  assert.equal(new Date(stored).toISOString().replace(".000", ""), utc);
  assert.ok(text.includes("--date=iso-strict-local"), "check command uses iso-strict-local");
  assert.ok(!/dated 2026-11-02/.test(text), "no local-date claim left");
});

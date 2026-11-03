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
  const [sha, raw] = git("log", "--reverse", "--format=%h %cd", "--date=iso-strict-local", "--max-parents=0")
    .split("\n")[0]
    .split(" ");
  // Git versions differ: some print UTC as Z, others as +00:00.
  const utc = raw.replace(/\+00:00$/, "Z");
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

const read = (rel) => readFile(new URL(`../${rel}`, import.meta.url), "utf8");

test("DISCLOSURE.md calls near-sdk a runtime dependency, matching Cargo.toml", async () => {
  const cargo = await read("contracts/personality-nft/Cargo.toml");
  const [deps, devDeps] = cargo.split(/^\[dev-dependencies\]/m);
  assert.match(deps, /^near-sdk = "5\.30\.0"/m);
  assert.match(devDeps, /^near-sdk = \{[^}]*"unit-testing"/m);
  assert.match(await disclosure, /`near-sdk` 5\.30\.0 \(runtime dependency of the contract; also a dev-dependency with the `unit-testing` feature\)/);
});

test("code window dates: submissions open 2026-11-01, baseline cutoff 2026-10-19 (Q-001)", async () => {
  assert.match(await read("docs/HACKATHON.md"), /Q-001\. Code before 2026-11-01\?\*\* Yes, from the announcement on 2026-10-19/);
  for (const rel of ["docs/DISCLOSURE.md", "docs/submission-checklist.md"]) {
    const text = await read(rel);
    assert.match(text, /submissions open 2026-11-01/i, `${rel} names the open date`);
    assert.match(text, /2026-10-19/, `${rel} names the baseline cutoff`);
  }
});

test("submission-checklist cites README sections that exist", async () => {
  const readme = await read("README.md");
  const checklist = await read("docs/submission-checklist.md");
  for (const section of ["Mock caveats and status", "Disclosure", "Inference"]) {
    assert.match(readme, new RegExp(`^## ${section}$`, "m"), `README has "${section}"`);
    assert.ok(checklist.includes(`"${section}"`), `checklist cites "${section}"`);
  }
  assert.doesNotMatch(checklist, /README "Inference" table/);
  assert.doesNotMatch(checklist, /README "What this is"[^|]*pre-hackathon|under "What this is" Status/);
  assert.match(readme, /pre-hackathon code \(none\)/);
});

test("personality-nft audit names the init call testnet-deploy really builds", async () => {
  const deploy = await read("scripts/testnet-deploy.mjs");
  assert.match(deploy, /"with-init-call", INIT_METHOD/);
  assert.match(deploy, /INIT_METHOD = "new_default_meta"/);
  const audit = await read("docs/audit/personality-nft.md");
  assert.match(audit, /with-init-call new_default_meta/);
  assert.doesNotMatch(audit, /--initFunction/);
});

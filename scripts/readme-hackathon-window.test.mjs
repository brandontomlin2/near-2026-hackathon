// Pins the README's "Hackathon window" section (Q-003 diff link).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const section = readme.split("\n## Hackathon window\n")[1]?.split(/\n## /)[0] ?? "";

test("README has a Hackathon window section that links the pre-hackathon...main diff", () => {
  assert.ok(section, "README must have a 'Hackathon window' section");
  assert.match(
    section,
    /https:\/\/github.com\/brandontomlin2\/near-2026-hackathon\/compare\/pre-hackathon\.\.\.main/,
  );
  assert.match(section, /hackathon-submission/);
  assert.match(section, /pre-hackathon/);
});

test("Hackathon window sits immediately before Disclosure", () => {
  const headings = [...readme.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
  const i = headings.indexOf("Hackathon window");
  const j = headings.indexOf("Disclosure");
  assert.ok(i >= 0 && j >= 0, "both headings exist");
  assert.equal(j, i + 1, "'Disclosure' directly follows 'Hackathon window'");
});

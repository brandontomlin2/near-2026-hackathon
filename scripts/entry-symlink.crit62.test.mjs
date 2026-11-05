// crit62: demo.mjs, swarm.mjs and site.mjs must run when launched through a symlink
// (argv[1] is the link, import.meta.url the real file). Before the fix they exited 0
// with no output and wrote nothing.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPTS = ["demo", "swarm", "site"];
const real = (name) => fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));

let tmp;
before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crit62-symlink-"));
});
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const env = () => {
  const e = { ...process.env };
  delete e.MOCK_INFERENCE;
  return e;
};
const run = (entry, args) =>
  spawnSync(process.execPath, [entry, ...args], { cwd: tmp, env: env(), encoding: "utf8", timeout: 30000 });
// demo and swarm take --out DIR; site takes the directory as its only argument.
const outArgs = (name, dir) => (name === "site" ? [dir] : ["--out", dir]);
const link = (name, dirInTmp = "") => {
  const dir = path.join(tmp, dirInTmp);
  fs.mkdirSync(dir, { recursive: true });
  const l = path.join(dir, `${name}-link.mjs`);
  if (!fs.existsSync(l)) fs.symlinkSync(real(name), l);
  return l;
};

describe("launch through a symlink", () => {
  for (const name of SCRIPTS) {
    it(`${name}: prints output and writes files via a symlinked script`, () => {
      const out = path.join(tmp, `out-${name}`);
      const r = run(link(name), outArgs(name, out));
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stdout.trim().length > 0, "stdout must not be empty");
      assert.ok(fs.existsSync(out) && fs.readdirSync(out).length > 0, "output dir must be written");
    });

    it(`${name}: a bad flag via the link exits 2, not a silent 0`, () => {
      const r = run(link(name), ["--definitely-not-a-flag"]);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /--definitely-not-a-flag|unknown/i);
    });
  }

  it("demo: works with a symlinked directory in front of the script", () => {
    const realDir = path.dirname(real("demo"));
    const dirLink = path.join(tmp, "scripts-dir-link");
    fs.symlinkSync(realDir, dirLink);
    const out = path.join(tmp, "out-dirlink");
    const r = run(path.join(dirLink, "demo.mjs"), ["--out", out]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim().length > 0);
    assert.ok(fs.existsSync(path.join(out, "index.html")));
  });
});

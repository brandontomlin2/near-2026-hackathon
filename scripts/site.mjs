// Static site: runs the mock demo into a gitignored folder (default out/site).
// Every file is referenced by a relative path, so the folder opens from file://
// and from any static host. No network, nothing signed.
// Usage: node scripts/site.mjs [DIR]

import { fileURLToPath } from "node:url";
import { main } from "./demo.mjs";

export const DEFAULT_SITE_DIR = "out/site";

const USAGE = `Usage: node scripts/site.mjs [DIR]
  DIR  output directory (default ${DEFAULT_SITE_DIR})
Runs the mock demo into DIR with relative links only. Nothing is signed or sent.`;

export function buildSite(dir = DEFAULT_SITE_DIR, opts) {
  return main(["--out", dir], { ...opts, name: "site" });
}

/** Returns { dir } or { help: true }; throws on anything but one plain directory. */
export function parseArgs(argv) {
  if (argv.some((a) => a === "--help" || a === "-h")) return { help: true };
  const flag = argv.find((a) => a.startsWith("-"));
  if (flag !== undefined) throw new Error(`unknown argument ${JSON.stringify(flag)}; the only argument is an output directory`);
  if (argv.length > 1) throw new Error(`expected one output directory, got ${argv.length} arguments`);
  if (argv.length === 1 && argv[0].trim() === "") throw new Error('output directory must not be empty, got ""');
  return { dir: argv[0] ?? DEFAULT_SITE_DIR };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`site: ${error.message} (see --help)`);
    process.exitCode = 2;
  }
  if (opts?.help) {
    console.log(USAGE);
  } else if (opts) {
    const code = await buildSite(opts.dir);
    if (code === 0) console.log(`\nSite ready: ${opts.dir}/index.html (open it, or upload the folder to a static host; see docs/hosting.md)`);
    process.exitCode = code;
  }
}

// Static site: runs the mock demo into a gitignored folder (default out/site).
// Every file is referenced by a relative path, so the folder opens from file://
// and from any static host. No network, nothing signed.
// Usage: node scripts/site.mjs [DIR]

import { fileURLToPath } from "node:url";
import { main } from "./demo.mjs";

export const DEFAULT_SITE_DIR = "out/site";

export function buildSite(dir = DEFAULT_SITE_DIR, opts) {
  return main(["--out", dir], opts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? DEFAULT_SITE_DIR;
  const code = await buildSite(dir);
  if (code === 0) console.log(`\nSite ready: ${dir}/index.html (open it, or upload the folder to a static host; see docs/hosting.md)`);
  process.exitCode = code;
}

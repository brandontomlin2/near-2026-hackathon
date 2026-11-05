// Guard for `npm test`: Node 20's test runner does not expand globs, so it fails with a
// confusing "Could not find" error. Fail early with a clear message instead.
// Keep this file free of newer syntax so it parses on old Node versions.
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

// Returns null when `version` (e.g. "v22.1.0") satisfies the minimum major, else a message.
export function checkNode(version, minMajor, what) {
  const major = Number(String(version).replace(/^v/, "").split(".")[0]);
  if (major >= minMajor) return null;
  return (
    (what || "npm test") + " needs Node " + minMajor + " or later (found " + version + "). " +
    "Install Node " + minMajor + "+ and retry."
  );
}

// Minimum major from package.json "engines.node" (">=22" -> 22).
export function minMajorFromPackage() {
  const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
  const range = JSON.parse(readFileSync(pkgPath, "utf8")).engines.node;
  return Number(/(\d+)/.exec(range)[1]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const message = checkNode(process.version, minMajorFromPackage());
  if (message) {
    console.error(message);
    process.exit(1);
  }
}

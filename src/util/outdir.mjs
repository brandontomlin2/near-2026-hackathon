// Output-dir ownership for the generating CLIs: a run clears only the files it
// generates (by name pattern, in known subdirs), so a second run with other options
// never leaves the first run's files beside its own. Nothing outside outDir is touched.

import { readdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, parse, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const contains = (outer, inner) => {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Throw if outDir is the filesystem root, the home dir, the repo root, or any ancestor of them. */
export function assertSafeOutDir(outDir) {
  const dir = resolve(outDir);
  const risky = [parse(dir).root, homedir(), REPO_ROOT].map((p) => resolve(p));
  if (risky.some((p) => contains(dir, p))) {
    throw new Error(`refusing --out ${JSON.stringify(outDir)}: it is the filesystem root, your home directory, the repo root, or contains one of them`);
  }
  return dir;
}

/** `cannot write <dir>: <short reason>` for a Node filesystem error (error.code like ENOENT), or null for any other error. */
export function describeWriteFailure(dir, error) {
  if (typeof error?.code !== "string" || !/^E[A-Z]+$/.test(error.code)) return null;
  const reason = String(error.message).split("\n")[0].replace(/^E[A-Z]+: /, "").replace(/, (mkdir|open|scandir|opendir|rmdir|unlink|access|stat|lstat|rename|symlink|copyfile|rm|mkdtemp|realpath) '.*$/, "");
  return `cannot write ${dir}: ${reason}`;
}

/** Remove regular files directly inside outDir/sub whose names match `pattern`. A missing dir is fine. */
export async function clearOwnedFiles(outDir, sub, pattern) {
  const dir = join(outDir, sub);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return;
    throw error;
  }
  for (const e of entries) {
    if ((e.isFile() || e.isSymbolicLink()) && pattern.test(e.name)) await rm(join(dir, e.name), { force: true });
  }
}

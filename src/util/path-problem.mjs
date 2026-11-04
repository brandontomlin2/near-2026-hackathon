// One-line, plain-English reason for the filesystem errors a bad output path causes,
// so a CLI never prints a raw Node error (EEXIST / ENOTDIR / EISDIR) to a judge.
// The caller already names the path; this says what is wrong with it and what to pass instead.

/**
 * @param {unknown} error  an Error thrown by mkdir / writeFile / readFile
 * @param {string} flag    what the user passed, e.g. "--out" or "EVIDENCE_OUT"
 * @returns {string | null} the explanation, or null when the error is not a path-shape problem
 */
export function pathProblem(error, flag) {
  const code = error?.code;
  if (code === "EEXIST" || code === "ENOTDIR") {
    return `a file is in the way, but ${flag} must be a directory (or sit inside one); pass another path (--help shows usage)`;
  }
  if (code === "EISDIR") return `that is a directory; ${flag} needs a file path (--help shows usage)`;
  return null;
}

// One-line, plain-English reason for the filesystem errors a bad output path causes,
// so a CLI never prints a raw Node error (EEXIST / ENOTDIR / EISDIR) to a judge.

/**
 * @param {unknown} error  an Error thrown by mkdir / writeFile / readFile
 * @param {string} flag    what the user passed, e.g. "--out" or "EVIDENCE_OUT"
 * @returns {string | null} the explanation, or null when the error is not a path-shape problem
 */
export function pathProblem(error, flag) {
  const code = error?.code;
  const where = error?.path ?? "a part of the path";
  if (code === "EEXIST" || code === "ENOTDIR") {
    return `${where} is a file, not a directory, so ${flag} cannot go there; pass a path that is not inside or on a file (see --help)`;
  }
  if (code === "EISDIR") return `${where} is a directory, so ${flag} cannot be written there; pass a file path (see --help)`;
  return null;
}

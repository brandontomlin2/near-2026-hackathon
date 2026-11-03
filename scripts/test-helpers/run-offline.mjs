// Runs a node script in a child process with the no-network preload and
// returns { code, stdout, stderr, violations }. `violations` is every trip the
// guard logged, even ones the script caught and ignored.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PRELOAD = fileURLToPath(new URL("./no-network.mjs", import.meta.url));

export async function runOffline(args, { env = {}, cwd = process.cwd() } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "no-network-"));
  const logFile = join(dir, "violations.log");
  const childEnv = { ...process.env, ...env, NO_NETWORK_LOG: logFile };
  // Mock runs must work without keys; make sure none leak in from the host.
  for (const key of ["NEAR_AI_API_KEY", "NEAR_AI_MODEL", "NEAR_NETWORK", "NEAR_ACCOUNT_ID", "NEAR_CONTRACT_ACCOUNT_ID", "EVIDENCE_NETWORK", "MOCK_INFERENCE"]) {
    if (!(key in env)) delete childEnv[key];
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", PRELOAD, ...args], { env: childEnv, cwd });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    const violations = (await readFile(logFile, "utf8").catch(() => "")).split("\n").filter(Boolean);
    return { ...result, violations };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

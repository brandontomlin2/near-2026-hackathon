// Preload guard for scripts/yield-shade-check.mjs: node --import scripts/yield-shade-check-guard.mjs <script>
//
// Wraps every way a script could reach the network or start a process (fetch, net, tls, http, https,
// dns, child_process). Each call appends one line to the file named by YIELD_SHADE_GUARD_LOG and then
// throws, so the guarded script can neither succeed nor hide the attempt. It never signs or sends
// anything itself; it only records and blocks.

import { appendFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";

const require = createRequire(import.meta.url);
const logFile = process.env.YIELD_SHADE_GUARD_LOG;

function blocked(name) {
  return function guarded() {
    if (logFile) appendFileSync(logFile, `${name}\n`);
    throw new Error(`yield-shade-check guard: ${name} is blocked (the shade dry run must be offline and spawn nothing)`);
  };
}

function patch(target, names, prefix) {
  for (const name of names) {
    if (typeof target[name] === "function") target[name] = blocked(`${prefix}.${name}`);
  }
}

globalThis.fetch = blocked("fetch");
if (typeof globalThis.WebSocket === "function") globalThis.WebSocket = blocked("WebSocket");
if (typeof globalThis.XMLHttpRequest === "function") globalThis.XMLHttpRequest = blocked("XMLHttpRequest");

const net = require("node:net");
patch(net, ["connect", "createConnection"], "net");
net.Socket.prototype.connect = blocked("net.Socket.prototype.connect");
patch(require("node:tls"), ["connect"], "tls");
patch(require("node:http"), ["request", "get"], "http");
patch(require("node:https"), ["request", "get"], "https");
patch(require("node:http2"), ["connect"], "http2");
patch(require("node:dgram"), ["createSocket"], "dgram");
patch(require("node:dns"), ["lookup", "resolve", "resolve4", "resolve6"], "dns");
patch(
  require("node:child_process"),
  ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"],
  "child_process",
);

// Make `import { spawnSync } from "node:child_process"` see the patched functions too.
syncBuiltinESMExports();

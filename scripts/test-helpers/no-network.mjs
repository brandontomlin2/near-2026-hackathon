// Preload guard: `node --import ./scripts/test-helpers/no-network.mjs script.mjs`.
// Any attempt to reach the network, resolve a name or spawn a process throws
// and is also appended to the file named by NO_NETWORK_LOG, so a script that
// swallows the error still fails the test. Covers fetch, WebSocket,
// node:http/https request/get, node:net and node:tls connect, node:dns
// lookups (callback, promises, resolver), node:dgram, and every node:child_process
// spawner (curl, near, anything). Mock runs must not need any of them.

import { createRequire } from "node:module";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const log = process.env.NO_NETWORK_LOG;

function trip(route) {
  return (...args) => {
    const detail = args.length && typeof args[0] === "string" ? ` ${args[0]}` : "";
    const message = `NO_NETWORK violation: ${route}${detail}`;
    if (log) appendFileSync(log, `${message}\n`);
    throw new Error(message);
  };
}

function patch(target, route, names) {
  for (const name of names) {
    if (name in target) target[name] = trip(`${route}.${name}`);
  }
}

globalThis.fetch = trip("fetch");
if ("WebSocket" in globalThis) globalThis.WebSocket = trip("WebSocket");
if ("EventSource" in globalThis) globalThis.EventSource = trip("EventSource");

patch(require("node:http"), "http", ["request", "get"]);
patch(require("node:https"), "https", ["request", "get"]);
patch(require("node:http2"), "http2", ["connect"]);

const net = require("node:net");
patch(net, "net", ["connect", "createConnection"]);
net.Socket.prototype.connect = trip("net.Socket.connect");
patch(require("node:tls"), "tls", ["connect"]);
patch(require("node:dgram").Socket.prototype, "dgram", ["send", "connect"]);

const dns = require("node:dns");
patch(dns, "dns", ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]);
patch(dns.promises, "dns.promises", ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "reverse"]);

patch(require("node:child_process"), "child_process", [
  "spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork",
]);

syncBuiltinESMExports();

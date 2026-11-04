#!/usr/bin/env node
// Dependency-free fallback secret scan, used by scripts/verify.sh ONLY when gitleaks
// is not installed. It is far narrower than gitleaks: it checks git-tracked files for a
// short list of high-signal patterns and prints file:line and rule name, never the value.
//
// Rules:
//   near-ed25519-private-key   ed25519: + 86..88 base58 chars (a 64-byte secret key;
//                              public keys are 44 chars and do not match)
//   near-secp256k1-private-key secp256k1: + 43..44 base58 chars (a 32-byte secret key;
//                              secp256k1 public keys are 87..88 chars and do not match)
//   pem-private-key            -----BEGIN ... PRIVATE KEY----- headers
//   seed-phrase                a seed/mnemonic/phrase/secret key whose value is 12 or 24
//                              lowercase words, in env/config-like files only
//   aws-access-key-id          AKIA/ASIA + 16 upper-case alphanumerics
//   github-token               ghp_/gho_/ghu_/ghs_/ghr_ + 36+ chars, or github_pat_ + 22+
//   openai-style-token         sk- + 20+ token chars (also covers sk-proj- and sk-ant-)
//   slack-token                xox[abprs]- + 10+ chars
//
// Allowlist: ALLOWLIST below lists known test fixtures as { file, rule, includes }.
// A finding is dropped only when its file path equals `file`, its rule equals `rule`
// and the matched text contains `includes`. Keep entries this narrow. The repo has
// none today: tests build their fake keys at runtime.
//
// Usage: node scripts/secret-scan-fallback.mjs [--root <dir>]
// Exit: 0 no findings, 1 findings, 2 usage or git error.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const B58 = "[1-9A-HJ-NP-Za-km-z]";
const WORD = "[a-z]{3,8}";

export const ALLOWLIST = [
  // { file: "path/in/repo", rule: "rule-name", includes: "text inside the match" },
];

export const RULES = [
  { name: "near-ed25519-private-key", re: new RegExp(`\\bed25519:${B58}{86,88}(?!${B58})`, "g") },
  { name: "near-secp256k1-private-key", re: new RegExp(`\\bsecp256k1:${B58}{43,44}(?!${B58})`, "g") },
  { name: "pem-private-key", re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/g },
  {
    name: "seed-phrase",
    configOnly: true,
    re: new RegExp(
      `(?:seed|mnemonic|passphrase|recovery|secret)[\\w.-]*["']?\\s*[:=]\\s*["']?(?:${WORD}\\s+){11}${WORD}(?:(?:\\s+${WORD}){12})?(?![\\w ])`,
      "gi",
    ),
  },
  { name: "aws-access-key-id", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { name: "openai-style-token", re: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
];

const CONFIG_FILE = /(?:^|\/)\.env(?:\.[^/]*)?$|\.(?:json|toml|ya?ml|ini|conf|cfg|properties|env)$/i;
const MAX_BYTES = 2 * 1024 * 1024;

function isAllowed(file, rule, matched) {
  return ALLOWLIST.some((a) => a.file === file && a.rule === rule && matched.includes(a.includes));
}

// A seed phrase is exactly 12 or 24 words; the regex above also matches 13..23 words
// as a prefix of a longer run, so count the words in the matched value.
function wordCountOk(matched) {
  const value = matched.split(/[:=]/).slice(1).join(" ").replace(/["']/g, "").trim();
  const n = value.split(/\s+/).length;
  return n === 12 || n === 24;
}

export function scanText(file, text) {
  const findings = [];
  const lines = text.split("\n");
  const isConfig = CONFIG_FILE.test(file);
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.configOnly && !isConfig) continue;
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        if (rule.name === "seed-phrase" && !wordCountOk(m[0])) continue;
        if (isAllowed(file, rule.name, m[0])) continue;
        findings.push({ file, line: i + 1, rule: rule.name });
      }
    }
  });
  return findings;
}

export function scanRepo(root) {
  const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  const files = out.toString("utf8").split("\0").filter(Boolean);
  const findings = [];
  let scanned = 0;
  for (const file of files) {
    const abs = path.join(root, file);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue; // deleted in the working tree
    }
    if (!stat.isFile() || stat.size > MAX_BYTES) continue;
    const buf = fs.readFileSync(abs);
    if (buf.subarray(0, 8192).includes(0)) continue; // binary
    scanned += 1;
    findings.push(...scanText(file, buf.toString("utf8")));
  }
  return { scanned, findings };
}

function main(argv) {
  let root = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--root" && argv[i + 1]) {
      root = argv[(i += 1)];
    } else {
      console.error(`secret-scan-fallback: unknown argument "${argv[i]}"\nusage: node scripts/secret-scan-fallback.mjs [--root <dir>]`);
      return 2;
    }
  }
  let result;
  try {
    result = scanRepo(root);
  } catch (err) {
    console.error(`secret-scan-fallback: could not list git-tracked files in ${root}: ${err.message}`);
    return 2;
  }
  for (const f of result.findings) console.log(`${f.file}:${f.line}: ${f.rule} (value not shown)`);
  if (result.findings.length > 0) {
    console.log(`secret-scan-fallback: ${result.findings.length} finding(s) in ${result.scanned} tracked file(s)`);
    return 1;
  }
  console.log(`secret-scan-fallback: no findings in ${result.scanned} tracked file(s)`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === new URL(import.meta.url).pathname) {
  process.exitCode = main(process.argv.slice(2));
}

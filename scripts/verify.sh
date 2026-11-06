#!/usr/bin/env bash
# Local judge screen. GitHub Actions is intentionally disabled.
# bash, shellcheck -s bash. Never reads or prints keys. Never uses mainnet.
set -euo pipefail
unset CDPATH

usage() {
  cat <<'EOF'
Usage: bash scripts/verify.sh [--live]

Mock run (no keys, no chain writes):
  bash scripts/verify.sh

Testnet run (never mainnet; do not put keys on the command line). The evidence
stage reads NEAR_CONTRACT_ACCOUNT_ID as the contract account to query (the same
variable the deploy step uses; NEAR_ACCOUNT_ID, the signer there, is the fallback
when it is unset) and the transaction hashes from EVIDENCE_TX_FILE (an absolute
path; the script cd's into a fresh clone):
  NEAR_NETWORK=testnet NEAR_CONTRACT_ACCOUNT_ID=<contract-account> EVIDENCE_TX_FILE="$PWD/out/live-proof/txs.json" bash scripts/verify.sh --live

  The live evidence stage includes the transaction hashes in EVIDENCE_TX_FILE
  (the file npm run live-proof writes). A relative path is resolved against the
  directory you run this script from, then against the source checkout, before
  the fresh clone is entered (out/ is gitignored, so it does not exist there).
  When EVIDENCE_TX_FILE is unset and out/live-proof/txs.json exists in the
  source checkout, that file is used.

The script clones HEAD into a temp directory, installs dependencies when
package.json exists, runs node --test on test files that exist, and scans
with gitleaks when that binary is installed. When it is not, the stage runs
scripts/secret-scan-fallback.mjs (a narrower built-in scan of git-tracked files)
and records PASS or FAIL labelled FALLBACK; only if node is also missing does it
print WARN lines and record SKIP. Planned npm scripts are:

  deploy:nft   testnet deploy of the NFT contract (live only)
  mint         mint 4 tokens (mock unless --live)
  swarm        N rounds with MOCK_INFERENCE=1 (default N=5, or SWARM_ROUNDS)
  demo         the offline end-to-end demo with MOCK_INFERENCE=1 (out/index.html)
  evidence     write out/evidence.json (mock memory loop: swarm, sheets, anchor_sheet
               dry-runs, mock, not on-chain proof; real hashes and RPC views with --live)
  anchor       dry-run round-hash determinism check (always mock, never signs)
  yield:demo:check  runs the yield demo with a timeout; PASS only if plan.json is a dry run
               (signed false, sent false, 1 call planned, the planner's pool 747 swap re-checked with checkProposal, 0 signed, one vault id, one gas figure) with 4 matching rule rejections
  yield:shade:check  runs yield:shade:dry-run under a guard (no near CLI, network or subprocess call);
               PASS only if it is a testnet dry run (signed false, sent false) and refused flags exit 1
  yield:live:check  runs yield:live:dry-run under a guard (no near CLI, network or subprocess call);
               PASS only if it is an unsigned testnet plan and signing flags and NEAR_NETWORK=mainnet exit 2

The mock evidence stage passes only for placeholder entries marked mock.
A missing planned script prints SKIP (not built yet) and does not fail.
Exit status is 0 when every stage is PASS or SKIP, and nonzero on any failure.
EOF
}

LIVE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --live)
      LIVE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "verify: unknown argument \"$1\" (see --help)" >&2
      exit 2
      ;;
  esac
done

failed=0
work=""
runner=""
runner_dir=""
results_file=""
source_root=""

# TMPDIR may be relative (TMPDIR=../tmp). Every temp path is used again after the
# script has cd'd into the fresh clone, so resolve it once to an absolute directory
# and export that, so node's os.tmpdir() inside the clone agrees.
tmp_root=$(cd "${TMPDIR:-/tmp}" 2>/dev/null && pwd -P) || {
  echo "verify: TMPDIR is not a directory: \"${TMPDIR:-/tmp}\"" >&2
  exit 2
}
export TMPDIR="$tmp_root"

# A row that cannot be written is a hard failure: under set -e the run aborts, cleanup
# prints the summary, and the stage check below refuses PASS for the missing rows.
record() {
  local status="$1"
  local stage="$2"
  local detail="$3"
  if ! printf '%s\t%s\t%s\n' "$status" "$stage" "$detail" >> "$results_file"; then
    echo "FAIL: could not record stage \"${stage}\" in \"${results_file}\"; the summary would be incomplete" >&2
    failed=1
    return 1
  fi
}

print_summary() {
  # Every stage a complete run records, in order. result: PASS is printed only when
  # each one has a row, so a lost results file can never look like a clean pass.
  local expected_stages=(
    "fresh clone" "workflows" "symlinks" "secret files" "npm install" "tests"
    "secret scan" "deploy nft" "mint" "swarm" "demo" "round hash" "yield" "yield demo" "yield shade" "yield live" "vault tests"
    "evidence"
  )
  local status stage detail seen=$'\n' missing=""
  echo
  echo "SUMMARY"
  printf '%-8s  %-14s  %s\n' "STATUS" "STAGE" "DETAIL"
  printf '%-8s  %-14s  %s\n' "------" "-----" "------"
  if [[ -n "$results_file" && -f "$results_file" ]]; then
    while IFS=$'\t' read -r status stage detail; do
      printf '%-8s  %-14s  %s\n' "$status" "$stage" "$detail"
      seen="${seen}${stage}"$'\n'
    done < "$results_file"
  fi
  echo
  if [[ "$failed" -eq 0 ]]; then
    for stage in "${expected_stages[@]}"; do
      if [[ "$seen" != *$'\n'"${stage}"$'\n'* ]]; then
        missing="${missing:+${missing}, }${stage}"
      fi
    done
    if [[ -n "$missing" ]]; then
      echo "FAIL: no row was recorded for: ${missing}"
      failed=1
    fi
  fi
  if [[ "$secret_scan_skipped" -eq 1 ]]; then
    echo "WARN: the secret scan did NOT run because gitleaks is not installed; install it (brew install gitleaks) and rerun for a scanned result."
  fi
  if [[ "$failed" -eq 0 ]]; then
    echo "result: PASS"
  else
    echo "result: FAIL"
  fi
}

# Set to 1 when gitleaks is missing so the summary repeats the warning next to the result.
secret_scan_skipped=0

# Runs gitleaks on the fresh clone (current directory). Missing gitleaks is a loud
# SKIP, never a FAIL: judges may not have it, and the WARN lines go to stdout so
# they survive in pasted output. CI is not involved here; this is the local screen.
secret_scan() {
  local gitleaks_args
  echo
  echo "==> secret scan"
  if ! command -v gitleaks >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && [[ -f scripts/secret-scan-fallback.mjs ]]; then
    echo "NOTE: gitleaks is not installed; running the narrower built-in fallback scan (scripts/secret-scan-fallback.mjs)."
    if node scripts/secret-scan-fallback.mjs; then
      record PASS "secret scan" "FALLBACK scan, no findings (gitleaks not installed; narrower than gitleaks)"
    else
      echo "FAIL: fallback secret scan reported findings or failed"
      record FAIL "secret scan" "FALLBACK scan reported findings or failed (gitleaks not installed)"
      failed=1
    fi
    return 0
  fi
  if ! command -v gitleaks >/dev/null 2>&1; then
    secret_scan_skipped=1
    echo "WARN: secret scan did NOT run: gitleaks is not installed on this machine."
    echo "WARN: install gitleaks (brew install gitleaks, or a release from https://github.com/gitleaks/gitleaks/releases) and rerun bash scripts/verify.sh to scan."
    echo "WARN: this stage is SKIP, not FAIL, so result: PASS below does not mean the tree was scanned for secrets."
    record SKIP "secret scan" "NOT RUN: gitleaks not installed (brew install gitleaks)"
    return 0
  fi
  gitleaks_args=(detect --source . --redact --no-banner --verbose)
  if [[ -f .gitleaks.toml ]]; then
    gitleaks_args+=(--config .gitleaks.toml)
  fi
  if gitleaks "${gitleaks_args[@]}"; then
    record PASS "secret scan" "no findings"
  else
    echo "FAIL: gitleaks reported findings or failed"
    record FAIL "secret scan" "gitleaks reported findings or failed"
    failed=1
  fi
}

# The live evidence stage runs `npm run evidence` inside the fresh clone, where out/
# is gitignored, so the relative EVIDENCE_TX_FILE that live-proof prints
# (out/live-proof/txs.json) would not resolve there and `transactions` would be [].
# Called before the cd into the clone: turns a relative path into an absolute one
# (invoking directory first, then the source checkout), defaults to the live-proof
# file in the source checkout when unset, and exports the result for the runner.
# Prints the chosen path; never reads the file (evidence.mjs does, and fails loudly).
resolve_evidence_tx_file() {
  local root="$1"
  local file="${EVIDENCE_TX_FILE:-}"
  if [[ -z "$file" ]]; then
    if [[ -f "$root/out/live-proof/txs.json" ]]; then
      file="$root/out/live-proof/txs.json"
    else
      echo "evidence tx file: none (EVIDENCE_TX_FILE unset, no out/live-proof/txs.json in ${root})"
      return 0
    fi
  elif [[ "$file" != /* ]]; then
    if [[ -f "$PWD/$file" ]]; then
      file="$PWD/$file"
    else
      file="$root/$file"
    fi
  fi
  if [[ ! -f "$file" ]]; then
    echo "WARN: evidence tx file ${file} does not exist; the evidence stage will fail without transaction hashes." >&2
  fi
  export EVIDENCE_TX_FILE="$file"
  echo "evidence tx file: ${EVIDENCE_TX_FILE}"
}

cleanup() {
  local code=$?
  if [[ "$code" -ne 0 && "$failed" -eq 0 ]]; then
    # An unexpected abort (set -e, a missing file) must never end in "result: PASS".
    failed=1
    if [[ -n "$results_file" && -f "$results_file" ]]; then
      record FAIL "aborted" "exited with status $code before the last stage" || true
    fi
  fi
  print_summary || true
  if [[ "$code" -eq 0 && "$failed" -ne 0 ]]; then
    # The summary found a gap (a stage with no row): "result: FAIL" needs a nonzero exit too.
    code=1
  fi
  if [[ -n "$work" && -d "$work" ]]; then
    rm -rf "$work"
  fi
  if [[ -n "$runner_dir" && -d "$runner_dir" ]]; then
    rm -rf "$runner_dir"
  fi
  if [[ -n "$results_file" && -f "$results_file" ]]; then
    rm -f "$results_file"
  fi
  exit "$code"
}

write_runner() {
  # macOS mktemp only randomises a trailing run of X's, so a ".js" suffix
  # would make every run pick the same name and concurrent runs collide.
  # Make a random directory and use a fixed file name inside it.
  runner_dir=$(mktemp -d "$tmp_root/near-verify-run.XXXXXX")
  runner="$runner_dir/run.js"
  cat > "$runner" <<'JS'
const { spawnSync } = require("node:child_process");

const mode = process.argv[2];
const npmArgs = process.argv.slice(3);

function isSecretName(name) {
  return /(^|_)(API_KEY|ACCESS_KEY|SECRET|PRIVATE_KEY|TOKEN|PASSWORD|MNEMONIC|PASSPHRASE|CREDENTIAL|CREDENTIALS|SEED_PHRASE|KEYPAIR)($|_)/i.test(name)
    || /(^|_)KEY($|_)/i.test(name);
}

if (mode !== "mock" && mode !== "live") {
  console.error("refusing to run: unknown npm mode");
  process.exit(1);
}

if (process.env.NEAR_NETWORK === "mainnet") {
  console.error("refusing to run: NEAR_NETWORK=mainnet");
  process.exit(1);
}

const env = {};
for (const [name, value] of Object.entries(process.env)) {
  if (mode === "mock" && (isSecretName(name) || name === "NEAR_ACCOUNT_ID" || name === "NEAR_CONTRACT_ACCOUNT_ID")) {
    continue;
  }
  env[name] = value;
}

if (mode === "mock") {
  env.MOCK_INFERENCE = "1";
  delete env.NEAR_NETWORK;
  env.EVIDENCE_NETWORK = "mock";
} else {
  env.NEAR_NETWORK = "testnet";
  env.EVIDENCE_NETWORK = "testnet";
  env.MOCK_INFERENCE = "0";
}

const result = spawnSync("npm", npmArgs, { env, stdio: "inherit" });
if (result.error) {
  console.error("npm failed to start");
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
JS
}

run_npm() {
  local mode="$1"
  shift
  node "$runner" "$mode" "$@"
}

script_status() {
  local name="$1"
  node -e '
const fs = require("fs");
const name = process.argv[1];
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
} catch (err) {
  process.exit(2);
}
const scripts = pkg && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
process.exit(Object.prototype.hasOwnProperty.call(scripts, name) ? 0 : 1);
' "$name"
}

last_outcome=""

planned() {
  local stage="$1"
  local script="$2"
  local kind="$3"
  shift 3
  local rc=0
  local mode="mock"

  echo
  echo "==> ${stage}"

  if [[ ! -f package.json ]]; then
    echo "SKIP (not built yet)"
    record SKIP "$stage" "SKIP (not built yet)"
    last_outcome="skip"
    return 0
  fi

  script_status "$script" || rc=$?
  if [[ "$rc" -eq 2 ]]; then
    echo "FAIL: package.json is not valid JSON"
    record FAIL "$stage" "package.json is not valid JSON"
    failed=1
    last_outcome="fail"
    return 0
  fi
  if [[ "$rc" -ne 0 ]]; then
    echo "SKIP (not built yet)"
    record SKIP "$stage" "SKIP (not built yet)"
    last_outcome="skip"
    return 0
  fi

  case "$kind" in
    mock)
      mode="mock"
      ;;
    live)
      mode="live"
      ;;
    auto)
      if [[ "$LIVE" -eq 1 ]]; then
        mode="live"
      else
        mode="mock"
      fi
      ;;
    *)
      echo "FAIL: unknown stage kind"
      record FAIL "$stage" "unknown stage kind"
      failed=1
      last_outcome="fail"
      return 0
      ;;
  esac

  if [[ "$mode" == "live" && "$LIVE" -ne 1 ]]; then
    echo "SKIP (live testnet not requested)"
    record SKIP "$stage" "npm run ${script} exists; live testnet not requested"
    last_outcome="skip"
    return 0
  fi

  if run_npm "$mode" run "$script" -- "$@"; then
    if [[ "$stage" == "evidence" ]]; then
      last_outcome="pass"
    else
      record PASS "$stage" "npm run ${script} (${mode})"
      last_outcome="pass"
    fi
  else
    echo "FAIL: npm run ${script} failed"
    record FAIL "$stage" "npm run ${script} failed"
    failed=1
    last_outcome="fail"
  fi
}

evidence_ok() {
  node -e '
const fs = require("fs");
let raw;
try {
  raw = fs.readFileSync("out/evidence.json", "utf8");
} catch (err) {
  console.error("missing out/evidence.json");
  process.exit(1);
}
let data;
try {
  data = JSON.parse(raw);
} catch (err) {
  console.error("out/evidence.json is not JSON");
  process.exit(1);
}
if (!data || typeof data !== "object" || Array.isArray(data)) {
  console.error("out/evidence.json must be a JSON object");
  process.exit(1);
}
const live = process.argv[1] === "live";
const txs0 = Array.isArray(data.transactions) ? data.transactions : [];
const views0 = Array.isArray(data.views) ? data.views : [];
if (!live) {
  // Mock evidence: placeholders only, clearly marked, never real-looking.
  const mockOk = data.mock === true && data.network === "mock"
    && txs0.length > 0 && txs0.every((tx) => tx && tx.mock === true && /^MOCK-/.test(String(tx.hash)))
    && views0.length > 0 && views0.every((v) => v && v.mock === true && typeof v.method === "string" && v.method.length > 0);
  if (!mockOk) {
    console.error("mock evidence must be marked mock with MOCK- placeholder hashes");
    process.exit(1);
  }
  const hex64 = /^[0-9a-f]{64}$/;
  const ml = data.memory_loop;
  const mlTokens = ml && Array.isArray(ml.tokens) ? ml.tokens : [];
  const finalHash = ml && ml.swarm ? ml.swarm.final_round_hash : undefined;
  const mlOk = ml && ml.mock === true && hex64.test(String(finalHash))
    && mlTokens.length > 0
    && new Set(mlTokens.map((t) => t && t.token_id)).size === mlTokens.length
    && mlTokens.every((t) => {
      const a = t && t.anchor;
      return t && typeof t.token_id === "string" && t.sheet && hex64.test(String(t.sheet.sheet_hash))
        && a && a.status === "dry-run" && a.mock === true && a.transaction_hash === null
        && a.method === "anchor_sheet" && a.args && a.args.sheet_hash === t.sheet.sheet_hash
        && a.args.token_id === t.token_id && a.linked_round_hash === finalHash
        // Every sheet, not just the latest: its own dry-run, linked to its own round hash,
        // in order, chained to the one before, and the last one is the latest sheet.
        && Array.isArray(t.sheets) && t.sheets.length > 0
        && t.sheets.every((s, i) => {
          const sa = s && s.anchor;
          return s && hex64.test(String(s.sheet_hash)) && sa && sa.status === "dry-run" && sa.mock === true
            && sa.transaction_hash === null && sa.method === "anchor_sheet" && sa.args
            && sa.args.sheet_hash === s.sheet_hash && sa.args.token_id === t.token_id
            && Number.isInteger(s.round) && s.round >= 1 && s.round <= ml.swarm.rounds
            && sa.linked_round_hash === ml.swarm.round_hashes[s.round - 1]
            && s.previous_hash === (i === 0 ? null : t.sheets[i - 1].sheet_hash)
            && (i === 0 || s.round > t.sheets[i - 1].round);
        })
        && t.sheets.at(-1).sheet_hash === t.sheet.sheet_hash;
    });
  if (!mlOk) {
    console.error("mock evidence needs a memory_loop of anchor_sheet dry-runs linked to the final round hash");
    process.exit(1);
  }
  process.exit(0);
}
if (Object.prototype.hasOwnProperty.call(data, "network") && data.network !== "testnet") {
  console.error("evidence network must be testnet");
  process.exit(1);
}
const txs = Array.isArray(data.transactions) ? data.transactions : [];
const views = Array.isArray(data.views) ? data.views : [];
const hashOk = txs.length > 0 && txs.every((tx) => {
  return tx && typeof tx.hash === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,}$/.test(tx.hash);
});
const viewOk = views.some((view) => {
  return view && typeof view.method === "string" && view.method.length > 0 && Object.prototype.hasOwnProperty.call(view, "result");
});
if (!hashOk || !viewOk) {
  console.error("out/evidence.json needs transaction hashes and RPC view results");
  process.exit(1);
}
' "$1"
}

results_file=$(mktemp "$tmp_root/near-verify-results.XXXXXX")
trap 'cleanup' EXIT
export GIT_TERMINAL_PROMPT=0
set +x

if [[ "${NEAR_NETWORK:-}" == "mainnet" ]]; then
  echo "error: NEAR_NETWORK=mainnet is refused. This script never uses mainnet." >&2
  record FAIL "network" "mainnet is refused"
  failed=1
  exit 1
fi

if [[ -n "${NEAR_NETWORK:-}" && "${NEAR_NETWORK}" != "testnet" ]]; then
  echo "error: NEAR_NETWORK must be unset or testnet." >&2
  record FAIL "network" "NEAR_NETWORK must be unset or testnet"
  failed=1
  exit 1
fi

if [[ "$LIVE" -eq 1 ]]; then
  # The evidence stage queries NEAR_CONTRACT_ACCOUNT_ID, falling back to NEAR_ACCOUNT_ID.
  if [[ "${NEAR_NETWORK:-}" != "testnet" || ( -z "${NEAR_CONTRACT_ACCOUNT_ID:-}" && -z "${NEAR_ACCOUNT_ID:-}" ) ]]; then
    echo "error: --live requires NEAR_NETWORK=testnet and NEAR_CONTRACT_ACCOUNT_ID (or NEAR_ACCOUNT_ID)." >&2
    record FAIL "live env" "--live requires NEAR_NETWORK=testnet and NEAR_CONTRACT_ACCOUNT_ID (or NEAR_ACCOUNT_ID)"
    failed=1
    exit 1
  fi
  if [[ -n "${NEAR_CONTRACT_ACCOUNT_ID:-}" ]]; then
    echo "mode: live (testnet, contract account NEAR_CONTRACT_ACCOUNT_ID set, keys not printed)"
  else
    echo "mode: live (testnet, contract account from NEAR_ACCOUNT_ID, keys not printed)"
  fi
else
  echo "mode: mock (no keys)"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required" >&2
  record FAIL "node" "node is not installed"
  failed=1
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "error: git is required" >&2
  record FAIL "git" "git is not installed"
  failed=1
  exit 1
fi

write_runner

script_dir=$(dirname -- "$0")
case "$script_dir" in
  /*) ;;
  *) script_dir="${PWD}/${script_dir}" ;;
esac
script_dir=$(cd -- "$script_dir" && pwd)
source_root=$(git -C "$script_dir" rev-parse --show-toplevel)
source_head=$(git -C "$source_root" rev-parse HEAD)
short_head=$(git -C "$source_root" rev-parse --short=12 HEAD)

if [[ "$LIVE" -eq 1 ]]; then
  resolve_evidence_tx_file "$source_root"
fi

echo
echo "==> fresh clone"
if [[ -n "$(git -C "$source_root" status --porcelain)" ]]; then
  echo "WARN: working tree is dirty; verifying committed HEAD ${short_head} only." >&2
fi

work=$(mktemp -d "$tmp_root/near-verify.XXXXXX")
if git clone --local --no-hardlinks --quiet "$source_root" "$work/repo" \
  && git -C "$work/repo" checkout --detach --quiet "$source_head"; then
  record PASS "fresh clone" "$short_head"
else
  echo "FAIL: git clone failed"
  record FAIL "fresh clone" "git clone failed"
  failed=1
  exit 1
fi

cd "$work/repo"

echo
echo "==> workflows"
workflow_hits=""
if [[ -d .github/workflows ]]; then
  while IFS= read -r path; do
    if [[ -n "$path" ]]; then
      if [[ -z "$workflow_hits" ]]; then
        workflow_hits="$path"
      else
        workflow_hits="${workflow_hits} ${path}"
      fi
    fi
  done < <(find .github/workflows -type f -print)
fi
if [[ -n "$workflow_hits" ]]; then
  echo "FAIL: GitHub Actions workflow files are not allowed: ${workflow_hits}"
  record FAIL "workflows" "workflow files present; CI is disabled"
  failed=1
else
  echo "no workflow files; CI is disabled"
  record PASS "workflows" "no workflow files; CI disabled"
fi

echo
echo "==> symlinks"
symlink_broken=0
while IFS=$'\t' read -r meta path; do
  mode=${meta%% *}
  if [[ "$mode" == "120000" && ! -e "$path" ]]; then
    echo "broken symlink: ${path} -> $(readlink "$path")" >&2
    symlink_broken=1
  fi
done < <(git ls-files -s)
if [[ "$symlink_broken" -eq 0 ]]; then
  record PASS "symlinks" "tracked symlinks resolve"
else
  record FAIL "symlinks" "broken tracked symlink"
  failed=1
fi

echo
echo "==> secret files"
secret_hits=$(git ls-files | grep -E '(^|/)\.env(\..*)?$|\.(pem|key)$' | grep -v '\.env\.example$' || true)
if [[ -n "$secret_hits" ]]; then
  echo "$secret_hits" >&2
  record FAIL "secret files" "tracked env or key filenames"
  failed=1
else
  record PASS "secret files" "no tracked env or key files"
fi

echo
echo "==> npm install"
if [[ ! -f package.json ]]; then
  echo "SKIP (not built yet)"
  record SKIP "npm install" "SKIP (not built yet)"
elif ! command -v npm >/dev/null 2>&1; then
  echo "FAIL: npm is not installed"
  record FAIL "npm install" "npm is not installed"
  failed=1
elif [[ -f package-lock.json ]]; then
  if npm ci --no-audit --no-fund; then
    record PASS "npm install" "npm ci"
  else
    echo "FAIL: npm ci failed"
    record FAIL "npm install" "npm ci failed"
    failed=1
  fi
else
  if npm install --no-audit --no-fund; then
    record PASS "npm install" "npm install"
  else
    echo "FAIL: npm install failed"
    record FAIL "npm install" "npm install failed"
    failed=1
  fi
fi

echo
echo "==> tests"
test_files=()
while IFS= read -r -d '' path; do
  test_files+=("$path")
done < <(find . \
  \( -type d \( -name node_modules -o -name .git -o -name .agents -o -name .claude -o -name dist -o -name build -o -name out -o -name target -o -name coverage \) -prune \) \
  -o \( -type f \( \
    -name '*.test.js' -o -name '*.test.mjs' -o -name '*.test.cjs' \
    -o -name '*.spec.js' -o -name '*.spec.mjs' -o -name '*.spec.cjs' \
  \) -print0 \))
if [[ ${#test_files[@]} -eq 0 ]]; then
  echo "no test files"
  record SKIP "tests" "no test files"
elif node --test "${test_files[@]}"; then
  record PASS "tests" "${#test_files[@]} file(s)"
else
  echo "FAIL: node --test failed"
  record FAIL "tests" "node --test failed"
  failed=1
fi

secret_scan

# No --json here: the dry run must keep the wasm-built gate, so `verify.sh --live`
# FAILs when the contract wasm has not been built (npm run build:contract).
planned "deploy nft" "deploy:nft" live
planned "mint" "mint" auto
rounds="${SWARM_ROUNDS:-5}"
if [[ ! "$rounds" =~ ^[1-9][0-9]*$ ]]; then
  echo
  echo "==> swarm"
  echo "FAIL: SWARM_ROUNDS must be a positive integer"
  record FAIL "swarm" "SWARM_ROUNDS must be a positive integer"
  failed=1
else
  planned "swarm" "swarm" mock --rounds "$rounds"
fi

planned "demo" "demo" mock
planned "round hash" "anchor" mock --dry-run --check
# Yield Optimizer: one mock debate round, dry run (nothing signed or sent).
planned "yield" "yield" mock
# Yield demo: runs npm run yield:demo with a timeout and checks plan.json (dry run, 1 call planned and re-checked on a pool with a reference price, pool 1 refused as off reference, one vault id, one gas figure, 4 rule rejections).
planned "yield demo" "yield:demo:check" mock
# Yield shade: runs the Shade dry run under a no-near-CLI, no-network, no-subprocess guard and checks it never signs or sends.
planned "yield shade" "yield:shade:check" mock
# Yield live: runs the unsigned testnet live-path planner (dry-run) under the same guard and checks it never signs or sends.
planned "yield live" "yield:live:check" mock

# Yield vault contract unit tests. The build cache is the source checkout's
# gitignored target/ so a fresh clone does not recompile near-sdk every run.
echo
echo "==> vault tests"
if [[ ! -f contracts/yield-vault/Cargo.toml ]]; then
  echo "SKIP (not built yet)"
  record SKIP "vault tests" "SKIP (not built yet)"
elif ! command -v cargo >/dev/null 2>&1; then
  echo "WARN: cargo not installed; the yield vault contract tests did NOT run" >&2
  record SKIP "vault tests" "NOT RUN: cargo not installed"
elif (cd contracts/yield-vault && CARGO_TARGET_DIR="${source_root}/contracts/yield-vault/target" cargo test --quiet); then
  record PASS "vault tests" "cargo test (contracts/yield-vault)"
else
  echo "FAIL: cargo test failed in contracts/yield-vault"
  record FAIL "vault tests" "cargo test failed (contracts/yield-vault)"
  failed=1
fi

planned "evidence" "evidence" auto
if [[ "$last_outcome" == "pass" ]]; then
  if evidence_ok "$([[ "$LIVE" -eq 1 ]] && echo live || echo mock)"; then
    mkdir -p "${source_root}/out"
    cp "out/evidence.json" "${source_root}/out/evidence.json"
    # Repo-relative on purpose: this output is pasted into pull requests.
    echo "wrote out/evidence.json"
    if [[ "$LIVE" -eq 1 ]]; then
      record PASS "evidence" "wrote out/evidence.json"
    else
      echo "evidence: mock, not on-chain proof"
      record PASS "evidence" "wrote out/evidence.json (mock, not on-chain proof)"
    fi
  else
    echo "FAIL: out/evidence.json missing tx hashes or RPC views"
    record FAIL "evidence" "out/evidence.json missing tx hashes or RPC views"
    failed=1
  fi
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

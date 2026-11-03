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

Testnet run (never mainnet; do not put keys on the command line):
  NEAR_NETWORK=testnet NEAR_ACCOUNT_ID=<testnet-account> bash scripts/verify.sh --live

The script clones HEAD into a temp directory, installs dependencies when
package.json exists, runs node --test on test files that exist, and scans
with gitleaks when that binary is installed. Planned npm scripts are:

  deploy:nft   testnet deploy of the NFT contract (live only)
  mint         mint 4 tokens (mock unless --live)
  swarm        N rounds with MOCK_INFERENCE=1 (default N=5, or SWARM_ROUNDS)
  demo         the offline end-to-end demo with MOCK_INFERENCE=1 (out/index.html)
  evidence     write out/evidence.json (mock placeholders; real hashes and RPC views with --live)
  anchor       dry-run round-hash determinism check (always mock, never signs)

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
      echo "unknown argument: $1" >&2
      usage >&2
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

record() {
  local status="$1"
  local stage="$2"
  local detail="$3"
  printf '%s\t%s\t%s\n' "$status" "$stage" "$detail" >> "$results_file"
}

print_summary() {
  local status stage detail
  echo
  echo "SUMMARY"
  printf '%-8s  %-14s  %s\n' "STATUS" "STAGE" "DETAIL"
  printf '%-8s  %-14s  %s\n' "------" "-----" "------"
  if [[ -n "$results_file" && -f "$results_file" ]]; then
    while IFS=$'\t' read -r status stage detail; do
      printf '%-8s  %-14s  %s\n' "$status" "$stage" "$detail"
    done < "$results_file"
  fi
  echo
  if [[ "$failed" -eq 0 ]]; then
    echo "result: PASS"
  else
    echo "result: FAIL"
  fi
}

cleanup() {
  local code=$?
  print_summary || true
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
  runner_dir=$(mktemp -d "${TMPDIR:-/tmp}/near-verify-run.XXXXXX")
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
  if (mode === "mock" && (isSecretName(name) || name === "NEAR_ACCOUNT_ID")) {
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
  process.exit(0);
}
if (Object.prototype.hasOwnProperty.call(data, "network") && data.network !== "testnet") {
  console.error("evidence network must be testnet");
  process.exit(1);
}
const txs = Array.isArray(data.transactions) ? data.transactions : [];
const views = Array.isArray(data.views) ? data.views : [];
const hashOk = txs.some((tx) => {
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

results_file=$(mktemp "${TMPDIR:-/tmp}/near-verify-results.XXXXXX")
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
  if [[ "${NEAR_NETWORK:-}" != "testnet" || -z "${NEAR_ACCOUNT_ID:-}" ]]; then
    echo "error: --live requires NEAR_NETWORK=testnet and NEAR_ACCOUNT_ID." >&2
    record FAIL "live env" "--live requires NEAR_NETWORK=testnet and NEAR_ACCOUNT_ID"
    failed=1
    exit 1
  fi
  echo "mode: live (testnet, account id set, keys not printed)"
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

echo
echo "==> fresh clone"
if [[ -n "$(git -C "$source_root" status --porcelain)" ]]; then
  echo "WARN: working tree is dirty; verifying committed HEAD ${short_head} only." >&2
fi

work=$(mktemp -d "${TMPDIR:-/tmp}/near-verify.XXXXXX")
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

echo
echo "==> secret scan"
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "WARN: secret scan did NOT run (gitleaks not found). optional: brew install gitleaks" >&2
  record SKIP "secret scan" "gitleaks not installed (warn)"
else
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
fi

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

planned "evidence" "evidence" auto
if [[ "$last_outcome" == "pass" ]]; then
  if evidence_ok "$([[ "$LIVE" -eq 1 ]] && echo live || echo mock)"; then
    mkdir -p "${source_root}/out"
    cp "out/evidence.json" "${source_root}/out/evidence.json"
    echo "wrote ${source_root}/out/evidence.json"
    record PASS "evidence" "wrote out/evidence.json"
  else
    echo "FAIL: out/evidence.json missing tx hashes or RPC views"
    record FAIL "evidence" "out/evidence.json missing tx hashes or RPC views"
    failed=1
  fi
fi

if [[ "$failed" -ne 0 ]]; then
  exit 1
fi

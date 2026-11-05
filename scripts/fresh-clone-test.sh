#!/usr/bin/env bash
# AI-screener check: fresh clone, npm ci, the README judge path, README blocks marked <!-- judge:run -->.
# Offline, no keys, no chain writes. Never reads .env or key files.
set -uo pipefail
unset CDPATH

usage() {
  cat <<'USAGE'
Usage: bash scripts/fresh-clone-test.sh [--allow-empty] [REPO_PATH]

Clones REPO_PATH (default: the repo containing this script) via file:// into a
temp dir, runs npm ci, walks the offline README judge path (demo, ask, anchors,
attest:check, swarm, render; scripts/fresh-clone-judge-path.mjs, SKIP when the
clone has no scripts/demo.mjs), then runs every README.md fenced shell block that is
preceded by <!-- judge:run -->. Blocks may also be preceded by
<!-- judge:expect TEXT --> lines; the combined output must contain TEXT.
Blocks without the run marker are skipped. Prints a PASS/FAIL table and exits
nonzero on any failure.

  --allow-empty   a README with no judge:run blocks is SKIP instead of FAIL
USAGE
}

allow_empty=()
repo=""
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --allow-empty) allow_empty=(--allow-empty) ;;
    -*) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
    *) repo="$arg" ;;
  esac
done

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
if [[ -z "$repo" ]]; then
  repo=$(git -C "$script_dir" rev-parse --show-toplevel)
fi
repo=$(cd -- "$repo" && pwd) || { echo "error: not a directory: $repo" >&2; exit 2; }

export GIT_TERMINAL_PROMPT=0
work=$(mktemp -d "${TMPDIR:-/tmp}/near-fresh-clone.XXXXXX")
pre="$work/pre.tsv"
trap 'rm -rf "$work"' EXIT
: > "$pre"
row() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$pre"; }

finish() {
  local out="$work/helper.out" code
  node "$script_dir/fresh-clone-lib.mjs" run --readme "$work/repo/README.md" --cwd "$work/repo" \
    --pre "$pre" ${allow_empty[@]+"${allow_empty[@]}"} | tee "$out"
  code=${PIPESTATUS[0]}
  # A silent helper must never read as success: require its result line.
  if ! grep -Eq '^result: (PASS|FAIL)$' "$out"; then
    echo "error: helper printed no 'result:' line; treating as FAIL" >&2
    exit 1
  fi
  exit "$code"
}

if [[ -n "$(git -C "$repo" status --porcelain 2>/dev/null)" ]]; then
  echo "WARN: $repo has uncommitted changes; testing committed HEAD only." >&2
fi

echo "==> clone file://$repo"
if git clone --quiet "file://$repo" "$work/repo"; then
  row PASS clone "file://$repo @ $(git -C "$work/repo" rev-parse --short=12 HEAD)"
else
  row FAIL clone "git clone failed"
  mkdir -p "$work/repo"
  finish
fi
cd "$work/repo" || exit 1

for f in LICENSE README.md; do
  if [[ -f "$f" ]]; then row PASS "$f" present; else row FAIL "$f" missing; fi
done

echo "==> npm ci"
if [[ ! -f package.json ]]; then
  row SKIP "npm ci" "no package.json"
elif [[ ! -f package-lock.json ]]; then
  row FAIL "npm ci" "package-lock.json missing"
elif npm ci --no-audit --no-fund; then
  row PASS "npm ci" ok
else
  row FAIL "npm ci" failed
fi

echo "==> judge path"
if [[ ! -f scripts/demo.mjs ]]; then
  row SKIP "judge path" "no scripts/demo.mjs"
else
  rows_before=$(wc -l < "$pre")
  if ! node "$script_dir/fresh-clone-judge-path.mjs" --cwd "$work/repo" --rows "$pre" \
    && [[ "$(wc -l < "$pre")" -eq "$rows_before" ]]; then
    row FAIL "judge path" "helper failed without writing rows"
  fi
fi

finish

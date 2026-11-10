# Judge checklist for an AI screener

What an AI screener checks on this repository, in order. Everything runs
offline with no keys and no chain writes. Nothing here needs a testnet
account. Inference is mock (`MOCK_INFERENCE=1`) and anchor calls are dry runs;
no testnet deployment, NEAR AI Cloud call or on-chain anchor has been run or
is evidenced in this repository. Live paths exist in code (`src/inference/client.mjs`,
`scripts/testnet-deploy.mjs`, `scripts/live-proof.mjs`) but need keys and a
human's explicit approval. See `docs/tracks.md`.

## Checks

| # | Check | How |
| --- | --- | --- |
| 1 | The README says what the product is, the problem, and how NEAR fits | Read `README.md` top to bottom. |
| 2 | The README has numbered "do X, see Y" steps | Each step is a command plus the output to expect. Steps a judge can run are in fenced blocks marked `<!-- judge:run -->`. |
| 3 | Those steps actually work from a fresh clone | `bash scripts/fresh-clone-test.sh` (see below). |
| 4 | `LICENSE` exists | The same script checks it. MIT. |
| 5 | Tests run | `npm ci` then `npm test` (also part of `bash scripts/verify.sh`). |
| 6 | The code matches the README's claims | For each claim (4 agents, round hash chain, character sheets and their hashes, dry-run anchor calls, determinism), find the code and the output that shows it. A claim with no code or output is a mismatch. |
| 7 | Disclosures | The README lists libraries, templates and AI-generated code, and any pre-hackathon code. |
| 8 | No secrets, no CI workflows | `bash scripts/verify.sh` (secret files, gitleaks when installed, no `.github/workflows`). |
| 9 | The claimed tracks match what exists | The claimed tracks are exactly `security` (AI Security & Defense), `defi` (Unstoppable DeFi) and `nfts` (NFTs That Do Something): `security` and `defi` are the Yield Optimizer vault, `nfts` is supporting. `swarms`, `agents` and `privacy` are not claimed. Read `docs/tracks.md` for what each track gets and what does not exist. |

## Run the fresh-clone script

```sh
bash scripts/fresh-clone-test.sh            # this repo, committed HEAD, via file://
bash scripts/fresh-clone-test.sh /path/to/repo
bash scripts/fresh-clone-test.sh --allow-empty   # no judge:run blocks is SKIP, not FAIL
```

It clones to a temp dir, checks `LICENSE` and `README.md`, runs `npm ci`,
walks the offline README judge path with `scripts/fresh-clone-judge-path.mjs`
(demo, ask, anchors, attest:check, swarm, render; every quoted string must
appear in both the README and the command output, and a failure names the
drifted side), then runs the README blocks marked runnable. Only committed work is tested;
uncommitted changes print a warning. It prints a PASS/FAIL/SKIP table and
exits non-zero if any row is FAIL. The temp dir is removed at the end.

Each block runs as one `bash` script (`set -eo pipefail`) in the clone root,
with a 120 s limit. Leading `$ ` prompts, comments and blank lines are
ignored; `\` line continuations are joined.

The environment is scrubbed: names with a KEY, TOKEN, SECRET, PASSWORD or
similar segment, `NEAR_ACCOUNT_ID` and `NEAR_NETWORK` are removed, and
`MOCK_INFERENCE=1` is forced (a block may set it itself, for example to
show that a live call without a key fails safely).

## Marking README blocks

Put the markers on their own lines directly above the fence. Blank lines and
other markers may sit between them.

````markdown
<!-- judge:run -->
<!-- judge:expect mode: mock -->
```sh
npm run infer -- "What do you make of the treasury proposal?"
```
````

- `<!-- judge:run -->` makes the block runnable. Blocks without it are never run. Prose between the marker and the fence cancels it.
- `<!-- judge:expect TEXT -->` (zero or more) requires `TEXT` to appear in the block's combined stdout and stderr. The step passes only if the exit code is 0 and every expect is found.
- A lint (not a sandbox, easily bypassed) flags a marked block as FAIL if it uses `curl`/`wget`, `--live`, the `near` CLI, `cargo near`, `git push`, `npm publish` or `npm login`, reads `.env` or key files, selects a non-testnet network, or is not a shell block. The child runs with a scrubbed environment and a temp `HOME`. Mark only offline, keyless steps. Do not mark `bash scripts/verify.sh` (it clones and installs again) or the testnet run.

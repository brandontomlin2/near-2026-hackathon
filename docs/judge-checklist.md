# Judge checklist for an AI screener

What an AI screener checks on this repository, in order. The product is the Yield Optimizer vault: AI agents propose trades, a NEAR vault contract's on-chain rules veto the bad ones, and only trades that pass execute on Rhea (Ref Finance). Everything below runs offline with no keys and no chain writes; nothing here needs a testnet account. Inference is mock (`MOCK_INFERENCE=1`) and every vault and anchor command is a dry run. One approved testnet run happened on 2026-11-09 (testnet only, nothing on mainnet): the vault and the NFT contract are deployed, one NFT token (`aloof`) was minted, and one swap went through `execute_swap`. Its ids, transaction hashes and a read-only `curl` check are in the README section "Live on testnet". The owner sent that swap by hand, so it was not agent-picked, and the vault has not refused a live transaction. The tooling in this repository never signs. See `docs/tracks.md`.

## Checks

| # | Check | How |
| --- | --- | --- |
| 1 | The README says what the product is, the problem, and how NEAR fits | Read `README.md` top to bottom. It opens with the vault: the problem, what `npm run yield:demo` shows and a plain status paragraph, then "Judge quick path", "Live on testnet", "Validate locally" and "Tracks and how NEAR fits". The personality NFTs are under "Supporting: the personality NFTs". |
| 2 | The README has numbered "do X, see Y" steps | "Judge quick path" has four steps: `npm install && npm run yield:demo`, `npm run demo`, `open out/index.html`, `bash scripts/verify.sh`. Each step is a command plus the output to expect. Steps a judge can run are in fenced blocks marked `<!-- judge:run -->`. |
| 3 | Those steps actually work from a fresh clone | `bash scripts/fresh-clone-test.sh` (see below). |
| 4 | `LICENSE` exists | The same script checks it. MIT. |
| 5 | Tests run | `npm ci` then `npm test` (also part of `bash scripts/verify.sh`). |
| 6 | The code matches the README's claims | For each claim (the vault's pool allowlist, `max_trade`, `daily_cap`, price floor, runner allowlist and the named errors; four rule rejections in `npm run yield:demo`; the live swap in "Live on testnet"; and, for the supporting side, 4 agents, round hash chain, character sheets and their hashes, dry-run anchor calls, determinism), find the code and the output that shows it. A claim with no code or output is a mismatch. |
| 7 | Disclosures | The README lists libraries, templates and AI-generated code, and any pre-hackathon code. |
| 8 | The live claims are checkable and no larger than they are | The README's "Verify it yourself with curl (read-only, no near-cli-rs)" reads the vault's state and the swap transaction from public testnet RPC endpoints (needs the network, so the tests do not run it). Expect `"swaps_executed":1` and a `swap_executed` event. Claims beyond one swap, mainnet, NEAR Intents or TEE attestation are mismatches. |
| 9 | No secrets, no CI workflows | `bash scripts/verify.sh` (secret files, gitleaks when installed, no `.github/workflows`). |
| 10 | The claimed tracks match what exists | The claimed tracks are exactly `security` (AI Security & Defense), `defi` (Unstoppable DeFi) and `nfts` (NFTs That Do Something): `security` and `defi` are the Yield Optimizer vault, `nfts` is supporting. `swarms`, `agents` and `privacy` are not claimed. Read `docs/tracks.md` for what each track gets and what does not exist. |

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

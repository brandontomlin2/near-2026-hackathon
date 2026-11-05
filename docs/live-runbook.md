# Live testnet runbook

For the owner. Nothing in this repository has been run live, and nothing here runs until you decide to. Only step 6 signs and spends; every other step is a build, a read-only check or a dry run. The shorter checklist is `docs/live-readiness.md`; this file is the ordered procedure. Mainnet is refused everywhere.

## 1. Preconditions

Tools:

- near-cli-rs v0.14 or later on `PATH` (`near --version`). Dry runs do not need it; step 6 does.
- cargo-near and Rust, for `npm run build:contract` only (the README says it was tested with cargo-near 0.22.0).
- `node` and `npm` (the repository has no other runtime dependency for these steps).

Accounts (two, both already created and funded on testnet; the scripts never create accounts and never read, print or create keys):

| Role | Env var | Signs |
| --- | --- | --- |
| Contract account, a named `<name>.testnet` | `NEAR_CONTRACT_ACCOUNT_ID` | the `deploy` transaction (`near contract deploy <contract> ... sign-with-keychain`) |
| Owner account | `NEAR_ACCOUNT_ID` | the four `nft_mint` transactions and `anchor_sheet` (`sign-as <owner>`), and is the token owner |

Both keys must be in the near-cli-rs keychain (`near login`). The send step checks that a keychain key exists for each signer before it sends.

Media host: a public HTTPS (or ipfs/ar) folder that will serve `aloof.svg`, `chaotic.svg`, `social.svg` and `skeptic.svg`, exactly the bytes `npm run render` writes. `media_hash` on each token is the sha256 of those bytes, so a re-render or edit after upload breaks the match. The folder's URL is `<url>` below.

Environment variable names this runbook uses (names only; export values in your own shell, nothing in this repository loads `.env`, and no value or key belongs in the repository, a PR or a commit):

- `NEAR_NETWORK`: leave unset or set to `testnet`; anything else is refused.
- `NEAR_ACCOUNT_ID`: the owner account.
- `NEAR_CONTRACT_ACCOUNT_ID`: the contract account; must be set explicitly for a send and must end in `.testnet`.
- `EVIDENCE_NETWORK`: `testnet` for the evidence step (default is `mock`).
- `EVIDENCE_TX_FILE`: the JSON file of transaction hashes the evidence step reads.

## 2. Commands, in order

Total cost of the run in step 6: deposits of 0.21 NEAR (four mints at 0.05 NEAR, one `anchor_sheet` at 0.01 NEAR, deploy at 0 NEAR) plus gas. Gas is not itemised by the scripts; the prepaid gas is 100 Tgas per deploy or mint and 30 Tgas for the anchor, and only the gas actually used is burned.

### Step 1. Build the contract (no signing)

```sh
npm run build:contract
```

Expect `Contract successfully built!` and the file `contracts/personality-nft/target/near/personality_nft.wasm` (about 279 KB; about 2 minutes on the first run).

### Step 2. Preflight (no signing)

```sh
export NEAR_ACCOUNT_ID=<owner>.testnet
export NEAR_CONTRACT_ACCOUNT_ID=<contract>.testnet
npm run live:check
```

Expect every line `[ok]` (or `[skip]`), then `ready: yes.` and exit 0. Any `[todo]` gives `ready: no.` and exit 1. It makes one read-only RPC `view_account` call per account; `npm run live:check -- --offline` skips that call. Account ids are never printed.

### Step 3. Render and upload the SVGs (no signing)

```sh
npm run render
```

Expect four lines, `out/aloof.svg` through `out/skeptic.svg`. Upload exactly those four files to the media folder, then open `<url>/aloof.svg` in a browser to confirm it is served.

### Step 4. Rehearsal (no signing, no network)

```sh
npm run live:dry-run -- --media-base <url>
```

`npm run live:dry-run` is `node scripts/live-proof.mjs --dry-run`. It prints the six steps and sends nothing (it spawns nothing and touches no network). It writes an example file to `out/live-proof/evidence.example.json` (`"example": true`, placeholder hashes). With both accounts exported, the output starts:

```
dry-run: nothing is signed or sent. Add --send --i-approve to broadcast on testnet.
network: testnet   owner: owner-x.testnet   contract: nft-x.testnet

[1/6] deploy
  call     nft-x.testnet.new_default_meta
```

(`owner-x.testnet` and `nft-x.testnet` stand in for your accounts.) Each step lists `call`, `args`, `deposit`, `gas` and the exact `command` that would run. It ends with two `summary:` lines. Check them before going on:

```
summary: contract nft-x.testnet  owner owner-x.testnet  agents aloof, chaotic, social, skeptic  total deposit 0.21 NEAR
summary: anchor sheet_hash 35b263d770d675b370ab4fa18a19c2bd40cdd3afa13ef885414ef798c87e2203
```

Check the contract and owner are the accounts you mean, the agents are the four above, the total deposit is `0.21 NEAR`, and every `media` URL in the mint args is under your `<url>`. Without the exported accounts the same lines show `<NEAR_ACCOUNT_ID>` and `<NEAR_CONTRACT_ACCOUNT_ID>`. The rehearsal does not check that the wasm exists (it plans the deploy without reading it); `npm run live:check` (step 2) does.

### Step 5. Owner approval

Stop here. Do not continue without your own explicit yes.

### Step 6. The one command that signs and spends

```sh
npm run live-proof -- --send --i-approve --media-base <url>
```

This signs and sends six testnet transactions: deploy (signed by the contract account), four `nft_mint` calls and `anchor_sheet` (signed by the owner). It is refused with exit 2 and nothing sent if `--i-approve` is missing, if `--media-base` is missing, if `NEAR_ACCOUNT_ID` or `NEAR_CONTRACT_ACCOUNT_ID` is unset or invalid, if the contract is not a named `.testnet` account, or if `NEAR_NETWORK` is anything but `testnet`. `--out`, `--force` and `--update-example` are refused with `--send`.

Expect first:

```
send: deploy, mint x4, anchor_sheet on testnet as <owner>, contract <contract>
```

then each near-cli-rs transaction streamed as it runs, and at the end:

```
wrote 6 of 6 transaction hashes to out/live-proof/txs.json
done. Next, with read-only RPC views (nothing signed):
  EVIDENCE_NETWORK=testnet NEAR_CONTRACT_ACCOUNT_ID=<contract>.testnet EVIDENCE_TX_FILE=out/live-proof/txs.json npm run evidence
```

(with your real contract account id in place of `<contract>.testnet`) and exit 0. `out/live-proof/txs.json` holds `{network, contract, owner, transactions: [{label, hash}, ...]}` with the labels `deploy`, `mint aloof`, `mint chaotic`, `mint social`, `mint skeptic`, `anchor_sheet`. A step that exited 0 contributes the hashes the near CLI printed; a step that failed contributes none. See section 3 if the output differs.

### Step 7. Evidence (read-only)

Run the command printed at the end of step 6, which for a contract account `<contract>.testnet` is:

```sh
EVIDENCE_NETWORK=testnet NEAR_CONTRACT_ACCOUNT_ID=<contract>.testnet EVIDENCE_TX_FILE=out/live-proof/txs.json npm run evidence
```

It makes read-only RPC views only. It prints `wrote <absolute path>/out/evidence.json (testnet)` and exits 0; a failed view prints `view failed: <method>: <error>` on stderr and exits 1. A plain `npm run evidence` without `EVIDENCE_NETWORK=testnet` is mock mode and writes `MOCK-` placeholders; it is not proof.

### Step 8. Judge screen against the live evidence (no signing)

```sh
NEAR_NETWORK=testnet NEAR_CONTRACT_ACCOUNT_ID=<contract>.testnet EVIDENCE_TX_FILE="$PWD/out/live-proof/txs.json" bash scripts/verify.sh --live
```

`EVIDENCE_TX_FILE` must be an absolute path, because the script runs in a fresh clone of the committed `HEAD` in a temp directory (`out/` is gitignored, so the tx file is read from your checkout through that path). Expect the 17-row `STATUS / STAGE / DETAIL` table and `result: PASS`. The `deploy nft` and `mint` rows run as dry runs. This step does not check the chain: it fails unless every transaction in `out/evidence.json` has a valid hash, there is at least one, and at least one RPC view returned a result.

## 3. If something fails

Everything already sent stays on chain. The run stops at the first failed step.

1. Read the lines at the end of the `live-proof` output. A failed step prints `error: <stage> failed with exit <n>; stopping. Earlier transactions were not rolled back.` and then:
   - `wrote <k> of 6 transaction hashes to out/live-proof/txs.json`: `txs.json` is written even after a failure, with only the steps that exited 0.
   - `FAILED: <stage> exited <n>. Not recorded (not sent, or sent and failed): <labels>.` The labels are the failed step and every step after it. near-cli-rs can print a transaction id for a transaction that executed and then failed, so a failed step's id is deliberately not recorded.
   - `Next, once the failed step has been redone and every hash is in the file ...` followed by the evidence command. Do not run it yet.
2. `WARN: no hash found in the near CLI output for: <labels>.` means those steps exited 0 (the transactions exist) but no `Transaction ID:` block could be read. Find each hash in the explorer under `https://explorer.testnet.near.org/accounts/<contract>.testnet` and add `{"label": "<label>", "hash": "<hash>"}` to the `transactions` array in `out/live-proof/txs.json` by hand. Use the exact labels above.
3. Do not rerun the whole `live-proof --send` command after a partial run. Its first step would redeploy the code and call `new_default_meta` again, which fails on an already-initialized contract, and `nft_mint` of a token id that already exists fails with `token_id must be unique`, so you would spend gas and still not have a clean record. Redo only the failed step by hand:
   - Take its `command` line from the step 4 rehearsal (`npm run live:dry-run -- --media-base <url>`) and run that one `near ...` command yourself. This is a second signing action: it needs your explicit yes, just like step 6.
   - Do the steps in order (deploy, the four mints, `anchor_sheet`); a mint needs the deploy, and `anchor_sheet` needs the aloof token.
   - Copy the transaction hash from the output into `out/live-proof/txs.json` with the matching label, keeping the transactions in send order.
4. Once all six labels are in `txs.json`, run step 7 and step 8.

Common refusals (exit 2 or 1, nothing sent) are listed in `docs/live-readiness.md`.

## 4. Fill in evidence and the README afterward

`out/evidence.json` (written by step 7) holds the network, the contract account id, the transactions (label, hash and explorer link; `mock` is false) and the RPC view results (`nft_tokens` and the per-token `sheet_anchor` views). Check each hash resolves at `https://explorer.testnet.near.org/transactions/<hash>`.

Then, on a feature branch:

1. Replace the paragraph under `## Live on testnet` in `README.md` with the contract account id, the six explorer links and the view results copied from `out/evidence.json`. Keep it one paragraph. Never paste keys, `.env` contents or the keychain path.
2. Update the tests that pin the current "Not run yet" wording in the same PR:
   - `scripts/readme-facts.test.mjs` (the `Live on testnet` paragraph tests, which require a single paragraph starting `Not run yet.` and the evidence command),
   - `scripts/docs-facts.test.mjs`,
   - `scripts/live-readiness.test.mjs`,
   - and `scripts/live-runbook.live60.test.mjs`, which requires the README section to link this runbook.
3. In `docs/submission-checklist.md`, update the "Live testnet evidence section filled" row from `missing` to done, with the evidence, and re-check the rows that say nothing is deployed (the README Status and "Planned features not described as shipped" rows).
4. Run `bash scripts/verify.sh` and put its output in the PR's `## Proof` section.

`out/` is gitignored (`out/evidence.json` and `out/live-proof/txs.json` are both ignored), so `out/evidence.json` itself is not committed; quote its contents in the README.

## 5. Rollback

On-chain transactions cannot be undone. Options:

- Remove the contract and its tokens by deleting the contract account, naming the owner as beneficiary. The near-cli-rs form (from `.claude/skills/near-cli-rs/SKILL.md`) is `near account delete-account <ACCOUNT_ID> beneficiary <BENEFICIARY_ACCOUNT_ID> network-config testnet sign-with-keychain send`. This is signed by the contract account and permanently deletes it, its state and the tokens; the transactions stay in chain history. Check `near account delete-account --help` first. This runbook has not run it.
- Or leave the old contract alone and deploy fresh to a different, new contract account (a new `NEAR_CONTRACT_ACCOUNT_ID`), then run section 2 again.
- To undo the documentation, `git revert` the evidence PR. Nothing the scripts write under `out/` is tracked, so there is nothing else to revert.

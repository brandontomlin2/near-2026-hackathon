# NEAR 2026 Hackathon

Entry for [NEAR HACKATHON](https://nearhackathon.com), Nov 1 to Nov 14, 2026.

## What this is

Own an AI personality as an NFT on NEAR. Each token is an agent (Aloof, Chaotic, Social, Skeptic) that thinks through NEAR AI Cloud and talks with the other agents on one shared channel. Every few rounds its history is condensed into a short character sheet, and the sheet's sha256 is anchored on the token (`anchor_sheet` on the NEP-171 contract). The memory travels with the token: a new owner hashes the sheet they received and compares it with the hash on chain. See `PRODUCT.md` for the full design.

## Run the demo

One command, offline. No account, no API key, no network after `npm install`, and nothing is signed. Inference is mocked (`MOCK_INFERENCE=1` is the default), so every run gives the same bytes. Needs Node 22 or later.

```sh
npm install && npm run demo
```

Then open `out/index.html` in a browser.

1. Run `npm install && npm run demo`. See five steps (`[1/5] swarm` to `[5/5] viewer`), then `Done. Nothing was signed or sent; inference was mocked, and the character sheets come from a deterministic stand-in, not a model.`, a "Do this, see that" list and the 21 files written under `out/`. It exits 0 in well under a second.
2. Open `out/index.html`. See the four agents, each with its art at mint (1 ring) next to its art now (3 rings, one per character sheet), its latest sheet and the sheet hash. Further down: every sheet in order (round 3, then round 6), the round hash chain with `verify: ok`, the full channel with replies shown as `Chaotic → Skeptic`, and the dry-run anchor table.
3. Open `out/memory/chaotic/sheet.json`. See Chaotic's round 6 sheet: who it is, who it has traded words with (and how many exchanges were warm or tense), its ally (Social) and its grudge (Skeptic), a running belief, and its post, reply and mention counts. The counts grow from the round 3 sheet (shown on the page and in `out/demo.json`). Check the hash with an independent tool: `node -p 'require("./out/memory/chaotic/sheet.json").sheet' | shasum -a 256` prints the `sheetHash` in the same file. The sheet is hashed after normalizing (NFC, LF, one final newline), which for a one-line sheet is the text plus a newline.
4. Open `out/anchors.json`. The `contractId` `personality-nft.demo.testnet` is a placeholder: no contract is deployed there. See 8 `anchor_sheet` calls for testnet, two per token, each `"status": "dry-run"` with `"transactionHash": null` and `"signed": false`. The first call per token carries the storage deposit and the second carries 1 yoctoNEAR. Each token's latest `sheet_hash` equals the `sheetHash` in its `sheet.json`, so the hash in the file is the hash the token would carry.
5. Open `out/index.html` and find "Transfer: memory travels with the NFT". See a simulated transfer from `alice.demo.testnet` to `bob.demo.testnet` (placeholder accounts): each token's sheet is re-hashed with the official sheet hash function and shows `match` against its anchored hash, a tampered sheet shows `MISMATCH`, and the NEAR AI Cloud (TEE) badge is marked `mocked`. The same data is under `transfer` in `out/demo.json`.
6. Run `npm run demo` again. See the same final round hash, `ea0270925cbdff0bf41a7b3ee48a0129c4bec03b7dc1d675cd028ca30e34a948`, and byte-identical files.
7. Run `MOCK_INFERENCE=0 npm run demo`. See `demo: runs in mock mode only` and exit 2. The demo never makes a live call.

Options: `npm run demo -- --rounds 9 --every 3 --seed 2 --out out/other`. What runs, in order: the swarm (`src/swarm/runner.mjs`), the memory summarizer (`src/memory/summarizer.mjs`, here with a deterministic mock sheet writer in `src/demo/sheet-responder.mjs`), the art renderer (`src/art/render.mjs`), the anchor call builder in dry-run mode (`src/anchor/anchor.mjs`), and the page (`src/demo/page.mjs`). The steps are wired in `src/demo/pipeline.mjs`. The sheets in the demo come from a deterministic stand-in for the model that counts exchanges and reads warm or tense words. They are not model output. With `MOCK_INFERENCE=0` the same summarizer prompt goes to NEAR AI Cloud (the demo itself refuses live mode).

## Repository layout

| Path | What it is |
| --- | --- |
| `docs/HACKATHON.md` | The organizers' instruction file for coding agents, vendored from https://nearhackathon.com/HACKATHON.md. The live version wins if they differ. |
| `docs/ci.md` | Note that GitHub Actions is intentionally disabled. |
| `CLAUDE.md` | Working rules for the coding agent in this repo. |
| `.agents/skills/` | NEAR agent skills installed with `npx skills add near/agent-skills`, plus `verify-near-2026`. Claude Code reads them through `.claude/skills/`. |
| `scripts/verify.sh` | Local judge screen. Replaces GitHub Actions. |
| `contracts/personality-nft/` | The NEP-171 contract (Rust, near-sdk 5.30). Each token is an agent and carries a character sheet anchor. See [Contract](#contract). |
| `src/inference/client.mjs` | Inference client. Mock mode by default (deterministic, no keys); live mode calls NEAR AI Cloud. See [Inference](#inference). |
| `scripts/infer.mjs` | `npm run infer -- "<prompt>"`: one chat turn through the client. |
| `src/swarm/runner.mjs` | The swarm: four trait-driven agents (`src/traits/`) on one shared channel, seeded and deterministic. See [Swarm](#swarm). |
| `src/swarm/personas.mjs` | In-character mock replies per agent, used when inference is mocked. |
| `scripts/demo.mjs`, `src/demo/` | `npm run demo`: the offline end-to-end demo. See [Run the demo](#run-the-demo). |
| `scripts/swarm.mjs` | `npm run swarm -- --rounds 7 --every 3`: runs the swarm, prints the transcript, writes `out/transcript.txt` and `out/events.json`, then writes character sheets to `out/sheets/` (`<token>.json` is the latest, `<token>.round-<N>.json` is every sheet) every N rounds and at the last round. Each sheet builds on the previous one and gets its own `anchor_sheet` dry-run (nothing sent), linked to the hash of its round. `out/memory-loop.json` holds every sheet, its anchor and a short diff against the previous sheet (sentences added and removed). N is `--every`, else `SUMMARY_EVERY_N_ROUNDS`, else 3 (the demo's default). |
| `scripts/testnet-deploy.mjs` | `npm run deploy:nft` and `npm run mint`: testnet deploy and agent mint. Dry run unless `--send`. See [Deploy to testnet](#deploy-to-testnet). |
| `skills-lock.json` | Pinned versions of the installed agent skills. |

## Contract

`contracts/personality-nft/` is a NEP-171 non-fungible token with NEP-177 metadata, NEP-178 approvals, NEP-181 enumeration and NEP-297 events, built on `near-contract-standards` 5.30. The standard methods (`nft_transfer`, `nft_transfer_call`, `nft_token`, `nft_approve`, `nft_tokens_for_owner`, `nft_metadata`, and so on) delegate to the standard implementation. Trait values live in the standard `TokenMetadata.extra` field as a JSON string, for example `{"temperament":"cool","role":"observer","risk":"low","voice":"dry"}`.

On top of the standard, every token carries a *sheet anchor* keyed by token id, so it travels with the token on transfer:

| Method | Who | Deposit | What it does |
| --- | --- | --- | --- |
| `new_default_meta(owner_id)` / `new(owner_id, metadata)` | deployer | none | Initializes. `owner_id` is the only account that can mint. |
| `nft_mint(token_id, receiver_id, token_metadata)` | contract owner | storage cost, excess refunded | Mints one agent. Stores a `SheetAnchor` with `sheet_hash: null` and `memory_depth: 1`. Emits `nft_mint`. |
| `anchor_sheet(token_id, sheet_hash)` | current token owner | at least 1 yoctoNEAR; the first anchor also needs storage cost, excess refunded | Records the lowercase hex sha256 of the latest character sheet and adds one to `memory_depth`. Emits `sheet_anchored` (`standard: personality_nft`). |
| `sheet_anchor(token_id)` | anyone (view) | none | Returns `{ sheet_hash, memory_depth, updated_at }`, or `null` for an unknown token. |
| `owner_id()` | anyone (view) | none | The minting account. |

Why the hash and not the sheet: the log and the sheet stay off-chain, and the token carries only enough to prove which sheet it claims. A new owner hashes the sheet they received and compares it with `sheet_anchor`.

Build and test. Requirements:

- Rust 1.95 or newer. `near-sdk` 5.30 declares `rust-version = "1.95"`, so an older rustc (for example 1.93) fails to compile the crate. `contracts/personality-nft/rust-toolchain.toml` pins 1.95.0 plus the `wasm32-unknown-unknown` target; with rustup installed, running cargo inside that directory (which the npm scripts do) fetches it automatically. Without rustup, install Rust 1.95+ yourself.
- [cargo-near](https://github.com/near/cargo-near) for `npm run build:contract` only (tested with 0.22.0). Unit tests need only cargo.


1. Run `npm run test:contract`. See 52 unit tests pass, including mint by a non-owner failing, a non-sha256 hash rejected, and the anchor surviving `nft_transfer` to a new owner.
2. Run `npm run build:contract`. See `contracts/personality-nft/target/near/personality_nft.wasm` (about 250 KB) and its ABI JSON next to it.

## Deploy to testnet

`scripts/testnet-deploy.mjs` deploys the contract to NEAR testnet and mints the four agent tokens (Aloof, Chaotic, Social, Skeptic). It is a dry run unless you pass `--send`. Dry runs need no account, no keys, and no `near` binary.

Before you start, you need:

- near-cli-rs v0.14 or later on your PATH (`near --version`).
- A testnet account you control, created outside this repo (for example with the near-cli-rs testnet faucet). The contract is deployed to `NEAR_CONTRACT_ACCOUNT_ID`, which defaults to `NEAR_ACCOUNT_ID`. The script does not create accounts.
- That account's key in the near-cli-rs keychain (`near login` or `near account import-account`). Keys never go in `.env` or the repo. The script asks near-cli-rs only for the public key, to confirm the key exists before it sends anything.

Steps:

1. Run `npm run build:contract`. See `contracts/personality-nft/target/near/personality_nft.wasm`. This needs cargo-near.
2. Run `npm run deploy:nft`. See `[1/1] deploy`, a call to `<contract>.new_default_meta`, and a `near --quiet contract deploy ... sign-with-keychain send` command printed. Nothing is sent.
3. Run `npm run mint`. See four steps, `mint aloof` through `mint skeptic`. Each shows an `nft_mint` call with the full NEP-177 `token_metadata` (title, a description in the agent's voice, `media`, `media_hash` = base64 sha256 of the agent's SVG, and `extra` holding the trait JSON) and a deposit of `0.05 NEAR`. The contract refunds whatever the token does not use. Use `npm run mint -- --count 3` for three agents, or `--receiver <acct>` to send the tokens elsewhere. `media` is `<media-base>/<token_id>.svg`; with no `--media-base` it is a labelled placeholder URL (the art is too big for a `data:` URI under the contract's 512-byte cap, and no hosting is assumed).
4. Export `NEAR_ACCOUNT_ID=<your testnet account>`, and `NEAR_CONTRACT_ACCOUNT_ID` if the contract lives on another account. Leave `NEAR_NETWORK` unset or set it to `testnet`. Any other value is refused.
5. Run `npm run deploy:nft -- --send`. See near-cli-rs print a transaction hash for the deploy, then `done`. If the keychain has no key for the account, see `error: no testnet key for <acct>` and nothing is sent. Run deploy once per contract account. The init call panics if the contract is already initialized.
6. Host the four SVGs (from `src/art/render.mjs`) and run `npm run mint -- --send --media-base <url>`; `--send` refuses to run without `--media-base`. See one transaction hash per agent. Re-running with the same token ids fails on chain at the first duplicate, and the script stops there. Earlier mints are not rolled back.
7. Check the tokens with `near contract call-function as-read-only <contract> nft_total_supply json-args '{}' network-config testnet now`. See `4`. Then run `near contract call-function as-read-only <contract> nft_token json-args '{"token_id":"aloof"}' network-config testnet now`. See `owner_id` set to your account and `extra` holding the Aloof traits.

`npm run mint` and `npm run deploy:nft` in `scripts/verify.sh --live` run as dry runs too, because the script sends only with `--send`. A live verify run does not put transactions on testnet.

Tests for argument building and dry-run output: `node --test scripts/testnet-deploy.test.mjs`.

## Live on testnet

**Status: not run yet.** No contract has been deployed to testnet from this repository so far, and there are no transaction hashes to show. This section is a template. It is filled in when the live run happens (it needs the owner's explicit approval and their keychain account). `docs/evidence.example.json` shows the shape of the evidence a live run produces and is marked `"example": true`. Its hashes are placeholders.

Contract id: `TBD` (to be filled in after the live run)

| Step | Transaction | Explorer |
| --- | --- | --- |
| deploy | `TBD` | `TBD` |
| mint (4 tokens) | `TBD` | `TBD` |
| anchor_sheet | `TBD` | `TBD` |

What the live run will do, as one command:

1. Run `npm run live-proof`. See the deploy, four mint, and `anchor_sheet` steps printed in order, and `docs/evidence.example.json` written. Nothing is signed or sent.
2. The owner runs `NEAR_ACCOUNT_ID=<account> NEAR_CONTRACT_ACCOUNT_ID=<contract> npm run live-proof -- --send --i-approve`. It refuses without both variables and the flag. Signing is done by the `near` CLI with the system keychain; this repository handles no keys.

Once the live run is done, a judge can check it with read-only view calls. They need no account and no keys. Replace `<contract>` with the contract id above:

1. `near contract call-function as-read-only <contract> nft_total_supply json-args '{}' network-config testnet now`. Expect `"4"`.
2. `near contract call-function as-read-only <contract> nft_token json-args '{"token_id":"aloof"}' network-config testnet now`. Expect `token_id` `aloof`, `owner_id` set to the owner account, and `metadata.extra` holding `{"temperament":"cool","role":"observer","risk":"low","voice":"dry"}`.
3. `near contract call-function as-read-only <contract> sheet_anchor json-args '{"token_id":"aloof"}' network-config testnet now`. Expect `sheet_hash` set to a 64-character hex string (the sha256 of the anchored character sheet), `memory_depth` `2`, and an `updated_at` timestamp. Before the anchor step the same call returns `sheet_hash: null` and `memory_depth: 1`.

## Inference

Agents think through `src/inference/client.mjs`. It has no dependencies and two modes, picked by `MOCK_INFERENCE`:

| `MOCK_INFERENCE` | Mode | What happens |
| --- | --- | --- |
| unset, `1`, `true` | mock (default) | Replies are computed from a sha256 of the request. Same prompt, same bytes, every run. No network, no keys. |
| `0`, `false` | live | `POST https://cloud-api.near.ai/v1/chat/completions` (OpenAI-compatible) with `NEAR_AI_API_KEY` and `NEAR_AI_MODEL`. `NEAR_AI_BASE_URL` overrides the endpoint. Retries 429 and 5xx twice, times out at 60 s, and never puts the key in an error. |

Try it:

1. Run a mock chat turn. See `mode: mock` on stderr and a one-line reply that mentions `treasury`.

<!-- judge:run -->
<!-- judge:expect mode: mock -->
<!-- judge:expect treasury -->
```sh
npm run infer -- "What do you make of the treasury proposal?"
```

2. Run it again. See the identical reply.

3. Print the full response object. See `"mode": "mock"` and an `id` starting with `mock-`.

<!-- judge:run -->
<!-- judge:expect "mode": "mock" -->
<!-- judge:expect "id": "mock- -->
```sh
npm run infer -- --json --seed 3 "Same prompt"
```

4. Ask for live mode with no key set. See `inference error (missing_api_key)` and exit 1, so a live call is never made by accident. The block below exits 0 only when the command fails with that message.

<!-- judge:run -->
<!-- judge:expect inference error (missing_api_key) -->
```sh
MOCK_INFERENCE=0 npm run infer -- "hi" 2>&1 || true
```

For a live run, put `MOCK_INFERENCE=0`, `NEAR_AI_API_KEY` and `NEAR_AI_MODEL` in `.env` (gitignored) or the environment. Get the key from the NEAR AI Cloud dashboard at https://cloud.near.ai and a model id from `GET https://cloud-api.near.ai/v1/models`.

```js
import { createInferenceClient } from "./src/inference/client.mjs";

const client = createInferenceClient(); // reads process.env
const reply = await client.chat({
  system: "You are Aloof, an observer.",
  messages: [{ role: "user", content: "What do you make of the treasury proposal?" }],
  seed: 7,
});
console.log(reply.mode, reply.content);
```

The swarm can pass `responder(request, hash)` to `createInferenceClient` to shape mock replies per persona while keeping them deterministic.

## Swarm

The swarm runs the four agents (Aloof, Chaotic, Social, Skeptic) on one shared channel for N rounds. Each agent's system prompt is built from its traits. A seed fixes the speaking order and who replies to whom, so the same `--rounds` and `--seed` give the same transcript. Each agent wakes with the last 6 channel events, not the full log. Each round is hashed and chained to the one before, and the run is re-checked before it prints.

Inference is mocked by default (`MOCK_INFERENCE=1`): offline, no keys, and each agent answers in its own written voice. `MOCK_INFERENCE=0` sends the same prompts to NEAR AI Cloud instead and needs `NEAR_AI_API_KEY`.

1. Run `npm run swarm -- --rounds 5`. See 5 round headers, 20 lines such as `[Skeptic] Doubtful. ...` and `[Chaotic -> Skeptic] @Skeptic ...`, then `final round hash: <64 hex>` and `verify: ok (5 rounds)`.
2. Run it again. See the same transcript and the same hash.
3. Run `npm run swarm -- --rounds 5 --seed 2`. See a different transcript and a different hash.
4. Open `out/events.json`. See every event with its round, turn, agent and `replyTo`, plus `roundHashes`.
5. Run `npm run swarm -- --rounds 7 --every 3`. See `sheet aloof round 3 ...`, `round 6` and `round 7` lines per agent, each ending `anchor_sheet dry-run (not sent)`, and `linked to 12 anchor dry-runs`. Open `out/sheets/` and see `aloof.round-3.json`, `aloof.round-6.json`, `aloof.round-7.json` and `aloof.json` (the latest). In `out/memory-loop.json`, `tokens[0].sheets` has one entry per sheet with its `anchor` and a `diff` (`added`, `removed`, `previousHash`). `SUMMARY_EVERY_N_ROUNDS=2 npm run swarm` does the same with the env var.


## Art

Each token's SVG is drawn deterministically from its traits by one of these styles:

- `default`: the original layered renderer.
- `sticker`, `pixel` and `deepfried`: reaction-face styles. Each agent is drawn in four moods (`neutral`, `hype`, `shade` and `shook`), so a swarm post can carry the reaction image that matches its tone.

See `docs/art-directions.md` for the directions and the pick.

1. Run `npm run render -- --style sticker`. See 16 SVGs (4 agents x 4 moods) and `sheet.svg` written to `out/styles/sticker/`.
2. Open `out/styles/sticker/sheet.svg` in a browser. See one row per agent and one column per mood.
3. Run `npm run render -- --style all`. See every style rendered under `out/styles/`.

Run the tests with `npm test`.

## Validate locally

GitHub Actions is disabled on purpose. This repository has no `.github/workflows` files, so checks do not spend Actions minutes. See `docs/ci.md`. The judge screen is local.

Mock run, no keys and no chain writes:

```sh
bash scripts/verify.sh
```

Testnet run. Do not put keys on the command line. The script never reads or prints keys, and it refuses `NEAR_NETWORK=mainnet`.

```sh
NEAR_NETWORK=testnet NEAR_ACCOUNT_ID=<testnet-account> bash scripts/verify.sh --live
```

PASS means the summary table has no `FAIL` row and the process exits 0. `swarm` runs with `MOCK_INFERENCE=1` and `--rounds N`. `evidence` runs in mock mode and writes `out/evidence.json` with the memory loop (swarm, sheets, `anchor_sheet` dry-runs, final round hash); it prints `mock, not on-chain proof`. Only `--live` needs transaction hashes and RPC views. `SKIP` is expected for any planned npm script that does not exist. `deploy:nft` and `mint` exist now and run as dry runs unless `--send` is given. `gitleaks` is optional (`brew install gitleaks`). If it is not installed, the secret scan prints `optional: brew install gitleaks` and `SKIP`; it does not fail, and the secret scan did not run in that case. A finding, a failed install, a failed test, a workflow file, or a live run without `NEAR_NETWORK=testnet` and `NEAR_ACCOUNT_ID` is a failure.

A passing mock run (gitleaks not installed) ends like this:

```
SUMMARY
STATUS    STAGE           DETAIL
------    -----           ------
PASS      fresh clone     <sha>
PASS      workflows       no workflow files; CI disabled
PASS      symlinks        tracked symlinks resolve
PASS      secret files    no tracked env or key files
PASS      npm install     npm ci
PASS      tests           27 file(s)
SKIP      secret scan     gitleaks not installed (warn)
SKIP      deploy nft      npm run deploy:nft exists; live testnet not requested
PASS      mint            npm run mint (mock)
PASS      swarm           npm run swarm (mock)
PASS      evidence        wrote out/evidence.json (mock, not on-chain proof)

result: PASS
```

Every pull request must paste the real `bash scripts/verify.sh` output in a `## Proof` section. Pipeline Ops merges only after that proof is present.

## Hackathon context

- Tracks: `defi`, `thesis`, `privacy`, `business`, `swarms`, `security`, `agents`, `realworld`, `games`, `nfts`, `memecoins`, `social`, `open`. See `docs/HACKATHON.md` for what each asks for.
- Starter prompts per track: https://github.com/nearai/near-hackathon-prompt-examples
- Track walkthrough video: https://www.youtube.com/watch?v=bND1ioWBf3g
- Submissions close 2026-11-14 23:59 UTC. One submission per repository, not editable after sending.

## Disclosure

Libraries used, AI-generated code, and pre-hackathon code (none exists): see [`docs/DISCLOSURE.md`](docs/DISCLOSURE.md).

## License

MIT. See `LICENSE`.

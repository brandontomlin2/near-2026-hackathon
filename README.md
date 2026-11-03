# NEAR 2026 Hackathon

Entry for [NEAR HACKATHON](https://nearhackathon.com), Nov 1 to Nov 14, 2026.

## What this is

Track and product are not chosen yet. This section will describe the product, the problem it solves, and how NEAR fits in once building starts.

## Try it

Numbered "do X, see Y" steps for judges will go here.

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
| `scripts/swarm.mjs` | `npm run swarm -- --rounds 5`: runs the swarm, prints the transcript, writes `out/transcript.txt` and `out/events.json`, then writes a character sheet per token to `out/sheets/` and `anchor_sheet` dry-runs (nothing sent) linked to the final round hash in `out/memory-loop.json`. |
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

Why the hash and not the sheet: the log and the sheet stay off-chain, and the token carries only enough to prove which sheet it claims. A new owner hashes the sheet they received and compares it with `sheet_anchor`. The sheet hash is `hashSheet` in `src/anchor/hash.mjs`: sha256 of the sheet after Unicode NFC, LF line endings, no trailing spaces, no leading or trailing blank lines and one final newline.

Build and test (needs Rust; the crate pins rustc 1.95 through `rust-toolchain.toml`, and `cargo near build` needs [cargo-near](https://github.com/near/cargo-near)):

1. Run `npm run test:contract`. See 13 unit tests pass, including mint by a non-owner failing, a non-sha256 hash rejected, and the anchor surviving `nft_transfer` to a new owner.
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
3. Run `npm run mint`. See four steps, `mint aloof` through `mint skeptic`. Each shows an `nft_mint` call with `token_metadata.extra` holding the trait JSON and a deposit of `0.05 NEAR`. The contract refunds whatever the token does not use. Use `npm run mint -- --count 3` for three agents, or `--receiver <acct>` to send the tokens elsewhere.
4. Export `NEAR_ACCOUNT_ID=<your testnet account>`, and `NEAR_CONTRACT_ACCOUNT_ID` if the contract lives on another account. Leave `NEAR_NETWORK` unset or set it to `testnet`. Any other value is refused.
5. Run `npm run deploy:nft -- --send`. See near-cli-rs print a transaction hash for the deploy, then `done`. If the keychain has no key for the account, see `error: no testnet key for <acct>` and nothing is sent. Run deploy once per contract account. The init call panics if the contract is already initialized.
6. Run `npm run mint -- --send`. See one transaction hash per agent. Re-running with the same token ids fails on chain at the first duplicate, and the script stops there. Earlier mints are not rolled back.
7. Check the tokens with `near contract call-function as-read-only <contract> nft_total_supply json-args '{}' network-config testnet now`. See `4`. Then run `near contract call-function as-read-only <contract> nft_token json-args '{"token_id":"aloof"}' network-config testnet now`. See `owner_id` set to your account and `extra` holding the Aloof traits.

`npm run mint` and `npm run deploy:nft` in `scripts/verify.sh --live` run as dry runs too, because the script sends only with `--send`. A live verify run does not put transactions on testnet.

Tests for argument building and dry-run output: `node --test scripts/testnet-deploy.test.mjs`.

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

PASS means the summary table has no `FAIL` row and the process exits 0. `swarm` runs with `MOCK_INFERENCE=1` and `--rounds N`. `evidence` runs in mock mode and writes `out/evidence.json` with the memory loop (swarm, sheets, `anchor_sheet` dry-runs, final round hash); it prints `mock, not on-chain proof`. Only `--live` needs transaction hashes and RPC views. `SKIP` is expected for any planned npm script that does not exist. `deploy:nft` and `mint` exist now and run as dry runs unless `--send` is given. If `gitleaks` is not installed, the secret scan prints a warning and `SKIP`; it does not fail. A finding, a failed install, a failed test, a workflow file, or a live run without `NEAR_NETWORK=testnet` and `NEAR_ACCOUNT_ID` is a failure.

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

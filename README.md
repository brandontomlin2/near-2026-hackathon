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
| `src/inference/client.mjs` | Inference client. Mock mode by default (deterministic, no keys); live mode calls NEAR AI Cloud. See [Inference](#inference). |
| `scripts/infer.mjs` | `npm run infer -- "<prompt>"`: one chat turn through the client. |
| `skills-lock.json` | Pinned versions of the installed agent skills. |

## Inference

Agents think through `src/inference/client.mjs`. It has no dependencies and two modes, picked by `MOCK_INFERENCE`:

| `MOCK_INFERENCE` | Mode | What happens |
| --- | --- | --- |
| unset, `1`, `true` | mock (default) | Replies are computed from a sha256 of the request. Same prompt, same bytes, every run. No network, no keys. |
| `0`, `false` | live | `POST https://cloud-api.near.ai/v1/chat/completions` (OpenAI-compatible) with `NEAR_AI_API_KEY` and `NEAR_AI_MODEL`. `NEAR_AI_BASE_URL` overrides the endpoint. Retries 429 and 5xx twice, times out at 60 s, and never puts the key in an error. |

Try it:

1. Run `npm run infer -- "What do you make of the treasury proposal?"`. See `mode: mock` on stderr and a one-line reply that mentions `treasury`.
2. Run it again. See the identical reply.
3. Run `npm run infer -- --json --seed 3 "Same prompt"`. See the full response object with `"mode": "mock"` and an `id` starting with `mock-`.
4. Run `MOCK_INFERENCE=0 npm run infer -- "hi"` with no key set. See `inference error (missing_api_key)` and exit 1, so a live call is never made by accident.

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

PASS means the summary table has no `FAIL` row and the process exits 0. `SKIP` is expected until `package.json` and the planned npm scripts exist: `deploy:nft` (testnet deploy), `mint` (4 tokens), `swarm` (`MOCK_INFERENCE=1`, `--rounds N`), and `evidence` (`out/evidence.json` with transaction hashes and RPC views). If `gitleaks` is not installed, the secret scan prints a warning and `SKIP`; it does not fail. A finding, a failed install, a failed test, a workflow file, or a live run without `NEAR_NETWORK=testnet` and `NEAR_ACCOUNT_ID` is a failure.

A passing mock run before those scripts exist looks like this:

```
SUMMARY
STATUS    STAGE           DETAIL
------    -----           ------
PASS      fresh clone     <sha>
PASS      workflows       no workflow files; CI disabled
PASS      symlinks        tracked symlinks resolve
PASS      secret files    no tracked env or key files
SKIP      npm install     SKIP (not built yet)
SKIP      tests           no test files
SKIP      secret scan     gitleaks not installed (warn)
SKIP      deploy nft      SKIP (not built yet)
SKIP      mint            SKIP (not built yet)
SKIP      swarm           SKIP (not built yet)
SKIP      evidence        SKIP (not built yet)

result: PASS
```

Every pull request must paste the real `bash scripts/verify.sh` output in a `## Proof` section. Pipeline Ops merges only after that proof is present.

## Hackathon context

- Tracks: `defi`, `thesis`, `privacy`, `business`, `swarms`, `security`, `agents`, `realworld`, `games`, `nfts`, `memecoins`, `social`, `open`. See `docs/HACKATHON.md` for what each asks for.
- Starter prompts per track: https://github.com/nearai/near-hackathon-prompt-examples
- Track walkthrough video: https://www.youtube.com/watch?v=bND1ioWBf3g
- Submissions close 2026-11-14 23:59 UTC. One submission per repository, not editable after sending.

## License

MIT. See `LICENSE`.

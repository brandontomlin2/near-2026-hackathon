# NEAR 2026 Hackathon entry

This repository is an entry for NEAR HACKATHON (Nov 1 to Nov 14, 2026, UTC).

## Read first

- `docs/HACKATHON.md` is the organizers' instruction file for coding agents. Read it in full before building or submitting anything. The live version at https://nearhackathon.com/HACKATHON.md wins if the two differ; re-read it before submitting.
- Follow its "Never without the human's explicit confirmation" list exactly: no submission, no posting on X, no making the repo public, no pushing or force-pushing, no mainnet transactions, no committed secrets without an explicit yes from the human.

## Key dates (UTC)

| Event | When |
| --- | --- |
| Development ends, submissions close | 2026-11-14 23:59 |
| Judging | 2026-11-16 to 2026-11-18 |

## Working rules

- NEAR docs are found through https://docs.near.org/llms.txt and https://docs.near-intents.org/llms.txt. Look up contract addresses, RPC endpoints and SDK versions in the docs. Never guess them.
- Build on testnet first. Mainnet only where an integration is mainnet-only (for example NEAR Intents, which has no testnet; use tiny amounts and `dry: true` quotes).
- Keys and tokens live in `.env`, never in the repository or its history.
- The NEAR agent skills are installed under `.claude/skills/`. Use them for NEAR API, smart contract, dapp, Intents, NEAR Kit and NEAR AI Cloud work.
- The README is written for an AI judge as well as a human: what the product is, the problem it solves, how NEAR fits in, and numbered "do X, see Y" steps a judge can follow to try it. No marketing copy.

## Submission

Submission is one attempt per repository and cannot be edited. Before submitting, work through the checklist in `docs/HACKATHON.md` under "Procedure", collect every field listed under "What the human decides" from the human, print the full JSON payload, and send only after they confirm.

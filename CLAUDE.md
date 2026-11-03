# NEAR 2026 Hackathon entry

This repository is an entry for NEAR HACKATHON (Nov 1 to Nov 14, 2026, UTC).

## Read first

- `docs/HACKATHON.md` is the organizers' instruction file for coding agents. Read it in full before building or submitting anything. The live version at https://nearhackathon.com/HACKATHON.md wins if the two differ; re-read it before submitting.
- Follow its "Never without the human's explicit confirmation" list exactly. Without an explicit yes from the human, never:
  - Send the submission. Print the full JSON payload first and wait for a yes.
  - Post anything on X or another network on their behalf.
  - Make the repository public, push, or force-push.
  - Sign transactions, spend tokens or deploy to mainnet.
- Never commit secrets. Keys belong in environment variables, never in the repository or its history.
- Pushing in this repo: the human has authorized pushing feature branches and opening pull requests as part of the normal workflow below. Force-pushing and making the repository public still need an explicit yes each time.

## Key dates (UTC)

| Event | When |
| --- | --- |
| Development ends, submissions close | 2026-11-14 23:59 |
| Repository must be public by | 2026-11-14 23:59 |
| Judging starts | 2026-11-16 |
| Results announced by | 2026-11-18 23:59 |

## Working rules

- NEAR docs are found through https://docs.near.org/llms.txt and https://docs.near-intents.org/llms.txt. Look up contract addresses, RPC endpoints and SDK versions in the docs. Never guess them.
- Build on testnet first. Mainnet only where an integration is mainnet-only (for example NEAR Intents, which has no testnet), and every mainnet action still needs the human's explicit yes. Use separate dev accounts, tiny amounts and `dry: true` quotes.
- Keys and tokens live in `.env`, never in the repository or its history.
- The NEAR agent skills live under `.agents/skills/` and are symlinked into `.claude/skills/`. Use them for NEAR API, smart contract, dapp, Intents, NEAR Kit and NEAR AI Cloud work.
- The README is written for an AI judge as well as a human: what the product is, the problem it solves, how NEAR fits in, and numbered "do X, see Y" steps a judge can follow to try it. No marketing copy. It also lists libraries, templates and AI-generated code used (Q-005) and discloses any pre-hackathon code (Q-002, Q-003).

## Git workflow

Never commit directly to `main`. Work on `feat/`, `fix/`, `chore/` or `docs/` branches, open a pull request, have it reviewed, and squash-merge after review passes. Rebase on `main` before merging.

## Submission

Submission is one attempt per repository and cannot be edited. Before submitting, work through the checklist in `docs/HACKATHON.md` under "Procedure", collect every field listed under "What the human decides" from the human, print the full JSON payload, and send only after they confirm.

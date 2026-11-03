# Demo video script (2 minutes)

Goal: one complete moment, from a real action to a visible result. No slides, no architecture tour. The human records and narrates; this file is the shot list.

**Command status.** Commands marked **(exists)** run in this repo today. Commands marked **(PLANNED)** are described in `PRODUCT.md` and are not on `main` yet (no matching script in `package.json`). Before recording, re-check each one against `package.json` and update this file. If a planned command ships with different output, change the shot, not the product.

Run everything in mock mode (`MOCK_INFERENCE=1`, the default). No keys on screen. Do not show `.env`.

## Shot list

| # | Time | On screen | Command | Status |
| --- | --- | --- | --- | --- |
| 1 | 0:00 to 0:12 | Title card: name, one line. Then terminal. | none | n/a |
| 2 | 0:12 to 0:30 | Fresh clone, install. | `git clone <REPO_URL> && cd <repo> && npm install` | exists |
| 3 | 0:30 to 0:50 | Mint four agents. Mock mode prints four `nft_mint` calls (dry run). SVGs from `out/` are PLANNED. | `npm run mint` | exists (dry run; no SVGs yet) |
| 4 | 0:50 to 1:15 | Swarm runs 5 rounds. Transcript scrolls. | `npm run swarm -- --rounds 5` | PLANNED |
| 5 | 1:15 to 1:35 | Character sheets update. Show the before/after diff. | `npm run summarize` | PLANNED |
| 6 | 1:35 to 1:50 | Checks pass: round hashes, SVG determinism, memory files. | `bash scripts/verify.sh` (SVG determinism check PLANNED) | exists (partial) |
| 7 | 1:50 to 2:00 | Close: repo URL, one question. | none | n/a |

Fallback while the planned commands are missing, to show something real:

- `npm run infer -- "What do you make of the treasury proposal?"` (exists): one agent turn, mock mode, identical reply on a second run.
- `npm run test:contract` (exists, needs Rust): all contract tests pass, including the anchor surviving `nft_transfer`.
- `node scripts/viewer.mjs` (exists): writes a static HTML page of a 5-round mock run to `out/viewer/index.html`; prints `mode: mock`.
- `npm test` (exists): Node tests for scripts and `src/`; ends with `# fail 0`.
- `bash scripts/verify.sh` (exists): the judge screen, ends with `result: PASS`.

## Narration

Plain words. Read at a normal pace; about 230 words in total.

**Scene 1 (0:00 to 0:12)**
"When you move an AI character to a new app, it forgets who it was. We built an NFT that carries its character with it."

**Scene 2 (0:12 to 0:30)**
"This is a fresh clone. I run npm install. No account, no API key. Inference is in mock mode, so you get the same output I do."

**Scene 3 (0:30 to 0:50)**
"One command mints four agents: Aloof, Chaotic, Social and Skeptic. Each is an NFT on NEAR testnet. Each gets its own picture, drawn from its traits. The same traits always give the same image."

**Scene 4 (0:50 to 1:15)**
"Now the swarm. For five rounds the agents post and reply on one shared channel. Each turn is a call to NEAR AI Cloud. Here it is mocked, so it is repeatable. Watch Skeptic push back on Chaotic."

**Scene 5 (1:15 to 1:35)**
"After the rounds, each agent's log is summarized into a short character sheet. Here is the sheet before, and after. Allies and grudges have changed. The picture gains a ring for the extra memory."

**Scene 6 (1:35 to 1:50)**
"The hash of each sheet is stored on the token. So if the token is transferred, the new owner hashes the sheet they received and compares it with the chain. The verify command checks the round hashes, the pictures and the memory files."

**Scene 7 (1:50 to 2:00)**
"Code is public, link below. Built at NEAR HACKATHON. What would you want an agent like this to remember?"

## Recording notes

- Terminal font large enough to read at 720p. Light background or high contrast.
- Trim waiting time. Do not speed up output so much that it can't be read.
- If the video shows a live testnet run (not done yet), show transaction hashes only. Never show a key, a seed phrase or `.env`.
- Say "mock mode" out loud once. Do not imply a live NEAR AI call or on-chain write unless that run was really live.
- Do not claim the `privacy` track or any TEE attestation. `PRODUCT.md` says to leave it off until a check ships.
- Export a 60 to 90 second cut (scenes 3 to 6) for the X post.

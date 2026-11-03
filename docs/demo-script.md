# Demo video script (2 minutes)

Goal: one complete moment, from a real action to a visible result. No slides, no architecture tour. The human records and narrates; this file is the shot list.

**Command status.** Every shot uses `npm run demo`, which exists. It runs the whole product offline in one go: swarm, memory sheets, art, dry-run anchors, and the page at `out/index.html`. Before recording, run it once and check that the output still matches this file.

Run everything in mock mode (`MOCK_INFERENCE=1`, the default). No keys on screen. Do not show `.env`.

## Shot list

| # | Time | On screen | Command or file |
| --- | --- | --- | --- |
| 1 | 0:00 to 0:12 | Title card: name, one line. Then terminal. | none |
| 2 | 0:12 to 0:30 | Fresh clone, install, one command. The five `[n/5]` lines and "Nothing was signed or sent". | `git clone <REPO_URL> && cd <repo> && npm install && npm run demo` |
| 3 | 0:30 to 0:50 | Browser on `out/index.html`, Agents section. Sticker art at mint next to art now (it gains one star along the edge per sheet written: 1 at mint, 3 now); point at each agent's strip of four reaction faces. | `open out/index.html` |
| 4 | 0:50 to 1:15 | Scroll to Channel. Rounds scroll by with a reaction face beside each message; find a `Chaotic → Skeptic` exchange. Then the share cards grid. | page, Channel section |
| 5 | 1:15 to 1:35 | Scroll up to Memory (it sits above Channel on the page). Chaotic's round 3 sheet, then round 6: its fights with Skeptic went from 3 to 5, Social became its ride-or-die (1 to 3 warm moments), and its "Who I am" line escalated from chaos goblin to villain arc. | page, Memory section |
| 6 | 1:35 to 1:50 | Anchor (dry run) table, then the Round hash chain (above Channel) ending in `verify: ok`. Back in the terminal, run `npm run demo` again: same final hash. | page, then `npm run demo` |
| 7 | 1:50 to 2:00 | Close: repo URL, one question. | none |

Fallbacks if the browser is awkward on camera: `cat out/transcript.txt` for shot 4, `cat out/memory/chaotic/sheet.json` for shot 5, `cat out/anchors.json` for shot 6. `bash scripts/verify.sh` ends with `result: PASS` and runs the demo in a fresh clone.

## Narration

Plain words. Read at a normal pace; about 300 words in total.

**Scene 1 (0:00 to 0:12)**
"When you move an AI character to a new app, it forgets who it was. We built an NFT that carries its character with it."

**Scene 2 (0:12 to 0:30)**
"This is a fresh clone. I run npm install, then one command: npm run demo. No account, no API key. Inference is in mock mode, so you get the same output I do."

**Scene 3 (0:30 to 0:50)**
"Four agents: Aloof, Chaotic, Social and Skeptic. Each is an NFT on NEAR. Each gets its own picture, drawn from its traits. The same traits always give the same image. On the left is the picture at mint; on the right, now, after it has written its memory. Under each is a strip of four reaction faces: neutral, hype, shade and shook."

**Scene 4 (0:50 to 1:15)**
"Now the swarm. For six rounds the agents post and reply on one shared channel. Each turn is a call to NEAR AI Cloud. Here it is mocked and repeatable. Each message gets the reaction face that matches its tone, chosen by a text rule. Watch Skeptic push back on Chaotic, Social cheer for everyone, and Aloof and Skeptic each get caught off guard once. Every message also becomes a share card: face, quote, agent name."

**Scene 5 (1:15 to 1:35)**
"Every three rounds, each agent's log is summarized into a short character sheet. Here is Chaotic's sheet at round three, and at round six. The feud with Skeptic grew, Social became its ride-or-die, and chaos goblin became villain arc. The picture changes with each sheet."

**Scene 6 (1:35 to 1:50)**
"The hash of each sheet goes on the token. So if the token is transferred, the new owner hashes the sheet they received and compares it with the chain. Here the anchor call is prepared and shown, and never signed. Run it again: the same hash, byte for byte."

**Scene 7 (1:50 to 2:00)**
"Code is public, link below. Built at NEAR HACKATHON. What would you want an agent like this to remember?"

## Recording notes

- Terminal font large enough to read at 720p. Light background or high contrast.
- Trim waiting time. Do not speed up output so much that it can't be read.
- The demo never signs. If the video also shows a live testnet run, show transaction hashes only. Never show a key, a seed phrase or `.env`.
- Say "mock mode" out loud once. Do not imply a live NEAR AI call or on-chain write unless that run was really live.
- Do not claim the `privacy` track or any TEE attestation. `PRODUCT.md` says to leave it off until a check ships.
- Export a 60 to 90 second cut (scenes 3 to 6) for the X post.

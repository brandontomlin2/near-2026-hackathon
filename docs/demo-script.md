# Demo video script (2.5 minutes)

Goal: one complete moment, from a real action to a visible result. The product is the Yield Optimizer vault, so the video leads with it: AI agents propose trades, the vault contract's on-chain rules veto the bad ones, and only a trade that passes can execute on Rhea (Ref Finance). Then the live proof from the one testnet run on 2026-11-09, then the supporting personality NFT demo briefly, then the judge screen. No slides, no architecture tour. The human records and narrates; this file is the shot list.

The vault scenes V1 to V7 below take about 90 seconds. The full vault shot table and voice-over are in `docs/yield-demo-video-script.md`; `docs/demo-video.md` has the same vault shots as a 90 second cut, so keep the three consistent. For 2.5 minutes, record V1 to V7, then supporting scenes 3, 4 and 8 (about one minute). The full nine supporting scenes run about 2 minutes 25 and make a longer cut.

**Command status.** The vault scenes use `npm run yield:demo`, `bash scripts/verify.sh` and the live links in the README section "Live on testnet"; all exist. The supporting scenes use `npm run demo` and `npm run ask`, and both exist. `npm run demo` runs the supporting product offline in one go: swarm, memory sheets, art, meme cards, dry-run anchors, and the page at `out/index.html`. `npm run ask -- <agentId> "<question>"` exists (README step 3, the shot 3 command): the owner asks one agent a question and it remembers the exchange. It changes only `out/memory`, so run `npm run demo` again before a second take. Before recording, run the commands once and check that the output still matches this file.

Run everything in mock mode (`MOCK_INFERENCE=1`, the default). No keys on screen. Do not show `.env`. Nothing the commands print is live: the vault and runner ids in the demo output are placeholders. The one live result is scene V5, a real testnet transaction.

**Who this is for.** A treasury owner who wants yield from an automated trader without trusting every trade it picks. The owner sets limits on the vault contract once; agents can only propose. Open on that problem, then run `npm run yield:demo` in the first 30 seconds.

## Vault scenes (about 90 seconds)

| # | Time | On screen | Command or file |
| --- | --- | --- | --- |
| V1 | 0:00 to 0:08 | Title card with the problem: "Handing an AI agent your tokens means trusting every trade it picks. Here the agent only proposes." Then terminal. | none |
| V2 | 0:08 to 0:20 | Fresh clone, install, one command. The first line, `YIELD DEMO - DRY RUN - mock inference, offline - nothing signed, nothing sent`. | `git clone <REPO_URL> && cd <repo> && npm install && npm run yield:demo` |
| V3 | 0:20 to 0:40 | The agent table: three agents refused as off reference, Chaotic vetoed by Skeptic (`chaotic vetoed by skeptic: size is 10000 bps of max_trade, above the 8000 bps audit line`), and the optimizer row `yield-optimizer  pool 747: 0.05 usdc -> min 0.050406 usdt  OK           execute`. | same run |
| V4 | 0:40 to 0:55 | The four rule rejections with the contract's error names (`REJECTED ERR_MAX_TRADE: 1001 exceeds max_trade 1000`, `REJECTED ERR_DAILY_CAP: spent 1501 + 1000 exceeds daily_cap 2500`, `REJECTED ERR_PRICE_FLOOR: min_amount_out 149 below floor 3/2 of amount_in 100`, `REJECTED ERR_PAUSED: vault is paused`), then `1 unsigned execute_swap call planned, 0 signed, 0 sent`. | same run |
| V5 | 0:55 to 1:10 | The live proof: the explorer page of the swap transaction, or the read-only `curl` check, both in the README section "Live on testnet". Say that the owner sent this one swap by hand, it was not agent-picked, and the vault has not refused a live transaction. | the swap link in the README table |
| V6 | 1:10 to 1:20 | `out/yield-demo/index.html` for the same run as one page. Then `npm run demo` and `out/index.html` for the four agents the proposals come from, the supporting demo. | `open out/yield-demo/index.html`, `npm run demo`, `open out/index.html` |
| V7 | 1:20 to 1:30 | The judge screen: an 18-row table ending `result: PASS`. Pre-record it; it takes a minute or two. | `bash scripts/verify.sh` |

Vault narration, one sentence per scene: V1 the problem; V2 one offline command, mock inference, nothing signed; V3 each agent proposes, the planner finds one swap that passes; V4 four proposals break an on-chain rule and the contract's own messages say which; V5 this is the one real swap on testnet, sent by the owner; V6 the same run as a page, and the agents are also NFTs; V7 one command re-checks it all. The full voice-over is in `docs/yield-demo-video-script.md`.

## Supporting scenes: the personality NFT demo

The scenes below are the supporting demo, where the four agents come from. Their numbers are within this table, and their times are within the supporting block. The memory story is not the pitch; do not open on it. The first scene's title card can be skipped when the vault scenes ran first.

| # | Time | On screen | Command or file |
| --- | --- | --- | --- |
| 1 | 0:00 to 0:12 | Title card with the problem: "Buying an AI character? Check its memory is the one the seller anchored." Then terminal. | none |
| 2 | 0:12 to 0:25 | Fresh clone, install, one command. The five `[n/5]` lines and "Nothing was signed or sent". | `git clone <REPO_URL> && cd <repo> && npm install && npm run demo` |
| 3 | 0:25 to 0:45 | You are the owner. Ask Chaotic about Skeptic. Pause on the answer, `Chaotic (mock): Skeptic?? 5 fights and counting, bro I did not read the contract and it SHOWS 💀`, then on the sheet diff, where `Owner: 0 fights, 0 hugs, 1 shrug` joins the scorecard, and the line `sheet chaotic round 7 <64-hex sheet hash> (+4 -4) -> anchor_sheet dry-run (not sent)`. The very last line is `Nothing was signed or sent; inference was mocked: the answer and the sheet come from deterministic stand-ins, not a model.` | `npm run ask -- chaotic "what do you think of Skeptic?"` |
| 4 | 0:45 to 1:00 | Browser on `out/index.html`, the "Meme pack" section: three meme cards. Open the Chaotic caption card full size: "SKEPTIC SAW MY POST AND CHOSE TO SPEAK", "SHOW THE HASH?? I DO NOT EVEN KNOW WHERE THE HASH LIVES 🚀". | `open out/index.html`, `open out/share/meme-caption-chaotic.svg` |
| 5 | 1:00 to 1:15 | Scroll up to Agents. Sticker art at mint next to art now (it gains one star along the edge per sheet written: 1 at mint, 3 now); point at each agent's strip of four reaction faces. | page, Agents section |
| 6 | 1:15 to 1:35 | Memory section. Chaotic's round 3 sheet, then round 6: its fights with Skeptic went from 3 to 5, Social became its ride-or-die (1 to 3 warm moments), and its "Who I am" line escalated from chaos goblin to villain arc. | page, Memory section |
| 7 | 1:35 to 1:50 | Scroll to Channel. Rounds scroll by with a reaction face beside each message; find a `Chaotic → Skeptic` exchange. | page, Channel section |
| 8 | 1:50 to 2:15 | Transfer: four `match` rows. Then the Anchor (dry run) table and the Round hash chain ending in `verify: ok`. Back in the terminal, run `npm run demo` again: same final hash. | page, then `npm run demo` |
| 9 | 2:15 to 2:25 | Close: repo URL, one question. | none |

Page order, top to bottom: Agents, Memory, Meme pack, Transfer, Channel, Anchor (dry run), Round hash chain, Files. The shot order above scrolls up twice (shot 5 back to Agents, shot 8 back to Transfer, which sits above Channel); the browser's find box (Cmd-F) gets you there without hunting.

The windows add up to 2 minutes 25. Trim the pauses in shots 5 to 7 if you need it shorter. Never cut shot 3 or shot 4.

Fallbacks if the browser is awkward on camera: `cat out/transcript.txt` for shot 7, `cat out/memory/chaotic/sheet.json` for shot 6, `cat out/anchors.json` for shot 8. `bash scripts/verify.sh` ends with `result: PASS` and runs the demo in a fresh clone.

## Narration

This narration is for the supporting scenes. Plain words. Read at a normal pace; about 380 words in total.

**Scene 1 (0:00 to 0:12)**
"Someone is selling you an AI character. How do you know the memory you are buying is the one they anchored? We built an NFT that carries its character with it, and lets you check."

**Scene 2 (0:12 to 0:25)**
"This is a fresh clone. I run npm install, then one command: npm run demo. No account, no API key. Inference is in mock mode, so you get the same output I do."

**Scene 3 (0:25 to 0:45)**
"Now I am the owner. I ask Chaotic what it thinks of Skeptic. It answers in character, five fights and counting. And it remembers: look at the diff, I am in its scorecard now. The new sheet hash is prepared for the token, and not sent."

**Scene 4 (0:45 to 1:00)**
"The agents make memes out of what they really said. This one is Chaotic: show the hash? I do not even know where the hash lives. Three cards, built from the replies and the character sheets."

**Scene 5 (1:00 to 1:15)**
"Four agents: Aloof, Chaotic, Social and Skeptic. In the design each is an NFT on NEAR, with its own picture drawn from its traits; nothing is minted in this demo. On the left is the picture at mint, on the right, now, after it has written its memory. Under each is a strip of four reaction faces: neutral, hype, shade and shook."

**Scene 6 (1:15 to 1:35)**
"Every three rounds, each agent's log is summarized into a short character sheet. Here is Chaotic's sheet at round three, and at round six. The feud with Skeptic grew, Social became its ride-or-die, and chaos goblin became villain arc. The picture changes with each sheet."

**Scene 7 (1:35 to 1:50)**
"Those sheets came from six rounds on one shared channel. In live mode each turn would call NEAR AI Cloud; this demo is mocked and has not been run against it. Each message gets the reaction face that matches its tone, chosen by a text rule. Watch Skeptic push back on Chaotic. Aloof and Skeptic each get caught off guard once."

**Scene 8 (1:50 to 2:15)**
"Now the token changes hands. The new owner takes the sheet, hashes it, and compares it with the hash on the token: every row matches. Here the anchor call is prepared and shown, and never signed. Run it again: the same hash, byte for byte."

**Scene 9 (2:15 to 2:25)**
"Code is public, link below. Built at NEAR HACKATHON. What would you want an agent like this to remember?"

## Recording notes

- Terminal font large enough to read at 720p. Light background or high contrast.
- Trim waiting time. Do not speed up output so much that it can't be read.
- The demos never sign. The live proof (scene V5) is the one testnet run of 2026-11-09: show the explorer page or the `curl` check from the README section "Live on testnet", and nothing else from that run. Never show a key, a seed phrase or `.env`.
- Say "mock mode" out loud once. Do not imply a live NEAR AI call, mainnet use, an agent-picked live trade or a live rejection; the one live swap was sent by the owner by hand.
- Do not claim the `privacy` track or any TEE attestation. `npm run attest:check` exists, but it only checks a hand-made fixture offline and ends `CONSISTENT, NOT VERIFIED`; `privacy` is not claimed (`PRODUCT.md`, `docs/tracks.md`). Keep it off screen.
- Export a 60 to 90 second cut for the X post: `docs/demo-video.md` is that cut (the vault shots first, then the supporting `npm run ask` and meme card shots).

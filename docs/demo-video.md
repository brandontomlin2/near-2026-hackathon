# Demo video shot list (60 to 90 seconds) and screenshot fallback

For the public X post (`docs/HACKATHON.md`: attach a demo video or screenshots). The human records it. This is the short cut of `docs/demo-script.md` (the 2.5 minute version). It leads with the user's problem and the owner asking an agent a question (`npm run ask`), then shows the three meme cards and the transfer + re-hash panel.

**Everything here is MOCK.** Inference is mocked, the character sheets come from a deterministic stand-in (not a model), the accounts (`alice.demo.testnet`, `bob.demo.testnet`) and the contract id are placeholders, and nothing is signed, sent or deployed. Every hash on screen is a MOCK hash. Say "mock mode" out loud once, and keep the caption in beat 1 on screen. Do not show `.env`, keys or a wallet. Do not claim a live NEAR AI call, an on-chain write, TEE attestation or the `privacy` track.

All commands below were run on the committed tree and the output lines pasted here are real; `scripts/docs-facts.test.mjs` re-checks the hashes and quoted lines against a fresh `npm run demo`, so if that test passes this file is current. The project has no npm dependencies, so `npm install` finishes at once. Needs Node 22 or newer.

## Before you record

1. Fresh clone in an empty folder, terminal font large enough for 720p, high contrast.
2. Run the commands once off camera, so you know the output matches the table below. If a hash differs, re-read the terminal, not this file: the hashes here are for the defaults (`--rounds 6 --seed 1 --every 3`).
3. Have a browser window ready for `out/index.html` and for `out/share/meme-caption-chaotic.svg`.
4. Shot 3 runs `npm run ask`, which rewrites `out/memory/chaotic/` (only that; the page and the hashes in the table below do not change). To record a second take, run `npm run demo` first: it starts the memory over.

## Shot list (about 90 seconds)

| # | Time | Show on screen | Command (from the repo root) | Key output to point at | Caption (on screen) |
| --- | --- | --- | --- | --- | --- |
| 1 | 0:00 to 0:08 | Title card with the problem, then an empty terminal. | `git clone <REPO_URL> && cd <repo> && npm install` | none | "Buying an AI character? Check the memory is the one the seller anchored. MOCK MODE: no keys, no network, nothing signed. Hashes are MOCK." |
| 2 | 0:08 to 0:16 | Terminal. One command runs the whole product. | `npm run demo` | `[1/5] swarm: 6 rounds, 24 events, verify: ok` ... `[4/5] anchor (dry run): 8 calls prepared, 0 signed` ... `Done. Nothing was signed or sent; inference was mocked, and the character sheets come from a deterministic stand-in, not a model.` | "4 AI agents, 4 NFTs, 1 command" |
| 3 | 0:16 to 0:30 | Terminal. You are the owner: ask Chaotic what it thinks of Skeptic. Pause on the answer, then on the sheet diff. | `npm run ask -- chaotic "what do you think of Skeptic?"` | `Chaotic (mock): Skeptic?? 5 fights and counting, bro I did not read the contract and it SHOWS 💀`, then the diff line `+ Scorecard: ... Owner: 0 fights, 0 hugs, 1 shrug`, and last `(+4 -4) -> anchor_sheet dry-run (not sent)`. | "You asked. It remembered. You are now in its memory (MOCK)." |
| 4 | 0:30 to 0:42 | Browser: `out/index.html`, the "Meme pack" section (it sits right after Memory). Then each card full size. | `open out/index.html`, then `open out/share/meme-caption-chaotic.svg` (also `meme-caption-skeptic.svg`, `meme-villain-chaotic.svg`) | Three cards. Start on the Chaotic caption card: "SKEPTIC SAW MY POST AND CHOSE TO SPEAK" over its face, "SHOW THE HASH?? I DO NOT EVEN KNOW WHERE THE HASH LIVES 🚀" below. Then "4TH REPLY FROM CHAOTIC AND I AM OUT OF FACES". | "Meme pack: made from what the agents actually said" |
| 5 | 0:42 to 0:50 | Scroll up to Agents. Art at mint next to art now. Point at the extra stars along the edges (1 at mint, 3 now: one per memory depth). | page, Agents section | Four agents, two pictures each ("at mint", "now"). | "Each token draws itself from its traits. A star for every memory." |
| 6 | 0:50 to 1:00 | Scroll to Channel. Stop on a `Chaotic → Skeptic` line (the page shows an arrow; `out/transcript.txt` writes it as `->`). | page, Channel section | `[Chaotic -> Skeptic] @Skeptic receipts?? bro I AM the receipts 💀` (round 1, as written in `out/transcript.txt`) | "One shared channel. Mocked replies, same every run." |
| 7 | 1:00 to 1:15 | Scroll to "Transfer: memory travels with the NFT". Four rows, each `match`. Then "Tampered sheet": the edited sheet, then the bold `MISMATCH`. | page, Transfer section, then "Tampered sheet" | `alice.demo.testnet` sends every token to `bob.demo.testnet`. Anchored hash and re-hashed hash are identical, Result `match`. Aloof: `c2273f6a921b50d7dc941eac68948e084d7189524df1180c005ff696c765d78a` (MOCK). Tampered: anchored `c2273f6a...d78a` against re-hashed `83e5fd011487275c6829aefa5b7abcf239587ebdc8bbada684d16ee5d1d6fa71`, result `MISMATCH`. | "A buyer re-hashes the memory and checks it against the token. Edit one word and it no longer matches." |
| 8 | 1:15 to 1:25 | Terminal: check one hash by hand, then run the demo again and show the same final hash. | `node -p 'require("./out/memory/aloof/sheet.json").sheet' \| shasum -a 256`, then `node -p 'require("./out/memory/aloof/sheet.json").sheetHash'`, then `npm run demo \| grep 4c8e82` | Both hash lines print `c2273f6a921b50d7dc941eac68948e084d7189524df1180c005ff696c765d78a`. The printed line (step 6 of the "Do this, see that" list) ends with `4c8e826620ce2fa1c118df19d13f622ade870b0a54dd206e2c93157df9c6ff52.` (final round hash, MOCK, the same as in the page's Round hash chain). | "Same input, same hash, byte for byte (MOCK)" |
| 9 | 1:25 to 1:30 | End card: repo URL, `#NEARHackathon`, one question. | none | none | "Built at NEAR HACKATHON. What should an agent remember?" |

Notes on timing: shots 2 and 8 print in well under a second, so most of that time is you talking. If you run long, drop shot 6 or shot 5 first, never shot 3 or shot 4. Shots 3 to 7 alone are about 60 seconds, which is the floor.

Shot 8 uses `grep` on purpose: the demo prints a lot, and the grep keeps the screen to one readable line. The `Done.` list in the full output also shows the same hash in step 6. Running `npm run demo` again also starts the memory over, so the `Owner` line from shot 3 is gone afterwards.

## Narration (about 215 words)

1. "Someone is selling you an AI character. How do you know the memory you are buying is the one they anchored? Everything you will see is in mock mode: no keys, no network, nothing signed."
2. "Fresh clone, one command. Four agents run six rounds on a shared channel, memory sheets get written, and the anchor calls are prepared, never sent."
3. "Now you are the owner. Ask Chaotic what it thinks of Skeptic. It answers in character, and it remembers: you are in its scorecard now, and the new sheet hash is prepared for the token."
4. "The agents also make memes, from what they really said. Chaotic: show the hash? I do not even know where the hash lives."
5. "Each agent is a token, with a picture drawn from its traits. A star for each memory it has written."
6. "Here Skeptic and Chaotic argue. The replies are mocked, so you get exactly what I get."
7. "Now the token changes hands. The new owner takes the memory, hashes it, and compares it with the hash on the token. It matches. Change one word and it does not."
8. "Check it yourself: the hash by hand, the same one the page shows. Run the demo again and the final hash is identical."
9. "Code is public, link below. Built at NEAR HACKATHON. What should an agent remember?"

## Screenshot checklist (fallback if no video)

Take them from the fresh-clone run above, in this order. The first four are the minimum for the X post; lead the post with the meme card (row 3). X shows up to four images per post.

| # | What | How to open it | Size and crop | Must be visible |
| --- | --- | --- | --- | --- |
| 1 | Terminal after `npm run demo` | Run `npm run demo` | Window about 1280 x 720, font 16 to 18 pt. Crop to the five `[n/5]` lines and the `Done.` line. | `[1/5] swarm ... verify: ok` to `[5/5] viewer: out/index.html`, and "Nothing was signed or sent". |
| 2 | Agents: art at mint and now | `open out/index.html`, Agents section | Browser window 1280 x 720 at 100% zoom (the page content is 980 px wide). | The four agent cards with both pictures each, and the banner "Mock mode, dry run: inference is mocked and nothing is signed, sent or deployed." |
| 3 | Meme card | `open out/share/meme-caption-chaotic.svg` (the page's "Meme pack" section shows all three) | The cards are 900 x 900 squares. Capture it square, whole image. | "SKEPTIC SAW MY POST AND CHOSE TO SPEAK" over the face, "SHOW THE HASH?? I DO NOT EVEN KNOW WHERE THE HASH LIVES 🚀" below. |
| 4 | Transfer + re-hash panel | `open out/index.html`, Transfer section | 1280 x 720. Include the heading, the `alice`/`bob` line and the four `match` rows. | "Transfer: memory travels with the NFT", four `match` rows. |
| 5 | Tampered sheet | Same page, "Tampered sheet" | 1280 x 720. | The `MISMATCH` row. |
| 6 | Channel exchange | Same page, Channel section | 1280 x 720, crop to a few lines around a `Chaotic -> Skeptic` message. | The `[Chaotic -> Skeptic]` style line, or the same line in `out/transcript.txt`. |
| 7 | Judge screen | `bash scripts/verify.sh` | Crop to the last lines. | `result: PASS`. Run it before shooting and only shoot if it passes. |
| 8 | Owner asks (optional) | `npm run ask -- chaotic "what do you think of Skeptic?"` | Crop to the answer line and the `Owner: 0 fights, 0 hugs, 1 shrug` diff line. | `Chaotic (mock): Skeptic?? 5 fights and counting`. |
| 9 | Sticker mood sheet (optional) | `npm run render -- --style sticker`, `open out/styles/sticker/sheet.svg` | The sheet is a 1064 x 1064 square. Capture it square, whole image. Optionally repeat for `--style pixel` or `deepfried` (`npm run render -- --style all`). | The 4 x 4 grid of faces. Terminal lists 16 SVGs plus `sheet.svg` under `out/styles/sticker/`. |

Every screenshot should show the word MOCK somewhere: add it in the post text or as an overlay on the image, because the page itself says "mock" only in its banner, the `MOCK_INFERENCE=0` note in the Memory section, and the "mock placeholder" labels and `mocked` "Inference (NEAR AI Cloud)" badge in the Transfer section. Put the alt text "Mock-mode demo, hashes are MOCK" on each image.

## What not to show

- `.env`, keys, seed phrases, wallet windows, the `near` CLI.
- Any claim of a live testnet run, unless a real live run happened and you show its transaction hashes only.
- The placeholder contract id as if it were deployed.

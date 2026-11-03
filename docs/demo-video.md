# Demo video shot list (60 to 90 seconds) and screenshot fallback

For the public X post (`docs/HACKATHON.md`: attach a demo video or screenshots). The human records it. This is the short cut of `docs/demo-script.md` (the 2 minute version), plus the meme share cards and the transfer + re-hash panel.

**Everything here is MOCK.** Inference is mocked, the character sheets come from a deterministic stand-in (not a model), the accounts (`alice.demo.testnet`, `bob.demo.testnet`) and the contract id are placeholders, and nothing is signed, sent or deployed. Every hash on screen is a MOCK hash. Say "mock mode" out loud once, and keep the caption in beat 1 on screen. Do not show `.env`, keys or a wallet. Do not claim a live NEAR AI call, an on-chain write, TEE attestation or the `privacy` track.

All commands below were run on the committed tree and the output lines pasted here are real; `scripts/docs-facts.test.mjs` re-checks the hashes and quoted lines against a fresh `npm run demo`, so if that test passes this file is current. The project has no npm dependencies, so `npm install` finishes at once. Needs Node 22 or newer.

## Before you record

1. Fresh clone in an empty folder, terminal font large enough for 720p, high contrast.
2. Run the commands once off camera, so you know the output matches the table below. If a hash differs, re-read the terminal, not this file: the hashes here are for the defaults (`--rounds 6 --seed 1 --every 3`).
3. Have a browser window ready for `out/index.html` and for `out/styles/sticker/sheet.svg`.

## Shot list (about 85 seconds)

| # | Time | Show on screen | Command (from the repo root) | Key output to point at | Caption (on screen) |
| --- | --- | --- | --- | --- | --- |
| 1 | 0:00 to 0:08 | Title card, then an empty terminal. | `git clone <REPO_URL> && cd <repo> && npm install` | none | "MOCK MODE: no keys, no network, nothing signed. Hashes are MOCK." |
| 2 | 0:08 to 0:20 | Terminal. One command runs the whole product. | `npm run demo` | `[1/5] swarm: 6 rounds, 24 events, verify: ok` ... `[4/5] anchor (dry run): 8 calls prepared, 0 signed` ... `Done. Nothing was signed or sent; inference was mocked, and the character sheets come from a deterministic stand-in, not a model.` | "4 AI agents, 4 NFTs, 1 command" |
| 3 | 0:20 to 0:32 | Browser: `out/index.html`, Agents section. Art at mint next to art now. Point at the extra stars along the edges (1 at mint, 3 now: one per memory depth). | `open out/index.html` | Four agents, two pictures each ("at mint", "now"). | "Each token draws itself from its traits. A star for every memory." |
| 4 | 0:32 to 0:42 | Scroll to Channel. Stop on a `Chaotic → Skeptic` line (the page shows an arrow; `out/transcript.txt` writes it as `->`). | page, Channel section | `[Chaotic -> Skeptic] @Skeptic receipts?? bro I AM the receipts 💀` (round 1, as written in `out/transcript.txt`) | "One shared channel. Mocked replies, same every run." |
| 5 | 0:42 to 0:50 | Meme share cards: the sticker contact sheet (4 agents x 4 moods). | `npm run render -- --style sticker`, then `open out/styles/sticker/sheet.svg` | Terminal lists 16 SVGs plus `sheet.svg` under `out/styles/sticker/`. The sheet is a 4 by 4 grid, rows = agents, columns = moods (neutral, hype, shade, shook). | "Meme share cards: one face per mood" |
| 6 | 0:50 to 1:05 | Browser back on `out/index.html`. Scroll to "Transfer: memory travels with the NFT". Four rows, each `match`. | page, Transfer section | `alice.demo.testnet` sends every token to `bob.demo.testnet`. Anchored hash and re-hashed hash are identical, Result `match`. Aloof: `685c3c71764322636ddf22dc0463afd6dda0dacf3ef5ea5591772d028d92d355` (MOCK). | "Owner changes. The new owner re-hashes the memory and checks it against the token." |
| 7 | 1:05 to 1:13 | Scroll to "Tampered sheet". The edited sheet, then the bold `MISMATCH`. | page, "Tampered sheet" | Anchored `685c3c71...d355` against re-hashed `3cc8bc4a2320990d06b75b0723b1a5d099254a5ffeb4c4e83b1ee3ac20b48372`, result `MISMATCH`. | "Edit one word in the memory and the hash no longer matches." |
| 8 | 1:13 to 1:23 | Terminal: check one hash by hand, then run the demo again and show the same final hash. | `node -p 'require("./out/memory/aloof/sheet.json").sheet' \| shasum -a 256`, then `node -p 'require("./out/memory/aloof/sheet.json").sheetHash'`, then `npm run demo \| grep 3dd144` | Both hash lines print `685c3c71764322636ddf22dc0463afd6dda0dacf3ef5ea5591772d028d92d355`. The printed line (step 6 of the "Do this, see that" list) ends with `3dd1440b3ee005665ee0674dcf25e462d29b458b5fbc37a8795243960d05cc6f.` (final round hash, MOCK, the same as in the page's Round hash chain). | "Same input, same hash, byte for byte (MOCK)" |
| 9 | 1:23 to 1:30 | End card: repo URL, `#NEARHackathon`, one question. | none | none | "Built at NEAR HACKATHON. What should an agent remember?" |

Notes on timing: shots 2 and 8 print in well under a second, so most of that time is you talking. If you run long, drop shot 4 or shot 5 first. Shots 3 to 7 alone are about 60 seconds, which is the floor.

Shot 8 uses `grep` on purpose: the demo prints a lot, and the grep keeps the screen to one readable line. The `Done.` list in the full output also shows the same hash in step 6.

## Narration (about 180 words)

1. "When you move an AI character to a new app, it forgets who it was. These NFTs carry their character with them. Everything you will see is in mock mode: no keys, no network, nothing signed."
2. "Fresh clone, one command. Four agents run six rounds on a shared channel, memory sheets get written, and the anchor calls are prepared, never sent."
3. "Each agent is a token, with a picture drawn from its traits. A star for each memory it has written."
4. "Here Skeptic and Chaotic argue. The replies are mocked, so you get exactly what I get."
5. "Same art engine, meme mode: a share card for every mood."
6. "Now the token changes hands. The new owner takes the memory, hashes it, and compares it with the hash on the token. It matches."
7. "Change one word in the memory and the hash no longer matches."
8. "Check it yourself: the hash by hand, the same one the page shows. Run the demo again and the final hash is identical."
9. "Code is public, link below. Built at NEAR HACKATHON. What should an agent remember?"

## Screenshot checklist (fallback if no video)

Take them from the fresh-clone run above, in this order. The first four are the minimum for the X post. X shows up to four images per post.

| # | What | How to open it | Size and crop | Must be visible |
| --- | --- | --- | --- | --- |
| 1 | Terminal after `npm run demo` | Run `npm run demo` | Window about 1280 x 720, font 16 to 18 pt. Crop to the five `[n/5]` lines and the `Done.` line. | `[1/5] swarm ... verify: ok` to `[5/5] viewer: out/index.html`, and "Nothing was signed or sent". |
| 2 | Agents: art at mint and now | `open out/index.html`, Agents section | Browser window 1280 x 720 at 100% zoom (the page content is 980 px wide). | The four agent cards with both pictures each, and the banner "Mock mode, dry run: inference is mocked and nothing is signed, sent or deployed." |
| 3 | Meme share cards | `npm run render -- --style sticker`, `open out/styles/sticker/sheet.svg` | The sheet is a 1064 x 1064 square. Capture it square, whole image. Optionally repeat for `--style pixel` or `deepfried` (`npm run render -- --style all`). | The 4 x 4 grid of faces. |
| 4 | Transfer + re-hash panel | `open out/index.html`, Transfer section | 1280 x 720. Include the heading, the `alice`/`bob` line and the four `match` rows. | "Transfer: memory travels with the NFT", four `match` rows. |
| 5 | Tampered sheet | Same page, "Tampered sheet" | 1280 x 720. | The `MISMATCH` row. |
| 6 | Channel exchange | Same page, Channel section | 1280 x 720, crop to a few lines around a `Chaotic -> Skeptic` message. | The `[Chaotic -> Skeptic]` style line, or the same line in `out/transcript.txt`. |
| 7 | Judge screen | `bash scripts/verify.sh` | Crop to the last lines. | `result: PASS`. Run it before shooting and only shoot if it passes. |

Every screenshot should show the word MOCK somewhere: add it in the post text or as an overlay on the image, because the page itself says "mock" only in its banner, the `MOCK_INFERENCE=0` note in the Memory section and the `mocked` TEE badge in the Transfer section. Put the alt text "Mock-mode demo, hashes are MOCK" on each image.

## What not to show

- `.env`, keys, seed phrases, wallet windows, the `near` CLI.
- Any claim of a live testnet run, unless a real live run happened and you show its transaction hashes only.
- The placeholder contract id as if it were deployed.

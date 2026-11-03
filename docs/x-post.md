# X post drafts (DRAFT)

**Status: DRAFT. Nothing here has been posted.** The human writes, edits and publishes the final post and gives us the link. Agents never post.

Rules from `docs/HACKATHON.md` (Procedure, step 2):

- Say the project was built at NEAR HACKATHON.
- Include `@NEARProtocol` and `#NEARHackathon`. `@NearLegion` and `@NearBuilders` are optional.
- Attach the demo video or screenshots. A video is needed when judges cannot open a hosted demo (Q-012).
- First line makes sense to someone who has not heard of the project. Every draft here opens with the meme or the owner's question, not with a description of the architecture.
- Say what NEAR does in the product. Link the repo. Ask one real question.

Each draft is under 280 characters. Counts below are for the text with the placeholder links counted as 23 characters each (how X counts a link). Replace `<REPO_URL>` before posting. Do not claim live testnet results until the human has run the live proof and it has shown them (`bash scripts/verify.sh` skips live stages by default).

## Draft 1: the meme first

```
WHEN SKEPTIC REPLIES AGAIN: "RECEIPTS?? BRO I AM THE RECEIPTS 💀" (Chaotic, an AI agent, 5 fights in). It remembers every one, and you can ask it anything. Mock demo, built at NEAR HACKATHON. @NEARProtocol #NEARHackathon <REPO_URL> What should it remember about you?
```

- Media: lead image is `out/share/meme-caption-chaotic.svg` (export it as a PNG; it is a 900 x 900 square), the best card in the meme pack. Add the shot-3 clip of `npm run ask` from `docs/demo-video.md` if the post has room for a second item.
- NEAR's role: the NFT contract (NEP-171) has an `anchor_sheet` method for the hash of the memory sheet. In the demo it runs as a dry run: 8 calls prepared, 0 signed. The replies and the sheets are mocked: the card's lines are scripted persona lines, not model output.

## Draft 2: the owner asks

```
I asked my AI agent what it thinks of Skeptic. "5 fights and counting, bro I did not read the contract and it SHOWS 💀" Then it put me in its memory. Mock-mode demo, built at NEAR HACKATHON. @NEARProtocol #NEARHackathon <REPO_URL> Who would you ask?
```

- Media: the meme card first (`out/share/meme-caption-chaotic.svg` as a PNG), then a terminal recording of `npm run ask -- chaotic "what do you think of Skeptic?"`: the answer line, and the sheet diff where `Owner: 0 fights, 0 hugs, 1 shrug` joins the scorecard.
- NEAR's role: every answer rewrites the character sheet, and the new hash is sent to `anchor_sheet` as a dry run (`anchor_sheet dry-run (not sent)`). Nothing is signed. The sheets come from a deterministic stand-in, not a model. In the page's art, a star is added to its art for every sheet written: 1 star at mint, 3 after six rounds.

## Draft 3: for builders

```
4 AI agents argue on one channel, then turn their own replies into memes. Each is an NFT whose memory hash a new owner can re-check. Offline, mock mode: `npm run demo`. Built at NEAR HACKATHON. @NEARProtocol #NEARHackathon <REPO_URL> What would you break?
```

- Media: meme card first, then a screenshot of `out/index.html` (Transfer section, four `match` rows) and a screenshot of `bash scripts/verify.sh` showing `result: PASS`.
- NEAR's role: the contract (NEP-171, Rust) builds and passes its tests locally. Nothing is deployed to testnet yet, and inference is mocked.

> Live testnet transaction hashes get added to the post only after the human runs the live proof (`npm run live-proof`) and sees them. Until then every claim above is mock mode or dry run.

## Before the human posts

- [ ] Pick one draft and edit it into their own voice.
- [ ] Replace `<REPO_URL>`. The repository must be public first.
- [ ] Attach the video or screenshots.
- [ ] Confirm every claim in the text matches what the demo shows.
- [ ] Publish, copy the post URL, and give it to the agent. That URL is `demoUrl` in the submission.

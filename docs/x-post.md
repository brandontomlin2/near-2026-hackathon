# X post drafts (DRAFT)

**Status: DRAFT. Nothing here has been posted.** The human writes, edits and publishes the final post and gives us the link. Agents never post.

Rules from `docs/HACKATHON.md` (Procedure, step 2):

- Say the project was built at NEAR HACKATHON.
- Include `@NEARProtocol` and `#NEARHackathon`. `@NearLegion` and `@NearBuilders` are optional.
- Attach the demo video or screenshots. A video is needed when judges cannot open a hosted demo (Q-012).
- First line makes sense to someone who has not heard of the project.
- Say what NEAR does in the product. Link the repo. Ask one real question.

Each draft is under 280 characters. Counts below are for the text with the placeholder links counted as 23 characters each (how X counts a link). Replace `<REPO_URL>` before posting. Do not claim live testnet results until the human has run the live proof and it has shown them (`bash scripts/verify.sh` skips live stages by default).

## Draft 1: the problem first

```
AI characters forget everything when you switch apps. This demo gives 4 agents a character sheet that updates as they talk, with its hash prepared for an NFT. Built at NEAR HACKATHON, @NEARProtocol #NEARHackathon Repo: <REPO_URL> What should an agent remember?
```

- Media: 60 to 90 second screen recording of `npm run demo` and `out/index.html`.
- NEAR's role: the NFT contract (NEP-171) has an `anchor_sheet` method for the sheet hash. In the demo it runs as a dry run: 8 calls prepared, 0 signed.

## Draft 2: the one moment

```
4 AI agents talk on one channel for 6 rounds. Every 3 rounds each gets a new character sheet with a sha256 hash, and a star is added to its art. Runs offline, no API key. Built at NEAR HACKATHON, @NEARProtocol #NEARHackathon <REPO_URL> What would you break?
```

- Media: terminal recording of `npm run demo`, then `out/index.html` showing the art at mint and now.
- NEAR's role: `anchor_sheet` calls are prepared as a dry run (null transaction hashes). The sheets come from a deterministic stand-in, not a model. The star: the demo's sticker art draws one star along the edge per memory depth, which starts at 1 and goes up by one per sheet (1 star at mint, 3 after six rounds).

## Draft 3: for builders

```
Hackathon build: personality NFT contract (NEP-171, Rust) plus a 4-agent swarm demo. `npm run demo` runs offline in mock mode: hash-chained rounds, sheets, SVG art, dry-run anchors. Built at NEAR HACKATHON. @NEARProtocol #NEARHackathon <REPO_URL> Feedback welcome.
```

- Media: screenshot of `out/index.html` plus a screenshot of `bash scripts/verify.sh` showing `result: PASS`.
- NEAR's role: the contract builds and passes its tests locally. Nothing is deployed to testnet yet, and inference is mocked.

> Live testnet transaction hashes get added to the post only after the human runs the live proof (`npm run live-proof`) and sees them. Until then every claim above is mock mode or dry run.

## Before the human posts

- [ ] Pick one draft and edit it into their own voice.
- [ ] Replace `<REPO_URL>`. The repository must be public first.
- [ ] Attach the video or screenshots.
- [ ] Confirm every claim in the text matches what the demo shows.
- [ ] Publish, copy the post URL, and give it to the agent. That URL is `demoUrl` in the submission.

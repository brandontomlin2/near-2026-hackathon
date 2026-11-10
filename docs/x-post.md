# X post drafts (DRAFT)

**Status: DRAFT. Do not post from this file as is. Nothing here has been posted.** The human writes, edits and publishes the final post and gives us the link. Agents never post.

Rules from `docs/HACKATHON.md` (Procedure, step 2):

- Say the project was built at NEAR HACKATHON.
- Include `@NEARProtocol` and `#NEARHackathon`. `@NearLegion` and `@NearBuilders` are optional.
- Attach the demo video or screenshots. A video is needed when judges cannot open a hosted demo (Q-012).
- First line makes sense to someone who has not heard of the project. Every draft here opens with the problem or the claim, not with a description of the architecture.
- Say what NEAR does in the product. Link the repo. Ask one real question.

The product is the Yield Optimizer vault: AI agents propose trades, a NEAR vault contract's on-chain rules veto the bad ones, and only trades that pass execute on Rhea (Ref Finance). Each draft is at most 280 characters, counted the way X does: the `<REPO_URL>` placeholder as 23 characters (how X counts a link). Counted that way: draft 1 is 272, draft 2 is 279, draft 3 is 258. `scripts/docs-accuracy.test.mjs` re-counts every draft and checks both tags, so re-run `node --test scripts/docs-accuracy.test.mjs` after editing one. Replace `<REPO_URL>` with `https://github.com/brandontomlin2/near-2026-hackathon` before posting (the repository must be public first; X counts the link as 23 characters, which is why the placeholder stays in the blocks below). Live demo URL: TODO(owner): none exists; do not add one unless the human hosts it.

What is true, so every claim in a post can be checked against it: one approved testnet run happened on 2026-11-09 (testnet only, nothing on mainnet): the vault is deployed and made one small swap through `execute_swap` on Rhea (Ref Finance). The owner sent that swap by hand, so do not say an agent picked it, and the vault has not refused a live transaction (rejections are shown by the contract's tests and by the offline demo). The demo (`npm run yield:demo`) is offline: mock inference, a committed pool snapshot, placeholder account ids, nothing signed or sent. The ids, transaction hashes and a read-only `curl` check are in the README section "Live on testnet". Do not claim a TEE, NEAR Intents, mainnet use or a live NEAR AI Cloud call.

## Draft 1 (272 characters): the problem

```
Would you hand a trading bot your treasury? Ours only proposes. A NEAR vault contract checks each swap against on-chain limits and refuses the rest. One live testnet swap. Built at NEAR HACKATHON. @NEARProtocol #NEARHackathon <REPO_URL> Which rule is missing?
```

- Media: the terminal screenshot of `npm run yield:demo`, cropped from the `YIELD DEMO` line to `1 unsigned execute_swap call planned, 0 signed, 0 sent`, and a screenshot of the swap transaction page linked in the README section "Live on testnet".
- NEAR's role: the vault contract (`contracts/yield-vault/`) holds the tokens, checks every `execute_swap` against the owner's rules and makes the swap on Rhea (Ref Finance). The live swap is 0.01 wNEAR on Ref pool 0 on testnet.

## Draft 2 (279 characters): the rejections

```
AI agents propose swaps; a NEAR vault contract decides: max trade, daily cap, price floor, pause. The offline mock demo shows 4 proposals it rejects, with the contract's own errors. Built at NEAR HACKATHON. @NEARProtocol #NEARHackathon <REPO_URL> What would you cap?
```

- Media: the "Rejected by the on-chain rules" table on `out/yield-demo/index.html` (the four `REJECTED ERR_...` lines), then the terminal summary.
- NEAR's role: the four messages are the exact strings the Rust `check_rules` returns, read from `contracts/yield-vault/tests/rule-vectors.json`, the vectors the contract is tested with. The demo is a dry run with mock inference; the agents' proposals come from a committed snapshot of Ref testnet pools.

## Draft 3 (258 characters): for builders

```
A Rust vault on NEAR swaps on Rhea (Ref Finance) only if the owner's rules pass. One live testnet swap, nothing on mainnet. `npm run yield:demo` runs offline. Built at NEAR HACKATHON. @NEARProtocol #NEARHackathon <REPO_URL> What would you break?
```

- Media: a screenshot of `bash scripts/verify.sh` ending `result: PASS`, and the explorer page of the swap transaction.
- NEAR's role: near-sdk contract, NEP-141 deposits, cross-contract promises and callbacks to Ref. The refund and recovery paths have run only against a mock Ref; the one live swap is the only run against the real Ref testnet contract.

> The personality NFTs the four agents also come from are supporting context and are not in these drafts. If the human wants a line about them, the true version is: the agents are also NEP-171 NFTs, the NFT contract is deployed on testnet and one token (`aloof`) was minted. The chat between the agents is scripted and the character sheets come from a deterministic stand-in, not a model.

## What to attach

- Screenshot of the offline vault page: run `npm run yield:demo`, then open `out/yield-demo/index.html` and capture it by hand.
- Screenshot (produced by the code) of the supporting NFT page: `npm run screenshot` runs `node scripts/screenshot.mjs`, which runs the demo into a temp dir and writes a full-page PNG to `out/page.png` (it needs a Chrome or Chromium already installed). `out/page.png` is gitignored.
- Video: no script produces one. The human records it by hand from `docs/yield-demo-video-script.md` (the vault video, about 90 seconds) or `docs/demo-video.md` (the vault first, then the supporting demo). `docs/HACKATHON.md` Q-012 says screenshots are not enough when judges cannot open a hosted demo, so record the video.

## Before the human posts

- [ ] Pick one draft and edit it into their own voice.
- [ ] Replace `<REPO_URL>`. The repository must be public first.
- [ ] Attach the video or screenshots.
- [ ] Confirm every claim in the text matches the "What is true" paragraph above and the README section "Live on testnet".
- [ ] Publish, copy the post URL, and give it to the agent. That URL is `demoUrl` in the submission.

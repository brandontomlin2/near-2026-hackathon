# Yield vault demo: 90-second video shot list and X post draft

Draft only. Nothing here has been recorded or posted. Posting on X needs the human's explicit yes (see `docs/HACKATHON.md`).

Everything the commands show is the offline dry run: mock inference, committed pool snapshots, placeholder account ids (`vault.yield-demo.testnet`), nothing signed or sent. Say so on screen. The one live result is the testnet run of 2026-11-09, shown in its own shot below from the README section "Live on testnet": the vault is deployed on testnet and made one small swap, sent by the owner by hand. Do not imply live trading beyond that one swap, an agent-picked live trade, a live rejection (the vault has not refused a live transaction) or mainnet use. `docs/demo-video.md` has the same shots as a short cut, followed by the supporting NFT shots.

## Setup before recording

- Fresh clone, `npm install` already done, terminal at least 180 columns wide (the rule lines are long), font large enough to read at 720p.
- Run `npm run yield:demo` once so `out/yield-demo/index.html` exists, then `clear`.
- Browser with no extensions visible; open the page from disk (`open out/yield-demo/index.html`).

## Shot list (about 90 seconds)

| Time | Shot | On screen | Voice-over (draft) |
| --- | --- | --- | --- |
| 0:00-0:08 | Title card | "Yield vault: AI agents propose, the contract decides" | Four AI agents and a planner want to trade from one vault. The vault's rules decide what can happen. |
| 0:08-0:18 | Terminal | Type `npm run yield:demo`; hold on the first two lines (`YIELD DEMO - DRY RUN ...`, the snapshot line, not fetched) | One command, offline. Mock inference, one committed Ref snapshot, nothing signed or sent. |
| 0:18-0:32 | Terminal, zoom on the agent table | The five rows: aloof, chaotic, social, skeptic, yield-optimizer; aloof, social and skeptic `refused: SOFT_OFF_REFERENCE ...`, the `yield-optimizer  pool 747: 0.05 usdc -> min 0.050406 usdt  OK           execute` row, then `chaotic vetoed by skeptic ...` and the `optimizer swap on pool 747, 6 other pools not chosen:` lines | Each agent proposes one swap. The stable agents picked testnet pool 1, which is far off its $1 peg, so they are refused against the reference price. Skeptic vetoes Chaotic's oversized trade. The planner skips the other pools (no reference price, off the reference price, or not allowed) and plans one small swap on pool 747, a shallow testnet pool of fake USDC.e and USDT.e whose reference is the $1 peg. Say so on camera: shallow liquidity, fake tokens, planned and rule-checked only. |
| 0:32-0:50 | Terminal, zoom on the rule block | `on-chain rules, vectors from contracts/yield-vault/tests/rule-vectors.json ...` and the four `REJECTED ERR_...` lines | These four proposals break an on-chain rule: over max trade, over the daily cap, below the price floor, vault paused. Each message is the exact string the Rust contract's check_rules returns, read from the same test vectors the contract is tested with. |
| 0:50-0:58 | Terminal | `1 unsigned execute_swap call planned, 0 signed, 0 sent` | The one proposal that passes every check becomes an execute_swap call, and even that is never signed or sent. |
| 0:58-1:10 | Browser | The explorer page of the swap transaction, or the read-only `curl` check, both in the README section "Live on testnet": the `swap_executed` event, 0.01 wNEAR in and `94246798` of `rft.tokenfactory.testnet` out on pool 0 | This one is real, on testnet: the vault made one small swap through execute_swap. The owner sent it by hand, it was not picked by an agent, and the vault has not refused a live transaction yet; the rejections you just saw are the offline demo and the contract's tests. Nothing is on mainnet. |
| 1:10-1:20 | Browser | `out/yield-demo/index.html`: DRY RUN notice, Agent proposals table, "Rejected by the on-chain rules" table (red messages), the Unsigned calls section with the one pool 747 call | The same run as one static page: no network, no scripts. |
| 1:20-1:30 | Terminal | `bash scripts/verify.sh` result table, the `yield demo` row PASS, `result: PASS` (pre-recorded; it takes a minute or two) | The judge check re-runs this from a fresh clone and only passes if nothing was signed or sent and every rejection matches the contract. |

Keep the cut honest: no sped-up fake output, no edited numbers. If a line changes in the code, re-record; the README test pins these lines.

## Screenshots for the X post

1. Terminal: the one-screen summary from `npm run yield:demo`, cropped from the `YIELD DEMO` line to `1 unsigned execute_swap call planned, 0 signed, 0 sent`.
2. Browser: the "Rejected by the on-chain rules" table on `out/yield-demo/index.html`.
3. Browser: the Agent proposals table with Skeptic's veto of Chaotic visible.
4. Terminal: the `verify.sh` SUMMARY table ending `result: PASS`.

## X post draft (not posted)

The drafts are in `docs/x-post.md`: vault-first, each says it was built at NEAR HACKATHON and carries `@NEARProtocol` and `#NEARHackathon`. Nothing has been posted. Per `docs/HACKATHON.md` the post must attach the video or screenshots. Before posting: add the repository link once it is public, and get the human's explicit yes.

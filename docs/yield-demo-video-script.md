# Yield vault demo: 90-second video shot list and X post draft

Draft only. Nothing here has been recorded or posted. Posting on X needs the human's explicit yes (see `docs/HACKATHON.md`).

Everything shown is the offline dry run: mock inference, committed pool snapshots, placeholder account ids. No vault is deployed and nothing is signed or sent. Say so on screen; do not imply live trading.

## Setup before recording

- Fresh clone, `npm install` already done, terminal at least 180 columns wide (the rule lines are long), font large enough to read at 720p.
- Run `npm run yield:demo` once so `out/yield-demo/index.html` exists, then `clear`.
- Browser with no extensions visible; open the page from disk (`open out/yield-demo/index.html`).

## Shot list (about 90 seconds)

| Time | Shot | On screen | Voice-over (draft) |
| --- | --- | --- | --- |
| 0:00-0:08 | Title card | "Yield vault: AI agents propose, the contract decides" | Four AI agents and a planner want to trade from one vault. The vault's rules decide what can happen. |
| 0:08-0:20 | Terminal | Type `npm run yield:demo`; hold on the first two lines (`YIELD DEMO - DRY RUN ...`, the snapshot line, not fetched) | One command, offline. Mock inference, one committed Ref snapshot, nothing signed or sent. |
| 0:20-0:35 | Terminal, zoom on the agent table | The five rows: aloof, chaotic, social, skeptic, yield-optimizer; the `yield-optimizer  HOLD ...` row, then `chaotic vetoed by skeptic ...` and the `optimizer HOLD, 6 pools checked, none usable:` lines | Each agent proposes one swap. Skeptic vetoes Chaotic's oversized trade. The planner finds no pool that passes every gate on the real snapshot (no reference price, off the reference price, or not allowed) and holds. |
| 0:35-0:55 | Terminal, zoom on the rule block | `on-chain rules, vectors from contracts/yield-vault/tests/rule-vectors.json ...` and the four `REJECTED ERR_...` lines | These four proposals break an on-chain rule: over max trade, over the daily cap, below the price floor, vault paused. Each message is the exact string the Rust contract's check_rules returns, read from the same test vectors the contract is tested with. |
| 0:55-1:05 | Terminal | `3 unsigned execute_swap calls planned, 0 signed, 0 sent` | What survives becomes an execute_swap call, built but never signed. |
| 1:05-1:20 | Browser | `out/yield-demo/index.html`: DRY RUN notice, Agent proposals table, "Rejected by the on-chain rules" table (red messages), one Unsigned calls card | The same run as one static page: no network, no scripts. |
| 1:20-1:30 | Terminal | `bash scripts/verify.sh` result table, the `yield demo` row PASS, `result: PASS` (pre-recorded; it takes a minute or two) | The judge check re-runs this from a fresh clone and only passes if nothing was signed or sent and every rejection matches the contract. |

Keep the cut honest: no sped-up fake output, no edited numbers. If a line changes in the code, re-record; the README test pins these lines.

## Screenshots for the X post

1. Terminal: the one-screen summary from `npm run yield:demo`, cropped from the `YIELD DEMO` line to `3 unsigned execute_swap calls planned, 0 signed, 0 sent`.
2. Browser: the "Rejected by the on-chain rules" table on `out/yield-demo/index.html`.
3. Browser: the Agent proposals table with Skeptic's veto of Chaotic visible.
4. Terminal: the `verify.sh` SUMMARY table ending `result: PASS`.

## X post draft (not posted)

> Built at NEAR HACKATHON: four AI agents and a planner propose swaps for one NEAR vault. The vault contract has the last word: max trade, daily cap, price floor, pause. `npm run yield:demo` shows it offline: the agents' proposals, and four that the on-chain rules reject with the contract's exact error. Dry run: nothing signed, nothing sent, not deployed yet. @NEARProtocol #NEARHackathon

Per `docs/HACKATHON.md` the post must say it was built at NEAR HACKATHON, tag @NEARProtocol and #NEARHackathon (optionally @NearLegion and @NearBuilders), and attach the video or screenshots. Before posting: add the repository link once it is public, and get the human's explicit yes.

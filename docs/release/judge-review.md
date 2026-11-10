# Judge-eye review, 2026-11-09

Follow-up, 2026-11-09 (branch `claude/release-doc-1109b`): findings 3, 4, 5, 7 and 8 were addressed after this review, and finding 9 in part. The findings below are left as written. Finding 3: the tracks are now exactly `security`, `defi` and `nfts` in the README, `PRODUCT.md`, `docs/tracks.md` and the checklists. Finding 4: `PRODUCT.md` was replaced with the vault version. Finding 5: the README is vault-first, the NFT material sits under "Supporting: the personality NFTs", and the "Work in progress: Yield Optimizer" heading is gone. Finding 7: the README has a read-only `curl` check of the vault and the swap. Finding 8: `docs/tracks.md`, `docs/judge-checklist.md`, `docs/submission-checklist.md`, `docs/x-post.md`, `docs/demo-video.md`, `docs/demo-script.md` and `docs/yield-demo-video-script.md` now follow the vault story and the live run. Finding 9: the README marks the Shade Agent runner as cut and `docs/yield-shade-go-nogo.md` records it as not pursued; the README's Shade dry-run subsection still lists its commands. Finding 6 (no live rejection) and finding 10 (human-only items) are unchanged.

What a fresh-clone AI screen (Claude Code or Codex, Q-017 in `docs/HACKATHON.md`) hits when it follows the README, and what a human judge reads next. Reviewed commit: `f605da2` on `claude/release-doc-1109` (PR #200 on top of `main` `581ae9a`). Fixes made on this branch are marked FIXED; everything else is listed for Brandon and not done.

## How it was checked

An independent reviewer agent made a local `git clone` of this worktree into a private temp directory (no remote added, nothing pushed), then ran the README as written: the "Judge quick path" steps 1 to 4, the "Judge path (offline, yield)" steps, every `<!-- judge:run -->` block, every numbered step in the "Yield Optimizer" section, `npm test` and `cargo test` in `contracts/yield-vault`. Each backticked "see this line" string was checked against the real output with `grep -F`. It also checked every README link and anchor, and searched the README and docs for statements that contradict the live testnet run. No `near` CLI was run and nothing was signed or sent.

Machine: macOS (Apple silicon), Node v22.22.0, cargo 1.93.1 installed, gitleaks not installed.

## Result in one paragraph

Every command ran with the exit code the README claims and every quoted output line matched: nothing breaks. The README's prose was the problem. Its opening status paragraph said the vault was not deployed and nothing had ever been sent, while its last section records the 2026-11-09 testnet run. An AI screen that compares claims would report the README as contradicting itself, on the one fact human judges care most about. That contradiction is fixed on this branch. What remains is mostly the old memory-NFT story still sitting in docs and in the track list.

## What ran (fresh clone of `f605da2`)

| Step | Command | Exit | README lines matched |
| --- | --- | --- | --- |
| Quick path 1 | `npm install && npm run yield:demo` | 0 | 16 of 16 |
| Quick path 2 | `npm run demo` | 0 | 6 of 6 |
| Quick path 3 | headline in `out/index.html` | n/a | matched the old headline (changed since, see finding 2) |
| Quick path 4 | `bash scripts/verify.sh` | 0 | 18 rows, no `FAIL`, `result: PASS`, 92 s |
| Yield judge path 1 to 4 | `yield:demo`, `yield:shade:check`, `yield:live:check`, `yield:live:dry-run -- --send` | 0, 0, 0, 2 | all |
| `judge:run` blocks | 4 blocks | 0 | every `judge:expect` string |
| Planner table | `node scripts/yield-optimizer.mjs` (two forms) | 0 | 12 of 12 rows |
| Shade dry run 1 to 4 | | 0, 0, 1, 0 | all |
| Live path, unsigned 1 to 6 | | 0, 0, 2, 0, 0, 3 | all |
| Vault CLI 1 to 5 | `npm run yield` and its refusals | 0, 0, 0, 2, 1, 1 | all |
| Vault CLI 6 | `cargo test` in `contracts/yield-vault` | 0 | `278 passed; 0 failed`, all 12 named tests present |
| Vault CLI 7 | the `node --test` list | 0 | `# pass 429`, `# fail 0` |
| `npm test` | | 0 | 4604 tests, 4594 pass, 0 fail, 10 todo |

Static checks: all 35 distinct README link targets exist and every `#anchor` resolves. `LICENSE` exists (MIT). `docs/DISCLOSURE.md` exists and is linked. `git status` stayed clean after every step (only gitignored `out/` and `target/` appeared). Timing claims held.

Explorer links: `explorer.testnet.near.org` answered HTTP 200 to a HEAD request for the swap and vault URLs (page content not checked). `testnet.nearblocks.io` answered 403 to `curl`, which is its bot protection, so it is inconclusive from a script; open those links in a browser.

## Findings, ranked by judge impact

### 1. FIXED. The README said "not deployed, nothing sent" in about a dozen places while "Live on testnet" records a real run

Impact: highest. The AI screen checks that the repository matches what the README says, and the README disagreed with itself about whether the product is live. A human judge reading only the first screen would have concluded there is no testnet deployment at all, which undersells the entry.

Where it was (line numbers at `f605da2`): README lines 11, 13, 24, 58, 59, 105, 236, 320, 324, 330, 336 and 358; `contracts/yield-vault/README.md` lines 7, 262 and 306; `docs/DISCLOSURE.md` line 54; `docs/yield-vault-live-runbook.md` lines 5 and 8.

Fix made: each of those sentences now says what is true. The vault is deployed on testnet and made one swap on 2026-11-09 (linked to "Live on testnet"); everything a judge runs from the repository is offline and sends nothing; the ids the demos print are placeholders, not the live accounts; the refund and recovery paths have run only against the mock Ref. No command, expected-output line or number changed. The "Live on testnet" section also gained one sentence saying the live swap is the pool 0 wNEAR fallback, not the pool 747 swap the offline demo plans (finding 6).

### 2. FIXED. The `npm run demo` page headline pitched the cut story

`out/index.html` opened with "Your NFT remembers who you are". It now opens with "AI agents propose trades. On-chain rules decide.", names the treasury user, says the page is the supporting demo and points at `npm run yield:demo`. README steps, the tests that pinned the old string and `docs/img/page.png` follow it. Commit `438635c`.

### 3. NOT DONE, needs Brandon. The README claims five tracks, and says itself that two of them are not built

README line 40: "Tracks: `defi`, `security`, `nfts`, `swarms` and `agents`". Six lines later the track-fit paragraph says, for `swarms` and `agents`: "What does not exist: no coordination market, bidding, collective purchasing or settlement between agents, and no agent earns, spends, negotiates, hires or pays". Those are close to the organizers' own definitions of the two tracks. A screen doing feature verification per track will mark both as not delivered, and that sits next to the two tracks the vault does deliver.

Suggested: claim `security` and `defi`; keep `nfts` only if Brandon wants the supporting demo scored; drop `swarms` and `agents`. The track list is the human's decision (`docs/HACKATHON.md`, "What the human decides"), and `scripts/readme-facts.test.mjs` pins the track-fit paragraph, so this was left alone. Rationale per track is in [`RELEASE.md`](RELEASE.md).

### 4. NOT DONE, needs Brandon's yes. `PRODUCT.md` describes a different product

The README links it as "Design". It pitches "Own an AI personality as an NFT", says "Submit `nfts`, `swarms`, and `agents`", lists "Marketplace or trading" and "Token economics or payments" as out of scope, and its demo flow says `npm run swarm` does not exist. A judge who follows the link reads a product that contradicts the README. Proposed replacement text is in [`RELEASE.md`](RELEASE.md), "Proposed PRODUCT.md changes".

### 5. NOT DONE. The README is vault-first for one screen, then turns back into the NFT README

- "What this is" (line 28) opens with a second "Problem:" about an AI character forgetting who it was, with the Chaotic share card as the first image in the file.
- "Try it (judge path)" is ten steps of the NFT demo and comes before the vault's own section, which starts at line 211 of 383.
- The vault's section is introduced by a heading that still reads "Work in progress: Yield Optimizer". The sentence under it is fixed; the heading is an anchor other text links to, so it was left.
- Suggested: move "Yield Optimizer" and "Live on testnet" up to follow the quick path, move the NFT sections under one "Supporting: personality agents" heading, and rename the work-in-progress heading to "Not done: Shade Agent runner". This is a reorder of a test-pinned file (`scripts/readme-facts.test.mjs` fixes the section order relative to "Live on testnet"), so it is a half-day job, not a safe small edit.

### 6. PARTLY FIXED. The live swap is not the swap the demo plans, and no live rejection exists

The offline demo, the unsigned live plan and the runbook all describe pool 747 (0.05 USDC.e to USDT.e). The live swap was pool 0 (0.01 wNEAR to `rft`). The "Live on testnet" section now says so in one sentence. Still true, and worth stating in the demo video rather than hiding:

- The owner sent the live swap by hand from printed commands. The README does not record an agent proposing it, so it should not be presented as an agent-picked trade.
- The vault has never refused a live transaction. The rejections are shown by unit tests, sandbox tests and the offline demo.
- A cheap way to close this without any transaction: the deployed vault has a read-only `check_proposal(proposal, runner_id)` view. One documented RPC view call with an over-limit proposal would let a judge see the live contract return `ERR_MAX_TRADE` themselves. Not done here (this session made no network calls to NEAR); it is a README step plus one test.

### 7. NOT DONE. "Check it yourself" in "Live on testnet" needs near-cli-rs

The only verification the README offers for the live state is a `near contract call-function as-read-only ...` command. An AI screen in a fresh container has no `near` binary and the quick path promises none is needed. Add the same check as a `curl` to a public testnet RPC (`query` / `call_function` on `get_state`), with the expected `swaps_executed: 1`. Look the RPC endpoint up in the NEAR docs; do not guess it.

### 8. NOT DONE. Supporting docs still say nothing is deployed, or pitch the NFT

A judge who wanders into `docs/` finds statements the README no longer makes:

- `docs/tracks.md`: "Nothing is deployed on testnet", names `nfts`, `swarms`, `agents` as the claimed tracks, calls the vault "planned".
- `docs/judge-checklist.md` line 6: "no testnet deployment ... has been run or is evidenced in this repository".
- `docs/submission-checklist.md` lines 41, 46, 94, 122: last walked 2026-11-04; quotes README text that no longer exists and says the live section is "not run yet".
- `docs/x-post.md`, `docs/demo-video.md`, `docs/demo-script.md`: the post drafts and shot lists are for the memory-NFT demo. `docs/yield-demo-video-script.md` is the vault one and still says no vault is deployed.
- `docs/x-post.md` at least is pinned by `scripts/docs-accuracy.test.mjs`, so check for a pinning test before each edit. Simplest safe option before going public: delete or archive the NFT-era planning docs that the README does not link, and refresh the three it does.

### 9. NOT DONE. The Shade Agent section is stale and is cut scope

README line 288: "Go/no-go status: not decided (the owner decides by 2026-11-06 ...)". That date has passed and Shade is cut. The section still gives a judge four commands for a feature that is not part of the entry. Suggested: shrink it to two lines under "Not done", and record the decision as "not pursued for this submission" in `docs/yield-shade-go-nogo.md`. Pinned by `scripts/yield-shade.readme.test.mjs`.

### 10. NOT DONE, human only. Things the screen cannot pass until Brandon acts

- The repository must be public by Sat Nov 14, 5:59pm CST. Until then, and until PR #200 is on `main`, the NFT's `media` link (a GitHub raw URL to `docs/nft-media/aloof.svg`) returns 404. Expected; do not host the art elsewhere.
- Q-012: with no hosted demo, the X post needs a video, not only screenshots. There is no vault demo video yet.
- Run a full-history `gitleaks detect` once before making the repository public. On this machine gitleaks is not installed, so `verify.sh` used its narrower fallback scan (`PASS`, no findings).
- The four local tags `hp-pre-rebase-*` are worker leftovers. They are not the Q-003 tags; do not push them. The annotated `pre-hackathon` tag now points at the root commit `992acee` because no code predates the window (`docs/DISCLOSURE.md`); the compare is `pre-hackathon...main` until `hackathon-submission` exists.

### 11. Nits

- `out/yield-demo/index.html`, the page a judge opens in step 1, has no link to the live run. One line with the vault's explorer link would connect the offline demo to the live proof.
- The README table of explorer links uses `explorer.testnet.near.org` in one row and `testnet.nearblocks.io` in the others. Both are pinned by a test; pick one when the README is next reworked.
- `npm test` reports `todo 10`. The README says to expect `fail 0`, which holds; a careful screen may ask what the ten are.
- On a machine with Rust, the `vault tests` row of `verify.sh` is `PASS`; the README spends more words on the `SKIP` case than on the normal one.
- Two README refusal checks ask the judge to pass `--send --i-approve` (`npm run yield:demo -- --send --i-approve`, and `npm run yield -- --send --i-approve --agent skeptic` with no network set). Both are refused before anything can be sent, and the reviewer ran them as documented. A cautious screen may decline to run them; the plain `--send` refusals already prove the gate.
- Build board: `fill-readme-live-on-testnet-section-...` and `live-testnet-deploy-...` are still `todo` although the run is done and recorded.

## Differences between the live `HACKATHON.md` and the copy in `docs/`

Fetched 2026-11-09 by a helper agent that summarized rather than quoted, so re-read the live file before submitting. Tracks, fields, dates and prizes match. Two additions were reported: changes after submission go through `https://nearhackathon.com/request-changes` (never resubmit), and the NEAR Builders $10 credit uses a separate API key that does not show in the cloud.near.ai dashboard. `docs/HACKATHON.md` was not updated.

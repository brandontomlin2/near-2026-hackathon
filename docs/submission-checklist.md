# Submission checklist

Mirrors `docs/HACKATHON.md` (matched the live https://nearhackathon.com/HACKATHON.md on 2026-11-03; not re-fetched on 2026-11-04, that pass made no network calls). The live version wins: re-read it before submitting. Tick items with evidence, not memory.

Submission is one attempt per repository and cannot be edited. Window: 2026-11-01T00:00Z to **2026-11-14T23:59Z**. Outside it the API returns 403: tell the human, do not retry. Judging starts 2026-11-16T00:00Z; results by 2026-11-18T23:59Z.

Agents never do the items marked **HUMAN**. Without an explicit yes, agents must not send the submission, post on X, make the repo public, push, or sign or spend anything.

Status key: **done** (evidence given), **missing** (agent-doable work not finished), **needs Brandon** (only the human can supply or do it). Last walked: 2026-11-04 on branch `claude/docs-accuracy27`, based on main `c8e48d8`.

## At a glance: what the hackathon requires, and where it stands

| Requirement (source) | Status | Where |
| --- | --- | --- |
| Public repo before 2026-11-14T23:59Z, kept public through judging | **HUMAN** (only they can make it public; the repo cannot show its visibility) | Section 1 |
| README: what it is, the problem, how NEAR fits, numbered "do X, see Y" steps | done | Section 2 |
| `LICENSE` | done (MIT) | Section 1 |
| Libraries, templates, AI-generated code listed; pre-hackathon code disclosed | done (`docs/DISCLOSURE.md`: none predates the window) | Section 2 |
| Pre-hackathon / `hackathon-submission` tags and README diff link (Q-003) | not applicable: no code predates 2026-11-01 (first commit `992acee`, 2026-11-02); no such tags exist | Section 3 |
| Demo video, 60 to 90 s (Q-012: screenshots alone are not enough if judges cannot open a hosted demo) | **HUMAN** records it; shot list is `docs/demo-video.md`, the 2.5 minute script is `docs/demo-script.md` | Section 4 |
| X post: says built at NEAR HACKATHON, tags `@NEARProtocol` and `#NEARHackathon`, video or screenshots attached | drafts done (3, each at most 280 characters, both tags); **HUMAN** edits, attaches media and publishes | Section 4 |
| Form fields: project name, lead name, email, team size, tracks, payout account, repo URL, demo post URL, idea, consent | all **HUMAN** | Section 6 |
| At most 2 projects per person, each independent and named in the other's README (Q-015) | **HUMAN** to answer; README names no second project | Sections 2 and 5 |
| Submission itself (one attempt, cannot be edited) | **HUMAN** confirms the printed payload; not started | Section 7 |
| Hosted demo (optional, a plus) | **HUMAN** (needs their hosting account); `npm run site` builds it | Section 2 |

## Rule-by-rule audit of `docs/HACKATHON.md`

Walked 2026-11-04 against this tree (main `aaaa5ba`), offline. Status: **PASS** (proved in the repo), **GAP** (agent-doable fix not done), **TODO-OWNER** (only the human can do or supply it), **N/A** (rule does not apply, reason given). The sections after this table give more detail.

| Rule (HACKATHON.md section) | Status | Proof |
| --- | --- | --- |
| Start here 2 / Procedure 1: repo public by 2026-11-14T23:59Z | TODO-OWNER | Visibility is not visible from the tree. Human makes it public (agents must not), then opens the URL logged out. |
| Q-014: repo stays public through judging; add a LICENSE file | PASS (LICENSE) / TODO-OWNER (staying public) | `LICENSE` line 1 `MIT License`, line 3 `Copyright (c) 2026 Brandon Tomlin`; README `## License` (README.md:216-218) says "MIT. See `LICENSE`." |
| Never-list: commit no secrets, keys in environment variables | PASS | `git grep -nE "ed25519:\|secp256k1:\|sk-[A-Za-z0-9]{8}\|BEGIN .*PRIVATE\|ghp_\|AKIA"` outside `.agents/` finds only placeholders (`ed25519:...`) in skill docs, fake keys in `scripts/*.test.mjs` and the pattern list in `scripts/secret-scan-fallback.mjs`, and on-chain public keys in `docs/spikes/shade-agent.md:25-26`. `git ls-files` lists no `.env`, `.pem` or `.key`; `.gitignore` excludes them. History: `git log --all -G'BEGIN [A-Z ]*PRIVATE KEY\|ghp_...\|sk-...'` hits only the scanner's own test commits; the 80+ character `secp256k1:` string in commit 83fbec5 is the public MPC root key from a testnet view call (`spikes/shade/evidence/testnet-mpc-views.txt`), not a secret. gitleaks is not installed here: see the next row. |
| Same: secret scan on the full history before going public | TODO-OWNER | `scripts/verify.sh` secret-scan row is `PASS ... FALLBACK` (`scripts/secret-scan-fallback.mjs`, narrower than gitleaks) or `SKIP`. Install gitleaks and run `gitleaks detect` once before the repo is made public. |
| Public-repo readiness: no absolute local paths | PASS | `git grep -nE "/Users/\|/home/[a-z]"` outside `.agents/` and `.claude/`: one hit, `src/demo/demo.test.mjs:162`, a test needle asserting that demo output does NOT contain `/Users/`. Tracked symlinks in `.claude/skills/` are relative (`../../.agents/skills/...`). |
| Public-repo readiness: no private links | PASS | `git grep` for gist, notion, google docs, figma, slack, linear, ngrok, `.internal`: no hits outside `.agents/` and `.claude/`. `localhost`/`127.0.0.1` appear only in `src/inference/client.mjs:11,247,267` (documented: plain http accepted for loopback only) and `scripts/claude-loop.sh:531` (a local git author email `claude-loop@localhost`, not a link). |
| Procedure 1 / Q-012: README for a machine reader: what it is, the problem, "do X - see Y" steps, no marketing | PASS | README.md:15-26 "Judge quick path" (4 numbered steps, the seconds-long demos first and verify.sh last) and README.md:58 "Try it (judge path)" (steps 1-10 numbered, each "run X, see Y"); `scripts/readme-facts.test.mjs` and `scripts/readme-commands.test.mjs` pin the commands. Line 28 "What this is" gives product and problem; "How NEAR fits" is at README.md:42. |
| Q-012: local-only demo OK with public repo, reproducible README, X post with a video; screenshots not enough if judges cannot open the demo | TODO-OWNER | Reproducible README: PASS (above). Video and X post are the human's: `docs/demo-video.md`, `docs/x-post.md`. Hosted demo is optional: `docs/hosting.md`. |
| Q-002: existing product on another chain is allowed; disclose in README | N/A | No earlier product. README.md:82 and README.md:212-214 "Disclosure" say pre-hackathon code: none. |
| Q-003 / Q-004: dedicated branch, or tags `pre-hackathon` and `hackathon-submission`, plus a README section linking the diff | N/A | No code predates the window, so there is no baseline to diff. `git rev-parse 992acee` resolves to `992acee11248ef2929fc21cf3897e04241f8435b` (first commit, named in `docs/DISCLOSURE.md`); `docs/DISCLOSURE.md` names no tag. `git tag -l` lists only four local `hp-pre-rebase-*` safety tags (not baseline tags, never pushed). If the owner wants belt and braces, a `pre-hackathon` tag on `992acee` would be empty of code. |
| Q-001: window runs from the 2026-10-19 announcement to 2026-11-14; earlier commits are baseline | PASS | `docs/DISCLOSURE.md` "Pre-hackathon code" (first commit 2026-11-03T00:20:04Z UTC, `scripts/disclosure-facts.test.mjs` pins it). |
| Q-005: list libraries, templates, boilerplate, AI code in README | PASS (by link) | README.md:212-214 "Disclosure" links `docs/DISCLOSURE.md`, which lists: no npm dependencies, Rust deps `near-sdk` 5.30.0 and `near-contract-standards` 5.30.0, `.agents/skills`, no template, AI-generated code (effectively all). Optional hardening, see GAP row below. |
| Q-005 hardening: README itself should carry a one-line list, not only a link | GAP | Suggested line for README.md `## Disclosure` (README is owned by other PRs; not edited here): "Third-party code: no npm dependencies; Rust crates `near-sdk` 5.30.0 and `near-contract-standards` 5.30.0 (contract only); NEAR agent skills under `.agents/skills/`; no template. Nearly all code is AI-generated (Claude Code) under human direction." |
| Q-007 / Q-008 / Q-010: testnet first; Intents is mainnet-only; testnet-only is eligible | PASS | Testnet-only and mock-only stated at README.md:17 ("Everything here is mock or dry-run"), README.md:82 ("Nothing ... is deployed or live on testnet"), README.md:208-210 "Live on testnet: Not run yet". Guards: `scripts/testnet-deploy.mjs` and `scripts/live-proof.mjs` refuse `NEAR_NETWORK` other than `testnet`; `docs/DISCLOSURE.md` "Other notes" and Shade spike section say nothing was signed. No Intents or mainnet use (`PRODUCT.md`). `docs/DISCLOSURE.md` "Other notes" now states it in one line ("Mock and testnet status: ..."). |
| Q-006: 1Click JWT not required | N/A | Product does not use NEAR Intents. |
| Q-011: mandatory integrations: none | N/A | Own contract on NEAR fits: `contracts/personality-nft/`. |
| Q-013: organizers get non-exclusive promo rights, team keeps rights | N/A | No action; human to be aware. |
| Q-015: one person, several projects: each README names the other project | TODO-OWNER | TODO(owner): say whether the lead is submitting a second project. If yes, README must name it; the name is not known to this repo and must not be invented. README.md currently names no other project (`grep -n -i "other project\|second project" README.md` finds nothing). If no, record "one project only" here. |
| Q-016: single payment within 30 days of results | N/A | Informational. |
| Q-017: Claude Code and Codex screen the README and reproduce | PASS | README written for that reader (`scripts/readme-facts.test.mjs`); `bash scripts/verify.sh` is the one-command reproduction, ends `result: PASS`. Re-run on the final commit. |
| Q-000: NEAR AI credits | N/A | Live inference is optional; the demo runs in mock mode with no key (README "Inference"). |
| Start here 3 / Procedure 2: X demo post says built at NEAR HACKATHON, tags `@NEARProtocol` and `#NEARHackathon`, video or screenshots attached | TODO-OWNER | Drafts in `docs/x-post.md` (all carry both tags; `scripts/docs-accuracy.test.mjs`). Human edits, replaces `<REPO_URL>`, attaches media, publishes. Agents never post. |
| Procedure 3: submit only between 2026-11-01T00:00Z and 2026-11-14T23:59Z, once, after repo is public and the post is up; re-read live HACKATHON.md first | TODO-OWNER | Section 7 below. Not started. |
| Procedure 3: payload has exactly the 11 API fields, no `website`, body at most 12000 bytes, `requestId` generated once, payload not committed | TODO-OWNER | Section 7 below. No payload exists in the repo (`git grep -ln requestId` finds only `docs/HACKATHON.md` and this file). |
| Never-list: print the full JSON payload and wait for an explicit yes before sending | TODO-OWNER | Section 7 below. |
| Tracks: one or more valid ids, each once | TODO-OWNER | Plan `nfts`, `swarms`, `agents` (README.md:31, `PRODUCT.md`, `docs/tracks.md`); `privacy` stays off (Section 5). Human confirms. |
| Human decides: project name (2-80) | TODO-OWNER | Not in repo by design. |
| Human decides: team lead name (2-80) | TODO-OWNER | `LICENSE` names a copyright holder, but that is not the confirmed `leadName`. Ask. |
| Human decides: contact email (max 160, at most 2 submissions per email) | TODO-OWNER | Ask. |
| Human decides: team size (`1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+`) | TODO-OWNER | Ask. |
| Human decides: mainnet NEAR account for payout (`nearAddress`) | TODO-OWNER | Ask. Never create or invent one. |
| Human decides: public repository URL (`projectUrl`, unique) | TODO-OWNER | Known only after the repo is public. |
| Human decides: public demo post URL (`demoUrl`) | TODO-OWNER | Known only after the human publishes the post. |
| Human decides: what they built (`idea`, 20-2000 chars) | TODO-OWNER | Human approves a draft from README "What this is" and "How NEAR fits". |
| Human decides: consent to the contact notice, read verbatim | TODO-OWNER | Quote is in Section 6. `true` only after the human agrees. |

Disclosure note: `docs/DISCLOSURE.md` carries the Q-002, Q-003 and Q-005 answers. A one-sentence "everything here is mock or dry-run; nothing is deployed to testnet; no mainnet or Intents use" is added there so the disclosure file stands alone.

Open GAPs for the lead: (1) README one-line library list (suggested text above). TODO-OWNER items that block submission: public repo, gitleaks run on history, X post and video, Q-015 answer, tracks, all form fields.

## 1. Repository

| Requirement | Status | Evidence / next step |
| --- | --- | --- |
| Repo public by 2026-11-14T23:59Z, stays public through judging (Q-014) | needs Brandon | Only the human makes it public. Check after: open the repo URL logged out. |
| `LICENSE` file (Q-014) | done | MIT, `head -3 LICENSE`; README "License" section. |
| No secrets in tree or history | done (local) | `bash scripts/verify.sh` row `PASS secret files`. The gitleaks row is `SKIP` unless gitleaks is installed: run `gitleaks detect` before going public (needs Brandon to install or approve). |
| `bash scripts/verify.sh` ends `result: PASS` | done | Re-run on the final commit; paste into the final PR `## Proof`. |
| No `.github/workflows` | done | `ls .github` fails; `docs/ci.md`; verify row `PASS workflows`. |
| Stray local tags | needs Brandon | `git tag` lists `hp-pre-rebase-*` safety tags. They are not baseline tags. Do not push them; delete locally if wanted (`git tag -d`). |

## 2. README (for an AI judge and a human, Procedure step 1)

| Requirement | Status | Evidence / next step |
| --- | --- | --- |
| What the product is, the problem, how NEAR fits; no marketing | done | README "What this is", "How NEAR fits". |
| Numbered "do X, see Y" steps from a fresh clone | done | README "Try it (judge path)" steps 1-10. Re-check each command exists in `package.json` before submit. |
| Works with no keys (`MOCK_INFERENCE=1`); live env vars documented | done | README "Inference" section. |
| Track ids named in README | done | README line 21, under the title: "Tracks: `nfts`, `swarms` and `agents`." `docs/HACKATHON.md` lists all 13 valid ids. |
| Libraries, templates, AI-generated code listed (Q-005) | done | `docs/DISCLOSURE.md`, linked from README "Disclosure". |
| Pre-hackathon code disclosed (Q-002, Q-003) | done | README "Mock caveats and status" and "Disclosure": none. `docs/DISCLOSURE.md` names first commit `992acee`. |
| Planned features not described as shipped | done | README "Mock caveats and status" and "Live on testnet" say nothing is deployed and there are no hashes to show. Re-check after any live run. |
| Second project named in README (Q-015) | needs Brandon | Ask if the lead is submitting another project. If yes, add a README line naming it (not done, none known). If no, record "one project only" in section 5. |
| Hosted demo up (Q-012, optional but a plus) | needs Brandon | `npm run site` builds `out/site/`; `docs/hosting.md`. Hosting needs the human's account. Keep up to 2026-11-18, ideally 2026-11-25. |
| Live testnet evidence section filled | missing | README "Live on testnet" says "Not run yet". Fill only after the human hosts the four SVGs, approves `npm run live-proof -- --send --i-approve --media-base <url>` and sees real hashes. That run writes them to `out/live-proof/txs.json`; then `EVIDENCE_NETWORK=testnet NEAR_CONTRACT_ACCOUNT_ID=<NEAR_CONTRACT_ACCOUNT_ID> EVIDENCE_TX_FILE=out/live-proof/txs.json npm run evidence` (read-only views; the evidence script reads `NEAR_CONTRACT_ACCOUNT_ID` as the contract account to query) writes `out/evidence.json`. A bare `npm run evidence` is mock mode and is not proof. Never invent hashes. |

## 3. Pre-hackathon baseline (Q-001 to Q-004)

Submissions open 2026-11-01; the code baseline cutoff is 2026-10-19 (announcement date, `docs/HACKATHON.md` Q-001). Earlier commits are baseline.

| Requirement | Status | Evidence / next step |
| --- | --- | --- |
| Decide whether any code predates 2026-11-01 | done | None. `git log --reverse --format='%h %ad %s' --date=short \| head` starts 2026-11-02. |
| If any: tags `pre-hackathon` and `hackathon-submission` plus a README diff link | done (not applicable) | No `pre-hackathon` tag exists or is needed. If this changes, tag, link `<repo>/compare/pre-hackathon...hackathon-submission`, and the human pushes the tags. |
| One-line "no pre-hackathon code" in README | done | README line under "Mock caveats and status" and in "Disclosure". |
| Pushing tags or branches | needs Brandon | Human's explicit yes, per `HACKATHON.md`. |

## 4. Demo post on X (**HUMAN** writes and publishes)

Requirements from Procedure step 2. Drafts: `docs/x-post.md` (3 drafts, counted the way X does, link 23 and emoji 2: 270, 262 and 277 characters; each has `@NEARProtocol`, `#NEARHackathon` and "built at NEAR HACKATHON"; `scripts/docs-accuracy.test.mjs` re-checks all of this). Video plan: `docs/demo-video.md`, `docs/demo-script.md`.

| Requirement | Status | Evidence / next step |
| --- | --- | --- |
| Draft says the project was built at NEAR HACKATHON | done | `docs/x-post.md` drafts 1-3. |
| Tags `@NEARProtocol` and `#NEARHackathon` (optional `@NearLegion`, `@NearBuilders`) | done in drafts | `docs/x-post.md`. No draft uses the optional tags; add if wanted. |
| Replace `<REPO_URL>` placeholder | needs Brandon | Needs the public repo URL. |
| Record demo video (Q-012: screenshots alone are not enough when judges cannot open a hosted demo) | needs Brandon | Shot list in `docs/demo-video.md`. |
| First line stands alone; NEAR's role concrete; repo linked; one real question | done in drafts | Re-check after the human edits. |
| Post is published, public, opens logged out | needs Brandon | The post URL becomes `demoUrl`. Agents never post. |
| Claims match the demo (mock mode, dry-run, nothing deployed) | done in drafts | Re-check against README Status; no live claims until a live run happened. |

## 5. Tracks and second-project rule

Valid ids (API table): `defi`, `thesis`, `privacy`, `business`, `swarms`, `security`, `agents`, `realworld`, `games`, `nfts`, `memecoins`, `social`, `open`. Each listed once.

| Requirement | Status | Evidence / next step |
| --- | --- | --- |
| Plan: `nfts`, `swarms`, `agents` | done (plan) | `PRODUCT.md` "Tracks"; README matches since 2026-11-03. |
| `privacy` only if a TEE attestation check ships | not met, stays off | `npm run attest:check` exists but only checks a hand-made fixture offline and ends `CONSISTENT, NOT VERIFIED`: no TDX quote signature, NVIDIA attestation or chat signature is checked, and nothing has run against a real report. So `privacy` stays off (`PRODUCT.md`, `docs/privacy.md`). |
| Final track list confirmed | needs Brandon | Human picks every track the project fits. |
| Q-015: at most 2 projects per person, each independent and named in the other's README; at most 2 submissions per email | needs Brandon | Ask whether a second project is planned; record the answer here. |

## 6. Fields the human provides (never guess or fill placeholders)

API field names in parentheses. All are **needs Brandon**; none is in the repo, by design.

| Field | Rule | Status |
| --- | --- | --- |
| Project name (`projectName`) | 2-80 chars | needs Brandon |
| Team lead name (`leadName`) | 2-80 chars | needs Brandon |
| Contact email (`email`) | valid, max 160 chars, max 2 submissions per email | needs Brandon |
| Team size (`size`) | exactly one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+` | needs Brandon |
| Tracks (`tracks`) | array, one or more valid ids, each once | needs Brandon (section 5) |
| Payout account (`nearAddress`) | mainnet, 2-64 chars, lowercase, `^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$`; named account or 64-char implicit. Agents never create or invent one. | needs Brandon |
| Public repo URL (`projectUrl`) | http(s), max 300 chars, never submitted before | needs Brandon |
| Public demo post URL (`demoUrl`) | http(s), max 300 chars | needs Brandon |
| What we built (`idea`) | 20-2000 chars: problem, product, how NEAR fits. Can be drafted from README for the human to approve. | needs Brandon |
| Consent (`consent`) | `true` only after the human hears: "I agree that the organizers may use these details to review our submission and contact us about this hackathon." | needs Brandon |
| `requestId` | UUID, generated once, reused on retries | done at send time (section 7) |

## 7. Send (agents only after an explicit yes)

- [ ] Re-read the live HACKATHON.md for rule or date changes (this copy matched on 2026-11-03).
- [ ] Generate `requestId` once (`node -e 'console.log(crypto.randomUUID())'`) and reuse it on retries.
- [ ] Payload has exactly the 11 fields in the API table (`requestId`, `projectName`, `leadName`, `email`, `size`, `tracks`, `nearAddress`, `projectUrl`, `demoUrl`, `idea`, `consent`) and no extras. `website` must be absent. Body under 12000 bytes.
- [ ] Do not commit the payload; it holds personal data.
- [ ] Print the full JSON to the human. **Wait for an explicit yes.**
- [ ] POST to https://nearhackathon.com/api/applications. 201 means saved; tell the human.
- [ ] 400: fix the fields listed in `fields`, resend with the same `requestId`. 403: tell the human, no retry. 409: repo already submitted or email at its limit, ask the human, do not change the link or email to get around it. 413: shorten `idea`. 503: wait a minute, resend with the same `requestId`.

Status of this section: not started, correctly. This walk drafted no payload and called no API.

## 8. Testnet and mainnet rules (Q-007, Q-008, Q-010, CLAUDE.md)

| Requirement | Status | Evidence / next step |
| --- | --- | --- |
| Build on testnet first; testnet-only projects are eligible in all tracks (Q-010) | done | Contract targets testnet; `scripts/testnet-deploy.mjs` refuses any `NEAR_NETWORK` but `testnet`; `scripts/verify.sh` refuses `mainnet`. |
| Product uses no mainnet or Intents (no testnet for Intents, Q-007) | done | `PRODUCT.md` out of scope: Mainnet, Intents. If that changes: separate dev accounts, tiny amounts, `dry: true` quotes, human's yes per action. |
| Deploy, mint and anchor are dry runs unless both `--send` and `--i-approve` are given | done | README "Deploy to testnet"; `npm run mint` prints only (`dry-run: nothing is signed or sent`), and `npm run deploy:nft` stops with `error: wasm not found ... Run npm run build:contract first` until the contract is built, then prints only; `--send` without `--i-approve` is refused; `npm run live-proof` hands its `--i-approve` on to both and refuses any `NEAR_NETWORK` but `testnet`. |
| Live testnet run | needs Brandon | Needs a testnet account and the human's yes. `npm run live:check` is read-only preflight. |
| Payout account is mainnet (not testnet) | needs Brandon | Section 6. Receiving a prize needs no repo action. |

## 9. Other rules (no action unless noted)

- Q-006: no 1Click JWT needed; not used.
- Q-013: organizers get non-exclusive promo rights; the team keeps all rights. Nothing to do. needs Brandon to be aware.
- Q-016: single payment within 30 days of results.
- Q-017: Claude Code and Codex screen projects; the README and `bash scripts/verify.sh` are written for that reader.

## 10. After submitting

- [ ] Keep the repo public through judging (starts 2026-11-16; results by 2026-11-18T23:59Z).
- [ ] Keep any hosted demo up to 2026-11-18, ideally 2026-11-25.
- [ ] Payout is a single payment within 30 days of results (Q-016).

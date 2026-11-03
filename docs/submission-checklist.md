# Submission checklist

Mirrors `docs/HACKATHON.md` (byte-identical to the live https://nearhackathon.com/HACKATHON.md when last walked, 2026-11-03). The live version wins: re-read it before submitting. Tick items with evidence, not memory.

Submission is one attempt per repository and cannot be edited. Window: 2026-11-01T00:00Z to **2026-11-14T23:59Z**. Outside it the API returns 403: tell the human, do not retry. Judging starts 2026-11-16T00:00Z; results by 2026-11-18T23:59Z.

Agents never do the items marked **HUMAN**. Without an explicit yes, agents must not send the submission, post on X, make the repo public, push, or sign or spend anything.

Status key: **done** (evidence given), **missing** (agent-doable work not finished), **needs Brandon** (only the human can supply or do it). Last walked: 2026-11-03 on branch `claude/checklist-walk`.

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
| Track ids named in README | done | README top: `nfts`, `swarms`, `agents` (fixed 2026-11-03; it said only `nfts` and `agents`). `docs/HACKATHON.md` lists all 13 valid ids. |
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

Requirements from Procedure step 2. Drafts: `docs/x-post.md` (3 drafts, all under 280 characters with links counted as 23; each has `@NEARProtocol`, `#NEARHackathon` and "Built at NEAR HACKATHON"). Video plan: `docs/demo-video.md`, `docs/demo-script.md`.

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
| `privacy` only if a TEE attestation check ships | missing | No attestation check exists; `privacy` stays off (`PRODUCT.md`, `docs/privacy.md`). |
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
| Deploy, mint and anchor are dry runs unless both `--send` and `--i-approve` are given | done | README "Deploy to testnet"; `npm run deploy:nft` and `npm run mint` print only; `--send` without `--i-approve` is refused; `npm run live-proof` hands its `--i-approve` on to both and refuses any `NEAR_NETWORK` but `testnet`. |
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

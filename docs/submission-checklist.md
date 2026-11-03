# Submission checklist

Mirrors `docs/HACKATHON.md`. The live version at https://nearhackathon.com/HACKATHON.md wins: re-read it before submitting. Tick items with evidence, not memory.

Submission is one attempt per repository and cannot be edited. Window: 2026-11-01T00:00Z to **2026-11-14T23:59Z**. Outside it the API returns 403: tell the human, do not retry.

Agents never do the items marked **HUMAN**. Without an explicit yes, agents must not send the submission, post on X, make the repo public, push, or sign or spend anything.

## 1. Repository

- [ ] **HUMAN** Repository is public by 2026-11-14T23:59Z and stays public through judging (Q-014).
- [ ] `LICENSE` file exists (MIT today). Check: `head -3 LICENSE`.
- [ ] No secrets in the tree or history. Check: `bash scripts/verify.sh` shows `PASS secret files`, and gitleaks if installed.
- [ ] `bash scripts/verify.sh` ends with `result: PASS`. Paste the output into the final PR `## Proof`.
- [ ] No `.github/workflows` files (CI is disabled on purpose, `docs/ci.md`).

## 2. README (written for an AI judge and a human)

- [ ] What the product is, the problem, and how NEAR fits in. No marketing.
- [ ] Numbered "do X, see Y" steps a judge can follow from a fresh clone. Every command in them exists in `package.json`.
- [ ] Works with no keys (`MOCK_INFERENCE=1`). Live mode and its env vars are documented.
- [x] Libraries, templates and AI-generated code are listed (Q-005). Evidence: `docs/DISCLOSURE.md`, linked from the README.
- [x] Pre-hackathon code is disclosed (Q-002, Q-003). If any exists, README links the diff. Evidence: none exists; `docs/DISCLOSURE.md`.
- [ ] Planned features are not described as shipped.
- [ ] Names the other project if the lead submits a second one (see section 5).

## 3. Pre-hackathon baseline (Q-001, Q-003, Q-004)

Hackathon window starts 2026-11-01. Earlier commits are baseline.

- [x] Decide whether any code predates 2026-11-01. Result: none, first commit 2026-11-02. Check: `git log --reverse --format='%h %ad %s' --date=short | head`.
- [ ] If yes: tag the last pre-hackathon commit `pre-hackathon`, tag the final commit `hackathon-submission`, and add a README section linking the diff (`<repo>/compare/pre-hackathon...hackathon-submission`).
- [x] If no: say so in the README in one line. The README Disclosure section links to `docs/DISCLOSURE.md`, which says none.
- [ ] **HUMAN** Pushing tags needs the human's yes.

## 4. Demo post on X (**HUMAN** writes and publishes)

- [ ] Text says the project was built at NEAR HACKATHON.
- [ ] Tags `@NEARProtocol` and `#NEARHackathon` (optional: `@NearLegion`, `@NearBuilders`).
- [ ] Demo video attached. Screenshots alone are not enough if judges cannot open a hosted demo (Q-012).
- [ ] First line is understandable without context; NEAR's role is stated concretely; repo linked; one real question asked.
- [ ] Post is public and the URL works while logged out.
- [ ] Drafts: `docs/x-post.md`. Video plan: `docs/demo-script.md`.

## 5. Tracks and second-project rule

- [ ] Tracks chosen from the valid ids: `defi`, `thesis`, `privacy`, `business`, `swarms`, `security`, `agents`, `realworld`, `games`, `nfts`, `memecoins`, `social`, `open`. Each listed once. Every track the project fits.
- [ ] Current plan from `PRODUCT.md`: `nfts`, `swarms`, `agents`. Add `privacy` only if a TEE attestation check ships in the demo.
- [ ] Q-015: one person may send at most 2 submissions, for different, independent, disclosed projects. Each README names the other project. The same project twice is not allowed. The email limit is 2 per address.
- [ ] If only one project: confirm with the human that no second submission is planned, and note that here.

## 6. Fields the human provides (never guess or fill placeholders)

- [ ] Project name (2-80 chars)
- [ ] Team lead name (2-80 chars)
- [ ] Contact email (max 160 chars)
- [ ] Team size: exactly one of `1`, `2 - 4`, `4 - 6`, `6 - 8`, `8+`
- [ ] Tracks (section 5)
- [ ] NEAR mainnet account for payout (`name.near` or a 64-char implicit account). The team creates it; agents never create or invent one.
- [ ] Public repo URL (max 300 chars, not submitted before)
- [ ] Public demo post URL (max 300 chars)
- [ ] "What we built", 20-2000 chars: problem, product, how NEAR fits
- [ ] Consent, read verbatim: "I agree that the organizers may use these details to review our submission and contact us about this hackathon."

## 7. Send

- [ ] Re-read the live HACKATHON.md for rule or date changes.
- [ ] Generate `requestId` once (`node -e 'console.log(crypto.randomUUID())'`) and reuse it on retries.
- [ ] Payload has exactly the 11 fields in the API table and no extras (`website` must be absent). Body under 12000 bytes.
- [ ] Do not commit the payload; it holds personal data.
- [ ] Print the full JSON to the human. **Wait for an explicit yes.**
- [ ] POST to https://nearhackathon.com/api/applications. 201 means saved; tell the human.
- [ ] On 400 fix the listed fields and resend with the same `requestId`. On 409 ask the human; do not change the link or email to get around it. On 503 wait a minute and retry with the same `requestId`.

## 8. After submitting

- [ ] Keep the repo public through judging (starts 2026-11-16; results by 2026-11-18T23:59Z).
- [ ] Keep any hosted demo up to 2026-11-18, ideally 2026-11-25.
- [ ] Payout is a single payment within 30 days of results (Q-016).

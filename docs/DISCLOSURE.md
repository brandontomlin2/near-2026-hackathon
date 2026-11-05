# Disclosure

Answers to the hackathon's disclosure questions (Q-002, Q-003, Q-005 in `docs/HACKATHON.md`).

## Pre-hackathon code (Q-002, Q-003)

None. The first commit in this repository is `992acee`, "chore: initialize repository", committed at 2026-11-03T00:20:04Z (UTC). Git stores it in the committer's local time, UTC-6, as 2026-11-02T18:20:04-06:00. Check: `TZ=UTC git log --reverse --format='%h %cd %s' --date=iso-strict-local | head -1` prints the UTC time (some git versions write it as `+00:00` instead of `Z`); plain `--date=iso-strict` prints the stored -06:00 form. Every commit is dated 2026-11-03 (UTC) or later, inside the hackathon window (submissions open 2026-11-01; code baseline cutoff 2026-10-19 per Q-001; window ends 2026-11-14 UTC). No code was imported from an earlier project, so there is no `pre-hackathon` tag and no baseline diff to link.

## AI-generated code (Q-005)

Effectively all of the code, tests, contract, scripts and documentation in this repository was written by AI coding assistants, mainly Claude Code (Anthropic Claude models), under human direction. The human sets the goals and constraints, reviews pull requests, and decides what is submitted, published, signed or spent. The human did not hand-write the code; the human's work is direction, review and approval.

What git shows: every commit on `main` carries a `Co-authored-by` or `Co-Authored-By` trailer naming an AI agent (Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 or plain Claude; Cursor Agent; or the local worker identities "Hack Pilot" and "hp"), except three: the merge commit `4f709b7` (PR #2), and `6ae0563` and `ccdadea`, which are authored under the human's name. Git cannot say who wrote those two, so trailers give a lower bound on AI-written commits, not a claim about them. The commit author field is not evidence either way: nearly all commits are authored under the human's GitHub identity and a few under a default "Your Name" identity, because the sessions committed through the human's git configuration. This holds as of `dc480da` (155 commits); later commits are not recounted here. Reproduce the count with `git log --format=%B | grep -ciE '^co-authored-by:.*(claude|cursor|hack pilot|hp <)'` (counts trailer lines, not commits; a commit can carry several).

## Third-party libraries (Q-005)

### Node.js

- No npm dependencies. `package.json` has no `dependencies` or `devDependencies`, and the code under `src/` and `scripts/` imports only Node built-ins (`node:*`). Tests use the built-in `node:test` runner. Node 22 or newer is required.

### Rust (smart contract only)

Rust is needed only for the contract steps (`npm run test:contract`, `npm run build:contract`) in `contracts/personality-nft/`. Every other step runs with Node alone. The toolchain is pinned to rustc 1.95.0 with the `wasm32-unknown-unknown` target in `rust-toolchain.toml`.

Direct dependencies in `contracts/personality-nft/Cargo.toml`, with versions locked in `Cargo.lock`:

- `near-sdk` 5.30.0 (runtime dependency of the contract; also a dev-dependency with the `unit-testing` feature)
- `near-contract-standards` 5.30.0

Direct dependencies in `contracts/yield-vault/Cargo.toml` (the Yield Optimizer vault, same rustc 1.95.0 pin, tested with `cargo test` in that directory), with versions locked in its own `Cargo.lock`:

- `near-sdk` 5.30.0 (runtime dependency; also a dev-dependency with the `unit-testing` feature)

The vault calls the Rhea (Ref Finance) testnet exchange contract `ref-finance-101.testnet` at runtime; no Ref code is vendored or imported.

The vault's sandbox integration tests are a separate crate, `contracts/yield-vault/sandbox/` (not built by `cargo test` in the vault directory or by `scripts/verify.sh`), with its own `Cargo.lock`. Its direct dev-dependencies, from `contracts/yield-vault/sandbox/Cargo.toml`: `near-workspaces` 0.24.0 (downloads a local sandbox node binary on first run), `tokio` 1, `serde_json` 1, `anyhow` 1 and `reqwest` 0.13. Its mock contracts (`contracts/yield-vault/sandbox/mocks/`, `mock-ft` and `mock-ref`, never deployed) depend on `near-sdk` 5.30.0. `mock-ref` mimics Ref's method names, JSON argument shapes and inner withdraw gas, which were checked against two public GitHub copies of Ref's `ref-exchange/src` (jumbo-exchange/contracts and rozgo/ref-contracts), because the canonical ref-finance/ref-contracts repository was not reachable; its bodies are much simpler than Ref's. The source note at the top of `mock-ref/src/lib.rs` lists what was mirrored and from where.

`Cargo.lock` also pins their transitive dependencies. Building a contract to wasm needs [cargo-near](https://github.com/near/cargo-near), a build tool that is not a dependency of the crate.

### Agent skills and templates

- `.agents/skills/` (symlinked into `.claude/skills/`) holds NEAR agent skills installed from the hackathon starter material, with versions pinned in `skills-lock.json`. They are documentation for coding agents. They are not imported by the product.
- No application template or boilerplate was used.

### Shade / chain-signature spike (`spikes/shade/`, `docs/spikes/shade-agent.md`)

- `spikes/shade/chainsig.mjs` reimplements, with no dependencies, the key-derivation and sign-request logic of the NEAR MPC signer contract (`near/mpc`, files `kdf.rs`, `sign.rs`, `deposits.rs` under `crates/`), so derived keys can be computed offline. It was written from reading that source; none of it was copied or vendored. The derived keys match live `v1.signer-prod.testnet` view calls byte for byte (`spikes/shade/evidence/testnet-mpc-views.txt`).
- The design note also draws on the NearDeFi `shade-agent-template` and shade-agent framework repositories (github.com/NearDeFi), which were read in local clones that are not kept. Their exact repository names, commit SHAs, file paths and line numbers are unverified, and the note marks them as such. No code from them is in this repository.
- `src/yield/shade/` and `scripts/yield-shade-dry-run.mjs` (`npm run yield:shade:dry-run`) reuse the spike's derivation (`spikes/shade/chainsig.mjs`) to print the vault runner's Shade Agent plan. The agent contract's `request_signature` method and argument names come from the shade-agent-framework docs (URL in the script's output and in `docs/yield-shade-agent-plan.md`); the plan marks the rest of that call as unconfirmed.
- Unverified: everything that needs a signature. No transaction was signed or sent; the sign request, nonce, block hash and gas figures in the dry run are placeholders or contract minimums, and no TEE attestation was produced.

## Other notes

- Mock and testnet status: the demo is mock or dry-run only. Nothing is deployed to testnet or mainnet, nothing is signed or sent, and NEAR Intents (mainnet-only) is not used.
- Not covered by the MIT license in `LICENSE`: the third-party libraries above and the installed agent skills keep their own licenses.

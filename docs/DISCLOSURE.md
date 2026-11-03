# Disclosure

Answers to the hackathon's disclosure questions (Q-002, Q-003, Q-005 in `docs/HACKATHON.md`).

## Pre-hackathon code (Q-002, Q-003)

None. The first commit in this repository is `992acee`, "chore: initialize repository", committed at 2026-11-03T00:20:04Z (UTC). Git stores it in the committer's local time, UTC-6, as 2026-11-02T18:20:04-06:00. Check: `TZ=UTC git log --reverse --format='%h %cd %s' --date=iso-strict-local | head -1` prints the UTC time (some git versions write it as `+00:00` instead of `Z`); plain `--date=iso-strict` prints the stored -06:00 form. Every commit is dated 2026-11-03 (UTC) or later, inside the hackathon window (2026-11-01 to 2026-11-14 UTC). No code was imported from an earlier project, so there is no `pre-hackathon` tag and no baseline diff to link.

## AI-generated code (Q-005)

Effectively all of the code, tests, contract, scripts and documentation in this repository was written by AI coding assistants, mainly Claude Code (Anthropic Claude models), under human direction. The human sets the goals and constraints, reviews pull requests, and decides what is submitted, published, signed or spent. The human did not hand-write the code; the human's work is direction, review and approval.

What git shows, at `31895c7` (122 commits): 119 commits carry a `Co-authored-by` or `Co-Authored-By` trailer naming an AI agent (Claude Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 or plain Claude; Cursor Agent; or the local worker identities "Hack Pilot" and "hp"). The other 3 carry no AI trailer: the merge commit `4f709b7` (PR #2), and `6ae0563` and `ccdadea`, which are authored under the human's name. Git cannot say who wrote those two, so the count of AI-written commits is a lower bound from trailers, not a claim about the remaining two. The commit author field is not evidence either way: 117 commits are authored under the human's GitHub identity and 5 under a default "Your Name" identity, because the sessions committed through the human's git configuration. Reproduce the count with `git log --format=%B | grep -ciE '^co-authored-by:.*(claude|cursor|hack pilot|hp <)'` (counts trailer lines, not commits; a commit can carry several).

## Third-party libraries (Q-005)

### Node.js

- No npm dependencies. `package.json` has no `dependencies` or `devDependencies`, and the code under `src/` and `scripts/` imports only Node built-ins (`node:*`). Tests use the built-in `node:test` runner. Node 22 or newer is required.

### Rust (smart contract only)

Rust is needed only for the contract steps (`npm run test:contract`, `npm run build:contract`) in `contracts/personality-nft/`. Every other step runs with Node alone. The toolchain is pinned to rustc 1.95.0 with the `wasm32-unknown-unknown` target in `rust-toolchain.toml`.

Direct dependencies in `contracts/personality-nft/Cargo.toml`, with versions locked in `Cargo.lock`:

- `near-sdk` 5.30.0 (dev-dependency with the `unit-testing` feature)
- `near-contract-standards` 5.30.0

`Cargo.lock` also pins their transitive dependencies. Building the contract to wasm needs [cargo-near](https://github.com/near/cargo-near), a build tool that is not a dependency of the crate.

### Agent skills and templates

- `.agents/skills/` (symlinked into `.claude/skills/`) holds NEAR agent skills installed from the hackathon starter material, with versions pinned in `skills-lock.json`. They are documentation for coding agents. They are not imported by the product.
- No application template or boilerplate was used.

## Other notes

- Not covered by the MIT license in `LICENSE`: the third-party libraries above and the installed agent skills keep their own licenses.

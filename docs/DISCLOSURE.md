# Disclosure

Answers to the hackathon's disclosure questions (Q-002, Q-003, Q-005 in `docs/HACKATHON.md`).

## Pre-hackathon code (Q-002, Q-003)

None. The first commit in this repository is `992acee`, "chore: initialize repository", dated 2026-11-02. Check: `git log --reverse --format='%h %ad %s' --date=short | head`. Every commit is dated 2026-11-02 or later, inside the hackathon window (2026-11-01 to 2026-11-14 UTC). No code was imported from an earlier project, so there is no `pre-hackathon` tag and no baseline diff to link.

## AI-generated code (Q-005)

The code, tests, contract, scripts and documentation in this repository were written with AI coding assistants, mainly Claude Code (Anthropic Claude models), under human direction. The human sets the goals and constraints, reviews pull requests, and decides what is submitted, published, signed or spent. Claude Code sessions, including parallel worker sessions and review sessions, wrote and reviewed most commits, and each change lands through a pull request.

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

<!--
NOT DEPLOYED. NOT BUILT. NOT PUSHED anywhere. Draft for review.
Deploying needs the owner's (Brandon's) explicit yes. Values are placeholders.
-->
# deploy/shade (draft)

Draft deployment files for running the yield vault runner as a Shade Agent. Read `docs/yield-shade-agent-plan.md` first; it has the architecture, the confirmed/unconfirmed table, costs and the go/no-go.

Files
- `docker-compose.yaml`: agent service, dstack socket mount, dry-run defaults. Image is a placeholder.
- `deployment.yaml`: shade-agent-cli manifest shape from the official template. Defaults to `environment: local`, Docker build and Phala deploy disabled.
- Environment: the deploy env file is NOT in this repo and must never be committed. It needs `AGENT_CONTRACT_ID`, `SPONSOR_ACCOUNT_ID`, `SPONSOR_PRIVATE_KEY` (template names) and `VAULT_ID`, `EXECUTOR_ACCOUNT_ID`, `DERIVATION_PATH` (our names, unconfirmed). Keep the sponsor key funded with small testnet amounts only.

Status and gaps
- Nothing here has been run. There is no Dockerfile or agent-contract source in this directory.
- The framework is deprecated since 2026-04-19 (https://docs.near.org/ai/shade-agents/introduction) and unaudited.
- Manifest keys may differ from the current CLI (see comments in `deployment.yaml`); run `shade plan` first.
- The runtime defaults to `YIELD_SHADE_DRY_RUN=1` and `NEAR_NETWORK=testnet`. Anything that signs, deploys, pushes an image or spends needs Brandon's explicit yes.
- To review offline: `npm run yield:shade:dry-run` and `gtimeout 900 node --test src/yield/shade/*.test.mjs spikes/shade/*.test.mjs`.

# Yield vault live testnet runbook

## Status

- Nothing is deployed. No account named here exists. No transaction in this document has been signed or sent.
- Every step that changes chain state needs Brandon's explicit yes, one step or batch at a time. Do not run a block of steps on a single yes unless he said so.
- Testnet only. Mainnet is refused by the tooling and must not be used.
- This runbook was produced and dry-run checked: `node scripts/yield-live.mjs dry-run` validates the plan against `contracts/yield-vault/src/lib.rs`. It has never been executed. Every command below is copied from that tool's output for `config/yield-vault.live.example.json`, with its placeholders. `scripts/yield-live-runbook.test.mjs` fails if the two drift.
- A later alternative to the keychain-signed runner in step 19 is a Shade Agent runner: `npm run yield:shade:dry-run` prints its payloads offline, and the owner's go/no-go checklist is [docs/yield-shade-go-nogo.md](yield-shade-go-nogo.md). Nothing in either is done, and each signing step there needs the owner's explicit yes.
- Anything marked UNCONFIRMED was not verified from a first-party source or a live call; the "Verification table" and "Known gaps" say what to check.

## Cost and time

- Owner outflow for the full path: 8.525 NEAR plus 7 yocto (the 1 yocto security deposits). Of that, 6 NEAR funds the vault account (about 2.62 NEAR is its wasm storage), 2 NEAR funds the runner, 0.5 NEAR goes to Ref storage, and 0.02 NEAR becomes wNEAR. Most of it comes back through the rollback steps (Ref storage via step 29, vault and runner balances via the account deletions in steps 35 and 36).
- 19 transactions and 17 read-only calls, 1120 TGas prepaid in total. Prepaid gas is an upper bound; unused gas is refunded. The real gas cost was not measured (UNCONFIRMED); at the usual testnet gas price it is a small fraction of 1 NEAR.
- The owner needs the outflow above plus gas. Have at least 10 NEAR in the owner account.
- Time estimate (not measured): 45 to 90 minutes of operator time for the full path, mostly spent confirming each step. The swap chain (step 19) settles in under a few minutes if nothing fails; a stuck swap adds a 10 minute wait for force release.

## Before you start

1. Check the toolchain and plan (offline, no network, no keys):

```bash
npm run yield:live:preflight
```

   The same checks plus read-only chain lookups (existing accounts, balances, Ref and token reads) are available as `npm run yield:live:preflight -- --online`. It makes only read-only view calls and uses no keys. Online it also confirms the RPC is testnet (wrap.testnet exists) and FAILs if the vault or runner account already exists. `vault_id` and `runner_id` must be direct sub-accounts of the owner (for example `vault.<owner>`).
2. Copy the example config to a path that git ignores (`out/` is in `.gitignore`) and fill it in. Do not edit the tracked example.

```bash
mkdir -p out && cp config/yield-vault.live.example.json out/yield-vault.live.json
```

   Replace every `<FILL_ME>`, `owner_id`, `vault_id`, `runner_id`, `nft_contract_id`, and set `"placeholders": false`. The tool accepts public keys only and refuses anything that looks like a private key. Then pass `--config out/yield-vault.live.json` to `dry-run` and `preflight`. The commands in this document use the example config, so with your own config the ids, keys and token id in them will differ; re-run `dry-run --config out/yield-vault.live.json` and use its output.
3. Keys. Create the vault and runner key pairs in the near-cli-rs keychain (for example with `near account create-account ... autogenerate-new-keypair save-to-keychain` or `near account add-key`, see the repo skill `.agents/skills/near-cli-rs/SKILL.md`), and put only the two public keys in the config. The owner key must also be in the keychain (`near account import-account` or the faucet creation below). No key belongs in this repository, the config, or this document.
4. Fund the owner. Create a testnet owner account through the built-in faucet (`near account create-account sponsor-by-faucet-service <OWNER_ID> ... network-config testnet create`, syntax per the repo skill) or use https://near-faucet.io/ for more NEAR. The faucet amount is not documented (UNCONFIRMED); the owner needs at least 10 NEAR before step 1.
5. Make sure the NFT contract and token id in the config exist. The vault only records them; the contract does not verify them.

## Step 0: build, preflight, dry-run

```bash
cd contracts/yield-vault && cargo near build non-reproducible-wasm
```

Expected: exit 0 in about 33 seconds. Output: `contracts/yield-vault/target/near/yield_vault.wasm` (261718 bytes, about 2.62 NEAR of storage at 1e19 yocto per byte) and `yield_vault_abi.json` next to it. The wasm is not reproducible, so its hash will differ on another machine.

```bash
npm run yield:live:preflight
node scripts/yield-live.mjs dry-run
```

Expected with the example config: preflight prints PASS for config ids, plan validity, wasm present and size, storage estimate, wasm newer than src/lib.rs, the lib.rs parse and the plan agreeing with the built ABI, cargo and cargo-near; MISSING for the unfilled placeholders; MANUAL for owner funds, keychain keys, the NFT and Ref's storage bound; and ends with `READY FOR LIVE: no`. With your filled config the MISSING line must disappear. The MANUAL items need your own confirmation. `dry-run` prints 36 steps and the totals line `19 transactions, 17 views`, then a "filled at run time" list of 3 amounts (the two withdraw steps and withdraw_near) and `plan valid against contracts/yield-vault/src/lib.rs`. Do not continue unless both say the plan is valid.

## Plan steps

Three amounts are not fixed in advance: the withdraw steps and the `withdraw_near` step carry a marker such as `<READ get_balance(TOKEN) at step ID>` that you replace with the value the referenced view step returned (the tool lists them under "filled at run time"). `withdraw` rejects a zero amount, so skip a withdraw whose value is 0.

Each step below shows the exact near-cli-rs command, the expected result, the cost, what the plan expects, and what to do if it fails. Failure handling for the swap chain is in `contracts/yield-vault/README.md` ("Failure handling", "Force release"). Read-only steps use `as-read-only` and cost nothing.

### Phase: Setup

#### Step 1 [setup] create and fund the vault account

```bash
near account create-account fund-myself vault.owner.yield-demo.testnet '6 NEAR' use-manually-provided-public-key 'ed25519:<FILL_ME>' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 6 NEAR.
- Expected result: near-cli-rs prints the signed transaction result and a success line. Account creation is final once the transaction executes.
- Check (the plan's expectation): vault.owner.yield-demo.testnet exists with 6 NEAR and the vault key
- If it fails: If the id is taken or the owner balance is too low, the transaction fails and nothing is created; fix the config or fund the owner and re-run. Do not re-run after success (the account exists). The vault key is the only key on this account: if `public_keys.vault` does not match the keychain, steps 3 and 35 cannot be signed, so check it before this step.

#### Step 2 [setup] create and fund the runner account

```bash
near account create-account fund-myself runner.owner.yield-demo.testnet '2 NEAR' use-manually-provided-public-key 'ed25519:<FILL_ME>' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `runner.owner.yield-demo.testnet`.
- Cost: 2 NEAR.
- Expected result: Same as step 1 for the runner account.
- Check (the plan's expectation): runner.owner.yield-demo.testnet exists with 2 NEAR and the runner key
- If it fails: Same as step 1. The runner key must match `public_keys.runner`; execute_swap in step 19 is signed with it.

#### Step 3 [setup] deploy the vault wasm and call new in one transaction

```bash
near contract deploy vault.owner.yield-demo.testnet use-file contracts/yield-vault/target/near/yield_vault.wasm with-init-call new json-args '{"owner_id":"owner.yield-demo.testnet","nft_contract_id":"personality-nft.yield-demo.testnet","token_id":"<FILL_ME>","ref_exchange_id":"ref-finance-101.testnet","config":{"strategy":"chaotic","allowed_pools":[{"pool_id":0,"token_a":"wrap.testnet","token_b":"rft.tokenfactory.testnet","min_rate_a_to_b":{"num":"1770923779569","den":"374136952131431998480120321"},"min_rate_b_to_a":{"num":"374136952131431998480120321","den":"7083695118276"}}],"limits":[{"token_id":"wrap.testnet","max_trade":"10000000000000000000000000","daily_cap":"30000000000000000000000000"},{"token_id":"rft.tokenfactory.testnet","max_trade":"100000000000","daily_cap":"300000000000"}],"runners":["runner.owner.yield-demo.testnet"]}}' prepaid-gas '100 Tgas' attached-deposit '0 NEAR' network-config testnet sign-with-keychain send
```

- Signer: `vault.owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: One transaction with two actions: DeployContract (261718 bytes, about 2.62 NEAR of storage out of the 6 NEAR the vault holds) and FunctionCall `new`. near-cli-rs shows both actions succeeding.
- Check (the plan's expectation): both actions succeed (new is only callable by the vault account itself, so it must be this transaction)
- If it fails: `new` is private: it panics with ERR_PRIVATE_INIT unless the signer is the vault account itself, so never call it from the owner. ERR_BAD_CONFIG means the config body is invalid (see the vault README, "Hard rules"). A failed batch rolls back the deploy too, so the account stays empty and the step can be re-run. If the deploy fails for balance, the 6 NEAR is too small for the wasm; raise `funding.vault_initial_near` and start from a fresh vault account.

### Phase: Check

#### Step 4 [check] read the stored config

```bash
near contract call-function as-read-only vault.owner.yield-demo.testnet get_config json-args '{}' network-config testnet now
```

- Signer: none (read-only); receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: A JSON object with `strategy`, `allowed_pools`, `limits`, `runners`.
- Check (the plan's expectation): runners == [runner.owner.yield-demo.testnet], strategy == chaotic
- If it fails: If the call fails with "account does not exist" or "no contract code", step 3 did not complete. If `runners` or `strategy` differ from the config, do not continue: `update_config` (owner, 1 yocto) can correct limits, but a wrong runner is better fixed with `revoke_runner` / `add_runner`.

#### Step 5 [check] read the vault state

```bash
near contract call-function as-read-only vault.owner.yield-demo.testnet get_state json-args '{}' network-config testnet now
```

- Signer: none (read-only); receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: A VaultState object. `paused: false`, `swap_in_flight: false`, `recovery_in_flight: false`, `release_in_flight: false`, `swaps_executed: 0`, empty `balances`.
- Check (the plan's expectation): paused == false, nothing in flight
- If it fails: Any in-flight flag true here means state is not fresh; stop and inspect before continuing.

#### Step 6 [check] read wrap.testnet's storage bounds

```bash
near contract call-function as-read-only wrap.testnet storage_balance_bounds json-args '{}' network-config testnet now
```

- Signer: none (read-only); receiver: `wrap.testnet`.
- Cost: 0 NEAR.
- Expected result: JSON `{"min":"1250000000000000000000","max":"1250000000000000000000"}` (0.00125 NEAR, as read on 2026-11-05).
- Check (the plan's expectation): min <= 0.00125 NEAR (token_storage_deposit_near)
- If it fails: If the bounds differ from `token_storage_deposit_near` in the config, the next step attaches the wrong amount; fix the config and re-run `dry-run` before continuing.

### Phase: Fund

#### Step 7 [fund] register the vault on wrap.testnet

```bash
near contract call-function as-transaction wrap.testnet storage_deposit json-args '{"account_id":"vault.owner.yield-demo.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `wrap.testnet`.
- Cost: 0.00125 NEAR.
- Expected result: The token contract returns a storage balance object `{total, available}` for the vault. Bounds are fixed at 0.00125 NEAR (CONFIRMED by a read-only call on 2026-11-05).
- Check (the plan's expectation): wrap.testnet storage_balance_of(vault.owner.yield-demo.testnet) is not null
- If it fails: If this is skipped or fails, `ft_transfer` and `ft_transfer_call` to the vault fail on this token. Re-run is harmless: an already registered account is refunded the attached deposit.

#### Step 8 [fund] register the owner on wrap.testnet (so withdrawals can land)

```bash
near contract call-function as-transaction wrap.testnet storage_deposit json-args '{"account_id":"owner.yield-demo.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `wrap.testnet`.
- Cost: 0.00125 NEAR.
- Expected result: Same as step 7 for the owner account. Needed so `withdraw` can pay the owner.
- Check (the plan's expectation): wrap.testnet storage_balance_of(owner.yield-demo.testnet) is not null
- If it fails: If skipped, the vault `withdraw` ft_transfer fails and `on_owner_withdraw` restores the vault balance.

### Phase: Check

#### Step 9 [check] read rft.tokenfactory.testnet's storage bounds

```bash
near contract call-function as-read-only rft.tokenfactory.testnet storage_balance_bounds json-args '{}' network-config testnet now
```

- Signer: none (read-only); receiver: `rft.tokenfactory.testnet`.
- Cost: 0 NEAR.
- Expected result: Same shape as the previous bounds read, for rft.tokenfactory.testnet (0.00125 NEAR).
- Check (the plan's expectation): min <= 0.00125 NEAR (token_storage_deposit_near)
- If it fails: Same as the previous bounds read.

### Phase: Fund

#### Step 10 [fund] register the vault on rft.tokenfactory.testnet

```bash
near contract call-function as-transaction rft.tokenfactory.testnet storage_deposit json-args '{"account_id":"vault.owner.yield-demo.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `rft.tokenfactory.testnet`.
- Cost: 0.00125 NEAR.
- Expected result: Same as step 7 for rft.tokenfactory.testnet (the swap output token).
- Check (the plan's expectation): rft.tokenfactory.testnet storage_balance_of(vault.owner.yield-demo.testnet) is not null
- If it fails: If skipped, Ref cannot pay the vault on `withdraw`, the reconcile sees no drop, and the output is stranded on Ref (`withdraw_not_reconciled`). Recoverable with `recover_from_ref` after registering.

#### Step 11 [fund] register the owner on rft.tokenfactory.testnet (so withdrawals can land)

```bash
near contract call-function as-transaction rft.tokenfactory.testnet storage_deposit json-args '{"account_id":"owner.yield-demo.testnet","registration_only":true}' prepaid-gas '30 Tgas' attached-deposit '0.00125 NEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `rft.tokenfactory.testnet`.
- Cost: 0.00125 NEAR.
- Expected result: Same as step 7 for the owner on rft.tokenfactory.testnet.
- Check (the plan's expectation): rft.tokenfactory.testnet storage_balance_of(owner.yield-demo.testnet) is not null
- If it fails: If skipped, step 24 fails and the vault restores its balance.

#### Step 12 [fund] wrap 0.02 NEAR into wNEAR

```bash
near contract call-function as-transaction wrap.testnet near_deposit json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0.02 NEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `wrap.testnet`.
- Cost: 0.02 NEAR.
- Expected result: wrap.testnet mints wNEAR to the owner. `near_deposit` is UNCONFIRMED (see Known gaps): the method name is the standard w-near one but wrap.testnet was not inspected.
- Check (the plan's expectation): owner holds at least 20000000000000000000000 wNEAR (ft_balance_of)
- If it fails: If the method does not exist or the call fails, the owner has no wNEAR; use the Ref testnet UI to swap NEAR for wNEAR, or pick a different input token in the config. If the owner is not registered on wrap.testnet (step 8 skipped), this fails.

### Phase: Check

#### Step 13 [check] read Ref's storage bounds

```bash
near contract call-function as-read-only ref-finance-101.testnet storage_balance_bounds json-args '{}' network-config testnet now
```

- Signer: none (read-only); receiver: `ref-finance-101.testnet`.
- Cost: 0 NEAR.
- Expected result: JSON `{"min":"1020000000000000000000","max":null}` as read on 2026-11-05: 0.00102 NEAR minimum, no maximum.
- Check (the plan's expectation): min <= ref_storage_deposit_near; note per-token storage Ref needs
- If it fails: If `min` is above `ref_storage_deposit_near` (0.5 NEAR), do not run step 14 with that value; raise the config value.

### Phase: Fund

#### Step 14 [fund] pay the vault's Ref storage

```bash
near contract call-function as-transaction vault.owner.yield-demo.testnet register_on_ref json-args '{}' prepaid-gas '100 Tgas' attached-deposit '0.5 NEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0.5 NEAR.
- Expected result: The vault calls Ref `storage_deposit { registration_only: false }` with the whole 0.5 NEAR and logs a `registered_on_ref` event. The 0.5 NEAR stays on Ref as the vault storage balance.
- Check (the plan's expectation): registered_on_ref event; Ref storage_balance_of(vault) is not null
- If it fails: On a failed Ref call the protocol refunds the vault and `on_register` forwards it to the owner (`register_failed` event); if the forward fails the NEAR sits on the vault and `withdraw_ref_storage` / `withdraw_near` (steps 29 and 31) move it. Needs 60 TGas minimum (MIN_REGISTER_GAS); the plan attaches 100 TGas. The per-token storage Ref needs is UNCONFIRMED; 0.5 NEAR is deliberately generous, and the unused part is recoverable with step 29.

### Phase: Check

#### Step 15 [check] read the vault's Ref storage balance

```bash
near contract call-function as-read-only ref-finance-101.testnet storage_balance_of json-args '{"account_id":"vault.owner.yield-demo.testnet"}' network-config testnet now
```

- Signer: none (read-only); receiver: `ref-finance-101.testnet`.
- Cost: 0 NEAR.
- Expected result: JSON `{"total":"500000000000000000000000","available":"..."}`; `available` is what `withdraw_ref_storage` can pull back.
- Check (the plan's expectation): total >= storage_balance_bounds.min
- If it fails: null means registration did not happen: repeat step 14 or read the vault README "Ref storage".

### Phase: Fund

#### Step 16 [fund] deposit 20000000000000000000000 of wrap.testnet into the vault

```bash
near contract call-function as-transaction wrap.testnet ft_transfer_call json-args '{"receiver_id":"vault.owner.yield-demo.testnet","amount":"20000000000000000000000","msg":""}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `wrap.testnet`.
- Cost: 0.000000000000000000000001 NEAR.
- Expected result: wrap.testnet moves 20000000000000000000000 (0.02 wNEAR) to the vault and calls `ft_on_transfer`; the vault accepts it because wrap.testnet is in an allowed pool and the sender is the owner. A `deposit` event is logged and `ft_transfer_call` resolves with 0 unused.
- Check (the plan's expectation): vault ft_on_transfer accepts the owner's deposit (token is in an allowed pool): deposit event, nothing refunded
- If it fails: The vault refunds in full (the token returns the amount to the owner) if the sender is not the owner, the token is not in an allowed pool, the amount is 0, a force release is pending, or a `sync_balance` read is pending. Pausing does not refuse deposits. Check `get_state` and the transaction logs.

### Phase: Check

#### Step 17 [check] read the vault's tracked balance

```bash
near contract call-function as-read-only vault.owner.yield-demo.testnet get_balance json-args '{"token_id":"wrap.testnet"}' network-config testnet now
```

- Signer: none (read-only); receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: The string "20000000000000000000000".
- Check (the plan's expectation): == 20000000000000000000000
- If it fails: A smaller value or "0" means the deposit was refunded; look at the step 16 receipts.

#### Step 18 [check] run the swap rules without side effects

```bash
near contract call-function as-read-only vault.owner.yield-demo.testnet check_proposal json-args '{"proposal":{"pool_id":0,"token_in":"wrap.testnet","token_out":"rft.tokenfactory.testnet","amount_in":"10000000000000000000000","min_amount_out":"50000000"},"runner_id":"runner.owner.yield-demo.testnet"}' network-config testnet now
```

- Signer: none (read-only); receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: JSON `{"ok":true,"reason":""}`.
- Check (the plan's expectation): ok == true
- If it fails: When `ok` is false, `reason` is "ERR_CODE: detail" (for example ERR_NO_LIMIT, ERR_MAX_TRADE, ERR_PRICE_FLOOR, ERR_DAILY_CAP). Fix the config or the amounts (`update_config`) before step 19. Do not run step 19 with `ok: false`; it would panic and lose only gas.

### Phase: Swap

#### Step 19 [swap] runner swaps 10000000000000000000000 wrap.testnet -> rft.tokenfactory.testnet on pool 0

```bash
near contract call-function as-transaction vault.owner.yield-demo.testnet execute_swap json-args '{"proposal":{"pool_id":0,"token_in":"wrap.testnet","token_out":"rft.tokenfactory.testnet","amount_in":"10000000000000000000000","min_amount_out":"50000000"}}' prepaid-gas '280.0 Tgas' attached-deposit '0 NEAR' sign-as runner.owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `runner.owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: The transaction itself returns after the first receipt; the swap chain (ft_transfer_call to Ref, on_deposit, Ref swap, on_swap, pre-withdraw read, Ref withdraw, reconcile) takes several more blocks. Poll step 20 until `swap_in_flight` is false. Logs end in a `swap_executed` event.
- Check (the plan's expectation): swap_executed event; balance of token_out >= min_amount_out
- If it fails: This is the step most likely to fail and the least tested: no gas figure has been measured on Ref. 280 TGas attached, exactly the 280 TGas minimum (MIN_EXECUTE_GAS, checked with `>=`). If it fails for lack of gas, NEAR allows up to 1 PGas per transaction so you may attach more, but the near-cli-rs skill documents 300 Tgas as its maximum (UNCONFIRMED against upstream). Read the vault README "Failure handling" table. If funds are stranded on Ref the vault records them in `stranded_on_ref` / `unverified_on_ref`. If a callback never ran, wait 10 minutes, then use the force release procedure in the Rollback section.

### Phase: Check

#### Step 20 [check] read the vault state after the swap

```bash
near contract call-function as-read-only vault.owner.yield-demo.testnet get_state json-args '{}' network-config testnet now
```

- Signer: none (read-only); receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: `swap_in_flight: false`, `swaps_executed: 1`, `stranded_on_ref` and `unverified_on_ref` empty, `balances` holding wrap.testnet (0.01) and rft.tokenfactory.testnet.
- Check (the plan's expectation): no swap in flight, swaps_executed == 1, nothing stranded
- If it fails: `swap_in_flight: true` after about 2 minutes: keep polling; after 10 minutes see force release. Non-empty `stranded_on_ref`: output or a swap refund could not be withdrawn (a plain failed swap is refunded automatically with a `swap_refunded` event and does not strand); use `recover_from_ref` (Rollback section).

#### Step 21 [check] read what is left on Ref for token_out

```bash
near contract call-function as-read-only ref-finance-101.testnet get_deposit json-args '{"account_id":"vault.owner.yield-demo.testnet","token_id":"rft.tokenfactory.testnet"}' network-config testnet now
```

- Signer: none (read-only); receiver: `ref-finance-101.testnet`.
- Cost: 0 NEAR.
- Expected result: The string "0".
- Check (the plan's expectation): 0 (the chain withdrew it back to the vault)
- If it fails: A non-zero value means the output is still on Ref (and should appear in `stranded_on_ref`). Do not delete the vault until it is zero.

#### Step 22 [check] read the vault's token_out balance

```bash
near contract call-function as-read-only vault.owner.yield-demo.testnet get_balance json-args '{"token_id":"rft.tokenfactory.testnet"}' network-config testnet now
```

- Signer: none (read-only); receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: A U128 string at or above 50000000 (0.5 rft at 8 decimals): the whole token_out balance. Write the value down: the withdraw step needs it.
- Check (the plan's expectation): >= 50000000
- If it fails: Below the floor cannot happen after `swap_executed` (the contract enforces min_amount_out); 0 means the swap did not complete.

#### Step 23 [check] read the vault's unswapped token_in balance

```bash
near contract call-function as-read-only vault.owner.yield-demo.testnet get_balance json-args '{"token_id":"wrap.testnet"}' network-config testnet now
```

- Signer: none (read-only); receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: A U128 string: the unswapped wrap.testnet balance, 10000000000000000000000 (0.01 wNEAR) in the example. Write the value down: the next step needs it.
- Check (the plan's expectation): 10000000000000000000000 if the swap took exactly amount_in (Ref may accept less)
- If it fails: A value other than the deposit minus `amount_in` means the swap or an earlier withdraw did not do what was expected; read `get_state` before withdrawing.

### Phase: Withdraw

#### Step 24 [withdraw] owner withdraws the whole token_out balance of rft.tokenfactory.testnet

```bash
near contract call-function as-transaction vault.owner.yield-demo.testnet withdraw json-args '{"token_id":"rft.tokenfactory.testnet","amount":"<READ get_balance(rft.tokenfactory.testnet) at step view-balance-2>"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0.000000000000000000000001 NEAR.
- Expected result: RUN-TIME VALUE. The amount in this command is a marker, not a literal. Before running it, replace the whole marker text (including the angle brackets) with the value returned by step 22 (`get_balance` of rft.tokenfactory.testnet), as a plain string of digits, keeping the quotes around it. The tool lists these in the "filled at run time" part of the `dry-run` output. The vault debits, calls `ft_transfer` to the owner, and `on_owner_withdraw` confirms; a `withdraw` event is logged. Afterward the vault balance of rft.tokenfactory.testnet is 0.
- Check (the plan's expectation): withdraw event; owner ft_balance_of(token_out) rose; the vault's token_out balance is 0
- If it fails: If the value read is 0 there is nothing to withdraw (the swap did not credit it). Needs 80 TGas minimum (MIN_WITHDRAW_GAS); the plan attaches 100. On a failed `ft_transfer` the callback restores the vault balance. Refused with ERR_RELEASE_PENDING while a force release reconciles; ERR_ZERO_AMOUNT for a zero amount.

#### Step 25 [withdraw] owner withdraws the unswapped wrap.testnet balance

```bash
near contract call-function as-transaction vault.owner.yield-demo.testnet withdraw json-args '{"token_id":"wrap.testnet","amount":"<READ get_balance(wrap.testnet) at step view-balance-3>"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0.000000000000000000000001 NEAR.
- Expected result: RUN-TIME VALUE. The amount in this command is a marker, not a literal. Before running it, replace the whole marker text (including the angle brackets) with the value returned by step 23 (`get_balance` of wrap.testnet), as a plain string of digits, keeping the quotes around it. The tool lists these in the "filled at run time" part of the `dry-run` output. SKIP this step if that value is 0, because `withdraw` rejects a zero amount. The vault passes `skip_unwrap_near: true` to Ref, so tokens stay wNEAR; this withdraw also pays wNEAR, not NEAR.
- Check (the plan's expectation): withdraw event; vault get_balance(token_in) == 0. Skip this step if the value read is 0 (withdraw rejects a zero amount).
- If it fails: Same as the previous withdraw. Afterward `get_balance(wrap.testnet)` should be "0".

### Phase: Check

#### Step 26 [check] read the owner's token_out balance

```bash
near contract call-function as-read-only rft.tokenfactory.testnet ft_balance_of json-args '{"account_id":"owner.yield-demo.testnet"}' network-config testnet now
```

- Signer: none (read-only); receiver: `rft.tokenfactory.testnet`.
- Cost: 0 NEAR.
- Expected result: A string at or above 50000000 (more if the owner held rft before).
- Check (the plan's expectation): >= 50000000
- If it fails: If unchanged, the step 24 transfer failed; check owner registration on rft.tokenfactory.testnet (step 11).

### Phase: Rollback

#### Step 27 [rollback] pause the vault

```bash
near contract call-function as-transaction vault.owner.yield-demo.testnet pause json-args '{}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0.000000000000000000000001 NEAR.
- Expected result: A `paused` event. From now on `execute_swap` is refused (`ERR_PAUSED`). Owner deposits through `ft_on_transfer` are still accepted; `pause` does not check them.
- Check (the plan's expectation): paused event
- If it fails: Needs exactly 1 yocto and the owner key; ERR_NOT_OWNER otherwise.

#### Step 28 [rollback] revoke every runner

```bash
near contract call-function as-transaction vault.owner.yield-demo.testnet revoke_all_runners json-args '{}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0.000000000000000000000001 NEAR.
- Expected result: A `runner_revoked` event; `get_config().runners` is empty. This also pauses the vault.
- Check (the plan's expectation): runner_revoked event; get_config().runners == []
- If it fails: Needs exactly 1 yocto and the owner key.

#### Step 29 [rollback] pull the Ref storage balance back to the vault account

```bash
near contract call-function as-transaction vault.owner.yield-demo.testnet withdraw_ref_storage json-args '{}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0.000000000000000000000001 NEAR.
- Expected result: The vault calls Ref `storage_withdraw`; Ref returns its available storage balance to the vault account; an `ref_storage_withdraw` event is logged. Not run against Ref yet.
- Check (the plan's expectation): ref_storage_withdraw event; NEAR returns to the vault account
- If it fails: Needs 40 TGas minimum (MIN_STORAGE_WITHDRAW_GAS). Ref may return less than the full 0.5 NEAR if it must keep storage for the vault token entries (UNCONFIRMED; compare `storage_balance_of` from step 15 before and after). Read step 15 again afterwards; NEAR left on Ref is not returned by deleting the vault.

### Phase: Check

#### Step 30 [check] read how much NEAR the owner can withdraw

```bash
near contract call-function as-read-only vault.owner.yield-demo.testnet get_withdrawable_near json-args '{}' network-config testnet now
```

- Signer: none (read-only); receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: A U128 string: account balance minus storage cost minus a 0.1 NEAR reserve. Write the value down: the withdraw_near step needs it.
- Check (the plan's expectation): the amount withdraw_near takes next (account balance minus storage cost minus a 0.1 NEAR reserve)
- If it fails: If it is 0, skip `withdraw_near`; the account deletion later sends the remainder to the owner anyway.

### Phase: Rollback

#### Step 31 [rollback] send the free NEAR from the vault to the owner

```bash
near contract call-function as-transaction vault.owner.yield-demo.testnet withdraw_near json-args '{"amount":"<READ get_withdrawable_near() at step view-withdrawable>"}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0.000000000000000000000001 NEAR.
- Expected result: RUN-TIME VALUE. The amount in this command is a marker, not a literal. Before running it, replace the whole marker text (including the angle brackets) with the value returned by step 30 (`get_withdrawable_near`), as a plain string of digits, keeping the quotes around it. The tool lists these in the "filled at run time" part of the `dry-run` output. SKIP this step if that value is 0. The vault transfers that NEAR to the owner and logs `near_withdrawn`. Optional if you are about to delete the vault, which sends the remainder to the owner.
- Check (the plan's expectation): near_withdrawn event. Skip this step if the value read is 0. Optional: delete-vault sends the remaining NEAR to the owner anyway.
- If it fails: ERR_INSUFFICIENT_NEAR when the amount exceeds the value read; read the view again right before running, since the balance can change.

### Phase: Check

#### Step 32 [check] read the vault state before deleting it

```bash
near contract call-function as-read-only vault.owner.yield-demo.testnet get_state json-args '{}' network-config testnet now
```

- Signer: none (read-only); receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: Everything empty or zero: `balances`, `stranded_on_ref`, `unverified_on_ref`, and all of `swap_in_flight`, `recovery_in_flight`, `release_in_flight` false.
- Check (the plan's expectation): balances, stranded_on_ref, unverified_on_ref all empty or zero; swap_in_flight, recovery_in_flight, release_in_flight false
- If it fails: Do not run step 35 until this is clean. Use the Rollback section to clear each non-empty item.

#### Step 33 [check] read what Ref still holds of wrap.testnet for the vault

```bash
near contract call-function as-read-only ref-finance-101.testnet get_deposit json-args '{"account_id":"vault.owner.yield-demo.testnet","token_id":"wrap.testnet"}' network-config testnet now
```

- Signer: none (read-only); receiver: `ref-finance-101.testnet`.
- Cost: 0 NEAR.
- Expected result: The string "0".
- Check (the plan's expectation): 0
- If it fails: Non-zero: tokens are still on Ref for the vault; recover them first. Deleting the account would destroy them.

#### Step 34 [check] read what Ref still holds of rft.tokenfactory.testnet for the vault

```bash
near contract call-function as-read-only ref-finance-101.testnet get_deposit json-args '{"account_id":"vault.owner.yield-demo.testnet","token_id":"rft.tokenfactory.testnet"}' network-config testnet now
```

- Signer: none (read-only); receiver: `ref-finance-101.testnet`.
- Cost: 0 NEAR.
- Expected result: The string "0".
- Check (the plan's expectation): 0
- If it fails: Same as step 33.

### Phase: Rollback

#### Step 35 [rollback] delete the vault account (destroys any tokens it still holds on token contracts or Ref)

```bash
near account delete-account vault.owner.yield-demo.testnet beneficiary owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `vault.owner.yield-demo.testnet`; receiver: `vault.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: The account is removed and its remaining NEAR is sent to the owner. The vault per-token storage deposits (0.00125 NEAR each) and any Ref storage still locked by token entries are forfeited: the plan has no storage_unregister step.
- Check (the plan's expectation): vault.owner.yield-demo.testnet no longer exists. Deleting it destroys any tokens still held for it on the token contracts or on Ref; only run it after the pre-delete checks are clean. The beneficiary owner.yield-demo.testnet receives the remaining NEAR, so withdraw_near is only needed if you keep the account. The vault's per-token storage deposits (0.00125 NEAR each) and any Ref storage still locked by token entries are forfeited: the plan has no storage_unregister step.
- If it fails: IRREVERSIBLE. Tokens still recorded for the vault on any token contract or on Ref are destroyed with it. Run only after steps 32 to 34 are clean and the vault holds no token balance on the token contracts (`ft_balance_of` of each token for the vault is 0).

#### Step 36 [rollback] delete the runner account

```bash
near account delete-account runner.owner.yield-demo.testnet beneficiary owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

- Signer: `runner.owner.yield-demo.testnet`; receiver: `runner.owner.yield-demo.testnet`.
- Cost: 0 NEAR.
- Expected result: The runner account is removed and its NEAR goes to the owner.
- Check (the plan's expectation): runner.owner.yield-demo.testnet no longer exists; its NEAR went to owner.yield-demo.testnet
- If it fails: Needs the runner key. If lost, the 2 NEAR cannot be recovered; that is the only loss.

## Rollback

### Fastest safe stop

Two owner calls, 1 yocto each, 30 TGas each. They are steps 27 and 28 above; run them alone, in this order, at any point after step 3:

```bash
near contract call-function as-transaction vault.owner.yield-demo.testnet pause json-args '{}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
near contract call-function as-transaction vault.owner.yield-demo.testnet revoke_all_runners json-args '{}' prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

After this no runner can start a swap. It blocks swaps only: owner deposits are still accepted and owner withdrawals still work, so stop sending deposits yourself. A swap already in flight continues to its end; it cannot be stopped. `unpause` and `add_runner` (owner, 1 yocto) undo it. Funds stay in the vault until withdrawn.

### Full teardown order

1. Wait for `get_state` to show `swap_in_flight`, `recovery_in_flight` and `release_in_flight` all false. If a swap or recovery is stuck, use the recovery procedures below first.
2. Pause and revoke all runners (steps 27 and 28).
3. Withdraw every token balance to the owner with `withdraw` (steps 24 and 25 pattern; read each amount with `get_balance`).
4. Recover anything on Ref (`stranded_on_ref`, `unverified_on_ref`, or a non-zero `get_deposit`) with `recover_from_ref`, then `withdraw` again.
5. Pull Ref storage back with `withdraw_ref_storage` (step 29), then optionally `withdraw_near` (step 31).
6. Run the pre-delete checks (steps 32 to 34): everything empty or zero.
7. Delete the vault account (step 35), then the runner account (step 36).

WARNING: deleting the vault account strands, and in practice loses, any tokens still held for it on the token contracts and on Ref. Those balances stay recorded under the account id, but nothing can move them until someone re-creates that id (for `vault.<owner>` only the owner can) and deploys code that can, and the vault's own bookkeeping is gone with its state. Never run step 35 while any balance, `stranded_on_ref`, `unverified_on_ref` or Ref `get_deposit` is non-zero. Also check each token directly (`ft_balance_of` for the vault on wrap.testnet and rft.tokenfactory.testnet) because the vault's own bookkeeping can miss tokens sent to it outside `ft_transfer_call`; `sync_balance` credits them so `withdraw` can move them.

### Recovery commands the plan does not print

These are not produced by `yield-live.mjs` (they only apply after a failure). They use the same call-function syntax as step 27 with a different method and gas. The method names, gas minimums and argument shapes below are checked against `contracts/yield-vault/src/lib.rs` by the test; the near-cli-rs syntax is UNCONFIRMED against upstream.

| Situation | Method (owner, 1 yocto unless noted) | Minimum gas | Args |
| --- | --- | --- | --- |
| A swap or recovery has been in flight for at least 10 minutes | `force_release_lock` | 100 TGas | `{}` |
| `release_in_flight` stays true at least 10 minutes after a force release | `abort_release` | none enforced | `{}` |
| Funds stranded on Ref | `recover_from_ref` | 170 TGas | `{"token_id":"<TOKEN>","amount":"<AMOUNT>"}` |
| Vault holds tokens it does not track (donation, or marked on Ref by mistake) | `sync_balance` | 50 TGas | `{"token_id":"<TOKEN>"}` |

Template (replace the method, args and gas, keep everything else):

```bash
near contract call-function as-transaction vault.owner.yield-demo.testnet force_release_lock json-args '{}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.yield-demo.testnet network-config testnet sign-with-keychain send
```

Use 170 Tgas or more for `recover_from_ref` and keep headroom above each minimum. `force_release_lock` reads where the held amount really is and then credits, rolls back or strands it; read the vault README "Force release" table before interpreting the result.

## Verification table

Status meanings: CONFIRMED means checked against the source named in the last column; UNCONFIRMED says what to check. Facts about Ref were read on 2026-11-05 from the deployed testnet contract through https://test.rpc.fastnear.com (read-only) because the Ref source repository and docs were unreachable; audit excerpts and a fork of the Ref contract are second-hand. "vault" rows are calls on the yield vault; each method exists in `contracts/yield-vault/src/lib.rs` and none has been run on chain.

| ID | Receiver | Method | Args | Deposit | Gas | Status |
| --- | --- | --- | --- | --- | --- | --- |
| V1 | vault | `new` | owner_id, nft_contract_id, token_id, ref_exchange_id, config | 0 | 100 TGas | CONFIRMED (lib.rs); signer must be the vault itself |
| V2 | vault | `register_on_ref` | none | Ref storage NEAR | min 60 TGas | CONFIRMED (lib.rs) |
| V3 | vault | `execute_swap` | proposal | 0 | min 280 TGas | CONFIRMED (lib.rs); gas on Ref never measured |
| V4 | vault | `check_proposal` | proposal, runner_id | view | n/a | CONFIRMED (lib.rs) |
| V5 | vault | `get_config` | none | view | n/a | CONFIRMED (lib.rs) |
| V6 | vault | `get_state` | none | view | n/a | CONFIRMED (lib.rs) |
| V7 | vault | `get_balance` | token_id | view | n/a | CONFIRMED (lib.rs) |
| V8 | vault | `get_withdrawable_near` | none | view | n/a | CONFIRMED (lib.rs) |
| V9 | vault | `withdraw` | token_id, amount | 1 yocto | min 80 TGas | CONFIRMED (lib.rs) |
| V10 | vault | `pause` | none | 1 yocto | 30 TGas | CONFIRMED (lib.rs) |
| V11 | vault | `unpause` | none | 1 yocto | 30 TGas | CONFIRMED (lib.rs) |
| V12 | vault | `revoke_all_runners` | none | 1 yocto | 30 TGas | CONFIRMED (lib.rs) |
| V13 | vault | `add_runner` | runner_id | 1 yocto | 30 TGas | CONFIRMED (lib.rs) |
| V14 | vault | `revoke_runner` | runner_id | 1 yocto | 30 TGas | CONFIRMED (lib.rs) |
| V15 | vault | `update_config` | config | 1 yocto | 30 TGas | CONFIRMED (lib.rs) |
| V16 | vault | `withdraw_ref_storage` | amount (optional) | 1 yocto | min 40 TGas | CONFIRMED (lib.rs); Ref side UNCONFIRMED (row R6) |
| V17 | vault | `withdraw_near` | amount | 1 yocto | 30 TGas | CONFIRMED (lib.rs) |
| V18 | vault | `force_release_lock` | none | 1 yocto | min 100 TGas | CONFIRMED (lib.rs) |
| V19 | vault | `abort_release` | none | 1 yocto | none enforced | CONFIRMED (lib.rs) |
| V20 | vault | `recover_from_ref` | token_id, amount | 1 yocto | min 170 TGas | CONFIRMED (lib.rs) |
| V21 | vault | `sync_balance` | token_id | 1 yocto | min 50 TGas | CONFIRMED (lib.rs) |
| V22 | vault | `ft_on_transfer` | sender_id, amount, msg | called by the token | n/a | CONFIRMED (lib.rs) |
| R1 | Ref ref-finance-101.testnet | contract exists and is live | n/a | n/a | n/a | CONFIRMED: code present, `version` view returns "1.9.19", owner reflabs.sputnikv2.testnet (RPC). Whether Rhea renamed it: UNCONFIRMED; no Rhea document stating this was reachable |
| R2 | Ref | `storage_deposit` | account_id, registration_only (false) | NEAR | vault passes 30 TGas | CONFIRMED export in deployed wasm (NEP-145 shape) |
| R3 | Ref | `storage_balance_bounds` view | none | view | n/a | CONFIRMED (RPC): min 1020000000000000000000, max null |
| R4 | Ref | `storage_balance_of` view | account_id | view | n/a | CONFIRMED export (RPC views work) |
| R5 | Ref | `ft_on_transfer` (deposit via token `ft_transfer_call`, msg "") | sender_id, amount, msg | 1 yocto on the token | vault passes 70 TGas | CONFIRMED (audit excerpt, second-hand); sender must already be registered on Ref (error E10) |
| R6 | Ref | `storage_withdraw` | amount | 1 yocto | vault passes 30 TGas | CONFIRMED export; how much Ref releases while token entries exist: UNCONFIRMED, compare `storage_balance_of` before and after |
| R7 | Ref | `swap` | actions [pool_id, token_in, amount_in, token_out, min_amount_out], referral_id | 1 yocto | vault passes 50 TGas | CONFIRMED (audit listing and deployed export) for the method and `referral_id`; the action field names are UNCONFIRMED from first-party source, check with a tiny real swap |
| R8 | Ref | `withdraw` | token_id, amount, unregister, skip_unwrap_near | 1 yocto | vault passes 40 TGas | CONFIRMED that `skip_unwrap_near` exists in the deployed wasm and that the Ref UI sends it; the vault passes true so wNEAR is not unwrapped. Amount "0" would withdraw everything on Ref; the vault never sends 0 |
| R9 | Ref | `get_deposit` view | account_id, token_id | view | n/a | CONFIRMED (RPC returned "0" as a JSON string) |
| R10 | Ref | token whitelist | n/a | n/a | n/a | CONFIRMED (RPC `get_whitelisted_tokens`): wrap.testnet, nusdc.ft-fin.testnet, nusdt.ft-fin.testnet and rft.tokenfactory.testnet are whitelisted, so `register_tokens` is not needed |
| R11 | Ref | per-token storage cost | n/a | n/a | n/a | UNCONFIRMED numerically (roughly 0.0006 NEAR per token entry by formula); 0.5 NEAR is attached as a generous margin |
| R12 | Ref | pool 0 | n/a | n/a | n/a | CONFIRMED (RPC): SIMPLE_POOL, wrap.testnet and rft.tokenfactory.testnet, fee 40 bps, amounts equal the fixture snapshot; liquidity is thin, use tiny amounts |
| T1 | token wrap.testnet, rft.tokenfactory.testnet | `storage_deposit` | account_id, registration_only | 0.00125 NEAR | 30 TGas | CONFIRMED (RPC): bounds min = max = 0.00125 NEAR on each token |
| T2 | token | `ft_transfer_call` | receiver_id, amount, msg | 1 yocto | 100 TGas | CONFIRMED (NEP-141 standard); wrap.testnet behaviour on chain not run |
| T3 | token | `ft_transfer`, `ft_balance_of` | standard NEP-141 | 1 yocto / view | vault passes 30 TGas | CONFIRMED (NEP-141 standard) |
| W1 | wrap.testnet | `near_deposit` | none | NEAR to wrap | 30 TGas | UNCONFIRMED: payable methods cannot be RPC-checked. Inspect the deployed wrap.testnet code or run the step with 0.02 NEAR and read `ft_balance_of` |
| N1 | near-cli-rs | every command shape in this document | n/a | n/a | n/a | UNCONFIRMED against upstream: shapes come from the repo skill `.agents/skills/near-cli-rs/SKILL.md` (v0.14+), not checked against the near-cli-rs README or `near --help`. Run `near --version` and `near contract call-function as-transaction --help` before the first send |
| N2 | near-cli-rs | step 19 gas `'280.0 Tgas'` | n/a | n/a | 280 TGas | The skill lists 300 Tgas as the maximum; NEAR itself allows 1 PGas per transaction (CONFIRMED, docs.near.org gas page and testnet protocol config) |
| N3 | RPC | https://test.rpc.fastnear.com | n/a | n/a | n/a | CONFIRMED in the official provider list (docs.near.org). near-cli-rs `network-config testnet` uses its own default RPC; the provider it picks was not checked |

## Known gaps

- Gas was never measured on Ref. Every vault gas figure is arithmetic over static constants (vault README, "Promise chain and gas"). If a Ref hop costs more than its constant the swap chain stops mid-way and the way out is the 10 minute force release.
- `wrap.testnet` `near_deposit` is unverified (row W1). Without wNEAR the owner cannot fund the vault with the example config.
- The Ref `swap` action field names (`pool_id`, `token_in`, `amount_in`, `token_out`, `min_amount_out`) were not read from first-party source (row R7). The Ref source repository and docs were unreachable on 2026-11-05.
- Per-token Ref storage cost is not documented (row R11); how much `storage_withdraw` returns is untested (row R6).
- Fixed: nusdc.ft-fin.testnet has 2 decimals on chain, and `src/yield/fixtures` now says 2 (it said 6). The nUSDC limits in the per-agent example configs were regenerated (1 nUSDC = 100 base units). The live example config uses the pool 0 pair (wrap.testnet to rft.tokenfactory.testnet) and was never affected.
- Testnet liquidity is thin and the pools are idle, so rates may move or the pool may hold too little for larger swaps. The example swap is tiny (0.01 wNEAR); the config's `max_trade` (10 wNEAR) and `daily_cap` (30 wNEAR) are the demo caps, not the swap size, and its floor `min_rate` is a sanity floor 50% under the snapshot spot price.
- near-cli-rs syntax is unverified against upstream (row N1). The create-account commands use `use-manually-provided-public-key`, which the repo skill documents; the tool, not this document, is the authority on the exact text, and the test only checks that they match.
- The 261718 byte wasm was built with `non-reproducible-wasm`; nothing proves it equals a reviewed build.
- Real gas burn is not estimated beyond the prepaid upper bound.
- Not covered: unregistering token entries on Ref, `register_tokens`, `near_withdraw`, mainnet, NEAR Intents.

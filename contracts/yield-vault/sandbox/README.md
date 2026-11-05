# yield-vault local sandbox harness (throwaway)

Measures the gas of the real Ref callback chain against the constants in `../src/lib.rs`
(review finding M-1). Separate crate on purpose: `../cargo test` (run by `scripts/verify.sh`)
does not build or run any of this. Local `near-workspaces` sandbox only; no network keys.

Run (first run downloads the sandbox binary and builds three wasm files, a few minutes):

    cd contracts/yield-vault/sandbox && gtimeout 1800 cargo test -- --nocapture --test-threads=1

- `mocks/mock-ft`: NEP-141 + NEP-145 token with `mint` and failure knobs.
- `mocks/mock-ref`: Ref/Rhea exchange with the real method names and JSON shapes
  (`ft_on_transfer`, `swap`, `withdraw`, `get_deposit`, NEP-145 storage). Each file header lists
  what is mirrored and what is simplified, with the Ref source file for each shape.
- `tests/common/mod.rs`: wasm build, deployment, and the gas table. The table is built from the
  sandbox RPC `EXPERIMENTAL_tx_status`: per receipt, executor, method, attached gas, gas burnt,
  and subtree burnt (own plus all descendant receipts), next to the `lib.rs` constant (parsed from
  the source, so it cannot drift).
- wasm is built with `RUSTFLAGS="--cfg near" cargo build --release --target wasm32-unknown-unknown`.
  Without `--cfg near`, near-sdk-env drops the host panic call and every panic message is lost.

- `mocks/mock-ref` also has `set_burn_tgas(method, tgas)`: the method spins until `env::used_gas()`
  has grown by `tgas` before its normal work, to model Ref bodies heavier than the mock.
- Ref's inner `withdraw` gas is the realistic default everywhere: 20 TGas `ft_transfer` + 20 TGas
  resolve callback (ref-exchange `GAS_FOR_FT_TRANSFER` / `GAS_FOR_RESOLVE_TRANSFER`, taken from the
  public jumbo-exchange fork; the canonical ref-finance/ref-contracts repository is no longer public).
  History: with `GAS_REF_WITHDRAW = 40` `ref.withdraw` failed with "Exceeded the prepaid gas" in the
  sandbox; commit 7a1d70e raised it to 60, which left only ~15 TGas for Ref's withdraw body
  (`tests/headroom.rs`), so lib.rs now attaches 80.

Caveats: mock bodies are much lighter than real Ref (no pool math, one storage read), so the
Ref-side `burnt` figures are lower bounds. The vault-side figures are real vault code.

## Gas table (Ref inner withdraw gas 20+20, constants: GAS_REF_WITHDRAW 80)

TGas. `attached` can exceed the constant because near-sdk hands unused gas to callbacks;
`subtree` = own burnt plus all descendant receipts; `const-sub` = constant minus subtree.

execute_swap @ MIN_EXECUTE_GAS (280), total burnt 31.09 TGas:

    #   receipt                               constant attached  burnt  subtree  const-sub
    0   vault.execute_swap                    280.00   280.00    2.60   30.78    249.22
    1     tin.ft_transfer_call                 70.00    70.00    2.21    5.92     64.08
    2     vault.on_deposit                    190.00   206.51    2.47   22.04    167.96
    3       ref.ft_on_transfer                     -    40.00    1.59    1.81        -
    4       tin.ft_resolve_transfer                -    26.90    1.45    1.68        -
    5       ref.swap                           50.00    50.00    1.61    1.84     48.16
    6       vault.on_swap                     135.00   153.15    2.44   17.51    117.49
    7         ref.get_deposit                  10.00    10.00    1.59    1.81      8.19
    8         vault.on_withdraw_pre           115.00   139.83    2.87   13.04    101.96
    9           ref.withdraw                   80.00    80.00    2.38    6.08     73.92
    10          ref.get_deposit                10.00    10.00    1.59    1.81      8.19
    11          vault.on_withdraw_reconciled   15.00    45.18    1.83    2.06     12.94
    12            tout.ft_transfer                 -    20.00    1.41    1.64        -
    13            ref.exchange_callback_post_withdraw - 56.73    1.62    1.84        -

recover_from_ref @ MIN_RECOVER_GAS (170), total burnt 19.95 TGas:

    0   vault.recover_from_ref               170.00   170.00    2.42   19.64    150.36
    1     ref.get_deposit                     10.00    10.00    1.58    1.80      8.20
    2     vault.on_recover_pre               130.00   156.69    2.44   15.19    114.81
    3       ref.withdraw                      80.00    80.00    2.37    6.08     73.92
    4       vault.on_recover                  40.00    73.36    2.43    6.45     33.55
    5         tin.ft_transfer                     -    20.00    1.43    1.65        -
    6         ref.exchange_callback_post_withdraw - 56.74    1.61    1.83        -
    7         ref.get_deposit                 10.00    10.00    1.58    1.80      8.20
    8         vault.on_recover_reconciled     15.00    60.05    1.77    2.00     13.00

Other entry points (own constant vs subtree): register_on_ref 60 / 6.36, sync_balance 50 / 6.16,
withdraw 80 / 6.29, force_release_lock 100 / 10.79 (measured earlier, when a garbage `get_deposit` reply still stuck the lock; no sandbox test reaches it now, since malformed replies are handled as failed reads, and `force_release_lock` is covered by the unit tests only). Regenerate with
`gtimeout 1800 cargo test --test happy_path -- --nocapture --test-threads=1`.

## Headroom: how much heavier than the mock can each Ref hop be?

`tests/headroom.rs`, at exactly MIN_EXECUTE_GAS (280) and MIN_RECOVER_GAS (170), Ref inner
withdraw gas 20+20. Max extra TGas one Ref hop can burn (on top of the mock's ~1.6 TGas body)
with the chain still completing (steps of 5 TGas; `get_deposit` 1 TGas):

| Ref hop                         | attached | swap chain @ 280 | recover @ 170 | floor asserted |
|---------------------------------|----------|------------------|---------------|----------------|
| ft_on_transfer                  | 40       | 35               | n/a           | 30             |
| swap                            | 50       | 45               | n/a           | 40             |
| get_deposit (knob hits both)    | 10       | 9                | 9             | 8              |
| withdraw                        | 80       | 35               | 35            | 30             |
| exchange_callback_post_withdraw | 20 + rest| 55               | 55            | 50             |

At the limit (the next step fails with "Exceeded the prepaid gas" in that Ref receipt) the tests
assert: lock released, vault value (wallet + Ref inner deposit) equals credited + stranded +
unverified (nothing lost or double counted), credits never exceed the wallet. Observed outcomes:
ft_on_transfer fails -> token refunded to the vault; swap fails -> token_in stranded; get_deposit
fails -> token_out stranded (swap chain) or token_in back as stranded/unverified (recover);
withdraw fails -> stranded; post-withdraw callback fails -> the transfer already landed and is credited.

Tightest hop: `get_deposit` (about 9 TGas spare on top of the mock's ~1.6; a real Ref view of one
account's deposit should be a few TGas). At `GAS_REF_WITHDRAW = 60` `withdraw` had only 15 spare;
at 80 it has 35 (on top of the mock body and Ref's inner 20+20).

    cd contracts/yield-vault/sandbox && gtimeout 1800 cargo test --test headroom -- --nocapture --test-threads=1

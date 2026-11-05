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
  resolve callback (ref-exchange `GAS_FOR_FT_TRANSFER` / `GAS_FOR_RESOLVE_TRANSFER`). History: with
  `GAS_REF_WITHDRAW = 40` this failed in the sandbox; lib.rs now has 60 (commit 7a1d70e).

Caveats: mock bodies are much lighter than real Ref (no pool math, one storage read), so the
Ref-side `burnt` figures are lower bounds. The vault-side figures are real vault code.

## Gas table (Ref inner withdraw gas 20+20, constants of commit 7a1d70e)

TGas. `attached` can exceed the constant because near-sdk hands unused gas to callbacks;
`subtree` = own burnt plus all descendant receipts; `const-sub` = constant minus subtree.

execute_swap @ MIN_EXECUTE_GAS (280), total burnt 31.09 TGas:

    #   receipt                               constant attached  burnt  subtree  const-sub
    0   vault.execute_swap                    280.00   280.00    2.60   30.78    249.22
    1     tin.ft_transfer_call                 70.00    70.00    2.21    5.92     64.08
    2     vault.on_deposit                    185.00   206.51    2.47   22.04    162.96
    3       ref.ft_on_transfer                     -    40.00    1.59    1.81        -
    4       tin.ft_resolve_transfer                -    26.90    1.45    1.68        -
    5       ref.swap                           50.00    50.00    1.61    1.84     48.16
    6       vault.on_swap                     120.00   153.15    2.44   17.51    102.49
    7         ref.get_deposit                  10.00    10.00    1.59    1.81      8.19
    8         vault.on_withdraw_pre            95.00   139.83    2.87   13.04     81.96
    9           ref.withdraw                   60.00    60.00    2.38    6.08     53.92
    10          ref.get_deposit                10.00    10.00    1.59    1.81      8.19
    11          vault.on_withdraw_reconciled   15.00    65.18    1.83    2.06     12.94
    12            tout.ft_transfer                 -    20.00    1.41    1.64        -
    13            ref.exchange_callback_post_withdraw - 36.73    1.62    1.84        -

recover_from_ref @ MIN_RECOVER_GAS (160), total burnt 20.00 TGas:

    0   vault.recover_from_ref               160.00   160.00    2.43   19.69    140.31
    1     ref.get_deposit                     10.00    10.00    1.59    1.81      8.19
    2     vault.on_recover_pre               115.00   146.69    2.45   15.23     99.77
    3       ref.withdraw                      60.00    60.00    2.38    6.09     53.91
    4       vault.on_recover                  40.00    83.35    2.43    6.47     33.53
    5         tin.ft_transfer                     -    20.00    1.43    1.65        -
    6         ref.exchange_callback_post_withdraw - 36.73    1.62    1.84        -
    7         ref.get_deposit                 10.00    10.00    1.59    1.81      8.19
    8         vault.on_recover_reconciled     15.00    70.03    1.78    2.00     13.00

Other entry points (own constant vs subtree): register_on_ref 60 / 6.36, sync_balance 50 / 6.16,
withdraw 80 / 6.29. Regenerate with
`gtimeout 1800 cargo test --test happy_path -- --nocapture --test-threads=1`.

## Headroom: how much heavier than the mock can each Ref hop be?

`tests/headroom.rs`, at exactly MIN_EXECUTE_GAS (280) and MIN_RECOVER_GAS (160), Ref inner
withdraw gas 20+20. Max extra TGas one Ref hop can burn (on top of the mock's ~1.6 TGas body)
with the chain still completing (steps of 5 TGas; `get_deposit` 1 TGas):

| Ref hop                         | attached | swap chain @ 280 | recover @ 160 | floor asserted |
|---------------------------------|----------|------------------|---------------|----------------|
| ft_on_transfer                  | 40       | 35               | n/a           | 30             |
| swap                            | 50       | 45               | n/a           | 40             |
| get_deposit (knob hits both)    | 10       | 9                | 9             | 8              |
| withdraw                        | 60       | 15               | 15            | 10             |
| exchange_callback_post_withdraw | 20 + rest| 35               | 35            | 30             |

At the limit (the next step fails with "Exceeded the prepaid gas" in that Ref receipt) the tests
assert: lock released, vault value (wallet + Ref inner deposit) equals credited + stranded +
unverified (nothing lost or double counted), credits never exceed the wallet. Observed outcomes:
ft_on_transfer fails -> token refunded to the vault; swap fails -> token_in stranded; get_deposit
fails -> token_out stranded (swap chain) or token_in back as stranded/unverified (recover);
withdraw fails -> stranded; post-withdraw callback fails -> the transfer already landed and is credited.

Tightest hops: `withdraw` (about 15 TGas spare) and `get_deposit` (about 9 TGas spare).

    cd contracts/yield-vault/sandbox && gtimeout 1800 cargo test --test headroom -- --nocapture --test-threads=1

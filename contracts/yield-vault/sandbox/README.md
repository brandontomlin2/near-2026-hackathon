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

Caveats: mock bodies are much lighter than real Ref (no pool math, one storage read), so the
Ref-side `burnt` figures are lower bounds. The vault-side figures are real vault code.

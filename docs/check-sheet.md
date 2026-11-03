# Check a sheet before you buy

The chain stores only the sha256 hash of each token's character sheet, not the sheet (`anchor_sheet` writes it, `sheet_anchor` reads it: `contracts/personality-nft/src/lib.rs:245`, `:311`). `npm run check-sheet` hashes the sheet file you were handed with the same function the anchor step uses (`hashSheet`, `src/anchor/hash.mjs`) and compares it with the hash anchored for the token. It is read-only: two view calls (`sheet_anchor`, `nft_in_flight`), nothing signed or sent (`scripts/check-sheet.mjs:13-15`).

## Try it offline (no keys, no network)

1. Run `npm run demo`. It writes `out/anchors.json` (dry-run anchors) and `out/memory/<token>/sheet.json` for the four tokens.
2. Check the aloof token's sheet against its latest anchor:

   ```
   npm run check-sheet -- --mock --token aloof --sheet out/memory/aloof/sheet.json
   echo $?
   ```

   You see (the demo is deterministic, so these hashes are the same on every run):

   ```
   check-sheet: MOCK, offline: compares with out/anchors.json (dry-run anchors, not chain data)
   contract:     personality-nft.demo.testnet
   token:        aloof
   sheet file:   out/memory/aloof/sheet.json
   sheet hash:   685c3c71764322636ddf22dc0463afd6dda0dacf3ef5ea5591772d028d92d355
   anchor hash:  685c3c71764322636ddf22dc0463afd6dda0dacf3ef5ea5591772d028d92d355
   in flight:    false (mock: demo has no transfer locks)
   result: MATCH
   ```

   `echo $?` prints `0`.
3. Tamper with a copy: change one phrase and write it to `out/tampered.json`.

   <!-- tamper-snippet -->
   ```
   node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('out/memory/aloof/sheet.json','utf8'));s.sheet=s.sheet.replace('Public enemy','Public friend');fs.writeFileSync('out/tampered.json',JSON.stringify(s))"
   ```
4. Check the copy:

   ```
   npm run check-sheet -- --mock --token aloof --sheet out/tampered.json
   echo $?
   ```

   You see:

   ```
   check-sheet: MOCK, offline: compares with out/anchors.json (dry-run anchors, not chain data)
   contract:     personality-nft.demo.testnet
   token:        aloof
   sheet file:   out/tampered.json
   sheet hash:   d9b7787501afdba52e55530f10e3cbac2bdaae9b91c15c2a88b3c3873e18a5b6
   anchor hash:  685c3c71764322636ddf22dc0463afd6dda0dacf3ef5ea5591772d028d92d355
   in flight:    false (mock: demo has no transfer locks)
   result: MISMATCH
   ```

   `echo $?` prints `1`.

Mock mode compares with dry-run anchors in a local file, not chain data (`scripts/check-sheet.mjs:182-212`). A `.json` sheet file must be `{"sheet": "<text>"}`, which is what `sheet.json` is; any other file is hashed as a whole (`scripts/check-sheet.mjs:85-109`).

## Check a real token on testnet

```
npm run check-sheet -- --contract <id>.testnet --token <token_id> --sheet <file> [--rpc <url>]
```

Nothing in this repository is deployed to testnet yet (`README.md:72`, `README.md:194`), so there is no real contract id to give. Once a human deploys one, the output has the same labels as above plus two lines, with values read from the chain (`scripts/check-sheet.mjs:166-178`, `:214-227`):

```
check-sheet: testnet, read-only view calls (nothing signed or sent)
contract:     <id>.testnet
token:        <token_id>
rpc:          <origin of the RPC URL>
sheet file:   <file>
sheet hash:   <64 hex, from your file>
anchor hash:  <64 hex from sheet_anchor, or null>
memory depth: <number from sheet_anchor>
in flight:    <true|false>
result: <MATCH | MISMATCH | MISMATCH (no sheet anchored yet) | IN-FLIGHT (...)>
```

- `MISMATCH (no sheet anchored yet)`: the token exists but `anchor_sheet` was never called, so the anchor hash is `null` (`scripts/check-sheet.mjs:119`; a minted token starts with `sheet_hash: null`, `README.md:89`). There is nothing to verify the file against.
- `IN-FLIGHT`: an `nft_transfer_call` on the token has not resolved. Its pending `nft_resolve_transfer` may still return the token to its seller, so do not buy until `in flight` is `false` (`scripts/check-sheet.mjs:111-118`; `contracts/personality-nft/src/lib.rs:348-354`). This is reported before the hash comparison.
- An unknown token or an RPC error prints an error on stderr and exits 2 (`scripts/check-sheet.mjs:143-153`).

| Exit | Meaning |
| --- | --- |
| 0 | MATCH |
| 1 | MISMATCH, MISMATCH (no sheet anchored yet), or IN-FLIGHT |
| 2 | usage error, unreadable sheet file, unknown token, or RPC error |

`--rpc` defaults to `https://rpc.testnet.near.org` (`scripts/evidence.mjs:27`). It must be an `https` URL whose host names testnet; mainnet hosts are refused, and only the origin (not path or query) is printed (`scripts/evidence.mjs:39-62`). `--contract` must be a named testnet account (`scripts/check-sheet.mjs:137`). Use an RPC endpoint you chose yourself, not one the seller suggests: the host check only rejects mainnet and unlabelled hosts, so a hostile endpoint whose name contains testnet could return a forged `sheet_anchor`. The two view calls are separate requests, not one atomic read, and each is aborted after 15 seconds (`scripts/check-sheet.mjs:48`, `:142`).

## Handing the sheet from seller to buyer

The chain holds only the hash. Sheets and the memory they are summarized from live in the seller's local `out/memory/<token>/` (`sheet.json`, `log.jsonl`), written by `npm run demo` and `npm run ask` (`scripts/ask.mjs:9`). `npm run demo` starts each token's memory over (`src/demo/pipeline.mjs:64-66`; `scripts/ask.mjs:33-34`), so a seller who re-runs it loses the sheet that matches the anchor unless they kept a copy.

1. The seller sends `out/memory/<token>/sheet.json` to the buyer over any channel (chat, email, file share). check-sheet checks integrity, not secrecy: a tampered file gives MISMATCH, so the channel does not need to be trusted for that. The file is not encrypted; anyone who gets it can read the sheet.
2. The buyer runs `npm run check-sheet -- --contract <id>.testnet --token <token_id> --sheet <received file>`.
3. On `MATCH` with `in flight: false`, note the `anchor hash` and `memory depth` it printed.
4. The seller transfers with `nft_transfer_expecting_anchor`, passing those two values as `expected_hash` and `expected_depth`. The contract panics unless the token's anchor is exactly that pair, and also refuses a token that is in flight, so the sale fails if the anchor changed after the buyer checked (`contracts/personality-nft/src/lib.rs:315-345`; method table at `README.md:94`). It costs 1 yoctoNEAR (`contracts/personality-nft/src/lib.rs:321`).

What is not there:

- No sheet URI. The collection metadata sets `reference: None` (`contracts/personality-nft/src/lib.rs:154`) and each token's `media` points at the rendered SVG art, not the sheet (`scripts/testnet-deploy.mjs:142`).
- No hosting. This repository does not store or serve sheets.
- If the seller loses the file, the buyer cannot recover the sheet from the chain; only its hash is there.
- Only the sheet text is hashed (`src/anchor/anchor.mjs:78-83`). The event log `log.jsonl` is not hash-anchored, so a matching sheet says nothing about the log behind it.

## Cost

View calls are free; see [`costs.md`](costs.md).

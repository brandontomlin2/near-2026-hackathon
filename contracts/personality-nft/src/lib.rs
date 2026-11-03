//! Personality NFT.
//!
//! A NEP-171 non-fungible token (with NEP-177 metadata, NEP-178 approvals,
//! NEP-181 enumeration and NEP-297 events) where every token is an AI agent.
//! The trait values that drive the agent and its SVG live in the standard
//! `TokenMetadata.extra` field as a JSON string. On top of the standard, each
//! token carries a *sheet anchor*: the sha256 of the agent's current character
//! sheet plus a memory depth that grows by one each time a new sheet is
//! anchored. The anchor is keyed by token id, so it travels with the token on
//! transfer, and a new owner can check that the sheet they received matches
//! the hash the token claims.

use near_contract_standards::non_fungible_token::approval::NonFungibleTokenApproval;
use near_contract_standards::non_fungible_token::core::{
    ext_nft_receiver, NonFungibleTokenCore, NonFungibleTokenResolver,
};
use near_contract_standards::non_fungible_token::enumeration::NonFungibleTokenEnumeration;
use near_contract_standards::non_fungible_token::events::NftMint;
use near_contract_standards::non_fungible_token::metadata::{
    NFTContractMetadata, NonFungibleTokenMetadataProvider, TokenMetadata, NFT_METADATA_SPEC,
};
use near_contract_standards::non_fungible_token::{
    refund_deposit_to_account, NonFungibleToken, Token, TokenId,
};
use near_sdk::collections::LazyOption;
use near_sdk::json_types::{U128, U64};
use near_sdk::store::LookupMap;
use near_sdk::{
    assert_one_yocto, env, near, require, AccountId, BorshStorageKey, Gas, PanicOnDefault, Promise,
    PromiseOrValue,
};
use std::collections::HashMap;

/// NEP-297 `standard` field for the events this contract adds on top of NEP-171.
pub const EVENT_STANDARD: &str = "personality_nft";
/// NEP-297 `version` field for the events this contract adds on top of NEP-171.
pub const EVENT_VERSION: &str = "1.0.0";
/// Memory depth of a freshly minted token (one ring in the SVG).
pub const INITIAL_MEMORY_DEPTH: u32 = 1;
/// Longest accepted token id, in bytes.
pub const MAX_TOKEN_ID_LEN: usize = 64;
/// Length of a sha256 digest, the only accepted size for metadata hashes.
pub const SHA256_BYTES: usize = 32;
/// Longest accepted `title`, in bytes.
pub const MAX_TITLE_LEN: usize = 128;
/// Longest accepted `description`, in bytes.
pub const MAX_DESCRIPTION_LEN: usize = 1024;
/// Longest accepted `extra` (the trait JSON), in bytes.
pub const MAX_EXTRA_LEN: usize = 2048;
/// Longest accepted `media`, `reference` or other short metadata string.
pub const MAX_URI_LEN: usize = 512;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    NonFungibleToken,
    Metadata,
    TokenMetadata,
    Enumeration,
    Approval,
    SheetAnchors,
    SeenHashes,
    InFlight,
}

/// The on-chain pointer to a token's off-chain character sheet.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SheetAnchor {
    /// Lowercase hex sha256 of the current character sheet. `None` until the
    /// first summary is anchored.
    pub sheet_hash: Option<String>,
    /// Starts at [`INITIAL_MEMORY_DEPTH`] at mint and grows by one per anchor.
    pub memory_depth: u32,
    /// Block timestamp (nanoseconds) of the mint or the latest anchor.
    pub updated_at: U64,
}

#[near(serializers = [json])]
struct SheetAnchoredData {
    token_id: TokenId,
    owner_id: AccountId,
    sheet_hash: String,
    memory_depth: u32,
}

#[near(serializers = [json])]
struct EventLog<T> {
    standard: String,
    version: String,
    event: String,
    data: Vec<T>,
}

/// Gas reserved for the standard resolve callback. Same budget the SDK uses.
const GAS_FOR_RESOLVE_TRANSFER: Gas = Gas::from_tgas(5);

/// Gas reserved for the `release_lock` callback chained after the resolve. It
/// reads one promise result and removes one map entry, less work than the
/// standard `nft_resolve_transfer`, which the SDK fits in 5 Tgas. Twice that
/// is reserved so the only callback that can ever clear a lock has a margin
/// against fee changes; unused static gas is refunded, so the margin is free.
const GAS_FOR_RELEASE_LOCK: Gas = Gas::from_tgas(10);

/// An in-flight lock: which `nft_transfer_call` set it.
///
/// The lock has no expiry. It is cleared only by the `release_lock` callback
/// chained after the standard `nft_resolve_transfer`, which the runtime always
/// executes once the receiver's promise settles, however long that takes
/// (bounded only by the gas the sender attached) and however it ends. A
/// time-based unlock would let a receiver that stalls its
/// `nft_on_transfer` (chained yields or congested hops) outlive the window,
/// anchor as the recorded owner, and then return the token with a foreign
/// anchor, which is exactly what the lock exists to prevent.
#[near(serializers = [borsh])]
#[derive(Clone, Copy)]
pub struct InFlightLock {
    /// Unique per `nft_transfer_call`. Only the callback of the transfer that
    /// set the lock may clear it, so a stale or replayed callback carrying
    /// another transfer's nonce leaves the lock alone.
    nonce: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    sheet_anchors: LookupMap<TokenId, SheetAnchor>,
    /// `"{token_id}:{sheet_hash}"` for every hash ever anchored. A hash can be
    /// anchored once per token, so alternating A, B, A, B cannot inflate depth.
    seen_hashes: LookupMap<String, ()>,
    /// Tokens inside an `nft_transfer_call`: ownership has moved to the
    /// receiver but the transfer may still revert. Their anchor is frozen.
    in_flight: LookupMap<TokenId, InFlightLock>,
    /// Source of lock nonces. Incremented per `nft_transfer_call`.
    next_lock_nonce: u64,
}

#[near]
impl Contract {
    /// Initializes the contract with the default collection metadata.
    /// `owner_id` is the only account allowed to mint.
    #[init]
    pub fn new_default_meta(owner_id: AccountId) -> Self {
        Self::new(
            owner_id,
            NFTContractMetadata {
                spec: NFT_METADATA_SPEC.to_string(),
                name: "Personality NFT".to_string(),
                symbol: "PERSONA".to_string(),
                icon: None,
                base_uri: None,
                reference: None,
                reference_hash: None,
            },
        )
    }

    /// Initializes the contract with explicit collection metadata.
    #[init]
    pub fn new(owner_id: AccountId, metadata: NFTContractMetadata) -> Self {
        metadata.assert_valid();
        Self {
            tokens: NonFungibleToken::new(
                StorageKey::NonFungibleToken,
                owner_id,
                Some(StorageKey::TokenMetadata),
                Some(StorageKey::Enumeration),
                Some(StorageKey::Approval),
            ),
            metadata: LazyOption::new(StorageKey::Metadata, Some(&metadata)),
            sheet_anchors: LookupMap::new(StorageKey::SheetAnchors),
            seen_hashes: LookupMap::new(StorageKey::SeenHashes),
            in_flight: LookupMap::new(StorageKey::InFlight),
            next_lock_nonce: 0,
        }
    }

    /// Mints one personality token. Only the contract owner may call this.
    ///
    /// Put the trait values (`temperament`, `role`, `risk`, `voice`) in
    /// `token_metadata.extra` as a JSON string. The attached deposit must cover
    /// the storage the token uses; the remainder is refunded. Emits the
    /// standard NEP-297 `nft_mint` event.
    #[payable]
    pub fn nft_mint(
        &mut self,
        token_id: TokenId,
        receiver_id: AccountId,
        token_metadata: TokenMetadata,
    ) -> Token {
        require!(
            env::predecessor_account_id() == self.tokens.owner_id,
            "only the contract owner can mint"
        );
        require!(
            receiver_id != env::current_account_id(),
            "cannot mint to the contract account itself"
        );
        validate_token_id(&token_id);
        validate_token_metadata(&token_metadata);
        let initial_storage = env::storage_usage();
        let token = self.tokens.internal_mint_with_refund(
            token_id.clone(),
            receiver_id,
            Some(token_metadata),
            None,
        );
        self.sheet_anchors.insert(
            token_id,
            SheetAnchor {
                sheet_hash: None,
                memory_depth: INITIAL_MEMORY_DEPTH,
                updated_at: U64(env::block_timestamp()),
            },
        );
        // `store` collections write lazily; flush so the storage delta below
        // includes the anchor and the minter is charged for it.
        self.sheet_anchors.flush();
        let storage_used = env::storage_usage().saturating_sub(initial_storage);
        refund_deposit_to_account(storage_used, env::predecessor_account_id());
        NftMint {
            owner_id: &token.owner_id,
            token_ids: &[&token.token_id],
            memo: None,
        }
        .emit();
        token
    }

    /// Records the sha256 of the token's latest character sheet and grows its
    /// memory depth by one. Only the current token owner may call this.
    ///
    /// A hash can be anchored only once per token (re-anchoring an old hash is
    /// rejected), so depth counts distinct sheets. It is still advisory: the
    /// chain holds no sheet contents. Frozen while an `nft_transfer_call` is in
    /// flight.
    ///
    /// Attach at least 1 yoctoNEAR (so a full-access key must sign). Every
    /// anchor adds a seen-hash record, so the deposit must cover that storage
    /// growth (about 100 bytes plus the first anchor's own growth); the
    /// remainder is refunded. Emits a NEP-297 `sheet_anchored` event.
    #[payable]
    pub fn anchor_sheet(&mut self, token_id: TokenId, sheet_hash: String) -> SheetAnchor {
        require!(
            is_sha256_hex(&sheet_hash),
            "sheet_hash must be 64 lowercase hex characters (sha256)"
        );
        require!(
            env::attached_deposit().as_yoctonear() >= 1,
            "attach at least 1 yoctoNEAR"
        );
        let caller = env::predecessor_account_id();
        let owner_id = self
            .tokens
            .owner_by_id
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("token not found"));
        require!(
            owner_id == caller,
            "only the token owner can anchor a sheet"
        );

        require!(
            !self.is_in_flight(&token_id),
            "token is in an nft_transfer_call; anchor after it resolves"
        );

        let initial_storage = env::storage_usage();
        let mut anchor = self
            .sheet_anchors
            .get(&token_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("sheet anchor missing for token"));
        require!(
            anchor.sheet_hash.as_deref() != Some(sheet_hash.as_str()),
            "sheet_hash is already anchored; memory depth only grows with a new sheet"
        );
        require!(
            self.seen_hashes
                .insert(format!("{token_id}:{sheet_hash}"), ())
                .is_none(),
            "sheet_hash was anchored before; memory depth only grows with a new sheet"
        );
        anchor.memory_depth = anchor
            .memory_depth
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("memory depth overflow"));
        anchor.sheet_hash = Some(sheet_hash.clone());
        anchor.updated_at = U64(env::block_timestamp());
        self.sheet_anchors.insert(token_id.clone(), anchor.clone());
        self.sheet_anchors.flush();
        self.seen_hashes.flush();
        let storage_used = env::storage_usage().saturating_sub(initial_storage);
        refund_deposit_to_account(storage_used, caller);

        emit_event(
            "sheet_anchored",
            SheetAnchoredData {
                token_id,
                owner_id,
                sheet_hash,
                memory_depth: anchor.memory_depth,
            },
        );
        anchor
    }

    /// Returns the token's sheet anchor, or `None` if the token does not exist.
    pub fn sheet_anchor(&self, token_id: TokenId) -> Option<SheetAnchor> {
        self.sheet_anchors.get(&token_id).cloned()
    }

    /// Like `nft_transfer`, but panics unless the token's anchor is exactly
    /// `(expected_hash, expected_depth)`. Sellers and marketplaces use it so a
    /// sale cannot land after the anchor was swapped. Also refuses a token
    /// whose `nft_transfer_call` is still in flight: its pending
    /// `nft_resolve_transfer` may still hand the token back to the previous
    /// owner, so a buyer cannot rely on the anchor it pinned. Requires
    /// 1 yoctoNEAR.
    #[payable]
    pub fn nft_transfer_expecting_anchor(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        expected_hash: Option<String>,
        expected_depth: u32,
    ) {
        let anchor = self
            .sheet_anchors
            .get(&token_id)
            .unwrap_or_else(|| env::panic_str("sheet anchor missing for token"));
        require!(
            anchor.sheet_hash == expected_hash && anchor.memory_depth == expected_depth,
            "sheet anchor does not match the expected anchor"
        );
        require!(
            !self.is_in_flight(&token_id),
            "token is in an nft_transfer_call; transfer after it resolves"
        );
        self.tokens
            .nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    /// True while an `nft_transfer_call` on the token has not resolved yet.
    /// While true, `anchor_sheet`, `nft_transfer_expecting_anchor` and a nested
    /// `nft_transfer_call` are refused, and the pending `nft_resolve_transfer`
    /// may still return the token to its previous owner. Buyers should treat
    /// such a token as not for sale until this returns false.
    pub fn nft_in_flight(&self, token_id: TokenId) -> bool {
        self.is_in_flight(&token_id)
    }

    /// True while an `nft_transfer_call` lock is set on the token. The lock
    /// never expires; only `release_lock` clears it.
    fn is_in_flight(&self, token_id: &TokenId) -> bool {
        self.in_flight.contains_key(token_id)
    }

    /// The account allowed to mint.
    pub fn owner_id(&self) -> AccountId {
        self.tokens.owner_id.clone()
    }
}

// NEP-171 core, NEP-178 approvals and NEP-181 enumeration delegate to the
// standard implementation in `near-contract-standards`.

#[near]
impl NonFungibleTokenCore for Contract {
    #[payable]
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
    ) {
        self.tokens
            .nft_transfer(receiver_id, token_id, approval_id, memo);
    }

    /// Standard `nft_transfer_call` with an in-flight lock on the token.
    ///
    /// Deviations from a stock NEP-171 contract, all documented in the README:
    /// a second `nft_transfer_call` on a token whose first one has not
    /// resolved panics instead of settling as a no-op (so an escrow that
    /// forwards the token with `nft_transfer_call` from inside its
    /// `nft_on_transfer` fails here); the lock's storage (prefix, token id and
    /// an 8-byte nonce) is paid from the contract account's balance until
    /// `release_lock` frees it, since this method takes exactly 1 yocto; and
    /// `true` is also returned when the resolve callback itself failed.
    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        assert_one_yocto();
        require!(
            !self.is_in_flight(&token_id),
            "token is already in an nft_transfer_call"
        );
        // Same flow as the standard implementation: the receiver's
        // `nft_on_transfer` is followed by the standard `nft_resolve_transfer`
        // callback (unchanged name and signature, so wallets and indexers that
        // match on it keep working). The standard callback's fixed arguments
        // leave no room for the lock nonce, so a second, private `release_lock`
        // callback is chained after it; it clears the lock only if the nonce
        // still matches and forwards the resolve result as the NEP-171 bool.
        let sender_id = env::predecessor_account_id();
        let (old_owner, old_approvals) =
            self.tokens
                .internal_transfer(&sender_id, &receiver_id, &token_id, approval_id, memo);
        // Wrapping cannot realistically happen (2^64 transfers) and must never
        // panic: a panic here would revert the whole transfer.
        let nonce = self.next_lock_nonce;
        self.next_lock_nonce = nonce.wrapping_add(1);
        self.in_flight
            .insert(token_id.clone(), InFlightLock { nonce });
        ext_nft_receiver::ext(receiver_id.clone())
            .with_unused_gas_weight(1)
            .nft_on_transfer(sender_id, old_owner.clone(), token_id.clone(), msg)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RESOLVE_TRANSFER)
                    .with_unused_gas_weight(0)
                    .nft_resolve_transfer(old_owner, receiver_id, token_id.clone(), old_approvals),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_RELEASE_LOCK)
                    .with_unused_gas_weight(0)
                    .release_lock(token_id, U64(nonce)),
            )
            .into()
    }

    fn nft_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens.nft_token(token_id)
    }
}

#[near]
impl NonFungibleTokenResolver for Contract {
    #[private]
    fn nft_resolve_transfer(
        &mut self,
        previous_owner_id: AccountId,
        receiver_id: AccountId,
        token_id: TokenId,
        approved_account_ids: Option<HashMap<AccountId, u64>>,
    ) -> bool {
        // Standard callback, unchanged: settles the transfer (returning the
        // token if the receiver asked for it). It never touches the in-flight
        // lock; `release_lock`, chained after it, does that.
        self.tokens.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id,
            approved_account_ids,
        )
    }
}

#[near]
impl Contract {
    /// Second callback of `nft_transfer_call`, chained after the standard
    /// `nft_resolve_transfer`. Releases the in-flight lock, but only if the lock
    /// still belongs to this transfer (`nonce` matches), so a stale or replayed
    /// callback carrying another transfer's nonce leaves the lock alone. Never
    /// panics (a panic would revert the removal and leave the token locked): a
    /// missing or foreign lock is simply left as is. This callback is the only
    /// thing that clears a lock; there is no expiry, so it must stay cheap and
    /// panic-free.
    ///
    /// Returns the resolve result so the promise `nft_transfer_call` returns
    /// still yields the NEP-171 bool. Should the resolve callback itself have
    /// failed (only possible by running out of its fixed gas), ownership has
    /// already moved to the receiver and was not rolled back, so the transfer
    /// counts as completed and `true` is returned. Callers that must tell that
    /// case apart from a receiver that kept the token can read the receipt
    /// outcomes of the `nft_resolve_transfer` receipt.
    #[private]
    pub fn release_lock(&mut self, token_id: TokenId, nonce: U64) -> bool {
        if self
            .in_flight
            .get(&token_id)
            .is_some_and(|lock| lock.nonce == nonce.0)
        {
            self.in_flight.remove(&token_id);
        }
        // The resolve result is a JSON bool (at most 5 bytes); anything else
        // (a failed receipt, or an oversized body) counts as completed.
        env::promise_result_checked(0, 8)
            .ok()
            .and_then(|bytes| near_sdk::serde_json::from_slice::<bool>(&bytes).ok())
            .unwrap_or(true)
    }
}

#[near]
impl NonFungibleTokenApproval for Contract {
    #[payable]
    fn nft_approve(
        &mut self,
        token_id: TokenId,
        account_id: AccountId,
        msg: Option<String>,
    ) -> Option<Promise> {
        self.tokens.nft_approve(token_id, account_id, msg)
    }

    #[payable]
    fn nft_revoke(&mut self, token_id: TokenId, account_id: AccountId) {
        self.tokens.nft_revoke(token_id, account_id);
    }

    #[payable]
    fn nft_revoke_all(&mut self, token_id: TokenId) {
        self.tokens.nft_revoke_all(token_id);
    }

    fn nft_is_approved(
        &self,
        token_id: TokenId,
        approved_account_id: AccountId,
        approval_id: Option<u64>,
    ) -> bool {
        self.tokens
            .nft_is_approved(token_id, approved_account_id, approval_id)
    }
}

#[near]
impl NonFungibleTokenEnumeration for Contract {
    fn nft_total_supply(&self) -> U128 {
        self.tokens.nft_total_supply()
    }

    fn nft_tokens(&self, from_index: Option<U128>, limit: Option<u64>) -> Vec<Token> {
        self.tokens.nft_tokens(from_index, limit)
    }

    fn nft_supply_for_owner(&self, account_id: AccountId) -> U128 {
        self.tokens.nft_supply_for_owner(account_id)
    }

    fn nft_tokens_for_owner(
        &self,
        account_id: AccountId,
        from_index: Option<U128>,
        limit: Option<u64>,
    ) -> Vec<Token> {
        self.tokens
            .nft_tokens_for_owner(account_id, from_index, limit)
    }
}

#[near]
impl NonFungibleTokenMetadataProvider for Contract {
    fn nft_metadata(&self) -> NFTContractMetadata {
        self.metadata.get().unwrap()
    }
}

/// True for exactly 64 lowercase hex characters, the canonical sha256 encoding.
fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn validate_token_id(token_id: &str) {
    require!(
        !token_id.is_empty() && token_id.len() <= MAX_TOKEN_ID_LEN,
        "token_id must be 1 to 64 bytes"
    );
    // Same charset as the JS builders (src/anchor/anchor.mjs): [a-z0-9_-].
    require!(
        token_id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-'),
        "token_id may only contain a-z, 0-9, '_' and '-'"
    );
}

/// A sha256 digest is exactly 32 bytes; anything else is rejected so the two
/// `Base64VecU8` hash fields cannot bloat storage or every `nft_token` view.
fn require_hash_len(value: &Option<near_sdk::json_types::Base64VecU8>, field: &str) {
    if let Some(v) = value {
        require!(
            v.0.len() == SHA256_BYTES,
            format!("{field} must be exactly {SHA256_BYTES} bytes")
        );
    }
}

fn require_max_len(value: &Option<String>, max: usize, field: &str) {
    if let Some(v) = value {
        require!(
            v.len() <= max,
            format!("{field} is too long (max {max} bytes)")
        );
    }
}

/// Bounds every free-form metadata string so a mint cannot bloat storage or
/// every `nft_token` view, and requires `extra` to be a JSON object.
fn validate_token_metadata(m: &TokenMetadata) {
    require!(
        matches!(m.copies, None | Some(1)),
        "copies must be 1: each agent is a single token"
    );
    require_max_len(&m.title, MAX_TITLE_LEN, "title");
    require_max_len(&m.description, MAX_DESCRIPTION_LEN, "description");
    require_max_len(&m.extra, MAX_EXTRA_LEN, "extra");
    require_max_len(&m.media, MAX_URI_LEN, "media");
    require_max_len(&m.reference, MAX_URI_LEN, "reference");
    require_max_len(&m.issued_at, MAX_URI_LEN, "issued_at");
    require_max_len(&m.expires_at, MAX_URI_LEN, "expires_at");
    require_max_len(&m.starts_at, MAX_URI_LEN, "starts_at");
    require_max_len(&m.updated_at, MAX_URI_LEN, "updated_at");
    require_hash_len(&m.media_hash, "media_hash");
    require_hash_len(&m.reference_hash, "reference_hash");
    if let Some(extra) = &m.extra {
        let parsed = near_sdk::serde_json::from_str::<near_sdk::serde_json::Value>(extra);
        require!(
            matches!(parsed, Ok(near_sdk::serde_json::Value::Object(_))),
            "extra must be a JSON object"
        );
    }
}

fn emit_event<T: near_sdk::serde::Serialize>(event: &str, data: T) {
    let log = EventLog {
        standard: EVENT_STANDARD.to_string(),
        version: EVENT_VERSION.to_string(),
        event: event.to_string(),
        data: vec![data],
    };
    let json = near_sdk::serde_json::to_string(&log)
        .unwrap_or_else(|_| env::panic_str("event serialization failed"));
    env::log_str(&format!("EVENT_JSON:{json}"));
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::test_utils::{accounts, get_logs, VMContextBuilder};
    use near_sdk::{testing_env, NearToken};

    const MINT_DEPOSIT: NearToken = NearToken::from_millinear(100);
    const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);
    const HASH_A: &str = "a3f1c9e2b4d6f8a0c2e4b6d8f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a8";
    const HASH_B: &str = "0000000000000000000000000000000000000000000000000000000000000001";

    fn context(predecessor: AccountId, deposit: NearToken) -> VMContextBuilder {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(accounts(0))
            .signer_account_id(predecessor.clone())
            .predecessor_account_id(predecessor)
            .attached_deposit(deposit)
            .block_timestamp(1_700_000_000_000_000_000);
        builder
    }

    fn aloof_metadata() -> TokenMetadata {
        TokenMetadata {
            title: Some("Aloof".to_string()),
            description: Some("An observer. Cool palette, monocle, sparse dots.".to_string()),
            media: None,
            media_hash: None,
            copies: Some(1),
            issued_at: None,
            expires_at: None,
            starts_at: None,
            updated_at: None,
            extra: Some(
                r#"{"temperament":"cool","role":"observer","risk":"low","voice":"dry"}"#
                    .to_string(),
            ),
            reference: None,
            reference_hash: None,
        }
    }

    /// Owner is accounts(1); the token "aloof" is minted to accounts(2).
    fn minted_contract() -> Contract {
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        let mut contract = Contract::new_default_meta(accounts(1));
        contract.nft_mint("aloof".to_string(), accounts(2), aloof_metadata());
        contract
    }

    #[test]
    fn metadata_is_valid_and_owner_is_recorded() {
        testing_env!(context(accounts(1), NearToken::from_yoctonear(0)).build());
        let contract = Contract::new_default_meta(accounts(1));
        let meta = contract.nft_metadata();
        assert_eq!(meta.spec, NFT_METADATA_SPEC);
        assert_eq!(meta.symbol, "PERSONA");
        assert_eq!(contract.owner_id(), accounts(1));
        assert_eq!(contract.nft_total_supply().0, 0);
    }

    #[test]
    fn mint_stores_token_traits_and_initial_anchor() {
        let contract = minted_contract();
        let token = contract
            .nft_token("aloof".to_string())
            .expect("token exists");
        assert_eq!(token.owner_id, accounts(2));
        let extra = token.metadata.expect("metadata").extra.expect("traits");
        assert!(extra.contains(r#""role":"observer""#));

        let anchor = contract.sheet_anchor("aloof".to_string()).expect("anchor");
        assert_eq!(anchor.sheet_hash, None);
        assert_eq!(anchor.memory_depth, INITIAL_MEMORY_DEPTH);
        assert_eq!(anchor.updated_at.0, 1_700_000_000_000_000_000);
        assert_eq!(contract.nft_total_supply().0, 1);
        assert!(get_logs().iter().any(|l| l.contains("nft_mint")));
    }

    #[test]
    #[should_panic(expected = "only the contract owner can mint")]
    fn mint_by_non_owner_panics() {
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        let mut contract = Contract::new_default_meta(accounts(1));
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.nft_mint("x".to_string(), accounts(2), aloof_metadata());
    }

    #[test]
    #[should_panic(expected = "Must attach")]
    fn mint_without_storage_deposit_panics() {
        testing_env!(context(accounts(1), NearToken::from_yoctonear(0)).build());
        let mut contract = Contract::new_default_meta(accounts(1));
        contract.nft_mint("x".to_string(), accounts(2), aloof_metadata());
    }

    #[test]
    fn anchor_sheet_by_token_owner_updates_hash_and_depth() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT)
            .block_timestamp(1_700_000_001_000_000_000)
            .build());
        let anchor = contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        assert_eq!(anchor.sheet_hash.as_deref(), Some(HASH_A));
        assert_eq!(anchor.memory_depth, 2);
        assert_eq!(anchor.updated_at.0, 1_700_000_001_000_000_000);
        assert_eq!(contract.sheet_anchor("aloof".to_string()), Some(anchor));

        let logs = get_logs();
        let event = logs
            .iter()
            .find(|l| l.contains("sheet_anchored"))
            .expect("sheet_anchored event");
        assert!(event.starts_with("EVENT_JSON:"));
        assert!(event.contains(r#""standard":"personality_nft""#));
        assert!(event.contains(&format!(r#""sheet_hash":"{HASH_A}""#)));
        assert!(event.contains(r#""memory_depth":2"#));

        // A second summary, once storage exists, only needs 1 yoctoNEAR.
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        let second = contract.anchor_sheet("aloof".to_string(), HASH_B.to_string());
        assert_eq!(second.sheet_hash.as_deref(), Some(HASH_B));
        assert_eq!(second.memory_depth, 3);
    }

    #[test]
    #[should_panic(expected = "only the token owner can anchor a sheet")]
    fn anchor_sheet_by_contract_owner_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
    }

    #[test]
    #[should_panic(expected = "attach at least 1 yoctoNEAR")]
    fn anchor_sheet_without_deposit_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), NearToken::from_yoctonear(0)).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
    }

    #[test]
    #[should_panic(expected = "sheet_hash must be 64 lowercase hex characters")]
    fn anchor_sheet_rejects_non_sha256_hash() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), "ABCDEF".to_string());
    }

    #[test]
    #[should_panic(expected = "token not found")]
    fn anchor_sheet_on_unknown_token_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("ghost".to_string(), HASH_A.to_string());
    }

    #[test]
    fn sheet_anchor_for_unknown_token_is_none() {
        let contract = minted_contract();
        assert_eq!(contract.sheet_anchor("ghost".to_string()), None);
    }

    #[test]
    fn anchor_travels_with_the_token_on_transfer() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());

        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer(accounts(3), "aloof".to_string(), None, None);
        assert_eq!(
            contract.nft_token("aloof".to_string()).unwrap().owner_id,
            accounts(3)
        );

        // History stays keyed by token id, and the new owner continues it.
        let carried = contract.sheet_anchor("aloof".to_string()).unwrap();
        assert_eq!(carried.sheet_hash.as_deref(), Some(HASH_A));
        assert_eq!(carried.memory_depth, 2);

        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        let next = contract.anchor_sheet("aloof".to_string(), HASH_B.to_string());
        assert_eq!(next.memory_depth, 3);
    }

    #[test]
    #[should_panic(expected = "only the token owner can anchor a sheet")]
    fn previous_owner_cannot_anchor_after_transfer() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer(accounts(3), "aloof".to_string(), None, None);
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
    }

    #[test]
    fn sha256_hex_validation() {
        assert!(is_sha256_hex(HASH_A));
        assert!(is_sha256_hex(HASH_B));
        assert!(!is_sha256_hex(&HASH_A.to_uppercase()));
        assert!(!is_sha256_hex(&HASH_A[..63]));
        assert!(!is_sha256_hex(&format!("{HASH_A}0")));
        assert!(!is_sha256_hex(&format!("g{}", &HASH_A[1..])));
        assert!(!is_sha256_hex(""));
    }

    // ---- hardening tests -------------------------------------------------

    use near_sdk::mock::MockAction;
    use near_sdk::test_utils::get_created_receipts;
    use std::panic::{catch_unwind, AssertUnwindSafe};

    /// Total yoctoNEAR transferred to `to` by receipts created so far.
    fn transferred_to(to: &AccountId) -> u128 {
        get_created_receipts()
            .iter()
            .filter(|r| &r.receiver_id == to)
            .flat_map(|r| r.actions.iter())
            .map(|a| match a {
                MockAction::Transfer { deposit, .. } => deposit.as_yoctonear(),
                _ => 0,
            })
            .sum()
    }

    fn mint_with(token_id: &str, meta: TokenMetadata) {
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        let mut contract = Contract::new_default_meta(accounts(1));
        contract.nft_mint(token_id.to_string(), accounts(2), meta);
    }

    #[test]
    fn mint_charges_exact_storage_and_refunds_the_rest() {
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        let mut contract = Contract::new_default_meta(accounts(1));
        let before = env::storage_usage();
        contract.nft_mint("aloof".to_string(), accounts(2), aloof_metadata());
        let cost =
            env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - before) as u128;
        assert!(cost > 0);
        // Refund goes to the minter, never to the receiver, and nothing is kept
        // beyond the storage cost (anchor storage included).
        assert_eq!(
            transferred_to(&accounts(1)),
            MINT_DEPOSIT.as_yoctonear() - cost
        );
        assert_eq!(transferred_to(&accounts(2)), 0);
    }

    #[test]
    fn mint_with_half_the_storage_cost_panics() {
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        let mut contract = Contract::new_default_meta(accounts(1));
        let before = env::storage_usage();
        contract.nft_mint("aloof".to_string(), accounts(2), aloof_metadata());
        let cost =
            env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - before) as u128;

        testing_env!(context(accounts(1), NearToken::from_yoctonear(cost / 2)).build());
        let mut fresh = Contract::new_default_meta(accounts(1));
        let res = catch_unwind(AssertUnwindSafe(|| {
            fresh.nft_mint("cloof".to_string(), accounts(2), aloof_metadata());
        }));
        assert!(
            res.is_err(),
            "deposit below the storage cost must be rejected"
        );
    }

    #[test]
    #[should_panic(expected = "token_id must be unique")]
    fn mint_duplicate_token_id_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        contract.nft_mint("aloof".to_string(), accounts(3), aloof_metadata());
    }

    #[test]
    fn duplicate_mint_cannot_reset_anchor_or_owner() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());

        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        let res = catch_unwind(AssertUnwindSafe(|| {
            contract.nft_mint("aloof".to_string(), accounts(3), aloof_metadata());
        }));
        assert!(res.is_err());
        let anchor = contract.sheet_anchor("aloof".to_string()).unwrap();
        assert_eq!(anchor.sheet_hash.as_deref(), Some(HASH_A));
        assert_eq!(anchor.memory_depth, 2);
        assert_eq!(
            contract.nft_token("aloof".to_string()).unwrap().owner_id,
            accounts(2)
        );
    }

    #[test]
    #[should_panic(expected = "token_id must be 1 to 64 bytes")]
    fn mint_empty_token_id_panics() {
        mint_with("", aloof_metadata());
    }

    #[test]
    #[should_panic(expected = "token_id must be 1 to 64 bytes")]
    fn mint_overlong_token_id_panics() {
        mint_with(&"a".repeat(MAX_TOKEN_ID_LEN + 1), aloof_metadata());
    }

    #[test]
    #[should_panic(expected = "token_id may only contain")]
    fn mint_uppercase_token_id_panics() {
        mint_with("Aloof", aloof_metadata());
    }

    #[test]
    #[should_panic(expected = "token_id may only contain")]
    fn mint_token_id_with_dot_panics() {
        mint_with("a.b", aloof_metadata());
    }

    #[test]
    #[should_panic(expected = "token_id may only contain")]
    fn mint_token_id_with_non_ascii_panics() {
        mint_with("caf\u{e9}", aloof_metadata());
    }

    #[test]
    fn mint_accepts_js_compatible_token_id_charset() {
        mint_with("agent_0-z9", aloof_metadata());
    }

    #[test]
    fn mint_accepts_none_and_32_byte_hashes() {
        let mut m = aloof_metadata();
        m.media_hash = Some(near_sdk::json_types::Base64VecU8::from(vec![
            7u8;
            SHA256_BYTES
        ]));
        m.reference_hash = Some(near_sdk::json_types::Base64VecU8::from(vec![
            9u8;
            SHA256_BYTES
        ]));
        mint_with("x", m);
        mint_with("y", aloof_metadata());
    }

    #[test]
    #[should_panic(expected = "media_hash must be exactly 32 bytes")]
    fn mint_oversized_media_hash_panics() {
        let mut m = aloof_metadata();
        m.media_hash = Some(near_sdk::json_types::Base64VecU8::from(vec![0u8; 4096]));
        mint_with("x", m);
    }

    #[test]
    #[should_panic(expected = "media_hash must be exactly 32 bytes")]
    fn mint_short_media_hash_panics() {
        let mut m = aloof_metadata();
        m.media_hash = Some(near_sdk::json_types::Base64VecU8::from(vec![0u8; 31]));
        mint_with("x", m);
    }

    #[test]
    #[should_panic(expected = "reference_hash must be exactly 32 bytes")]
    fn mint_oversized_reference_hash_panics() {
        let mut m = aloof_metadata();
        m.reference_hash = Some(near_sdk::json_types::Base64VecU8::from(vec![0u8; 33]));
        mint_with("x", m);
    }

    #[test]
    #[should_panic(expected = "reference_hash must be exactly 32 bytes")]
    fn mint_empty_reference_hash_panics() {
        let mut m = aloof_metadata();
        m.reference_hash = Some(near_sdk::json_types::Base64VecU8::from(Vec::<u8>::new()));
        mint_with("x", m);
    }

    #[test]
    fn mint_accepts_limit_sized_fields() {
        let mut m = aloof_metadata();
        m.title = Some("t".repeat(MAX_TITLE_LEN));
        m.description = Some("d".repeat(MAX_DESCRIPTION_LEN));
        let pad = "x".repeat(MAX_EXTRA_LEN - r#"{"p":""}"#.len());
        m.extra = Some(format!(r#"{{"p":"{pad}"}}"#));
        assert_eq!(m.extra.as_ref().unwrap().len(), MAX_EXTRA_LEN);
        mint_with(&"a".repeat(MAX_TOKEN_ID_LEN), m);
    }

    #[test]
    #[should_panic(expected = "title is too long")]
    fn mint_overlong_title_panics() {
        let mut m = aloof_metadata();
        m.title = Some("t".repeat(MAX_TITLE_LEN + 1));
        mint_with("x", m);
    }

    #[test]
    #[should_panic(expected = "description is too long")]
    fn mint_overlong_description_panics() {
        let mut m = aloof_metadata();
        m.description = Some("d".repeat(MAX_DESCRIPTION_LEN + 1));
        mint_with("x", m);
    }

    #[test]
    #[should_panic(expected = "extra is too long")]
    fn mint_overlong_extra_panics() {
        let mut m = aloof_metadata();
        m.extra = Some(format!(r#"{{"p":"{}"}}"#, "x".repeat(MAX_EXTRA_LEN)));
        mint_with("x", m);
    }

    #[test]
    #[should_panic(expected = "media is too long")]
    fn mint_overlong_media_panics() {
        let mut m = aloof_metadata();
        m.media = Some("m".repeat(MAX_URI_LEN + 1));
        mint_with("x", m);
    }

    #[test]
    #[should_panic(expected = "extra must be a JSON object")]
    fn mint_non_json_extra_panics() {
        let mut m = aloof_metadata();
        m.extra = Some("not json".to_string());
        mint_with("x", m);
    }

    #[test]
    #[should_panic(expected = "extra must be a JSON object")]
    fn mint_non_object_extra_panics() {
        let mut m = aloof_metadata();
        m.extra = Some("[1,2]".to_string());
        mint_with("x", m);
    }

    #[test]
    #[should_panic(expected = "Must provide metadata")]
    fn mint_without_extra_metadata_is_allowed_but_none_token_metadata_is_not() {
        // `nft_mint` takes metadata by value, so the standard's guard is the
        // last line of defence if the signature ever becomes optional.
        let mut c = Contract::new_default_meta(accounts(1));
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        c.tokens
            .internal_mint_with_refund("y".to_string(), accounts(2), None, None);
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_without_yocto_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), NearToken::from_yoctonear(0)).build());
        contract.nft_transfer(accounts(3), "aloof".to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "Sender not approved")]
    fn transfer_by_non_owner_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        contract.nft_transfer(accounts(3), "aloof".to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "Sender not approved")]
    fn contract_owner_cannot_transfer_a_token_it_minted_to_someone_else() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(1), ONE_YOCTO).build());
        contract.nft_transfer(accounts(1), "aloof".to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "Current and next owner must differ")]
    fn transfer_to_self_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer(accounts(2), "aloof".to_string(), None, None);
    }

    fn approve(contract: &mut Contract, spender: AccountId) -> u64 {
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.nft_approve("aloof".to_string(), spender.clone(), None);
        contract
            .nft_token("aloof".to_string())
            .unwrap()
            .approved_account_ids
            .unwrap()[&spender]
    }

    #[test]
    fn approved_account_transfers_with_right_approval_id_and_approvals_clear() {
        let mut contract = minted_contract();
        let id = approve(&mut contract, accounts(3));
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        contract.nft_transfer(accounts(4), "aloof".to_string(), Some(id), None);
        let token = contract.nft_token("aloof".to_string()).unwrap();
        assert_eq!(token.owner_id, accounts(4));
        assert!(token.approved_account_ids.unwrap().is_empty());
        assert!(!contract.nft_is_approved("aloof".to_string(), accounts(3), None));
    }

    #[test]
    #[should_panic(expected = "is different from the given approval_id")]
    fn approved_transfer_with_wrong_approval_id_panics() {
        let mut contract = minted_contract();
        let id = approve(&mut contract, accounts(3));
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        contract.nft_transfer(accounts(4), "aloof".to_string(), Some(id + 1), None);
    }

    #[test]
    #[should_panic(expected = "Sender not approved")]
    fn revoked_account_cannot_transfer() {
        let mut contract = minted_contract();
        approve(&mut contract, accounts(3));
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_revoke("aloof".to_string(), accounts(3));
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        contract.nft_transfer(accounts(4), "aloof".to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "Sender not approved")]
    fn revoke_all_removes_every_approval() {
        let mut contract = minted_contract();
        approve(&mut contract, accounts(3));
        approve(&mut contract, accounts(4));
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_revoke_all("aloof".to_string());
        testing_env!(context(accounts(4), ONE_YOCTO).build());
        contract.nft_transfer(accounts(4), "aloof".to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "Predecessor must be token owner")]
    fn non_owner_cannot_approve() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        contract.nft_approve("aloof".to_string(), accounts(3), None);
    }

    #[test]
    #[should_panic(expected = "Predecessor must be token owner")]
    fn approved_account_cannot_revoke_others_or_approve_more() {
        let mut contract = minted_contract();
        approve(&mut contract, accounts(3));
        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        contract.nft_approve("aloof".to_string(), accounts(4), None);
    }

    #[test]
    #[should_panic(expected = "only the token owner can anchor a sheet")]
    fn approved_account_cannot_anchor() {
        let mut contract = minted_contract();
        approve(&mut contract, accounts(3));
        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
    }

    #[test]
    fn approvals_do_not_survive_transfer_so_old_spender_cannot_move_it_back() {
        let mut contract = minted_contract();
        approve(&mut contract, accounts(3));
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer(accounts(4), "aloof".to_string(), None, None);
        let res = catch_unwind(AssertUnwindSafe(|| {
            testing_env!(context(accounts(3), ONE_YOCTO).build());
            contract.nft_transfer(accounts(3), "aloof".to_string(), None, None);
        }));
        assert!(res.is_err());
    }

    #[test]
    #[should_panic(expected = "already anchored")]
    fn anchoring_the_same_hash_twice_does_not_inflate_memory_depth() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
    }

    #[test]
    fn first_anchor_with_only_one_yocto_cannot_cover_new_storage() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        let res = catch_unwind(AssertUnwindSafe(|| {
            contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        }));
        assert!(res.is_err());
    }

    #[test]
    fn anchor_refunds_excess_deposit_to_the_token_owner() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        let before = env::storage_usage();
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        let cost =
            env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - before) as u128;
        assert!(cost > 0);
        assert_eq!(
            transferred_to(&accounts(2)),
            MINT_DEPOSIT.as_yoctonear() - cost
        );
        assert_eq!(transferred_to(&accounts(1)), 0);
    }

    #[test]
    fn failed_anchor_by_stranger_leaves_anchor_untouched() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        let res = catch_unwind(AssertUnwindSafe(|| {
            contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        }));
        assert!(res.is_err());
        let anchor = contract.sheet_anchor("aloof".to_string()).unwrap();
        assert_eq!(anchor.sheet_hash, None);
        assert_eq!(anchor.memory_depth, INITIAL_MEMORY_DEPTH);
    }

    fn panics<F: FnOnce()>(f: F) -> bool {
        catch_unwind(AssertUnwindSafe(f)).is_err()
    }

    /// True if `f` panics and the panic message contains `needle`, the same
    /// substring check `#[should_panic(expected = ..)]` performs.
    fn panics_with<F: FnOnce()>(f: F, needle: &str) -> bool {
        match catch_unwind(AssertUnwindSafe(f)) {
            Ok(()) => false,
            Err(payload) => payload
                .downcast_ref::<String>()
                .map(String::as_str)
                .or_else(|| payload.downcast_ref::<&str>().copied())
                .is_some_and(|msg| msg.contains(needle)),
        }
    }

    fn resolve(contract: &mut Contract, receiver_reverts: bool) -> bool {
        resolve_with_nonce(contract, receiver_reverts, 0)
    }

    fn resolve_with_nonce(contract: &mut Contract, receiver_reverts: bool, nonce: u64) -> bool {
        resolve_chain(
            contract,
            accounts(2),
            accounts(3),
            receiver_reverts,
            nonce,
            0,
        )
    }

    /// Runs the two callbacks `nft_transfer_call` schedules, in order, with the
    /// promise results the runtime would hand each: the receiver's answer to
    /// `nft_resolve_transfer`, then its bool to `release_lock`.
    fn resolve_chain(
        contract: &mut Contract,
        previous_owner: AccountId,
        receiver: AccountId,
        receiver_reverts: bool,
        nonce: u64,
        block_height: u64,
    ) -> bool {
        callback_env(receiver_reverts.to_string().into_bytes(), block_height);
        let kept =
            contract.nft_resolve_transfer(previous_owner, receiver, "aloof".to_string(), None);
        callback_env(kept.to_string().into_bytes(), block_height);
        contract.release_lock("aloof".to_string(), U64(nonce))
    }

    fn callback_env(promise_result: Vec<u8>, block_height: u64) {
        testing_env!(
            context(accounts(0), NearToken::from_yoctonear(0))
                .block_height(block_height)
                .build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Successful(promise_result)]
        );
    }

    fn function_calls(receipts: &[near_sdk::mock::Receipt]) -> Vec<(String, Vec<u8>, Gas)> {
        receipts
            .iter()
            .flat_map(|r| r.actions.iter())
            .filter_map(|a| match a {
                MockAction::FunctionCallWeight {
                    method_name,
                    args,
                    prepaid_gas,
                    ..
                } => Some((
                    String::from_utf8(method_name.clone()).unwrap(),
                    args.clone(),
                    *prepaid_gas,
                )),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn transfer_call_schedules_standard_resolve_then_release_lock_with_its_nonce() {
        let mut contract = minted_contract();
        // Two transfer calls so the lock under test carries nonce 1, not the
        // default 0, proving the receipt carries the stored nonce.
        testing_env!(context(accounts(2), ONE_YOCTO)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
        assert!(resolve(&mut contract, false));
        testing_env!(context(accounts(3), ONE_YOCTO)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(4), "aloof".to_string(), None, None, "".into());
        let stored_nonce = contract.in_flight.get("aloof").unwrap().nonce;
        assert_eq!(stored_nonce, 1);

        let receipts = get_created_receipts();
        assert_eq!(receipts.len(), 3, "receiver call, resolve, release");
        assert_eq!(receipts[0].receiver_id, accounts(4));
        assert_eq!(receipts[1].receiver_id, accounts(0));
        assert_eq!(receipts[2].receiver_id, accounts(0));
        // Each callback depends on the receipt before it. The mock records a
        // dependency as the position of the receipt's `CreateReceipt` entry in
        // its action log, where each receipt is followed by its own actions.
        let mut action_log_index = vec![0usize];
        for r in &receipts[..receipts.len() - 1] {
            action_log_index.push(action_log_index.last().unwrap() + 1 + r.actions.len());
        }
        assert_eq!(receipts[0].receipt_indices, Vec::<u64>::new());
        assert_eq!(
            receipts[1].receipt_indices,
            vec![action_log_index[0] as u64]
        );
        assert_eq!(
            receipts[2].receipt_indices,
            vec![action_log_index[1] as u64]
        );

        let calls = function_calls(&receipts);
        let names: Vec<&str> = calls.iter().map(|(n, _, _)| n.as_str()).collect();
        assert_eq!(
            names,
            vec!["nft_on_transfer", "nft_resolve_transfer", "release_lock"]
        );
        // The standard callback keeps its standard arguments and gas budget.
        let resolve_args: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_slice(&calls[1].1).unwrap();
        assert_eq!(resolve_args["previous_owner_id"], accounts(3).to_string());
        assert_eq!(resolve_args["receiver_id"], accounts(4).to_string());
        assert_eq!(resolve_args["token_id"], "aloof");
        assert_eq!(calls[1].2, GAS_FOR_RESOLVE_TRANSFER);
        // The release callback carries exactly the nonce stored in the lock.
        let release_args: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_slice(&calls[2].1).unwrap();
        assert_eq!(release_args["token_id"], "aloof");
        assert_eq!(release_args["nonce"], stored_nonce.to_string());
        // Pinned to the literal, not the constant: `release_lock` is the only
        // thing that clears a lock, so its budget must keep a margin over the
        // 5 Tgas the SDK gives the comparable resolve callback.
        assert_eq!(calls[2].2, GAS_FOR_RELEASE_LOCK);
        assert_eq!(calls[2].2, Gas::from_tgas(10));
    }

    #[test]
    fn release_lock_forwards_resolve_result_and_survives_a_failed_resolve() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
        // A failed resolve result: no panic, lock still released, reported as
        // completed because ownership was not rolled back.
        testing_env!(
            context(accounts(0), NearToken::from_yoctonear(0)).build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![near_sdk::PromiseResult::Failed]
        );
        assert!(contract.release_lock("aloof".to_string(), U64(0)));
        assert!(!contract.is_in_flight(&"aloof".to_string()));
        // Forwards `false` from a successful resolve that returned the token.
        callback_env(b"false".to_vec(), 0);
        assert!(!contract.release_lock("aloof".to_string(), U64(0)));
    }

    #[test]
    fn anchor_is_frozen_during_transfer_call_and_unfrozen_after_revert() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
        // The receiver owns the token now but must not touch the anchor.
        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        assert!(panics(|| {
            contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        }));
        // A nested transfer call cannot overwrite the in-flight lock either.
        testing_env!(context(accounts(3), ONE_YOCTO)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        assert!(panics(|| {
            let _ =
                contract.nft_transfer_call(accounts(4), "aloof".to_string(), None, None, "".into());
        }));
        // The receiver reverts the transfer: the token returns, anchor untouched.
        assert!(!resolve(&mut contract, true));
        let token = contract.nft_token("aloof".to_string()).unwrap();
        assert_eq!(token.owner_id, accounts(2));
        let anchor = contract.sheet_anchor("aloof".to_string()).unwrap();
        assert_eq!(anchor.sheet_hash, None);
        assert_eq!(anchor.memory_depth, INITIAL_MEMORY_DEPTH);
        // The owner can anchor again once the transfer resolved.
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        let anchor = contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        assert_eq!(anchor.memory_depth, 2);
    }

    #[test]
    fn resolve_success_keeps_token_with_receiver_and_clears_lock() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
        // Receiver accepted the token (did not ask for a return).
        assert!(resolve(&mut contract, false));
        let token = contract.nft_token("aloof".to_string()).unwrap();
        assert_eq!(token.owner_id, accounts(3));
        // Lock cleared: the new owner can anchor right away.
        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        let anchor = contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        assert_eq!(anchor.memory_depth, 2);
    }

    #[test]
    #[should_panic(expected = "Must attach")]
    fn anchor_sheet_with_underfunded_deposit_panics() {
        let mut contract = minted_contract();
        // 1 yocto passes the >= 1 check but cannot cover the anchor storage.
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
    }

    /// Audit 3, M-1, inverted. A receiver that stalls its `nft_on_transfer`
    /// (chained yields, congested hops) is the recorded owner for as long as
    /// the gas the sender attached lets it stall, but the lock never expires:
    /// at every height it can neither anchor, nest a transfer call, nor sell
    /// with a pinned anchor. When it finally returns the token, the previous
    /// owner gets it back with the anchor untouched and no hash burned in
    /// `seen_hashes`.
    ///
    /// The loop over block heights is a regression guard against reintroducing
    /// a height-based expiry: the heights straddle the old 1000-block window
    /// (inside, at, and far past it) and end at `u64::MAX`, so any unlock that
    /// keys off `block_height` fails at least one iteration.
    #[test]
    fn receiver_cannot_anchor_at_any_height_while_locked() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO)
            .block_height(1_000)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
        // Resolution never runs. The heights cover the old 1000-block window
        // (1_999 inside, 2_000 at, 11_000 far past) and the maximum height.
        for height in [1_000u64, 1_999, 2_000, 11_000, u64::MAX] {
            testing_env!(context(accounts(3), MINT_DEPOSIT)
                .block_height(height)
                .build());
            assert!(
                contract.nft_in_flight("aloof".to_string()),
                "height {height}"
            );
            assert_eq!(
                contract.nft_token("aloof".to_string()).unwrap().owner_id,
                accounts(3)
            );
            assert!(
                panics(|| {
                    contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
                }),
                "receiver anchored at height {height}"
            );
            testing_env!(context(accounts(3), ONE_YOCTO)
                .block_height(height)
                .prepaid_gas(near_sdk::Gas::from_tgas(100))
                .build());
            assert!(
                panics(|| {
                    let _ = contract.nft_transfer_call(
                        accounts(4),
                        "aloof".to_string(),
                        None,
                        None,
                        "".into(),
                    );
                }),
                "receiver nested a transfer call at height {height}"
            );
            assert!(
                panics(|| {
                    contract.nft_transfer_expecting_anchor(
                        accounts(4),
                        "aloof".to_string(),
                        None,
                        None,
                        None,
                        INITIAL_MEMORY_DEPTH,
                    );
                }),
                "receiver sold with a pinned anchor at height {height}"
            );
        }
        // The receiver finally asks for the return, far past the old window.
        assert!(!resolve_chain(
            &mut contract,
            accounts(2),
            accounts(3),
            true,
            0,
            u64::MAX
        ));
        assert!(!contract.nft_in_flight("aloof".to_string()));
        let token = contract.nft_token("aloof".to_string()).unwrap();
        assert_eq!(token.owner_id, accounts(2));
        let anchor = contract.sheet_anchor("aloof".to_string()).unwrap();
        assert_eq!(anchor.sheet_hash, None);
        assert_eq!(anchor.memory_depth, INITIAL_MEMORY_DEPTH);
        // Nothing was burned: the owner can still anchor the hash the receiver
        // tried to plant.
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        let anchor = contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        assert_eq!(anchor.sheet_hash.as_deref(), Some(HASH_A));
        assert_eq!(anchor.memory_depth, 2);
    }

    /// With no expiry a lock is replaced only after `release_lock` cleared the
    /// previous one, so the nonce check guards the one remaining ordering: a
    /// stale or replayed callback of an earlier transfer arriving while a later
    /// transfer's lock is set.
    #[test]
    fn stale_callback_cannot_clear_a_later_transfers_lock() {
        let mut contract = minted_contract();
        // Transfer 1 (nonce 0): account 2 -> 3, resolved and released.
        testing_env!(context(accounts(2), ONE_YOCTO)
            .block_height(1_000)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
        assert!(resolve_chain(
            &mut contract,
            accounts(2),
            accounts(3),
            false,
            0,
            1_001
        ));
        assert!(!contract.nft_in_flight("aloof".to_string()));
        // Transfer 2 (nonce 1): account 3 sends the token on to account 4.
        testing_env!(context(accounts(3), ONE_YOCTO)
            .block_height(1_002)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(4), "aloof".to_string(), None, None, "".into());
        assert_eq!(contract.in_flight.get("aloof").unwrap().nonce, 1);
        // Transfer 1's callbacks run again with a "return the token" answer.
        // The token has moved on, so the standard resolve is a no-op, and
        // `release_lock` sees a foreign nonce and leaves transfer 2's lock.
        assert!(resolve_chain(
            &mut contract,
            accounts(2),
            accounts(3),
            true,
            0,
            1_003
        ));
        assert!(contract.nft_in_flight("aloof".to_string()));
        assert_eq!(
            contract.nft_token("aloof".to_string()).unwrap().owner_id,
            accounts(4)
        );
        testing_env!(context(accounts(4), MINT_DEPOSIT)
            .block_height(1_004)
            .build());
        assert!(panics(|| {
            contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        }));
        // Transfer 2's own callbacks (nonce 1) clear it.
        assert!(resolve_chain(
            &mut contract,
            accounts(3),
            accounts(4),
            false,
            1,
            1_005
        ));
        assert!(!contract.nft_in_flight("aloof".to_string()));
        testing_env!(context(accounts(4), MINT_DEPOSIT)
            .block_height(1_006)
            .build());
        let anchor = contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        assert_eq!(anchor.memory_depth, 2);
    }

    #[test]
    fn nft_in_flight_view_tracks_the_lock() {
        let mut contract = minted_contract();
        assert!(!contract.nft_in_flight("aloof".to_string()));
        assert!(!contract.nft_in_flight("no-such-token".to_string()));
        testing_env!(context(accounts(2), ONE_YOCTO)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
        assert!(contract.nft_in_flight("aloof".to_string()));
        assert!(resolve(&mut contract, false));
        assert!(!contract.nft_in_flight("aloof".to_string()));
    }

    #[test]
    fn transfer_expecting_anchor_refuses_an_in_flight_token_and_works_after() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
        // The receiver owns the token and the pinned anchor matches, but the
        // pending resolve may still take the token back, so the sale is refused.
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        assert!(panics(|| {
            contract.nft_transfer_expecting_anchor(
                accounts(4),
                "aloof".to_string(),
                None,
                None,
                None,
                INITIAL_MEMORY_DEPTH,
            );
        }));
        assert_eq!(
            contract.nft_token("aloof".to_string()).unwrap().owner_id,
            accounts(3)
        );
        // Once the receiver has kept the token and the lock is released, the
        // same sale goes through.
        assert!(resolve(&mut contract, false));
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        contract.nft_transfer_expecting_anchor(
            accounts(4),
            "aloof".to_string(),
            None,
            None,
            None,
            INITIAL_MEMORY_DEPTH,
        );
        assert_eq!(
            contract.nft_token("aloof".to_string()).unwrap().owner_id,
            accounts(4)
        );
    }

    #[test]
    fn stale_callback_with_unknown_nonce_does_not_panic_or_freeze() {
        let mut contract = minted_contract();
        // No lock at all and a made-up nonce: still settles, nothing frozen.
        let _ = resolve_with_nonce(&mut contract, false, 99);
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        let anchor = contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        assert_eq!(anchor.memory_depth, 2);
    }

    #[test]
    fn alternating_two_hashes_cannot_inflate_depth() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        contract.anchor_sheet("aloof".to_string(), HASH_B.to_string());
        assert!(panics(|| {
            contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        }));
        let anchor = contract.sheet_anchor("aloof".to_string()).unwrap();
        assert_eq!(anchor.sheet_hash.as_deref(), Some(HASH_B));
        assert_eq!(anchor.memory_depth, 3);
    }

    #[test]
    fn transfer_expecting_anchor_checks_hash_and_depth() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        for (hash, depth) in [(Some(HASH_B), 2), (Some(HASH_A), 3), (None, 2)] {
            assert!(panics(|| {
                contract.nft_transfer_expecting_anchor(
                    accounts(3),
                    "aloof".to_string(),
                    None,
                    None,
                    hash.map(String::from),
                    depth,
                );
            }));
        }
        contract.nft_transfer_expecting_anchor(
            accounts(3),
            "aloof".to_string(),
            None,
            None,
            Some(HASH_A.to_string()),
            2,
        );
        let token = contract.nft_token("aloof".to_string()).unwrap();
        assert_eq!(token.owner_id, accounts(3));
    }

    #[test]
    #[should_panic(expected = "cannot mint to the contract account itself")]
    fn mint_to_the_contract_account_panics() {
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        let mut contract = Contract::new_default_meta(accounts(1));
        contract.nft_mint("x".to_string(), accounts(0), aloof_metadata());
    }

    #[test]
    #[should_panic(expected = "copies must be 1")]
    fn mint_with_copies_other_than_one_panics() {
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        let mut contract = Contract::new_default_meta(accounts(1));
        let mut meta = aloof_metadata();
        meta.copies = Some(1000);
        contract.nft_mint("x".to_string(), accounts(2), meta);
    }

    // ---- edge-case gap tests ---------------------------------------------
    //
    // `#[private]` on `nft_resolve_transfer` and `release_lock` is enforced by
    // the generated wasm entry point, not by the Rust method, so an outside
    // caller of those two can only be tested against a sandbox. Everything
    // else below runs against the mock VM.

    /// Context for a 1-yocto `nft_transfer_call` with enough prepaid gas for
    /// the three receipts it schedules.
    fn transfer_call_env(sender: AccountId) {
        testing_env!(context(sender, ONE_YOCTO)
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
    }

    fn anchor_of(contract: &Contract) -> SheetAnchor {
        contract.sheet_anchor("aloof".to_string()).expect("anchor")
    }

    fn owner_of(contract: &Contract) -> AccountId {
        contract
            .nft_token("aloof".to_string())
            .expect("token")
            .owner_id
    }

    // -- unauthorized callers ----------------------------------------------

    #[test]
    #[should_panic(expected = "Sender not approved")]
    fn transfer_call_by_non_owner_panics() {
        let mut contract = minted_contract();
        transfer_call_env(accounts(3));
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
    }

    #[test]
    #[should_panic(expected = "Sender not approved")]
    fn transfer_call_by_contract_owner_panics() {
        let mut contract = minted_contract();
        transfer_call_env(accounts(1));
        let _ = contract.nft_transfer_call(accounts(1), "aloof".to_string(), None, None, "".into());
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_call_without_yocto_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), NearToken::from_yoctonear(0))
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_call_with_two_yocto_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), NearToken::from_yoctonear(2))
            .prepaid_gas(near_sdk::Gas::from_tgas(100))
            .build());
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
    }

    #[test]
    #[should_panic(expected = "Sender not approved")]
    fn transfer_expecting_anchor_by_non_owner_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        // The pinned anchor is correct; the caller is not.
        contract.nft_transfer_expecting_anchor(
            accounts(3),
            "aloof".to_string(),
            None,
            None,
            None,
            INITIAL_MEMORY_DEPTH,
        );
    }

    #[test]
    #[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
    fn transfer_expecting_anchor_without_yocto_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), NearToken::from_yoctonear(0)).build());
        contract.nft_transfer_expecting_anchor(
            accounts(3),
            "aloof".to_string(),
            None,
            None,
            None,
            INITIAL_MEMORY_DEPTH,
        );
    }

    #[test]
    #[should_panic(expected = "Sender not approved")]
    fn previous_owner_cannot_transfer_after_transfer() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer(accounts(3), "aloof".to_string(), None, None);
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer(accounts(2), "aloof".to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "Predecessor must be token owner")]
    fn approved_account_cannot_revoke_itself() {
        let mut contract = minted_contract();
        approve(&mut contract, accounts(3));
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        contract.nft_revoke("aloof".to_string(), accounts(3));
    }

    #[test]
    #[should_panic(expected = "Predecessor must be token owner")]
    fn stranger_cannot_revoke() {
        let mut contract = minted_contract();
        approve(&mut contract, accounts(3));
        testing_env!(context(accounts(4), ONE_YOCTO).build());
        contract.nft_revoke("aloof".to_string(), accounts(3));
    }

    #[test]
    #[should_panic(expected = "Predecessor must be token owner")]
    fn approved_account_cannot_revoke_all() {
        let mut contract = minted_contract();
        approve(&mut contract, accounts(3));
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        contract.nft_revoke_all("aloof".to_string());
    }

    #[test]
    #[should_panic(expected = "Predecessor must be token owner")]
    fn contract_owner_cannot_revoke_all_on_someone_elses_token() {
        let mut contract = minted_contract();
        approve(&mut contract, accounts(3));
        testing_env!(context(accounts(1), ONE_YOCTO).build());
        contract.nft_revoke_all("aloof".to_string());
    }

    #[test]
    fn failed_revoke_by_stranger_leaves_approval_in_place() {
        let mut contract = minted_contract();
        let id = approve(&mut contract, accounts(3));
        testing_env!(context(accounts(4), ONE_YOCTO).build());
        assert!(panics(
            || contract.nft_revoke("aloof".to_string(), accounts(3))
        ));
        assert!(contract.nft_is_approved("aloof".to_string(), accounts(3), Some(id)));
    }

    // -- sheet_hash validation through the contract method -----------------

    #[test]
    #[should_panic(expected = "sheet_hash must be 64 lowercase hex characters")]
    fn anchor_sheet_rejects_uppercase_hash() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_uppercase());
    }

    #[test]
    #[should_panic(expected = "sheet_hash must be 64 lowercase hex characters")]
    fn anchor_sheet_rejects_63_char_hash() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A[..63].to_string());
    }

    #[test]
    #[should_panic(expected = "sheet_hash must be 64 lowercase hex characters")]
    fn anchor_sheet_rejects_65_char_hash() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), format!("{HASH_A}0"));
    }

    #[test]
    #[should_panic(expected = "sheet_hash must be 64 lowercase hex characters")]
    fn anchor_sheet_rejects_64_char_non_hex_hash() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), format!("g{}", &HASH_A[1..]));
    }

    #[test]
    fn rejected_hashes_leave_anchor_untouched_and_do_not_burn_the_lowercase_form() {
        let mut contract = minted_contract();
        let bad: Vec<String> = vec![
            String::new(),
            HASH_A.to_uppercase(),
            // Mixed case: one uppercase nibble.
            format!("{}A{}", &HASH_A[..10], &HASH_A[11..]),
            HASH_A[..63].to_string(),
            format!("{HASH_A}0"),
            format!("g{}", &HASH_A[1..]),
            // 64 bytes with whitespace and with a multibyte character.
            format!("{} ", &HASH_A[..63]),
            format!("{}\u{e9}", &HASH_A[..62]),
            // Exactly 64 bytes, rejected only for the non-hex 'x' of the prefix.
            format!("0x{}", &HASH_A[..62]),
        ];
        for hash in bad {
            testing_env!(context(accounts(2), MINT_DEPOSIT).build());
            assert!(
                panics(|| {
                    contract.anchor_sheet("aloof".to_string(), hash.clone());
                }),
                "accepted {hash:?}"
            );
            let anchor = anchor_of(&contract);
            assert_eq!(anchor.sheet_hash, None, "hash set by {hash:?}");
            assert_eq!(anchor.memory_depth, INITIAL_MEMORY_DEPTH);
        }
        // The canonical form of a rejected hash is still anchorable.
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        let anchor = contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        assert_eq!(anchor.sheet_hash.as_deref(), Some(HASH_A));
        assert_eq!(anchor.memory_depth, 2);
    }

    // -- memory_depth bounds -----------------------------------------------

    fn set_depth(contract: &mut Contract, depth: u32) {
        contract
            .sheet_anchors
            .get_mut("aloof")
            .expect("anchor")
            .memory_depth = depth;
    }

    #[test]
    fn memory_depth_can_reach_u32_max() {
        let mut contract = minted_contract();
        set_depth(&mut contract, u32::MAX - 1);
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        let anchor = contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        assert_eq!(anchor.memory_depth, u32::MAX);
        assert_eq!(anchor_of(&contract).memory_depth, u32::MAX);
    }

    #[test]
    #[should_panic(expected = "memory depth overflow")]
    fn memory_depth_at_u32_max_panics_instead_of_wrapping() {
        let mut contract = minted_contract();
        set_depth(&mut contract, u32::MAX);
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
    }

    #[test]
    fn memory_depth_grows_by_exactly_one_per_distinct_hash() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        for i in 0u32..5 {
            let hash = format!("{:064x}", 0x1000u128 + u128::from(i));
            let anchor = contract.anchor_sheet("aloof".to_string(), hash.clone());
            assert_eq!(anchor.memory_depth, INITIAL_MEMORY_DEPTH + i + 1);
            assert_eq!(anchor.sheet_hash, Some(hash));
        }
        assert_eq!(anchor_of(&contract).memory_depth, 6);
    }

    // -- anchors and depth across nft_transfer_call ------------------------

    #[test]
    fn anchored_token_keeps_history_when_receiver_keeps_it() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());

        transfer_call_env(accounts(2));
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
        // Frozen in flight, history intact.
        let in_flight = anchor_of(&contract);
        assert_eq!(in_flight.sheet_hash.as_deref(), Some(HASH_A));
        assert_eq!(in_flight.memory_depth, 2);

        assert!(resolve(&mut contract, false));
        assert_eq!(owner_of(&contract), accounts(3));
        let kept = anchor_of(&contract);
        assert_eq!(kept.sheet_hash.as_deref(), Some(HASH_A));
        assert_eq!(kept.memory_depth, 2);

        // The new owner continues the history; the old owner cannot.
        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        let next = contract.anchor_sheet("aloof".to_string(), HASH_B.to_string());
        assert_eq!(next.memory_depth, 3);
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        assert!(panics(|| {
            contract.anchor_sheet("aloof".to_string(), format!("{:064x}", 0xdead_beefu64));
        }));
        assert_eq!(anchor_of(&contract).memory_depth, 3);
    }

    #[test]
    fn anchored_token_keeps_history_when_receiver_returns_it() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());

        transfer_call_env(accounts(2));
        let _ = contract.nft_transfer_call(accounts(3), "aloof".to_string(), None, None, "".into());
        assert!(!resolve(&mut contract, true));

        assert_eq!(owner_of(&contract), accounts(2));
        assert!(!contract.nft_in_flight("aloof".to_string()));
        let returned = anchor_of(&contract);
        assert_eq!(returned.sheet_hash.as_deref(), Some(HASH_A));
        assert_eq!(returned.memory_depth, 2);

        // The would-be receiver is a stranger again.
        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        assert!(panics(|| {
            contract.anchor_sheet("aloof".to_string(), HASH_B.to_string());
        }));
        // The original owner continues from where it left off, and HASH_B
        // was not burned by the receiver's failed attempt.
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        let next = contract.anchor_sheet("aloof".to_string(), HASH_B.to_string());
        assert_eq!(next.sheet_hash.as_deref(), Some(HASH_B));
        assert_eq!(next.memory_depth, 3);
    }

    #[test]
    fn depth_counts_distinct_sheets_across_owners() {
        // Owner 2 anchors A, hands the token to 3 who anchors B, hands it back
        // to 2, who may not re-anchor A or B but can add a third.
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer(accounts(3), "aloof".to_string(), None, None);
        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_B.to_string());
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        contract.nft_transfer(accounts(2), "aloof".to_string(), None, None);

        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        assert!(panics(|| {
            contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        }));
        assert!(panics(|| {
            contract.anchor_sheet("aloof".to_string(), HASH_B.to_string());
        }));
        let third = format!("{:064x}", 3u8);
        let anchor = contract.anchor_sheet("aloof".to_string(), third.clone());
        assert_eq!(anchor.sheet_hash, Some(third));
        assert_eq!(anchor.memory_depth, 4);
    }

    // -- approvals across transfers ----------------------------------------

    #[test]
    fn transfer_call_clears_approvals_and_a_revert_restores_them() {
        let mut contract = minted_contract();
        let id = approve(&mut contract, accounts(3));
        transfer_call_env(accounts(2));
        let _ = contract.nft_transfer_call(accounts(4), "aloof".to_string(), None, None, "".into());
        // While in flight the receiver holds the token with no approvals.
        assert_eq!(owner_of(&contract), accounts(4));
        assert!(!contract.nft_is_approved("aloof".to_string(), accounts(3), None));
        assert!(contract
            .nft_token("aloof".to_string())
            .unwrap()
            .approved_account_ids
            .unwrap()
            .is_empty());

        // The contract hands the saved approvals to the scheduled resolve
        // callback; run that callback with exactly the arguments it scheduled.
        let calls = function_calls(&get_created_receipts());
        let resolve_args: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_slice(&calls[1].1).unwrap();
        let saved: Option<HashMap<AccountId, u64>> =
            near_sdk::serde_json::from_value(resolve_args["approved_account_ids"].clone()).unwrap();
        assert_eq!(saved.as_ref().and_then(|m| m.get(&accounts(3))), Some(&id));

        // Receiver returns the token: the previous owner's approvals come back
        // with their original approval ids.
        callback_env(b"true".to_vec(), 0);
        let kept =
            contract.nft_resolve_transfer(accounts(2), accounts(4), "aloof".to_string(), saved);
        assert!(!kept);
        callback_env(b"false".to_vec(), 0);
        assert!(!contract.release_lock("aloof".to_string(), U64(0)));
        assert!(!contract.nft_in_flight("aloof".to_string()));
        assert_eq!(owner_of(&contract), accounts(2));
        assert!(contract.nft_is_approved("aloof".to_string(), accounts(3), Some(id)));
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        contract.nft_transfer(accounts(5), "aloof".to_string(), Some(id), None);
        assert_eq!(owner_of(&contract), accounts(5));
    }

    #[test]
    fn transfer_call_kept_by_receiver_leaves_old_approvals_dead() {
        let mut contract = minted_contract();
        let id = approve(&mut contract, accounts(3));
        transfer_call_env(accounts(2));
        let _ = contract.nft_transfer_call(accounts(4), "aloof".to_string(), None, None, "".into());
        assert!(resolve_chain(
            &mut contract,
            accounts(2),
            accounts(4),
            false,
            0,
            0
        ));
        assert_eq!(owner_of(&contract), accounts(4));
        assert!(!contract.nft_is_approved("aloof".to_string(), accounts(3), None));
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        assert!(panics(|| {
            contract.nft_transfer(accounts(3), "aloof".to_string(), Some(id), None);
        }));
        assert_eq!(owner_of(&contract), accounts(4));
    }

    #[test]
    fn approved_transfer_call_schedules_resolve_with_the_real_owner() {
        let mut contract = minted_contract();
        let id = approve(&mut contract, accounts(3));
        transfer_call_env(accounts(3));
        let _ =
            contract.nft_transfer_call(accounts(4), "aloof".to_string(), Some(id), None, "".into());
        assert!(contract.nft_in_flight("aloof".to_string()));
        assert_eq!(owner_of(&contract), accounts(4));
        // The resolve callback is scheduled with the owner, not the spender,
        // as `previous_owner_id`, so a revert returns the token to the owner.
        let calls = function_calls(&get_created_receipts());
        let resolve_args: near_sdk::serde_json::Value =
            near_sdk::serde_json::from_slice(&calls[1].1).unwrap();
        assert_eq!(resolve_args["previous_owner_id"], accounts(2).to_string());
        assert!(!resolve_chain(
            &mut contract,
            accounts(2),
            accounts(4),
            true,
            0,
            0
        ));
        assert_eq!(owner_of(&contract), accounts(2));
    }

    #[test]
    #[should_panic(expected = "is different from the given approval_id")]
    fn approved_transfer_call_with_wrong_approval_id_panics() {
        let mut contract = minted_contract();
        let id = approve(&mut contract, accounts(3));
        transfer_call_env(accounts(3));
        let _ = contract.nft_transfer_call(
            accounts(4),
            "aloof".to_string(),
            Some(id + 1),
            None,
            "".into(),
        );
    }

    #[test]
    fn transfer_expecting_anchor_clears_approvals() {
        let mut contract = minted_contract();
        let id = approve(&mut contract, accounts(3));
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer_expecting_anchor(
            accounts(4),
            "aloof".to_string(),
            None,
            None,
            None,
            INITIAL_MEMORY_DEPTH,
        );
        assert_eq!(owner_of(&contract), accounts(4));
        assert!(!contract.nft_is_approved("aloof".to_string(), accounts(3), Some(id)));
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        assert!(panics(|| {
            contract.nft_transfer(accounts(3), "aloof".to_string(), Some(id), None);
        }));
    }

    #[test]
    fn approved_spender_can_use_transfer_expecting_anchor_with_its_approval_id() {
        let mut contract = minted_contract();
        let id = approve(&mut contract, accounts(3));
        testing_env!(context(accounts(3), ONE_YOCTO).build());
        contract.nft_transfer_expecting_anchor(
            accounts(4),
            "aloof".to_string(),
            Some(id),
            None,
            None,
            INITIAL_MEMORY_DEPTH,
        );
        assert_eq!(owner_of(&contract), accounts(4));
    }

    // -- storage deposits --------------------------------------------------

    /// Mints a second 5-byte token id to accounts(2) and returns its storage
    /// cost in yoctoNEAR. Measured on the same contract the caller keeps
    /// using, because the mock keeps storage across `testing_env!` (so a
    /// "fresh" contract is not fresh) and the standard allocates an owner's
    /// token set only on that owner's first mint.
    fn next_mint_cost(contract: &mut Contract) -> u128 {
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        let before = env::storage_usage();
        contract.nft_mint("bloof".to_string(), accounts(2), aloof_metadata());
        env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - before) as u128
    }

    #[test]
    fn mint_with_exact_storage_cost_succeeds_and_refunds_nothing() {
        let mut contract = minted_contract();
        let cost = next_mint_cost(&mut contract);
        testing_env!(context(accounts(1), NearToken::from_yoctonear(cost)).build());
        contract.nft_mint("cloof".to_string(), accounts(2), aloof_metadata());
        assert_eq!(
            contract.nft_token("cloof".to_string()).unwrap().owner_id,
            accounts(2)
        );
        assert_eq!(contract.nft_total_supply().0, 3);
        assert_eq!(transferred_to(&accounts(1)), 0);
        assert_eq!(transferred_to(&accounts(2)), 0);
    }

    #[test]
    #[should_panic(expected = "Must attach")]
    fn mint_one_yocto_below_storage_cost_panics() {
        let mut contract = minted_contract();
        let cost = next_mint_cost(&mut contract);
        testing_env!(context(accounts(1), NearToken::from_yoctonear(cost - 1)).build());
        contract.nft_mint("cloof".to_string(), accounts(2), aloof_metadata());
    }

    #[test]
    fn failed_underfunded_mint_creates_no_refund_receipt() {
        let mut contract = minted_contract();
        let cost = next_mint_cost(&mut contract);
        testing_env!(context(accounts(1), NearToken::from_yoctonear(cost / 2)).build());
        assert!(panics_with(
            || {
                contract.nft_mint("cloof".to_string(), accounts(2), aloof_metadata());
            },
            "Must attach"
        ));
        // Note: on chain the panic reverts every write. The mock keeps the
        // in-memory writes, so the only invariant checked here is that no
        // refund receipt was created for a mint that did not happen.
        assert_eq!(transferred_to(&accounts(1)), 0);
        assert_eq!(transferred_to(&accounts(2)), 0);
    }

    /// Storage cost in yoctoNEAR of the first anchor on a freshly minted
    /// 5-byte token id. Probes on "bloof" so the "aloof" minted afterwards
    /// does not collide in the mock's persistent storage.
    fn first_anchor_cost() -> u128 {
        testing_env!(context(accounts(1), MINT_DEPOSIT).build());
        let mut contract = Contract::new_default_meta(accounts(1));
        contract.nft_mint("bloof".to_string(), accounts(2), aloof_metadata());
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        let before = env::storage_usage();
        contract.anchor_sheet("bloof".to_string(), HASH_A.to_string());
        env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - before) as u128
    }

    #[test]
    fn anchor_with_exact_storage_cost_succeeds_and_refunds_nothing() {
        let cost = first_anchor_cost();
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), NearToken::from_yoctonear(cost)).build());
        let anchor = contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        assert_eq!(anchor.memory_depth, 2);
        assert_eq!(transferred_to(&accounts(2)), 0);
        assert_eq!(transferred_to(&accounts(1)), 0);
    }

    #[test]
    #[should_panic(expected = "Must attach")]
    fn anchor_one_yocto_below_storage_cost_panics() {
        let cost = first_anchor_cost();
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), NearToken::from_yoctonear(cost - 1)).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
    }

    #[test]
    #[should_panic(expected = "Must attach")]
    fn second_anchor_with_one_yocto_cannot_cover_its_seen_hash_record() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        // The hash slot is already allocated, but every anchor adds a
        // seen-hash record, so 1 yocto is still not enough.
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.anchor_sheet("aloof".to_string(), HASH_B.to_string());
    }

    #[test]
    fn second_anchor_charges_only_its_seen_hash_record() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        let before = env::storage_usage();
        contract.anchor_sheet("aloof".to_string(), HASH_B.to_string());
        let used = env::storage_usage() - before;
        // Only the `"{token_id}:{hash}"` key plus collection overhead; the
        // anchor itself is overwritten in place with a same-length hash.
        assert!(used > 0 && used < 200, "second anchor used {used} bytes");
        let cost = env::storage_byte_cost().as_yoctonear() * used as u128;
        assert_eq!(
            transferred_to(&accounts(2)),
            MINT_DEPOSIT.as_yoctonear() - cost
        );
    }

    #[test]
    fn anchor_refund_goes_to_the_caller_not_the_contract_or_previous_owner() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer(accounts(3), "aloof".to_string(), None, None);
        testing_env!(context(accounts(3), MINT_DEPOSIT).build());
        let before = env::storage_usage();
        contract.anchor_sheet("aloof".to_string(), HASH_A.to_string());
        let cost =
            env::storage_byte_cost().as_yoctonear() * (env::storage_usage() - before) as u128;
        assert_eq!(
            transferred_to(&accounts(3)),
            MINT_DEPOSIT.as_yoctonear() - cost
        );
        assert_eq!(transferred_to(&accounts(1)), 0);
        assert_eq!(transferred_to(&accounts(2)), 0);
    }

    // -- views and calls on unknown token ids ------------------------------

    #[test]
    fn views_on_unknown_token_or_account_are_empty_not_panics() {
        let contract = minted_contract();
        assert_eq!(contract.nft_token("ghost".to_string()), None);
        assert_eq!(contract.sheet_anchor("ghost".to_string()), None);
        assert!(!contract.nft_in_flight("ghost".to_string()));
        assert_eq!(contract.nft_supply_for_owner(accounts(5)).0, 0);
        assert!(contract
            .nft_tokens_for_owner(accounts(5), None, None)
            .is_empty());
        // Enumeration of what does exist still works alongside.
        assert_eq!(contract.nft_total_supply().0, 1);
        assert_eq!(contract.nft_tokens(None, None).len(), 1);
        assert_eq!(contract.nft_supply_for_owner(accounts(2)).0, 1);
    }

    #[test]
    #[should_panic(expected = "Token not found")]
    fn nft_is_approved_on_unknown_token_panics() {
        let contract = minted_contract();
        contract.nft_is_approved("ghost".to_string(), accounts(3), None);
    }

    #[test]
    #[should_panic(expected = "Token not found")]
    fn transfer_of_unknown_token_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer(accounts(3), "ghost".to_string(), None, None);
    }

    #[test]
    #[should_panic(expected = "Token not found")]
    fn transfer_call_of_unknown_token_panics() {
        let mut contract = minted_contract();
        transfer_call_env(accounts(2));
        let _ = contract.nft_transfer_call(accounts(3), "ghost".to_string(), None, None, "".into());
    }

    #[test]
    #[should_panic(expected = "sheet anchor missing for token")]
    fn transfer_expecting_anchor_of_unknown_token_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_transfer_expecting_anchor(
            accounts(3),
            "ghost".to_string(),
            None,
            None,
            None,
            INITIAL_MEMORY_DEPTH,
        );
    }

    #[test]
    #[should_panic(expected = "Token not found")]
    fn approve_on_unknown_token_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        contract.nft_approve("ghost".to_string(), accounts(3), None);
    }

    #[test]
    #[should_panic(expected = "Token not found")]
    fn revoke_on_unknown_token_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_revoke("ghost".to_string(), accounts(3));
    }

    #[test]
    #[should_panic(expected = "Token not found")]
    fn revoke_all_on_unknown_token_panics() {
        let mut contract = minted_contract();
        testing_env!(context(accounts(2), ONE_YOCTO).build());
        contract.nft_revoke_all("ghost".to_string());
    }

    #[test]
    fn unknown_token_ids_never_get_a_lock_or_anchor_from_failed_calls() {
        let mut contract = minted_contract();
        transfer_call_env(accounts(2));
        assert!(panics_with(
            || {
                let _ = contract.nft_transfer_call(
                    accounts(3),
                    "ghost".to_string(),
                    None,
                    None,
                    "".into(),
                );
            },
            "Token not found"
        ));
        testing_env!(context(accounts(2), MINT_DEPOSIT).build());
        assert!(panics_with(
            || {
                contract.anchor_sheet("ghost".to_string(), HASH_A.to_string());
            },
            "token not found"
        ));
        assert!(!contract.nft_in_flight("ghost".to_string()));
        assert_eq!(contract.sheet_anchor("ghost".to_string()), None);
        assert_eq!(contract.nft_token("ghost".to_string()), None);
    }
}

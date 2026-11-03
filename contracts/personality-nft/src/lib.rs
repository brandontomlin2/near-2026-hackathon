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
    NonFungibleTokenCore, NonFungibleTokenResolver,
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
    env, near, require, AccountId, BorshStorageKey, PanicOnDefault, Promise, PromiseOrValue,
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

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    tokens: NonFungibleToken,
    metadata: LazyOption<NFTContractMetadata>,
    sheet_anchors: LookupMap<TokenId, SheetAnchor>,
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
    /// Attach at least 1 yoctoNEAR (so a full-access key must sign). The first
    /// anchor on a token grows storage; the deposit must cover that growth and
    /// the remainder is refunded. Emits a NEP-297 `sheet_anchored` event.
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
        anchor.memory_depth = anchor
            .memory_depth
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str("memory depth overflow"));
        anchor.sheet_hash = Some(sheet_hash.clone());
        anchor.updated_at = U64(env::block_timestamp());
        self.sheet_anchors.insert(token_id.clone(), anchor.clone());
        self.sheet_anchors.flush();
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

    #[payable]
    fn nft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: TokenId,
        approval_id: Option<u64>,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<bool> {
        self.tokens
            .nft_transfer_call(receiver_id, token_id, approval_id, memo, msg)
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
        self.tokens.nft_resolve_transfer(
            previous_owner_id,
            receiver_id,
            token_id,
            approved_account_ids,
        )
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
    require_max_len(&m.title, MAX_TITLE_LEN, "title");
    require_max_len(&m.description, MAX_DESCRIPTION_LEN, "description");
    require_max_len(&m.extra, MAX_EXTRA_LEN, "extra");
    require_max_len(&m.media, MAX_URI_LEN, "media");
    require_max_len(&m.reference, MAX_URI_LEN, "reference");
    require_max_len(&m.issued_at, MAX_URI_LEN, "issued_at");
    require_max_len(&m.expires_at, MAX_URI_LEN, "expires_at");
    require_max_len(&m.starts_at, MAX_URI_LEN, "starts_at");
    require_max_len(&m.updated_at, MAX_URI_LEN, "updated_at");
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
        testing_env!(context(accounts(2), ONE_YOCTO).build());
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

        testing_env!(context(accounts(3), ONE_YOCTO).build());
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
}

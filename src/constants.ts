import { PublicKey } from "@solana/web3.js";

/** Meteora Dynamic Bonding Curve program (live mainnet, IDL 0.2.1). */
export const DBC_PROGRAM_ID = new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");

/** PDA(["pool_authority"]) — hardcoded in the program as a const PDA. */
export const POOL_AUTHORITY = new PublicKey("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");

/** Post-migration venue: Meteora DAMM v2 (cp-amm). */
export const DAMM_V2_PROGRAM_ID = new PublicKey("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");

/** Meteora locker — holds the vesting escrow for locked base tokens. */
export const LOCKER_PROGRAM_ID = new PublicKey("LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn");

/**
 * bonding-guard — a Token-2022 transfer hook that keeps the launched token
 * bound to the DBC pool vault while the curve is live. Passed as
 * `transferHookProgram` on a `create_config_with_transfer_hook` launch; DBC
 * revokes it automatically on graduation.
 */
export const BONDING_GUARD_PROGRAM_ID = new PublicKey(
  "2iYpvGhiJvfpYCmxrF8iwSTPRE42yKeUzjgTGV6zBeSM",
);

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
);
export const METAPLEX_TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

export const NATIVE_MINT = new PublicKey("So11111111111111111111111111111111111111112");

/** Account/instruction seed prefixes (constants.rs `seeds`). */
export const SEEDS = {
  config: "config",
  cpool: "cpool",
  pool: "pool",
  tokenVault: "token_vault",
  poolAuthority: "pool_authority",
  position: "position",
  tokenBadge: "token_badge",
  claimFeeOperator: "cf_operator",
  meteoraMetadata: "meteora",
  dammV2Metadata: "damm_v2",
  partnerMetadata: "partner_metadata",
  virtualPoolMetadata: "virtual_pool_metadata",
  baseLocker: "base_locker",
  operator: "operator",
  eventAuthority: "__event_authority",
} as const;

/** Fee math denominator: `cliffFeeNumerator` is ppm of 1e9, not 1e6. */
export const FEE_DENOMINATOR = 1_000_000_000n;
/** Basis-point denominator — the unit `reduction_factor` uses in exponential mode. */
export const BASIS_POINT_MAX = 10_000n;
/** Hard cap on the total fee numerator (99%). */
export const MAX_FEE_NUMERATOR = 990_000_000n;
/** Floor on `cliffFeeNumerator` (0.25%). */
export const MIN_FEE_NUMERATOR = 2_500_000n;

export const MAX_CURVE_POINT = 16;
export const MAX_CURVE_POINT_CONFIG = 20;

export const MIN_SQRT_PRICE = 4295048016n;
export const MAX_SQRT_PRICE = 79226673521066979257578248091n;

/** Extra base supply required on top of the swap amount (25%). */
export const SWAP_BUFFER_PERCENTAGE = 25n;

export const MIN_POOL_CREATION_FEE = 1_000_000n;
export const MAX_POOL_CREATION_FEE = 100_000_000_000n;

/** Minimum share of liquidity that must still be locked one day after migration. */
export const MIN_LOCKED_LIQUIDITY_BPS = 1000;
export const MAX_LOCK_DURATION_IN_SECONDS = 3600n * 24n * 365n * 2n;

/** Share of the post-migration quote surplus that goes to partner + creator (80%). */
export const PARTNER_AND_CREATOR_SURPLUS_SHARE = 80n;

/** Protocol's cut of the migrated liquidity (0.2%). */
export const PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS = 20;

/** `VirtualPool::migration_progress` — the state gate for most post-curve actions. */
export enum MigrationProgress {
  PreBondingCurve = 0,
  PostBondingCurve = 1,
  LockedVesting = 2,
  CreatedPool = 3,
}

/** `MigrationOption` — MeteoraDamm (v1) is deprecated and rejected on create. */
export enum MigrationOption {
  MeteoraDamm = 0,
  DammV2 = 1,
}

/** `CollectFeeMode` — where the quote fee accrues during the curve. Two variants only. */
export enum CollectFeeMode {
  QuoteToken = 0,
  OutputToken = 1,
}

/** `MigratedCollectFeeMode` — where fees accrue after graduation to DAMM v2. */
export enum MigratedCollectFeeMode {
  QuoteToken = 0,
  OutputToken = 1,
  /** DAMM v2 only. */
  Compounding = 2,
}

/** `BaseFeeMode` (a.k.a. FeeSchedulerMode). */
export enum BaseFeeMode {
  FeeSchedulerLinear = 0,
  FeeSchedulerExponential = 1,
  RateLimiter = 2,
}

/** `ActivationType` — slots or unix timestamps. */
export enum ActivationType {
  Slot = 0,
  Timestamp = 1,
}

/** `TokenType` — plain SPL vs Token-2022. */
export enum TokenType {
  SplToken = 0,
  Token2022 = 1,
}

/**
 * `TokenAuthorityOption` — who may update token metadata after launch.
 * Mint-authority variants are rejected unless the config is a transfer-hook config.
 */
export enum TokenAuthorityOption {
  CreatorUpdateAuthority = 0,
  Immutable = 1,
  PartnerUpdateAuthority = 2,
  /** Transfer-hook configs only. */
  CreatorUpdateAndMintAuthority = 3,
  /** Transfer-hook configs only. */
  PartnerUpdateAndMintAuthority = 4,
}

/** `MigrationFeeOption` — `Customizable` (6) is the only one that lets you set your own bps. */
export enum MigrationFeeOption {
  FixedBps25 = 0,
  FixedBps30 = 1,
  FixedBps100 = 2,
  FixedBps200 = 3,
  FixedBps400 = 4,
  FixedBps600 = 5,
  Customizable = 6,
}

/** `migration_fee_withdraw_status` bits. */
export const MIGRATION_FEE_MASK = { creator: 0b010, partner: 0b100 } as const;

/**
 * `withdraw_migration_fee`'s `flag` argument — `SenderFlag` in the Rust.
 * `0 as partner and 1 as creator` (ix_withdraw_migration_fee.rs). Partner
 * withdrawals are signed by `config.fee_claimer`, creator ones by `pool.creator`.
 */
export enum WithdrawMigrationFeeFlag {
  Partner = 0,
  Creator = 1,
}

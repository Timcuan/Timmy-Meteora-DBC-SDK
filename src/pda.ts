import { PublicKey } from "@solana/web3.js";
import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID, LOCKER_PROGRAM_ID, POOL_AUTHORITY, SEEDS } from "./constants.js";

/** Lexicographic max of two pubkeys — DBC orders the pool seeds this way. */
export function maxKey(a: PublicKey, b: PublicKey): PublicKey {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) >= 0 ? a : b;
}

export function minKey(a: PublicKey, b: PublicKey): PublicKey {
  return Buffer.compare(a.toBuffer(), b.toBuffer()) < 0 ? a : b;
}

function find(seeds: (Buffer | Uint8Array)[], programId = DBC_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, programId)[0];
}

const b = (s: string) => Buffer.from(s);

export const poolAuthority = () => POOL_AUTHORITY;

/** seeds: ["pool", config, max(base,quote), min(base,quote)] */
export const virtualPool = (config: PublicKey, baseMint: PublicKey, quoteMint: PublicKey) =>
  find([
    b(SEEDS.pool),
    config.toBuffer(),
    maxKey(baseMint, quoteMint).toBuffer(),
    minKey(baseMint, quoteMint).toBuffer(),
  ]);

/** seeds: ["token_vault", mint, pool] */
export const tokenVault = (mint: PublicKey, pool: PublicKey) =>
  find([b(SEEDS.tokenVault), mint.toBuffer(), pool.toBuffer()]);

export const baseVault = (baseMint: PublicKey, pool: PublicKey) => tokenVault(baseMint, pool);
export const quoteVault = (quoteMint: PublicKey, pool: PublicKey) => tokenVault(quoteMint, pool);

/** seeds: ["token_badge", tokenMint] */
export const tokenBadge = (tokenMint: PublicKey) =>
  find([b(SEEDS.tokenBadge), tokenMint.toBuffer()]);

/** seeds: ["operator", whitelistedAddress] */
export const operator = (whitelistedAddress: PublicKey) =>
  find([b(SEEDS.operator), whitelistedAddress.toBuffer()]);

/** seeds: ["cf_operator", operator] */
export const claimFeeOperator = (operator: PublicKey) =>
  find([b(SEEDS.claimFeeOperator), operator.toBuffer()]);

/** seeds: ["partner_metadata", feeClaimer] */
export const partnerMetadata = (feeClaimer: PublicKey) =>
  find([b(SEEDS.partnerMetadata), feeClaimer.toBuffer()]);

/** seeds: ["virtual_pool_metadata", virtualPool] */
export const virtualPoolMetadata = (pool: PublicKey) =>
  find([b(SEEDS.virtualPoolMetadata), pool.toBuffer()]);

/** seeds: ["meteora", virtualPool] — DAMM v1 migration metadata. */
export const meteoraMigrationMetadata = (pool: PublicKey) =>
  find([b(SEEDS.meteoraMetadata), pool.toBuffer()]);

/** seeds: ["damm_v2", virtualPool] — DAMM v2 migration metadata. */
export const dammV2MigrationMetadata = (pool: PublicKey) =>
  find([b(SEEDS.dammV2Metadata), pool.toBuffer()]);

/** seeds: ["base_locker", virtualPool] — vesting escrow for locked base tokens. */
export const baseLocker = (pool: PublicKey) => find([b(SEEDS.baseLocker), pool.toBuffer()]);

/** Anchor `#[event_cpi]` authority. */
export const eventAuthority = () => find([b(SEEDS.eventAuthority)]);

// ── DAMM v2 (post-graduation venue) ──────────────────────────────────────────
// Both verified against a real mainnet DBC->DAMM v2 migration: they appear as
// accounts in the reference migration for the `Inference` pool.

/** seeds: ["pool_authority"] on the DAMM v2 program. */
export const dammPoolAuthority = () =>
  PublicKey.findProgramAddressSync([b(SEEDS.poolAuthority)], DAMM_V2_PROGRAM_ID)[0];

/** seeds: ["__event_authority"] on the DAMM v2 program. */
export const dammEventAuthority = () =>
  PublicKey.findProgramAddressSync([b(SEEDS.eventAuthority)], DAMM_V2_PROGRAM_ID)[0];

/** Locker program's `#[event_cpi]` authority — derived, not a DBC PDA. */
export const lockerEventAuthority = () =>
  PublicKey.findProgramAddressSync([b(SEEDS.eventAuthority)], LOCKER_PROGRAM_ID)[0];

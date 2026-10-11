import {PublicKey, SystemProgram, TransactionInstruction} from "@solana/web3.js";
import {TOKEN_2022_PROGRAM_ID, DAMM_V2_PROGRAM_ID, LOCKER_PROGRAM_ID} from "../constants.js";
import {buildInstruction} from "./shared.js";
import * as pda from "../pda.js";

/**
 * Graduates a completed curve into a DAMM v2 pool.
 *
 * DBC-side accounts and both DAMM v2 PDAs are derived; the DAMM v2 pool, its
 * two position NFTs and its vaults are the cp-amm program's layout, so they are
 * supplied by the caller (create them with the cp-amm program first).
 */
export async function migrationDammV2(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  payer: PublicKey;
  /** cp-amm pool account, and its two position NFTs (mints must sign). */
  dammPool: PublicKey;
  firstPositionNftMint: PublicKey;
  firstPositionNftAccount: PublicKey;
  firstPosition: PublicKey;
  secondPositionNftMint?: PublicKey;
  secondPositionNftAccount?: PublicKey;
  secondPosition?: PublicKey;
  tokenAVault: PublicKey;
  tokenBVault: PublicKey;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
  /**
   * Appended after the IDL's accounts. A real mainnet graduation passes the
   * DAMM v2 position accounts here (three of them for a two-position pool).
   */
  remainingAccounts?: { pubkey: PublicKey; isWritable?: boolean; isSigner?: boolean }[];
}): Promise<TransactionInstruction> {
  return buildInstruction(
    a.program,
    "migrationDammV2",
    [],
    {
      virtualPool: a.pool,
      migrationMetadata: pda.dammV2MigrationMetadata(a.pool),
      config: a.config,
      pool: a.dammPool,
      firstPositionNftMint: a.firstPositionNftMint,
      firstPositionNftAccount: a.firstPositionNftAccount,
      firstPosition: a.firstPosition,
      ...(a.secondPositionNftMint
        ? {
            secondPositionNftMint: a.secondPositionNftMint,
            secondPositionNftAccount: a.secondPositionNftAccount!,
            secondPosition: a.secondPosition!,
          }
        : {}),
      dammPoolAuthority: pda.dammPoolAuthority(),
      ammProgram: DAMM_V2_PROGRAM_ID,
      baseMint: a.baseMint,
      quoteMint: a.quoteMint,
      tokenAVault: a.tokenAVault,
      tokenBVault: a.tokenBVault,
      baseVault: pda.baseVault(a.baseMint, a.pool),
      quoteVault: pda.quoteVault(a.quoteMint, a.pool),
      payer: a.payer,
      tokenBaseProgram: a.tokenBaseProgram,
      tokenQuoteProgram: a.tokenQuoteProgram,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      dammEventAuthority: pda.dammEventAuthority(),
      systemProgram: SystemProgram.programId,
    },
    a.remainingAccounts ?? [],
  );
}

/** Creates the DAMM v2 migration metadata account for a pool. Run before `migrationDammV2`. */
export async function migrationDammV2CreateMetadata(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  payer: PublicKey;
}): Promise<TransactionInstruction> {
  return buildInstruction(a.program, "migrationDammV2CreateMetadata", [], {
    virtualPool: a.pool,
    config: a.config,
    migrationMetadata: pda.dammV2MigrationMetadata(a.pool),
    payer: a.payer,
    systemProgram: SystemProgram.programId,
  });
}

/**
 * Locks the configured vesting reserve into a Meteora locker escrow.
 *
 * Only meaningful when the config carries `locked_vesting`; the base tokens come
 * out of the pool's base vault, not from the creator. The escrow pair is
 * created with the locker program (`LOCKER_PROGRAM_ID`) first — DBC CPIs into it.
 */
export async function createLocker(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  creator: PublicKey;
  escrow: PublicKey;
  escrowToken: PublicKey;
  payer: PublicKey;
  tokenProgram: PublicKey;
}): Promise<TransactionInstruction> {
  return buildInstruction(a.program, "createLocker", [], {
    virtualPool: a.pool,
    config: a.config,
    baseVault: pda.baseVault(a.baseMint, a.pool),
    baseMint: a.baseMint,
    base: pda.baseLocker(a.pool),
    creator: a.creator,
    escrow: a.escrow,
    escrowToken: a.escrowToken,
    payer: a.payer,
    tokenProgram: a.tokenProgram,
    lockerProgram: LOCKER_PROGRAM_ID,
    lockerEventAuthority: pda.lockerEventAuthority(),
    systemProgram: SystemProgram.programId,
  });
}

// ── fees ─────────────────────────────────────────────────────────────────────

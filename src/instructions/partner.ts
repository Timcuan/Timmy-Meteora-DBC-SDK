import {BN} from "@coral-xyz/anchor";
import {PublicKey, SystemProgram, TransactionInstruction} from "@solana/web3.js";
import {buildInstruction, ata, u64le, HOOK_ACCOUNTS_INFO} from "./shared.js";
import * as pda from "../pda.js";
//
// `event_authority` and `program` are omitted on every wrapper: they are
// `#[event_cpi]` accounts the Anchor client resolves itself (proven by the
// launch path). `pool_authority` is a hardcoded const address in the IDL and
// is passed explicitly to be safe.

/** Registers a partner (white-label launchpad) under a fee-claimer wallet. */
export async function createPartnerMetadata(a: {
  program: any;
  /** Signs: proves ownership of the fee wallet. Must match the config's fee_claimer. */
  feeClaimer: PublicKey;
  payer: PublicKey;
  name: string;
  website: string;
  logo: string;
}): Promise<TransactionInstruction> {
  return buildInstruction(
    a.program,
    "createPartnerMetadata",
    [{ padding: new Uint8Array(96), name: a.name, website: a.website, logo: a.logo }],
    {
      partnerMetadata: pda.partnerMetadata(a.feeClaimer),
      payer: a.payer,
      feeClaimer: a.feeClaimer,
      systemProgram: SystemProgram.programId,
    },
  );
}

/** Partner claims its share of the surplus quote (80% pool, split partner/creator). */
export async function partnerWithdrawSurplus(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  quoteMint: PublicKey;
  feeClaimer: PublicKey;
  tokenQuoteProgram: PublicKey;
}): Promise<TransactionInstruction> {
  return buildInstruction(a.program, "partnerWithdrawSurplus", [], {
    poolAuthority: pda.poolAuthority(),
    config: a.config,
    virtualPool: a.pool,
    tokenQuoteAccount: ata(a.quoteMint, a.feeClaimer, a.tokenQuoteProgram),
    quoteVault: pda.quoteVault(a.quoteMint, a.pool),
    quoteMint: a.quoteMint,
    feeClaimer: a.feeClaimer,
    tokenQuoteProgram: a.tokenQuoteProgram,
  });
}

/** Creator claims its share of the surplus quote. */
export async function creatorWithdrawSurplus(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  quoteMint: PublicKey;
  creator: PublicKey;
  tokenQuoteProgram: PublicKey;
}): Promise<TransactionInstruction> {
  return buildInstruction(a.program, "creatorWithdrawSurplus", [], {
    poolAuthority: pda.poolAuthority(),
    config: a.config,
    virtualPool: a.pool,
    tokenQuoteAccount: ata(a.quoteMint, a.creator, a.tokenQuoteProgram),
    quoteVault: pda.quoteVault(a.quoteMint, a.pool),
    quoteMint: a.quoteMint,
    creator: a.creator,
    tokenQuoteProgram: a.tokenQuoteProgram,
  });
}

/** Partner claims the 90% share of the pool creation fee (lamports). */
export async function claimPartnerPoolCreationFee(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  feeClaimer: PublicKey;
  /** Lamports destination — usually the fee-claimer wallet itself. */
  feeReceiver: PublicKey;
}): Promise<TransactionInstruction> {
  return buildInstruction(a.program, "claimPartnerPoolCreationFee", [], {
    config: a.config,
    pool: a.pool,
    feeClaimer: a.feeClaimer,
    feeReceiver: a.feeReceiver,
  });
}

/** Rotates the pool creator. Signer = current creator. Free at PreBondingCurve. */
export async function transferPoolCreator(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  creator: PublicKey;
  newCreator: PublicKey;
}): Promise<TransactionInstruction> {
  return buildInstruction(a.program, "transferPoolCreator", [], {
    virtualPool: a.pool,
    config: a.config,
    creator: a.creator,
    newCreator: a.newCreator,
  });
}

/**
 * Creator claims its trading-fee share (base + quote) into its ATAs.
 * `pool.config` is not required here — the creator fee is pool-scoped.
 */
export async function claimCreatorTradingFee2(a: {
  program: any;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  creator: PublicKey;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
  maxBaseAmount?: bigint;
  maxQuoteAmount?: bigint;
  /** Transfer-hook pool only — the hook program id (passed as the CPI extra account). */
  transferHookProgram?: PublicKey;
}): Promise<TransactionInstruction> {
  const maxB = a.maxBaseAmount ?? 18446744073709551615n;
  const maxQ = a.maxQuoteAmount ?? 18446744073709551615n;
  const ix = await buildInstruction(
    a.program,
    "claimCreatorTradingFee2",
    [new BN(maxB.toString()), new BN(maxQ.toString()), { slices: [] }],
    {
      poolAuthority: pda.poolAuthority(),
      pool: a.pool,
      tokenAAccount: ata(a.baseMint, a.creator, a.tokenBaseProgram),
      tokenBAccount: ata(a.quoteMint, a.creator, a.tokenQuoteProgram),
      baseVault: pda.baseVault(a.baseMint, a.pool),
      quoteVault: pda.quoteVault(a.quoteMint, a.pool),
      baseMint: a.baseMint,
      quoteMint: a.quoteMint,
      creator: a.creator,
      tokenBaseProgram: a.tokenBaseProgram,
      tokenQuoteProgram: a.tokenQuoteProgram,
    },
    a.transferHookProgram
      ? [{ pubkey: a.transferHookProgram, isWritable: false, isSigner: false }]
      : [],
  );
  if (a.transferHookProgram) {
    ix.data = Buffer.concat([
      ix.data.subarray(0, 8), // the builder's own sighash
      u64le(maxB),
      u64le(maxQ),
      HOOK_ACCOUNTS_INFO,
    ]);
  }
  return ix;
}



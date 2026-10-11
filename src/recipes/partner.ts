import { PublicKey } from "@solana/web3.js";
import {
  claimCreatorTradingFee2,
  claimPartnerPoolCreationFee,
  claimTradingFee2,
  createPartnerMetadata,
  creatorWithdrawSurplus,
  partnerWithdrawSurplus,
  transferPoolCreator,
  withdrawMigrationFee,
} from "../ix.js";
import { WithdrawMigrationFeeFlag } from "../constants.js";

/**
 * Partner / creator extraction flows — the white-label launchpad surface.
 *
 * A DBC "partner" is whoever owns the config's `fee_claimer`. Register once,
 * launch every token through `create_config(fee_claimer = you)`, and the fee
 * stack routes to you: 80% trading fee, 90% pool-creation fee, surplus share,
 * migration fee, and the permanent locked-LP fee stream. The creator role adds
 * its own cut on top.
 *
 * Every helper is async because `buildInstruction` is; await each before
 * dropping the instruction into a Transaction.
 */

/** One-time registration under the fee wallet. Returns the tx instruction. */
export async function registerPartner(a: {
  program: any;
  feeClaimer: PublicKey;
  payer: PublicKey;
  name: string;
  website: string;
  logo: string;
}) {
  return createPartnerMetadata(a);
}

/** Partner-side revenue, one instruction per stream. */
export async function partnerRevenue(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  feeClaimer: PublicKey;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
}) {
  return {
    /** 80% of the bonding-phase trading fee (in both tokens, into fee ATAs). */
    tradingFee: await claimTradingFee2(a),
    /** Partner share of the surplus quote. */
    surplus: await partnerWithdrawSurplus(a),
    /** 90% of the pool creation fee (lamports into feeClaimer). */
    poolCreationFee: await claimPartnerPoolCreationFee({
      program: a.program,
      config: a.config,
      pool: a.pool,
      feeClaimer: a.feeClaimer,
      feeReceiver: a.feeClaimer,
    }),
  };
}

/** Creator-side revenue, one instruction per stream. */
export async function creatorRevenue(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  creator: PublicKey;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
}) {
  return {
    /** The creator's cut of the trading fee. */
    tradingFee: await claimCreatorTradingFee2({
      program: a.program,
      pool: a.pool,
      baseMint: a.baseMint,
      quoteMint: a.quoteMint,
      creator: a.creator,
      tokenBaseProgram: a.tokenBaseProgram,
      tokenQuoteProgram: a.tokenQuoteProgram,
    }),
    /** The creator's share of the surplus quote. */
    surplus: await creatorWithdrawSurplus({
      program: a.program,
      config: a.config,
      pool: a.pool,
      quoteMint: a.quoteMint,
      creator: a.creator,
      tokenQuoteProgram: a.tokenQuoteProgram,
    }),
    /** The creator's share of the migration fee. */
    migrationFee: await withdrawMigrationFee({
      program: a.program,
      config: a.config,
      pool: a.pool,
      quoteMint: a.quoteMint,
      sender: a.creator,
      tokenQuoteProgram: a.tokenQuoteProgram,
      flag: WithdrawMigrationFeeFlag.Creator,
    }),
  };
}

/** Rotate the pool creator to an exit wallet (burn-and-rotate). */
export async function transferCreator(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  creator: PublicKey;
  newCreator: PublicKey;
}) {
  return transferPoolCreator(a);
}
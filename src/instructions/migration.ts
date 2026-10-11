import {PublicKey, TransactionInstruction} from "@solana/web3.js";
import {WithdrawMigrationFeeFlag} from "../constants.js";
import {buildInstruction, resolveTokenProgram, ata} from "./shared.js";
import * as pda from "../pda.js";

/**
 * Pulls the leftover base supply out of the vault into `leftover_receiver`'s ATA.
 *
 * Only valid while `migration_progress == CreatedPool`, on a fixed-supply config,
 * once per pool. This is the instruction that turns a reserve supply allocation
 * into a spendable balance.
 */
export async function withdrawLeftover(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  leftoverReceiver: PublicKey;
  tokenBaseProgram: PublicKey;
}): Promise<TransactionInstruction> {
  return buildInstruction(a.program, "withdrawLeftover", [], {
    config: a.config,
    virtualPool: a.pool,
    tokenBaseAccount: ata(a.baseMint, a.leftoverReceiver, a.tokenBaseProgram),
    baseVault: pda.baseVault(a.baseMint, a.pool),
    baseMint: a.baseMint,
    leftoverReceiver: a.leftoverReceiver,
    tokenBaseProgram: a.tokenBaseProgram,
  });
}

export async function withdrawMigrationFee(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  quoteMint: PublicKey;
  sender: PublicKey;
  flag: WithdrawMigrationFeeFlag;
  tokenQuoteProgram?: PublicKey;
  tokenQuoteAccount?: PublicKey;
}): Promise<TransactionInstruction> {
  const tokenQuoteProgram = await resolveTokenProgram(a.program, a.quoteMint, a.tokenQuoteProgram);
  return buildInstruction(a.program, "withdrawMigrationFee", [a.flag], {
    config: a.config,
    virtualPool: a.pool,
    tokenQuoteAccount: a.tokenQuoteAccount ?? ata(a.quoteMint, a.sender, tokenQuoteProgram),
    quoteVault: pda.quoteVault(a.quoteMint, a.pool),
    quoteMint: a.quoteMint,
    sender: a.sender,
    tokenQuoteProgram,
  });
}

// ── graduation ───────────────────────────────────────────────────────────────

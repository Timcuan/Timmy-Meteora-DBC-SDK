import {PublicKey, SystemProgram} from "@solana/web3.js";
import {TOKEN_2022_PROGRAM_ID} from "../constants.js";
import {buildInstruction, resolveTokenProgram} from "./shared.js";
import * as pda from "../pda.js";

export interface CreatePoolArgs {
  program: any;
  payer: PublicKey;
  creator: PublicKey;
  config: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  params: { name: string; symbol: string; uri: string };
  /** Base mint's token program. Defaults to Token-2022. */
  tokenProgram?: PublicKey;
  /** Quote mint's token program. Derived from the mint when omitted. */
  tokenQuoteProgram?: PublicKey;
  transferHookProgram?: PublicKey;
}

export async function initializeVirtualPool(a: CreatePoolArgs) {
  const tokenProgram = a.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const tokenQuoteProgram = await resolveTokenProgram(a.program, a.quoteMint, a.tokenQuoteProgram);
  const pool = pda.virtualPool(a.config, a.baseMint, a.quoteMint);
  const baseVault = pda.baseVault(a.baseMint, pool);
  const quoteVault = pda.quoteVault(a.quoteMint, pool);
  const name = a.transferHookProgram
    ? "initializeVirtualPoolWithToken2022TransferHook"
    : tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
      ? "initializeVirtualPoolWithToken2022"
      : "initializeVirtualPoolWithSplToken";
  const ix = await buildInstruction(a.program, name, [a.params], {
    config: a.config,
    creator: a.creator,
    baseMint: a.baseMint,
    quoteMint: a.quoteMint,
    pool,
    baseVault,
    quoteVault,
    payer: a.payer,
    tokenQuoteProgram,
    ...(a.transferHookProgram
      ? { tokenProgram, transferHookProgram: a.transferHookProgram }
      : { tokenProgram }),
    systemProgram: SystemProgram.programId,
  });
  return { instruction: ix, pool, baseVault, quoteVault, tokenQuoteProgram };
}

// ── swap ─────────────────────────────────────────────────────────────────────

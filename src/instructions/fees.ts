import {BN} from "@coral-xyz/anchor";
import {PublicKey, TransactionInstruction} from "@solana/web3.js";
import {buildInstruction, ata, u64le, HOOK_ACCOUNTS_INFO} from "./shared.js";
import * as pda from "../pda.js";

/** Claims both sides of a pool's accrued fees into the fee claimer's ATAs. */
export async function claimTradingFee2(a: {
  program: any;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  feeClaimer: PublicKey;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
  maxAmountA?: bigint;
  maxAmountB?: bigint;
  /** Transfer-hook pool only — the hook program id (passed as the CPI extra account). */
  transferHookProgram?: PublicKey;
}): Promise<TransactionInstruction> {
  const maxA = a.maxAmountA ?? 18446744073709551615n;
  const maxB = a.maxAmountB ?? 18446744073709551615n;
  const ix = await buildInstruction(
    a.program,
    "claimTradingFee2",
    // transfer_hook_accounts_info is `{ slices: Vec<...> }` — an empty vec is the
    // "no hook accounts" encoding; undefined/null break borsh (0x66). For a hook
    // pool the data is hand-rolled below (anchor coder drops the enum slice).
    [new BN(maxA.toString()), new BN(maxB.toString()), { slices: [] }],
    {
      config: a.config,
      pool: a.pool,
      tokenAAccount: ata(a.baseMint, a.feeClaimer, a.tokenBaseProgram),
      tokenBAccount: ata(a.quoteMint, a.feeClaimer, a.tokenQuoteProgram),
      baseVault: pda.baseVault(a.baseMint, a.pool),
      quoteVault: pda.quoteVault(a.quoteMint, a.pool),
      baseMint: a.baseMint,
      quoteMint: a.quoteMint,
      feeClaimer: a.feeClaimer,
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
      u64le(maxA),
      u64le(maxB),
      HOOK_ACCOUNTS_INFO,
    ]);
  }
  return ix;
}

// ── operator (absent from the official SDK's write path) ─────────────────────

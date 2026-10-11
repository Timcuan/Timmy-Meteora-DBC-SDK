import {BN} from "@coral-xyz/anchor";
import {PublicKey, TransactionInstruction} from "@solana/web3.js";
import {buildInstruction, u64le, HOOK_ACCOUNTS_INFO} from "./shared.js";
import * as pda from "../pda.js";

export interface Swap2Args {
  program: any;
  payer: PublicKey;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  /** Buyer side. */
  inputTokenAccount: PublicKey;
  outputTokenAccount: PublicKey;
  amount0: bigint;
  amount1: bigint;
  swapMode: number;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
  referralTokenAccount?: PublicKey;
  transferHook?: boolean;
  /** Hook program id — required when `transferHook` is set, passed as the CPI extra account. */
  transferHookProgram?: PublicKey;
  /**
   * Extra accounts appended after the IDL's. For the first-swap-at-min-fee the
   * program reads the instruction sysvar from `remaining_accounts[0]` to scan
   * the tx for `initialize_pool` — pass `SYSVAR_INSTRUCTIONS_PUBKEY` here.
   */
  remainingAccounts?: { pubkey: PublicKey; isWritable?: boolean; isSigner?: boolean }[];
}

export async function swap2(a: Swap2Args): Promise<TransactionInstruction> {
  const name = a.transferHook ? "swap2WithTransferHook" : "swap2";
  const params = [{ amount0: new BN(a.amount0.toString()), amount1: new BN(a.amount1.toString()), swapMode: a.swapMode }];
  // swap2_with_transfer_hook takes (params, transfer_hook_accounts_info). The hook CPI
  // requires the hook program id as an extra account (TransferHookBase, length 1);
  // add_extra_accounts_for_execute_cpi resolves it by key against `hook_program_id`.
  if (a.transferHook && !a.transferHookProgram) {
    throw new Error("swap2: transferHookProgram is required when transferHook is set");
  }
  const args = a.transferHook
    ? [...params, { slices: [{ accounts_type: { TransferHookBase: {} }, length: 1 }] }]
    : params;
  const remaining = a.transferHook
    ? [{ pubkey: a.transferHookProgram!, isWritable: false, isSigner: false }, ...(a.remainingAccounts ?? [])]
    : (a.remainingAccounts ?? []);
  const ix = await buildInstruction(
    a.program,
    name,
    args,
    {
      config: a.config,
      pool: a.pool,
      inputTokenAccount: a.inputTokenAccount,
      outputTokenAccount: a.outputTokenAccount,
      baseVault: pda.baseVault(a.baseMint, a.pool),
      quoteVault: pda.quoteVault(a.quoteMint, a.pool),
      baseMint: a.baseMint,
      quoteMint: a.quoteMint,
      payer: a.payer,
      tokenBaseProgram: a.tokenBaseProgram,
      tokenQuoteProgram: a.tokenQuoteProgram,
      ...(a.referralTokenAccount
        ? { referralTokenAccount: a.referralTokenAccount }
        : { referralTokenAccount: null }),
    },
    remaining,
  );
  if (a.transferHook) {
    // hand-roll `swap2_with_transfer_hook`'s data — the anchor coder drops the
    // enum-bearing slice element in the 2nd arg; reuse the builder's account keys.
    ix.data = Buffer.concat([
      ix.data.subarray(0, 8), // the builder's own sighash (correct; only the args below are hand-rolled)
      u64le(a.amount0),
      u64le(a.amount1),
      Buffer.from([a.swapMode]),
      HOOK_ACCOUNTS_INFO,
    ]);
  }
  return ix;
}

// ── migration ────────────────────────────────────────────────────────────────

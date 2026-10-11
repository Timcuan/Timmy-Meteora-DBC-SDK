import {BN} from "@coral-xyz/anchor";
import {PublicKey, SystemProgram, TransactionInstruction} from "@solana/web3.js";
import {buildInstruction} from "./shared.js";
import * as pda from "../pda.js";

export async function createOperatorAccount(a: {
  program: any;
  whitelistedAddress: PublicKey;
  signer: PublicKey;
  payer: PublicKey;
  permission: bigint;
}): Promise<TransactionInstruction> {
  return buildInstruction(a.program, "createOperatorAccount", [new BN(a.permission.toString())], {
    operator: pda.operator(a.whitelistedAddress),
    whitelistedAddress: a.whitelistedAddress,
    signer: a.signer,
    payer: a.payer,
    systemProgram: SystemProgram.programId,
  });
}

export async function createTokenBadge(a: {
  program: any;
  tokenMint: PublicKey;
  operator: PublicKey;
  signer: PublicKey;
  payer: PublicKey;
}): Promise<TransactionInstruction> {
  return buildInstruction(a.program, "createTokenBadge", [], {
    tokenBadge: pda.tokenBadge(a.tokenMint),
    tokenMint: a.tokenMint,
    operator: a.operator,
    signer: a.signer,
    payer: a.payer,
    systemProgram: SystemProgram.programId,
  });
}

// ── partner / creator extraction surface ─────────────────────────────────────

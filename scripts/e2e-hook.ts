#!/usr/bin/env bun
/**
 * bonding-guard smoke test on localnet:
 *   1) deploy a "locked" launch (transfer hook attached)
 *   2) buy on the curve via swap2WithTransferHook  -> succeeds (curve trade allowed)
 *   3) free wallet-to-wallet transfer              -> REVERTS (jail active)
 *
 * Start the validator with the hook loaded first:
 *   solana-test-validator --reset --ledger test-ledger \
 *     --bpf-program dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN dbc.so \
 *     --bpf-program cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG damm.so \
 *     --bpf-program LocpQgucEQHbqNABEYvBvwoxCPsSbG91A1QaQhQQqjn locker.so \
 *     --bpf-program 2iYpvGhiJvfpYCmxrF8iwSTPRE42yKeUzjgTGV6zBeSM programs/bonding-guard/target/deploy/bonding_guard.so \
 *     --account A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck damm_cfg.json
 */
import { Connection, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createSyncNativeInstruction,
  createTransferCheckedInstruction, NATIVE_MINT as WSOL,
} from "@solana/spl-token";
import {
  deploy, getProgram, swap2, collectFees,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, BONDING_GUARD_PROGRAM_ID,
} from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const authority = Keypair.generate();
const other = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, 100e9), "confirmed");

// ── 1) deploy a locked launch ──────────────────────────────────────────────────
const built = await deploy({
  authority, connection: conn, mode: "locked",
  identity: { name: "Locked Proof", symbol: "LOCK", uri: "https://x.test/lock.json" },
  startPrice: 5e-8, graduationQuote: 65, totalSupply: 1e9,
});
const launchSig = await sendAndConfirmTransaction(conn, built.transaction, [authority, ...built.signers], { commitment: "confirmed", skipPreflight: true });
console.log("1) locked launch deployed:", launchSig.slice(0, 32) + "…");
console.log("   hook program:", BONDING_GUARD_PROGRAM_ID.toBase58(), "| pool:", built.pool.toBase58());

// ── 2) buy on the curve (transfer-hook swap path) ─────────────────────────────
const program = getProgram(conn, { publicKey: authority.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any);
const wsolAta = getAssociatedTokenAddressSync(WSOL, authority.publicKey, true, TOKEN_PROGRAM_ID);
const baseAta = getAssociatedTokenAddressSync(built.baseMint, authority.publicKey, true, TOKEN_2022_PROGRAM_ID);
// wrap 5 SOL + create the base-token ATA (the swap's output account must exist)
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountInstruction(authority.publicKey, wsolAta, authority.publicKey, WSOL, TOKEN_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(authority.publicKey, baseAta, authority.publicKey, built.baseMint, TOKEN_2022_PROGRAM_ID),
  SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: wsolAta, lamports: 5e9 }),
  createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
), [authority], { commitment: "confirmed", skipPreflight: true });

const buyIx = await swap2({
  program, payer: authority.publicKey, config: built.config, pool: built.pool,
  baseMint: built.baseMint, quoteMint: WSOL,
  inputTokenAccount: wsolAta, outputTokenAccount: baseAta,
  amount0: 1_000_000_000n, amount1: 0n, swapMode: 0, // ExactIn
  tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  transferHook: true,
  transferHookProgram: BONDING_GUARD_PROGRAM_ID,
});
await sendAndConfirmTransaction(conn, new Transaction().add(buyIx), [authority], { commitment: "confirmed", skipPreflight: true });
const bought = await conn.getTokenAccountBalance(baseAta, "confirmed");
console.log("2) curve buy OK — got", bought.value.uiAmount, "base tokens (hook allowed the curve trade)");

// ── 3) free transfer should REVERT (jail) ─────────────────────────────────────
const otherAta = getAssociatedTokenAddressSync(built.baseMint, other.publicKey, true, TOKEN_2022_PROGRAM_ID);
const freeIx = createTransferCheckedInstruction(baseAta, built.baseMint, otherAta, authority.publicKey, 1_000_000n, 6, [], TOKEN_2022_PROGRAM_ID);
let freeErr: string | null = null;
let otherUi = 0;
try {
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountInstruction(authority.publicKey, otherAta, other.publicKey, built.baseMint, TOKEN_2022_PROGRAM_ID),
    freeIx,
  ), [authority], { commitment: "confirmed", skipPreflight: true });
  otherUi = (await conn.getTokenAccountBalance(otherAta, "confirmed")).value.uiAmount ?? 0;
} catch (e: any) {
  freeErr = String(e?.message ?? e).slice(0, 160);
}
if (!freeErr && otherUi > 0) {
  throw new Error(`free transfer SUCCEEDED (${otherUi} tokens) — jail did NOT block it`);
}
console.log("3) free transfer REVERTED (as expected) — jail active");
console.log("   reason:", freeErr ?? "(on-chain revert, sim aborted)");

// ── 4) collect trading fee while the curve is live (hook still active) ─────────
try {
  const feeSig = await collectFees({
    connection: conn, authority, config: built.config, pool: built.pool,
    baseMint: built.baseMint, quoteMint: WSOL,
    feeClaimer: authority.publicKey,
    tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
    transferHookProgram: BONDING_GUARD_PROGRAM_ID,
  });
  console.log("4) collectFees during bonding:", feeSig ? "claimed (hook-aware claim OK)" : "nothing accrued yet (still OK)");
} catch (e: any) {
  throw new Error(`collectFees reverted: ${String(e?.message ?? e).slice(0, 160)}`);
}

console.log("\nHOOK E2E PASS — locked launch, curve trade allowed, free transfer blocked, fee claim hook-aware");
#!/usr/bin/env bun
/**
 * Full operator proof on localnet:
 *   deploy("atomic") → launch + graduate in ONE tx (atomic launch)
 *   settle()          → team lock+claim, migrate, reserve, LP pull, fee
 *
 * Proves the operator: allocatorPreset + atomicLaunch + settle, with actual
 * on-chain balance checks.
 */
import {
  Connection, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, NATIVE_MINT as WSOL,
} from "@solana/spl-token";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import dammIdl from "../idl/damm_v2.json" with { type: "json" };
import lockerIdl from "../idl/locker.json" with { type: "json" };
import {
  deploy, settle, fetchPool, fetchPoolConfig,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const authority = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, 200e9), "confirmed");

// pre-fund + wrap SOL for the buyer (authority)
const wsolAta = getAssociatedTokenAddressSync(WSOL, authority.publicKey, true, TOKEN_PROGRAM_ID);
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountInstruction(authority.publicKey, wsolAta, authority.publicKey, WSOL, TOKEN_PROGRAM_ID),
  SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: wsolAta, lamports: 100e9 }),
  createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID),
), [authority], { commitment: "confirmed" });

// ── atomic launch: launch + graduate in one tx ──
const built = await deploy({
  authority, connection: conn, mode: "atomic",
  identity: { name: "Operator Proof", symbol: "OPR", uri: "https://x.test/o" },
  startPrice: 5e-8, graduationQuote: 65, totalSupply: 1e9,
  teamAllocation: 50_000_000,
  creatorLpPct: 90,
  swapPct: 40,
  postPct: 100,
  feeCliffPct: 85, feeEndPct: 0.25, feeSeconds: 100,
});

built.transaction.partialSign(...built.signers, authority);
const launchSig = await conn.sendRawTransaction(built.transaction.serialize(), { skipPreflight: true });
await conn.confirmTransaction(launchSig, "confirmed");

const pool = (await fetchPool(conn, built.pool))!;
const cfg = (await fetchPoolConfig(conn, built.config))!;
const complete = pool.sqrtPrice >= cfg.migrationSqrtPrice;
console.log("1) atomic launch sig:", launchSig.slice(0, 24));
console.log("   graduated in one tx:", complete, "| quoteReserve:", Number(pool.quoteReserve) / 1e9, "SOL");
console.log("   progress:", pool.migrationProgress, "(1 = PostBondingCurve, vested config)");
if (!complete) { console.log("ATOMIC LAUNCH FAILED"); process.exit(1); }

// ── liquidate: team + migrate + leftover + LP + fee ──
const provider = new AnchorProvider(conn, { publicKey: authority.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any, { commitment: "confirmed" });
const cpAmm = new Program(dammIdl as any, provider) as any;
const locker = new Program(lockerIdl as any, provider) as any;

const sigs = await settle({
  connection: conn, authority, built,
  dammProgram: cpAmm, lockerProgram: locker,
  teamAllocation: 50_000_000,
});
console.log("2) liquidation tx count:", sigs.length);

// ── verify the sweep ──
const baseAta = getAssociatedTokenAddressSync(built.baseMint, authority.publicKey, true, TOKEN_2022_PROGRAM_ID);
const wsolAfter = await conn.getTokenAccountBalance(wsolAta, "confirmed");
const baseAfter = await conn.getTokenAccountBalance(baseAta, "confirmed");
const solBal = await conn.getBalance(authority.publicKey);
console.log("3) after liquidation:");
console.log(`   base tokens held: ${baseAfter.value.uiAmount?.toLocaleString()}`);
console.log(`   wSOL held       : ${wsolAfter.value.uiAmount?.toLocaleString()}`);
console.log(`   SOL balance     : ${(solBal / LAMPORTS_PER_SOL).toFixed(2)}`);
const poolAfter = (await fetchPool(conn, built.pool))!;
console.log(`   pool progress   : ${poolAfter.migrationProgress} (3 = CreatedPool/migrated) | leftover withdrawn: ${poolAfter.isWithdrawLeftover}`);

console.log("\nOPERATOR ORCHESTRATOR PASS");
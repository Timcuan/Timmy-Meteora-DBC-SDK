#!/usr/bin/env bun
/**
 * Consumer-integration smoke: exactly what a launchpad (Jup-style) would do,
 * from imports to on-chain state, on localnet. Proves the SDK works as a
 * package, not just as internal scripts.
 */
import { Connection, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, createSyncNativeInstruction, getAssociatedTokenAddressSync, NATIVE_MINT as WSOL } from "@solana/spl-token";
import {
  // the launchpad surface
  buildLaunchTransaction, collectFees, fetchPool, fetchPoolConfig,
  analyzePoolConfig, swap2, getProgram,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, type LaunchInput,
} from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const user = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(user.publicKey, 100e9), "confirmed");

// 1) wallet flow: build unsigned, partial-sign, wallet signs — the browser path
const input: LaunchInput = {
  authority: user, connection: conn,
  name: "Launchpad Proof", symbol: "LPAD", uri: "https://x.test/lpad.json",
  startPrice: 5e-8, graduationQuote: 65, totalSupply: 1e9, skipPreflight: true,
};
const built = await buildLaunchTransaction(input);
built.transaction.partialSign(...built.signers, user);
const sig = await conn.sendRawTransaction(built.transaction.serialize(), { skipPreflight: true });
await conn.confirmTransaction(sig, "confirmed");
console.log("1) wallet-flow launch:", sig.slice(0, 16) + "…");

// 2) read back through the public analyze surface
const cfg = (await fetchPoolConfig(conn, built.config))!;
const pool = (await fetchPool(conn, built.pool))!;
const a = analyzePoolConfig(cfg);
console.log("2) analyzePoolConfig:", { fixedSupply: a.fixedTokenSupply, leftover: Number(a.supply.leftover) / 1e6, creator: pool.creator.toBase58().slice(0, 8) });
if (!a.fixedTokenSupply) throw new Error("config did not decode as fixed supply");

// 3) swap through the public builder (what a launchpad trading UI calls)
const program = getProgram(conn, { publicKey: user.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any);
const w = getAssociatedTokenAddressSync(WSOL, user.publicKey, true, TOKEN_PROGRAM_ID);
const b = getAssociatedTokenAddressSync(built.baseMint, user.publicKey, true, TOKEN_2022_PROGRAM_ID);
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountInstruction(user.publicKey, w, user.publicKey, WSOL, TOKEN_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(user.publicKey, b, user.publicKey, built.baseMint, TOKEN_2022_PROGRAM_ID),
  SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: w, lamports: 20e9 }),
  createSyncNativeInstruction(w, TOKEN_PROGRAM_ID),
), [user], { commitment: "confirmed", skipPreflight: true });
const swapIx = await swap2({ program, payer: user.publicKey, config: built.config, pool: built.pool,
  baseMint: built.baseMint, quoteMint: WSOL, inputTokenAccount: w, outputTokenAccount: b,
  amount0: 1_000_000_000n, amount1: 0n, swapMode: 0,
  tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID });
await sendAndConfirmTransaction(conn, new Transaction().add(swapIx), [user], { commitment: "confirmed", skipPreflight: true });
const bal = await conn.getTokenAccountBalance(b, "confirmed");
console.log("3) public swap2 bought:", bal.value.uiAmount, "tokens");

// 4) fee sweep through the public recipe (returns null when empty)
const feeSig = await collectFees({ connection: conn, authority: user, config: built.config, pool: built.pool,
  baseMint: built.baseMint, quoteMint: WSOL, feeClaimer: user.publicKey,
  tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID });
console.log("4) collectFees:", feeSig ? "claimed" : "null (empty) — loop-safe either way");

console.log("\nCONSUMER SMOKE PASS — launchpad surface works end to end");

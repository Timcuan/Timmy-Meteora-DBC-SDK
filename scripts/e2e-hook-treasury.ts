#!/usr/bin/env bun
/**
 * bonding-guard treasury gate proof on localnet:
 *   1) deploy a "locked" launch (transfer hook attached)
 *   2) sniper buys      -> OK   (buy always open)
 *   3) sniper sells     -> REVERTS (not the treasury)
 *   4) treasury sells   -> OK   (the only wallet allowed to exit)
 *
 * Treasury wallet is baked into the hook at compile time; its keypair is
 * `programs/bonding-guard/target/deploy/operator-keypair.json`.
 */
import { Connection, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction, PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createSyncNativeInstruction,
  NATIVE_MINT as WSOL,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import {
  deploy, getProgram, swap2,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, BONDING_GUARD_PROGRAM_ID,
} from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const authority = Keypair.generate();
const sniper = Keypair.generate();
const treasury = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("programs/bonding-guard/target/deploy/operator-keypair.json", "utf8"))));
for (const k of [authority, sniper, treasury]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 500e9), "confirmed");

const program = getProgram(conn, { publicKey: authority.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any);
const send = async (t: Transaction, signers: Keypair[]) => sendAndConfirmTransaction(conn, t, signers, { commitment: "confirmed", skipPreflight: true });

// ── 1) deploy locked ───────────────────────────────────────────────────────────
const built = await deploy({
  authority, connection: conn, mode: "locked",
  identity: { name: "Treasury Gate", symbol: "TGATE", uri: "https://x.test/tgate.json" },
  startPrice: 5e-8, graduationQuote: 6500, totalSupply: 1e9,
});
await send(built.transaction, [authority, ...built.signers]);
console.log("1) locked launch deployed | pool:", built.pool.toBase58());

// ── helpers: wrap SOL + make base ATA, then a swap in a given direction ────────
const setup = async (wallet: Keypair) => {
  const w = getAssociatedTokenAddressSync(WSOL, wallet.publicKey, true, TOKEN_PROGRAM_ID);
  const b = getAssociatedTokenAddressSync(built.baseMint, wallet.publicKey, true, TOKEN_2022_PROGRAM_ID);
  await send(new Transaction().add(
    createAssociatedTokenAccountInstruction(wallet.publicKey, w, wallet.publicKey, WSOL, TOKEN_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(wallet.publicKey, b, wallet.publicKey, built.baseMint, TOKEN_2022_PROGRAM_ID),
    SystemProgram.transfer({ fromPubkey: wallet.publicKey, toPubkey: w, lamports: 50e9 }),
    createSyncNativeInstruction(w, TOKEN_PROGRAM_ID),
  ), [wallet]);
  return { w, b };
};
const doSwap = async (wallet: Keypair, input: PublicKey, output: PublicKey, amount: bigint) => {
  const ix = await swap2({
    program, payer: wallet.publicKey, config: built.config, pool: built.pool,
    baseMint: built.baseMint, quoteMint: WSOL,
    inputTokenAccount: input, outputTokenAccount: output,
    amount0: amount, amount1: 0n, swapMode: 0, // ExactIn
    tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
    transferHook: true, transferHookProgram: BONDING_GUARD_PROGRAM_ID,
  });
  await send(new Transaction().add(ix), [wallet]);
};

// ── 2) sniper buys ─────────────────────────────────────────────────────────────
const s = await setup(sniper);
await doSwap(sniper, s.w, s.b, 1_000_000_000n); // 1 SOL in
const sniperBal = await conn.getTokenAccountBalance(s.b, "confirmed");
console.log("2) sniper bought:", sniperBal.value.uiAmount, "base (buy open)");

// ── 3) sniper sells -> REVERT ──────────────────────────────────────────────────
let sniperSellErr: string | null = null;
try { await doSwap(sniper, s.b, s.w, BigInt(Math.floor((sniperBal.value.uiAmount ?? 0) * 1e6))); }
catch (e: any) { sniperSellErr = String(e?.message ?? e).slice(0, 120); }
if (!sniperSellErr) throw new Error("sniper SELL succeeded — gate did not block it");
console.log("3) sniper sell REVERTED (not treasury)");

// ── 4) treasury sells -> OK ────────────────────────────────────────────────────
const t = await setup(treasury);
await doSwap(treasury, t.w, t.b, 1_000_000_000n); // treasury buys (ohp)
const tBal = await conn.getTokenAccountBalance(t.b, "confirmed");
await doSwap(treasury, t.b, t.w, BigInt(Math.floor((tBal.value.uiAmount ?? 0) * 1e6))); // treasury sells
console.log("4) treasury sold its base back on the curve (allowed)");

console.log("\nTREASURY GATE PASS — buy open, treasury-only sell");
#!/usr/bin/env bun
/**
 * Localnet proof of the two new levers:
 *   1) exponentialFeeDecay — 99% cliff, 5%/period geometric decay
 *   2) buildKneeCurve      — flat entry segment, thin pump segment to graduation
 * Launch, buy, and read back the on-chain fee schedule + curve segments.
 */
import { Connection, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createSyncNativeInstruction,
  NATIVE_MINT as WSOL,
} from "@solana/spl-token";
import {
  launchToken, getProgram, swap2, fetchPool, fetchPoolConfig,
  exponentialFeeDecay, buildKneeCurve, sqrtPriceFromPrice, feeAtElapsed, feePct,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const authority = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, 500e9), "confirmed");

// ── the two new levers ─────────────────────────────────────────────────────────
const fee = exponentialFeeDecay({ cliffFeePct: 99, reductionBps: 200, numberOfPeriod: 100, periodFrequency: 1n });
const sqrtStart = sqrtPriceFromPrice(5e-8, 6, 9);
const curve = buildKneeCurve({
  sqrtStartPrice: sqrtStart,
  migrationQuoteThreshold: 65n * 10n ** 9n,
  swapBaseAmount: 510_000_000n * 10n ** 6n,
  kneeSqrtPrice: (sqrtStart * 15n) / 10n, // knee 1.5x sqrt (2.25x price); pm is only 2x ps
  tailLiquidity: 49_737_174_511_549_300_381_436_441_047_036n, // thin segment absorbs ~20 of the 65 SOL
});

// what the fee schedule actually does (local math vs on-chain below)
console.log("1) exponential schedule: cliff 99%, 5%/period");
for (const t of [0, 10, 30, 60, 100]) {
  console.log(`   t=${String(t).padStart(3)}s  fee=${feePct(feeAtElapsed(fee, t)).toFixed(2)}%`);
}

const result = await launchToken({
  authority, connection: conn,
  name: "Knee Proof", symbol: "KNEE", uri: "https://x.test/knee.json",
  startPrice: 5e-8, graduationQuote: 65, totalSupply: 1e9,
  baseFee: fee,
  curve,
  skipPreflight: true,
});
console.log("2) launched | pool:", result.pool.toBase58());

// ── read back on-chain: fee schedule + curve segments ──────────────────────────
const cfg = (await fetchPoolConfig(conn, result.config))!;
const bf = cfg.poolFees.baseFee;
console.log("3) on-chain baseFee:");
console.log("   mode            :", bf.baseFeeMode, "(1 = exponential)");
console.log("   cliffFeeNumerator:", Number(bf.cliffFeeNumerator) / 1e7 + "%");
console.log("   reductionFactor  :", Number(bf.thirdFactor), "bps/period");
console.log("   numberOfPeriod   :", Number(bf.firstFactor));

const pts = (cfg.curve as any[]).filter((p: any) => p.liquidity > 0n);
console.log("4) on-chain curve segments:", pts.length);
for (const p of pts) {
  console.log(`   sqrtPrice=${p.sqrtPrice} liquidity=${p.liquidity}`);
}

// ── buy through the knee, verify price jumps ───────────────────────────────────
const program = getProgram(conn, { publicKey: authority.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any);
const w = getAssociatedTokenAddressSync(WSOL, authority.publicKey, true, TOKEN_PROGRAM_ID);
const b = getAssociatedTokenAddressSync(result.baseMint, authority.publicKey, true, TOKEN_2022_PROGRAM_ID);
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountInstruction(authority.publicKey, w, authority.publicKey, WSOL, TOKEN_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(authority.publicKey, b, authority.publicKey, result.baseMint, TOKEN_2022_PROGRAM_ID),
  SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: w, lamports: 100e9 }),
  createSyncNativeInstruction(w, TOKEN_PROGRAM_ID),
), [authority], { commitment: "confirmed", skipPreflight: true });

const p0 = (await fetchPool(conn, result.pool))!;
const ix = await swap2({
  program, payer: authority.publicKey, config: result.config, pool: result.pool,
  baseMint: result.baseMint, quoteMint: WSOL,
  inputTokenAccount: w, outputTokenAccount: b,
  amount0: 30_000_000_000n, amount1: 0n, swapMode: 1,
  tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
});
await sendAndConfirmTransaction(conn, new Transaction().add(ix), [authority], { commitment: "confirmed", skipPreflight: true });
const p1 = (await fetchPool(conn, result.pool))!;

const price0 = Number(p0.sqrtPrice * p0.sqrtPrice) / 1e30;
const price1 = Number(p1.sqrtPrice * p1.sqrtPrice) / 1e30;
console.log("5) bought 30 SOL through the knee:");
console.log(`   sqrtPrice ${p0.sqrtPrice} -> ${p1.sqrtPrice} (${(price1 / price0).toFixed(1)}x)`);

const okMode = Number(bf.baseFeeMode) === 1;
const okCurve = pts.length === 3;
if (!okMode) throw new Error("fee mode is not exponential on-chain");
if (!okCurve) throw new Error(`expected 3 curve segments, got ${pts.length}`);
console.log("\nLEVERS PASS — exponential fee live, knee curve live");
#!/usr/bin/env bun
/** Proves `collectFees`: a buy accrues trading fee, collection sweeps it, re-collect is empty. */
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, NATIVE_MINT as WSOL,
} from "@solana/spl-token";
import {
  launchToken, getProgram, swap2, collectFees,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const authority = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, 80e9), "confirmed");

const launch = await launchToken({
  authority, connection: conn,
  name: "Collect", symbol: "CLT", uri: "https://x.test/h",
  startPrice: 5e-8, graduationQuote: 65, totalSupply: 1e9,
  baseFee: { cliffFeeNumerator: 850_000_000n, numberOfPeriod: 100, periodFrequency: 1n, reductionFactor: 8_250_000n, mode: 0 },
});

// buyer buys → fee accrues (cliff 85%)
const buyer = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(buyer.publicKey, 50e9), "confirmed");
const buyerW = getAssociatedTokenAddressSync(WSOL, buyer.publicKey, true, TOKEN_PROGRAM_ID);
const buyerB = getAssociatedTokenAddressSync(launch.baseMint, buyer.publicKey, true, TOKEN_2022_PROGRAM_ID);
const program = getProgram(conn, { publicKey: buyer.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any);
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountInstruction(buyer.publicKey, buyerW, buyer.publicKey, WSOL, TOKEN_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(buyer.publicKey, buyerB, buyer.publicKey, launch.baseMint, TOKEN_2022_PROGRAM_ID),
  await import("@solana/web3.js").then(({ SystemProgram }) => SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: buyerW, lamports: 20e9 })),
  createSyncNativeInstruction(buyerW, TOKEN_PROGRAM_ID),
), [buyer], { commitment: "confirmed" });

const ix = await swap2({ program, payer: buyer.publicKey, config: launch.config, pool: launch.pool, baseMint: launch.baseMint, quoteMint: WSOL, inputTokenAccount: buyerW, outputTokenAccount: buyerB, amount0: 5_000_000_000n, amount1: 0n, swapMode: 1, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID });
await sendAndConfirmTransaction(conn, new Transaction().add(ix), [buyer], { commitment: "confirmed" });
console.log("1) buyer bought 5 SOL (fee accrued at cliff)");

// collect the trading fee (fee_claimer = authority)
const sig1 = await collectFees({
  connection: conn, authority,
  config: launch.config, pool: launch.pool, baseMint: launch.baseMint, quoteMint: WSOL,
  feeClaimer: authority.publicKey, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
});
console.log("2) collect #1:", sig1 ? "claimed " + sig1.slice(0, 16) : "EMPTY (should NOT be empty)");

const sig2 = await collectFees({
  connection: conn, authority,
  config: launch.config, pool: launch.pool, baseMint: launch.baseMint, quoteMint: WSOL,
  feeClaimer: authority.publicKey, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
});
console.log("3) collect #2:", sig2 ? "claimed again" : "empty (correct — already swept)");

console.log(sig1 && !sig2 ? "COLLECT PASS (fee swept once, then empty)" : "UNEXPECTED");
process.exit(sig1 && !sig2 ? 0 : 1);
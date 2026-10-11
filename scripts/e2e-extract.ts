#!/usr/bin/env bun
/**
 * Extraction-surface proof on localnet:
 *   registerPartner → max-extraction launch → claim pool-creation fee →
 *   transferPoolCreator → graduate → migrate → withdrawLeftover →
 *   trading-fee / surplus / migration-fee claims.
 *
 * Proves the ix wrappers added in the partner/creator extraction surface and
 * the extraction knobs threaded through launchToken (`postMigrationTokenSupply`,
 * `liquiditySplit`, `migrationFee*`, `poolCreationFee`, `enableFirstSwapWithMinFee`).
 */
import {
  Connection, Keypair, PublicKey, Transaction, SystemProgram,
  sendAndConfirmTransaction, ComputeBudgetProgram, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, NATIVE_MINT as WSOL,
} from "@solana/spl-token";
import {
  launchToken, getProgram, swap2, fetchPool, fetchPoolConfig,
  migrationDammV2CreateMetadata, migrationDammV2, POOL_AUTHORITY,
  dammPositionNftAccount, dammTokenVault,
  registerPartner, partnerRevenue, creatorRevenue, transferCreator,
  claimPartnerPoolCreationFee, withdrawLeftover,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, DAMM_V2_PROGRAM_ID,
} from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");

const authority = Keypair.generate();   // partner (fee_claimer) + original creator
await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, 80e9), "confirmed");

// ── 1) register partner ──
const regIx = await registerPartner({
  program: getProgram(conn, { publicKey: authority.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any),
  feeClaimer: authority.publicKey, payer: authority.publicKey,
  name: "Demo Launch", website: "https://x.test", logo: "https://x.test/l.png",
});
await sendAndConfirmTransaction(conn, new Transaction().add(regIx), [authority], { commitment: "confirmed" });
const pm = PublicKey.findProgramAddressSync([Buffer.from("partner_metadata"), authority.publicKey.toBuffer()],
  new PublicKey("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN"))[0];
console.log("1) partner registered:", (await conn.getAccountInfo(pm, "confirmed")) ? "OK" : "MISSING");

// ── 2) max-extraction launch ──
const launch = await launchToken({
  authority, connection: conn,
  name: "Extract Proof", symbol: "EXTR", uri: "https://x.test/e",
  startPrice: 5e-8, graduationQuote: 65, totalSupply: 1e9,
  liquiditySplit: {
    partnerLiquidityPercentage: 50,
    partnerPermanentLockedLiquidityPercentage: 10,
    creatorLiquidityPercentage: 40,
    creatorPermanentLockedLiquidityPercentage: 0,
  },
  migrationFeePercentage: 10,
  creatorMigrationFeePercentage: 50,
  poolCreationFee: 100_000_000, // 0.1 SOL
  enableFirstSwapWithMinFee: true,
});
const cfg = (await fetchPoolConfig(conn, launch.config))!;
const threshold: bigint = cfg.migrationQuoteThreshold as bigint;
console.log("2) launched:", launch.pool.toBase58(), "| leftover planned:", (Number(launch.leftover) / 1e6).toLocaleString(), "base units");

// ── 3) claim pool-creation fee (partner, right after launch) ──
const beforeLamports = await conn.getBalance(authority.publicKey);
const pcfIx = await claimPartnerPoolCreationFee({
  program: getProgram(conn, { publicKey: authority.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any),
  config: launch.config, pool: launch.pool, feeClaimer: authority.publicKey, feeReceiver: authority.publicKey,
});
try {
  await sendAndConfirmTransaction(conn, new Transaction().add(pcfIx), [authority], { commitment: "confirmed" });
  const after = await conn.getBalance(authority.publicKey);
  console.log("3) pool-creation fee claimed:", ((after - beforeLamports) / LAMPORTS_PER_SOL).toFixed(4), "SOL (want ~0.09)");
} catch (e: any) {
  console.log("3) POOL-CREATION FEE FAILED:", e.message?.slice(0, 120));
}

// ── 4) transfer pool creator (PreBondingCurve) ──
const exitWallet = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(exitWallet.publicKey, 5e9), "confirmed");
await sendAndConfirmTransaction(conn, new Transaction().add(await transferCreator({
  program: getProgram(conn, { publicKey: authority.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any),
  config: launch.config, pool: launch.pool, creator: authority.publicKey, newCreator: exitWallet.publicKey,
})), [authority], { commitment: "confirmed" });
const poolAfterTransfer = (await fetchPool(conn, launch.pool))!;
console.log("4) creator transferred:", poolAfterTransfer.creator.equals(exitWallet.publicKey) ? "OK" : "FAILED");

// ── 5) graduate (buy loop) ──
const buyer = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(buyer.publicKey, 800e9), "confirmed");
const buyerW = getAssociatedTokenAddressSync(WSOL, buyer.publicKey, true, TOKEN_PROGRAM_ID);
const buyerB = getAssociatedTokenAddressSync(launch.baseMint, buyer.publicKey, true, TOKEN_2022_PROGRAM_ID);
const program = getProgram(conn, { publicKey: buyer.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any);
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountInstruction(buyer.publicKey, buyerW, buyer.publicKey, WSOL, TOKEN_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(buyer.publicKey, buyerB, buyer.publicKey, launch.baseMint, TOKEN_2022_PROGRAM_ID),
  SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: buyerW, lamports: 700e9 }),
  createSyncNativeInstruction(buyerW, TOKEN_PROGRAM_ID),
), [buyer], { commitment: "confirmed" });
for (let i = 0; i < 80; i++) {
  const p = (await fetchPool(conn, launch.pool))!;
  if (p.sqrtPrice >= cfg.migrationSqrtPrice) break;
  const need: bigint = threshold - (p.quoteReserve as bigint);
  if (need <= 0n) break;
  const bf = cfg.poolFees.baseFee;
  const elapsed = BigInt(Math.floor(Date.now() / 1000)) - p.activationPoint;
  const per = elapsed / bf.secondFactor > BigInt(bf.firstFactor) ? BigInt(bf.firstFactor) : elapsed / bf.secondFactor;
  let feeNum = bf.cliffFeeNumerator - bf.thirdFactor * per; if (feeNum < 0n) feeNum = 0n;
  const gross: bigint = ((need * 1_000_000_000n) / (1_000_000_000n - feeNum)) * 2n;
  const ix = await swap2({
    program, payer: buyer.publicKey, config: launch.config, pool: launch.pool,
    baseMint: launch.baseMint, quoteMint: WSOL,
    inputTokenAccount: buyerW, outputTokenAccount: buyerB,
    amount0: gross, amount1: 0n, swapMode: 1,
    tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  });
  try { await sendAndConfirmTransaction(conn, new Transaction().add(ix), [buyer], { commitment: "confirmed", skipPreflight: true }); } catch { }
}
const done = (await fetchPool(conn, launch.pool))!;
if (done.sqrtPrice < cfg.migrationSqrtPrice) throw new Error("curve did not complete");
console.log("5) course complete → progress:", done.migrationProgress);

// ── 6) migrate (creator = exitWallet signs the position NFT mints) ──
await sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: POOL_AUTHORITY, lamports: 3_000_000_000 }),
), [authority], { commitment: "confirmed" });
const metaIx = await migrationDammV2CreateMetadata({ program, config: launch.config, pool: launch.pool, payer: authority.publicKey });
await sendAndConfirmTransaction(conn, new Transaction().add(metaIx), [authority], { commitment: "confirmed", skipPreflight: true });
const dammPool = PublicKey.findProgramAddressSync([Buffer.from("pool"), launch.dammConfig.toBuffer(), launch.baseMint.toBuffer(), WSOL.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
const nft1 = Keypair.generate(), nft2 = Keypair.generate();
const pos = (m: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), m.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
const migIx = await migrationDammV2({
  program, config: launch.config, pool: launch.pool, baseMint: launch.baseMint, quoteMint: WSOL,
  payer: authority.publicKey, dammPool,
  firstPositionNftMint: nft1.publicKey, firstPositionNftAccount: dammPositionNftAccount(nft1.publicKey), firstPosition: pos(nft1.publicKey),
  secondPositionNftMint: nft2.publicKey, secondPositionNftAccount: dammPositionNftAccount(nft2.publicKey), secondPosition: pos(nft2.publicKey),
  tokenAVault: dammTokenVault(dammPool, launch.baseMint), tokenBVault: dammTokenVault(dammPool, WSOL),
  tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  remainingAccounts: [{ pubkey: launch.dammConfig, isWritable: false, isSigner: false }],
});
try {
  await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 })).add(migIx), [authority, nft1, nft2], { commitment: "confirmed", skipPreflight: true });
} catch (e: any) {
  const logs = e.signature ? (await conn.getTransaction(e.signature, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages : null;
  console.log("6) MIGRATE FAILED:", (logs ?? [e.message]).filter((l: string) => /rror/i.test(l)).slice(0, 3));
  process.exit(1);
}
console.log("6) migrated → progress:", (await fetchPool(conn, launch.pool))!.migrationProgress);

// ── 7) withdraw leftover ──
const leftAta = getAssociatedTokenAddressSync(launch.baseMint, authority.publicKey, true, TOKEN_2022_PROGRAM_ID);
const authWsol = getAssociatedTokenAddressSync(WSOL, authority.publicKey, true, TOKEN_PROGRAM_ID);
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountInstruction(authority.publicKey, leftAta, authority.publicKey, launch.baseMint, TOKEN_2022_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(authority.publicKey, authWsol, authority.publicKey, WSOL, TOKEN_PROGRAM_ID),
), [authority], { commitment: "confirmed" }).catch(() => {});
try {
  await sendAndConfirmTransaction(conn, new Transaction().add(await withdrawLeftover({
    program, config: launch.config, pool: launch.pool, baseMint: launch.baseMint,
    leftoverReceiver: authority.publicKey, tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
  })), [authority], { commitment: "confirmed" });
  const bal = await conn.getTokenAccountBalance(leftAta, "confirmed");
  console.log("7) leftover withdrawn:", bal.value.uiAmount?.toLocaleString(), "tokens");
} catch (e: any) {
  const logs = e.signature ? (await conn.getTransaction(e.signature, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages : null;
  console.log("7) LEFTOVER FAILED:", (logs ?? [e.message]).filter((l: string) => /rror/i.test(l)).slice(0, 3));
}

// ── 8) partner revenue: trading fee + surplus ──
const partnerProg = getProgram(conn, { publicKey: authority.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any);
const pRev = await partnerRevenue({
  program: partnerProg, config: launch.config, pool: launch.pool,
  baseMint: launch.baseMint, quoteMint: WSOL, feeClaimer: authority.publicKey,
  tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
});
await sendAndConfirmTransaction(conn, new Transaction().add(pRev.tradingFee), [authority], { commitment: "confirmed", skipPreflight: true })
  .then(() => console.log("8) partner trading fee claimed: OK"))
   .catch(async (e: any) => { const logs = e.signature ? (await conn.getTransaction(e.signature, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages : null; console.log("8) trading fee:", (logs ?? [e.message]).filter((l: string) => /rror/i.test(l)).slice(0, 2)); });
await sendAndConfirmTransaction(conn, new Transaction().add(pRev.surplus), [authority], { commitment: "confirmed", skipPreflight: true })
  .then(() => console.log("9) partner surplus claimed: OK"))
   .catch(async (e: any) => { const logs = e.signature ? (await conn.getTransaction(e.signature, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages : null; console.log("9) surplus:", (logs ?? [e.message]).filter((l: string) => /rror/i.test(l)).slice(0, 2)); });

// ── 10) creator revenue (creator = exitWallet) ──
const exitProg = getProgram(conn, { publicKey: exitWallet.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any);
const exitAta = getAssociatedTokenAddressSync(WSOL, exitWallet.publicKey, true, TOKEN_PROGRAM_ID);
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountInstruction(authority.publicKey, exitAta, exitWallet.publicKey, WSOL, TOKEN_PROGRAM_ID),
), [authority], { commitment: "confirmed" }).catch(() => {});
const cRev = await creatorRevenue({
  program: exitProg, config: launch.config, pool: launch.pool,
  baseMint: launch.baseMint, quoteMint: WSOL, creator: exitWallet.publicKey,
  tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
});
await sendAndConfirmTransaction(conn, new Transaction().add(cRev.surplus).add(cRev.migrationFee), [exitWallet], { commitment: "confirmed", skipPreflight: true })
  .then(() => console.log("10) creator surplus + migration fee claimed: OK"))
   .catch(async (e: any) => { const logs = e.signature ? (await conn.getTransaction(e.signature, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages : null; console.log("10) creator revenue:", (logs ?? [e.message]).filter((l: string) => /rror/i.test(l)).slice(0, 3)); });

console.log("\nEXTRACTION SURFACE DONE");
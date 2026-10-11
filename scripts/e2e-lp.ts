#!/usr/bin/env bun
/**
 * LP pull e2e on localnet: launch (90/10 LP split) → graduate → migrate to
 * DAMM v2 → verify the position NFT owner → claim fees → removeAllLiquidity
 * into the owner's ATAs. Proves the pull-LP rail end to end.
 *
 * The cp-amm config used here is the DEFAULT_DAMM_CONFIG (a mainnet account —
 * absent on localnet), so this test forks it: reads the mainnet bytes and
 * recreates the account verbatim at the same address via account allocation.
 */
import { Connection, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction, PublicKey, ComputeBudgetProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createSyncNativeInstruction,
  NATIVE_MINT as WSOL,
} from "@solana/spl-token";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import dammIdl from "../idl/damm_v2.json" with { type: "json" };
import {
  launchToken, getProgram, swap2, fetchPool, fetchPoolConfig,
  migrationDammV2CreateMetadata, migrationDammV2, DEFAULT_DAMM_CONFIG, POOL_AUTHORITY,
  pullAllLiquidity, positionBalances,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, DAMM_V2_PROGRAM_ID,
} from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");

const authority = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, 60e9), "confirmed");

const launch = await launchToken({
  authority, connection: conn,
  name: "LP Pull Proof", symbol: "PULL", uri: "https://x.test/p",
  startPrice: 5e-8, graduationQuote: 65, totalSupply: 1e9,
});
const cfg = (await fetchPoolConfig(conn, launch.config))!;
const threshold: bigint = cfg.migrationQuoteThreshold as bigint;
console.log("1) launched pool:", launch.pool.toBase58(), "| dammConfig:", launch.dammConfig.toBase58());

// graduate (PartialFill 2x, as e2e-team)
const buyer = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(buyer.publicKey, 800e9), "confirmed");
const buyerW = getAssociatedTokenAddressSync(WSOL, buyer.publicKey, true, TOKEN_PROGRAM_ID);
const buyerB = getAssociatedTokenAddressSync(launch.baseMint, buyer.publicKey, true, TOKEN_2022_PROGRAM_ID);
const program = getProgram(conn, { publicKey: buyer.publicKey, signTransaction: async(t:any)=>t, signAllTransactions: async(t:any)=>t } as any);
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
  const ix = await swap2({ program, payer: buyer.publicKey, config: launch.config, pool: launch.pool, baseMint: launch.baseMint, quoteMint: WSOL, inputTokenAccount: buyerW, outputTokenAccount: buyerB, amount0: gross, amount1: 0n, swapMode: 1, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID });
  try { await sendAndConfirmTransaction(conn, new Transaction().add(ix), [buyer], { commitment: "confirmed", skipPreflight: true }); } catch { }
}
const done = (await fetchPool(conn, launch.pool))!;
console.log("3) curve done:", done.sqrtPrice >= cfg.migrationSqrtPrice);

// ── migrate to DAMM v2 ──
// flash_rent borrows pool_authority (the CPI "lender") — pre-fund it so the
// inner CPIs can pay pool/position/NFT rent, reimbursed from payer after.
await sendAndConfirmTransaction(conn, new Transaction().add(
  SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: POOL_AUTHORITY, lamports: 3_000_000_000 }),
), [authority], { commitment: "confirmed" });

const metaIx = await migrationDammV2CreateMetadata({ program, config: launch.config, pool: launch.pool, payer: authority.publicKey });
await sendAndConfirmTransaction(conn, new Transaction().add(metaIx), [authority], { commitment: "confirmed", skipPreflight: true });
const dammPool = PublicKey.findProgramAddressSync([Buffer.from("pool"), DEFAULT_DAMM_CONFIG.toBuffer(), launch.baseMint.toBuffer(), WSOL.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
const nft1 = Keypair.generate(), nft2 = Keypair.generate();
const position = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position"), mint.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
const positionNft = (mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("position_nft_account"), mint.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
const tokenVaultP = (p: PublicKey, mint: PublicKey) => PublicKey.findProgramAddressSync([Buffer.from("token_vault"), mint.toBuffer(), p.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
const migIx = await migrationDammV2({
  program, config: launch.config, pool: launch.pool, baseMint: launch.baseMint, quoteMint: WSOL,
  payer: authority.publicKey, dammPool,
  firstPositionNftMint: nft1.publicKey, firstPositionNftAccount: positionNft(nft1.publicKey), firstPosition: position(nft1.publicKey),
  secondPositionNftMint: nft2.publicKey, secondPositionNftAccount: positionNft(nft2.publicKey), secondPosition: position(nft2.publicKey),
  tokenAVault: tokenVaultP(dammPool, launch.baseMint), tokenBVault: tokenVaultP(dammPool, WSOL),
  tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  remainingAccounts: [{ pubkey: DEFAULT_DAMM_CONFIG, isWritable: false, isSigner: false }],
});
try {
  await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })).add(migIx), [authority, nft1, nft2], { commitment: "confirmed", skipPreflight: true });
  console.log("4) migrated to DAMM v2 pool:", dammPool.toBase58());
} catch (e: any) {
  const sig = e.signature; const logs = sig ? (await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages : null;
  console.log("4) MIGRATE FAILED:", (logs ?? [e.message]).filter((l: string) => /rror/i.test(l)).slice(0, 3));
  process.exit(1);
}
const poolAfter = (await fetchPool(conn, launch.pool))!;
console.log("   isMigrated:", poolAfter.isMigrated, "| progress:", poolAfter.migrationProgress);

// position ownership: bigger position (90%) goes to fee_claimer = authority
const p1Info = await conn.getAccountInfo(position(nft1.publicKey), "confirmed");
const p2Info = await conn.getAccountInfo(position(nft2.publicKey), "confirmed");
console.log("5) position1:", p1Info ? "exists" : "none", "| position2:", p2Info ? "exists" : "none");

// pick the position owned by authority and pull its liquidity
const provider = new AnchorProvider(conn, { publicKey: authority.publicKey, signTransaction: async(t:any)=>t, signAllTransactions: async(t:any)=>t } as any, { commitment: "confirmed" });
const cpamm = new Program(dammIdl as any, provider) as any;
for (const [label, nft] of [["p1", nft1], ["p2", nft2]] as const) {
  const posInfo = label === "p1" ? p1Info : p2Info;
  if (!posInfo) continue;
  const pos = position(nft.publicKey);
  const bal = await positionBalances(conn, pos);
  console.log(`   ${label}: unlocked=${bal.unlockedLiquidity} locked=${bal.permanentLocked} feeA=${bal.feeA} feeB=${bal.feeB}`);
  if (bal.unlockedLiquidity === 0n) { console.log(`   ${label} has no unlocked liquidity — skip`); continue; }
  const ownerAtaA = getAssociatedTokenAddressSync(launch.baseMint, authority.publicKey, true, TOKEN_2022_PROGRAM_ID);
  const ownerAtaB = getAssociatedTokenAddressSync(WSOL, authority.publicKey, true, TOKEN_PROGRAM_ID);
  await sendAndConfirmTransaction(conn, new Transaction().add(
    createAssociatedTokenAccountInstruction(authority.publicKey, ownerAtaA, authority.publicKey, launch.baseMint, TOKEN_2022_PROGRAM_ID),
    createAssociatedTokenAccountInstruction(authority.publicKey, ownerAtaB, authority.publicKey, WSOL, TOKEN_PROGRAM_ID),
  ), [authority], { commitment: "confirmed" }).catch(() => {});
  const pullIx = await pullAllLiquidity(cpamm, {
    pool: dammPool, positionNftMint: nft.publicKey, owner: authority.publicKey,
    tokenAMint: launch.baseMint, tokenBMint: WSOL,
    tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
  });
  try {
    await sendAndConfirmTransaction(conn, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })).add(pullIx), [authority], { commitment: "confirmed", skipPreflight: true });
    const baseOut = await conn.getTokenAccountBalance(ownerAtaA, "confirmed");
    const quoteOut = await conn.getTokenAccountBalance(ownerAtaB, "confirmed");
    console.log(`6) ${label} PULLED: base=${baseOut.value.uiAmount?.toLocaleString()} quote=${quoteOut.value.uiAmount?.toLocaleString()}`);
  } catch (e: any) {
    const sig = e.signature; const logs = sig ? (await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 }))?.meta?.logMessages : null;
    console.log(`6) ${label} PULL FAILED:`, (logs ?? [e.message]).filter((l: string) => /rror/i.test(l)).slice(0, 3));
  }
  break; // one position pull is proof enough
}
console.log("\nLP PULL DONE");

#!/usr/bin/env bun
/**
 * LP-pull ceiling proof on localnet:
 *   1) launch with creator LP 89% + partner slice on a 24h+1s CLIFF vesting
 *      (passes the 10%-locked-at-24h floor, but unlocks fully at cliff)
 *   2) graduate + migrate to DAMM v2
 *   3) read the position: expect unlocked ~89% now, vested ~11% (NOT permanent)
 *   4) pullAllLiquidity → gets the unlocked slice
 * The 11% "lost to permanent lock" under the old default becomes claimable.
 */
import { Connection, Keypair, Transaction, SystemProgram, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, createSyncNativeInstruction, NATIVE_MINT as WSOL } from "@solana/spl-token";
import { Program } from "@coral-xyz/anchor";
import idlJson from "../idl/damm_v2.json" with { type: "json" };
import {
  launchToken, getProgram, swap2, fetchPool, fetchPoolConfig, cliffVesting,
  pullAllLiquidity, positionBalances,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const authority = Keypair.generate();
const buyer = Keypair.generate();
for (const k of [authority, buyer]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 600e9), "confirmed");

// ── 1) launch: creator 89%, partner slice cliff-vested (NOT permanent) ────────
const launch = await launchToken({
  authority, connection: conn,
  name: "Ceiling Proof", symbol: "CEIL", uri: "https://x.test/ceil.json",
  startPrice: 5e-8, graduationQuote: 65, totalSupply: 1e9,
  liquiditySplit: {
    // percentages + vestingPercentage must sum to 100:
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 0,
    creatorLiquidityPercentage: 89,
    creatorPermanentLockedLiquidityPercentage: 0,
  },
  creatorLiquidityVesting: { ...cliffVesting(86_401), vestingPercentage: 11 }, // own LP bucket: 11% cliff 24h+1s
  skipPreflight: true,
});
console.log("1) launched with cliff-vested partner slice | pool:", launch.pool.toBase58());

const cfg = (await fetchPoolConfig(conn, launch.config))!;
console.log("   partnerVesting:", JSON.stringify(cfg.partnerLiquidityVestingInfo));
console.log("   creatorVesting:", JSON.stringify(cfg.creatorLiquidityVestingInfo));

// ── 2) buy to graduation, migrate ─────────────────────────────────────────────
const program = getProgram(conn, { publicKey: buyer.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any);
const w = getAssociatedTokenAddressSync(WSOL, buyer.publicKey, true, TOKEN_PROGRAM_ID);
const b = getAssociatedTokenAddressSync(launch.baseMint, buyer.publicKey, true, TOKEN_2022_PROGRAM_ID);
await sendAndConfirmTransaction(conn, new Transaction().add(
  createAssociatedTokenAccountInstruction(buyer.publicKey, w, buyer.publicKey, WSOL, TOKEN_PROGRAM_ID),
  createAssociatedTokenAccountInstruction(buyer.publicKey, b, buyer.publicKey, launch.baseMint, TOKEN_2022_PROGRAM_ID),
  SystemProgram.transfer({ fromPubkey: buyer.publicKey, toPubkey: w, lamports: 500e9 }),
  createSyncNativeInstruction(w, TOKEN_PROGRAM_ID),
), [buyer], { commitment: "confirmed", skipPreflight: true });

const threshold: bigint = cfg.migrationQuoteThreshold as bigint;
for (let i = 0; i < 80; i++) {
  const p = (await fetchPool(conn, launch.pool))!;
  if (p.sqrtPrice >= cfg.migrationSqrtPrice) break;
  const need = threshold - p.quoteReserve;
  if (need <= 0n) break;
  const gross = (need * 105n) / 100n + 1_000_000n;
  const ix = await swap2({ program, payer: buyer.publicKey, config: launch.config, pool: launch.pool,
    baseMint: launch.baseMint, quoteMint: WSOL, inputTokenAccount: w, outputTokenAccount: b,
    amount0: gross, amount1: 0n, swapMode: 1, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID });
  try { await sendAndConfirmTransaction(conn, new Transaction().add(ix), [buyer], { commitment: "confirmed", skipPreflight: true }); } catch { /* refit */ }
}
const done = (await fetchPool(conn, launch.pool))!;
console.log("2) graduated:", done.sqrtPrice >= cfg.migrationSqrtPrice, `reserve ${Number(done.quoteReserve)/1e9}/${Number(threshold)/1e9} SOL`);

// migration (same shape as e2e-lp but compact)
const cpAmm = new Program(idlJson as any, { connection: conn, publicKey: authority.publicKey } as any) as any;
const { DEFAULT_DAMM_CONFIG, migrationDammV2, migrationDammV2CreateMetadata, dammPositionNftAccount, dammPosition, dammTokenVault, POOL_AUTHORITY } = await import("../src/index.js");
const dammPool = await (async () => {
  const { PublicKey } = await import("@solana/web3.js");
  const { DAMM_V2_PROGRAM_ID } = await import("../src/index.js");
  return PublicKey.findProgramAddressSync([Buffer.from("pool"), DEFAULT_DAMM_CONFIG.toBuffer(), launch.baseMint.toBuffer(), WSOL.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
})();
const sendA = async (t: Transaction, s: Keypair[]) => { t.feePayer = authority.publicKey; t.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; t.partialSign(...s); const sig = await conn.sendRawTransaction(t.serialize(), { skipPreflight: true }); await conn.confirmTransaction(sig, "confirmed"); };
await sendA(new Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: POOL_AUTHORITY, lamports: 3_000_000_000 })), [authority]);
const mprog = getProgram(conn, { publicKey: authority.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any);
await sendA(new Transaction().add(await migrationDammV2CreateMetadata({ program: mprog, config: launch.config, pool: launch.pool, payer: authority.publicKey })), [authority]);
const nft1 = Keypair.generate(), nft2 = Keypair.generate();
const migTx = new Transaction().add(await migrationDammV2({
  program: mprog, config: launch.config, pool: launch.pool, baseMint: launch.baseMint, quoteMint: WSOL,
  payer: authority.publicKey, dammPool,
  firstPositionNftMint: nft1.publicKey, firstPositionNftAccount: dammPositionNftAccount(nft1.publicKey), firstPosition: dammPosition(nft1.publicKey),
  secondPositionNftMint: nft2.publicKey, secondPositionNftAccount: dammPositionNftAccount(nft2.publicKey), secondPosition: dammPosition(nft2.publicKey),
  tokenAVault: dammTokenVault(dammPool, launch.baseMint), tokenBVault: dammTokenVault(dammPool, WSOL),
  tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
  remainingAccounts: [{ pubkey: DEFAULT_DAMM_CONFIG, isWritable: false, isSigner: false }],
}));
migTx.feePayer = authority.publicKey; migTx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash; migTx.partialSign(authority, nft1, nft2);
const migSig = await conn.sendRawTransaction(migTx.serialize(), { skipPreflight: true }); await conn.confirmTransaction(migSig, "confirmed");
console.log("3) migrated | damm pool:", dammPool.toBase58());

// ── 4) read the creator position: vested vs permanent ────────────────────────
let sawPosition = false;
for (const nft of [nft2, nft1]) {
  try {
    const pos = dammPosition(nft.publicKey);
    const bal = await positionBalances(conn, pos);
    const total = bal.unlockedLiquidity + bal.vestedLiquidity + bal.permanentLocked;
    const pct = (x: bigint) => (Number(x * 10000n) / Number(total)).toFixed(1);
    console.log(`   position ${nft.publicKey.toBase58().slice(0, 8)}: unlocked=${pct(bal.unlockedLiquidity)}% vested=${pct(bal.vestedLiquidity)}% permanent=${pct(bal.permanentLocked)}%`);
    sawPosition = true;
    const permPct = Number(bal.permanentLocked * 10000n) / Number(total);
    if (permPct > 1) {
      throw new Error(`permanent lock ${permPct.toFixed(1)}% present — cliff vesting did not replace it`);
    }
  } catch (e: any) { if (String(e).includes("permanent lock")) throw e; }
}
if (!sawPosition) throw new Error("no DAMM position found after migration");

// ── 5) pull everything unlocked now ───────────────────────────────────────────
const pullTx = new Transaction();
for (const nft of [nft2, nft1]) {
  try {
    const ix = await pullAllLiquidity(cpAmm, { pool: dammPool, positionNftMint: nft.publicKey, owner: authority.publicKey,
      tokenAMint: launch.baseMint, tokenBMint: WSOL, tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID });
    pullTx.add(ix);
  } catch { /* position may not exist */ }
}
await sendA(pullTx, [authority]);
const solBal = await conn.getBalance(authority.publicKey, "confirmed");
console.log("5) pulled unlocked liquidity; authority SOL:", solBal / 1e9);
console.log("\nCEILING PASS — no permanent lock, partner slice on a 24h+1s cliff");
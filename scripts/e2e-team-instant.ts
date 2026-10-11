#!/usr/bin/env bun
/**
 * Team allocation INSTANT-unlock proof on localnet:
 *   launchToken({ teamAllocation }) → graduate → lockTeamAllocation → claim
 *   IMMEDIATELY (no vesting wait) → assert the FULL reserve is claimed.
 *
 * `launchToken.teamAllocation` maps to locked_vesting with cliff_duration=0 and
 * the whole reserve as `cliff_unlock_amount`, so the locker releases 100% the
 * moment `create_locker` runs — the vesting period is zero.
 */
import {
  Connection, Keypair, Transaction, SystemProgram,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction, NATIVE_MINT as WSOL,
} from "@solana/spl-token";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import lockerIdl from "../idl/locker.json" with { type: "json" };
import {
  launchToken, getProgram, swap2, fetchPool, fetchPoolConfig,
  lockTeamAllocation, claimTeamAllocation, reassignTeamAllocation, teamAllocationTotal,
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const authority = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(authority.publicKey, 80e9), "confirmed");

const TEAM = 50_000_000; // 5% of 1e9, whole tokens
const launch = await launchToken({
  authority, connection: conn,
  name: "Team Instant", symbol: "TMINST", uri: "https://x.test/t",
  startPrice: 5e-8, graduationQuote: 65, totalSupply: 1e9,
  teamAllocation: TEAM,
});
const cfg = (await fetchPoolConfig(conn, launch.config))!;
const threshold: bigint = cfg.migrationQuoteThreshold as bigint;
console.log("1) launched, pool:", launch.pool.toBase58(), "| team allocation config:", (Number(teamAllocationTotal(cfg)) / 1e6).toLocaleString(), "tokens");

// ── graduate ──
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
  const ix = await swap2({ program, payer: buyer.publicKey, config: launch.config, pool: launch.pool, baseMint: launch.baseMint, quoteMint: WSOL, inputTokenAccount: buyerW, outputTokenAccount: buyerB, amount0: gross, amount1: 0n, swapMode: 1, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID });
  try { await sendAndConfirmTransaction(conn, new Transaction().add(ix), [buyer], { commitment: "confirmed", skipPreflight: true }); } catch { }
}
const done = (await fetchPool(conn, launch.pool))!;
if (done.sqrtPrice < cfg.migrationSqrtPrice) throw new Error("curve failed");
console.log("2) curve complete → progress:", done.migrationProgress, "(PostBondingCurve expected for vested config)");

// ── lock the team allocation ──
const { fundInstruction: fundIx, instruction: ataIx, lockInstruction: lockIx, escrow } = await lockTeamAllocation({
  connection: conn, creator: authority, config: launch.config, pool: launch.pool, baseMint: launch.baseMint,
});
await sendAndConfirmTransaction(conn, new Transaction().add(fundIx, ataIx, lockIx), [authority], { commitment: "confirmed", skipPreflight: true })
  .catch(e => { console.log("LOCK FAILED:", e.message?.slice(0, 200)); process.exit(1); });
console.log("3) locker escrow created:", escrow.toBase58());

// ── claim IMMEDIATELY (no vesting wait) ──
const provider = new AnchorProvider(conn, { publicKey: authority.publicKey, signTransaction: async (t: any) => t, signAllTransactions: async (t: any) => t } as any, { commitment: "confirmed" });
const locker = new Program(lockerIdl as any, provider) as any;
const teamAta = getAssociatedTokenAddressSync(launch.baseMint, authority.publicKey, true, TOKEN_2022_PROGRAM_ID);
await sendAndConfirmTransaction(conn, new Transaction().add(createAssociatedTokenAccountInstruction(authority.publicKey, teamAta, authority.publicKey, launch.baseMint, TOKEN_2022_PROGRAM_ID)), [authority], { commitment: "confirmed" });
const claimIx = await claimTeamAllocation(locker, { escrow, claimant: authority.publicKey, tokenMint: launch.baseMint });
await sendAndConfirmTransaction(conn, new Transaction().add(claimIx), [authority], { commitment: "confirmed", skipPreflight: true })
  .catch(e => { console.log("CLAIM FAILED:", e.message?.slice(0, 200)); process.exit(1); });
const teamBal = await conn.getTokenAccountBalance(teamAta, "confirmed");
const claimed = Number(teamBal.value.uiAmount ?? 0);
const expect = TEAM; // uiAmount is whole tokens
console.log("4) claimed immediately:", claimed, "tokens | want", expect);
const full = Math.abs(claimed - expect) < 0.001;
console.log(full ? "INSTANT UNLOCK PASS (100% claimed, zero vesting wait)" : "MISMATCH — not full unlock");

// ── reassign still works ──
const teamWallet = Keypair.generate();
await conn.confirmTransaction(await conn.requestAirdrop(teamWallet.publicKey, 1e9), "confirmed");
const reassignIx = await reassignTeamAllocation(locker, { escrow, currentRecipient: authority.publicKey, newRecipient: teamWallet.publicKey });
await sendAndConfirmTransaction(conn, new Transaction().add(reassignIx), [authority], { commitment: "confirmed", skipPreflight: true })
  .catch(e => { console.log("REASSIGN FAILED:", e.message?.slice(0, 200)); process.exit(1); });
console.log("5) reassign still works →", teamWallet.publicKey.toBase58());

process.exit(full ? 0 : 1);
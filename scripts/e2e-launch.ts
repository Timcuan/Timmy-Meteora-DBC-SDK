#!/usr/bin/env bun
/** End-to-end launch proof on localnet: launchToken -> pool live, supply in vault, PDAs on chain. */
import { Connection, Keypair } from "@solana/web3.js";
import { launchToken, fetchPool, fetchPoolConfig, analyzePoolConfig, analyzeVirtualPool } from "../src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const authority = Keypair.generate();
const sig = await conn.requestAirdrop(authority.publicKey, 50e9);
await conn.confirmTransaction(sig, "confirmed");
console.log("authority:", authority.publicKey.toBase58());

const t0 = Date.now();
const result = await launchToken({
  authority,
  connection: conn,
  name: "Test Inference",
  symbol: "TINF",
  uri: "https://ipfs.io/ipfs/test",
  startPrice: 5e-8,       // 5e-8 SOL per token
  graduationQuote: 65,    // 65 SOL to graduate
  totalSupply: 1e9,
  decimals: 6,
});
console.log(`\nlaunched in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log("  signature:", result.signature);
console.log("  config   :", result.config.toBase58());
console.log("  pool     :", result.pool.toBase58());
console.log("  baseMint :", result.baseMint.toBase58());
console.log("  leftover :", (Number(result.leftover) / 1e6).toLocaleString(), "tokens reserved");

// verify on chain
const cfg = await fetchPoolConfig(conn, result.config);
const pool = await fetchPool(conn, result.pool);
if (!cfg || !pool) throw new Error("accounts not found after launch");

const a = analyzePoolConfig(cfg);
const pa = analyzeVirtualPool(pool, cfg);

console.log("\n── on-chain verification ──");
console.log("  pool.creator            :", pool.creator.toBase58() === authority.publicKey.toBase58() ? "MATCHES authority" : "MISMATCH");
console.log("  fixed supply           :", a.fixedTokenSupply);
console.log("  swapBaseAmount         :", (Number(a.supply.swapOnCurve) / 1e6).toLocaleString());
console.log("  migrationThreshold    :", (Number(a.supply.migrationThreshold) / 1e6).toLocaleString());
console.log("  leftover reserved     :", (Number(a.supply.leftover) / 1e6).toLocaleString(), `(${a.supply.leftoverBpsOfSupply / 100}%)`);
console.log("  fee                    :", `${a.fee.cliffFeePct}% -> ${a.fee.finalFeePct}% over ${a.fee.decaySeconds}s`);
console.log("  migrationProgress      :", pa.migrationProgressName);
console.log("  quoteReserve           :", Number(pool.quoteReserve) / 1e9, "SOL");
console.log("  sqrtPrice              :", pool.sqrtPrice.toString());

// base vault balance == full supply (nothing in any wallet)
const vaultInfo = await conn.getTokenAccountBalance(result.baseVault, "confirmed");
console.log("  baseVault balance      :", vaultInfo.value.uiAmount?.toLocaleString(), "(all supply — nothing in a wallet)");

// leftoverReceiver ATA should NOT exist yet
const ata = (await import("@solana/spl-token")).getAssociatedTokenAddressSync;
const receiverAta = ata(result.baseMint, authority.publicKey, true, (await import("../src/index.js")).TOKEN_2022_PROGRAM_ID);
const ataInfo = await conn.getAccountInfo(receiverAta, "confirmed");
console.log("  leftoverReceiver ATA   :", ataInfo ? "EXISTS (unexpected)" : "absent (correct — hidden until withdraw)");

if (!a.fixedTokenSupply || a.supply.leftover === 0n) throw new Error("leftover not armed");
if (vaultInfo.value.uiAmount !== 1e9) throw new Error(`vault balance ${vaultInfo.value.uiAmount} != 1e9`);
console.log("\nE2E PASS");

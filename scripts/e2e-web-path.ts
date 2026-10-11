#!/usr/bin/env bun
/**
 * Headless browser-path proof: same code path as the website (buildLaunchTransaction
 * + partialSign + wallet signAndSendTransaction), against localnet. Phantom is
 * stubbed with a plain Keypair that plays the wallet's two roles: fee payer and
 * final signature. If this passes, the website's only untested part is the
 * Phantom popup itself.
 */
import { Connection, Keypair } from "@solana/web3.js";
import { buildLaunchTransaction, fetchPool, fetchPoolConfig, analyzePoolConfig, analyzeVirtualPool } from "/Users/aaa/Projects/meteora-sdk/src/index.js";

const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const wallet = Keypair.generate(); // plays Phantom
await conn.confirmTransaction(await conn.requestAirdrop(wallet.publicKey, 60e9), "confirmed");

// exactly what main.ts does
const built = await buildLaunchTransaction({
  authority: { publicKey: wallet.publicKey } as any,
  connection: conn,
  name: "Studio Proof",
  symbol: "STPF",
  uri: "https://x.test/p",
  startPrice: 5e-8,
  graduationQuote: 65,
  totalSupply: 1e9,
  decimals: 6,
});

// Stub "Phantom": partial-sign the init-signers, then the wallet signature is
// appended (partialSign on an already-partially-signed tx adds, never clears).
// Real Phantom's signAndSendTransaction produces exactly this signature set.
const tx = built.transaction;
tx.partialSign(...built.signers);
tx.partialSign(wallet);
const raw = tx.serialize();
const sig = await conn.sendRawTransaction(raw, { skipPreflight: false });
await conn.confirmTransaction(sig, "confirmed");
const signature = sig;

console.log("signature:", signature);

// verify like the success screen does
const cfg = await fetchPoolConfig(conn, built.config);
const pool = await fetchPool(conn, built.pool);
if (!cfg || !pool) throw new Error("not found");
const a = analyzePoolConfig(cfg);
const pa = analyzeVirtualPool(pool, cfg);
console.log("fixedSupply:", a.fixedTokenSupply,
  "| leftover:", (Number(a.supply.leftover) / 1e6).toLocaleString(),
  `(${a.supply.leftoverBpsOfSupply / 100}%)`,
  "| fee:", `${a.fee.cliffFeePct}%->${a.fee.finalFeePct}%`,
  "| creator matches wallet:", pool.creator.toBase58() === wallet.publicKey.toBase58(),
  "| progress:", pa.migrationProgressName);
if (!a.fixedTokenSupply) throw new Error("not fixed supply");
if (pool.creator.toBase58() !== wallet.publicKey.toBase58()) throw new Error("creator mismatch");
console.log("\nWEB PATH PASS");

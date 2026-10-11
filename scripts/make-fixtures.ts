#!/usr/bin/env bun
/**
 * Refresh the mainnet fixtures the verify gate asserts against.
 * Run when you want to re-pin to a newer live pool.
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { writeFileSync } from "node:fs";

const RPC = process.env.RPC ?? "https://solana-rpc.publicnode.com";
const conn = new Connection(RPC, "confirmed");

// Inference (inf) — a fixed-supply DBC launch whose dev pulled the leftover and dumped it.
const CONFIG = new PublicKey("68ct2VhcLPtqst8P3UK3ZstFjGgWg4sZ82avB8bRB4Rt");
const POOL = new PublicKey("8NW9q2dpu38FSspM7emjWxzAUxQC3LJD6UcbHPgGpfe8");
const BASE_MINT = new PublicKey("UUiN6UoCBpx4g2KfnH3JXV59AmdXQL3NJLe95eUwinf");
const QUOTE_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const LEFTOVER_TX = "4fdfn3Ea55gnsZsrZLXz82qsESg5QrH32Lfybsg3Lo7fSGCfJTmsAdmZKqA1GqQv5dfQVQGFoTgxMagXSqUuoioA";
const MIGRATION_TX = "3CsoJbfaxzegrL1KV6ULtDeiabrcD4z1jgMDuVSzfE2epZmnRL7JxtJ2JnzKm4Zx2MhZXQPKkhfVgU4iKbN6hoBR";

const cfg = await conn.getAccountInfo(CONFIG);
const pool = await conn.getAccountInfo(POOL);
if (!cfg || !pool) throw new Error("live accounts not found");

/** Pull the Nth top-level instruction's accounts + data out of a tx. */
async function instructionOf(signature: string, index: number) {
  const tx = await conn.getTransaction(signature, {
    maxSupportedTransactionVersion: 1,
    commitment: "confirmed",
  });
  if (!tx) throw new Error(`tx not found: ${signature}`);
  const keys = tx.transaction.message.staticAccountKeys;
  const ix = tx.transaction.message.compiledInstructions[index];
  return {
    signature,
    slot: tx.slot,
    accountKeys: keys.map((k) => k.toBase58()),
    instructionAccounts: (ix.accountKeyIndexes ?? []).map((i) => keys[i].toBase58()),
    data: Buffer.from(ix.data).toString("base64"),
  };
}

const fixture = {
  note: "Meteora DBC mainnet fixtures — Inference (inf), 2026-10-09",
  rpc: RPC,
  config: { address: CONFIG.toBase58(), data: cfg.data.toString("base64") },
  pool: { address: POOL.toBase58(), data: pool.data.toString("base64") },
  baseMint: BASE_MINT.toBase58(),
  quoteMint: QUOTE_MINT.toBase58(),
  withdrawLeftoverTx: await instructionOf(LEFTOVER_TX, 1),
  migrationDammV2Tx: await instructionOf(MIGRATION_TX, 0),
};

writeFileSync(new URL("./fixtures/mainnet.json", import.meta.url), JSON.stringify(fixture, null, 1));
console.log("wrote fixtures/mainnet.json");
console.log("withdraw_leftover accounts:", fixture.withdrawLeftoverTx.instructionAccounts.length);
console.log("migration_damm_v2 accounts:", fixture.migrationDammV2Tx.instructionAccounts.length);
console.log("migration_damm_v2 data:", fixture.migrationDammV2Tx.data);

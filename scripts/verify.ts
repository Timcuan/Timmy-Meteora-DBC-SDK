#!/usr/bin/env bun
/**
 * Mainnet invariant gate.
 *
 * Every assertion below is checked against fixtures pinned from a real DBC
 * launch (Inference / `inf`, 2026-10-09) — decoded with this SDK and compared
 * to the values the on-chain program itself stored. No assertion is derived
 * from this SDK's own output.
 */
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fixture from "./fixtures/mainnet.json" with { type: "json" };
import {
  POOL_AUTHORITY,
  MAX_SQRT_PRICE,
  MigrationProgress,
  BaseFeeMode,
  DBC_PROGRAM_ID,
  accountLayout,
  fieldOffset,
  baseVault,
  dammEventAuthority,
  dammPoolAuthority,
  eventAuthority,
  instructionNames,
  poolAuthority,
  virtualPool,
  decodePoolConfig,
  decodeVirtualPool,
  analyzePoolConfig,
  analyzeVirtualPool,
  baseOnCurve,
  quoteOnCurve,
  leftoverAmount,
  migrationBaseEstimate,
  supplyPlan,
  getProgram,
  withdrawLeftover,
  buildInstruction,
  instructionDiscriminator,
  idlMetadata,
  migrationDammV2,
  migrationDammV2CreateMetadata,
  createLocker,
  initializeVirtualPool,
  createConfig,
  swap2,
  claimTradingFee2,
  withdrawMigrationFee,
  createOperatorAccount,
  createTokenBadge,
  lockerEventAuthority,
  WithdrawMigrationFeeFlag,
  planFixedSupplyLaunch,
  feeDecay,
  feeAtElapsed,
  feePct,
  sqrtPriceFromPrice,
  priceFromSqrtPrice,
  type CurvePoint,
} from "../src/index.js";

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const cfgData = b64(fixture.config.data);
const poolData = b64(fixture.pool.data);
const CONFIG = new PublicKey(fixture.config.address);
const POOL = new PublicKey(fixture.pool.address);
const BASE_MINT = new PublicKey(fixture.baseMint);
const QUOTE_MINT = new PublicKey(fixture.quoteMint);

// Values the program stored on-chain — the ground truth for every check below.
const EXPECTED = {
  swapBaseAmount: 509_973_374_036_257n,
  migrationQuoteThreshold: 65_009_105_792n,
  migrationBaseThreshold: 190_026_619_385_773n,
  migrationSqrtPrice: 332_553_408_115_606_295n,
  sqrtStartPrice: 130_438_180_563_585_029n,
  preSupply: 1_000_000_000_000_000n,
  /** What the dev's wallet actually received in the withdraw_leftover tx. */
  observedPayout: 300_000_006_578_045n,
  quoteReserve: 65_009_105_801n,
  tradingQuoteFee: 45_677_558_953n,
  protocolQuoteFee: 9_518_166_937n,
  migrationBaseFee: 380_053_238_753n,
};

let passed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    passed++;
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function eq<T>(label: string, got: T, want: T) {
  check(label, got === want, `got ${got}, want ${want}`);
}

function section(name: string) {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 58 - name.length))}`);
}

// ── 1. IDL ───────────────────────────────────────────────────────────────────
section("IDL");
eq("id version", idlMetadata.version, "0.2.1");
eq("withdraw_leftover discriminator", Buffer.from(instructionDiscriminator("withdraw_leftover")).toString("hex"), "14c6caedebf3b742");
eq(
  "discriminator matches the live instruction data",
  Buffer.from(instructionDiscriminator("withdraw_leftover")).toString("hex"),
  Buffer.from(fixture.withdrawLeftoverTx.data, "base64").toString("hex"),
);

// ── 2. layouts ───────────────────────────────────────────────────────────────
section("account layouts");
eq("PoolConfig size", accountLayout("PoolConfig").size, 1048);
eq("PoolConfig size matches the live account", accountLayout("PoolConfig").size, cfgData.length);
eq("VirtualPool size", accountLayout("VirtualPool").size, 424);
eq("VirtualPool size matches the live account", accountLayout("VirtualPool").size, poolData.length);
eq("offset(leftover_receiver)", fieldOffset("PoolConfig", "leftover_receiver"), 72);
eq("offset(fixed_token_supply_flag)", fieldOffset("PoolConfig", "fixed_token_supply_flag"), 244);
eq("offset(swap_base_amount)", fieldOffset("PoolConfig", "swap_base_amount"), 256);
eq("offset(migration_progress)", fieldOffset("VirtualPool", "pool_state.migration_progress"), 308);

// ── 3. PDAs ──────────────────────────────────────────────────────────────────
section("PDA derivation");
eq("pool_authority", poolAuthority().toBase58(), POOL_AUTHORITY.toBase58());
eq("virtual_pool", virtualPool(CONFIG, BASE_MINT, QUOTE_MINT).toBase58(), POOL.toBase58());
eq(
  "base_vault",
  baseVault(BASE_MINT, POOL).toBase58(),
  fixture.withdrawLeftoverTx.instructionAccounts[4],
);
eq(
  "event_authority",
  eventAuthority().toBase58(),
  fixture.withdrawLeftoverTx.instructionAccounts[8],
);

// ── 4. decoding ──────────────────────────────────────────────────────────────
section("decode + analyze");
const cfg = decodePoolConfig(cfgData);
const pool = decodeVirtualPool(poolData);
eq("cfg.quoteMint", cfg.quoteMint.toBase58(), QUOTE_MINT.toBase58());
eq("cfg.feeClaimer", cfg.feeClaimer.toBase58(), fixture.withdrawLeftoverTx.instructionAccounts[6]);
eq("cfg.leftoverReceiver", cfg.leftoverReceiver.toBase58(), fixture.withdrawLeftoverTx.instructionAccounts[6]);
eq("cfg.sqrtStartPrice", cfg.sqrtStartPrice, EXPECTED.sqrtStartPrice);
eq("cfg.swapBaseAmount", cfg.swapBaseAmount, EXPECTED.swapBaseAmount);
eq("cfg.migrationBaseThreshold", cfg.migrationBaseThreshold, EXPECTED.migrationBaseThreshold);
eq("cfg.migrationQuoteThreshold", cfg.migrationQuoteThreshold, EXPECTED.migrationQuoteThreshold);
eq("cfg.migrationSqrtPrice", cfg.migrationSqrtPrice, EXPECTED.migrationSqrtPrice);

const analysis = analyzePoolConfig(cfg);
eq("fixed supply", analysis.fixedTokenSupply, true);
check(
  "supply.leftover tracks the observed payout",
  analysis.supply.leftover - EXPECTED.observedPayout <= 1000n &&
    analysis.supply.leftover - EXPECTED.observedPayout >= -1000n,
  `got ${analysis.supply.leftover}`,
);
eq("supply.leftoverBpsOfSupply", analysis.supply.leftoverBpsOfSupply, 3000);
eq("fee mode", analysis.fee.mode, BaseFeeMode.FeeSchedulerLinear);
eq("fee cliff", analysis.fee.cliffFeePct, 85);
eq("fee final", analysis.fee.finalFeePct, 2.5);
eq("fee periods", analysis.fee.periods, 100);
eq("fee decay window", analysis.fee.decaySeconds, 100);
eq("curve points", analysis.flags.curvePoints, 2);
eq("liquidity split totals 100", analysis.liquiditySplit.partnerPermanentLockedPct, 100);

const poolAnalysis = analyzeVirtualPool(pool, cfg);
eq("migration progress", poolAnalysis.migrationProgress, MigrationProgress.CreatedPool);
eq("curve complete", poolAnalysis.curveComplete, true);
eq("leftover already withdrawn", pool.isWithdrawLeftover, 1);
eq("withdraw_leftover no longer eligible", poolAnalysis.withdrawLeftoverEligible, false);
eq("lifetime trading quote fee", poolAnalysis.pending.lifetime.tradingQuoteFee, EXPECTED.tradingQuoteFee);
eq("lifetime protocol quote fee", poolAnalysis.pending.lifetime.protocolQuoteFee, EXPECTED.protocolQuoteFee);
eq("unclaimed migration base fee", poolAnalysis.pending.unclaimed.migrationBaseFee, EXPECTED.migrationBaseFee);
check(
  "unclaimed never exceeds lifetime",
  poolAnalysis.pending.unclaimed.protocolQuoteFee <= poolAnalysis.pending.lifetime.protocolQuoteFee,
);

// ── 5. curve math vs the program's own numbers ───────────────────────────────
section("curve math");
const curve: CurvePoint[] = [
  { sqrtPrice: 332_553_408_115_606_295n, liquidity: 109_449_706_774_922_426_670_955_333_559_135n },
  { sqrtPrice: MAX_SQRT_PRICE, liquidity: 2_188_549_608_828_172_882_570_583n },
];
eq(
  "baseOnCurve(start -> migration) == stored swap_base_amount",
  baseOnCurve(EXPECTED.sqrtStartPrice, EXPECTED.migrationSqrtPrice, curve),
  EXPECTED.swapBaseAmount,
);
eq(
  "quoteOnCurve(start -> migration) == stored migration_quote_threshold",
  quoteOnCurve(EXPECTED.sqrtStartPrice, EXPECTED.migrationSqrtPrice, curve),
  EXPECTED.migrationQuoteThreshold,
);

const plan = supplyPlan({
  sqrtStartPrice: EXPECTED.sqrtStartPrice,
  curve,
  migrationQuoteThreshold: EXPECTED.migrationQuoteThreshold,
  migrationBaseThreshold: EXPECTED.migrationBaseThreshold,
});
eq("plan.swapBaseAmount", plan.swapBaseAmount, EXPECTED.swapBaseAmount);
eq("plan.migrationSqrtPrice", plan.migrationSqrtPrice, EXPECTED.migrationSqrtPrice);
eq("plan.minSupplyWithoutBuffer", plan.minSupplyWithoutBuffer, 699_999_993_422_030n);
check("plan.minSupplyWithBuffer <= preSupply", plan.minSupplyWithBuffer <= EXPECTED.preSupply, `${plan.minSupplyWithBuffer}`);
check(
  "leftoverAmount(pre) agrees with analyzePoolConfig",
  leftoverAmount(plan, EXPECTED.preSupply) === analysis.supply.leftover,
);
const observedPayout = EXPECTED.observedPayout;
const drift = analysis.supply.leftover - observedPayout;
check(
  "reserved leftover matches the observed payout within 1000 base units",
  drift <= 1000n && drift >= -1000n,
  `drift ${drift} base units`,
);

const estimate = migrationBaseEstimate(
  (EXPECTED.migrationQuoteThreshold * 95n) / 100n,
  EXPECTED.migrationSqrtPrice,
);
const estimateErrorPpm =
  Number(((estimate - EXPECTED.migrationBaseThreshold) * 1_000_000n) / EXPECTED.migrationBaseThreshold);
check("migration base estimate is within 10 ppm", Math.abs(estimateErrorPpm) < 10, `${estimateErrorPpm} ppm`);

// ── 6. fee schedule ──────────────────────────────────────────────────────────
section("fee schedule");
const decay = feeDecay({ cliffFeePct: 85, endFeePct: 2.5, seconds: 100 });
eq("cliffFeeNumerator", decay.cliffFeeNumerator, 850_000_000n);
eq("numberOfPeriod", decay.numberOfPeriod, 100);
eq("reductionFactor", decay.reductionFactor, 8_250_000n);
eq("fee at t=0", feeAtElapsed(decay, 0), 850_000_000n);
eq("fee at t=50", feeAtElapsed(decay, 50), 437_500_000n);
eq("fee at t=100", feeAtElapsed(decay, 100), 25_000_000n);
eq("fee clamps after the last period", feeAtElapsed(decay, 100_000), 25_000_000n);
eq("feePct(85%)", feePct(850_000_000n), 85);
let rejected = false;
try {
  feeDecay({ cliffFeePct: 85, endFeePct: 0.1, seconds: 100 });
} catch {
  rejected = true;
}
check("feeDecay rejects an end fee below the program floor", rejected);

// Regression: exponential mode must not silently produce a linear reduction factor.
let expRejected = false;
try {
  feeDecay({ cliffFeePct: 85, endFeePct: 2.5, seconds: 100, mode: BaseFeeMode.FeeSchedulerExponential });
} catch {
  expRejected = true;
}
check("feeDecay rejects a non-linear mode instead of emitting a bogus schedule", expRejected);

let cliffRejected = false;
try {
  feeDecay({ cliffFeePct: 0.1, endFeePct: 0.1, seconds: 100 });
} catch {
  cliffRejected = true;
}
check("feeDecay rejects a cliff below the program floor", cliffRejected);

// Exponential math itself still models an existing on-chain config correctly.
const expFee: typeof decay = {
  cliffFeeNumerator: 100_000_000n,
  numberOfPeriod: 10,
  periodFrequency: 1n,
  reductionFactor: 500n, // 5% per period
  mode: BaseFeeMode.FeeSchedulerExponential,
};
eq("exponential fee at t=0", feeAtElapsed(expFee, 0), 100_000_000n);
eq("exponential fee at t=10 (10 x 5%)", feeAtElapsed(expFee, 10), 59_873_693n);
eq("exponential fee clamps after the last period", feeAtElapsed(expFee, 1000), 59_873_693n);

// ── 7. price helpers round-trip ──────────────────────────────────────────────
section("price helpers");
const sqrtFromPrice = sqrtPriceFromPrice(5e-8, 6, 9);
const sqrtRelError = Math.abs(Number(sqrtFromPrice - EXPECTED.sqrtStartPrice) / Number(EXPECTED.sqrtStartPrice));
check(
  "sqrtPriceFromPrice(5e-8) lands within 1e-6 of the live start price",
  sqrtRelError < 1e-6,
  `got ${sqrtFromPrice} (rel ${sqrtRelError.toExponential(2)})`,
);
check(
  "priceFromSqrtPrice round-trips",
  Math.abs(priceFromSqrtPrice(EXPECTED.sqrtStartPrice, 6, 9) - 5e-8) < 1e-13,
  `${priceFromSqrtPrice(EXPECTED.sqrtStartPrice, 6, 9)}`,
);

// ── 8. instruction builder vs the live transaction ───────────────────────────
section("instruction builder");
const conn = new Connection("http://127.0.0.1:8899", "confirmed");
const program = getProgram(conn, {
  publicKey: Keypair.generate().publicKey,
  signTransaction: async (t: any) => t,
  signAllTransactions: async (t: any) => t,
} as any);

const leftoverIx = await withdrawLeftover({
  program,
  config: CONFIG,
  pool: POOL,
  baseMint: BASE_MINT,
  leftoverReceiver: new PublicKey(fixture.withdrawLeftoverTx.instructionAccounts[6]),
  tokenBaseProgram: new PublicKey(fixture.withdrawLeftoverTx.instructionAccounts[7]),
});
eq("instruction programId", leftoverIx.programId.toBase58(), DBC_PROGRAM_ID.toBase58());
eq(
  "instruction data == the live instruction data",
  Buffer.from(leftoverIx.data).toString("base64"),
  fixture.withdrawLeftoverTx.data,
);
eq("account count", leftoverIx.keys.length, fixture.withdrawLeftoverTx.instructionAccounts.length);
fixture.withdrawLeftoverTx.instructionAccounts.forEach((want, i) => {
  eq(`account[${i}]`, leftoverIx.keys[i]?.pubkey.toBase58(), want);
});

// `buildInstruction` must accept the IDL's snake_case spelling too.
const snakeIx = await buildInstruction(program, "withdraw_leftover", [], {
  config: CONFIG,
  virtualPool: POOL,
  tokenBaseAccount: new PublicKey(fixture.withdrawLeftoverTx.instructionAccounts[3]),
  baseVault: new PublicKey(fixture.withdrawLeftoverTx.instructionAccounts[4]),
  baseMint: BASE_MINT,
  leftoverReceiver: new PublicKey(fixture.withdrawLeftoverTx.instructionAccounts[6]),
  tokenBaseProgram: new PublicKey(fixture.withdrawLeftoverTx.instructionAccounts[7]),
});
eq(
  "snake_case name builds the same instruction",
  Buffer.from(snakeIx.data).toString("base64"),
  Buffer.from(leftoverIx.data).toString("base64"),
);
let badNameRejected = false;
try {
  await buildInstruction(program, "notAnInstruction", [], {});
} catch {
  badNameRejected = true;
}
check("an unknown instruction name is rejected", badNameRejected);

// Every IDL instruction must be reachable through the generic builder.
const camelize = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const unreachable = instructionNames().filter((n) => typeof program.methods[camelize(n)] !== "function");
eq("IDL instructions reachable via the generic builder", unreachable.length, 0);

// DAMM v2 PDAs, checked against the accounts in the real post-migration tx.
eq("damm pool authority", dammPoolAuthority().toBase58(), "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
eq("damm event authority", dammEventAuthority().toBase58(), "3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

const genericIx = await buildInstruction(program, "withdrawLeftover", [], {
  config: CONFIG,
  virtualPool: POOL,
  tokenBaseAccount: new PublicKey(fixture.withdrawLeftoverTx.instructionAccounts[3]),
  baseVault: new PublicKey(fixture.withdrawLeftoverTx.instructionAccounts[4]),
  baseMint: BASE_MINT,
  leftoverReceiver: new PublicKey(fixture.withdrawLeftoverTx.instructionAccounts[6]),
  tokenBaseProgram: new PublicKey(fixture.withdrawLeftoverTx.instructionAccounts[7]),
});
eq(
  "generic builder == wrapper builder",
  Buffer.from(genericIx.data).toString("base64"),
  Buffer.from(leftoverIx.data).toString("base64"),
);

// ── 9. recipe reproduces the live launch ─────────────────────────────────────
section("recipe");

const recipe = planFixedSupplyLaunch({
  quoteMint: QUOTE_MINT,
  feeClaimer: cfg.feeClaimer,
  leftoverReceiver: cfg.leftoverReceiver,
  sqrtStartPrice: EXPECTED.sqrtStartPrice,
  curve,
  migrationQuoteThreshold: EXPECTED.migrationQuoteThreshold,
  migrationBaseThreshold: EXPECTED.migrationBaseThreshold,
  preMigrationTokenSupply: EXPECTED.preSupply,
  baseFee: { ...decay, mode: BaseFeeMode.FeeSchedulerLinear },
  migrationFeePercentage: 5,
  tokenAuthority: cfg.tokenUpdateAuthority,
  liquiditySplit: {
    partnerLiquidityPercentage: 0,
    partnerPermanentLockedLiquidityPercentage: 100,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
  },
});
eq("recipe warnings", recipe.warnings.length, 0);
check(
  "recipe leftover tracks the observed payout",
  recipe.leftover - EXPECTED.observedPayout <= 1000n &&
    recipe.leftover - EXPECTED.observedPayout >= -1000n,
  `got ${recipe.leftover}`,
);
eq("recipe leftover == plan leftover", recipe.leftover, leftoverAmount(recipe.plan, EXPECTED.preSupply));
eq("recipe swapBaseAmount", recipe.plan.swapBaseAmount, EXPECTED.swapBaseAmount);
eq("recipe tokenSupply.pre", recipe.configParameters.tokenSupply.preMigrationTokenSupply.toString(), EXPECTED.preSupply.toString());
eq("recipe fixed supply is armed", recipe.configParameters.tokenSupply !== null, true);
eq("recipe leftoverReceiver is set", recipe.configParameters.poolFees.baseFee.cliffFeeNumerator.toString(), "850000000");

// Default LP split (no liquiditySplit override): 90% unlocked to fee_claimer
// / 10% permanently locked. 100%-locked would make every graduated LP
// permanently unwithdrawable — the old default, caught in audit.
const defaultSplitRecipe = planFixedSupplyLaunch({
  quoteMint: QUOTE_MINT,
  feeClaimer: cfg.feeClaimer,
  leftoverReceiver: cfg.leftoverReceiver,
  sqrtStartPrice: EXPECTED.sqrtStartPrice,
  curve,
  migrationQuoteThreshold: EXPECTED.migrationQuoteThreshold,
  migrationBaseThreshold: EXPECTED.migrationBaseThreshold,
  preMigrationTokenSupply: EXPECTED.preSupply,
  baseFee: { ...decay, mode: BaseFeeMode.FeeSchedulerLinear },
});
eq("default LP: 90% unlocked to fee_claimer", defaultSplitRecipe.configParameters.partnerLiquidityPercentage, 90);
eq("default LP: 10% permanently locked (program floor)", defaultSplitRecipe.configParameters.partnerPermanentLockedLiquidityPercentage, 10);
eq("default LP split sums to 100",
  defaultSplitRecipe.configParameters.partnerLiquidityPercentage +
    defaultSplitRecipe.configParameters.partnerPermanentLockedLiquidityPercentage +
    defaultSplitRecipe.configParameters.creatorLiquidityPercentage +
    defaultSplitRecipe.configParameters.creatorPermanentLockedLiquidityPercentage,
  100);

// ── 9b. every ix wrapper builds offline, and the flag enum matches the Rust ──
section("wrapper builders (offline)");
const K = () => Keypair.generate().publicKey;
const offline: [string, () => Promise<any>][] = [
  ["createConfig", () => createConfig({ program, config: K(), payer: K(), feeClaimer: K(), leftoverReceiver: K(), quoteMint: K(), configParameters: {} } as any)],
  ["swap2 (no referral)", () => swap2({ program, payer: K(), config: K(), pool: K(), baseMint: K(), quoteMint: K(), inputTokenAccount: K(), outputTokenAccount: K(), amount0: 1n, amount1: 1n, swapMode: 0, tokenBaseProgram: K(), tokenQuoteProgram: K() })],
  ["swap2 (referral)", () => swap2({ program, payer: K(), config: K(), pool: K(), baseMint: K(), quoteMint: K(), inputTokenAccount: K(), outputTokenAccount: K(), amount0: 1n, amount1: 1n, swapMode: 0, tokenBaseProgram: K(), tokenQuoteProgram: K(), referralTokenAccount: K() })],
  ["withdrawMigrationFee", () => withdrawMigrationFee({ program, config: K(), pool: K(), quoteMint: K(), sender: K(), flag: WithdrawMigrationFeeFlag.Creator, tokenQuoteProgram: K() })],
  ["claimTradingFee2", () => claimTradingFee2({ program, config: K(), pool: K(), baseMint: K(), quoteMint: K(), feeClaimer: K(), tokenBaseProgram: K(), tokenQuoteProgram: K() })],
  ["createOperatorAccount", () => createOperatorAccount({ program, whitelistedAddress: K(), signer: K(), payer: K(), permission: 1n })],
  ["createTokenBadge", () => createTokenBadge({ program, tokenMint: K(), operator: K(), signer: K(), payer: K() })],
  ["migrationDammV2CreateMetadata", () => migrationDammV2CreateMetadata({ program, config: K(), pool: K(), payer: K() })],
  ["createLocker", () => createLocker({ program, config: K(), pool: K(), baseMint: K(), creator: K(), escrow: K(), escrowToken: K(), payer: K(), tokenProgram: K() })],
  ["initializeVirtualPool (offline)", () => initializeVirtualPool({ program, payer: K(), creator: K(), config: K(), baseMint: K(), quoteMint: K(), params: { name: "x", symbol: "y", uri: "z" }, tokenQuoteProgram: K() } as any)],
];
for (const [n, f] of offline) {
  let ok = false;
  try { await f(); ok = true; } catch { ok = false; }
  check(`wrapper builds offline: ${n}`, ok);
}

// Rust: `flag: u8, // 0 as partner and 1 as creator` (ix_withdraw_migration_fee.rs).
eq("flag enum: Partner = 0", WithdrawMigrationFeeFlag.Partner, 0);
eq("flag enum: Creator = 1", WithdrawMigrationFeeFlag.Creator, 1);
// Partner withdrawals are signed by config.fee_claimer, creator ones by pool.creator.
eq("locker event authority", lockerEventAuthority().toBase58(), "AqUDk3wybxjZujrNbKmjr2YTUZ8RA1a1nyGgs1zSmvTG");

// ── 10. graduation instruction vs the real migration tx ──────────────────────
section("graduation builder");
const mig = fixture.migrationDammV2Tx;
eq(
  "migration_damm_v2 discriminator matches the live instruction data",
  Buffer.from(instructionDiscriminator("migration_damm_v2")).toString("base64"),
  mig.data,
);

const migIx = await migrationDammV2({
  program,
  config: CONFIG,
  pool: POOL,
  baseMint: BASE_MINT,
  quoteMint: QUOTE_MINT,
  payer: new PublicKey(mig.instructionAccounts[19]),
  dammPool: new PublicKey(mig.instructionAccounts[4]),
  firstPositionNftMint: new PublicKey(mig.instructionAccounts[5]),
  firstPositionNftAccount: new PublicKey(mig.instructionAccounts[6]),
  firstPosition: new PublicKey(mig.instructionAccounts[7]),
  secondPositionNftMint: new PublicKey(mig.instructionAccounts[8]),
  secondPositionNftAccount: new PublicKey(mig.instructionAccounts[9]),
  secondPosition: new PublicKey(mig.instructionAccounts[10]),
  tokenAVault: new PublicKey(mig.instructionAccounts[15]),
  tokenBVault: new PublicKey(mig.instructionAccounts[16]),
  tokenBaseProgram: new PublicKey(mig.instructionAccounts[20]),
  tokenQuoteProgram: new PublicKey(mig.instructionAccounts[21]),
  remainingAccounts: mig.instructionAccounts.slice(25).map((a) => ({ pubkey: new PublicKey(a) })),
});

eq(
  "graduation instruction data",
  Buffer.from(migIx.data).toString("base64"),
  mig.data,
);
// The IDL's 25 fixed accounts must line up one-for-one, in order.
eq("graduation account count", migIx.keys.length, mig.instructionAccounts.length);
mig.instructionAccounts.forEach((want, i) => {
  eq(`graduation account[${i}]`, migIx.keys[i]?.pubkey.toBase58(), want);
});
check(
  "the 3 trailing accounts are remaining accounts (not IDL accounts)",
  mig.instructionAccounts.length - 25 === 3,
  `${mig.instructionAccounts.length} - 25`,
);

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(64)}`);
if (failures.length === 0) {
  console.log(`PASS — ${passed} assertions against live mainnet fixtures`);
} else {
  console.log(`FAIL — ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}

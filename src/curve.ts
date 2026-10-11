import { MAX_CURVE_POINT, MAX_SQRT_PRICE, SWAP_BUFFER_PERCENTAGE } from "./constants.js";

/**
 * Exact integer re-implementation of DBC's curve math (curve.rs / liquidity_distribution.rs).
 *
 * Conventions, all bigint and all floor unless stated:
 *   √P          Q64.64 sqrt price of the raw quote/base ratio
 *   L           liquidity, same scale as the config's `curve[i].liquidity`
 *   Δbase  = L·(√Pu − √Pl) / (√Pu·√Pl)      round **up** in the program
 *   Δquote = L·(√Pu − √Pl) / 2^128          round **up** in the program
 *   price(raw) = (√P / 2^64)² ;  price(human) = price(raw)·10^(baseDec − quoteDec)
 */

export const Q64 = 1n << 64n;
export const Q128 = 1n << 128n;

/**
 * Whole-token human amount → raw base units at `decimals`.
 * Uses the ×1000-then-divide trick so 3-decimal human input survives exactly
 * (e.g. `totalSupply: 999.999`), matching how every recipe converts.
 */
export const toRawUnits = (whole: number, decimals: number): bigint =>
  (BigInt(Math.round(whole * 1000)) * 10n ** BigInt(decimals)) / 1000n;

export interface CurvePoint {
  sqrtPrice: bigint;
  liquidity: bigint;
}

export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n < 2n) return n;
  let x = 1n << (BigInt(n.toString(2).length) / 2n + 1n);
  for (let i = 0; i < 128; i++) {
    const y = (x + n / x) >> 1n;
    if (y >= x) break;
    x = y;
  }
  return x;
}

const divUp = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Δbase for a single segment. `up` matches the program's Rounding::Up. */
export function deltaBase(pl: bigint, pu: bigint, L: bigint, up = true): bigint {
  const num = L * (pu - pl);
  const den = pl * pu;
  return up ? divUp(num, den) : num / den;
}

/** Δquote for a single segment. `up` matches the program's Rounding::Up. */
export function deltaQuote(pl: bigint, pu: bigint, L: bigint, up = true): bigint {
  const num = L * (pu - pl);
  return up ? divUp(num, Q128) : num / Q128;
}

/** √P' = √P + amount·2^128 / L — the program rounds this one down. */
export function nextSqrtPriceFromQuoteIn(pl: bigint, L: bigint, amount: bigint): bigint {
  return pl + (amount * Q128) / L;
}

/** Base tokens released when the price walks `sqrtStart -> sqrtEnd` across the curve. */
export function baseOnCurve(sqrtStart: bigint, sqrtEnd: bigint, curve: CurvePoint[]): bigint {
  let total = 0n;
  for (let i = 0; i < curve.length; i++) {
    const lower = i === 0 ? sqrtStart : curve[i - 1].sqrtPrice;
    if (curve[i].sqrtPrice > sqrtEnd) {
      total += deltaBase(lower, sqrtEnd, curve[i].liquidity);
      break;
    }
    total += deltaBase(lower, curve[i].sqrtPrice, curve[i].liquidity);
  }
  return total;
}

/** Quote tokens absorbed when the price walks `sqrtStart -> sqrtEnd`. */
export function quoteOnCurve(sqrtStart: bigint, sqrtEnd: bigint, curve: CurvePoint[]): bigint {
  let total = 0n;
  for (let i = 0; i < curve.length; i++) {
    const lower = i === 0 ? sqrtStart : curve[i - 1].sqrtPrice;
    if (curve[i].sqrtPrice > sqrtEnd) {
      total += deltaQuote(lower, sqrtEnd, curve[i].liquidity);
      break;
    }
    total += deltaQuote(lower, curve[i].sqrtPrice, curve[i].liquidity);
  }
  return total;
}

/** The price at which cumulative quote intake equals the migration threshold. */
export function migrationSqrtPrice(
  migrationQuoteThreshold: bigint,
  sqrtStart: bigint,
  curve: CurvePoint[],
): bigint {
  let next = sqrtStart;
  let left = migrationQuoteThreshold;

  for (let i = 0; i < curve.length; i++) {
    const segQuote = deltaQuote(next, curve[i].sqrtPrice, curve[i].liquidity);
    if (segQuote > left) {
      return nextSqrtPriceFromQuoteIn(next, curve[i].liquidity, left);
    }
    left -= segQuote;
    next = curve[i].sqrtPrice;
  }
  throw new Error("curve does not hold enough liquidity for this quote threshold");
}

/** L required to release `baseAmount` across [pl, pu]. */
export function liquidityForBaseAmount(pl: bigint, pu: bigint, baseAmount: bigint): bigint {
  return (baseAmount * pl * pu) / (pu - pl);
}

/**
 * `get_swap_amount_with_buffer`: swap amount + 25% buffer, capped at everything
 * the curve can release between the start price and MAX_SQRT_PRICE.
 */
export function swapAmountWithBuffer(
  swapBaseAmount: bigint,
  sqrtStartPrice: bigint,
  curve: CurvePoint[],
): bigint {
  const buffered = (swapBaseAmount * (100n + SWAP_BUFFER_PERCENTAGE)) / 100n;
  const maxOnCurve = baseOnCurve(sqrtStartPrice, MAX_SQRT_PRICE, curve);
  return buffered < maxOnCurve ? buffered : maxOnCurve;
}

export interface SupplyPlan {
  swapBaseAmount: bigint;
  migrationBaseThreshold: bigint;
  /** True when `migrationBaseThreshold` is the local estimate, not a value read off-chain. */
  migrationBaseEstimated: boolean;
  lockedVesting: bigint;
  migrationSqrtPrice: bigint;
  maxBaseOnCurve: bigint;
  /** Program's floor for `postMigrationTokenSupply` (no buffer). */
  minSupplyWithoutBuffer: bigint;
  /** Program's floor for `preMigrationTokenSupply` (with 25% buffer). */
  minSupplyWithBuffer: bigint;
}

/**
 * Base tokens a migrated DAMM v2 pool needs for `quoteAmount` at `migrationSqrtPrice`.
 *
 * This is an estimate: the program routes it through the migration-fee handler,
 * which splits the protocol's 0.2% liquidity fee, so the on-chain value lands a
 * few ppm away. Pass the real value (read from a live config) when you have it.
 */
export function migrationBaseEstimate(quoteAmount: bigint, migrationSqrtPrice: bigint): bigint {
  return (quoteAmount * Q128) / (migrationSqrtPrice * migrationSqrtPrice);
}

/**
 * Everything `create_config` derives, so a launch can be preflighted offline
 * instead of reverting on-chain with `InvalidTokenSupply`.
 *
 * `swapBaseAmount`, `migrationSqrtPrice` and the quote walk are exact; the
 * migration base threshold is exact only when supplied.
 */
export function supplyPlan(params: {
  sqrtStartPrice: bigint;
  curve: CurvePoint[];
  migrationQuoteThreshold: bigint;
  lockedVesting?: bigint;
  migrationBaseThreshold?: bigint;
  migrationFeePercentage?: number;
}): SupplyPlan {
  const { sqrtStartPrice, curve, migrationQuoteThreshold } = params;
  const lockedVesting = params.lockedVesting ?? 0n;
  if (curve.length === 0 || curve.length > MAX_CURVE_POINT) {
    throw new Error(`curve must have 1..${MAX_CURVE_POINT} points, got ${curve.length}`);
  }
  const sqrtMig = migrationSqrtPrice(migrationQuoteThreshold, sqrtStartPrice, curve);
  const swapBaseAmount = baseOnCurve(sqrtStartPrice, sqrtMig, curve);

  const feePct = BigInt(params.migrationFeePercentage ?? 0);
  const quoteExcluded = (migrationQuoteThreshold * (100n - feePct)) / 100n;
  const migrationBaseThreshold =
    params.migrationBaseThreshold ?? migrationBaseEstimate(quoteExcluded, sqrtMig);

  const buffered = swapAmountWithBuffer(swapBaseAmount, sqrtStartPrice, curve);
  return {
    swapBaseAmount,
    migrationBaseThreshold,
    migrationBaseEstimated: params.migrationBaseThreshold === undefined,
    lockedVesting,
    migrationSqrtPrice: sqrtMig,
    maxBaseOnCurve: baseOnCurve(sqrtStartPrice, MAX_SQRT_PRICE, curve),
    minSupplyWithoutBuffer: swapBaseAmount + migrationBaseThreshold + lockedVesting,
    minSupplyWithBuffer: buffered + migrationBaseThreshold + lockedVesting,
  };
}

/** Base tokens the vault will hand to `leftover_receiver` — fixed-supply configs only. */
export function leftoverAmount(plan: SupplyPlan, preMigrationTokenSupply: bigint): bigint {
  const consumed = plan.swapBaseAmount + plan.migrationBaseThreshold + plan.lockedVesting;
  const leftover = preMigrationTokenSupply - consumed;
  return leftover > 0n ? leftover : 0n;
}

// ── price helpers ────────────────────────────────────────────────────────────

/** √P from a raw quote/base ratio expressed as a bigint fraction. */
export function sqrtPriceFromRawRatio(numerator: bigint, denominator: bigint): bigint {
  return isqrt((numerator * Q128) / denominator);
}

/** √P from a human price (quote per whole base token). */
export function sqrtPriceFromPrice(
  price: number,
  baseDecimals: number,
  quoteDecimals: number,
): bigint {
  const scale = 10n ** BigInt(Math.abs(quoteDecimals - baseDecimals));
  const SCALE = 10n ** 12n; // keep float noise out of the integer path
  const scaled = BigInt(Math.round(price * Number(SCALE)));
  const numerator = quoteDecimals >= baseDecimals ? scaled * scale : scaled;
  const denominator = quoteDecimals >= baseDecimals ? SCALE : SCALE * scale;
  return sqrtPriceFromRawRatio(numerator, denominator);
}

/** Human price (quote per whole base token) from a √P. */
export function priceFromSqrtPrice(
  sqrtPrice: bigint,
  baseDecimals: number,
  quoteDecimals: number,
): number {
  const raw = Number((sqrtPrice * sqrtPrice * 10n ** 18n) / Q128) / 1e18;
  return raw * Math.pow(10, baseDecimals - quoteDecimals);
}

/** Raw (quote-base-units) ratio — no decimal adjustment. */
export function rawPriceFromSqrtPrice(sqrtPrice: bigint): number {
  return Number((sqrtPrice * sqrtPrice * 10n ** 18n) / Q128) / 1e18;
}

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  ActivationType,
  BASIS_POINT_MAX,
  BaseFeeMode,
  CollectFeeMode,
  FEE_DENOMINATOR,
  MIN_FEE_NUMERATOR,
  MigrationFeeOption,
  MigrationOption,
  MigratedCollectFeeMode,
  TokenAuthorityOption,
  TokenType,
} from "../constants.js";
import {
  leftoverAmount,
  supplyPlan,
  type CurvePoint,
  type SupplyPlan,
} from "../curve.js";

/**
 * Fixed-supply config recipe.
 *
 * A fixed-supply (`token_supply` present) config makes the program hold back
 * `preMigration − swap − migrationThreshold − lockedVesting` base tokens and pay
 * them to `leftover_receiver` via `withdraw_leftover` once the curve graduates.
 * Those tokens never sit in a wallet while the curve is running, so holder/dev
 * distribution scans see only the on-curve float.
 *
 * Everything here is preflightable offline: `planFixedSupplyLaunch` returns the
 * exact numbers the program will derive, plus the floors it enforces.
 */

export interface FeeDecay {
  /** Starting fee, ppm of 1e9 (85% = 850_000_000). */
  cliffFeeNumerator: bigint;
  /** number_of_period, u16 */
  numberOfPeriod: number;
  /** period_frequency — points (seconds or slots) per period. */
  periodFrequency: bigint;
  /** reduction_factor per period, in numerator units. */
  reductionFactor: bigint;
  mode: BaseFeeMode;
}

/**
 * Linear fee decay from `cliffFeePct` to `endFeePct` over `seconds`.
 *
 * Linear only. `FeeSchedulerExponential` reads `reduction_factor` as basis
 * points per period, not as an absolute numerator delta, so it cannot be derived
 * from a start/end pair — deriving one here would produce a fee schedule that
 * decays to nonsense (a cliff of 85% "reducing" by 825% per period). Use
 * `exponentialFeeDecay` for that shape.
 */
export function feeDecay(params: {
  cliffFeePct: number;
  endFeePct: number;
  seconds: number;
  periodFrequency?: bigint;
  mode?: BaseFeeMode;
}): FeeDecay {
  const mode = params.mode ?? BaseFeeMode.FeeSchedulerLinear;
  if (mode !== BaseFeeMode.FeeSchedulerLinear) {
    throw new Error(
      "feeDecay only produces FeeSchedulerLinear schedules — use exponentialFeeDecay for exponential",
    );
  }
  const periodFrequency = params.periodFrequency ?? 1n;
  const numberOfPeriod = Math.max(1, Math.floor(params.seconds / Number(periodFrequency)));
  // percent -> numerator units of 1e9
  const cliff = BigInt(Math.round(params.cliffFeePct * 1e7));
  const end = BigInt(Math.round(params.endFeePct * 1e7));
  if (end > cliff) throw new Error("endFeePct must not exceed cliffFeePct");
  if (cliff < MIN_FEE_NUMERATOR) {
    throw new Error(
      `cliffFeePct is below the program floor (${Number(MIN_FEE_NUMERATOR) / 1e7}%)`,
    );
  }
  if (end < MIN_FEE_NUMERATOR) {
    throw new Error(`endFeePct below the program floor (${Number(MIN_FEE_NUMERATOR) / 1e7}%)`);
  }
  const reductionFactor = (cliff - end) / BigInt(numberOfPeriod);
  if (reductionFactor * BigInt(numberOfPeriod) > cliff) {
    throw new Error("reduction overshoots the cliff");
  }
  return {
    cliffFeeNumerator: cliff,
    numberOfPeriod,
    periodFrequency,
    reductionFactor,
    mode,
  };
}

/**
 * Exponential fee decay: `cliff * (1 - reductionBps/10000)^period`.
 *
 * Geometric decay never reaches the floor — after the schedule "ends" the fee
 * keeps decaying toward it but stays well above a linear schedule's endpoint
 * for a long tail. A 99% cliff decaying 5%/period is still ~60% after 100
 * periods, where the linear schedule would long since be at its floor.
 * Every period's fee stays >= MIN_FEE_NUMERATOR, exactly what the program
 * validates (`get_min_base_fee_numerator` at `number_of_period`).
 *
 * `reductionBps` is basis points cut per period (500 = 5%), NOT a numerator
 * delta — the exponential mode reads `reduction_factor` as bps.
 */
export function exponentialFeeDecay(params: {
  cliffFeePct: number;
  /** bps of the remaining fee removed each period (1..9999). */
  reductionBps: number;
  numberOfPeriod: number;
  periodFrequency?: bigint;
}): FeeDecay {
  const { cliffFeePct, reductionBps, numberOfPeriod } = params;
  const periodFrequency = params.periodFrequency ?? 1n;
  const cliff = BigInt(Math.round(cliffFeePct * 1e7));
  if (cliff < MIN_FEE_NUMERATOR || cliff > 990_000_000n) {
    throw new Error(`cliffFeePct must be within the program bounds (0.25%..99%)`);
  }
  if (!Number.isInteger(reductionBps) || reductionBps < 1 || reductionBps > 9999) {
    throw new Error("reductionBps must be an integer in 1..9999");
  }
  if (!Number.isInteger(numberOfPeriod) || numberOfPeriod < 1 || numberOfPeriod > 65535) {
    throw new Error("numberOfPeriod must be an integer in 1..65535");
  }
  // program floor check: fee at the LAST period must still be >= MIN_FEE_NUMERATOR
  const schedule: FeeDecay = {
    cliffFeeNumerator: cliff,
    numberOfPeriod,
    periodFrequency,
    reductionFactor: BigInt(reductionBps),
    mode: BaseFeeMode.FeeSchedulerExponential,
  };
  const floorFee = feeAtElapsed(schedule, numberOfPeriod * Number(periodFrequency));
  if (floorFee < MIN_FEE_NUMERATOR) {
    throw new Error(
      `exponential schedule decays below the program floor at the last period ` +
        `(${(Number(floorFee) / 1e7).toFixed(4)}% < 0.25%) — reduce reductionBps or numberOfPeriod`,
    );
  }
  return schedule;
}

/** LP-slice vesting schedule — mirrors the program's `LiquidityVestingInfo`. */
export interface LiquidityVestingSchedule {
  /** Share of the slice (0..100) placed on this schedule. */
  vestingPercentage: number;
  /** bps of the vested amount unlocked per period. */
  bpsPerPeriod: number;
  numberOfPeriods: number;
  /** Seconds between periods. */
  frequency: number;
  /** Seconds after migration before anything unlocks. */
  cliffDurationFromMigrationTime: number;
}

/**
 * Vesting that satisfies the program's 10%-locked-at-24h floor yet unlocks
 * fully shortly after: a 100% cliff at `cliffSeconds` (> 86400). The floor
 * check runs at exactly SECONDS_PER_DAY, so any cliff past that passes while
 * the whole slice unlocks the moment the cliff does.
 */
export function cliffVesting(cliffSeconds: number): LiquidityVestingSchedule {
  if (cliffSeconds <= 86_400) {
    throw new Error(
      `cliffSeconds must be > 86400 (the floor is checked at exactly 24h; ` +
        `a cliff at or before it fails validation or unlocks early)`,
    );
  }
  return {
    vestingPercentage: 100,
    bpsPerPeriod: 10_000,
    numberOfPeriods: 1,
    frequency: 1,
    cliffDurationFromMigrationTime: cliffSeconds,
  };
}

// IDL type is `LiquidityVestingInfoParams` (the create_config arg): 5 fields, NO
// is_initialized / padding — those exist only on the stored account.
const vestingInfo = (v?: LiquidityVestingSchedule) =>
  v
    ? {
        vestingPercentage: v.vestingPercentage,
        bpsPerPeriod: v.bpsPerPeriod,
        numberOfPeriods: v.numberOfPeriods,
        cliffDurationFromMigrationTime: v.cliffDurationFromMigrationTime,
        frequency: v.frequency,
      }
    : {
        vestingPercentage: 0,
        bpsPerPeriod: 0,
        numberOfPeriods: 0,
        cliffDurationFromMigrationTime: 0,
        frequency: 0,
      };

export interface FixedSupplyLaunchOptions {
  quoteMint: PublicKey;
  feeClaimer: PublicKey;
  /** Wallet (or ATA owner) that receives the leftover base supply. */
  leftoverReceiver: PublicKey;
  /** √P at the start of the curve. Use `sqrtPriceFromPrice` to derive it. */
  sqrtStartPrice: bigint;
  /** Curve segments: each point's sqrt price + liquidity. */
  curve: CurvePoint[];
  /** Quote (lamports for wSOL) needed to graduate. */
  migrationQuoteThreshold: bigint;
  /** Fixed base supply minted before the curve opens. */
  preMigrationTokenSupply: bigint;
  /** Defaults to `preMigrationTokenSupply`. Must be >= the program floor. */
  postMigrationTokenSupply?: bigint;
  baseFee: FeeDecay;
  dynamicFee?: {
    binStep: number;
    binStepU128: bigint;
    filterPeriod: number;
    decayPeriod: number;
    reductionFactor: number;
    maxVolatilityAccumulator: number;
    variableFeeControl: number;
  } | null;
  lockedVesting?: {
    amountPerPeriod: bigint;
    cliffDurationFromMigrationTime: bigint;
    frequency: bigint;
    numberOfPeriod: bigint;
    cliffUnlockAmount: bigint;
  };
  tokenDecimals?: number;
  tokenType?: TokenType;
  activationType?: ActivationType;
  /** Curve-time fee destination. Defaults to `QuoteToken`. */
  collectFeeMode?: CollectFeeMode;
  /** 0..100 — the creator's cut of the quote fee. `fee_claimer` keeps the rest. */
  creatorTradingFeePercentage?: number;
  tokenAuthority?: TokenAuthorityOption;
  migrationFeeOption?: MigrationFeeOption;
  migrationFeePercentage?: number;
  creatorMigrationFeePercentage?: number;
  /** Exact migration base threshold from an existing config; skips the local estimate. */
  migrationBaseThreshold?: bigint;
  migratedPoolFee?: { collectFeeMode: MigratedCollectFeeMode; dynamicFee: number; poolFeeBps: number };
  /** Liquidity split on graduation; the four percentages + vesting must total 100. */
  liquiditySplit?: {
    partnerLiquidityPercentage: number;
    partnerPermanentLockedLiquidityPercentage: number;
    creatorLiquidityPercentage: number;
    creatorPermanentLockedLiquidityPercentage: number;
  };
  /**
   * Vesting schedule for the PARTNER LP slice at graduation. `vestingPercentage`
   * is the share of that slice placed on the schedule; the rest is unlocked
   * immediately. A cliff just past 24h satisfies the program's locked-liquidity
   * floor (`>= 10% locked at SECONDS_PER_DAY`) while still unlocking entirely
   * once the cliff passes — unlike `permanentLocked`, which never unlocks.
   */
  partnerLiquidityVesting?: LiquidityVestingSchedule;
  creatorLiquidityVesting?: LiquidityVestingSchedule;
  poolCreationFee?: bigint;
  /**
   * Whether the first swap after launch pays the minimum fee instead of the
   * cliff. The first swap must ALSO be sent without a referral account
   * (process_swap enforces `referral_token_account.is_none()`), so this is
   * effectively an early entry at the min fee: launch, then buy first.
   */
  enableFirstSwapWithMinFee?: boolean;
}

export interface FixedSupplyLaunchPlan {
  configParameters: any;
  plan: SupplyPlan;
  leftover: bigint;
  postMigrationTokenSupply: bigint;
  warnings: string[];
}

const bn = (v: bigint) => new BN(v.toString());
/** Deep-convert bigints to BN, leaving anything already BN-shaped alone. */
const bns = (o: any): any =>
  BN.isBN(o) ? o
  : typeof o === "bigint" ? bn(o)
  : Array.isArray(o) ? o.map(bns)
  : o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, bns(v)]))
  : o;

export function planFixedSupplyLaunch(opts: FixedSupplyLaunchOptions): FixedSupplyLaunchPlan {
  const decimals = opts.tokenDecimals ?? 6;
  const lockedVesting = opts.lockedVesting ?? {
    amountPerPeriod: 0n,
    cliffDurationFromMigrationTime: 0n,
    frequency: 0n,
    numberOfPeriod: 0n,
    cliffUnlockAmount: 0n,
  };
  const lockedTotal =
    lockedVesting.amountPerPeriod * lockedVesting.numberOfPeriod +
    lockedVesting.cliffUnlockAmount;

  const plan = supplyPlan({
    sqrtStartPrice: opts.sqrtStartPrice,
    curve: opts.curve,
    migrationQuoteThreshold: opts.migrationQuoteThreshold,
    lockedVesting: lockedTotal,
    migrationBaseThreshold: opts.migrationBaseThreshold,
    migrationFeePercentage: opts.migrationFeePercentage ?? 5,
  });

  const post = opts.postMigrationTokenSupply ?? opts.preMigrationTokenSupply;
  const leftover = leftoverAmount(plan, opts.preMigrationTokenSupply);
  const warnings: string[] = [];

  if (opts.preMigrationTokenSupply < plan.minSupplyWithBuffer) {
    warnings.push(
      `preMigrationTokenSupply ${opts.preMigrationTokenSupply} is below the program floor ` +
        `${plan.minSupplyWithBuffer} (swap + 25% buffer + migration + locked). create_config will revert.`,
    );
  }
  if (post < plan.minSupplyWithoutBuffer) {
    warnings.push(
      `postMigrationTokenSupply ${post} is below ${plan.minSupplyWithoutBuffer} (swap + migration + locked).`,
    );
  }
  if (post > opts.preMigrationTokenSupply) {
    warnings.push("postMigrationTokenSupply must not exceed preMigrationTokenSupply.");
  }
  if (opts.leftoverReceiver.equals(PublicKey.default)) {
    warnings.push("leftoverReceiver is the default pubkey — create_config rejects it.");
  }
  if (leftover === 0n) {
    warnings.push("leftover is zero: no base supply is reserved, withdraw_leftover will pay 0.");
  }
  if (opts.creatorTradingFeePercentage && opts.creatorTradingFeePercentage > 100) {
    warnings.push("creatorTradingFeePercentage must be <= 100.");
  }
  if (decimals < 6 || decimals > 9) {
    warnings.push(`tokenDecimals must be 6..9, got ${decimals}.`);
  }

  const split = opts.liquiditySplit ?? {
    // 90 unlocked / 10 permanently locked: the minimum the program accepts is
    // 10% locked one day after migration (MIN_LOCKED_LIQUIDITY_BPS = 1000).
    // 100% locked (the old default) makes ALL graduated LP permanently
    // unwithdrawable — fees still accrue, the liquidity never comes out.
    partnerLiquidityPercentage: 90,
    partnerPermanentLockedLiquidityPercentage: 10,
    creatorLiquidityPercentage: 0,
    creatorPermanentLockedLiquidityPercentage: 0,
  };
  const splitSum =
    split.partnerLiquidityPercentage +
    split.partnerPermanentLockedLiquidityPercentage +
    split.creatorLiquidityPercentage +
    split.creatorPermanentLockedLiquidityPercentage;
  if (splitSum !== 100) {
    warnings.push(`liquidity split must total 100, got ${splitSum}.`);
  }

  const configParameters = {
    poolFees: {
      baseFee: {
        cliffFeeNumerator: bn(opts.baseFee.cliffFeeNumerator),
        firstFactor: opts.baseFee.numberOfPeriod,
        secondFactor: bn(opts.baseFee.periodFrequency),
        thirdFactor: bn(opts.baseFee.reductionFactor),
        baseFeeMode: opts.baseFee.mode,
      },
      dynamicFee: opts.dynamicFee
        ? {
            binStep: opts.dynamicFee.binStep,
            binStepU128: bn(opts.dynamicFee.binStepU128),
            filterPeriod: opts.dynamicFee.filterPeriod,
            decayPeriod: opts.dynamicFee.decayPeriod,
            reductionFactor: opts.dynamicFee.reductionFactor,
            maxVolatilityAccumulator: opts.dynamicFee.maxVolatilityAccumulator,
            variableFeeControl: opts.dynamicFee.variableFeeControl,
          }
        : null,
    },
    collectFeeMode: opts.collectFeeMode ?? CollectFeeMode.QuoteToken,
    migrationOption: MigrationOption.DammV2,
    activationType: opts.activationType ?? ActivationType.Timestamp,
    tokenType: opts.tokenType ?? TokenType.Token2022,
    tokenDecimal: decimals,
    partnerLiquidityPercentage: split.partnerLiquidityPercentage,
    partnerPermanentLockedLiquidityPercentage: split.partnerPermanentLockedLiquidityPercentage,
    creatorLiquidityPercentage: split.creatorLiquidityPercentage,
    creatorPermanentLockedLiquidityPercentage: split.creatorPermanentLockedLiquidityPercentage,
    migrationQuoteThreshold: bn(opts.migrationQuoteThreshold),
    sqrtStartPrice: bn(opts.sqrtStartPrice),
    lockedVesting: {
      amountPerPeriod: bn(lockedVesting.amountPerPeriod),
      cliffDurationFromMigrationTime: bn(lockedVesting.cliffDurationFromMigrationTime),
      frequency: bn(lockedVesting.frequency),
      numberOfPeriod: bn(lockedVesting.numberOfPeriod),
      cliffUnlockAmount: bn(lockedVesting.cliffUnlockAmount),
    },
    migrationFeeOption: opts.migrationFeeOption ?? MigrationFeeOption.Customizable,
    tokenSupply: {
      preMigrationTokenSupply: bn(opts.preMigrationTokenSupply),
      postMigrationTokenSupply: bn(post),
    },
    creatorTradingFeePercentage: opts.creatorTradingFeePercentage ?? 0,
    tokenUpdateAuthority: opts.tokenAuthority ?? TokenAuthorityOption.Immutable,
    migrationFee: {
      feePercentage: opts.migrationFeePercentage ?? 5,
      creatorFeePercentage: opts.creatorMigrationFeePercentage ?? 0,
    },
    migratedPoolFee: opts.migratedPoolFee ?? {
      collectFeeMode: MigratedCollectFeeMode.QuoteToken,
      dynamicFee: 0,
      poolFeeBps: 200,
    },
    poolCreationFee: bn(opts.poolCreationFee ?? 0n),
    partnerLiquidityVestingInfo: vestingInfo(opts.partnerLiquidityVesting),
    creatorLiquidityVestingInfo: vestingInfo(opts.creatorLiquidityVesting),
    migratedPoolBaseFeeMode: 0,
    migratedPoolMarketCapFeeSchedulerParams: {
      numberOfPeriod: 0,
      sqrtPriceStepBps: 0,
      schedulerExpirationDuration: 0,
      reductionFactor: bn(0n),
    },
    enableFirstSwapWithMinFee: opts.enableFirstSwapWithMinFee ?? false,
    compoundingFeeBps: 0,
    padding: [0, 0],
    curve: opts.curve.map((p) => ({ sqrtPrice: bn(p.sqrtPrice), liquidity: bn(p.liquidity) })),
  };

  return {
    configParameters: bns(configParameters),
    plan,
    leftover,
    postMigrationTokenSupply: post,
    warnings,
  };
}

/**
 * Fee numerator at `elapsedSeconds` after activation, mirroring
 * `FeeScheduler::get_base_fee_numerator` (base_fee/fee_scheduler.rs).
 *
 * Exponential decay is computed the way the program does it — Q64.64 fixed point
 * with square-and-multiply and a truncating `>> 64` per step — not as repeated
 * integer division, which drifts (~9 numerator units over 100 periods).
 *
 * ponytail: only the decaying direction is modelled (base <= 1), which is the
 * only shape a valid config can express. A config whose `reductionFactor` is 0
 * is returned as the cliff, matching the program's approximation of 1^period.
 */
export function feeAtElapsed(fee: FeeDecay, elapsedSeconds: number): bigint {
  const period = BigInt(Math.floor(elapsedSeconds / Number(fee.periodFrequency)));
  const clamped = period > BigInt(fee.numberOfPeriod) ? BigInt(fee.numberOfPeriod) : period;

  if (fee.mode === BaseFeeMode.FeeSchedulerLinear) {
    const n = fee.cliffFeeNumerator - fee.reductionFactor * clamped;
    return n > 0n ? n : 0n;
  }

  // Exponential: cliff * (1 - reduction/10000)^period, in Q64.64.
  if (fee.reductionFactor === 0n) return fee.cliffFeeNumerator;
  if (fee.reductionFactor > BASIS_POINT_MAX) {
    throw new Error(
      `exponential reductionFactor must be basis points <= ${BASIS_POINT_MAX}, got ${fee.reductionFactor}`,
    );
  }

  const ONE_Q64 = 1n << 64n;
  const base = ONE_Q64 - (fee.reductionFactor << 64n) / BASIS_POINT_MAX;

  let result = ONE_Q64;
  let squared = base;
  let exp = clamped;
  while (exp > 0n) {
    if (exp & 1n) result = (result * squared) >> 64n;
    squared = (squared * squared) >> 64n;
    exp >>= 1n;
  }
  return (result * fee.cliffFeeNumerator) >> 64n;
}

/** Fee as a percentage, for display. */
export const feePct = (numerator: bigint) => Number((numerator * 1_000_000n) / FEE_DENOMINATOR) / 10_000;

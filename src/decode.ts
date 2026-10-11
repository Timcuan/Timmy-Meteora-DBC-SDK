import { PublicKey } from "@solana/web3.js";
import { accountLayout, camel, idlTypeFields } from "./layout.js";
import {
  BaseFeeMode,
  CollectFeeMode,
  FEE_DENOMINATOR,
  MigrationFeeOption,
  MigrationOption,
  MigrationProgress,
  TokenAuthorityOption,
  TokenType,
} from "./constants.js";

/** Borsh reader over an account body (discriminator already skipped). */
class Reader {
  private view: DataView;
  constructor(private buf: Uint8Array, public offset = 0) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  u8 = () => this.view.getUint8(this.offset++);
  i8 = () => this.view.getInt8(this.offset++);
  u16 = () => (this.offset += 2, this.view.getUint16(this.offset - 2, true));
  i16 = () => (this.offset += 2, this.view.getInt16(this.offset - 2, true));
  u32 = () => (this.offset += 4, this.view.getUint32(this.offset - 4, true));
  i32 = () => (this.offset += 4, this.view.getInt32(this.offset - 4, true));
  u64 = () => (this.offset += 8, this.view.getBigUint64(this.offset - 8, true));
  i64 = () => (this.offset += 8, this.view.getBigInt64(this.offset - 8, true));
  u128 = () => {
    const lo = this.u64();
    const hi = this.u64();
    return (hi << 64n) | lo;
  };
  bool = () => this.u8() !== 0;
  pubkey = () => {
    const pk = new PublicKey(this.buf.subarray(this.offset, this.offset + 32));
    this.offset += 32;
    return pk;
  };
  bytes = (n: number) => {
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  };
}

function readValue(type: any, r: Reader, defined: (name: string) => any): any {
  if (typeof type === "string") {
    switch (type) {
      case "u8": return r.u8();
      case "i8": return r.i8();
      case "u16": return r.u16();
      case "i16": return r.i16();
      case "u32": return r.u32();
      case "i32": return r.i32();
      case "u64": return r.u64();
      case "i64": return r.i64();
      case "u128": return r.u128();
      case "i128": return r.u128();
      case "bool": return r.bool();
      case "pubkey": return r.pubkey();
      default: throw new Error(`unsupported type: ${type}`);
    }
  }
  if ("defined" in type) return defined(type.defined.name);
  if ("array" in type) {
    const [inner, n] = type.array;
    if (inner === "u8") return r.bytes(n);
    return Array.from({ length: n }, () => readValue(inner, r, defined));
  }
  if ("option" in type) {
    return r.u8() === 0 ? null : readValue(type.option, r, defined);
  }
  throw new Error(`unsupported type: ${JSON.stringify(type)}`);
}

function structReader(name: string) {
  const fields = (idlTypeFields(name) ?? []).map((f: any) => ({ ...f, key: camel(f.name) }));
  return (r: Reader): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const f of fields) out[f.key] = readValue(f.type, r, (n) => structReader(n)(r));
    return out;
  };
}

/** Decode any DBC account by name. Returns camelCase keys, bigints for u64/u128. */
export function decodeAccount(name: string, data: Uint8Array): Record<string, any> {
  const layout = accountLayout(name);
  const disc = data.subarray(0, 8);
  if (Buffer.compare(Buffer.from(disc), Buffer.from(layout.discriminator)) !== 0) {
    throw new Error(
      `discriminator mismatch for ${name}: got ${Buffer.from(disc).toString("hex")}`,
    );
  }
  return structReader(name)(new Reader(data.subarray(8)));
}

export const decodePoolConfig = (data: Uint8Array) => decodeAccount("PoolConfig", data);

/** `VirtualPool` wraps a single `PoolState` — flatten it so callers get the fields directly. */
export const decodeVirtualPool = (data: Uint8Array) =>
  decodeAccount("VirtualPool", data).poolState as Record<string, any>;

export const decodeTokenBadge = (data: Uint8Array) => decodeAccount("TokenBadge", data);
export const decodeOperator = (data: Uint8Array) => decodeAccount("Operator", data);

const pct = (numerator: bigint) => Number((numerator * 1_000_000n) / FEE_DENOMINATOR) / 10_000;

/** Recompute what the program derives on-chain, from the stored config alone. */
export interface PoolConfigAnalysis {
  fixedTokenSupply: boolean;
  /** Base supply partitions, in whole tokens (config decimals applied by caller). */
  supply: {
    preMigration: bigint;
    postMigration: bigint;
    swapOnCurve: bigint;
    migrationThreshold: bigint;
    lockedVesting: bigint;
    /**
     * pre − swap − migration − locked. This is the reserved leftover that
     * `withdraw_leftover` pays out; the on-chain amount can drift by a few base
     * units because the payout is `base_vault.amount − fees` at withdraw time.
     */
    leftover: bigint;
    leftoverBpsOfSupply: number;
  };
  fee: {
    mode: BaseFeeMode;
    cliffFeePct: number;
    periods: number;
    periodSeconds: number;
    reductionPerPeriodPct: number;
    /** cliff − periods × reduction, floored at 0. */
    finalFeePct: number;
    /** 1 when the cliff is the whole story; >1 when buyers front-run the decay. */
    decaySeconds: number;
  };
  migration: {
    option: MigrationOption;
    feeOption: MigrationFeeOption;
    protocolFeePct: number;
    creatorFeePct: number;
    quoteThreshold: bigint;
    sqrtPrice: bigint;
  };
  liquiditySplit: {
    partnerLiquidityPct: number;
    partnerPermanentLockedPct: number;
    creatorLiquidityPct: number;
    creatorPermanentLockedPct: number;
    partnerVestingPct: number;
    creatorVestingPct: number;
  };
  flags: {
    collectFeeMode: CollectFeeMode;
    tokenType: TokenType;
    tokenDecimals: number;
    tokenAuthority: TokenAuthorityOption;
    creatorTradingFeePct: number;
    poolCreationFee: bigint;
    curvePoints: number;
  };
}

export function analyzePoolConfig(cfg: Record<string, any>): PoolConfigAnalysis {
  const baseFee = cfg.poolFees.baseFee;
  // BaseFeeConfig field order is (cliff, second, third, first, mode) for backward
  // compatibility: second = period_frequency, third = reduction_factor,
  // first = number_of_period.
  const periods = Number(baseFee.firstFactor);
  const periodFrequency = baseFee.secondFactor as bigint;
  const reduction = baseFee.thirdFactor as bigint;
  const finalNumerator =
    baseFee.cliffFeeNumerator > reduction * BigInt(periods)
      ? baseFee.cliffFeeNumerator - reduction * BigInt(periods)
      : 0n;

  const lockedVestingTotal =
    cfg.lockedVestingConfig.amountPerPeriod *
      cfg.lockedVestingConfig.numberOfPeriod +
    cfg.lockedVestingConfig.cliffUnlockAmount;

  const migrationThreshold = cfg.migrationBaseThreshold as bigint;
  const swapOnCurve = cfg.swapBaseAmount as bigint;
  const pre = cfg.preMigrationTokenSupply as bigint;
  const leftover = cfg.fixedTokenSupplyFlag === 1
    ? pre - swapOnCurve - migrationThreshold - lockedVestingTotal
    : 0n;

  const curvePoints = (cfg.curve as any[]).filter((p) => p.liquidity > 0n).length;

  return {
    fixedTokenSupply: cfg.fixedTokenSupplyFlag === 1,
    supply: {
      preMigration: pre,
      postMigration: cfg.postMigrationTokenSupply as bigint,
      swapOnCurve,
      migrationThreshold,
      lockedVesting: lockedVestingTotal,
      leftover: leftover > 0n ? leftover : 0n,
      leftoverBpsOfSupply: pre > 0n ? Number((leftover * 10_000n) / pre) : 0,
    },
    fee: {
      mode: baseFee.baseFeeMode as BaseFeeMode,
      cliffFeePct: pct(baseFee.cliffFeeNumerator),
      periods,
      periodSeconds: Number(periodFrequency),
      reductionPerPeriodPct: pct(reduction),
      finalFeePct: pct(finalNumerator),
      decaySeconds: periods * Number(periodFrequency),
    },
    migration: {
      option: cfg.migrationOption as MigrationOption,
      feeOption: cfg.migrationFeeOption as MigrationFeeOption,
      protocolFeePct: cfg.migrationFeePercentage,
      creatorFeePct: cfg.creatorMigrationFeePercentage,
      quoteThreshold: cfg.migrationQuoteThreshold as bigint,
      sqrtPrice: cfg.migrationSqrtPrice as bigint,
    },
    liquiditySplit: {
      partnerLiquidityPct: cfg.partnerLiquidityPercentage,
      partnerPermanentLockedPct: cfg.partnerPermanentLockedLiquidityPercentage,
      creatorLiquidityPct: cfg.creatorLiquidityPercentage,
      creatorPermanentLockedPct: cfg.creatorPermanentLockedLiquidityPercentage,
      partnerVestingPct: cfg.partnerLiquidityVestingInfo.vestingPercentage,
      creatorVestingPct: cfg.creatorLiquidityVestingInfo.vestingPercentage,
    },
    flags: {
      collectFeeMode: cfg.collectFeeMode as CollectFeeMode,
      tokenType: cfg.tokenType as TokenType,
      tokenDecimals: cfg.tokenDecimal,
      tokenAuthority: cfg.tokenUpdateAuthority as TokenAuthorityOption,
      creatorTradingFeePct: cfg.creatorTradingFeePercentage,
      poolCreationFee: cfg.poolCreationFee as bigint,
      curvePoints,
    },
  };
}

export interface VirtualPoolAnalysis {
  migrationProgress: MigrationProgress;
  migrationProgressName: string;
  isMigrated: boolean;
  curveComplete: boolean;
  /** quoteReserve / migrationQuoteThreshold, 0..1+ */
  curveProgress: number;
  withdrawLeftoverEligible: boolean;
  /** Base tokens still sitting in the vault that are not protocol fees. */
  pending: {
    /** Currently claimable, straight off the pool account. Can be claimed to 0 at any time. */
    unclaimed: {
      protocolBaseFee: bigint;
      protocolQuoteFee: bigint;
      partnerBaseFee: bigint;
      partnerQuoteFee: bigint;
      creatorBaseFee: bigint;
      creatorQuoteFee: bigint;
      migrationBaseFee: bigint;
      migrationQuoteFee: bigint;
    };
    /** Lifetime accumulated totals (`metrics`) — they only ever grow. */
    lifetime: {
      protocolBaseFee: bigint;
      protocolQuoteFee: bigint;
      tradingBaseFee: bigint;
      tradingQuoteFee: bigint;
    };
  };
}

export function analyzeVirtualPool(
  pool: Record<string, any>,
  cfg: Record<string, any>,
): VirtualPoolAnalysis {
  const progress = pool.migrationProgress as MigrationProgress;
  const threshold = cfg.migrationQuoteThreshold as bigint;
  const reserve = pool.quoteReserve as bigint;
  return {
    migrationProgress: progress,
    migrationProgressName: MigrationProgress[progress] ?? `unknown(${progress})`,
    isMigrated: pool.isMigrated === 1,
    curveComplete: reserve >= threshold,
    curveProgress: threshold > 0n ? Number((reserve * 10_000n) / threshold) / 10_000 : 0,
    withdrawLeftoverEligible:
      progress === MigrationProgress.CreatedPool &&
      cfg.fixedTokenSupplyFlag === 1 &&
      pool.isWithdrawLeftover === 0,
    pending: {
      unclaimed: {
        protocolBaseFee: pool.protocolBaseFee,
        protocolQuoteFee: pool.protocolQuoteFee,
        partnerBaseFee: pool.partnerBaseFee,
        partnerQuoteFee: pool.partnerQuoteFee,
        creatorBaseFee: pool.creatorBaseFee,
        creatorQuoteFee: pool.creatorQuoteFee,
        migrationBaseFee: pool.protocolMigrationBaseFeeAmount,
        migrationQuoteFee: pool.protocolMigrationQuoteFeeAmount,
      },
      lifetime: {
        protocolBaseFee: pool.metrics.totalProtocolBaseFee,
        protocolQuoteFee: pool.metrics.totalProtocolQuoteFee,
        tradingBaseFee: pool.metrics.totalTradingBaseFee,
        tradingQuoteFee: pool.metrics.totalTradingQuoteFee,
      },
    },
  };
}

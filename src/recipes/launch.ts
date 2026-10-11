import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { unpackMint } from "@solana/spl-token";
import { createConfig, initializeVirtualPool, tokenProgramFor } from "../ix.js";
import { buildHandle } from "../program.js";
import { sqrtPriceFromPrice, Q128, supplyPlan, toRawUnits, type CurvePoint } from "../curve.js";
import { MAX_SQRT_PRICE } from "../constants.js";
import { planFixedSupplyLaunch, type FeeDecay } from "./fixed-supply.js";
import { TokenAuthorityOption, NATIVE_MINT } from "../constants.js";

/**
 * Default post-graduation venue config: the zero-fee cp-amm Config the live
 * Inference launch migrated through (fee mode 0, numerator 0, verified on
 * mainnet). 762 public configs exist; this one keeps the graduated pool free
 * of swap fees, matching how the reference launch behaved.
 */
export const DEFAULT_DAMM_CONFIG = new PublicKey(
  "A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck",
);

/**
 * One-shot launch: create_config + initialize_pool in a single transaction.
 *
 * `initialize_virtual_pool_with_token2022` does everything on-chain — creates
 * the mint (init + signer), writes its metadata, mints the entire supply into
 * the base vault, then drops mint/metadata authority. The caller never touches
 * a mint keypair or a metadata CPI.
 *
 * Config is `init` + signer → a fresh Keypair, generated here and signed.
 * Keep the returned address; it is the pool's identity.
 */

export interface LaunchInput {
  /** Signs and pays. Also the default fee claimer and leftover receiver. */
  authority: Keypair;
  connection: Connection;
  name: string;
  symbol: string;
  uri: string;
  /** Defaults to wSOL (9 decimals, plain SPL — no token badge needed). */
  quoteMint?: PublicKey;
  /** Human price at curve start, quote per whole token (e.g. 5e-8). */
  startPrice: number;
  /** Quote needed to graduate, human units (e.g. 65 for 65 SOL). */
  graduationQuote: number;
  /** Base tokens sold on the curve, whole tokens (e.g. 51e7). Default 51% of supply. */
  swapOnCurve?: number;
  /**
   * Explicit curve segments — bypasses `buildCurve`. Use `buildKneeCurve` for a
   * flat-entry/thin-pump two-segment shape. Segments must cover the range up to
   * MAX_SQRT_PRICE; the plan preflight still validates the supply floor.
   */
  curve?: CurvePoint[];
  /** Whole tokens (e.g. 1e9). */
  totalSupply: number;
  /** Default 6. */
  decimals?: number;
  /**
   * Defaults to the Inference decay: 85% -> 2.5% over 100 seconds, linear.
   * The whole point of a fee cliff is front-loaded buyers; keep it or set it
   * explicitly, but never accidentally.
   */
  baseFee?: FeeDecay;
  /** Defaults to the authority wallet. */
  feeClaimer?: PublicKey;
  /** Where the leftover supply lands after graduation. Defaults to authority. */
  leftoverReceiver?: PublicKey;
  /**
   * The cp-amm Config the pool migrates into (`remaining_accounts[0]`).
   * On mainnet, reuse an existing public one — the zero-fee shape the real
   * Inference launch migrated through is
   * `A8gMrEPJkacWkcb3DGwtJwTe16HktSEfvwtuDh2MCtck` (762 configs exist).
   * Stored on the result so callers know what to pass to migrationDammV2.
   */
  dammConfig?: PublicKey;
  /** Creator's cut of the quote fee, 0..100. Default 0. */
  creatorTradingFeePercentage?: number;
  /** Skip preflight warnings. */
  skipPreflight?: boolean;

  // ── extraction knobs (leftover / LP / fee levers) ──────────────────────────
  /** Target circulating supply after migration. Lower = larger `withdraw_leftover` reserve. */
  postMigrationTokenSupply?: number;
  /** First swap after launch pays the min fee. */
  enableFirstSwapWithMinFee?: boolean;
  /** Migration fee % of the quote threshold, claimed by partner/creator. */
  migrationFeePercentage?: number;
  /** Creator's cut of the migration fee, 0..100. */
  creatorMigrationFeePercentage?: number;
  /** Graduation liquidity split; `creator*Percentage` becomes the dev's pullable LP + fee stream. */
  liquiditySplit?: {
    partnerLiquidityPercentage: number;
    partnerPermanentLockedLiquidityPercentage: number;
    creatorLiquidityPercentage: number;
    creatorPermanentLockedLiquidityPercentage: number;
  };
  /** LP-slice vesting schedules (see fixed-supply.ts `LiquidityVestingSchedule`). */
  partnerLiquidityVesting?: import("./fixed-supply.js").LiquidityVestingSchedule;
  creatorLiquidityVesting?: import("./fixed-supply.js").LiquidityVestingSchedule;
  /** Mint authority option. 3/4 retain mint authority (transfer-hook configs only). */
  tokenAuthority?: TokenAuthorityOption;
  /**
   * Token-2022 transfer hook program for a transfer-hook launch. Set it to
   * `BONDING_GUARD_PROGRAM_ID` to lock free transfers while the curve is live.
   * DBC revokes the hook on graduation.
   */
  transferHookProgram?: PublicKey;
  /** Lamports charged at pool creation; 90% goes to the partner fee_claimer. */
  poolCreationFee?: number;

  // ── team allocation (locked vesting, instant unlock) ────────────────────────
  /**
   * Team allocation in whole tokens, locked into the Meteora locker as a
   * locked-vesting reserve. Unlocks INSTANTLY: cliff_duration = 0 and the whole
   * amount is the cliff_unlock_amount, so `claimTeamAllocation` returns 100%
   * as soon as `lockTeamAllocation` (post-graduation) runs. Use the `lp.ts`
   * recipes to lock + claim; `reassignTeamAllocation` re-points it at any wallet.
   */
  teamAllocation?: number;
}

export interface LaunchResult {
  signature: string;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  /** Everything the program derives — swap amount, migration price, floors. */
  plan: ReturnType<typeof supplyPlan>;
  /** Base units reserved for `leftoverReceiver`. */
  leftover: bigint;
  /** The cp-amm Config to migrate through (pass to `migrationDammV2`). */
  dammConfig: PublicKey;
}

/** wSOL shortcut for the decimals lookup. */
async function decimalsOf(conn: Connection, mint: PublicKey): Promise<number> {
  if (mint.equals(NATIVE_MINT)) return 9;
  const info = await conn.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`quote mint not found: ${mint.toBase58()}`);
  return unpackMint(mint, info, info.owner).decimals;
}

/**
 * Closed-form curve for a target `swapBaseAmount` (base released to graduation)
 * and `migrationQuoteThreshold` (quote absorbed to graduation):
 *
 *   pm = Q·2^128 / (B·ps)          migration √P
 *   L  = Q·2^128 / (pm − ps)       segment liquidity
 *
 * Validated against the live Inference curve: reproduces its stored
 * `migration_sqrt_price` and `liquidity` to within rounding (±2 units).
 * The thin tail exists so the graduated pool keeps some depth past graduation.
 */
export function buildCurve(params: {
  sqrtStartPrice: bigint;
  migrationQuoteThreshold: bigint;
  swapBaseAmount: bigint;
  /** Default: 5% of the main liquidity. */
  tailLiquidity?: bigint;
}): CurvePoint[] {
  const { sqrtStartPrice: ps, migrationQuoteThreshold: Q, swapBaseAmount: B } = params;
  if (B <= 0n || Q <= 0n) throw new Error("swapBaseAmount and migrationQuoteThreshold must be > 0");
  const pm = (Q * Q128) / (B * ps);
  if (pm <= ps) throw new Error("start price too high for this graduation target");
  const L = (Q * Q128) / (pm - ps);
  return [
    { sqrtPrice: pm, liquidity: L },
    { sqrtPrice: MAX_SQRT_PRICE, liquidity: params.tailLiquidity ?? L / 20n },
  ];
}

/**
 * Two-segment curve with an explicit knee: a high-liquidity segment (flat
 * price, cheap entry) up to `kneeSqrtPrice`, then a thin segment (steep price)
 * to graduation. Buyers who enter early get a bargain; everyone after the knee
 * pushes price violently — the visual "pump" shape, deterministic on-chain.
 *
 * Both segments must absorb `migrationQuoteThreshold` in total; the split is
 * whatever the two liquidities produce given the knee price.
 */
export function buildKneeCurve(params: {
  sqrtStartPrice: bigint;
  migrationQuoteThreshold: bigint;
  swapBaseAmount: bigint;
  /** √P where the flat segment ends and the thin segment begins. */
  kneeSqrtPrice: bigint;
  /** Liquidity of the thin (post-knee) segment; the flat segment absorbs the rest. */
  tailLiquidity: bigint;
}): CurvePoint[] {
  const { sqrtStartPrice: ps, migrationQuoteThreshold: Q, swapBaseAmount: B, kneeSqrtPrice: pk } = params;
  if (B <= 0n || Q <= 0n) throw new Error("swapBaseAmount and migrationQuoteThreshold must be > 0");
  if (pk <= ps) throw new Error("kneeSqrtPrice must be above sqrtStartPrice");
  const pm = (Q * Q128) / (B * ps);
  if (pm <= pk) throw new Error("kneeSqrtPrice must be below the migration price");
  // quote absorbed by the thin segment from knee to migration (deltaQuote formula)
  const qTail = (params.tailLiquidity * (pm - pk)) / Q128;
  if (qTail >= Q) throw new Error("tailLiquidity is too large: the thin segment alone reaches graduation");
  const qFlat = Q - qTail;
  const LFlat = (qFlat * Q128) / (pk - ps);
  return [
    { sqrtPrice: pk, liquidity: LFlat },
    { sqrtPrice: pm, liquidity: params.tailLiquidity },
    { sqrtPrice: MAX_SQRT_PRICE, liquidity: params.tailLiquidity / 4n },
  ];
}

/** What `buildLaunchTransaction` produces: an unsigned tx plus the derived addresses. */
export interface BuiltLaunch {
  transaction: Transaction;
  /** Partial signers — the wallet only adds its signature on top. */
  signers: Keypair[];
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  plan: ReturnType<typeof supplyPlan>;
  leftover: bigint;
  /**
   * The cp-amm Config to pass as `remainingAccounts[0]` of `migrationDammV2`
   * when the curve graduates. Default: the zero-fee public config the live
   * Inference launch migrated through.
   */
  dammConfig: PublicKey;
}

/**
 * Browser path: build the launch transaction. Sign `signers` locally with
 * `transaction.partialSign(...)` (they are `init` accounts the program requires
 * as signers, never funded), then hand the tx to the wallet — it signs as fee
 * payer and sends.
 */
export async function buildLaunchTransaction(input: LaunchInput): Promise<BuiltLaunch> {
  const conn = input.connection;
  const payer = input.authority.publicKey;
  const decimals = input.decimals ?? 6;
  const quoteMint = input.quoteMint ?? NATIVE_MINT;
  const feeClaimer = input.feeClaimer ?? payer;
  const leftoverReceiver = input.leftoverReceiver ?? payer;
  const quoteDecimals = await decimalsOf(conn, quoteMint);

  const sqrtStart = sqrtPriceFromPrice(input.startPrice, decimals, quoteDecimals);
  const migrationQuoteThreshold = toRawUnits(input.graduationQuote, quoteDecimals);
  const preSupply = toRawUnits(input.totalSupply, decimals);
  // Base sold on the curve. Default 51% — the Inference shape; the rest of the
  // supply splits between the migration pool and the leftover reserve.
  const swapOnCurveWhole = input.swapOnCurve ?? input.totalSupply * 0.51;
  const swapOnCurve = toRawUnits(swapOnCurveWhole, decimals);
  const curve = input.curve ?? buildCurve({
    sqrtStartPrice: sqrtStart,
    migrationQuoteThreshold,
    swapBaseAmount: swapOnCurve,
  });

  const program = buildHandle(conn, payer);

  // Preflight exactly what create_config will derive, against the program's own floors.
  const pre = supplyPlan({
    sqrtStartPrice: sqrtStart,
    curve,
    migrationQuoteThreshold,
  });

  const postMigrationTokenSupply = input.postMigrationTokenSupply
    ? toRawUnits(input.postMigrationTokenSupply, decimals)
    : undefined;
  // Team allocation = locked_vesting with a zero cliff: the whole reserve is the
  // cliff_unlock_amount (claimable right after create_locker). frequency must be
  // non-zero to pass LockedVestingParams::validate, even with 0 periods.
  const teamAllocationTokens = input.teamAllocation
    ? toRawUnits(input.teamAllocation, decimals)
    : undefined;
  const { configParameters, plan, leftover, warnings } = planFixedSupplyLaunch({
    quoteMint,
    feeClaimer,
    leftoverReceiver,
    sqrtStartPrice: sqrtStart,
    curve,
    migrationQuoteThreshold,
    migrationBaseThreshold: pre.migrationBaseThreshold,
    preMigrationTokenSupply: preSupply,
    baseFee:
      input.baseFee ?? {
        cliffFeeNumerator: 850_000_000n, // 85%
        numberOfPeriod: 100,
        periodFrequency: 1n,
        reductionFactor: 8_250_000n,     // 0.825%/s -> 2.5% at t=100
        mode: 0, // FeeSchedulerLinear
      },
    creatorTradingFeePercentage: input.creatorTradingFeePercentage ?? 0,
    tokenAuthority: input.tokenAuthority ?? TokenAuthorityOption.Immutable,
    ...(postMigrationTokenSupply !== undefined ? { postMigrationTokenSupply } : {}),
    ...(teamAllocationTokens !== undefined
      ? {
          lockedVesting: {
            amountPerPeriod: 0n,
            cliffDurationFromMigrationTime: 0n,
            frequency: 1n,
            numberOfPeriod: 0n,
            cliffUnlockAmount: teamAllocationTokens,
          },
        }
      : {}),
    ...(input.migrationFeePercentage !== undefined
      ? { migrationFeePercentage: input.migrationFeePercentage }
      : {}),
    ...(input.creatorMigrationFeePercentage !== undefined
      ? { creatorMigrationFeePercentage: input.creatorMigrationFeePercentage }
      : {}),
    ...(input.liquiditySplit ? { liquiditySplit: input.liquiditySplit } : {}),
    ...(input.partnerLiquidityVesting ? { partnerLiquidityVesting: input.partnerLiquidityVesting } : {}),
    ...(input.creatorLiquidityVesting ? { creatorLiquidityVesting: input.creatorLiquidityVesting } : {}),
    ...(input.enableFirstSwapWithMinFee !== undefined
      ? { enableFirstSwapWithMinFee: input.enableFirstSwapWithMinFee }
      : {}),
    ...(input.poolCreationFee !== undefined
      ? { poolCreationFee: BigInt(Math.round(input.poolCreationFee)) }
      : {}),
  });

  if (warnings.length && !input.skipPreflight) {
    throw new Error(`launch preflight failed:\n  ${warnings.join("\n  ")}`);
  }

  const config = Keypair.generate(); // config is init + signer, not a PDA
  const baseMint = Keypair.generate(); // mint is init + signer, created by the ix
  const tokenQuoteProgram = await tokenProgramFor(conn, quoteMint);

  const cfgIx = await createConfig({
    program,
    config: config.publicKey,
    payer,
    feeClaimer,
    leftoverReceiver,
    quoteMint,
    configParameters,
    transferHookProgram: input.transferHookProgram,
  });
  const { instruction: poolIx, pool, baseVault, quoteVault } = await initializeVirtualPool({
    program,
    payer,
    creator: payer,
    config: config.publicKey,
    baseMint: baseMint.publicKey,
    quoteMint,
    params: { name: input.name, symbol: input.symbol, uri: input.uri },
    tokenQuoteProgram,
    transferHookProgram: input.transferHookProgram,
  });

  // Fee payer + blockhash are set here so partialSign works in the browser:
  // the wallet only appends its signature on top.
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const transaction = new Transaction().add(cfgIx, poolIx);
  transaction.feePayer = payer;
  transaction.recentBlockhash = blockhash;

  return {
    transaction,
    /** Partial signers — the wallet only adds its signature on top. */
    signers: [config, baseMint],
    config: config.publicKey,
    pool,
    baseMint: baseMint.publicKey,
    baseVault,
    quoteVault,
    plan,
    leftover,
    dammConfig: input.dammConfig ?? DEFAULT_DAMM_CONFIG,
  };
}

/**
 * Node path: build, sign everything locally (including the authority keypair),
 * send, confirm. Browsers should call `buildLaunchTransaction` and let the
 * wallet sign as fee payer instead.
 */
export async function launchToken(input: LaunchInput): Promise<LaunchResult> {
  const built = await buildLaunchTransaction(input);
  const signature = await sendAndConfirmTransaction(
    input.connection,
    built.transaction,
    [input.authority, ...built.signers],
    { commitment: "confirmed", skipPreflight: input.skipPreflight ?? false },
  );
  return {
    signature,
    config: built.config,
    pool: built.pool,
    baseMint: built.baseMint,
    baseVault: built.baseVault,
    quoteVault: built.quoteVault,
    plan: built.plan,
    leftover: built.leftover,
    dammConfig: built.dammConfig,
  };
}

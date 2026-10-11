import { Connection, Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_INSTRUCTIONS_PUBKEY, ComputeBudgetProgram } from "@solana/web3.js";
import { createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync, NATIVE_MINT as WSOL } from "@solana/spl-token";
import { buildLaunchTransaction, type LaunchInput, type BuiltLaunch } from "./launch.js";
import { exponentialFeeDecay, cliffVesting, feeAtElapsed } from "./fixed-supply.js";
import { BaseFeeMode } from "../constants.js";
import type { CurvePoint } from "../curve.js";
import { toRawUnits } from "../curve.js";
import { buildHandle, fetchPool } from "../program.js";
import { swap2, migrationDammV2, migrationDammV2CreateMetadata, withdrawLeftover, claimTradingFee2 } from "../ix.js";
import {
  lockTeamAllocation, claimTeamAllocation, pullAllLiquidity, refreshVesting,
  dammPositionNftAccount, dammPosition, dammTokenVault,
} from "./lp.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, DAMM_V2_PROGRAM_ID, POOL_AUTHORITY, BONDING_GUARD_PROGRAM_ID, TokenAuthorityOption } from "../constants.js";

/**
 * Launchpad operator — funding, allocation and recovery behind one easy API.
 *
 *   deploy(mode, opts)  → "standard" | "atomic"
 *   settle(opts)      → recover team + reserve + LP + fees in one sweep
 */

export type LaunchMode = "standard" | "atomic" | "locked";

/** Launch knobs tuned for a fully-allocated launch. Identity is NOT part of a
 * preset — `deploy` takes it from `DeployOpts.identity` and validates it, so a
 * token can never ship with the placeholder metadata. */
export function allocatorPreset(input: {
  totalSupply: number;
  graduationQuote: number;
  startPrice: number;
  teamAllocation: number;
  creatorLpPct: number;
  swapPct: number;
  postPct: number;
  feeCliffPct: number;
  feeEndPct: number;
  feeSeconds: number;
  enableFirstSwapMinFee?: boolean;
}): Omit<LaunchInput, "authority" | "connection" | "name" | "symbol" | "uri"> {
  const cliff = BigInt(Math.round(input.feeCliffPct * 1e7));
  const end = BigInt(Math.round(input.feeEndPct * 1e7));
  const periods = Math.max(1, input.feeSeconds);
  return {
    startPrice: input.startPrice,
    graduationQuote: input.graduationQuote,
    totalSupply: input.totalSupply,
    swapOnCurve: (input.totalSupply * input.swapPct) / 100,
    postMigrationTokenSupply: (input.totalSupply * input.postPct) / 100,
    teamAllocation: input.teamAllocation,
    liquiditySplit: {
      partnerLiquidityPercentage: 90 - input.creatorLpPct,
      partnerPermanentLockedLiquidityPercentage: 10,
      creatorLiquidityPercentage: input.creatorLpPct,
      creatorPermanentLockedLiquidityPercentage: 0,
    },
    baseFee: {
      cliffFeeNumerator: cliff,
      numberOfPeriod: periods,
      periodFrequency: 1n,
      reductionFactor: (cliff - end) / BigInt(periods),
      mode: 0,
    },
    enableFirstSwapWithMinFee: input.enableFirstSwapMinFee ?? true,
    skipPreflight: true,
  };
}

/**
 * The maximum-extraction shape, one call. Everything the program allows:
 *  - minimal curve float (swapPct floor) → maximum leftover reserve
 *  - 89% creator LP + 11% cliff-vested (100% claimable in 24h)
 *  - geometric fee (99% cliff, never bottoms out) to the fee claimer
 *  - team allocation = the leftover, claimable instantly after graduation
 *  - atomic: launch + graduate in one transaction
 * Locked-mode levers (jail, mint authority) are opt-in on top via `deploy`.
 */
export function maxExtractionPreset(input: {
  totalSupply: number;
  graduationQuote: number;
  startPrice: number;
}): Omit<LaunchInput, "authority" | "connection" | "name" | "symbol" | "uri"> {
  return {
    ...allocatorPreset({
      totalSupply: input.totalSupply,
      graduationQuote: input.graduationQuote,
      startPrice: input.startPrice,
      teamAllocation: 0, // leftover is already maximal; team eats it 1:1
      creatorLpPct: 89,
      swapPct: 20,       // minimal float → max leftover (~76% of supply)
      postPct: 30,       // small circulating supply post-migration
      feeCliffPct: 99,
      feeEndPct: 2,      // as bps%: 2% cut per period (geometric)
      feeSeconds: 600,
      enableFirstSwapMinFee: true,
    }),
    baseFee: exponentialFeeDecay({
      cliffFeePct: 99,
      reductionBps: 200,
      numberOfPeriod: 600,
      periodFrequency: 1n,
    }),
  };
}

export interface DeployOpts {
  authority: Keypair;
  connection: Connection;
  mode: LaunchMode;
  identity: { name: string; symbol: string; uri: string };
  startPrice: number;
  graduationQuote: number;
  totalSupply: number;
  teamAllocation?: number;
  creatorLpPct?: number;
  swapPct?: number;
  postPct?: number;
  feeCliffPct?: number;
  feeEndPct?: number;
  feeSeconds?: number;
  /** Retain mint authority (inflation) — transfer-hook ("locked") configs only. */
  retainMintAuthority?: boolean;
  /** Override the transfer hook program (defaults to bonding-guard on "locked"). */
  transferHookProgram?: PublicKey;
  /**
   * Exponential fee decay instead of linear: `cliffFeePct * (1 - reductionBps/10000)^period`.
   * Geometric decay never bottoms out — the fee stays far above a linear schedule's
   * endpoint long after the schedule "ends" (`feeEndPct` is ignored when set).
   */
  feeReductionBps?: number;
  /** Exponential-fee period count (default: feeSeconds) and period length in seconds (default 1). */
  feePeriods?: number;
  feePeriodSeconds?: number;
  /** Explicit curve segments — bypasses the default shape. Use `buildKneeCurve`. */
  curve?: CurvePoint[];
  /**
   * Vest the non-creator LP slice instead of permanently locking it: a cliff at
   * `lpCliffSeconds` (> 86400) passes the 10%-locked-at-24h floor and then unlocks
   * fully, so the slice is claimable instead of dead. Default on: 86401s.
   */
  lpCliffSeconds?: number | false;
}

/** Deploy a token with a chosen mode. "atomic" = launch+finalize in one tx. */
export async function deploy(opts: DeployOpts): Promise<AtomicLaunch | BuiltLaunch & { baseAta: PublicKey }> {
  // a token with placeholder/empty metadata indexes as "unknown" on explorers —
  // reject it up front so a deploy never ships without a real identity
  const name = opts.identity?.name?.trim();
  const symbol = opts.identity?.symbol?.trim();
  const uri = opts.identity?.uri?.trim();
  if (!name || !symbol) throw new Error("deploy: identity.name and identity.symbol are required");
  if (!uri || uri === "https://ipfs.io/ipfs/v0" || !/^https?:\/\/|^ipfs:\/\//.test(uri)) {
    throw new Error("deploy: identity.uri must be a real metadata JSON (http/https/ipfs), not a placeholder");
  }
  const input = allocatorPreset({
    totalSupply: opts.totalSupply,
    graduationQuote: opts.graduationQuote,
    startPrice: opts.startPrice,
    teamAllocation: opts.teamAllocation ?? 0,
    creatorLpPct: opts.creatorLpPct ?? 0,
    swapPct: opts.swapPct ?? 40,
    postPct: opts.postPct ?? 100,
    feeCliffPct: opts.feeCliffPct ?? 85,
    feeEndPct: opts.feeEndPct ?? (opts.mode === "atomic" ? 0.25 : 2.5),
    feeSeconds: opts.feeSeconds ?? 100,
    enableFirstSwapMinFee: opts.mode === "atomic",
  });
  const baseInput: LaunchInput = {
    ...input,
    authority: opts.authority,
    connection: opts.connection,
    name,
    symbol,
    uri,
  };

  // exponential decay replaces the linear schedule entirely
  if (opts.feeReductionBps) {
    baseInput.baseFee = exponentialFeeDecay({
      cliffFeePct: opts.feeCliffPct ?? 85,
      reductionBps: opts.feeReductionBps,
      numberOfPeriod: opts.feePeriods ?? opts.feeSeconds ?? 100,
      periodFrequency: BigInt(opts.feePeriodSeconds ?? 1),
    });
  }
  if (opts.curve) baseInput.curve = opts.curve;

  // vest the partner slice instead of the default 10% permanent lock:
  // cliff > 86400 passes the floor check, then unlocks fully.
  // The floor computes locked bps with Rounding::Down, and 10% vested lands at 999 bps —
  // one short of the 1000 floor. Bump the vesting bucket by 1%, taken from whichever
  // unlocked slice can spare it (partner first, else creator).
  if (opts.lpCliffSeconds !== false) {
    const cliff = typeof opts.lpCliffSeconds === "number" ? opts.lpCliffSeconds : 86_401;
    const split = baseInput.liquiditySplit!;
    const vestPct = split.partnerPermanentLockedLiquidityPercentage + 1;
    if (split.partnerLiquidityPercentage > 0) split.partnerLiquidityPercentage -= 1;
    else split.creatorLiquidityPercentage -= 1;
    baseInput.partnerLiquidityVesting = { ...cliffVesting(cliff), vestingPercentage: vestPct };
    split.partnerPermanentLockedLiquidityPercentage = 0;
  }

  // "locked" launches attach a transfer hook so the token only moves through
  // the curve during bonding; graduation revokes it and graduates normally.
  if (opts.mode === "locked" || opts.transferHookProgram) {
    baseInput.transferHookProgram = opts.transferHookProgram ?? BONDING_GUARD_PROGRAM_ID;
    if (opts.retainMintAuthority) {
      baseInput.tokenAuthority = TokenAuthorityOption.CreatorUpdateAndMintAuthority;
    }
  }

  if (opts.mode === "atomic") return atomicLaunch(baseInput);

  const built = await buildLaunchTransaction(baseInput);
  const baseAta = getAssociatedTokenAddressSync(built.baseMint, opts.authority.publicKey, true, TOKEN_2022_PROGRAM_ID);
  return { ...built, baseAta };
}

/**
 * Claim the bonding-phase trading fee (80% → fee_claimer) in one tx. Safe to
 * call on a loop — returns `null` when there is nothing left to claim, so a
 * collector can just call it every N seconds while the curve is live.
 */
export async function collectFees(opts: {
  connection: Connection;
  authority: Keypair;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  feeClaimer: PublicKey;
  tokenBaseProgram: PublicKey;
  tokenQuoteProgram: PublicKey;
  /** "locked" launches only — the transfer-hook program id for the CPI extra account. */
  transferHookProgram?: PublicKey;
}): Promise<string | null> {
  const { authority: payer, connection: conn } = opts;
  // nothing accrued → skip the tx entirely (fields may decode as number or bigint)
  const pool = await fetchPool(conn, opts.pool);
  if (!pool) return null;
  if (Number(pool.partnerBaseFee) === 0 && Number(pool.partnerQuoteFee) === 0) return null;

  const baseAta = getAssociatedTokenAddressSync(opts.baseMint, opts.feeClaimer, true, opts.tokenBaseProgram);
  const quoteAta = getAssociatedTokenAddressSync(opts.quoteMint, opts.feeClaimer, true, opts.tokenQuoteProgram);
  const pre = [];
  if (!(await conn.getAccountInfo(baseAta, "confirmed"))) pre.push(createAssociatedTokenAccountInstruction(payer.publicKey, baseAta, opts.feeClaimer, opts.baseMint, opts.tokenBaseProgram));
  if (!(await conn.getAccountInfo(quoteAta, "confirmed"))) pre.push(createAssociatedTokenAccountInstruction(payer.publicKey, quoteAta, opts.feeClaimer, opts.quoteMint, opts.tokenQuoteProgram));

  const program = buildHandle(conn, payer.publicKey);
  try {
    const claimIx = await claimTradingFee2({
      program, config: opts.config, pool: opts.pool,
      baseMint: opts.baseMint, quoteMint: opts.quoteMint,
      feeClaimer: opts.feeClaimer,
      tokenBaseProgram: opts.tokenBaseProgram, tokenQuoteProgram: opts.tokenQuoteProgram,
      transferHookProgram: opts.transferHookProgram,
    });
    const t = new Transaction().add(...pre, claimIx);
    t.feePayer = payer.publicKey;
    t.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    t.partialSign(payer);
    const s = await conn.sendRawTransaction(t.serialize(), { skipPreflight: true });
    await conn.confirmTransaction(s, "confirmed");
    // on-chain revert (e.g. nothing left) surfaces here, not as a client throw
    const res = await conn.getTransaction(s, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (res?.meta?.err) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Atomic launch: `[create_config, init_pool, create base ATA, giant first-swap]`
 * in ONE transaction. The first swap pays the config floor fee (not the cliff)
 * and a PartialFill giant buy walks the curve to graduation.
 */
export async function atomicLaunch(input: LaunchInput): Promise<AtomicLaunch> {
  const conn = input.connection;
  const payer = input.authority;
  const quoteMint = input.quoteMint ?? WSOL;
  const built = await buildLaunchTransaction(input);

  const program = buildHandle(conn, payer.publicKey);

  const wsolAta = getAssociatedTokenAddressSync(quoteMint, payer.publicKey, true, TOKEN_PROGRAM_ID);
  const baseAta = getAssociatedTokenAddressSync(built.baseMint, payer.publicKey, true, TOKEN_2022_PROGRAM_ID);

  // floor fee = what the first-swap actually pays (end of the decay schedule)
  const bf = input.baseFee;
  let floorNum = 25_000_000n; // 2.5%
  if (bf) {
    if (bf.mode === BaseFeeMode.FeeSchedulerExponential) {
      // geometric decay: floor = cliff·(1−bps/10000)^periods — reuse the exact Q64.64 math
      floorNum = feeAtElapsed(bf, Number(bf.periodFrequency) * bf.numberOfPeriod);
    } else {
      const n = bf.cliffFeeNumerator - bf.reductionFactor * BigInt(bf.numberOfPeriod);
      if (n >= 0n) floorNum = n;
    }
  }
  const threshold = toRawUnits(input.graduationQuote, 9);
  const gross = ((threshold * 1_000_000_000n) / (1_000_000_000n - floorNum)) * 102n / 100n;

  const swapIx = await swap2({
    program,
    payer: payer.publicKey,
    config: built.config,
    pool: built.pool,
    baseMint: built.baseMint,
    quoteMint,
    inputTokenAccount: wsolAta,
    outputTokenAccount: baseAta,
    amount0: gross,
    amount1: 0n,
    swapMode: 1, // PartialFill
    tokenBaseProgram: TOKEN_2022_PROGRAM_ID,
    tokenQuoteProgram: TOKEN_PROGRAM_ID,
    // first-swap-at-min-fee: the program scans the tx via the instruction sysvar
    // for the initialize_pool instruction (validate_contain_initialize_pool_ix_and_no_cpi)
    remainingAccounts: [{ pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isWritable: false, isSigner: false }],
  });

  built.transaction.add(
    createAssociatedTokenAccountInstruction(payer.publicKey, baseAta, payer.publicKey, built.baseMint, TOKEN_2022_PROGRAM_ID),
    swapIx,
  );
  return { ...built, baseAta, wsolAta, gross };
}

export interface AtomicLaunch extends BuiltLaunch {
  baseAta: PublicKey;
  /** wSOL ATA the giant first-swap spends from — the wallet must hold `gross` wSOL here. */
  wsolAta: PublicKey;
  /** The gross quote amount (lamports) the first swap will spend (PartialFill clips overshoot). */
  gross: bigint;
}

export interface SettleOpts {
  connection: Connection;
  authority: Keypair;
  built: BuiltLaunch;
  /** cp-amm Program (load `idl/damm_v2.json`). */
  dammProgram: any;
  /** locker Program — required only when teamAllocation > 0. */
  lockerProgram?: any;
  quoteMint?: PublicKey;
  firstPositionNftMint?: Keypair;
  secondPositionNftMint?: Keypair;
  teamAllocation?: number;
}

/**
 * Full recovery after graduation: lock+claim team → finalize → withdraw
 * reserve → pull LP → claim fee. Returns every signature.
 */
export async function settle(opts: SettleOpts): Promise<string[]> {
  const { connection: conn, authority, built, dammProgram: cpAmm } = opts;
  const quoteMint = opts.quoteMint ?? WSOL;
  const sigs: string[] = [];
  const program = buildHandle(conn, authority.publicKey);
  const send = async (t: Transaction) => {
    t.feePayer = authority.publicKey;
    t.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
    t.partialSign(authority);
    const s = await conn.sendRawTransaction(t.serialize(), { skipPreflight: true });
    await conn.confirmTransaction(s, "confirmed");
    sigs.push(s);
  };

  // 1) team allocation: lock (pre-migration) + claim (atomic)
  if (opts.teamAllocation && opts.teamAllocation > 0 && opts.lockerProgram) {
    const { fundInstruction, instruction: ataIx, lockInstruction, escrow } = await lockTeamAllocation({
      connection: conn, creator: authority, config: built.config, pool: built.pool, baseMint: built.baseMint,
    });
    await send(new Transaction().add(fundInstruction, ataIx, lockInstruction));
    const claimIx = await claimTeamAllocation(opts.lockerProgram, { escrow, claimant: authority.publicKey, tokenMint: built.baseMint });
    await send(new Transaction().add(claimIx));
  }

  // 2) finalize to DAMM v2 (fund pool_authority for the flash_rent first)
  await send(new Transaction().add(SystemProgram.transfer({ fromPubkey: authority.publicKey, toPubkey: POOL_AUTHORITY, lamports: 3_000_000_000 })));
  const metaIx = await migrationDammV2CreateMetadata({ program, config: built.config, pool: built.pool, payer: authority.publicKey });
  await send(new Transaction().add(metaIx));

  const dammPool = PublicKey.findProgramAddressSync([Buffer.from("pool"), built.dammConfig.toBuffer(), built.baseMint.toBuffer(), quoteMint.toBuffer()], DAMM_V2_PROGRAM_ID)[0];
  const nft1 = opts.firstPositionNftMint ?? Keypair.generate();
  const nft2 = opts.secondPositionNftMint ?? Keypair.generate();
  const migIx = await migrationDammV2({
    program, config: built.config, pool: built.pool, baseMint: built.baseMint, quoteMint,
    payer: authority.publicKey, dammPool,
    firstPositionNftMint: nft1.publicKey, firstPositionNftAccount: dammPositionNftAccount(nft1.publicKey), firstPosition: dammPosition(nft1.publicKey),
    secondPositionNftMint: nft2.publicKey, secondPositionNftAccount: dammPositionNftAccount(nft2.publicKey), secondPosition: dammPosition(nft2.publicKey),
    tokenAVault: dammTokenVault(dammPool, built.baseMint), tokenBVault: dammTokenVault(dammPool, quoteMint),
    tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID,
    remainingAccounts: [{ pubkey: built.dammConfig, isWritable: false, isSigner: false }],
  });
  const migTx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 700_000 }),
    migIx,
  );
  migTx.feePayer = authority.publicKey;
  migTx.recentBlockhash = (await conn.getLatestBlockhash("confirmed")).blockhash;
  migTx.partialSign(authority, nft1, nft2);
  const migSig = await conn.sendRawTransaction(migTx.serialize(), { skipPreflight: true });
  await conn.confirmTransaction(migSig, "confirmed");
  {
    const res = await conn.getTransaction(migSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (res?.meta?.err) {
      const logs = (res.meta.logMessages ?? []).filter((l) => /rror|failed|constraint/i.test(l));
      throw new Error(`migration reverted: ${JSON.stringify(res.meta.err)} :: ${logs.slice(0, 3).join(" | ")}`);
    }
  }
  sigs.push(migSig);

  // 3) reserve + LP pull + fees
  const leftIx = await withdrawLeftover({ program, config: built.config, pool: built.pool, baseMint: built.baseMint, leftoverReceiver: authority.publicKey, tokenBaseProgram: TOKEN_2022_PROGRAM_ID });
  await send(new Transaction().add(leftIx));

  for (const nft of [nft2, nft1]) {
    try {
      // cliff-vested slices: refresh first so anything past its cliff is withdrawable
      try {
        const refreshIx = await refreshVesting(cpAmm, { pool: dammPool, positionNftMint: nft.publicKey, owner: authority.publicKey });
        await send(new Transaction().add(refreshIx));
      } catch { /* position without vesting — nothing to refresh */ }
      const pullIx = await pullAllLiquidity(cpAmm, {
        pool: dammPool, positionNftMint: nft.publicKey, owner: authority.publicKey,
        tokenAMint: built.baseMint, tokenBMint: quoteMint,
        tokenAProgram: TOKEN_2022_PROGRAM_ID, tokenBProgram: TOKEN_PROGRAM_ID,
      });
      await send(new Transaction().add(pullIx));
    } catch { /* position may not exist (creator 0%) */ }
  }

  try {
    const feeIx = await claimTradingFee2({ program, config: built.config, pool: built.pool, baseMint: built.baseMint, quoteMint, feeClaimer: authority.publicKey, tokenBaseProgram: TOKEN_2022_PROGRAM_ID, tokenQuoteProgram: TOKEN_PROGRAM_ID });
    await send(new Transaction().add(feeIx));
  } catch { /* no fees accrued */ }

  return sigs;
}
import { BN } from "@coral-xyz/anchor";
import { PublicKey, Connection, Keypair, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import { DAMM_V2_PROGRAM_ID, DBC_PROGRAM_ID, LOCKER_PROGRAM_ID, POOL_AUTHORITY, TOKEN_2022_PROGRAM_ID } from "../constants.js";
import { buildHandle, fetchPool } from "../program.js";
import { createLocker } from "../ix.js";

/**
 * Post-graduation: pull LP + team allocation.
 *
 * Two independent mechanisms, both verified against the Rust source:
 *
 * 1. LP pull — the graduated DAMM v2 position NFT (90% unlocked / 10%
 *    permanently locked under our launch defaults). `removeAllLiquidity`
 *    withdraws every unlocked unit into the NFT owner's ATAs and closes the
 *    position in one instruction; `claimPositionFee` sweeps the accrued fees
 *    first. The signer must be the position's owner (whoever holds the NFT —
 *    `fee_claimer` under our defaults).
 *
 * 2. Team allocation — the `locked_vesting` reserve set at create_config.
 *    `createLocker` (DBC, creator-signed, runs at PostBondingCurve — before
 *    migration) moves that reserve out of the pool vault into a Meteora locker
 *    vesting escrow owned by the pool creator, with cliff + linear unlock
 *    measured from curve completion. `claimTeamAllocation` then pulls the
 *    unlocked slice. `updateVestingEscrowRecipient` re-points the escrow at
 *    any team wallet — the allocation can be assigned after launch.
 */

// ── DAMM v2 (cp-amm) PDAs ────────────────────────────────────────────────────

/** seeds: ["position", nft_mint] on cp-amm */
export const dammPosition = (nftMint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("position"), nftMint.toBuffer()], DAMM_V2_PROGRAM_ID)[0];

/** seeds: ["position_nft_account", nft_mint] on cp-amm */
export const dammPositionNftAccount = (nftMint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("position_nft_account"), nftMint.toBuffer()], DAMM_V2_PROGRAM_ID)[0];

/** seeds: ["token_vault", mint, pool] on cp-amm (mint first, then pool). */
export const dammTokenVault = (pool: PublicKey, mint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("token_vault"), mint.toBuffer(), pool.toBuffer()], DAMM_V2_PROGRAM_ID)[0];

/**
 * Rent the createLocker CPI flash-borrows on pool_authority. The escrow rent
 * observed on localnet is ~2.95 SOL; 3 SOL covers it with margin.
 */
export const POOL_AUTHORITY_RENT_LAMPORTS = 3_000_000_000n;

/** seeds: ["base_locker", pool] on DBC — the CPI base for the vesting escrow. */
export const lockerBase = (pool: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("base_locker"), pool.toBuffer()], DBC_PROGRAM_ID)[0];

/** seeds: ["escrow", base_locker_pda(pool)] on the locker program. */
export const lockerEscrow = (pool: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("escrow"), lockerBase(pool).toBuffer()],
    LOCKER_PROGRAM_ID,
  )[0];

/**
 * The escrow's token account — a plain ATA owned by the escrow PDA
 * (locker IDL: seeds [escrow, token_program, token_mint] under the ATA
 * program). The DBC `create_locker` CPI requires it to exist FIRST;
 * callers pre-create it in the same transaction.
 */
export const lockerEscrowToken = (escrow: PublicKey, tokenMint: PublicKey, tokenProgram = TOKEN_2022_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(tokenMint, escrow, true, tokenProgram);

// ── LP pull ──────────────────────────────────────────────────────────────────

/** Accrued-but-unclaimed fees plus the withdrawable liquidity of a position. */
export async function positionBalances(
  connection: Connection,
  position: PublicKey,
): Promise<{ feeA: bigint; feeB: bigint; unlockedLiquidity: bigint; vestedLiquidity: bigint; permanentLocked: bigint }> {
  const info = await connection.getAccountInfo(position, "confirmed");
  if (!info) throw new Error(`position not found: ${position.toBase58()}`);
  // Position layout (after 8-byte discriminator), per DAMM v2 IDL:
  // pool(32) nft_mint(32) fee_a_cp[u8;32] fee_b_cp[u8;32]
  // fee_a_pending u64 fee_b_pending u64 unlocked u128 vested u128 permanent u128
  const d = info.data;
  const u64 = (o: number) => BigInt(d.readBigUInt64LE(o));
  const u128 = (o: number) => u64(o) | (u64(o + 8) << 64n);
  return {
    feeA: u64(128),
    feeB: u64(136),
    unlockedLiquidity: u128(144),
    vestedLiquidity: u128(160),
    permanentLocked: u128(176),
  };
}

/**
 * Sweep the accrued fees of a graduated position into the owner's ATAs.
 * Signer: the position's owner.
 */
export async function claimPositionFee(cpAmm: any, a: {
  pool: PublicKey;
  positionNftMint: PublicKey;
  owner: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAProgram: PublicKey;
  tokenBProgram: PublicKey;
}) {
  return cpAmm.methods
    .claimPositionFee()
    .accounts({
      pool: a.pool,
      position: dammPosition(a.positionNftMint),
      tokenAAccount: getAssociatedTokenAddressSync(a.tokenAMint, a.owner, true, a.tokenAProgram),
      tokenBAccount: getAssociatedTokenAddressSync(a.tokenBMint, a.owner, true, a.tokenBProgram),
      tokenAVault: dammTokenVault(a.pool, a.tokenAMint),
      tokenBVault: dammTokenVault(a.pool, a.tokenBMint),
      tokenAMint: a.tokenAMint,
      tokenBMint: a.tokenBMint,
      positionNftAccount: dammPositionNftAccount(a.positionNftMint),
      signer: a.owner,
      tokenAProgram: a.tokenAProgram,
      tokenBProgram: a.tokenBProgram,
    })
    .instruction();
}

/**
 * Recompute a position's vesting state (owner-signed) so vested liquidity that
 * has since unlocked becomes withdrawable. Required before `pullAllLiquidity`
 * can withdraw a cliff-vested slice after the cliff passes.
 */
export async function refreshVesting(cpAmm: any, a: {
  pool: PublicKey;
  positionNftMint: PublicKey;
  owner: PublicKey;
}) {
  return cpAmm.methods
    .refreshVesting()
    .accounts({
      pool: a.pool,
      position: dammPosition(a.positionNftMint),
      positionNftAccount: dammPositionNftAccount(a.positionNftMint),
      owner: a.owner,
    })
    .instruction();
}

/**
 * Withdraw the entire unlocked + vested liquidity of a graduated position into
 * the owner's ATAs, in one instruction (thresholds are slippage bounds; 0
 * accepts whatever the math gives).
 *
 * A cliff-vested slice (`cliffVesting` / `lpCliffSeconds`) must have had
 * `refreshVesting` run after the cliff; a truly `permanent` lock never unlocks.
 */
export async function pullAllLiquidity(cpAmm: any, a: {
  pool: PublicKey;
  positionNftMint: PublicKey;
  owner: PublicKey;
  tokenAMint: PublicKey;
  tokenBMint: PublicKey;
  tokenAProgram: PublicKey;
  tokenBProgram: PublicKey;
  tokenAAmountThreshold?: bigint;
  tokenBAmountThreshold?: bigint;
}) {
  return cpAmm.methods
    .removeAllLiquidity(
      new BN((a.tokenAAmountThreshold ?? 0n).toString()),
      new BN((a.tokenBAmountThreshold ?? 0n).toString()),
    )
    .accounts({
      pool: a.pool,
      position: dammPosition(a.positionNftMint),
      tokenAAccount: getAssociatedTokenAddressSync(a.tokenAMint, a.owner, true, a.tokenAProgram),
      tokenBAccount: getAssociatedTokenAddressSync(a.tokenBMint, a.owner, true, a.tokenBProgram),
      tokenAVault: dammTokenVault(a.pool, a.tokenAMint),
      tokenBVault: dammTokenVault(a.pool, a.tokenBMint),
      tokenAMint: a.tokenAMint,
      tokenBMint: a.tokenBMint,
      positionNftAccount: dammPositionNftAccount(a.positionNftMint),
      signer: a.owner,
      tokenAProgram: a.tokenAProgram,
      tokenBProgram: a.tokenBProgram,
    })
    .instruction();
}

// ── team allocation (locked vesting) ─────────────────────────────────────────

/** The vesting reserve carried in the config, in base units. */
export function teamAllocationTotal(cfg: Record<string, any>): bigint {
  const lv = cfg.lockedVestingConfig;
  return lv.amountPerPeriod * lv.numberOfPeriod + lv.cliffUnlockAmount;
}

/**
 * Move the config's `locked_vesting` reserve out of the pool vault into a
 * locker escrow owned by the pool creator. Must run at
 * `migration_progress == PostBondingCurve` — i.e. after the curve completes
 * and BEFORE `migration_damm_v2`. Signer: the pool creator.
 *
 * The escrow address is deterministic: PDA("escrow", PDA("base_locker", pool))
 * on the locker program — no keypair to keep.
 *
 * The CPI flash-rents pool_authority: the caller must fund pool_authority with
 * >= POOL_AUTHORITY_RENT_LAMPORTS first (a plain system transfer; the CPI
 * repays it in the same instruction). Returns THREE instructions:
 * `fundInstruction` (creator -> pool_authority), `instruction` (pre-create
 * the escrow ATA — the locker requires it), `lockInstruction` (the lock).
 * Add all three to one transaction, in that order.
 */
export async function lockTeamAllocation(a: {
  connection: Connection;
  creator: Keypair;
  config: PublicKey;
  pool: PublicKey;
  baseMint: PublicKey;
  tokenProgram?: PublicKey;
}) {
  const pool = await fetchPool(a.connection, a.pool);
  if (!pool) throw new Error("pool not found");
  const tokenProgram = a.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const program = buildHandle(a.connection, a.creator.publicKey);
  const escrow = lockerEscrow(a.pool);
  const escrowToken = lockerEscrowToken(escrow, a.baseMint, tokenProgram);
  const fundInstruction = SystemProgram.transfer({
    fromPubkey: a.creator.publicKey,
    toPubkey: POOL_AUTHORITY,
    lamports: POOL_AUTHORITY_RENT_LAMPORTS,
  });
  const ix = await createLocker({
    program,
    config: a.config,
    pool: a.pool,
    baseMint: a.baseMint,
    creator: a.creator.publicKey,
    escrow,
    escrowToken,
    payer: a.creator.publicKey,
    tokenProgram,
  });
  // The locker CPI requires the escrow's ATA to exist first — pre-create it in
  // the same transaction, right before the lock.
  const preCreate = createAssociatedTokenAccountIdempotentInstruction(
    a.creator.publicKey,
    escrowToken,
    escrow,
    a.baseMint,
    tokenProgram,
  );
  return { fundInstruction, instruction: preCreate, lockInstruction: ix, escrow };
}

/**
 * Claim the unlocked slice of the team escrow. Signer: the escrow recipient
 * (the pool creator, or whoever the escrow was re-pointed at). Claims land
 * directly in the recipient's ATA.
 */
export async function claimTeamAllocation(locker: any, a: {
  escrow: PublicKey;
  claimant: PublicKey;
  tokenMint: PublicKey;
  tokenProgram?: PublicKey;
  maxAmount?: bigint;
}) {
  const tokenProgram = a.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  return locker.methods
    // maxAmount=0 claims nothing; default to u64::MAX ("claim everything unlocked").
    .claimV2(new BN((a.maxAmount ?? 18446744073709551615n).toString()), null)
    .accounts({
      escrow: a.escrow,
      tokenMint: a.tokenMint,
      escrowToken: lockerEscrowToken(a.escrow, a.tokenMint),
      recipient: a.claimant,
      recipientToken: getAssociatedTokenAddressSync(a.tokenMint, a.claimant, true, tokenProgram),
      memoProgram: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
      tokenProgram,
    })
    .instruction();
}

/**
 * Re-point the team escrow at a different wallet. Signer: the CURRENT
 * recipient. Lets a launch assign the team slice after the fact, or rotate
 * the payout wallet (fits the one-shot-wallet rotation strategy).
 */
export async function reassignTeamAllocation(locker: any, a: {
  escrow: PublicKey;
  currentRecipient: PublicKey;
  newRecipient: PublicKey;
}) {
  return locker.methods
    .updateVestingEscrowRecipient(a.newRecipient, null)
    .accounts({
      escrow: a.escrow,
      escrowMetadata: null, // IDL-optional; null means "no metadata account"
      signer: a.currentRecipient,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * Mint new base tokens to `to`'s ATA. Only works while the launch retains mint
 * authority: `deploy({ mode: "locked", retainMintAuthority: true })` — the
 * program gates mint-authority retention to transfer-hook configs, and
 * graduation revokes the transfer hook but NEVER the mint authority.
 * Signer: whoever holds the mint authority (the pool creator).
 */
export async function mintTo(connection: Connection, authority: Keypair, a: {
  mint: PublicKey;
  to: PublicKey;
  amount: bigint;
  tokenProgram?: PublicKey;
}) {
  const tokenProgram = a.tokenProgram ?? TOKEN_2022_PROGRAM_ID;
  const ata = getAssociatedTokenAddressSync(a.mint, a.to, true, tokenProgram);
  const instructions: any[] = [createAssociatedTokenAccountIdempotentInstruction(authority.publicKey, ata, a.to, a.mint, tokenProgram)];
  const { createMintToInstruction } = await import("@solana/spl-token");
  instructions.push(createMintToInstruction(a.mint, ata, authority.publicKey, BigInt(a.amount.toString()), [], tokenProgram));
  const tx = new (await import("@solana/web3.js")).Transaction();
  tx.add(...instructions);
  tx.feePayer = authority.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.partialSign(authority);
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

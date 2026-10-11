import { Connection, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { ASSOCIATED_TOKEN_PROGRAM_ID } from "../constants.js";
import { camel } from "../layout.js";

/** Little-endian u64. */
export const u64le = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
/**
 * `TransferHookAccountsInfo { slices: [{ accounts_type: TransferHookBase, length: 1 }] }`
 * — the "this transfer has a hook, and the hook needs one extra account (its own
 * program id)" encoding. anchor 0.31's instruction coder drops the enum-bearing
 * slice element, so these 6 bytes are hand-rolled wherever the arg appears.
 */
export const HOOK_ACCOUNTS_INFO = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x01]);

/**
 * Instruction layer.
 *
 * Shapes come from the vendored IDL, so there is exactly one generic builder;
 * the wrappers below only add PDA derivation and account plumbing for the paths
 * that actually get used. Anything not wrapped is still reachable via
 * `buildInstruction(name, args, accounts)`.
 */

/**
 * Build one instruction from the IDL.
 *
 * `name` accepts either spelling — the IDL's `snake_case` or Anchor's
 * `camelCase` — because every other identifier in this SDK is snake_case and
 * silently throwing on `"withdraw_leftover"` would be a footgun.
 *
 * `accounts` values are pubkeys except `null`, which marks an IDL-optional
 * account as deliberately absent (Anchor requires the key present for optional
 * accounts — omitting it throws "not provided").
 *
 * `remainingAccounts` are appended after the IDL's fixed accounts; instructions
 * that need them (e.g. `migrationDammV2`, which takes the DAMM v2 position
 * accounts) are unbuildable without.
 */
export async function buildInstruction(
  program: any,
  name: string,
  args: any[] = [],
  accounts: Record<string, PublicKey | null> = {},
  remainingAccounts: { pubkey: PublicKey; isWritable?: boolean; isSigner?: boolean }[] = [],
): Promise<TransactionInstruction> {
  const method = program.methods[name] ?? program.methods[camel(name)];
  if (!method) throw new Error(`instruction not in IDL: ${name}`);
  return method(...args)
    .accounts(accounts)
    .remainingAccounts(
      remainingAccounts.map((r) => ({
        pubkey: r.pubkey,
        isWritable: r.isWritable ?? false,
        isSigner: r.isSigner ?? false,
      })),
    )
    .instruction();
}

/** Token program that owns `mint` — never assume Token-2022. */
export async function tokenProgramFor(connection: Connection, mint: PublicKey): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) throw new Error(`mint not found: ${mint.toBase58()}`);
  return info.owner;
}

/**
 * Resolve the token program for a mint, honouring an explicit override.
 *
 * Never assume `TOKEN_PROGRAM_ID`: a hardcoded default silently breaks every
 * Token-2022 quote mint. When no override is given the mint's owner is read from
 * chain — which requires the program's provider connection; building offline
 * must pass the override explicitly or it throws.
 */
export async function resolveTokenProgram(
  program: any,
  mint: PublicKey,
  override?: PublicKey,
): Promise<PublicKey> {
  if (override) return override;
  const connection: Connection | undefined = program?.provider?.connection;
  if (!connection) {
    throw new Error(
      `cannot derive the token program for ${mint.toBase58()} without a provider connection — ` +
        `pass tokenProgram / tokenQuoteProgram explicitly when building offline`,
    );
  }
  return tokenProgramFor(connection, mint);
}

export const ata = (mint: PublicKey, owner: PublicKey, tokenProgram: PublicKey) =>
  getAssociatedTokenAddressSync(mint, owner, true, tokenProgram, ASSOCIATED_TOKEN_PROGRAM_ID);

// ── config ───────────────────────────────────────────────────────────────────

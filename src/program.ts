import { AnchorProvider, Program, type Idl } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  type Commitment,
  type GetProgramAccountsFilter,
} from "@solana/web3.js";
import idlJson from "../idl/dbc.json" with { type: "json" };
import { DBC_PROGRAM_ID } from "./constants.js";
import { accountDiscriminator, structLayout } from "./layout.js";
import { decodeAccount } from "./decode.js";

const IDL = idlJson as unknown as Idl;

/** Anchor program handle — only needed to *build* instructions, not to decode. */
export function getProgram(connection: Connection, wallet?: any, commitment: Commitment = "confirmed") {
  const provider = new AnchorProvider(connection, wallet ?? ({} as any), { commitment });
  return new Program(IDL as any, provider) as any;
}

/**
 * Anchor handle for a **read/tx-building** session: no wallet, just a payer
 * pubkey. Instruction building needs a provider but never a real signer —
 * every recipe in this SDK signs transactions itself. Use this instead of
 * hand-writing the same `{ publicKey, signTransaction: async … }` stub.
 */
export function buildHandle(connection: Connection, payer: PublicKey) {
  return getProgram(connection, {
    publicKey: payer,
    signTransaction: async (t: any) => t,
    signAllTransactions: async (t: any) => t,
  } as any);
}

export const programId = DBC_PROGRAM_ID;

/** Decode by account name, flattening the single-field wrapper accounts. */
function decodeNamed(name: string, data: Uint8Array): Record<string, any> {
  return name === "VirtualPool" || name === "TransferHookPool"
    ? (decodeAccount(name, data).poolState as Record<string, any>)
    : decodeAccount(name, data);
}

/** Read one account's bytes; null when the account does not exist. */
async function fetchRaw(connection: Connection, address: PublicKey): Promise<Uint8Array | null> {
  const info = await connection.getAccountInfo(address, "confirmed");
  return info ? new Uint8Array(info.data) : null;
}

/** Read + decode any DBC account by name. Returns null when it does not exist. */
export async function fetchAccount<T = Record<string, any>>(
  connection: Connection,
  address: PublicKey,
  accountName: string,
): Promise<T | null> {
  const data = await fetchRaw(connection, address);
  return data ? (decodeNamed(accountName, data) as T) : null;
}

/** Read + decode by fixed account type; null when missing. */
function fetcher(accountName: string) {
  return (connection: Connection, address: PublicKey) =>
    fetchAccount(connection, address, accountName);
}

export const fetchPoolConfig = async (c: Connection, address: PublicKey) => {
  const data = await fetchRaw(c, address);
  if (!data) return null;
  // transfer-hook launches wrap the same fields in `ConfigWithTransferHook`
  try {
    return decodeAccount("PoolConfig", data);
  } catch {
    return decodeAccount("ConfigWithTransferHook", data).config as Record<string, any>;
  }
};
export const fetchTokenBadge = fetcher("TokenBadge");
export const fetchOperator = fetcher("Operator");
export const fetchClaimFeeOperator = fetcher("ClaimFeeOperator");
export const fetchPartnerMetadata = fetcher("PartnerMetadata");

/** Flattened `PoolState` fields — `VirtualPool` wraps a single `pool_state`. */
export const fetchPool = async (c: Connection, address: PublicKey) => {
  const data = await fetchRaw(c, address);
  if (!data) return null;
  // transfer-hook launches use a `TransferHookPool` account (same `pool_state`,
  // different discriminator) until graduation revokes the hook.
  try {
    return decodeAccount("VirtualPool", data).poolState as Record<string, any>;
  } catch {
    return decodeAccount("TransferHookPool", data).poolState as Record<string, any>;
  }
};

/**
 * Server-side account scan.
 *
 * Every account carries its discriminator at offset 0, so a scan is a memcmp on
 * that plus any extra filters — e.g. `fixed_token_supply_flag == 1` at offset 244
 * to surface every config that has a `leftover_receiver` payout armed.
 *
 * ponytail: unfiltered scans pull the whole account set (PoolConfig alone is
 * ~542k accounts / ~570 MB on mainnet). Pass `countOnly` for a cheap census, or
 * use a filter — a full decode needs a paid RPC or an archive node.
 */
export async function findAccounts(
  connection: Connection,
  accountName: string,
  extraFilters: GetProgramAccountsFilter[] = [],
  opts: { countOnly?: boolean } = {},
): Promise<{ address: PublicKey; account: Record<string, any> }[]> {
  const disc = accountDiscriminator(accountName);
  const raw = await connection.getProgramAccounts(DBC_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.from(disc).toString("base64"), encoding: "base64" } },
      ...extraFilters,
    ],
    ...(opts.countOnly ? { dataSlice: { offset: 0, length: 0 } } : {}),
  });
  return raw.map(({ pubkey, account }) => ({
    address: pubkey,
    account: opts.countOnly ? {} : decodeNamed(accountName, new Uint8Array(account.data)),
  }));
}

/**
 * Byte offset of a field inside an account, discriminator included.
 * Dotted paths walk nested structs: `fieldOffset("VirtualPool", "pool_state.migration_progress")`.
 */
export function fieldOffset(accountName: string, path: string): number {
  let offset = 8; // discriminator
  let struct = accountName;
  for (const part of path.split(".")) {
    const field_ = structLayout(struct, 0).find((f) => f.name === part);
    if (!field_) throw new Error(`no field ${part} on ${struct}`);
    offset += field_.offset;
    struct = field_.type;
  }
  return offset;
}

/** Every PoolConfig that pays a leftover on migration. */
export function findFixedSupplyConfigs(connection: Connection) {
  return findAccounts(connection, "PoolConfig", [
    { memcmp: { offset: fieldOffset("PoolConfig", "fixed_token_supply_flag"), bytes: "2", encoding: "base58" } },
  ]);
}

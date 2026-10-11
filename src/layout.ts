import idl from "../idl/dbc.json" with { type: "json" };

/**
 * IDL-driven Borsh layout tables.
 *
 * Anchor accounts are `8-byte discriminator || borsh(fields)` and the IDL carries
 * the exact field order, so offsets are derived instead of hand-maintained. A
 * hardcoded offset table silently rots the moment the program is upgraded; this
 * one cannot.
 *
 * Only fixed-size types are supported — that is every field of every DBC account.
 */

type IdlType =
  | string
  | { defined: { name: string } }
  | { option: IdlType }
  | { vec: IdlType }
  | { array: [IdlType, number] };

export interface FieldLayout {
  name: string;
  /** IDL type rendered as a string, for display. */
  type: string;
  offset: number;
  size: number;
}

export interface AccountLayout {
  name: string;
  discriminator: Uint8Array;
  fields: FieldLayout[];
  /** Total account size including the discriminator. */
  size: number;
}

const IDL = idl as any;

const FIXED: Record<string, number> = {
  u8: 1, i8: 1, bool: 1,
  u16: 2, i16: 2,
  u32: 4, i32: 4,
  u64: 8, i64: 8,
  u128: 16, i128: 16,
  u256: 32, i256: 32,
  pubkey: 32,
};

function definedFields(name: string): any[] | undefined {
  const t = IDL.types?.find((x: any) => x.name === name);
  return t?.type?.kind === "struct" ? t.type.fields : undefined;
}

export function typeName(t: IdlType): string {
  if (typeof t === "string") return t;
  if ("defined" in t) return t.defined.name;
  if ("option" in t) return `option<${typeName(t.option)}>`;
  if ("vec" in t) return `vec<${typeName(t.vec)}>`;
  if ("array" in t) return `[${typeName(t.array[0])}; ${t.array[1]}]`;
  return JSON.stringify(t);
}

export function sizeOf(t: IdlType): number {
  if (typeof t === "string") {
    const size = FIXED[t];
    if (size === undefined) throw new Error(`unknown fixed type: ${t}`);
    return size;
  }
  if ("defined" in t) {
    const fields = definedFields(t.defined.name);
    if (!fields) throw new Error(`unknown struct: ${t.defined.name}`);
    return fields.reduce((acc, f) => acc + sizeOf(f.type), 0);
  }
  if ("option" in t) return 1 + sizeOf(t.option);
  if ("array" in t) return t.array[1] * sizeOf(t.array[0]);
  throw new Error(`variable-size type is not decodable: ${typeName(t)}`);
}

export function structLayout(name: string, baseOffset = 0): FieldLayout[] {
  const fields = definedFields(name);
  if (!fields) throw new Error(`struct not in IDL: ${name}`);
  const out: FieldLayout[] = [];
  let offset = baseOffset;
  for (const f of fields) {
    const size = sizeOf(f.type);
    out.push({ name: f.name, type: typeName(f.type), offset, size });
    offset += size;
  }
  return out;
}

/**
 * Account discriminator only — no sizing, so it works for accounts that carry
 * variable-length fields (`PartnerMetadata`, `VirtualPoolMetadata` both have
 * `string`s and cannot be laid out with `accountLayout`).
 */
export function accountDiscriminator(name: string): Uint8Array {
  const acc = IDL.accounts?.find((a: any) => a.name === name);
  if (!acc) throw new Error(`account not in IDL: ${name}`);
  return Uint8Array.from(acc.discriminator);
}

/**
 * Full field layout for a fixed-size account.
 *
 * Throws for accounts with variable-length fields (`string`, `vec`) — those
 * cannot be addressed by static offset. Use `accountDiscriminator` when you only
 * need to identify the account.
 */
export function accountLayout(name: string): AccountLayout {
  const acc = IDL.accounts?.find((a: any) => a.name === name);
  if (!acc) throw new Error(`account not in IDL: ${name}`);
  const fields = structLayout(name, 8);
  const body = fields.reduce((m, f) => Math.max(m, f.offset + f.size), 8);
  return {
    name,
    discriminator: Uint8Array.from(acc.discriminator),
    fields,
    size: body,
  };
}

/** Account names whose layout is static (no `string`/`vec` fields). */
export function fixedSizeAccounts(): string[] {
  return (IDL.accounts ?? [])
    .map((a: any) => a.name as string)
    .filter((name: string) => {
      try {
        accountLayout(name);
        return true;
      } catch {
        return false;
      }
    });
}

/** snake_case -> camelCase, the spelling Anchor uses for `program.methods`. */
export const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

/** IDL field lists for a struct type; undefined when the type is not a struct. */
export function idlTypeFields(name: string): any[] | undefined {
  const t = IDL.types?.find((x: any) => x.name === name);
  return t?.type?.kind === "struct" ? t.type.fields : undefined;
}

export function instructionDiscriminator(name: string): Uint8Array {
  const ix = IDL.instructions?.find((i: any) => i.name === name);
  if (!ix) throw new Error(`instruction not in IDL: ${name}`);
  return Uint8Array.from(ix.discriminator);
}

export function instructionNames(): string[] {
  return (IDL.instructions ?? []).map((i: any) => i.name);
}

export const idlMetadata = IDL.metadata as { name: string; version: string };

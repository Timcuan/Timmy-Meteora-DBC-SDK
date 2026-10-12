import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "./constants.js";

/**
 * Token identity for a launch/clone — the three on-chain fields a DBC launch
 * writes (`name`, `symbol`, `uri`) plus the display context that lives *inside*
 * the metadata JSON (`image`, `description`).
 *
 * On-chain the mint only carries `name`/`symbol`/`uri`; the logo and links are
 * fields of the JSON that `uri` points at. `image` here is resolved from that
 * JSON (or Jupiter's `icon` for plain SPL), so a clone shows the right avatar
 * and the launch is handed a `uri` that indexers can resolve to an image.
 */
export interface TokenIdentity {
  name: string;
  symbol: string;
  /** Metadata JSON URL. Empty when the token has no resolvable metadata (plain SPL). */
  uri: string;
  /** Logo URL — from the metadata JSON `image`, or Jupiter `icon`. */
  image: string;
  description: string;
}

// A `uri` must resolve for the token to be listed well, so the fetch rewrites a
// dead host onto a live gateway while leaving the original `uri` intact for the
// launch (indexers resolve that, not this).
//
// Only gateways verified to answer are listed. The previous list led with
// ipfs.io, which returns 429 with a service-worker deprecation notice, and also
// carried cloudflare-ipfs.com and w3s.link, which do not answer at all. Leading
// with a dead gateway made every metadata read pay a timeout first.
//
// Order is measured, not conventional: across three CIDs, Pinata's public
// gateway answered 429 to all three while Filebase served all three, so Filebase
// goes first and Pinata is kept as the fallback. Both are still tried, because a
// rate limit is per-IP and temporary.
export const IPFS_GATEWAYS = [
  "https://ipfs.filebase.io",
  "https://gateway.pinata.cloud",
];

/** Hosts that no longer serve content. A `uri` pointing at one is a trap: it
 *  resolves for nobody, so the token launches with no logo and a weak listing. */
const DEAD_GATEWAY_HOSTS = [
  "ipfs.io",
  "dweb.link",
  "cloudflare-ipfs.com",
  "w3s.link",
  "ipfs.infura.io",
];

/** The CID inside an `ipfs://` URI or a `/ipfs/<cid>` path, or null. */
export function ipfsCid(uri: string): string | null {
  const m = uri.match(/^ipfs:\/\/(.+)$/) || uri.match(/\/ipfs\/(.+)$/);
  return m ? m[1].split("?")[0].replace(/\/+$/, "") : null;
}

/** True when a URI points at a gateway that no longer answers. */
export function usesDeadGateway(uri: string): boolean {
  const cid = ipfsCid(uri);
  if (!cid) return false;
  try {
    return DEAD_GATEWAY_HOSTS.some((h) => new URL(uri).hostname === h);
  } catch {
    return false;
  }
}

/** Every URL worth trying for a URI: the URI itself, then each live gateway. */
export function gatewayCandidates(uri: string): string[] {
  const cid = ipfsCid(uri);
  if (!cid) return [uri];
  return IPFS_GATEWAYS.map((g) => `${g}/ipfs/${cid}`);
}

/**
 * A URL that actually serves the image.
 *
 * The reference launch's metadata points its `image` at ipfs.io, which returns
 * 429, so the raw field is not displayable even though the token is indexed
 * (Jupiter rewrites gateways itself). Rewriting the host here is what makes the
 * logo appear in the console preview.
 *
 * This is the pure rewrite, with no network. Use `firstReachable` when the URL
 * is about to be shown, since any single gateway can be rate-limited.
 */
export function resolvableImageUrl(image: string): string {
  if (!image) return "";
  return usesDeadGateway(image) ? gatewayCandidates(image)[0] ?? image : image;
}

/** The first candidate URL for an asset that actually answers, or null. */
async function firstReachable(url: string): Promise<string | null> {
  for (const c of gatewayCandidates(url)) {
    if (await urlReachable(c)) return c;
  }
  return null;
}

async function fetchJson(url: string): Promise<Record<string, any> | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

/** Try the metadata `uri` through every live gateway (a dead host is rewritten). */
async function fetchMetadataJson(uri: string): Promise<Record<string, any> | null> {
  for (const c of gatewayCandidates(uri)) {
    const j = await fetchJson(c);
    if (j) return j;
  }
  return null;
}

/** Does this URL serve anything? The body is cancelled once the status is known. */
async function urlReachable(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    const ok = r.ok;
    await r.body?.cancel();
    return ok;
  } catch {
    return false;
  }
}

export interface MetadataCheck {
  ok: boolean;
  /** Why it failed, in terms a launcher can act on. */
  reason?: string;
  /** Warnings that do not block a launch. */
  warnings: string[];
  metadata?: { name: string; symbol: string; image: string; description: string };
  /** A displayable image URL, with a dead gateway rewritten. */
  imageUrl?: string;
}

/**
 * Validate the metadata `uri` a launch is about to write on-chain.
 *
 * The mint carries only name/symbol/uri, so this JSON is the entire source of
 * the logo, the description and every rich listing. A URI that does not resolve
 * costs real SOL to discover: the launch succeeds, the token has no image, and
 * indexers rank it lower. Everything here is checkable before signing.
 */
export async function checkMetadataUri(
  uri: string,
  expected?: { name?: string; symbol?: string },
): Promise<MetadataCheck> {
  const trimmed = (uri ?? "").trim();
  const warnings: string[] = [];
  if (!trimmed) return { ok: false, reason: "no metadata URI", warnings };

  const json = await fetchMetadataJson(trimmed);
  if (!json) {
    return { ok: false, reason: `nothing at ${trimmed} parsed as JSON`, warnings };
  }

  const name = String(json.name ?? "");
  const symbol = String(json.symbol ?? "");
  const image = String(json.image ?? "");
  const description = String(json.description ?? "");

  if (!image) {
    return { ok: false, reason: "the JSON has no image field, so the token has no logo", warnings, metadata: { name, symbol, image, description } };
  }

  if (usesDeadGateway(trimmed)) {
    warnings.push("this URI points at a gateway that no longer serves content; indexers may fail to read it");
  }

  // Try every live gateway, not just the rewritten first one: a single gateway
  // rate-limits (Pinata's public host answered 429 to every CID tried while
  // Filebase served all of them), and a 429 must not read as "your logo is gone".
  const imageUrl = await firstReachable(image);
  if (!imageUrl) {
    return {
      ok: false,
      reason: `the image at ${image} does not load from any live gateway`,
      warnings, metadata: { name, symbol, image, description },
    };
  }

  if (expected?.name && name && name !== expected.name) {
    warnings.push(`the JSON says name "${name}" but the form says "${expected.name}"`);
  }
  if (expected?.symbol && symbol && symbol.toLowerCase() !== expected.symbol.toLowerCase()) {
    warnings.push(`the JSON says symbol "${symbol}" but the form says "${expected.symbol}"`);
  }
  if (!name || !symbol) {
    warnings.push("the JSON is missing name or symbol; some indexers read only the JSON");
  }
  if (!description) {
    warnings.push("no description in the JSON");
  }

  return { ok: true, warnings, metadata: { name, symbol, image, description }, imageUrl };
}

interface JupiterToken {
  id: string;
  name?: string;
  symbol?: string;
  icon?: string;
}

/**
 * Resolve a token's name/symbol/uri/image from, in order:
 *   1. the on-chain Token-2022 `tokenMetadata` extension (authoritative name/symbol/uri),
 *   then its metadata JSON (image/description);
 *   2. Jupiter's token search (name/symbol/icon) for plain SPL or non-extension tokens.
 *
 * `uri` stays empty on the Jupiter fallback (Jupiter gives an icon, not a metadata
 * JSON) — a launch still needs a real metadata `uri`, which the caller supplies.
 */
export async function fetchTokenIdentity(
  mint: PublicKey,
  connection: Connection,
): Promise<TokenIdentity> {
  const mintStr = mint.toBase58();

  // 1) Token-2022 metadata extension — authoritative name/symbol/uri.
  try {
    const acc = await connection.getParsedAccountInfo(mint, "confirmed");
    const v = acc?.value;
    if (v && v.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()) {
      const info = (v.data as any)?.parsed?.info;
      const meta = (info?.extensions ?? []).find((e: any) => e.extension === "tokenMetadata");
      if (meta?.state?.name) {
        const name: string = meta.state.name;
        const symbol: string = meta.state.symbol;
        const uri: string = meta.state.uri ?? "";
        const json = uri ? await fetchMetadataJson(uri) : null;
        return {
          name,
          symbol,
          uri,
          image: String(json?.image ?? ""),
          description: String(json?.description ?? ""),
        };
      }
    }
  } catch {
    /* fall through to Jupiter */
  }

  // 2) Jupiter search — name/symbol/icon for plain SPL / non-extension tokens.
  const r = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mintStr)}`);
  const list = (await r.json()) as JupiterToken[];
  const t = Array.isArray(list) ? list.find((x) => x.id === mintStr) ?? list[0] : null;
  if (!t) throw new Error(`token not found on-chain or on Jupiter (${mintStr})`);
  return { name: String(t.name ?? ""), symbol: String(t.symbol ?? ""), uri: "", image: t.icon ?? "", description: "" };
}
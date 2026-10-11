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

// ipfs.io is 429/service-worker-deprecated; try a few gateways for the *fetch*,
// but keep the original `uri` intact for the launch (it is what indexers resolve).
const IPFS_GATEWAYS = [
  "https://ipfs.io",
  "https://gateway.pinata.cloud",
  "https://cloudflare-ipfs.com",
  "https://w3s.link",
];

async function fetchJson(url: string): Promise<Record<string, any> | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, any>;
  } catch {
    return null;
  }
}

/** Try the metadata `uri` through every gateway (rewriting an ipfs.io host when present). */
async function fetchMetadataJson(uri: string): Promise<Record<string, any> | null> {
  const candidates = [uri];
  if (uri.includes("/ipfs/")) {
    const cidPath = uri.slice(uri.indexOf("/ipfs/") + "/ipfs/".length);
    for (const g of IPFS_GATEWAYS) candidates.push(`${g}/ipfs/${cidPath}`);
  }
  for (const c of candidates) {
    const j = await fetchJson(c);
    if (j) return j;
  }
  return null;
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
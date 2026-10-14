# @timc/meteora-sdk

Meteora **Dynamic Bonding Curve** (DBC) SDK. Live program `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`, IDL **0.2.1** — all **34 instructions**, 10 accounts, 70 types.

Built from the on-chain program, not from the published SDK's surface: the IDL was extracted out of the official npm bundle, every discriminator was re-verified against the deployed `.so`, and every account offset is derived from the IDL rather than hand-written.

## Integrating as a launchpad (Jupiter-style / multi-tenant)

The whole surface a launchpad needs, in one import:

```ts
import {
  buildLaunchTransaction,   // browser path: unsigned tx + partial signers → wallet signs
  launchToken,              // node path: sign-and-send
  deploy, settle,           // operator path: full lifecycle (mode: standard | atomic | locked)
  collectFees,              // bonding-phase fee sweep (loop-safe, returns null when empty)
  fetchPool, fetchPoolConfig, analyzePoolConfig, analyzeVirtualPool,  // read/monitor any DBC pool
  fetchTokenIdentity,       // clone/prefill: name/symbol/uri/image from any mint
  registerPartner, partnerRevenue, creatorRevenue,  // white-label multi-tenant fee routing
  swap2,                    // exact-in / partial-fill / exact-out, transfer-hook aware
  BONDING_GUARD_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, DEFAULT_DAMM_CONFIG,
  type LaunchMode, type LaunchInput, type DeployOpts,
} from "@timc/meteora-sdk";
```

Two integration shapes, same builders underneath:
- **Wallet flow** (Phantom/Solflare/Ledger): `buildLaunchTransaction` returns `{ transaction, signers }` — partial-sign the `signers`, hand the tx to the wallet. Nothing sensitive crosses the wire; the wallet is fee payer.
- **Custodial flow** (server-side launchpad): `launchToken` / `deploy` sign with a passed keypair and send.

Every knob is validated client-side before the tx is built (metadata realness, supply floors, fee bounds, split sums) so a bad config dies before the user signs, not on-chain.

## Verify it yourself

```bash
bun install
bun run verify      # 169 assertions against pinned mainnet fixtures
bun run typecheck
```

`verify` decodes real mainnet accounts (`Inference` / `inf`, 2026-10-09) and asserts the SDK's output against values the **program itself** stored — plus two live transactions (`withdraw_leftover` and `migration_damm_v2`) rebuilt byte for byte, accounts and data. No assertion is checked against this SDK's own output.

Re-pin to a newer pool: `bun run scripts/make-fixtures.ts`.

## Layout

| file | what |
|---|---|
| `src/constants.ts` | program ids, every enum, seed prefixes, fee/curve constants |
| `src/pda.ts` | all PDAs — pool, vaults, badge, operator, metadata, locker, event authority |
| `src/layout.ts` | IDL-driven Borsh offset tables |
| `src/decode.ts` | account decoder + `analyzePoolConfig` / `analyzeVirtualPool` |
| `src/curve.ts` | exact bigint curve math + offline supply plan |
| `src/token-identity.ts` | token metadata: `fetchTokenIdentity`, `checkMetadataUri`, the IPFS gateway helpers |
| `src/program.ts` | Anchor handle, `fetch*`, filtered `getProgramAccounts` scans |
| `src/ix.ts` | instruction builders |
| `src/recipes/fixed-supply.ts` | `planFixedSupplyLaunch`, `feeDecay`, `feeAtElapsed` |
| `src/recipes/launch.ts` | `launchToken`, `buildLaunchTransaction`, `buildCurve` |
| `src/recipes/lp.ts` | LP pull/claim + team allocation (locked vesting) |
| `src/recipes/partner.ts` | partner/creator revenue (register, claim streams) |
| `src/recipes/operator.ts` | high-level orchestration (`deploy`, `settle`, `collectFees`, `allocatorPreset`, `maxExtractionPreset`) |
| `programs/bonding-guard/` | the transfer-hook program (Token-2022). `build.sh` bakes `TREASURY_WALLET` at compile time; `deploy.sh` = gated one-command deploy (refuses without a valid treasury, checks absence + fee-payer funding, then `solana program deploy`) |

## Recipes — what each high-level call ACTUALLY does

The low-level `ix.ts` mirrors the IDL 1:1. The `recipes/*` files are the parts
you reach for. Because the SDK favours neutral naming, here is the decoder —
every high-level call, the DBC instruction(s) it dispatches, and its real
effect — so nothing is ambiguous later.

### operator.ts — the whole launch lifecycle in three calls

| call | dispatches | real effect |
|---|---|---|
| `allocatorPreset(opts)` | (offline) | builds the `LaunchInput` knobs: supply split (`swapOnCurve` → reserve), `teamAllocation`, `liquiditySplit` (creator LP), `migrationFee`, `poolCreationFee`, fee cliff, first-swap min fee |
| `maxExtractionPreset(input)` | (offline) | every lever at once: minimal curve float, 89% creator LP + 11% cliff-vested, geometric 99% fee, atomic graduation |
| `mintTo(conn, authority, {mint, to, amount})` | Token-2022 `mint_to` | inflation lever. Requires `deploy({ mode:"locked", retainMintAuthority:true })` — the program keeps mint authority with the creator even after graduation revokes the transfer hook |
| `deploy(opts)` | `create_config` + `initialize_virtual_pool` (+ `swap2` if `atomic`) | launches. `mode:"standard"` = plain launch. `mode:"atomic"` = launch **and** graduate in one tx (a giant first-swap walks the curve to threshold at min fee) |
| `settle(opts)` | `create_locker` + `claim_v2` + `migration_damm_v2` + `withdraw_leftover` + `remove_all_liquidity` + `claim_trading_fee2` | full post-graduation recovery: team allocation → migrate → reserve withdrawal → LP pull → fee claim, in order |
| `collectFees(opts)` | `claim_trading_fee2` | one-shot sweep of the 80% bonding trading fee. Safe to loop (returns `null` when nothing accrued) |
| `atomicLaunch(input)` | as `deploy("atomic")` | the bare launch+finalize bundle |

### launch.ts — plain launch

`launchToken(input)` / `buildLaunchTransaction(input)` → `create_config` +
`initialize_virtual_pool` in one tx (browser path returns an unsigned tx +
partial signers). `input` carries every allocation knob (see `allocatorPreset`):
`swapOnCurve`, `postMigrationTokenSupply`, `teamAllocation`, `liquiditySplit`,
`migrationFeePercentage`, `creatorMigrationFeePercentage`, `poolCreationFee`,
`creatorTradingFeePercentage`, `enableFirstSwapWithMinFee`, `tokenAuthority`.

### lp.ts — liquidity + team allocation (post-launch)

| call | real effect |
|---|---|
| `pullAllLiquidity(cpAmm, …)` | `remove_all_liquidity` on a DAMM v2 position → base + quote into the owner's ATAs |
| `claimPositionFee(cpAmm, …)` | `claim_position_fee` → sweep fees from a (locked) position, recurring |
| `positionBalances(conn, pos)` | read a position's unlocked/vested/permanently-locked liquidity + fees |
| `lockTeamAllocation(…)` | `create_locker` → moves the locked-vesting reserve into a locker escrow (pre-migration) |
| `claimTeamAllocation(locker, …)` | `claim_v2` → withdraw the team reserve (instantly, when cliff=0) |
| `reassignTeamAllocation(locker, …)` | `update_vesting_escrow_recipient` → point the escrow at another wallet |
| `teamAllocationTotal(cfg)` | the configured vested-total (base units) |

### partner.ts — partner & creator revenue

`registerPartner` (`create_partner_metadata`), `partnerRevenue` (trading fee +
surplus + pool-creation fee), `creatorRevenue` (creator trading fee + creator
surplus + migration fee), `transferCreator` (`transfer_pool_creator`). The
"partner" here is whoever owns `config.fee_claimer` — the destination of 80%
trading fee, 90% pool-creation fee, surplus share, migration fee, and the
permanent locked-LP fee stream.

## Read a launch

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import { fetchPoolConfig, fetchPool, analyzePoolConfig, analyzeVirtualPool } from "@timc/meteora-sdk";

const conn = new Connection(RPC, "confirmed");
const cfg  = await fetchPoolConfig(conn, configAddress);
const pool = await fetchPool(conn, poolAddress);

const a  = analyzePoolConfig(cfg);
const pa = analyzeVirtualPool(pool, cfg);

a.fixedTokenSupply        // token_supply present?
a.supply.leftover         // base tokens reserved for leftover_receiver
a.supply.leftoverBpsOfSupply
a.fee.cliffFeePct         // 85
a.fee.finalFeePct         // 2.5
a.fee.decaySeconds        // 100
pa.migrationProgressName  // "CreatedPool"
pa.withdrawLeftoverEligible
pa.pending.lifetime       // metrics, monotonic
pa.pending.unclaimed      // currently claimable
```

## Token metadata

`initializeVirtualPool` (both the SPL and the Token-2022 variant) writes
`name`/`symbol`/`uri` into the mint and **drops the metadata authority**, so the
`uri` is permanent — a URI that does not resolve cannot be corrected after the
launch. On Token-2022 that lands in the `tokenMetadata` extension with a
`metadataPointer` at the mint itself. The JSON at `uri` is the entire source of
the logo, the description and the rich listings.

Check it before signing, not after:

```ts
import { checkMetadataUri } from "@timc/meteora-sdk";

const check = await checkMetadataUri("ipfs://Qm...", { name: "Inference", symbol: "inf" });
check.ok         // resolves to JSON, has an image, and the image loads
check.reason     // why not, in terms a launcher can act on
check.metadata   // { name, symbol, image, description }
check.imageUrl   // displayable URL, rewritten off a dead gateway
check.warnings   // JSON disagrees with the form, missing description, dead gateway, ...
```

Gateway helpers — pure, except where the fetch is named:

| call | purpose |
|---|---|
| `ipfsCid(uri)` | CID from `ipfs://…` or a `/ipfs/…` path, else `null` |
| `usesDeadGateway(uri)` | the URI points at a host that no longer serves content |
| `gatewayCandidates(uri)` | live gateway URLs to try, in order |
| `resolvableImageUrl(image)` | rewrite for display; no network |
| `IPFS_GATEWAYS` | the ordered live list |

## The leftover mechanism

`create_config` with `token_supply` set makes the program reserve

```
preMigrationTokenSupply − swapBaseAmount − migrationBaseThreshold − lockedVesting
```

and hand it to `config.leftover_receiver` through **`withdraw_leftover`**, once the curve graduates. `withdraw_leftover` pays `base_vault.amount − base fees − protocol_migration_base_fee`, gated on `migration_progress == CreatedPool` + `fixed_token_supply_flag == 1` + `is_withdraw_leftover == 0`.

Because those tokens sit inside the pool vault and never in a wallet while the curve runs, holder/dev-distribution scans see only the on-curve float. Measured on mainnet: **522,275 of 542,618** PoolConfigs carry `fixed_token_supply_flag == 1` — this is the DBC default, not an edge case.

`planFixedSupplyLaunch` reproduces the whole thing offline and returns the exact numbers the program will derive, plus warnings for every floor it enforces (`InvalidTokenSupply`, `InvalidLeftoverAddress`, the 25% swap buffer, the liquidity-split total).

```ts
const { configParameters, plan, leftover, warnings } = planFixedSupplyLaunch({
  quoteMint, feeClaimer, leftoverReceiver,     // leftoverReceiver must not be the default pubkey
  sqrtStartPrice, curve, migrationQuoteThreshold,
  preMigrationTokenSupply: 1_000_000_000_000_000n,
  baseFee: feeDecay({ cliffFeePct: 85, endFeePct: 2.5, seconds: 100 }),
});
if (warnings.length) throw new Error(warnings.join("\n"));
```

## Instruction coverage

Wrapped: `createConfig`(+transfer-hook), `initializeVirtualPool`(SPL / Token-2022 / transfer-hook), `swap2`(+transfer-hook), `withdrawLeftover`, `withdrawMigrationFee`, `claimTradingFee2`, `createOperatorAccount`, `createTokenBadge`, `migrationDammV2`, `migrationDammV2CreateMetadata`, `createLocker`.

Anything else is reachable generically — the IDL is the source of truth, so there is one builder, not 34 wrappers. All 34 IDL instructions are asserted reachable in `verify`:

```ts
// accepts the IDL's snake_case or Anchor's camelCase
await buildInstruction(program, "claim_partner_pool_creation_fee", [], { ...accounts });
await buildInstruction(program, "claimPartnerPoolCreationFee", [], { ...accounts });
```

Instructions that take accounts beyond the IDL's fixed list need `remainingAccounts` — a real `migration_damm_v2` passes the DAMM v2 position accounts that way (25 fixed + 3 remaining on mainnet):

```ts
await buildInstruction(program, name, args, accounts, [
  { pubkey: positionAccount, isWritable: true },
]);
```

Paths the published SDK's write surface does **not** expose: `create_operator_account`, `create_token_badge` / `close_token_badge`, `claim_partner_pool_creation_fee`, `claim_protocol_pool_creation_fee`, `claim_protocol_fee2`, `claim_creator_trading_fee2`, `initialize_virtual_pool_with_spl_token`, `swap2_with_transfer_hook`.

## Gotchas

- **`BaseFeeConfig` field order is reordered for backward compatibility**: `second_factor` = `period_frequency`, `third_factor` = `reduction_factor`, `first_factor` = `number_of_period`. Reading them positionally gets the fee schedule wrong.
- **ppm denominator is 1e9**, not 1e6. `cliffFeeNumerator 850_000_000` = 85%.
- **`CollectFeeMode` has two variants** (QuoteToken/OutputToken). `Compounding` exists only as `MigratedCollectFeeMode`, post-graduation.
- **`migrationBaseThreshold` is an estimate** when computed locally (~4 ppm off — it routes through the migration-fee handler). Pass the real value from a live config to be exact; `plan.migrationBaseEstimated` tells you which you got.
- **`TokenAuthorityOption`**: `CreatorUpdateAuthority=0, Immutable=1, PartnerUpdateAuthority=2`, and the mint-authority variants (3, 4) are transfer-hook configs only.
- **`VirtualPool` wraps a single `pool_state`** — the decoders flatten it so you get the fields directly.
- **`accountLayout` throws for accounts with `string` fields** (`PartnerMetadata`, `VirtualPoolMetadata`) — they cannot be addressed by static offset. Use `accountDiscriminator` when you only need to identify one; `fixedSizeAccounts()` lists the ones that can be laid out.
- **Program-wide scans are expensive**: PoolConfig alone is ~542k accounts. Use a filter or `{ countOnly: true }`; a full decode needs a paid RPC.
- `withdraw_leftover` is once per pool (`is_withdraw_leftover` flag) and only while `migration_progress == CreatedPool`.
- **`feeDecay` is linear-only** and throws for any other mode. `FeeSchedulerExponential` reads `reduction_factor` as basis points per period, not as an absolute numerator delta, so it cannot be derived from a start/end pair — deriving one silently produced a schedule decaying to 3.3e+293%.
- **Exponential fee math is Q64.64, not repeated integer division.** `feeAtElapsed` mirrors the program's square-and-multiply with a truncating `>> 64` per step; the naive per-step `(acc * base) / 10000` drifts by ~9 numerator units over 100 periods.
- **Token programs are derived from the mint, never assumed.** Hardcoding `TOKEN_PROGRAM_ID` for the quote side breaks every Token-2022 quote mint. `initializeVirtualPool` and `withdrawMigrationFee` read the mint's owner via the program's provider connection; pass `tokenProgram` / `tokenQuoteProgram` explicitly only when building offline.
- **`buildInstruction` accepts snake_case or camelCase**, and takes a 5th `remainingAccounts` argument. Without it, instructions like `migration_damm_v2` cannot be built at all.
- **The IPFS gateways most references name are dead.** `ipfs.io` and `dweb.link` answer 429 with a service-worker deprecation notice; `cloudflare-ipfs.com` and `w3s.link` answer nothing at all. Measured live and reliable: `ipfs.filebase.io`. `gateway.pinata.cloud` works but rate-limits hard — it answered 429 to every CID in one run while Filebase served all of them. Try every candidate, not just the first, or a 429 on one host reads as "your image is gone".
- **Indexed does not mean resolvable.** The `Inference` fixture's metadata points its `image` at `ipfs.io` and Jupiter still returns an icon for it, because Jupiter rewrites gateways itself. Never use "it appears in the indexer" as proof that a URL works.
- **Enumerating a wallet's token accounts is browser-hostile.** Indexed requests are refused on the free RPCs regardless of CORS, so anything built on `getTokenAccountsByOwner` (or `getProgramAccounts`) has to run in a node process. Test the exact method from a browser origin before designing a page around it.

## Account types on mainnet

Measured live, discriminator-filtered:

| account | count |
|---|---|
| `PoolConfig` | 542,618 |
| `TransferHookPool` | 6,069 |
| `TokenBadge` | 2,375 |
| `Operator` | 1 |
| `ClaimFeeOperator` | **0** |
| `VirtualPool` | *(~522k, one per config)* |

`ClaimFeeOperator` (`cf_operator` seed) has **zero instances** — it is superseded by `Operator`. Its discriminator therefore could not be validated against live chain state; it is verified only against the IDL and the deployed `.so`, where its two 4-byte halves appear separately rather than as one contiguous 8-byte value (the other nine account discriminators appear contiguously).

## Fixture

`scripts/fixtures/mainnet.json` pins `Inference` (`inf`) — a fixed-supply DBC launch where the dev withdrew the leftover and dumped it, netting ~96 SOL from a ~0.06 SOL float. Useful as a worked example of every field this SDK decodes.

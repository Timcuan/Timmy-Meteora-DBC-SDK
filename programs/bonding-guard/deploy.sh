#!/usr/bin/env bash
# Deploy bonding-guard to mainnet. Gated, one command.
#   TREASURY_WALLET=<pubkey> ./deploy.sh
# Optional: RPC (default mainnet-beta), KEYPAIR (program keypair path).
#
# Program id: target/deploy/bonding-guard-keypair.json — fund THAT wallet first
# (rent + fees, ~0.03 SOL for this 20 KB binary; estimate printed before deploy).
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${TREASURY_WALLET:-}" ]; then
  echo "TREASURY_WALLET not set — refusing." >&2
  echo "This wallet is the only one that can sell during bonding;" >&2
  echo "baking the wrong one bricks the launch." >&2
  exit 1
fi
if [[ ! "$TREASURY_WALLET" =~ ^[1-9A-HJ-NP-Za-km-z]{43,44}$ ]]; then
  echo "TREASURY_WALLET does not look like a pubkey: $TREASURY_WALLET" >&2
  exit 1
fi

RPC="${RPC:-https://api.mainnet-beta.solana.com}"
KEYPAIR="${KEYPAIR:-target/deploy/bonding-guard-keypair.json}"
PROG_ID=$(solana-keygen pubkey "$KEYPAIR")

# 1) build with the treasury baked in
TREASURY_WALLET="$TREASURY_WALLET" ./build.sh

# 2) preflight: program absent + funded
if solana --url "$RPC" program show "$PROG_ID" >/dev/null 2>&1; then
  echo "2) FAIL: program already exists at $PROG_ID — first-deploy only." >&2
  exit 1
fi
# fee payer = CLI default keypair (NOT the program account — funding the
# program account via a plain transfer creates a system-owned account and
# bricks the deploy with "not an upgradeable program")
FEE_PAYER=$(solana --url "$RPC" address)
BAL=$(solana --url "$RPC" balance "$FEE_PAYER" | awk '{print $1}')
echo "2) program absent ✓ | fee payer $FEE_PAYER: $BAL SOL"
SO_SIZE=$(stat -f%z target/deploy/bonding_guard.so)
NEED=$(python3 -c "print(f'{($SO_SIZE * 6.9696 + 30000 + 15000000)/1e9:.4f}')")
if python3 -c "import sys; sys.exit(0 if float('$BAL') >= float('$NEED') else 1)"; then
  echo "   funded ✓ (need ≥ $NEED SOL: rent + fees)"
else
  echo "   FAIL: fund $FEE_PAYER (the CLI wallet) with ≥ $NEED SOL, then re-run." >&2
  echo "         Do NOT fund the program account $PROG_ID directly." >&2
  exit 1
fi

# 3) deploy (max-len headroom for future upgrades without a new keypair)
echo "3) deploying…"
solana --url "$RPC" program deploy target/deploy/bonding_guard.so \
  --program-id "$KEYPAIR" --max-len 65536 --skip-fee-check

# 4) verify
echo "4) verifying…"
solana --url "$RPC" program show "$PROG_ID"
echo "TREASURY baked: $TREASURY_WALLET  ← only this wallet can sell during bonding"
echo "DEPLOY GUARD PASS"
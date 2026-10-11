#!/usr/bin/env bash
# Build bonding_guard.so with a caller-provided TREASURY wallet.
# Usage: TREASURY_WALLET=<pubkey> ./build.sh
# Bakes the sell-allowed wallet into the binary at compile time (env! macro).
set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${TREASURY_WALLET:-}" ]; then
  echo "TREASURY_WALLET not set — using dev default (operator-keypair)" >&2
  TREASURY_WALLET=$(solana-keygen pubkey target/deploy/operator-keypair.json)
  echo "TREASURY_WALLET=$TREASURY_WALLET"
fi

export TREASURY_WALLET
cargo build-sbf
echo "built with TREASURY=$TREASURY_WALLET"
echo "program id: $(solana-keygen pubkey target/deploy/bonding-guard-keypair.json)"
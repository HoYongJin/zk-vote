#!/usr/bin/env bash
# Preflight for the chain secrets BEFORE the cost-gated GCP standup (C1).
# Verifies: owner != relayer (AR-M4), RPC really serves Sepolia, both EOAs funded.
#
# Run in YOUR OWN terminal with the secrets sourced from a gitignored env file —
# do NOT paste private keys inline (they'd land in shell history / logs). This
# script never prints the keys; its output (addresses, balances, chain id) is
# public and safe to share.
#
#   set -a; source .env.deploy-secrets; set +a        # gitignored (.env* rule)
#   bash scripts/local/check-chain-secrets.sh
#
# Requires: foundry `cast`.
set -euo pipefail

: "${OWNER_PRIVATE_KEY:?set OWNER_PRIVATE_KEY (cold, configureElection)}"
: "${RELAYER_PRIVATE_KEY:?set RELAYER_PRIVATE_KEY (hot, deploy+submit gas)}"
: "${SEPOLIA_RPC_URL:?set SEPOLIA_RPC_URL}"

command -v cast >/dev/null 2>&1 || { echo "FAIL: foundry 'cast' not found (https://getfoundry.sh)"; exit 1; }

EXPECTED_CHAIN_ID=11155111
RELAYER_MIN_ETH="0.05"   # 배포(verifier+VotingTally)+투표 가스. 여유롭게 0.2~0.5 권장.
OWNER_MIN_ETH="0.01"     # configureElection 1회분(소량).

# Address derivation is offline; key is passed in argv only within YOUR local shell.
owner_addr=$(cast wallet address --private-key "$OWNER_PRIVATE_KEY")
relayer_addr=$(cast wallet address --private-key "$RELAYER_PRIVATE_KEY")

fail=0
echo "OWNER   address: $owner_addr"
echo "RELAYER address: $relayer_addr"
echo

# AR-M4: the two keys MUST be different addresses.
if [ "$owner_addr" = "$relayer_addr" ]; then
  echo "FAIL [AR-M4]: owner and relayer are the SAME address — keys must differ"
  fail=1
else
  echo "OK   [AR-M4]: owner != relayer"
fi

# The RPC must serve Sepolia, not mainnet/another chain.
chain_id=$(cast chain-id --rpc-url "$SEPOLIA_RPC_URL")
if [ "$chain_id" = "$EXPECTED_CHAIN_ID" ]; then
  echo "OK   [chain]: RPC serves Sepolia ($chain_id)"
else
  echo "FAIL [chain]: RPC chain id is $chain_id, expected $EXPECTED_CHAIN_ID (wrong network!)"
  fail=1
fi

# Both EOAs need gas (relayer a lot, owner a little).
owner_bal=$(cast balance "$owner_addr" --rpc-url "$SEPOLIA_RPC_URL" --ether)
relayer_bal=$(cast balance "$relayer_addr" --rpc-url "$SEPOLIA_RPC_URL" --ether)
echo "OWNER   balance: $owner_bal ETH"
echo "RELAYER balance: $relayer_bal ETH"

if awk -v b="$relayer_bal" -v m="$RELAYER_MIN_ETH" 'BEGIN{exit !(b+0 >= m+0)}'; then
  echo "OK   [gas]: relayer >= $RELAYER_MIN_ETH ETH"
else
  echo "WARN [gas]: relayer < $RELAYER_MIN_ETH ETH — 배포/투표 가스 부족 위험 (Sepolia faucet 충전)"
  fail=1
fi
if awk -v b="$owner_bal" -v m="$OWNER_MIN_ETH" 'BEGIN{exit !(b+0 >= m+0)}'; then
  echo "OK   [gas]: owner >= $OWNER_MIN_ETH ETH"
else
  echo "WARN [gas]: owner < $OWNER_MIN_ETH ETH — configureElection 가스 부족 위험 (소량 충전)"
  fail=1
fi

echo
if [ "$fail" -eq 0 ]; then
  echo "✅ PREFLIGHT PASSED — 키/RPC/가스 OK. C1 standup 진행 가능."
else
  echo "❌ PREFLIGHT 문제 — 위 FAIL/WARN 해결 후 재실행."
  exit 1
fi

#!/usr/bin/env bash
# CI gate (PROJECT_PLAN Phase 17): the post-C1 public signal schema must
# hold everywhere — every active verification key exposes exactly 4 public
# signals and the Solidity boundary is uint[4].
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)
cd "${PROJECT_ROOT}"

checked=0
for vk in server/zkp/build_*/verification_key.json; do
  [ -f "$vk" ] || continue
  n=$(node -e "console.log(require('./$vk').nPublic)")
  if [ "$n" != "4" ]; then
    echo "FAIL: $vk has nPublic=$n (expected 4 — audit C1 schema)" >&2
    exit 1
  fi
  echo "ok: $vk nPublic=4"
  checked=$((checked + 1))
done
if [ "$checked" -eq 0 ]; then
  echo "FAIL: no verification keys found under server/zkp/build_*/" >&2
  exit 1
fi

for verifier in contracts/Groth16Verifier_4_5.sol contracts/Groth16Verifier_5_4.sol; do
  if ! grep -Eq 'uint\[ *4 *\] +calldata +_pubSignals' "$verifier"; then
    echo "FAIL: $verifier does not take uint[4] public signals" >&2
    exit 1
  fi
  echo "ok: $verifier uint[4]"
done

if ! grep -q 'uint256\[4\]' contracts/VotingTally.sol; then
  echo "FAIL: VotingTally.sol does not use uint256[4] public inputs" >&2
  exit 1
fi
echo "ok: VotingTally uint256[4]"

echo "artifact schema OK"

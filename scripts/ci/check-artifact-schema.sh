#!/usr/bin/env bash
# CI gate (PROJECT_PLAN Phase 17): the post-C1 public signal schema must
# hold everywhere — every active verification key exposes exactly 4 public
# signals and the Solidity boundary is uint[4].
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)
cd "${PROJECT_ROOT}"

checked=0
for vk in zk/build_*/verification_key.json; do
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
  echo "FAIL: no verification keys found under zk/build_*/" >&2
  exit 1
fi

# SOL-VERIF-1: EVERY committed Groth16 verifier must take uint[4] public signals.
# A stale uint[2]/uint[3] verifier name-resolves to the same
# Groth16Verifier_<depth>_<candidates> pattern as a real one and, wired into the
# uint256[4] VotingTally, reverts every submitTally — bricking the election. Fail
# closed on any non-uint[4] verifier rather than allow-listing only the good ones.
shopt -s nullglob
verifiers=(contracts/Groth16Verifier*.sol)
if [ "${#verifiers[@]}" -eq 0 ]; then
  echo "FAIL: no contracts/Groth16Verifier*.sol found" >&2
  exit 1
fi
for verifier in "${verifiers[@]}"; do
  if ! grep -Eq 'uint\[ *4 *\] +calldata +_pubSignals' "$verifier"; then
    echo "FAIL: $verifier does not take uint[4] public signals (SOL-VERIF-1: stale uint[2]/uint[3] verifier must not ship; regenerate via setUpZk.sh)" >&2
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

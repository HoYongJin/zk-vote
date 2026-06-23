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

# G6: build-matrix <-> committed-verifier parity. Every built shape must have a
# matching committed verifier and vice versa, so a direct `circom` build can
# never silently diverge from what is deployable. Key off verification_key.json
# (build_*/ also holds temp circoms / wasm dirs).
for vk in zk/build_*/verification_key.json; do
  [ -f "$vk" ] || continue
  shape=$(basename "$(dirname "$vk")")   # build_4_5
  shape=${shape#build_}                  # 4_5
  if [ ! -f "contracts/Groth16Verifier_${shape}.sol" ]; then
    echo "FAIL: zk/build_${shape}/ has no matching contracts/Groth16Verifier_${shape}.sol (G6 parity)" >&2
    exit 1
  fi
  echo "ok: build_${shape} <-> Groth16Verifier_${shape}.sol"
done
for verifier in "${verifiers[@]}"; do
  shape=$(basename "$verifier" .sol)     # Groth16Verifier_4_5
  shape=${shape#Groth16Verifier_}        # 4_5
  if [ ! -f "zk/build_${shape}/verification_key.json" ]; then
    echo "FAIL: contracts/Groth16Verifier_${shape}.sol has no matching zk/build_${shape}/ (G6 parity)" >&2
    exit 1
  fi
done

# G6: the committed `component main = Main(depth, candidates)` literal must map
# to a real built shape. setUpZk.sh sed-rewrites this line at build time, but a
# direct `circom` compile uses the literal — it must be a deployable shape, not a
# phantom like the old Main(3, 3). Anchor on the `component main` instantiation
# (NOT the `template Main(...)` definition).
main_line=$(grep -E '^[[:space:]]*component[[:space:]]+main\b.*Main\(' zk/circuits/VoteCheck.circom || true)
if [ -z "$main_line" ]; then
  echo "FAIL: could not find the 'component main = Main(...)' instantiation in zk/circuits/VoteCheck.circom (G6)" >&2
  exit 1
fi
source_shape=$(printf '%s\n' "$main_line" | sed -E 's/.*Main\(([0-9]+),[[:space:]]*([0-9]+)\).*/\1_\2/')
if [ ! -f "zk/build_${source_shape}/verification_key.json" ]; then
  echo "FAIL: VoteCheck.circom instantiates Main -> build_${source_shape}, which has no zk/build_${source_shape}/ (G6: the committed circuit source must match a built shape)" >&2
  exit 1
fi
echo "ok: VoteCheck.circom Main -> build_${source_shape}"

if ! grep -q 'uint256\[4\]' contracts/VotingTally.sol; then
  echo "FAIL: VotingTally.sol does not use uint256[4] public inputs" >&2
  exit 1
fi
echo "ok: VotingTally uint256[4]"

echo "artifact schema OK"

#!/usr/bin/env bash
# Reports which pieces of the zk-vote toolchain are present on this machine.
# Informational only — never fails. See docs/PROJECT_PLAN.md Phase 2.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

check_tool() {
  local name="$1"
  local version_arg="${2:---version}"
  if command -v "${name}" >/dev/null 2>&1; then
    echo "[ok] ${name}: $("${name}" "${version_arg}" 2>&1 | head -n 1)"
  else
    echo "[missing] ${name}"
  fi
}

check_tool docker --version
check_tool node --version
check_tool cargo --version
check_tool forge --version
check_tool gcloud --version
check_tool nargo --version   # Noir POC only; NOT part of production v1

# circom: honor CIRCOM_BIN (setUpZk.sh does the same), then PATH.
CIRCOM_BIN="${CIRCOM_BIN:-circom}"
if command -v "${CIRCOM_BIN}" >/dev/null 2>&1; then
  echo "[ok] circom (${CIRCOM_BIN}): $("${CIRCOM_BIN}" --version 2>&1 | head -n 1)"
else
  echo "[missing] circom — build from source (https://docs.circom.io) and export CIRCOM_BIN=/path/to/circom"
fi

# snarkjs: the repo uses the LOCAL bin (no global install required).
SNARKJS_FOUND="false"
for candidate in "${PROJECT_ROOT}/node_modules/.bin/snarkjs" "${PROJECT_ROOT}/server/node_modules/.bin/snarkjs"; do
  if [ -x "${candidate}" ]; then
    echo "[ok] snarkjs (local): ${candidate}"
    SNARKJS_FOUND="true"
    break
  fi
done
if [ "${SNARKJS_FOUND}" != "true" ]; then
  echo "[missing] snarkjs — run 'npm install' at the repo root (a global install is NOT needed)"
fi

# Powers of Tau files: required for circuit setup (audit M2). Use
# scripts/local/fetch-ptau.sh <12|16|20> to download + checksum-verify.
for power in 12 16 20; do
  ptau="${PROJECT_ROOT}/zk/powersOfTau28_hez_final_${power}.ptau"
  if [ -f "${ptau}" ]; then
    echo "[ok] ptau _${power}: $(basename "${ptau}")"
  else
    echo "[absent] ptau _${power} (fetch with: bash scripts/local/fetch-ptau.sh ${power})"
  fi
done

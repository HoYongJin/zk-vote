#!/usr/bin/env bash
# Phase-18 post-deploy verification gate — READ-ONLY, NO cost, NO provisioning.
# Runs against an already-deployed staging Cloud Run service to prove the rollout
# is correct before declaring Phase 18 done. Safe to run repeatedly.
#
# Implements docs/RUNBOOK_PHASE18_STANDUP.md §8 + PROJECT_PLAN §18 verification gate:
#   1. /healthz + /readyz return 200
#   2. every proving artifact GETs 200 AND is byte-identical to the committed
#      zk/ circuit bytes (invariant #7 — proves the GCS bucket was seeded correctly)
#   3. (optional) a GCIP token is accepted and a stale Supabase token is rejected
#      (proves issuer/audience were repointed off Supabase)
#
# Usage:
#   STAGING_BASE_URL=https://zkvote-staging-api-xxxx.a.run.app \
#   [GCIP_ID_TOKEN=<valid GCIP ID token>] \
#   [SUPABASE_ID_TOKEN=<stale Supabase token, expected REJECTED>] \
#   [AUTHED_PATH=/api/me] \
#   bash scripts/gcp/verify-staging.sh
#
# Exits non-zero on the first failed gate.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

BASE_URL="${STAGING_BASE_URL:-}"
if [[ -z "${BASE_URL}" ]]; then
  echo "Set STAGING_BASE_URL to the deployed Cloud Run service URL." >&2
  exit 1
fi
BASE_URL="${BASE_URL%/}"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok: $*"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

http_code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "== Phase-18 verify against ${BASE_URL}"

# 1) health -----------------------------------------------------------------
echo "[1] health endpoints"
for ep in /healthz /readyz; do
  code="$(http_code "${BASE_URL}${ep}")"
  [[ "${code}" == "200" ]] || fail "${ep} returned ${code} (want 200)"
  pass "${ep} 200"
done

# 2) proving artifacts served + byte-identical to the committed circuit -------
echo "[2] GCS proving artifacts (served bytes == committed zk/ bytes, invariant #7)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
ARTS=(
  "build_4_5/circuit_final.zkey"
  "build_4_5/VoteCheck_temp_js/VoteCheck_temp.wasm"
  "build_5_4/circuit_final.zkey"
  "build_5_4/VoteCheck_temp_js/VoteCheck_temp.wasm"
)
for rel in "${ARTS[@]}"; do
  url="${BASE_URL}/api/zkp-files/${rel}"
  out="${TMP}/art.bin"
  code="$(curl -s -o "${out}" -w '%{http_code}' "${url}")"
  [[ "${code}" == "200" ]] || fail "GET ${rel} returned ${code} (want 200 — was the bucket seeded?)"
  want="$(sha256_of "${PROJECT_ROOT}/zk/${rel}")"
  got="$(sha256_of "${out}")"
  [[ "${want}" == "${got}" ]] || fail "${rel} sha256 mismatch (served ${got} != committed ${want}) — invariant #7 violated"
  pass "${rel} 200 + sha256 ${want}"
done

# 3) auth boundary (optional — needs sample tokens) --------------------------
echo "[3] auth boundary (GCIP accepted, Supabase rejected)"
AUTHED_PATH="${AUTHED_PATH:-/api/me}"
if [[ -n "${GCIP_ID_TOKEN:-}" ]]; then
  code="$(http_code -H "Authorization: Bearer ${GCIP_ID_TOKEN}" "${BASE_URL}${AUTHED_PATH}")"
  [[ "${code}" != "401" && "${code}" != "403" ]] \
    || fail "GCIP token rejected (${code}) at ${AUTHED_PATH} — issuer/audience mismatch (project-id coupling?)"
  pass "GCIP token accepted (${code}) at ${AUTHED_PATH}"
else
  echo "  skip: set GCIP_ID_TOKEN to check acceptance"
fi
if [[ -n "${SUPABASE_ID_TOKEN:-}" ]]; then
  code="$(http_code -H "Authorization: Bearer ${SUPABASE_ID_TOKEN}" "${BASE_URL}${AUTHED_PATH}")"
  [[ "${code}" == "401" || "${code}" == "403" ]] \
    || fail "stale Supabase token NOT rejected (${code}) — backend issuer still resolves Supabase"
  pass "Supabase token rejected (${code})"
else
  echo "  skip: set SUPABASE_ID_TOKEN to check rejection"
fi

echo "Phase-18 verify PASSED."

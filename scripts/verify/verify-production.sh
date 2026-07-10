#!/usr/bin/env bash
# Phase-18 post-deploy verification gate — READ-ONLY, NO cost, NO provisioning.
# Runs against the deployed production Cloud Run service. Safe to run repeatedly.
#
# Implements the production verification gate:
#   1. /healthz + /readyz return 200
#   2. every proving artifact GETs 200 AND is byte-identical to the committed
#      zk/ circuit bytes (invariant #7 — proves the GCS bucket was seeded correctly)
#   3. (optional) a GCIP token is accepted and a stale Supabase token is rejected
#      (proves issuer/audience were repointed off Supabase)
#
# Usage:
#   VERIFY_BASE_URL=https://zkvote-prod-api-xxxx.a.run.app \
#   [GCIP_ID_TOKEN=<valid GCIP ID token>] \
#   [SUPABASE_ID_TOKEN=<stale Supabase token, expected REJECTED>] \
#   [AUTHED_PATH=/api/me] \
#   bash scripts/verify/verify-production.sh
#
# Exits non-zero on the first failed gate.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)
RUN_ID="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
PROJECT_ID="${GCP_PROJECT_ID:-zkvote-prod-hhyyj}"
REGION="${GCP_REGION:-asia-northeast3}"
SERVICE="${CLOUD_RUN_SERVICE:-zkvote-prod-api}"
EVIDENCE_PATH="${VERIFY_EVIDENCE_PATH:-${PROJECT_ROOT}/docs/evidence/verify-production-${RUN_ID}.json}"
EVIDENCE_TMP="$(mktemp)"
EVIDENCE_FINALIZED=false

BASE_URL="${VERIFY_BASE_URL:-${PRODUCTION_BASE_URL:-${PROD_BASE_URL:-}}}"
if [[ -z "${BASE_URL}" ]]; then
  BASE_URL="$(gcloud run services describe "${SERVICE}" --project "${PROJECT_ID}" --region "${REGION}" --format='value(status.url)')"
fi
[[ -n "${BASE_URL}" ]] || { echo "Cloud Run service URL is empty." >&2; exit 1; }
BASE_URL="${BASE_URL%/}"

command -v node >/dev/null || { echo "node is required." >&2; exit 1; }

evidence_init() {
  mkdir -p "$(dirname "${EVIDENCE_PATH}")"
  EVIDENCE_PATH="${EVIDENCE_PATH}" RUN_ID="${RUN_ID}" BASE_URL="${BASE_URL}" node <<'NODE' > "${EVIDENCE_TMP}"
const doc = {
  status: "running",
  runId: process.env.RUN_ID,
  command: "bash scripts/verify/verify-production.sh",
  startedAt: new Date().toISOString(),
  baseUrl: process.env.BASE_URL,
  checks: {},
  caveats: []
};
process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
NODE
  cp "${EVIDENCE_TMP}" "${EVIDENCE_PATH}"
}

evidence_update() {
  local key="$1"
  local value_json="$2"
  node "${SCRIPT_DIR}/json-evidence-update.mjs" "${EVIDENCE_TMP}" set "${key}" "${value_json}"
  cp "${EVIDENCE_TMP}" "${EVIDENCE_PATH}"
}

evidence_caveat() {
  local message="$1"
  node "${SCRIPT_DIR}/json-evidence-update.mjs" "${EVIDENCE_TMP}" caveat "${message}"
  cp "${EVIDENCE_TMP}" "${EVIDENCE_PATH}"
}

evidence_finish() {
  local status="$1"
  local failure="${2:-}"
  if [[ "${EVIDENCE_FINALIZED}" == true ]]; then
    return
  fi
  node "${SCRIPT_DIR}/json-evidence-update.mjs" "${EVIDENCE_TMP}" finish "${status}" "${failure}"
  cp "${EVIDENCE_TMP}" "${EVIDENCE_PATH}"
  EVIDENCE_FINALIZED=true
}

fail() {
  echo "FAIL: $*" >&2
  evidence_finish "failed" "$*"
  exit 1
}
pass() { echo "  ok: $*"; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

http_code() { curl -s -o /dev/null -w '%{http_code}' "$@" || true; }

echo "== Phase-18 verify against ${BASE_URL}"
evidence_init

# 1) health -----------------------------------------------------------------
# /readyz is the authoritative readiness gate (it checks Postgres + Redis +
# artifact store). On Cloud Run the Google Front End intercepts the literal path
# /healthz and serves its OWN 404 before the request reaches the app, so /healthz
# is treated as best-effort only (verified live: /readyz 200, /healthz GFE-404).
echo "[1] health endpoints"
code="$(http_code "${BASE_URL}/readyz")"
[[ "${code}" == "200" ]] || fail "/readyz returned ${code} (want 200)"
pass "/readyz 200"
hz="$(http_code "${BASE_URL}/healthz")"
if [[ "${hz}" == "200" ]]; then
  pass "/healthz 200"
else
  warning="/healthz returned ${hz} — Cloud Run's GFE intercepts this path; /readyz is authoritative."
  evidence_caveat "${warning}"
  echo "  warn: ${warning}"
fi
evidence_update "health" "{\"readyz\":${code},\"healthz\":${hz}}"

# 2) proving artifacts served + byte-identical to the committed circuit -------
echo "[2] GCS proving artifacts (served bytes == committed zk/ bytes, invariant #7)"
TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}" "${EVIDENCE_TMP}"' EXIT
ARTS=(
  "build_4_10/circuit_final.zkey"
  "build_4_10/VoteCheck_temp_js/VoteCheck_temp.wasm"
  "build_10_10/circuit_final.zkey"
  "build_10_10/VoteCheck_temp_js/VoteCheck_temp.wasm"
)
for rel in "${ARTS[@]}"; do
  url="${BASE_URL}/api/zkp-files/${rel}"
  out="${TMP}/art.bin"
  code="$(curl -s -o "${out}" -w '%{http_code}' "${url}" || true)"
  [[ "${code}" == "200" ]] || fail "GET ${rel} returned ${code} (want 200 — was the bucket seeded?)"
  want="$(sha256_of "${PROJECT_ROOT}/zk/${rel}")"
  got="$(sha256_of "${out}")"
  [[ "${want}" == "${got}" ]] || fail "${rel} sha256 mismatch (served ${got} != committed ${want}) — invariant #7 violated"
  evidence_update "artifact:${rel}" "{\"url\":\"${url}\",\"status\":${code},\"sha256\":\"${got}\"}"
  pass "${rel} 200 + sha256 ${want}"
done

# 3) auth boundary (optional — needs sample tokens) --------------------------
echo "[3] auth boundary (GCIP accepted, Supabase rejected)"
AUTHED_PATH="${AUTHED_PATH:-/api/me}"
if [[ -n "${GCIP_ID_TOKEN:-}" ]]; then
  code="$(http_code -H "Authorization: Bearer ${GCIP_ID_TOKEN}" "${BASE_URL}${AUTHED_PATH}")"
  [[ "${code}" != "401" && "${code}" != "403" ]] \
    || fail "GCIP token rejected (${code}) at ${AUTHED_PATH} — issuer/audience mismatch (project-id coupling?)"
  evidence_update "gcipToken" "{\"path\":\"${AUTHED_PATH}\",\"status\":${code},\"accepted\":true}"
  pass "GCIP token accepted (${code}) at ${AUTHED_PATH}"
else
  evidence_caveat "GCIP_ID_TOKEN not supplied; token acceptance not verified."
  echo "  skip: set GCIP_ID_TOKEN to check acceptance"
fi
if [[ -n "${SUPABASE_ID_TOKEN:-}" ]]; then
  code="$(http_code -H "Authorization: Bearer ${SUPABASE_ID_TOKEN}" "${BASE_URL}${AUTHED_PATH}")"
  [[ "${code}" == "401" || "${code}" == "403" ]] \
    || fail "stale Supabase token NOT rejected (${code}) — backend issuer still resolves Supabase"
  evidence_update "supabaseToken" "{\"path\":\"${AUTHED_PATH}\",\"status\":${code},\"rejected\":true}"
  pass "Supabase token rejected (${code})"
else
  evidence_caveat "SUPABASE_ID_TOKEN not supplied; stale Supabase rejection not verified."
  echo "  skip: set SUPABASE_ID_TOKEN to check rejection"
fi

evidence_finish "passed"
echo "Phase-18 verify PASSED."
echo "Evidence: ${EVIDENCE_PATH}"

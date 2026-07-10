#!/usr/bin/env bash
# Seeds the byte-exact zk proving artifacts into the GCS artifact bucket so the
# production API (ARTIFACT_STORE=gcs) can stream wasm/zkey to the browser prover.
#
# >>> Writes to a billable GCS bucket (negligible cost) — gated like the rest of
#     the standup. Run under the OPERATOR's gcloud credentials, NOT the runtime
#     service account (which is read-only objectViewer). <<<
#
# Object keys MUST match rust-backend/crates/api/src/routes/artifacts.rs
# (read_gcs_artifact derives the GCS object key as the path after /api/zkp-files/,
#  leading slash trimmed):
#   build_{depth}_{candidates}/circuit_final.zkey
#   build_{depth}_{candidates}/verification_key.json
#   build_{depth}_{candidates}/VoteCheck_temp_js/VoteCheck_temp.wasm
#
# Idempotent (skips objects already byte-identical) and sha256 round-trip verified
# after every upload (invariant #7: served wasm/zkey must be bit-identical to the
# circuit). Aborts on any mismatch rather than silently serving wrong bytes.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)

PROJECT_ID="${PROJECT_ID:-${GCP_PROJECT_ID:-zkvote-prod-hhyyj}}"
BUCKET="${BUCKET:-${ARTIFACT_BUCKET:-zkvote-prod-artifacts-${PROJECT_ID}}}"
BUILD_DIRS=("build_4_10" "build_6_10" "build_8_10" "build_10_10")
ARTIFACT_FILES=(
  "circuit_final.zkey"
  "verification_key.json"
  "VoteCheck_temp_js/VoteCheck_temp.wasm"
  "ceremony.json"
)

if [[ "${CONFIRM_COSTS:-}" != "yes" ]]; then
  echo "Refusing to run: set CONFIRM_COSTS=yes after explicit user approval (writes to a billable GCS bucket)." >&2
  exit 1
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if ! gcloud storage buckets describe "gs://${BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  echo "Refusing to seed: bucket gs://${BUCKET} does not exist (run zkvote-production-setup.sh first)." >&2
  exit 1
fi

# --- Trusted-setup provenance gate (ZK-SETUP-1 / AR-H1, invariant #6) ----------
# Pre-flight over ALL shapes BEFORE any upload (all-or-nothing: never seed a
# partial/mixed key set). Two stages, fail closed:
#   1. ceremony.json must declare finalizedWithBeacon: true — a cheap,
#      forgery-resistant structural pre-filter (scripts/verify/check-ceremony-beacon.sh).
#   2. `snarkjs zkey verify` must accept the zkey against the committed r1cs and
#      the depth-matched ptau — the AUTHORITATIVE transcript check. The flag in
#      (1) is hand-editable; only (2) proves the zkey is a real beacon transcript
#      of the committed circuit, so a forged finalizedWithBeacon cannot pass.
SNARKJS_BIN="${SNARKJS_BIN:-${PROJECT_ROOT}/node_modules/.bin/snarkjs}"
PTAU_DIR="${PTAU_DIR:-${PROJECT_ROOT}/zk}"

ptau_for_depth() { # mirror zk/setUpZk.sh ptau selection
  local depth="$1"
  if   [[ "${depth}" -le 5  ]]; then echo "powersOfTau28_hez_final_12.ptau"
  elif [[ "${depth}" -le 10 ]]; then echo "powersOfTau28_hez_final_16.ptau"
  elif [[ "${depth}" -le 20 ]]; then echo "powersOfTau28_hez_final_20.ptau"
  else echo ""; fi
}

if [[ ! -x "${SNARKJS_BIN}" ]]; then
  echo "ABORT: snarkjs not found at ${SNARKJS_BIN}; cannot verify the zkey transcript (AR-H1). Set SNARKJS_BIN or run 'npm ci'." >&2
  exit 1
fi

for dir in "${BUILD_DIRS[@]}"; do
  src_dir="${PROJECT_ROOT}/zk/${dir}"
  # Stage 1: structural beacon pre-filter (forgery-resistant, anchored match).
  bash "${PROJECT_ROOT}/scripts/verify/check-ceremony-beacon.sh" "${src_dir}/ceremony.json" >/dev/null

  # Stage 2: authoritative transcript verification against r1cs + depth-matched ptau.
  depth="${dir#build_}"; depth="${depth%%_*}"   # build_6_10 -> 6
  ptau_name="$(ptau_for_depth "${depth}")"
  ptau="${PTAU_DIR}/${ptau_name}"
  r1cs="${src_dir}/VoteCheck_temp.r1cs"
  zkey="${src_dir}/circuit_final.zkey"
  if [[ -z "${ptau_name}" || ! -f "${ptau}" ]]; then
    echo "ABORT: ptau '${ptau}' for ${dir} (depth ${depth}) not found; cannot run 'snarkjs zkey verify' (AR-H1). Fetch it (scripts/local/fetch-ptau.sh) or set PTAU_DIR." >&2
    exit 1
  fi
  if [[ ! -f "${r1cs}" || ! -f "${zkey}" ]]; then
    echo "ABORT: ${dir} is missing the r1cs/zkey needed for transcript verification." >&2
    exit 1
  fi
  echo "verifying trusted-setup transcript for ${dir} (depth ${depth}, ${ptau_name})..."
  if ! "${SNARKJS_BIN}" zkey verify "${r1cs}" "${ptau}" "${zkey}" >/dev/null 2>&1; then
    echo "ABORT: 'snarkjs zkey verify' FAILED for ${dir} — the zkey is not a valid transcript of the committed circuit + ptau (possible forged finalizedWithBeacon). Refusing to seed (AR-H1)." >&2
    exit 1
  fi
  echo "  ok: ${dir} beacon-finalized + transcript verified"
done
echo "Trusted-setup provenance OK for all ${#BUILD_DIRS[@]} shapes (beacon + zkey verify)."

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

seeded=0
skipped=0
for dir in "${BUILD_DIRS[@]}"; do
  for rel in "${ARTIFACT_FILES[@]}"; do
    src="${PROJECT_ROOT}/zk/${dir}/${rel}"
    obj="gs://${BUCKET}/${dir}/${rel}"
    if [[ ! -f "${src}" ]]; then
      echo "Refusing to seed: missing source artifact ${src}" >&2
      exit 1
    fi
    want="$(sha256_of "${src}")"
    rt="${TMP_DIR}/roundtrip.bin"
    rm -f "${rt}"

    # Idempotency: skip if the object is already present and byte-identical.
    if gcloud storage cp "${obj}" "${rt}" --project "${PROJECT_ID}" --quiet >/dev/null 2>&1; then
      if [[ "$(sha256_of "${rt}")" == "${want}" ]]; then
        echo "unchanged ${dir}/${rel} (sha256=${want})"
        skipped=$((skipped + 1))
        continue
      fi
    fi

    echo "uploading ${src} -> ${obj}"
    gcloud storage cp "${src}" "${obj}" --project "${PROJECT_ID}" --quiet

    # Round-trip sha256 verification (invariant #7 byte-identity).
    rm -f "${rt}"
    gcloud storage cp "${obj}" "${rt}" --project "${PROJECT_ID}" --quiet
    got="$(sha256_of "${rt}")"
    if [[ "${want}" != "${got}" ]]; then
      echo "ABORT: sha256 mismatch for ${obj} (local ${want} != GCS ${got}). Invariant #7 (byte-identity) violated." >&2
      exit 1
    fi
    echo "  ok sha256=${want}"
    seeded=$((seeded + 1))
  done
done

echo "Seeded gs://${BUCKET}: ${seeded} uploaded, ${skipped} already current (all sha256 verified, invariant #7)."

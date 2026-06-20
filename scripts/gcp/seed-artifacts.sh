#!/usr/bin/env bash
# Seeds the byte-exact zk proving artifacts into the GCS artifact bucket so the
# staging/prod API (ARTIFACT_STORE=gcs) can stream wasm/zkey to the browser prover.
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

PROJECT_ID="${PROJECT_ID:-${GCP_PROJECT_ID:-zkvote-staging}}"
BUCKET="${BUCKET:-${ARTIFACT_BUCKET:-zkvote-staging-artifacts-${PROJECT_ID}}}"
BUILD_DIRS=("build_4_5" "build_5_4")
ARTIFACT_FILES=(
  "circuit_final.zkey"
  "verification_key.json"
  "VoteCheck_temp_js/VoteCheck_temp.wasm"
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
  echo "Refusing to seed: bucket gs://${BUCKET} does not exist (run zkvote-staging-setup.sh first)." >&2
  exit 1
fi

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

#!/usr/bin/env bash
# ZK-SETUP-1 / AR-H1 pre-filter: assert a build's ceremony.json declares the
# trusted setup was beacon-finalized (finalizedWithBeacon == true).
#
# This flag is, on its own, FORGEABLE (a hand-edited manifest), so seed-artifacts.sh
# pairs this cheap structural check with an authoritative `snarkjs zkey verify`.
# It is factored out here so it can be unit-tested without gcloud or a ptau file
# (test/seedBeaconGate.test.ts). The match is ANCHORED on
# `"finalizedWithBeacon" : true` so a decoy substring (e.g. `"beaconHex":"truested"`
# next to `finalizedWithBeacon: false`) cannot false-pass. Fails closed (non-zero)
# on the first non-beacon or missing manifest.
#
# Usage: check-ceremony-beacon.sh <ceremony.json> [<ceremony.json> ...]
set -euo pipefail

if [[ "$#" -eq 0 ]]; then
  echo "usage: $(basename "$0") <ceremony.json> [<ceremony.json> ...]" >&2
  exit 2
fi

for cer in "$@"; do
  if [[ ! -f "${cer}" ]]; then
    echo "FAIL: ${cer} missing — refusing to treat an absent ceremony manifest as beacon-finalized (AR-H1)." >&2
    exit 1
  fi
  if ! grep -Eq '"finalizedWithBeacon"[[:space:]]*:[[:space:]]*true[[:space:]]*[,}]' "${cer}"; then
    echo "FAIL: ${cer} is not beacon-finalized (finalizedWithBeacon != true). Regenerate with BEACON_HEX via zk/setUpZk.sh (AR-H1)." >&2
    exit 1
  fi
done

echo "ok: $# ceremony manifest(s) beacon-finalized"

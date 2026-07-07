#!/usr/bin/env bash
# ZK-SETUP-1 / AR-H1 pre-filter: assert a build's ceremony.json declares the
# trusted setup was beacon-finalized (finalizedWithBeacon == true).
#
# This manifest is, on its own, FORGEABLE (hand-edited JSON), so seed-artifacts.sh
# pairs this structural check with authoritative `snarkjs zkey verify`. This gate
# still fails closed unless the manifest carries the exact finalized flag and a
# real 32-byte hex beacon value.
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
  if ! grep -Eq '"beaconHex"[[:space:]]*:[[:space:]]*"[0-9a-fA-F]{64}"[[:space:]]*[,}]' "${cer}"; then
    echo "FAIL: ${cer} is missing a 32-byte hex beaconHex. Regenerate with a published BEACON_HEX via zk/setUpZk.sh (AR-H1)." >&2
    exit 1
  fi
done

echo "ok: $# ceremony manifest(s) beacon-finalized"

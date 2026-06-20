#!/usr/bin/env bash
# Downloads a Powers of Tau file into zk/ and verifies its blake2b-512
# checksum against the values published in the snarkjs README (audit M2).
#
# Usage: bash scripts/local/fetch-ptau.sh <12|16|20>
#   12 -> Merkle depth <= 5    (build_4_5 / build_5_4)
#   16 -> Merkle depth <= 10
#   20 -> Merkle depth <= 20
#
# Fails closed: if the checksum cannot be computed or does not match, the
# downloaded file is removed and the script exits non-zero.
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)
PROJECT_ROOT=$(cd -- "${SCRIPT_DIR}/../.." >/dev/null 2>&1 && pwd)
ZKP_DIR="${PROJECT_ROOT}/zk"
MIRROR="https://storage.googleapis.com/zkevm/ptau"

POWER="${1:-12}"
case "${POWER}" in
  12) EXPECTED="ded2694169b7b08e898f736d5de95af87c3f1a64594013351b1a796dbee393bd825f88f9468c84505ddd11eb0b1465ac9b43b9064aa8ec97f2b73e04758b8a4a" ;;
  16) EXPECTED="6a6277a2f74e1073601b4f9fed6e1e55226917efb0f0db8a07d98ab01df1ccf43eb0e8c3159432acd4960e2f29fe84a4198501fa54c8dad9e43297453efec125" ;;
  20) EXPECTED="89a66eb5590a1c94e3f1ee0e72acf49b1669e050bb5f93c73b066b564dca4e0c7556a52b323178269d64af325d8fdddb33da3a27c34409b821de82aa2bf1a27b" ;;
  *) echo "Unsupported power: ${POWER} (expected 12, 16, or 20)" >&2; exit 1 ;;
esac

FILE="powersOfTau28_hez_final_${POWER}.ptau"
DEST="${ZKP_DIR}/${FILE}"

# Prints a 128-hex-char blake2b-512 digest of $1, or nothing if no usable
# tool exists. Every candidate's OUTPUT is format-checked: LibreSSL's openssl
# exits 0 while printing a usage error for unknown digests, so exit codes
# alone cannot be trusted here.
blake2b512_of() {
  local target="$1"
  local out

  if command -v b2sum >/dev/null 2>&1; then
    out="$(b2sum -l 512 "${target}" 2>/dev/null | awk '{print $1}')"
    if [[ "${out}" =~ ^[0-9a-f]{128}$ ]]; then echo "${out}"; return; fi
  fi

  out="$(openssl blake2b512 -r "${target}" 2>/dev/null | awk '{print $1}')"
  if [[ "${out}" =~ ^[0-9a-f]{128}$ ]]; then echo "${out}"; return; fi

  # macOS LibreSSL has no blake2b512; fall back to the repo-local blake2b-wasm.
  if [ -d "${PROJECT_ROOT}/node_modules/blake2b-wasm" ]; then
    out="$(node -e "
      const blake2b = require('${PROJECT_ROOT}/node_modules/blake2b-wasm');
      const fs = require('fs');
      blake2b.ready(() => {
        const h = blake2b(64);
        const stream = fs.createReadStream(process.argv[1]);
        stream.on('data', (c) => h.update(c));
        stream.on('end', () => console.log(Buffer.from(h.digest()).toString('hex')));
      });
    " "${target}")"
    if [[ "${out}" =~ ^[0-9a-f]{128}$ ]]; then echo "${out}"; return; fi
  fi

  echo "" # no usable tool
}

DOWNLOADED="false"
if [ -f "${DEST}" ]; then
  echo "-> ${FILE} already exists; verifying checksum only."
else
  echo "-> Downloading ${FILE} from ${MIRROR} ..."
  curl -fL --retry 3 -o "${DEST}.download" "${MIRROR}/${FILE}"
  mv "${DEST}.download" "${DEST}"
  DOWNLOADED="true"
fi

echo "-> Computing blake2b-512 checksum (this can take a while) ..."
ACTUAL="$(blake2b512_of "${DEST}")"

if [ -z "${ACTUAL}" ]; then
  echo "ERROR: no blake2b-512 tool available (need b2sum, openssl blake2b512, or repo-local blake2b-wasm)." >&2
  if [ "${DOWNLOADED}" = "true" ]; then
    echo "Refusing to trust an unverified download; removing ${DEST}." >&2
    rm -f "${DEST}"
  else
    echo "Leaving the pre-existing file in place, but it is UNVERIFIED by this run." >&2
  fi
  exit 1
fi

if [ "${ACTUAL}" != "${EXPECTED}" ]; then
  echo "ERROR: checksum mismatch for ${FILE}" >&2
  echo "  expected: ${EXPECTED}" >&2
  echo "  actual:   ${ACTUAL}" >&2
  rm -f "${DEST}"
  exit 1
fi

echo "OK: ${FILE} verified (blake2b-512 matches the snarkjs README)."

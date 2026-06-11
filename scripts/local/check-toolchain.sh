#!/usr/bin/env bash
set -euo pipefail

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
check_tool cargo --version
check_tool forge --version
check_tool circom --version
check_tool snarkjs --version
check_tool nargo --version
check_tool gcloud --version

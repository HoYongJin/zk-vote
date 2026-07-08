#!/usr/bin/env bash
# Shared Cloud SQL Auth Proxy launcher for operator scripts.
#
# Source this file, then call:
#   start_cloud_sql_proxy "$SQL_CONNECTION_NAME" "$PORT"
#   trap 'stop_cloud_sql_proxy' EXIT
#
# The helper never executes a default binary from /tmp. When PROXY_BIN is not
# explicitly provided, it downloads the proxy into a private mktemp directory
# and lets the proxy use gcloud ADC/application-default credentials instead of
# placing an OAuth token on the process command line.

cloud_sql_proxy_reject_unsafe_explicit_bin() {
  local candidate="$1"
  case "${candidate}" in
    /tmp | /tmp/* | /private/tmp | /private/tmp/*)
      echo "Refusing PROXY_BIN under a shared temporary directory: ${candidate}" >&2
      return 1
      ;;
  esac
}

cloud_sql_proxy_platform_suffix() {
  local os arch
  os=$(uname -s | tr '[:upper:]' '[:lower:]')
  arch=$(uname -m)
  case "${arch}" in arm64 | aarch64) arch=arm64 ;; *) arch=amd64 ;; esac
  printf '%s.%s' "${os}" "${arch}"
}

start_cloud_sql_proxy() {
  local connection_name="$1"
  local port="$2"
  local proxy_bin

  if [[ -n "${PROXY_BIN:-}" ]]; then
    cloud_sql_proxy_reject_unsafe_explicit_bin "${PROXY_BIN}"
    [[ -x "${PROXY_BIN}" ]] || {
      echo "PROXY_BIN is set but is not executable: ${PROXY_BIN}" >&2
      return 1
    }
    proxy_bin="${PROXY_BIN}"
  else
    command -v curl >/dev/null || {
      echo "curl is required to download cloud-sql-proxy." >&2
      return 1
    }
    CLOUD_SQL_PROXY_TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/zkvote-cloud-sql-proxy.XXXXXX")"
    chmod 700 "${CLOUD_SQL_PROXY_TMP_DIR}"
    proxy_bin="${CLOUD_SQL_PROXY_TMP_DIR}/cloud-sql-proxy"
    echo "Downloading cloud-sql-proxy ($(cloud_sql_proxy_platform_suffix))..."
    curl -fsSL -o "${proxy_bin}" \
      "https://storage.googleapis.com/cloud-sql-connectors/cloud-sql-proxy/v2.14.1/cloud-sql-proxy.$(cloud_sql_proxy_platform_suffix)"
    chmod 700 "${proxy_bin}"
  fi

  "${proxy_bin}" --address 127.0.0.1 --port "${port}" "${connection_name}" &
  CLOUD_SQL_PROXY_PID=$!
}

stop_cloud_sql_proxy() {
  if [[ -n "${CLOUD_SQL_PROXY_PID:-}" ]]; then
    kill "${CLOUD_SQL_PROXY_PID}" 2>/dev/null || true
  fi
  if [[ -n "${CLOUD_SQL_PROXY_TMP_DIR:-}" ]]; then
    rm -rf "${CLOUD_SQL_PROXY_TMP_DIR}"
  fi
}

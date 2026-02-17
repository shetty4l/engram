#!/usr/bin/env bash
set -euo pipefail

# Engram installer
# Usage: curl -fsSL https://github.com/shetty4l/engram/releases/latest/download/install.sh | bash

SERVICE_NAME="engram"
REPO="shetty4l/engram"
INSTALL_BASE="${HOME}/srv/engram"
DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/engram"

# --- source shared install functions from @shetty4l/core ---

INSTALL_LIB_URL="https://raw.githubusercontent.com/shetty4l/core/main/scripts/install-lib.sh"

install_lib=$(mktemp)
if ! curl -fsSL -o "$install_lib" "$INSTALL_LIB_URL"; then
  printf '\033[1;31m==>\033[0m %s\n' "Failed to download install-lib.sh from ${INSTALL_LIB_URL}" >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$install_lib"
rm -f "$install_lib"

# --- Engram-specific: data directory ---

setup_data_dir() {
  mkdir -p "$DATA_DIR"
  ok "Data directory ready: ${DATA_DIR}"
}

# --- Engram-specific: status ---

print_status() {
  local install_dir="${INSTALL_BASE}/latest"
  echo ""
  echo "=========================================="
  ok "Engram installed successfully!"
  echo "=========================================="
  echo ""
  echo "  Version:    ${RELEASE_TAG}"
  echo "  Install:    ${install_dir}"
  echo "  CLI:        ${BIN_DIR}/engram"
  echo "  Data:       ${DATA_DIR}"
  echo ""
  echo "  Add this to your MCP client configuration:"
  echo ""
  echo "  {"
  echo "    \"mcpServers\": {"
  echo "      \"engram\": {"
  echo "        \"command\": \"bun\","
  echo "        \"args\": [\"run\", \"${install_dir}/src/index.ts\"]"
  echo "      }"
  echo "    }"
  echo "  }"
  echo ""
  echo "  Database location: ${DATA_DIR}/engram.db"
  echo "  To override, set ENGRAM_DB_PATH environment variable."
  echo ""
}

# --- main ---

main() {
  info "Engram installer"
  echo ""

  check_prereqs
  fetch_latest_release
  download_and_extract
  update_symlink
  prune_versions
  setup_data_dir
  install_cli
  print_status
}

main "$@"

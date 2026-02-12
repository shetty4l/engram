#!/usr/bin/env bash
set -euo pipefail

# Engram installer
# Usage: curl -fsSL https://github.com/shetty4l/engram/releases/latest/download/install.sh | bash

REPO="shetty4l/engram"
INSTALL_BASE="${HOME}/srv/engram"
BIN_DIR="${HOME}/.local/bin"
DATA_DIR="${XDG_DATA_HOME:-${HOME}/.local/share}/engram"
MAX_VERSIONS=5

# --- helpers ---

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m==>\033[0m %s\n' "$*"; }
err()   { printf '\033[1;31m==>\033[0m %s\n' "$*" >&2; }
die()   { err "$@"; exit 1; }

check_prereqs() {
  local missing=()
  for cmd in bun curl tar jq; do
    if ! command -v "$cmd" &>/dev/null; then
      missing+=("$cmd")
    fi
  done
  if [ ${#missing[@]} -gt 0 ]; then
    die "Missing required tools: ${missing[*]}"
  fi
}

# --- fetch latest release ---

fetch_latest_release() {
  info "Fetching latest release from GitHub..."
  local release_json
  release_json=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")

  RELEASE_TAG=$(echo "$release_json" | jq -r '.tag_name')
  RELEASE_VERSION="${RELEASE_TAG#v}"
  TARBALL_URL=$(echo "$release_json" | jq -r '.assets[] | select(.name | startswith("engram-")) | .browser_download_url')

  if [ -z "$RELEASE_TAG" ] || [ "$RELEASE_TAG" = "null" ]; then
    die "No releases found for ${REPO}"
  fi
  if [ -z "$TARBALL_URL" ] || [ "$TARBALL_URL" = "null" ]; then
    die "No tarball asset found in release ${RELEASE_TAG}"
  fi

  info "Latest release: ${RELEASE_TAG}"
}

# --- download and extract ---

download_and_extract() {
  local version_dir="${INSTALL_BASE}/${RELEASE_TAG}"

  if [ -d "$version_dir" ]; then
    warn "Version ${RELEASE_TAG} already exists at ${version_dir}, reinstalling..."
    rm -rf "$version_dir"
  fi

  mkdir -p "$version_dir"

  info "Downloading ${RELEASE_TAG}..."
  local tmpfile
  tmpfile=$(mktemp)
  curl -fsSL -o "$tmpfile" "$TARBALL_URL"

  info "Extracting to ${version_dir}..."
  tar xzf "$tmpfile" -C "$version_dir"
  rm -f "$tmpfile"

  info "Installing dependencies..."
  (cd "$version_dir" && bun install --frozen-lockfile)

  info "Creating CLI wrapper..."
  cat > "$version_dir/engram" <<'WRAPPER'
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$(readlink "$0" || echo "$0")")" && pwd)"
exec bun run "$SCRIPT_DIR/src/cli.ts" "$@"
WRAPPER
  chmod +x "$version_dir/engram"

  ok "Installed ${RELEASE_TAG} to ${version_dir}"
}

# --- symlink management ---

update_symlink() {
  local version_dir="${INSTALL_BASE}/${RELEASE_TAG}"
  local latest_link="${INSTALL_BASE}/latest"

  rm -f "$latest_link"
  ln -s "$version_dir" "$latest_link"
  echo "$RELEASE_TAG" > "${INSTALL_BASE}/current-version"

  ok "Symlinked latest -> ${RELEASE_TAG}"
}

# --- prune old versions ---

prune_versions() {
  info "Pruning old versions (keeping ${MAX_VERSIONS})..."
  local versions=()
  for d in "${INSTALL_BASE}"/v*; do
    [ -d "$d" ] && versions+=("$(basename "$d")")
  done

  if [ ${#versions[@]} -eq 0 ]; then
    return
  fi

  # sort by semver (strip v prefix, sort numerically)
  IFS=$'\n' sorted=($(printf '%s\n' "${versions[@]}" | sed 's/^v//' | sort -t. -k1,1n -k2,2n -k3,3n | sed 's/^/v/'))
  unset IFS

  local count=${#sorted[@]}
  if [ "$count" -gt "$MAX_VERSIONS" ]; then
    local remove_count=$((count - MAX_VERSIONS))
    for ((i = 0; i < remove_count; i++)); do
      local old_version="${sorted[$i]}"
      info "Removing old version: ${old_version}"
      rm -rf "${INSTALL_BASE}/${old_version}"
    done
  fi
}

# --- data directory ---

setup_data_dir() {
  mkdir -p "$DATA_DIR"
  ok "Data directory ready: ${DATA_DIR}"
}

# --- CLI binary ---

install_cli() {
  mkdir -p "$BIN_DIR"
  ln -sf "${INSTALL_BASE}/latest/engram" "${BIN_DIR}/engram"
  ok "CLI linked: ${BIN_DIR}/engram"

  if [[ ":$PATH:" != *":${BIN_DIR}:"* ]]; then
    warn "~/.local/bin is not in your PATH. Add it to your shell profile:"
    warn "  export PATH=\"\$HOME/.local/bin:\$PATH\""
  fi
}

# --- status ---

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

#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "=== Engram Installation ==="
echo ""

# Check for Bun
if ! command -v bun &> /dev/null; then
    echo "Bun is not installed."
    echo "Install it with: curl -fsSL https://bun.sh/install | bash"
    exit 1
fi

echo "✓ Bun found: $(bun --version)"

# Install dependencies
echo ""
echo "Installing dependencies..."
cd "$PROJECT_DIR"
bun install

# Create data directory
DATA_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/engram"
echo ""
echo "Creating data directory: $DATA_DIR"
mkdir -p "$DATA_DIR"
echo "✓ Data directory ready"

# Output configuration
echo ""
echo "=== Installation Complete ==="
echo ""
echo "Add this to your MCP client configuration:"
echo ""
echo "  {"
echo "    \"mcpServers\": {"
echo "      \"engram\": {"
echo "        \"command\": \"bun\","
echo "        \"args\": [\"run\", \"$PROJECT_DIR/src/index.ts\"]"
echo "      }"
echo "    }"
echo "  }"
echo ""
echo "Database location: $DATA_DIR/engram.db"
echo ""
echo "To override database path, set ENGRAM_DB_PATH environment variable."

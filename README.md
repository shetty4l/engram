# Engram

Persistent memory for AI agents. An MCP server that gives your AI assistant long-term memory across sessions.

## Quick Start

```bash
# Clone and install
git clone <repo>
cd engram
./scripts/install.sh
```

## OpenCode Setup

Use this flow when running Engram with OpenCode.

### Prerequisites

- `bun` installed
- `opencode` installed
- `engram` CLI on PATH (run `bun link` in this repo once)

### 1) Sync the OpenCode plugin

From the repo root:

```bash
bun run setup
```

This copies `opencode/plugins/engram.ts` to `~/.config/opencode/plugins/engram.ts`.

### 2) Add Engram MCP server to OpenCode

Create or update `~/.config/opencode/opencode.json` with this block:

```bash
bun run opencode:config
```

This prints a ready-to-paste OpenCode config block with your local absolute path.

```json
{
  "mcp": {
    "engram": {
      "type": "local",
      "enabled": true,
      "command": ["bun", "run", "/path/to/engram/src/index.ts"]
    }
  }
}
```

Replace `/path/to/engram` with your local checkout path.

### 3) Restart OpenCode

Restart OpenCode so it loads the plugin and MCP server config.

### Verification

```bash
engram status
```

- If the daemon is not running yet, that is OK.
- The plugin auto-starts the daemon on `session.idle` or `experimental.session.compacting`.
- Data and runtime files live in `~/.local/share/engram/` (DB, PID, logs).

### Troubleshooting

- `engram: command not found`: run `bun link` from this repo.
- Plugin not loading: verify `~/.config/opencode/plugins/engram.ts` exists, then rerun `bun run setup` and restart OpenCode.
- Daemon issues:
  - `engram status`
  - `engram restart`
  - `curl http://127.0.0.1:7749/health`

Add to your MCP client config (e.g., OpenCode, Claude Desktop):

```json
{
  "mcpServers": {
    "engram": {
      "command": "bun",
      "args": ["run", "/path/to/engram/src/index.ts"]
    }
  }
}
```

## Tools

### `remember`

Store a memory for later retrieval.

```
remember({ content: "User prefers TypeScript over JavaScript", category: "preference" })
```

**Parameters:**
- `content` (required): The memory content
- `category` (optional): `decision`, `pattern`, `fact`, `preference`, `insight`

### `recall`

Retrieve relevant memories.

```
recall({ query: "coding preferences", limit: 5 })
```

**Parameters:**
- `query` (required): What to search for
- `limit` (optional): Max results (default: 10)
- `category` (optional): Filter by category
- `min_strength` (optional): Minimum strength threshold (0.0-1.0)

### `forget`

Delete a stored memory by ID.

```
forget({ id: "memory-uuid" })
```

**Parameters:**
- `id` (required): Memory ID to delete

**Returns:**
- `id`: Requested memory ID
- `deleted`: `true` if a memory was deleted, `false` if it did not exist

When users ask to forget by phrase (for example, "forget the memory about API keys"),
the assistant should first call `recall` to resolve candidates, then call `forget`
with the selected memory ID.

## Configuration

Database location: `~/.local/share/engram/engram.db`

Override with environment variable:
```bash
ENGRAM_DB_PATH=/custom/path/engram.db
```

## Development

```bash
# Core test suite (fast + CI-safe)
bun run test:core

# Full test suite (includes embedding/WASM tests)
bun run test:full

# Type check
bun run typecheck

# Lint
bun run lint

# All validation
bun run validate

# Full validation (includes embedding/WASM tests)
bun run validate:full
```

`validate` intentionally runs the core suite (`test:core`) as the required CI gate.
CI also runs `test:full` on every push and pull request. If full-suite assertions pass
but Bun exits with the known transformers/WASM runtime crash (`133`), CI records a warning
and continues. Any real test failures still fail CI.

## CI/CD

- CI workflow: `.github/workflows/ci.yml`
  - Runs on every push and pull request
  - Executes required `bun run validate`
  - Executes `bun run test:full` with special handling for known Bun exit `133`

## Roadmap

- **Slice 1** (current): Basic CRUD with strength/recency ordering
- **Slice 2**: Semantic search with embeddings (Ollama + sqlite-vec)
- **Slice 3**: Deduplication, merging, decay algorithm
- **Slice 4**: Conflict detection and resolution (`reflect` tool)
- **Slice 5**: Export/import for portability

## License

MIT

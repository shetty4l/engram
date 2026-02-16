# Engram

Persistent memory for AI agents. An MCP server that gives your AI assistant long-term memory across sessions.

## Quick Start

### Option 1: Install from release (Recommended)

```bash
curl -fsSL https://github.com/shetty4l/engram/releases/latest/download/install.sh | bash
```

This will:
- Download and extract the latest release to `~/srv/engram/<version>/`
- Install dependencies and build the `engram` CLI binary
- Symlink the CLI to `~/.local/bin/engram`
- Manage a `latest` symlink and prune old versions (keeps last 5)
- Print the MCP config to add to your client

**Requirements:** `bun`, `curl`, `tar`, `jq`

Add to your MCP client config:

```json
{
  "engram": {
    "command": "bun",
    "args": ["run", "~/srv/engram/latest/src/index.ts"]
  }
}
```

### Option 2: Local development

Clone the repo and run the setup script. Use this if you want to contribute or modify engram.

```bash
git clone https://github.com/shetty4l/engram.git
cd engram
./scripts/setup-local.sh
```

### Option 3: AWS EC2 (Always-on, cross-device)

Deploy to your AWS account with one command. Requires AWS CLI configured.

```bash
git clone https://github.com/shetty4l/engram.git
cd engram
./scripts/deploy-aws.sh
```

This will:
- Launch a t3.small EC2 instance with Amazon Linux 2023
- Install Bun and Engram automatically
- Configure SSM for secure access (no public ports)
- Output the MCP config to add to your client

**Requirements:**
- AWS CLI installed and configured (`aws configure` or `aws sso login`)
- IAM permissions: EC2, IAM, SSM

**Cost:** ~$15-20/month (t3.small + 10GB EBS). Stop the instance when not in use to save costs.

**Cleanup:**
```bash
./scripts/destroy-aws.sh
```

The script creates `~/.engram/` with your key and instance info.

## OpenCode Setup

Use this flow when running Engram with OpenCode.

### Prerequisites

- `bun` installed
- `opencode` installed
- `engram` CLI on PATH (installed automatically by `install.sh`, or run `bun link` from a local clone)

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

- `engram: command not found`: If installed from release, ensure `~/.local/bin` is in your PATH. If running from a clone, run `bun link` from the repo.
- Plugin not loading: verify `~/.config/opencode/plugins/engram.ts` exists, then rerun `bun run setup` and restart OpenCode.
- Daemon issues:
  - `engram status`
  - `engram restart`
  - `curl http://127.0.0.1:7749/health`

## Tools

### `remember`

Store a memory for later retrieval.

```
remember({ content: "User prefers TypeScript over JavaScript", category: "preference" })
```

**Parameters:**
- `content` (required): The memory content
- `category` (optional): `decision`, `pattern`, `fact`, `preference`, `insight`
- `scope_id`, `chat_id`, `thread_id`, `task_id` (optional): Scope filters for isolation
- `metadata` (optional): Structured metadata object
- `idempotency_key` (optional): Safe retry key
- `upsert` (optional): When `true`, update the existing memory matching the `idempotency_key` instead of creating a new one. Requires `idempotency_key`.

**Returns:** `{ id: string, status: "created" | "updated" }`

**Upsert behavior:**
- When `upsert: true` and a memory with the same `idempotency_key` (and `scope_id`) exists: overwrites `content`, `category`, `metadata`, and `embedding`. Does not change `created_at`, `access_count`, `strength`, or scope fields.
- Uses full-replace semantics: omitted optional fields (`category`, `metadata`) are set to `null`.
- When no match exists: creates a new memory normally.
- When `upsert` is omitted or `false`: standard idempotency replay (returns cached result, no mutation).

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
- `scope_id`, `chat_id`, `thread_id`, `task_id` (optional): Scope filters (feature-flagged)

### `forget`

Delete a stored memory by ID.

```
forget({ id: "memory-uuid" })
```

**Parameters:**
- `id` (required): Memory ID to delete
- `scope_id` (optional): Scope guard for deletion (required when `ENGRAM_ENABLE_SCOPES=1`)

**Returns:**
- `id`: Requested memory ID
- `deleted`: `true` if a memory was deleted, `false` if it did not exist

### `capabilities`

Discover server version and feature flags for compatibility-safe client opt-in.

### `context_hydrate`

Retrieve contextual memories for assistant turns. Behavior mirrors `recall`, with `query` optional.

When users ask to forget by phrase (for example, "forget the memory about API keys"),
the assistant should first call `recall` to resolve candidates, then call `forget`
with the selected memory ID.

## Memory Decay

Memories decay in strength over time when not accessed, helping prioritize relevant knowledge:

- **Decay rate**: 0.95 per day (~50% strength after 14 days without access)
- **Access boost**: Accessing a memory resets its strength to 1.0
- **Access count boost**: Frequently-accessed memories get a log-scale bonus

### CLI Commands

```bash
# View decay status for all memories
engram decay

# Apply decayed strengths to database
engram decay --apply

# Preview what would be pruned (dry run)
engram prune --threshold=0.1 --dry-run

# Delete memories below threshold
engram prune --threshold=0.1
```

### Configuration

Override defaults with environment variables:
```bash
ENGRAM_DECAY_RATE=0.95              # Daily decay multiplier (default: 0.95)
ENGRAM_ACCESS_BOOST_STRENGTH=1.0    # Strength after access (default: 1.0)
```

## Configuration

Database location: `~/.local/share/engram/engram.db`

Override with environment variable:
```bash
ENGRAM_DB_PATH=/custom/path/engram.db
```

Feature flags (all default to disabled):
```bash
ENGRAM_ENABLE_SCOPES=1
ENGRAM_ENABLE_IDEMPOTENCY=1
ENGRAM_ENABLE_CONTEXT_HYDRATION=1
ENGRAM_ENABLE_WORK_ITEMS=1
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

- **CI workflow**: `.github/workflows/ci.yml`
  - Runs on every push and pull request
  - Executes required `bun run validate`
  - Executes `bun run test:full` with special handling for known Bun exit `133`
- **Release workflow**: `.github/workflows/release.yml`
  - Triggers automatically on CI success on `main`
  - Auto-increments the patch version from the latest git tag
  - Creates a source tarball and publishes a GitHub Release with `install.sh`
  - Install: `curl -fsSL https://github.com/shetty4l/engram/releases/latest/download/install.sh | bash`

## Roadmap

- **Slice 1** ✅: Basic CRUD with strength/recency ordering
- **Slice 2** ✅: Full-text search with FTS5
- **Slice 3** ✅: HTTP server and daemon
- **Slice 4** ✅: Semantic search with local embeddings
- **Slice 5** ✅: Memory decay algorithm
- **Slice 6**: Deduplication and conflict detection
- **Slice 7**: Export/import for portability

## License

MIT

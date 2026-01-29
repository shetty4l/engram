# Engram

Persistent memory for AI agents. An MCP server that gives your AI assistant long-term memory across sessions.

## Quick Start

```bash
# Clone and install
git clone <repo>
cd engram
./scripts/install.sh
```

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

## Configuration

Database location: `~/.local/share/engram/engram.db`

Override with environment variable:
```bash
ENGRAM_DB_PATH=/custom/path/engram.db
```

## Development

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Lint
bun run lint

# All validation
bun run validate
```

## Roadmap

- **Slice 1** (current): Basic CRUD with strength/recency ordering
- **Slice 2**: Semantic search with embeddings (Ollama + sqlite-vec)
- **Slice 3**: Deduplication, merging, decay algorithm
- **Slice 4**: Conflict detection and resolution (`reflect` tool)
- **Slice 5**: Export/import for portability

## License

MIT

# Engram - Persistent Memory for AI Agents

A local MCP server providing long-term, cross-project memory for AI coding agents.

## Problem

Long agent conversations suffer from context compaction - the agent progressively loses:
- Earlier decisions and their rationale
- Accumulated understanding of codebase patterns
- Personal preferences and conventions
- Insights learned during the session

This forces repetitive re-explanation and degraded assistance quality.

## Solution

A persistent "second brain" that:
- Automatically captures knowledge from conversations
- Semantically retrieves relevant memories when needed
- Works across all projects and sessions
- Requires zero manual curation (no more markdown knowledge bases)

---

## Architecture

```
┌────────────────────────────────────────────────────────┐
│                    Agent Session                        │
│                                                         │
│   Automatic triggers:                                   │
│   - Session start → recall relevant context            │
│   - Decision made → remember                           │
│   - Pattern observed → remember                        │
│   - Session end → consolidate learnings                │
└───────────────────────┬────────────────────────────────┘
                        │ MCP Protocol (stdio)
                        ▼
┌────────────────────────────────────────────────────────┐
│              Engram MCP Server                          │
│                                                         │
│   Tools:                                                │
│   - remember(content, category?) → store memory        │
│   - recall(query, limit?) → retrieve relevant memories │
│                                                         │
│   Internal:                                             │
│   - Embedding generation (local transformers.js)       │
│   - Cosine similarity for semantic search              │
│   - FTS5 fallback for keyword search                   │
└───────────────────────┬────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        │                               │
        ▼                               ▼
┌───────────────────┐     ┌─────────────────────────────┐
│   HTTP Server     │     │      SQLite Database        │
│   (localhost)     │     │  ~/.local/share/engram/     │
│                   │     │                             │
│ POST /remember    │     │  Tables:                    │
│ POST /recall      │     │  - memories (content,       │
│ GET  /health      │     │      embedding, strength)   │
│                   │     │  - memories_fts (FTS5)      │
│ Used by:          │     │  - metrics (usage stats)    │
│ - OpenCode plugin │     │                             │
└───────────────────┘     └─────────────────────────────┘
```

---

## Core Concepts

### Memory Categories

Free-form content, optionally tagged:
- **decision** - "Prefer X over Y because Z"
- **pattern** - "This codebase uses repository pattern"
- **fact** - "Auth service lives in src/auth"
- **preference** - "User prefers verbose commit messages"
- **insight** - "Learned that X doesn't work because Y"

Categories are hints, not strict taxonomy. Memories are primarily retrieved by semantic similarity.

### Memory Lifecycle

**Creation:**
1. Agent calls `remember(content)`
2. Generate embedding via Ollama (or fallback to keywords)
3. Check for similar existing memories (cosine similarity > 0.85)
4. If similar: merge into existing memory, store old version in revisions
5. If novel: create new memory
6. Check for contradictions with other memories, flag if found

**Retrieval:**
1. Agent calls `recall(query)`
2. Generate query embedding
3. Find top-N similar memories by vector distance
4. Score by: `similarity * strength`
5. Return ranked results

**Decay:**
- Each memory has a `strength` score (0.0 - 1.0)
- Strength decays over time: `strength = base * 0.95^(days_since_access)`
- Accessing a memory resets decay and increments access count
- Access count provides log-scale boost: `* min(log(access_count + 1) / log(2), max_access_boost)`
- Default max access boost: 2.0 (configurable via `ENGRAM_DECAY_MAX_ACCESS_BOOST`)
- Low-strength memories sink below retrieval threshold but are never deleted

**Conflict Resolution (agent-side, not Engram):**
1. Calling agent detects conflicts during recall-before-remember check
2. Clear-cut cases: agent resolves autonomously (forget old + remember new)
3. Ambiguous cases: agent flags with `metadata: { needs_review: true, review_reason: "..." }`
4. User requests review: agent recalls flagged memories via `metadata_filter`, presents options per conflict
5. Options: keep new (forget old), enrich (merge both), keep both (mark resolved), dismiss
6. Resolution via existing tools: `forget()` + `remember()` with updated metadata

---

## Database Schema

```sql
-- Core memories
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT,
    
    -- Temporal tracking
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_accessed TEXT DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 1,
    
    -- Decay/relevance scoring
    strength REAL DEFAULT 1.0,
    
    -- Vector for semantic search (Float32Array as blob)
    embedding BLOB
);

-- Full-text search index
CREATE VIRTUAL TABLE memories_fts USING fts5(
    content,
    content='memories',
    content_rowid='rowid'
);

-- Usage metrics
CREATE TABLE metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    session_id TEXT,
    event TEXT NOT NULL,          -- 'remember', 'recall'
    memory_id TEXT,               -- for remember events
    query TEXT,                   -- for recall events
    result_count INTEGER,         -- for recall events
    was_fallback INTEGER          -- for recall events (1 if empty query)
);

-- Indexes for common queries
CREATE INDEX idx_memories_strength ON memories(strength);
CREATE INDEX idx_memories_last_accessed ON memories(last_accessed);
CREATE INDEX idx_metrics_session_id ON metrics(session_id);
```

---

## MCP Tools

### `remember`

Store a new memory.

**Input:**
```typescript
{
    content: string;      // The memory content (required)
    category?: string;    // Optional: decision, pattern, fact, preference, insight
}
```

**Output:**
```typescript
{
    id: string;                    // Memory ID
    merged_with?: string;          // If merged with existing memory
    conflict_detected?: boolean;   // If contradiction found
    conflict_with?: string;        // ID of conflicting memory
}
```

**Behavior:**
1. Generate embedding for content
2. Search for similar memories (threshold: 0.85)
3. If similar found: merge, preserve revision
4. If novel: create new memory
5. Scan for contradictions (high similarity but opposing sentiment/content)
6. Return result with any flags

### `recall`

Retrieve relevant memories.

**Input:**
```typescript
{
    query: string;          // What to search for (required)
    limit?: number;         // Max results, default 10
    category?: string;      // Filter by category
    min_strength?: number;  // Filter weak memories, default 0.1
    metadata_filter?: Record<string, unknown>;  // Filter by metadata (exact-match, AND logic)
}
```

**Output:**
```typescript
{
    memories: Array<{
        id: string;
        content: string;
        category: string | null;
        strength: number;
        relevance: number;      // Combined similarity * strength
        created_at: string;
        access_count: number;
    }>;
    fallback_mode: boolean;    // True if using keyword search (Ollama unavailable)
}
```

**Behavior:**
1. Generate query embedding (or extract keywords if Ollama unavailable)
2. Vector similarity search (or keyword match as fallback)
3. Apply strength weighting
4. Update `last_accessed` and `access_count` for returned memories
5. Recalculate strength based on access
6. Return ranked results

### Reflection (via `recall` + `metadata_filter`)

Conflict resolution uses existing tools rather than a dedicated `reflect` tool:

1. Agent stores ambiguous memories with `metadata: { needs_review: true, review_reason: "..." }`
2. To review: `recall({ query: "", metadata_filter: { needs_review: true } })`
3. Agent presents flagged memories to user with resolution options
4. Resolution via `forget()` + `remember()` with updated metadata

**Metadata conventions for conflict tracking:**
- `{ needs_review: true, review_reason: "..." }` — flagged for user review
- `{ supersedes: "<memory-id>", supersedes_reason: "..." }` — newer replaces older
- `{ related_to: ["<id-1>", "<id-2>"] }` — non-hierarchical links

To update metadata without changing content: `forget(id)` then `remember(same content, updated metadata)`.

---

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | MCP SDK support, type safety |
| Runtime | Bun | Fast, built-in SQLite, test runner, TypeScript support |
| Database | bun:sqlite | Native SQLite bindings, no external deps |
| Full-text Search | FTS5 | Built into SQLite, BM25 ranking |
| Embeddings | @huggingface/transformers | Local WASM, no external services required |
| Embedding Model | bge-small-en-v1.5 | Good quality, 384 dimensions, ~33MB |
| Vector Search | Pure JS cosine similarity | No native deps, fully Bun compatible |
| MCP SDK | @modelcontextprotocol/sdk | Standard protocol |
| Linter | oxlint | Fast Rust-based linter |
| Formatter | Biome | Fast Rust-based formatter + import sorting |

---

## Project Structure

```
engram/
├── .gitignore              # Git ignore patterns
├── .husky/pre-commit       # Pre-commit validation hook
├── AGENTS.md               # Project rules (validation gate)
├── PLAN.md                 # This file
├── biome.json              # Formatter + import sorting config
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts            # MCP server entry point
│   ├── config.ts           # Configuration (paths, thresholds, embedding model)
│   ├── embedding.ts        # Embedding generation with transformers.js
│   ├── cli.ts              # CLI commands (stats, search, daemon control)
│   ├── http.ts             # HTTP server for REST API
│   ├── daemon.ts           # Daemon process management
│   │
│   ├── db/
│   │   ├── index.ts        # Database connection, queries, migrations
│   │   └── schema.sql      # Table definitions (memories, FTS5, metrics)
│   │
│   └── tools/
│       ├── remember.ts     # remember tool - store with embeddings
│       └── recall.ts       # recall tool - semantic search
│
├── test/
│   ├── db.test.ts          # Database operations
│   ├── remember.test.ts    # remember tool tests
│   ├── recall.test.ts      # recall tool tests (including semantic)
│   ├── metrics.test.ts     # Metrics tracking tests
│   └── cli.test.ts         # CLI command tests
│
├── scripts/
│   ├── install.sh          # Install dependencies, setup
│   └── setup.ts            # Deploy OpenCode plugin
│
├── opencode/
│   └── plugins/
│       └── engram.ts       # OpenCode plugin for auto memory capture
│
└── README.md               # Usage documentation
```

---

## Configuration

**Environment variables** (all optional, have defaults):

```bash
ENGRAM_DB_PATH=~/.local/share/engram/engram.db    # Database location
ENGRAM_HTTP_PORT=7749                              # HTTP server port
ENGRAM_HTTP_HOST=127.0.0.1                         # HTTP server host
ENGRAM_EMBEDDING_MODEL=Xenova/bge-small-en-v1.5   # Embedding model
ENGRAM_DECAY_RATE=0.95                             # Daily decay rate
ENGRAM_DECAY_MAX_ACCESS_BOOST=2.0                  # Max access count boost multiplier
ENGRAM_PLUGIN_AUTO_EXTRACT=1                       # Plugin auto-extraction (0 to disable)
```

**Default paths:**
- Database: `~/.local/share/engram/engram.db`
- Model cache: `~/.local/share/engram/models/`
- PID file: `~/.local/share/engram/engram.pid`
- Log file: `~/.local/share/engram/engram.log`

---

## Implementation Slices

Development follows vertical slices - each slice delivers working end-to-end functionality.

### Slice 1: Foundation + Basic CRUD ✅
**Goal:** Working MCP server that stores and retrieves memories (no semantic search)

- [x] Project setup (package.json, tsconfig.json, AGENTS.md)
- [x] Configuration management with defaults + custom DB path support
- [x] SQLite database initialization with schema
- [x] `remember` tool - store content with ID and timestamps
- [x] `recall` tool - retrieve all memories, ordered by strength/recency
- [x] Unit tests for core logic (18 tests)
- [x] Installer script (bun install, create data dir, output MCP config)
- [x] README with basic setup
- [x] Code formatting with Biome + import sorting
- [x] Pre-commit hook with Husky

**Validation gate:** `bun run validate` (typecheck + lint + format:check + test)

### Slice 2: FTS5 Keyword Search ✅
**Goal:** Full-text search for memory retrieval

- [x] FTS5 virtual table for content indexing
- [x] BM25 ranking for search relevance
- [x] Prefix search support (e.g., "Type*")
- [x] Boolean operators (OR)
- [x] Graceful fallback to recent memories when query empty

### Slice 2.5: Metrics and Session Tracking ✅
**Goal:** Usage analytics for memory system

- [x] Metrics table for tracking remember/recall events
- [x] Session ID support for per-session analytics
- [x] Hit rate and fallback rate calculations
- [x] CLI `metrics` command

### Slice 3: HTTP Server and Daemon ✅
**Goal:** REST API for external integrations

- [x] HTTP server with `/remember`, `/recall`, `/health` endpoints
- [x] Daemon management (start/stop/status/restart)
- [x] CLI commands for server control (`serve`, `start`, `stop`, `status`, `restart`)
- [x] CLI commands for memory inspection (`stats`, `recent`, `search`, `show`)
- [x] PID file and log file management

### Slice 3.5: OpenCode Plugin Integration ✅
**Goal:** Automatic memory capture from OpenCode sessions

- [x] Plugin that hooks into `session.idle` events
- [x] Auto-starts daemon if not running
- [x] Calls HTTP API to persist session context
- [x] Setup script for plugin deployment (`bun run setup`)

### Slice 4: Semantic Search with Local Embeddings ✅
**Goal:** Vector similarity search without external dependencies

- [x] `@huggingface/transformers` for local embedding generation
- [x] `bge-small-en-v1.5` model (384 dimensions, ~33MB, WASM)
- [x] Embeddings stored as BLOB in SQLite
- [x] Cosine similarity search in pure JavaScript
- [x] FTS5 fallback when embeddings unavailable
- [x] Async `remember`/`recall` for embedding generation
- [x] Database migration for existing databases

### Slice 5: Memory Lifecycle ✅
**Goal:** Memory decay and management

- [x] Decay algorithm (strength reduces over time without access)
- [x] Strength boost on access
- [x] Prune low-strength memories (CLI command)
- [x] `engram decay` CLI command to view/apply decay
- [x] `engram prune` CLI command with --dry-run option
- [x] Configurable decay rate via environment variables

### Slice 5.5: Retrieval Quality ✅
**Goal:** Make retrieval leverage the full architecture; establish LLM-driven intelligence pattern

Architectural decision: **Keep Engram simple, let the calling agent handle intelligence.** Engram improves retrieval quality (ranking, filtering, decay). Knowledge management intelligence (dedup, conflicts, relationships, reflection) should be handled by the calling agent's system prompt, not by Engram code.

- [x] Strength-weighted ranking: `relevance = similarity * decayedStrength` (was pure cosine)
- [x] Access boost cap: `min(log(accessCount+1)/log(2), maxAccessBoost)` (default 2.0)
- [x] Metadata filtering in `recall()`: `metadata_filter` parameter for exact-match AND logic
- [x] OpenCode plugin auto-extraction configurable via `ENGRAM_PLUGIN_AUTO_EXTRACT=0`

Calling agent system prompt changes (not Engram code):
- [ ] REMEMBER mode: recall-before-remember dedup check
- [ ] Metadata conventions: `supersedes`, `needs_review`, `related_to`
- [ ] REFLECT mode: surface flagged memories, present resolution options to user

### Slice 6: Agent-Driven Memory Intelligence (Future)
**Goal:** Knowledge management via agent system prompt conventions

Intelligence lives in the calling agent, not in Engram. Engram provides storage and retrieval primitives; the agent's system prompt should instruct it to use them intelligently.

- [ ] Dedup: agent recalls similar content before storing, skips duplicates
- [ ] Conflict detection: agent classifies relationships (complementary/contradictory/supersedes)
- [ ] Metadata conventions for relationship tracking (supersedes, needs_review, related_to)
- [ ] OpenCode plugin refactor: replace raw log dumping with agent-mediated extraction

### Slice 7: Portability (Future)
**Goal:** Transport memory across machines

- [ ] `engram export` - export to JSON format
- [ ] `engram import` - import with replace/merge modes
- [ ] Embeddings included in export (handles non-determinism)

---

## Open Questions / Future Considerations

1. **Memory size limits** - Should individual memories have a max length? Very long memories might dominate similarity searches.

2. **Multi-agent** - If multiple agent sessions run concurrently, SQLite handles this (WAL mode), but conflict detection might flag false positives.

3. **Privacy** - All data is local. But should there be an explicit "forget everything about X" command?

4. **Embedding model updates** - When upgrading models, existing embeddings become incompatible. Need a re-embedding migration strategy.

---

## Success Criteria

The system is working when:

1. **Persistence** - Information shared in one session is available in the next
2. **Relevance** - `recall` returns genuinely useful memories, not noise
3. **Zero maintenance** - No manual curation needed after initial adoption
4. **Graceful degradation** - Works with FTS5 keyword search when embeddings unavailable
5. **Non-intrusive** - Doesn't noticeably slow down agent responses
6. **Cross-project** - Learnings from project A help when working on project B
7. **Local-first** - All data and models run locally, no external services required

---

## Development Workflow

### Validation Gate
All code changes must pass before proceeding:
```bash
bun run validate  # typecheck + lint + test
```

### Scripts
```json
{
    "scripts": {
        "typecheck": "tsc --noEmit",
        "lint": "oxlint src/",
        "format": "biome check --write src/ test/",
        "format:check": "biome check src/ test/",
        "test": "bun test",
        "validate": "bun run typecheck && bun run lint && bun run format:check && bun test",
        "start": "bun run src/index.ts"
    }
}
```

### Testing Strategy
- Unit tests with Bun's built-in test runner
- Test database uses `:memory:` SQLite for speed and isolation
- Test files in `test/` directory with `*.test.ts` naming

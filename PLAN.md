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
│   - reflect() → surface conflicts for resolution       │
│                                                         │
│   Internal:                                             │
│   - Embedding generation (Ollama)                      │
│   - Similarity detection for deduplication             │
│   - Decay scoring on access patterns                   │
└───────────────────────┬────────────────────────────────┘
                        │
                        ▼
┌────────────────────────────────────────────────────────┐
│              SQLite Database                            │
│              ~/.local/share/engram/engram.db           │
│                                                         │
│   Tables:                                               │
│   - memories     (content, embedding, strength, etc)   │
│   - revisions    (memory edit history)                 │
│   - conflicts    (detected contradictions)             │
└────────────────────────────────────────────────────────┘
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
- Access count provides log-scale boost: `* log(access_count + 1)`
- Low-strength memories sink below retrieval threshold but are never deleted

**Conflict Resolution:**
1. Agent calls `reflect()` 
2. Return unresolved conflicts with both memories
3. Present options: keep A, keep B, merge, keep both (context-dependent)
4. User chooses, system updates accordingly

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
    
    -- Vector for semantic search (stored as blob)
    embedding BLOB
);

-- Revision history for merged/edited memories
CREATE TABLE revisions (
    id TEXT PRIMARY KEY,
    memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    old_content TEXT NOT NULL,
    changed_at TEXT DEFAULT (datetime('now')),
    reason TEXT  -- 'merged', 'edited', 'superseded'
);

-- Flagged contradictions awaiting resolution
CREATE TABLE conflicts (
    id TEXT PRIMARY KEY,
    memory_a_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    memory_b_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    flagged_at TEXT DEFAULT (datetime('now')),
    resolved INTEGER DEFAULT 0,
    resolution TEXT  -- 'kept_a', 'kept_b', 'merged', 'context_dependent'
);

-- Indexes for common queries
CREATE INDEX idx_memories_strength ON memories(strength);
CREATE INDEX idx_memories_last_accessed ON memories(last_accessed);
CREATE INDEX idx_conflicts_resolved ON conflicts(resolved);
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

### `reflect`

Surface and resolve conflicts.

**Input:**
```typescript
{
    resolve?: {
        conflict_id: string;
        action: 'keep_a' | 'keep_b' | 'merge' | 'keep_both';
        merged_content?: string;  // Required if action is 'merge'
    }
}
```

**Output (when no resolve provided):**
```typescript
{
    conflicts: Array<{
        id: string;
        memory_a: { id: string; content: string; created_at: string; access_count: number; };
        memory_b: { id: string; content: string; created_at: string; access_count: number; };
        flagged_at: string;
    }>;
}
```

**Output (when resolving):**
```typescript
{
    resolved: boolean;
    action_taken: string;
    resulting_memory_id?: string;  // If merged
}
```

---

## Tech Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | MCP SDK support, type safety |
| Runtime | Bun | Fast, built-in SQLite, test runner, TypeScript support |
| Database | bun:sqlite | Native SQLite bindings, no external deps |
| Vector Search | @mceachen/sqlite-vec | Native SQLite extension, prebuilt binaries |
| Embeddings | Ollama (nomic-embed-text) | Local, private, good quality |
| Fallback | Keyword extraction | Works when Ollama unavailable |
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
│   ├── config.ts           # Configuration (paths, thresholds)
│   │
│   ├── db/
│   │   ├── index.ts        # Database connection and setup
│   │   └── schema.sql      # Table definitions
│   │
│   ├── memory/             # (Slice 2+)
│   │   ├── remember.ts     # Store logic with dedup
│   │   ├── recall.ts       # Retrieval with decay scoring
│   │   ├── reflect.ts      # Conflict detection and resolution
│   │   └── decay.ts        # Strength calculations
│   │
│   ├── embeddings/         # (Slice 2+)
│   │   ├── index.ts        # Unified embedding interface
│   │   ├── ollama.ts       # Ollama client
│   │   └── fallback.ts     # Keyword extraction fallback
│   │
│   └── tools/
│       ├── remember.ts     # remember tool handler
│       └── recall.ts       # recall tool handler
│
├── test/
│   ├── db.test.ts          # Database operations
│   ├── remember.test.ts    # remember tool tests
│   └── recall.test.ts      # recall tool tests
│
├── scripts/
│   └── install.sh          # Install dependencies, setup
│
└── README.md               # Usage documentation
```

---

## Configuration

**File:** `~/.config/engram/config.json` (optional, has defaults)

```json
{
    "database": {
        "path": "~/.local/share/engram/engram.db"
    },
    "embeddings": {
        "provider": "ollama",
        "model": "nomic-embed-text",
        "fallback_enabled": true
    },
    "memory": {
        "similarity_threshold": 0.85,
        "conflict_threshold": 0.75,
        "decay_factor": 0.95,
        "min_strength": 0.1,
        "default_recall_limit": 10
    }
}
```

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

### Slice 2: Semantic Search
**Goal:** Vector similarity search working end-to-end

- [ ] Ollama client for embedding generation
- [ ] Fallback keyword extraction when Ollama unavailable
- [ ] sqlite-vec integration for vector storage
- [ ] Similarity search in recall
- [ ] Graceful degradation to keyword search
- [ ] Installer offers Ollama setup

### Slice 3: Memory Intelligence
**Goal:** Deduplication, merging, and decay

- [ ] Deduplication via similarity threshold (>0.85 = merge)
- [ ] Merge logic with revision history
- [ ] `revisions` table
- [ ] Decay algorithm implementation
- [ ] Strength recalculation on access
- [ ] Conflict detection on remember
- [ ] `conflicts` table

### Slice 4: Conflict Resolution
**Goal:** `reflect` tool for surfacing and resolving conflicts

- [ ] `reflect` tool - list unresolved conflicts
- [ ] Resolution actions: keep_a, keep_b, merge, keep_both
- [ ] Proper archival of superseded memories

### Slice 5: Portability
**Goal:** Transport memory across machines

- [ ] `engram_export` tool - export to JSON format
- [ ] `engram_import` tool - import with replace/merge modes
- [ ] Export includes embeddings (handles non-determinism)
- [ ] Version metadata in export format

### Slice 6: Polish & Integration
**Goal:** Production-ready quality

- [ ] Comprehensive README with setup instructions
- [ ] MCP client configuration examples
- [ ] Error handling and logging
- [ ] Test in real conversations
- [ ] Iterate based on usage patterns

---

## Open Questions / Future Considerations

1. **Embedding model size** - nomic-embed-text is ~270MB. Acceptable? Alternatives: all-minilm (smaller, less accurate) or mxbai-embed-large (bigger, more accurate).

2. **Batch operations** - Should recall update access patterns for all returned memories, or just top result? Currently: all returned memories.

3. **Memory size limits** - Should individual memories have a max length? Very long memories might dominate similarity searches.

4. **Multi-agent** - If multiple agent sessions run concurrently, SQLite handles this (WAL mode), but conflict detection might flag false positives.

5. **Privacy** - All data is local. But should there be an explicit "forget everything about X" command?

---

## Portability Design

**Goal:** Transport memory across machines with eventual consistency.

### Export Format (JSON)
```json
{
    "version": "1.0",
    "exported_at": "2025-01-29T10:00:00Z",
    "machine": "macbook-pro",
    "memories": [
        {
            "id": "uuid-1",
            "content": "Prefer composition over inheritance",
            "category": "decision",
            "created_at": "2025-01-15T...",
            "updated_at": "2025-01-20T...",
            "strength": 0.95,
            "access_count": 12,
            "embedding": [0.1, 0.2, ...]
        }
    ],
    "revisions": [...],
    "conflicts": [...]
}
```

### Import Modes
- **Replace**: Wipe local DB, load import (clean slate)
- **Merge**: Add new memories, skip duplicates by ID

### Design Decisions
- Embeddings included in export (handles non-determinism across machines)
- Single-machine-at-a-time usage model (no real-time sync)
- Custom DB path supported via config for symlink-to-cloud workflows

---

## Success Criteria

The system is working when:

1. **Persistence** - Information shared in one session is available in the next
2. **Relevance** - `recall` returns genuinely useful memories, not noise
3. **Zero maintenance** - No manual curation needed after initial adoption
4. **Graceful degradation** - Works (less optimally) when Ollama is unavailable
5. **Non-intrusive** - Doesn't noticeably slow down agent responses
6. **Cross-project** - Learnings from project A help when working on project B
7. **Portable** - Can export memories and import on a different machine

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

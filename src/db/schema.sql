-- Engram Database Schema
-- Slice 1: Core memories table
-- Slice 2: Embedding column for semantic search

CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    category TEXT,
    scope_id TEXT,
    chat_id TEXT,
    thread_id TEXT,
    task_id TEXT,
    metadata_json TEXT,
    idempotency_key TEXT,
    
    -- Temporal tracking
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    last_accessed TEXT DEFAULT (datetime('now')),
    -- access_count counts DELIVERIES (memory actually reached an agent's context);
    -- surfaced_count counts recall-search hits regardless of delivery.
    access_count INTEGER DEFAULT 1,
    surfaced_count INTEGER DEFAULT 0,
    
    -- Decay/relevance scoring
    strength REAL DEFAULT 1.0,
    
    -- Semantic embedding (Float32Array as BLOB)
    embedding BLOB
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_memories_strength ON memories(strength);
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed ON memories(last_accessed);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    content='memories',
    content_rowid='rowid'
);

-- Triggers to keep FTS index in sync with memories table
CREATE TRIGGER IF NOT EXISTS memories_fts_insert AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_update AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
    INSERT INTO memories_fts(rowid, content) VALUES (NEW.rowid, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_fts_delete AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', OLD.rowid, OLD.content);
END;

-- Metrics table for tracking usage
CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    session_id TEXT,
    event TEXT NOT NULL,          -- 'remember', 'recall', 'forget', 'delivered'
    memory_id TEXT,               -- for remember events
    query TEXT,                   -- for recall events
    result_count INTEGER,         -- for recall events
    was_fallback INTEGER,         -- for recall events (1 if empty query)
    latency_ms REAL,              -- operation latency in milliseconds
    source TEXT,                  -- recall traffic class: deliberate|auto|session-start|bridge|judge
    recall_id TEXT,               -- correlates a recall with its /delivered feedback
    memory_ids TEXT               -- JSON array of memory ids surfaced/delivered
);

-- Index for querying metrics by session
CREATE INDEX IF NOT EXISTS idx_metrics_session_id ON metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_metrics_event ON metrics(event);
-- idx_metrics_recall_id is created in runMigrations: on pre-observability
-- databases the recall_id column does not exist until migrations add it,
-- and schema.sql executes first.

-- One row per memory that actually entered an agent's context.
-- Deliberate/judge recalls self-deliver; auto/session-start recalls are
-- confirmed later by the client via POST /delivered.
CREATE TABLE IF NOT EXISTS deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recall_id TEXT NOT NULL,
    session_id TEXT,
    source TEXT,
    memory_id TEXT NOT NULL,
    chars INTEGER,
    truncated INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deliveries_recall_id ON deliveries(recall_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_memory_id ON deliveries(memory_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_created_at ON deliveries(created_at);

-- Weekly judge-audit verdicts (orchestrator-write-only by convention).
-- memory_id NULL = session-level verdict (rescue_needed / no_rescue_needed).
CREATE TABLE IF NOT EXISTS judge_audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    audit_week TEXT NOT NULL,
    session_id TEXT NOT NULL,
    memory_id TEXT,
    verdict TEXT NOT NULL,        -- used|ignored|stale_contradicted|pivotal|rescue_needed|no_rescue_needed
    note TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_judge_audits_week ON judge_audits(audit_week);

-- Idempotency table for safe retries
CREATE TABLE IF NOT EXISTS idempotency_ledger (
    key TEXT NOT NULL,
    operation TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    scope_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    result_json TEXT NOT NULL,
    PRIMARY KEY (key, operation, scope_key)
);

-- Work item tables (optional feature; additive schema)
CREATE TABLE IF NOT EXISTS work_items (
    id TEXT PRIMARY KEY,
    scope_id TEXT,
    state TEXT NOT NULL,
    owner TEXT,
    payload_json TEXT,
    result_json TEXT,
    lease_expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_work_items_state ON work_items(state);
CREATE INDEX IF NOT EXISTS idx_work_items_scope_state ON work_items(scope_id, state);

CREATE TABLE IF NOT EXISTS work_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_item_id TEXT NOT NULL,
    event TEXT NOT NULL,
    payload_json TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

CREATE INDEX IF NOT EXISTS idx_work_events_work_item_id ON work_events(work_item_id);

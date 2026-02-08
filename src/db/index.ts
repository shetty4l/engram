import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getConfig } from "../config";

let db: Database | null = null;

export interface Memory {
  id: string;
  content: string;
  category: string | null;
  scope_id: string | null;
  chat_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  metadata_json: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  last_accessed: string;
  access_count: number;
  strength: number;
  embedding: Buffer | null;
}

export interface CreateMemoryInput {
  id: string;
  content: string;
  category?: string;
  scope_id?: string;
  chat_id?: string;
  thread_id?: string;
  task_id?: string;
  metadata_json?: string;
  idempotency_key?: string;
  embedding?: Buffer;
}

export interface MemoryFilters {
  scope_id?: string;
  chat_id?: string;
  thread_id?: string;
  task_id?: string;
}

function getSchemaSQL(): string {
  const schemaPath = join(dirname(import.meta.path), "schema.sql");
  return readFileSync(schemaPath, "utf-8");
}

/**
 * Run migrations for existing databases.
 * Adds new columns that may not exist in older schemas.
 */
function hasColumn(database: Database, table: string, column: string): boolean {
  const tableInfo = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return tableInfo.some((col) => col.name === column);
}

function hasCompositeIdempotencyPrimaryKey(database: Database): boolean {
  const tableInfo = database
    .prepare("PRAGMA table_info(idempotency_ledger)")
    .all() as {
    name: string;
    pk: number;
  }[];

  const keyPrimary = tableInfo.find((column) => column.name === "key")?.pk;
  const operationPrimary = tableInfo.find(
    (column) => column.name === "operation",
  )?.pk;
  const scopeKeyPrimary = tableInfo.find(
    (column) => column.name === "scope_key",
  )?.pk;

  return keyPrimary === 1 && operationPrimary === 2 && scopeKeyPrimary === 3;
}

function migrateIdempotencyLedger(database: Database): void {
  const hasLedgerTable = database
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'idempotency_ledger'",
    )
    .get() as { name?: string } | null;

  if (!hasLedgerTable || hasCompositeIdempotencyPrimaryKey(database)) {
    return;
  }

  database.exec(`
    BEGIN;
    CREATE TABLE idempotency_ledger_new (
      key TEXT NOT NULL,
      operation TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      scope_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      result_json TEXT NOT NULL,
      PRIMARY KEY (key, operation, scope_key)
    );
    INSERT INTO idempotency_ledger_new (key, operation, scope_key, scope_id, created_at, result_json)
    SELECT key, operation, COALESCE(scope_id, '__global__'), scope_id, created_at, result_json FROM idempotency_ledger;
    DROP TABLE idempotency_ledger;
    ALTER TABLE idempotency_ledger_new RENAME TO idempotency_ledger;
    CREATE INDEX IF NOT EXISTS idx_idempotency_operation_scope
      ON idempotency_ledger(operation, scope_key);
    COMMIT;
  `);
}

function normalizeScopeKey(scope_id: string | undefined): string {
  return scope_id ?? "__global__";
}

function runMigrations(database: Database): void {
  const memoryColumns: Array<{ name: string; definition: string }> = [
    { name: "embedding", definition: "BLOB" },
    { name: "scope_id", definition: "TEXT" },
    { name: "chat_id", definition: "TEXT" },
    { name: "thread_id", definition: "TEXT" },
    { name: "task_id", definition: "TEXT" },
    { name: "metadata_json", definition: "TEXT" },
    { name: "idempotency_key", definition: "TEXT" },
  ];

  for (const column of memoryColumns) {
    if (!hasColumn(database, "memories", column.name)) {
      database.exec(
        `ALTER TABLE memories ADD COLUMN ${column.name} ${column.definition}`,
      );
    }
  }

  // Ensure additive tables exist for old databases
  database.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_ledger (
      key TEXT NOT NULL,
      operation TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      scope_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      result_json TEXT NOT NULL,
      PRIMARY KEY (key, operation, scope_key)
    );
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
  `);

  migrateIdempotencyLedger(database);

  database.exec(`
    CREATE INDEX IF NOT EXISTS idx_idempotency_operation_scope
      ON idempotency_ledger(operation, scope_key);
  `);
}

export function initDatabase(dbPath?: string): Database {
  if (db) {
    return db;
  }

  const config = getConfig();
  const path = dbPath ?? config.database.path;

  // Ensure data directory exists (unless using :memory:)
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  db = new Database(path);

  // Enable WAL mode for better concurrent access
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }

  // Run schema
  const schema = getSchemaSQL();
  db.exec(schema);

  // Run migrations for existing databases
  runMigrations(db);

  return db;
}

export function getDatabase(): Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// For testing - reset database state
export function resetDatabase(): void {
  db = null;
}

// Query functions

export function createMemory(input: CreateMemoryInput): Memory {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO memories (
      id, content, category, scope_id, chat_id, thread_id, task_id,
      metadata_json, idempotency_key, embedding
    )
    VALUES (
      $id, $content, $category, $scope_id, $chat_id, $thread_id, $task_id,
      $metadata_json, $idempotency_key, $embedding
    )
    RETURNING *
  `);

  return stmt.get({
    $id: input.id,
    $content: input.content,
    $category: input.category ?? null,
    $scope_id: input.scope_id ?? null,
    $chat_id: input.chat_id ?? null,
    $thread_id: input.thread_id ?? null,
    $task_id: input.task_id ?? null,
    $metadata_json: input.metadata_json ?? null,
    $idempotency_key: input.idempotency_key ?? null,
    $embedding: input.embedding ?? null,
  }) as Memory;
}

export function getMemoryById(id: string): Memory | null {
  const database = getDatabase();
  const stmt = database.prepare("SELECT * FROM memories WHERE id = $id");
  return (stmt.get({ $id: id }) as Memory) ?? null;
}

function applyMemoryFilters(
  filters: MemoryFilters,
  clauses: string[],
  params: Record<string, string | number>,
): void {
  if (filters.scope_id) {
    clauses.push("scope_id = $scope_id");
    params.$scope_id = filters.scope_id;
  }
  if (filters.chat_id) {
    clauses.push("chat_id = $chat_id");
    params.$chat_id = filters.chat_id;
  }
  if (filters.thread_id) {
    clauses.push("thread_id = $thread_id");
    params.$thread_id = filters.thread_id;
  }
  if (filters.task_id) {
    clauses.push("task_id = $task_id");
    params.$task_id = filters.task_id;
  }
}

export function getAllMemories(
  limit: number = 10,
  filters: MemoryFilters = {},
): Memory[] {
  const database = getDatabase();
  const clauses: string[] = [];
  const params: Record<string, string | number> = { $limit: limit };
  applyMemoryFilters(filters, clauses, params);
  const whereClause =
    clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

  const stmt = database.prepare(
    `SELECT * FROM memories ${whereClause} ORDER BY strength DESC, last_accessed DESC LIMIT $limit`,
  );
  return stmt.all(params) as Memory[];
}

export function updateMemoryAccess(id: string): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE memories 
    SET last_accessed = datetime('now'),
        access_count = access_count + 1
    WHERE id = $id
  `);
  stmt.run({ $id: id });
}

export function deleteMemoryById(id: string, scope_id?: string): boolean {
  const database = getDatabase();
  if (scope_id) {
    const scopedStmt = database.prepare(
      "DELETE FROM memories WHERE id = $id AND scope_id = $scope_id",
    );
    const scopedResult = scopedStmt.run({ $id: id, $scope_id: scope_id });
    return scopedResult.changes > 0;
  }

  const stmt = database.prepare("DELETE FROM memories WHERE id = $id");
  const result = stmt.run({ $id: id });
  return result.changes > 0;
}

export function countMemories(): number {
  const database = getDatabase();
  const stmt = database.prepare("SELECT COUNT(*) as count FROM memories");
  const result = stmt.get() as { count: number };
  return result.count;
}

export interface SearchResult extends Memory {
  rank: number;
}

export function searchMemories(
  query: string,
  limit: number,
  filters: MemoryFilters = {},
): SearchResult[] {
  const database = getDatabase();

  // Empty query falls back to recent memories by strength
  if (!query.trim()) {
    const memories = getAllMemories(limit, filters);
    return memories.map((m) => ({ ...m, rank: 0 }));
  }

  const clauses: string[] = [];
  const params: Record<string, string | number> = {
    $query: query,
    $limit: limit,
  };
  applyMemoryFilters(filters, clauses, params);
  const whereClause = clauses.length > 0 ? `AND ${clauses.join(" AND ")}` : "";

  // FTS5 search with BM25 ranking (lower rank = better match)
  const stmt = database.prepare(`
    SELECT m.*, bm25(memories_fts) as rank
    FROM memories_fts fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE memories_fts MATCH $query
    ${whereClause}
    ORDER BY rank, m.strength DESC, m.last_accessed DESC
    LIMIT $limit
  `);

  return stmt.all(params) as SearchResult[];
}

// Metrics functions

export interface MetricEvent {
  session_id?: string;
  event: "remember" | "recall" | "forget";
  memory_id?: string;
  query?: string;
  result_count?: number;
  was_fallback?: boolean;
}

export function logMetric(metric: MetricEvent): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO metrics (session_id, event, memory_id, query, result_count, was_fallback)
    VALUES ($session_id, $event, $memory_id, $query, $result_count, $was_fallback)
  `);

  stmt.run({
    $session_id: metric.session_id ?? null,
    $event: metric.event,
    $memory_id: metric.memory_id ?? null,
    $query: metric.query ?? null,
    $result_count: metric.result_count ?? null,
    $was_fallback: metric.was_fallback ? 1 : null,
  });
}

export interface MetricsSummary {
  total_remembers: number;
  total_recalls: number;
  recall_hit_rate: number;
  fallback_rate: number;
}

export function getMetricsSummary(session_id?: string): MetricsSummary {
  const database = getDatabase();

  const whereClause = session_id ? "WHERE session_id = $session_id" : "";
  const params: Record<string, string | null> = session_id
    ? { $session_id: session_id }
    : {};

  const remembers = database
    .prepare(
      `SELECT COUNT(*) as count FROM metrics ${whereClause}${whereClause ? " AND" : "WHERE"} event = 'remember'`,
    )
    .get(params) as { count: number };

  const recalls = database
    .prepare(
      `SELECT COUNT(*) as count FROM metrics ${whereClause}${whereClause ? " AND" : "WHERE"} event = 'recall'`,
    )
    .get(params) as { count: number };

  const recallHits = database
    .prepare(
      `SELECT COUNT(*) as count FROM metrics ${whereClause}${whereClause ? " AND" : "WHERE"} event = 'recall' AND result_count > 0`,
    )
    .get(params) as { count: number };

  const fallbacks = database
    .prepare(
      `SELECT COUNT(*) as count FROM metrics ${whereClause}${whereClause ? " AND" : "WHERE"} event = 'recall' AND was_fallback = 1`,
    )
    .get(params) as { count: number };

  return {
    total_remembers: remembers.count,
    total_recalls: recalls.count,
    recall_hit_rate: recalls.count > 0 ? recallHits.count / recalls.count : 0,
    fallback_rate: recalls.count > 0 ? fallbacks.count / recalls.count : 0,
  };
}

// Stats functions for CLI

export interface CategoryCount {
  category: string | null;
  count: number;
}

export interface MemoryStats {
  total_memories: number;
  categories: CategoryCount[];
  oldest_memory: string | null;
  newest_memory: string | null;
  total_access_count: number;
  avg_strength: number;
}

export function getStats(): MemoryStats {
  const database = getDatabase();

  const total = database
    .prepare("SELECT COUNT(*) as count FROM memories")
    .get() as { count: number };

  const categories = database
    .prepare(
      `SELECT category, COUNT(*) as count FROM memories GROUP BY category ORDER BY count DESC`,
    )
    .all() as CategoryCount[];

  const oldest = database
    .prepare("SELECT MIN(created_at) as date FROM memories")
    .get() as { date: string | null };

  const newest = database
    .prepare("SELECT MAX(created_at) as date FROM memories")
    .get() as { date: string | null };

  const accessCount = database
    .prepare("SELECT SUM(access_count) as total FROM memories")
    .get() as { total: number | null };

  const avgStrength = database
    .prepare("SELECT AVG(strength) as avg FROM memories")
    .get() as { avg: number | null };

  return {
    total_memories: total.count,
    categories,
    oldest_memory: oldest.date,
    newest_memory: newest.date,
    total_access_count: accessCount.total ?? 0,
    avg_strength: avgStrength.avg ?? 0,
  };
}

export function getRecentMemories(limit: number = 10): Memory[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM memories 
    ORDER BY created_at DESC
    LIMIT $limit
  `);
  return stmt.all({ $limit: limit }) as Memory[];
}

// Embedding-related functions

export interface MemoryWithEmbedding {
  id: string;
  content: string;
  category: string | null;
  scope_id: string | null;
  chat_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  strength: number;
  created_at: string;
  access_count: number;
  embedding: Buffer | null;
}

/**
 * Get all memories with embeddings for semantic search.
 */
export function getAllMemoriesWithEmbeddings(
  filters: MemoryFilters = {},
): MemoryWithEmbedding[] {
  const database = getDatabase();
  const clauses: string[] = ["embedding IS NOT NULL"];
  const params: Record<string, string> = {};
  applyMemoryFilters(filters, clauses, params);
  const whereClause = `WHERE ${clauses.join(" AND ")}`;
  const stmt = database.prepare(
    `SELECT id, content, category, scope_id, chat_id, thread_id, task_id, strength, created_at, access_count, embedding FROM memories ${whereClause}`,
  );
  return stmt.all(params) as MemoryWithEmbedding[];
}

/**
 * Get memories without embeddings (for backfill).
 */
export function getMemoriesWithoutEmbeddings(): {
  id: string;
  content: string;
}[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT id, content FROM memories WHERE embedding IS NULL
  `);
  return stmt.all() as { id: string; content: string }[];
}

/**
 * Update a memory's embedding.
 */
export function updateMemoryEmbedding(id: string, embedding: Buffer): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    UPDATE memories SET embedding = $embedding WHERE id = $id
  `);
  stmt.run({ $id: id, $embedding: embedding });
}

/**
 * Count memories with and without embeddings.
 */
export function countEmbeddingStatus(): {
  with_embedding: number;
  without_embedding: number;
} {
  const database = getDatabase();
  const withEmbed = database
    .prepare(
      "SELECT COUNT(*) as count FROM memories WHERE embedding IS NOT NULL",
    )
    .get() as { count: number };
  const withoutEmbed = database
    .prepare("SELECT COUNT(*) as count FROM memories WHERE embedding IS NULL")
    .get() as { count: number };
  return {
    with_embedding: withEmbed.count,
    without_embedding: withoutEmbed.count,
  };
}

export function getIdempotencyResult<T>(
  key: string,
  operation: string,
  scope_id?: string,
): T | null {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT result_json
    FROM idempotency_ledger
    WHERE key = $key AND operation = $operation AND scope_key = $scope_key
  `);
  const row = stmt.get({
    $key: key,
    $operation: operation,
    $scope_key: normalizeScopeKey(scope_id),
  }) as { result_json: string } | undefined;

  if (!row) {
    return null;
  }

  try {
    return JSON.parse(row.result_json) as T;
  } catch {
    return null;
  }
}

export function saveIdempotencyResult(
  key: string,
  operation: string,
  scope_id: string | undefined,
  result: unknown,
): void {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO idempotency_ledger (key, operation, scope_key, scope_id, result_json)
    VALUES ($key, $operation, $scope_key, $scope_id, $result_json)
  `);
  stmt.run({
    $key: key,
    $operation: operation,
    $scope_key: normalizeScopeKey(scope_id),
    $scope_id: scope_id ?? null,
    $result_json: JSON.stringify(result),
  });
}

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getConfig } from "../config";

let db: Database | null = null;

export interface Memory {
  id: string;
  content: string;
  category: string | null;
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
  embedding?: Buffer;
}

function getSchemaSQL(): string {
  const schemaPath = join(dirname(import.meta.path), "schema.sql");
  return readFileSync(schemaPath, "utf-8");
}

/**
 * Run migrations for existing databases.
 * Adds new columns that may not exist in older schemas.
 */
function runMigrations(database: Database): void {
  // Check if embedding column exists
  const tableInfo = database.prepare("PRAGMA table_info(memories)").all() as {
    name: string;
  }[];
  const hasEmbedding = tableInfo.some((col) => col.name === "embedding");

  if (!hasEmbedding) {
    database.exec("ALTER TABLE memories ADD COLUMN embedding BLOB");
  }
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
    INSERT INTO memories (id, content, category, embedding)
    VALUES ($id, $content, $category, $embedding)
    RETURNING *
  `);

  return stmt.get({
    $id: input.id,
    $content: input.content,
    $category: input.category ?? null,
    $embedding: input.embedding ?? null,
  }) as Memory;
}

export function getMemoryById(id: string): Memory | null {
  const database = getDatabase();
  const stmt = database.prepare("SELECT * FROM memories WHERE id = $id");
  return (stmt.get({ $id: id }) as Memory) ?? null;
}

export function getAllMemories(limit: number = 10): Memory[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT * FROM memories 
    ORDER BY strength DESC, last_accessed DESC
    LIMIT $limit
  `);
  return stmt.all({ $limit: limit }) as Memory[];
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

export function deleteMemoryById(id: string): boolean {
  const database = getDatabase();
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

export function searchMemories(query: string, limit: number): SearchResult[] {
  const database = getDatabase();

  // Empty query falls back to recent memories by strength
  if (!query.trim()) {
    const memories = getAllMemories(limit);
    return memories.map((m) => ({ ...m, rank: 0 }));
  }

  // FTS5 search with BM25 ranking (lower rank = better match)
  const stmt = database.prepare(`
    SELECT m.*, bm25(memories_fts) as rank
    FROM memories_fts fts
    JOIN memories m ON m.rowid = fts.rowid
    WHERE memories_fts MATCH $query
    ORDER BY rank, m.strength DESC, m.last_accessed DESC
    LIMIT $limit
  `);

  return stmt.all({ $query: query, $limit: limit }) as SearchResult[];
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
  strength: number;
  created_at: string;
  access_count: number;
  embedding: Buffer | null;
}

/**
 * Get all memories with embeddings for semantic search.
 */
export function getAllMemoriesWithEmbeddings(): MemoryWithEmbedding[] {
  const database = getDatabase();
  const stmt = database.prepare(`
    SELECT id, content, category, strength, created_at, access_count, embedding
    FROM memories
    WHERE embedding IS NOT NULL
  `);
  return stmt.all() as MemoryWithEmbedding[];
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

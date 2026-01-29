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
}

export interface CreateMemoryInput {
  id: string;
  content: string;
  category?: string;
}

function getSchemaSQL(): string {
  const schemaPath = join(dirname(import.meta.path), "schema.sql");
  return readFileSync(schemaPath, "utf-8");
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
    INSERT INTO memories (id, content, category)
    VALUES ($id, $content, $category)
    RETURNING *
  `);

  return stmt.get({
    $id: input.id,
    $content: input.content,
    $category: input.category ?? null,
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

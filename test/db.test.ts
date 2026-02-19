import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  closeDatabase,
  countMemories,
  createMemory,
  deleteMemoryById,
  getAllMemories,
  getDatabase,
  getIdempotencyResult,
  getMemoryById,
  initDatabase,
  resetDatabase,
  saveIdempotencyResult,
  searchMemories,
  updateMemoryAccess,
} from "../src/db";

describe("Database", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("creates and retrieves a memory", () => {
    const memory = createMemory({
      id: "test-1",
      content: "Test memory content",
      category: "fact",
    });

    expect(memory.id).toBe("test-1");
    expect(memory.content).toBe("Test memory content");
    expect(memory.category).toBe("fact");
    expect(memory.strength).toBe(1.0);
    expect(memory.access_count).toBe(1);
  });

  test("retrieves memory by ID", () => {
    createMemory({
      id: "test-2",
      content: "Another memory",
    });

    const retrieved = getMemoryById("test-2");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.content).toBe("Another memory");
    expect(retrieved!.category).toBeNull();
  });

  test("returns null for non-existent memory", () => {
    const retrieved = getMemoryById("non-existent");
    expect(retrieved).toBeNull();
  });

  test("lists all memories ordered by strength and recency", () => {
    createMemory({ id: "m1", content: "Memory 1" });
    createMemory({ id: "m2", content: "Memory 2" });
    createMemory({ id: "m3", content: "Memory 3" });

    const memories = getAllMemories(10);
    expect(memories.length).toBe(3);
  });

  test("respects limit parameter", () => {
    createMemory({ id: "m1", content: "Memory 1" });
    createMemory({ id: "m2", content: "Memory 2" });
    createMemory({ id: "m3", content: "Memory 3" });

    const memories = getAllMemories(2);
    expect(memories.length).toBe(2);
  });

  test("updates access count and timestamp", () => {
    createMemory({ id: "test-access", content: "Access test" });

    const before = getMemoryById("test-access");
    expect(before!.access_count).toBe(1);

    updateMemoryAccess("test-access");

    const after = getMemoryById("test-access");
    expect(after!.access_count).toBe(2);
  });

  test("counts memories", () => {
    expect(countMemories()).toBe(0);

    createMemory({ id: "m1", content: "Memory 1" });
    expect(countMemories()).toBe(1);

    createMemory({ id: "m2", content: "Memory 2" });
    expect(countMemories()).toBe(2);
  });

  test("deletes an existing memory", () => {
    createMemory({ id: "delete-me", content: "Temporary memory" });

    const deleted = deleteMemoryById("delete-me");

    expect(deleted).toBe(true);
    expect(getMemoryById("delete-me")).toBeNull();
    expect(countMemories()).toBe(0);
  });

  test("delete is idempotent for missing memory", () => {
    const deleted = deleteMemoryById("missing-memory");

    expect(deleted).toBe(false);
  });

  test("deleting a memory removes it from search", () => {
    createMemory({ id: "search-1", content: "Project budget note" });

    const beforeDelete = searchMemories("budget", 10);
    expect(beforeDelete.map((m) => m.id)).toContain("search-1");

    deleteMemoryById("search-1");

    const afterDelete = searchMemories("budget", 10);
    expect(afterDelete.map((m) => m.id)).not.toContain("search-1");
  });

  test("migrates legacy memories schema before creating scoped indexes", () => {
    closeDatabase();
    resetDatabase();

    const tempDir = mkdtempSync(join(tmpdir(), "engram-db-test-"));
    const dbPath = join(tempDir, "legacy-memories.db");

    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        category TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        last_accessed TEXT DEFAULT (datetime('now')),
        access_count INTEGER DEFAULT 1,
        strength REAL DEFAULT 1.0,
        embedding BLOB
      );
      CREATE INDEX idx_memories_strength ON memories(strength);
      CREATE INDEX idx_memories_last_accessed ON memories(last_accessed);
    `);
    legacyDb.close();

    initDatabase(dbPath);

    const memoryColumns = getDatabase()
      .prepare("PRAGMA table_info(memories)")
      .all() as { name: string }[];

    expect(memoryColumns.some((col) => col.name === "scope_id")).toBe(true);
    expect(memoryColumns.some((col) => col.name === "chat_id")).toBe(true);
    expect(memoryColumns.some((col) => col.name === "thread_id")).toBe(true);
    expect(memoryColumns.some((col) => col.name === "task_id")).toBe(true);
    expect(memoryColumns.some((col) => col.name === "metadata_json")).toBe(
      true,
    );
    expect(memoryColumns.some((col) => col.name === "idempotency_key")).toBe(
      true,
    );

    const memoryIndexes = getDatabase()
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memories'",
      )
      .all() as { name: string }[];
    const indexNames = memoryIndexes.map((index) => index.name);

    expect(indexNames).toContain("idx_memories_scope_id");
    expect(indexNames).toContain("idx_memories_chat_id");
    expect(indexNames).toContain("idx_memories_thread_id");
    expect(indexNames).toContain("idx_memories_task_id");
    expect(indexNames).toContain("idx_memories_idempotency_key");

    closeDatabase();
    resetDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    initDatabase(":memory:");
  });

  test("migrates legacy idempotency ledger to scoped primary key", () => {
    closeDatabase();
    resetDatabase();

    const tempDir = mkdtempSync(join(tmpdir(), "engram-db-test-"));
    const dbPath = join(tempDir, "legacy.db");

    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      CREATE TABLE idempotency_ledger (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        scope_id TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        result_json TEXT NOT NULL
      );
      INSERT INTO idempotency_ledger (key, operation, scope_id, result_json)
      VALUES ('legacy-key', 'remember', 'legacy-scope', '{"id":"legacy"}');
    `);
    legacyDb.close();

    initDatabase(dbPath);

    const pkInfo = getDatabase()
      .prepare("PRAGMA table_info(idempotency_ledger)")
      .all() as { name: string; pk: number }[];

    expect(pkInfo.find((col) => col.name === "key")?.pk).toBe(1);
    expect(pkInfo.find((col) => col.name === "operation")?.pk).toBe(2);
    expect(pkInfo.find((col) => col.name === "scope_key")?.pk).toBe(3);

    saveIdempotencyResult("legacy-key", "remember", "legacy-scope", {
      id: "updated",
    });

    const migrated = getDatabase()
      .prepare(
        "SELECT scope_key, scope_id FROM idempotency_ledger WHERE key = 'legacy-key' AND operation = 'remember'",
      )
      .get() as { scope_key: string; scope_id: string | null };

    expect(migrated.scope_key).toBe("legacy-scope");
    expect(migrated.scope_id).toBe("legacy-scope");

    closeDatabase();
    resetDatabase();
    rmSync(tempDir, { recursive: true, force: true });
    initDatabase(":memory:");
  });

  test("keeps idempotency results isolated by scope", () => {
    saveIdempotencyResult("shared-key", "remember", "scope-a", {
      id: "memory-a",
    });
    saveIdempotencyResult("shared-key", "remember", "scope-b", {
      id: "memory-b",
    });

    const scopeA = getIdempotencyResult<{ id: string }>(
      "shared-key",
      "remember",
      "scope-a",
    );
    const scopeB = getIdempotencyResult<{ id: string }>(
      "shared-key",
      "remember",
      "scope-b",
    );

    expect(scopeA?.ok).toBe(true);
    expect(scopeA?.ok && scopeA.value?.id).toBe("memory-a");
    expect(scopeB?.ok).toBe(true);
    expect(scopeB?.ok && scopeB.value?.id).toBe("memory-b");
  });
});

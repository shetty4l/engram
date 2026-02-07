import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  countMemories,
  createMemory,
  deleteMemoryById,
  getAllMemories,
  getMemoryById,
  initDatabase,
  resetDatabase,
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
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  getMemoryById,
  initDatabase,
  resetDatabase,
} from "../src/db";
import { recall } from "../src/tools/recall";
import { remember } from "../src/tools/remember";

describe("recall tool", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("returns empty array when no memories exist", () => {
    const result = recall({ query: "anything" });

    expect(result.memories).toEqual([]);
    expect(result.fallback_mode).toBe(true);
  });

  test("retrieves stored memories", () => {
    remember({ content: "Memory 1" });
    remember({ content: "Memory 2" });

    const result = recall({ query: "test" });

    expect(result.memories.length).toBe(2);
  });

  test("respects limit parameter", () => {
    remember({ content: "Memory 1" });
    remember({ content: "Memory 2" });
    remember({ content: "Memory 3" });

    const result = recall({ query: "test", limit: 2 });

    expect(result.memories.length).toBe(2);
  });

  test("filters by category", () => {
    remember({ content: "Fact 1", category: "fact" });
    remember({ content: "Decision 1", category: "decision" });
    remember({ content: "Fact 2", category: "fact" });

    const result = recall({ query: "test", category: "fact" });

    expect(result.memories.length).toBe(2);
    expect(result.memories.every((m) => m.category === "fact")).toBe(true);
  });

  test("updates access count on recall", () => {
    const { id } = remember({ content: "Test memory" });

    // Initial access count is 1
    let memory = getMemoryById(id);
    expect(memory!.access_count).toBe(1);

    // Recall should increment access count
    recall({ query: "test" });

    memory = getMemoryById(id);
    expect(memory!.access_count).toBe(2);
  });

  test("returns memories with correct shape", () => {
    remember({ content: "Test content", category: "fact" });

    const result = recall({ query: "test" });

    expect(result.memories[0]).toMatchObject({
      content: "Test content",
      category: "fact",
      strength: 1.0,
      relevance: 1.0,
    });
    expect(result.memories[0].id).toBeDefined();
    expect(result.memories[0].created_at).toBeDefined();
    expect(result.memories[0].access_count).toBeGreaterThanOrEqual(1);
  });

  test("indicates fallback mode in Slice 1", () => {
    const result = recall({ query: "test" });
    expect(result.fallback_mode).toBe(true);
  });
});

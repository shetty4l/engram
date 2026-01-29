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
    expect(result.fallback_mode).toBe(false);
  });

  test("retrieves stored memories", () => {
    remember({ content: "Memory 1" });
    remember({ content: "Memory 2" });

    const result = recall({ query: "Memory" });

    expect(result.memories.length).toBe(2);
  });

  test("respects limit parameter", () => {
    remember({ content: "Memory 1" });
    remember({ content: "Memory 2" });
    remember({ content: "Memory 3" });

    const result = recall({ query: "Memory", limit: 2 });

    expect(result.memories.length).toBe(2);
  });

  test("filters by category", () => {
    remember({ content: "Fact about TypeScript", category: "fact" });
    remember({ content: "Decision about Python", category: "decision" });
    remember({ content: "Fact about Rust", category: "fact" });

    const result = recall({
      query: "Fact OR TypeScript OR Rust",
      category: "fact",
    });

    expect(result.memories.length).toBe(2);
    expect(result.memories.every((m) => m.category === "fact")).toBe(true);
  });

  test("updates access count on recall", () => {
    const { id } = remember({ content: "Test memory" });

    // Initial access count is 1
    let memory = getMemoryById(id);
    expect(memory!.access_count).toBe(1);

    // Recall should increment access count
    recall({ query: "Test" });

    memory = getMemoryById(id);
    expect(memory!.access_count).toBe(2);
  });

  test("returns memories with correct shape", () => {
    remember({ content: "Test content", category: "fact" });

    const result = recall({ query: "Test" });

    expect(result.memories[0]).toMatchObject({
      content: "Test content",
      category: "fact",
      strength: 1.0,
    });
    expect(result.memories[0].id).toBeDefined();
    expect(result.memories[0].created_at).toBeDefined();
    expect(result.memories[0].access_count).toBeGreaterThanOrEqual(1);
    expect(result.memories[0].relevance).toBeGreaterThan(0);
  });

  test("fallback mode is false when query is provided", () => {
    remember({ content: "Test memory" });
    const result = recall({ query: "Test" });
    expect(result.fallback_mode).toBe(false);
  });

  test("fallback mode is true when query is empty", () => {
    remember({ content: "Test memory" });
    const result = recall({ query: "" });
    expect(result.fallback_mode).toBe(true);
  });

  test("fallback mode is true when query is whitespace", () => {
    remember({ content: "Test memory" });
    const result = recall({ query: "   " });
    expect(result.fallback_mode).toBe(true);
  });

  // FTS5 search behavior tests
  describe("FTS5 search", () => {
    test("finds memories containing query words", () => {
      remember({ content: "TypeScript is great for type safety" });
      remember({ content: "Python is good for data science" });
      remember({ content: "JavaScript runs in browsers" });

      const result = recall({ query: "TypeScript" });

      expect(result.memories.length).toBe(1);
      expect(result.memories[0].content).toContain("TypeScript");
    });

    test("finds memories with partial word matches using prefix", () => {
      remember({ content: "TypeScript is great" });
      remember({ content: "Python is good" });

      const result = recall({ query: "Type*" });

      expect(result.memories.length).toBe(1);
      expect(result.memories[0].content).toContain("TypeScript");
    });

    test("finds memories matching multiple words (OR)", () => {
      remember({ content: "TypeScript is great" });
      remember({ content: "Python is good" });
      remember({ content: "Rust is fast" });

      const result = recall({ query: "TypeScript OR Python" });

      expect(result.memories.length).toBe(2);
    });

    test("returns no results for non-matching query", () => {
      remember({ content: "TypeScript is great" });
      remember({ content: "Python is good" });

      const result = recall({ query: "Golang" });

      expect(result.memories.length).toBe(0);
    });

    test("empty query returns recent memories (fallback)", () => {
      remember({ content: "First memory" });
      remember({ content: "Second memory" });

      const result = recall({ query: "" });

      expect(result.memories.length).toBe(2);
      expect(result.fallback_mode).toBe(true);
    });

    test("ranks better matches higher", () => {
      remember({ content: "TypeScript TypeScript TypeScript" });
      remember({ content: "TypeScript is okay" });

      const result = recall({ query: "TypeScript" });

      expect(result.memories.length).toBe(2);
      // Both should have positive relevance scores
      expect(result.memories[0].relevance).toBeGreaterThan(0);
      expect(result.memories[1].relevance).toBeGreaterThan(0);
    });
  });
});

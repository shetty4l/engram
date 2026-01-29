import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  getMemoryById,
  initDatabase,
  resetDatabase,
} from "../src/db";
import { resetEmbedder } from "../src/embedding";
import { recall } from "../src/tools/recall";
import { remember } from "../src/tools/remember";

describe("recall tool", () => {
  beforeEach(() => {
    resetDatabase();
    resetEmbedder();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("returns empty array when no memories exist", async () => {
    const result = await recall({ query: "anything" });

    expect(result.memories).toEqual([]);
    expect(result.fallback_mode).toBe(false);
  });

  test("retrieves stored memories", async () => {
    await remember({ content: "Memory 1" });
    await remember({ content: "Memory 2" });

    const result = await recall({ query: "Memory" });

    expect(result.memories.length).toBe(2);
  });

  test("respects limit parameter", async () => {
    await remember({ content: "Memory 1" });
    await remember({ content: "Memory 2" });
    await remember({ content: "Memory 3" });

    const result = await recall({ query: "Memory", limit: 2 });

    expect(result.memories.length).toBe(2);
  });

  test("filters by category", async () => {
    await remember({ content: "Fact about TypeScript", category: "fact" });
    await remember({ content: "Decision about Python", category: "decision" });
    await remember({ content: "Fact about Rust", category: "fact" });

    const result = await recall({
      query: "TypeScript Rust programming",
      category: "fact",
    });

    expect(result.memories.length).toBe(2);
    expect(result.memories.every((m) => m.category === "fact")).toBe(true);
  });

  test("updates access count on recall", async () => {
    const { id } = await remember({ content: "Test memory" });

    // Initial access count is 1
    let memory = getMemoryById(id);
    expect(memory!.access_count).toBe(1);

    // Recall should increment access count
    await recall({ query: "Test" });

    memory = getMemoryById(id);
    expect(memory!.access_count).toBe(2);
  });

  test("returns memories with correct shape", async () => {
    await remember({ content: "Test content", category: "fact" });

    const result = await recall({ query: "Test" });

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

  test("fallback mode is false when query is provided", async () => {
    await remember({ content: "Test memory" });
    const result = await recall({ query: "Test" });
    expect(result.fallback_mode).toBe(false);
  });

  test("fallback mode is true when query is empty", async () => {
    await remember({ content: "Test memory" });
    const result = await recall({ query: "" });
    expect(result.fallback_mode).toBe(true);
  });

  test("fallback mode is true when query is whitespace", async () => {
    await remember({ content: "Test memory" });
    const result = await recall({ query: "   " });
    expect(result.fallback_mode).toBe(true);
  });

  // Semantic search behavior tests
  describe("semantic search", () => {
    test("finds memories with semantically similar content", async () => {
      await remember({ content: "TypeScript is great for type safety" });
      await remember({ content: "Python is good for data science" });
      await remember({ content: "JavaScript runs in browsers" });

      const result = await recall({ query: "statically typed languages" });

      // TypeScript should be most relevant for "statically typed languages"
      expect(result.memories.length).toBeGreaterThan(0);
      expect(result.memories[0].content).toContain("TypeScript");
    });

    test("returns no results for completely unrelated query when no embeddings match", async () => {
      await remember({ content: "TypeScript is great" });
      await remember({ content: "Python is good" });

      // Even with semantic search, very unrelated content should score low
      const result = await recall({ query: "cooking recipes for pasta" });

      // Results may still be returned but with low relevance
      // The semantic similarity should be low
      if (result.memories.length > 0) {
        expect(result.memories[0].relevance).toBeLessThan(0.5);
      }
    });

    test("empty query returns recent memories (fallback)", async () => {
      await remember({ content: "First memory" });
      await remember({ content: "Second memory" });

      const result = await recall({ query: "" });

      expect(result.memories.length).toBe(2);
      expect(result.fallback_mode).toBe(true);
    });

    test("ranks semantically similar content higher", async () => {
      await remember({ content: "I love programming in TypeScript" });
      await remember({ content: "The weather today is sunny and warm" });

      const result = await recall({ query: "coding with JavaScript" });

      expect(result.memories.length).toBe(2);
      // TypeScript content should be more similar to "coding with JavaScript"
      expect(result.memories[0].content).toContain("TypeScript");
      expect(result.memories[0].relevance).toBeGreaterThan(
        result.memories[1].relevance,
      );
    });

    test("handles synonyms and related concepts", async () => {
      await remember({ content: "The automobile needs an oil change" });
      await remember({ content: "I went hiking in the mountains" });

      const result = await recall({ query: "car maintenance" });

      expect(result.memories.length).toBe(2);
      // "automobile" should be semantically similar to "car"
      expect(result.memories[0].content).toContain("automobile");
    });
  });
});

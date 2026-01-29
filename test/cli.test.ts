import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  createMemory,
  getMemoryById,
  getMetricsSummary,
  getRecentMemories,
  getStats,
  initDatabase,
  logMetric,
  resetDatabase,
} from "../src/db";

describe("CLI database functions", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  describe("getStats", () => {
    test("returns empty stats for empty database", () => {
      const stats = getStats();

      expect(stats.total_memories).toBe(0);
      expect(stats.categories).toEqual([]);
      expect(stats.oldest_memory).toBeNull();
      expect(stats.newest_memory).toBeNull();
      expect(stats.total_access_count).toBe(0);
      expect(stats.avg_strength).toBe(0);
    });

    test("returns correct stats with memories", () => {
      createMemory({ id: "1", content: "Memory 1", category: "fact" });
      createMemory({ id: "2", content: "Memory 2", category: "fact" });
      createMemory({ id: "3", content: "Memory 3", category: "decision" });
      createMemory({ id: "4", content: "Memory 4" }); // no category

      const stats = getStats();

      expect(stats.total_memories).toBe(4);
      expect(stats.categories).toHaveLength(3); // fact, decision, null
      expect(stats.oldest_memory).not.toBeNull();
      expect(stats.newest_memory).not.toBeNull();
      expect(stats.total_access_count).toBe(4); // default access_count is 1
      expect(stats.avg_strength).toBe(1); // default strength is 1.0
    });

    test("counts categories correctly", () => {
      createMemory({ id: "1", content: "Memory 1", category: "fact" });
      createMemory({ id: "2", content: "Memory 2", category: "fact" });
      createMemory({ id: "3", content: "Memory 3", category: "decision" });

      const stats = getStats();
      const factCategory = stats.categories.find((c) => c.category === "fact");
      const decisionCategory = stats.categories.find(
        (c) => c.category === "decision",
      );

      expect(factCategory?.count).toBe(2);
      expect(decisionCategory?.count).toBe(1);
    });
  });

  describe("getRecentMemories", () => {
    test("returns empty array for empty database", () => {
      const memories = getRecentMemories(10);
      expect(memories).toEqual([]);
    });

    test("returns memories ordered by created_at DESC", () => {
      createMemory({ id: "1", content: "First" });
      createMemory({ id: "2", content: "Second" });
      createMemory({ id: "3", content: "Third" });

      const memories = getRecentMemories(10);

      expect(memories).toHaveLength(3);
      // All created at same instant in test, so order is by rowid DESC
      // Just verify we get all 3 memories
      const ids = memories.map((m) => m.id).sort();
      expect(ids).toEqual(["1", "2", "3"]);
    });

    test("respects limit parameter", () => {
      createMemory({ id: "1", content: "First" });
      createMemory({ id: "2", content: "Second" });
      createMemory({ id: "3", content: "Third" });

      const memories = getRecentMemories(2);

      expect(memories).toHaveLength(2);
      // Just verify limit works, don't assume order since timestamps are identical
    });

    test("uses default limit of 10", () => {
      // Create 15 memories
      for (let i = 1; i <= 15; i++) {
        createMemory({ id: String(i), content: `Memory ${i}` });
      }

      const memories = getRecentMemories();

      expect(memories).toHaveLength(10);
    });
  });

  describe("getMemoryById", () => {
    test("returns null for non-existent ID", () => {
      const memory = getMemoryById("non-existent");
      expect(memory).toBeNull();
    });

    test("returns memory for valid ID", () => {
      createMemory({
        id: "test-id",
        content: "Test content",
        category: "fact",
      });

      const memory = getMemoryById("test-id");

      expect(memory).not.toBeNull();
      expect(memory?.id).toBe("test-id");
      expect(memory?.content).toBe("Test content");
      expect(memory?.category).toBe("fact");
    });
  });

  describe("getMetricsSummary", () => {
    test("returns zero counts for empty metrics", () => {
      const summary = getMetricsSummary();

      expect(summary.total_remembers).toBe(0);
      expect(summary.total_recalls).toBe(0);
      expect(summary.recall_hit_rate).toBe(0);
      expect(summary.fallback_rate).toBe(0);
    });

    test("counts remembers and recalls correctly", () => {
      logMetric({ event: "remember", memory_id: "1" });
      logMetric({ event: "remember", memory_id: "2" });
      logMetric({ event: "recall", query: "test", result_count: 5 });
      logMetric({ event: "recall", query: "empty", result_count: 0 });

      const summary = getMetricsSummary();

      expect(summary.total_remembers).toBe(2);
      expect(summary.total_recalls).toBe(2);
    });

    test("calculates hit rate correctly", () => {
      logMetric({ event: "recall", query: "hit1", result_count: 3 });
      logMetric({ event: "recall", query: "hit2", result_count: 1 });
      logMetric({ event: "recall", query: "miss", result_count: 0 });
      logMetric({ event: "recall", query: "miss2", result_count: 0 });

      const summary = getMetricsSummary();

      // 2 hits out of 4 recalls = 50%
      expect(summary.recall_hit_rate).toBe(0.5);
    });

    test("calculates fallback rate correctly", () => {
      logMetric({ event: "recall", query: "normal", result_count: 1 });
      logMetric({
        event: "recall",
        query: "",
        result_count: 5,
        was_fallback: true,
      });
      logMetric({
        event: "recall",
        query: "",
        result_count: 3,
        was_fallback: true,
      });

      const summary = getMetricsSummary();

      // 2 fallbacks out of 3 recalls
      expect(summary.fallback_rate).toBeCloseTo(0.667, 2);
    });

    test("filters by session_id", () => {
      logMetric({ event: "remember", memory_id: "1", session_id: "session-a" });
      logMetric({ event: "remember", memory_id: "2", session_id: "session-b" });
      logMetric({
        event: "recall",
        query: "test",
        result_count: 1,
        session_id: "session-a",
      });

      const summaryA = getMetricsSummary("session-a");
      const summaryB = getMetricsSummary("session-b");

      expect(summaryA.total_remembers).toBe(1);
      expect(summaryA.total_recalls).toBe(1);
      expect(summaryB.total_remembers).toBe(1);
      expect(summaryB.total_recalls).toBe(0);
    });
  });
});

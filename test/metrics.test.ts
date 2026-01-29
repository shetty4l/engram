import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  getMetricsSummary,
  initDatabase,
  logMetric,
  resetDatabase,
} from "../src/db";
import { recall } from "../src/tools/recall";
import { remember } from "../src/tools/remember";

describe("metrics", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  describe("logMetric", () => {
    test("logs remember event", () => {
      logMetric({
        session_id: "session-123",
        event: "remember",
        memory_id: "mem-456",
      });

      const summary = getMetricsSummary();
      expect(summary.total_remembers).toBe(1);
    });

    test("logs recall event", () => {
      logMetric({
        session_id: "session-123",
        event: "recall",
        query: "test query",
        result_count: 5,
        was_fallback: false,
      });

      const summary = getMetricsSummary();
      expect(summary.total_recalls).toBe(1);
    });

    test("logs recall with fallback", () => {
      logMetric({
        session_id: "session-123",
        event: "recall",
        query: "",
        result_count: 3,
        was_fallback: true,
      });

      const summary = getMetricsSummary();
      expect(summary.fallback_rate).toBe(1);
    });
  });

  describe("getMetricsSummary", () => {
    test("returns correct summary for all events", () => {
      // 3 remembers
      logMetric({ event: "remember", memory_id: "1" });
      logMetric({ event: "remember", memory_id: "2" });
      logMetric({ event: "remember", memory_id: "3" });

      // 4 recalls: 2 hits, 2 misses, 1 fallback
      logMetric({ event: "recall", query: "test", result_count: 5 });
      logMetric({ event: "recall", query: "test", result_count: 2 });
      logMetric({ event: "recall", query: "test", result_count: 0 });
      logMetric({
        event: "recall",
        query: "",
        result_count: 0,
        was_fallback: true,
      });

      const summary = getMetricsSummary();
      expect(summary.total_remembers).toBe(3);
      expect(summary.total_recalls).toBe(4);
      expect(summary.recall_hit_rate).toBe(0.5); // 2 hits out of 4
      expect(summary.fallback_rate).toBe(0.25); // 1 fallback out of 4
    });

    test("filters by session_id", () => {
      logMetric({ session_id: "session-a", event: "remember", memory_id: "1" });
      logMetric({ session_id: "session-a", event: "remember", memory_id: "2" });
      logMetric({ session_id: "session-b", event: "remember", memory_id: "3" });

      const summaryA = getMetricsSummary("session-a");
      expect(summaryA.total_remembers).toBe(2);

      const summaryB = getMetricsSummary("session-b");
      expect(summaryB.total_remembers).toBe(1);

      const summaryAll = getMetricsSummary();
      expect(summaryAll.total_remembers).toBe(3);
    });

    test("returns zeros for empty database", () => {
      const summary = getMetricsSummary();
      expect(summary.total_remembers).toBe(0);
      expect(summary.total_recalls).toBe(0);
      expect(summary.recall_hit_rate).toBe(0);
      expect(summary.fallback_rate).toBe(0);
    });
  });

  describe("integration with tools", () => {
    test("remember logs metric with session_id", () => {
      remember({
        content: "Test memory",
        session_id: "test-session",
      });

      const summary = getMetricsSummary("test-session");
      expect(summary.total_remembers).toBe(1);
    });

    test("recall logs metric with session_id and query", () => {
      remember({ content: "TypeScript is great" });

      recall({
        query: "TypeScript",
        session_id: "test-session",
      });

      const summary = getMetricsSummary("test-session");
      expect(summary.total_recalls).toBe(1);
      expect(summary.recall_hit_rate).toBe(1); // Found the memory
    });

    test("recall logs fallback when query is empty", () => {
      remember({ content: "Test memory" });

      recall({
        query: "",
        session_id: "test-session",
      });

      const summary = getMetricsSummary("test-session");
      expect(summary.fallback_rate).toBe(1);
    });

    test("tracks complete session workflow", () => {
      const sessionId = "workflow-session";

      // User stores some memories
      remember({
        content: "Prefer functional patterns",
        session_id: sessionId,
      });
      remember({ content: "Use 2-space indentation", session_id: sessionId });

      // User searches for memories
      recall({ query: "functional", session_id: sessionId }); // hit
      recall({ query: "indentation", session_id: sessionId }); // hit
      recall({ query: "nonexistent", session_id: sessionId }); // miss

      const summary = getMetricsSummary(sessionId);
      expect(summary.total_remembers).toBe(2);
      expect(summary.total_recalls).toBe(3);
      expect(summary.recall_hit_rate).toBeCloseTo(0.67, 1); // 2/3
    });
  });
});

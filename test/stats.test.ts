import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  createMemory,
  getDatabase,
  getStatsForApi,
  initDatabase,
  logMetric,
  resetDatabase,
} from "../src/db";
import { startHttpServer } from "../src/http";

describe("stats API", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  describe("getStatsForApi", () => {
    test("returns zeros/nulls for empty database", () => {
      const stats = getStatsForApi();

      expect(stats.memories.total).toBe(0);
      expect(stats.memories.with_embedding_pct).toBe(0);
      expect(stats.operations.recall_24h).toBe(0);
      expect(stats.operations.remember_24h).toBe(0);
      expect(stats.operations.recall_hit_rate_24h).toBe(0);
      expect(stats.operations.recall_fallback_rate_24h).toBe(0);
      expect(stats.latency.recall_p50_ms).toBeNull();
      expect(stats.latency.recall_p95_ms).toBeNull();
      expect(stats.latency.recall_p99_ms).toBeNull();
    });

    test("counts total memories", () => {
      createMemory({ id: "m1", content: "First memory" });
      createMemory({ id: "m2", content: "Second memory" });
      createMemory({ id: "m3", content: "Third memory" });

      const stats = getStatsForApi();
      expect(stats.memories.total).toBe(3);
    });

    test("computes embedding percentage", () => {
      const embedding = Buffer.alloc(16);
      createMemory({ id: "m1", content: "With embedding", embedding });
      createMemory({ id: "m2", content: "Without embedding" });

      const stats = getStatsForApi();
      expect(stats.memories.with_embedding_pct).toBe(50);
    });

    test("computes 100% embedding when all have embeddings", () => {
      const embedding = Buffer.alloc(16);
      createMemory({ id: "m1", content: "With embedding", embedding });

      const stats = getStatsForApi();
      expect(stats.memories.with_embedding_pct).toBe(100);
    });

    test("counts recall operations in last hour", () => {
      logMetric({ event: "recall", query: "test", result_count: 3 });
      logMetric({ event: "recall", query: "other", result_count: 0 });

      const stats = getStatsForApi();
      expect(stats.operations.recall_24h).toBe(2);
    });

    test("counts remember and upsert operations in last hour", () => {
      logMetric({ event: "remember", memory_id: "m1" });
      logMetric({ event: "upsert", memory_id: "m2" });
      logMetric({ event: "remember", memory_id: "m3" });

      const stats = getStatsForApi();
      expect(stats.operations.remember_24h).toBe(3);
    });

    test("computes recall hit rate", () => {
      logMetric({ event: "recall", query: "a", result_count: 5 });
      logMetric({ event: "recall", query: "b", result_count: 2 });
      logMetric({ event: "recall", query: "c", result_count: 0 });
      logMetric({ event: "recall", query: "d", result_count: 0 });

      const stats = getStatsForApi();
      expect(stats.operations.recall_hit_rate_24h).toBe(0.5);
    });

    test("computes recall fallback rate", () => {
      logMetric({ event: "recall", query: "a", result_count: 3 });
      logMetric({
        event: "recall",
        query: "",
        result_count: 2,
        was_fallback: true,
      });
      logMetric({ event: "recall", query: "b", result_count: 1 });
      logMetric({
        event: "recall",
        query: "",
        result_count: 0,
        was_fallback: true,
      });

      const stats = getStatsForApi();
      expect(stats.operations.recall_fallback_rate_24h).toBe(0.5);
    });

    test("computes latency percentiles", () => {
      // Insert 10 recall metrics with known latencies
      for (let i = 1; i <= 10; i++) {
        logMetric({
          event: "recall",
          query: `q${i}`,
          result_count: 1,
          latency_ms: i * 10, // 10, 20, 30, ..., 100
        });
      }

      const stats = getStatsForApi();
      expect(stats.latency.recall_p50_ms).toBe(50);
      expect(stats.latency.recall_p95_ms).toBe(100);
      expect(stats.latency.recall_p99_ms).toBe(100);
    });

    test("returns null latency when no recall latency data", () => {
      // Only remember events, no recall
      logMetric({ event: "remember", memory_id: "m1", latency_ms: 5 });

      const stats = getStatsForApi();
      expect(stats.latency.recall_p50_ms).toBeNull();
      expect(stats.latency.recall_p95_ms).toBeNull();
      expect(stats.latency.recall_p99_ms).toBeNull();
    });

    test("handles single latency data point", () => {
      logMetric({
        event: "recall",
        query: "test",
        result_count: 1,
        latency_ms: 42,
      });

      const stats = getStatsForApi();
      expect(stats.latency.recall_p50_ms).toBe(42);
      expect(stats.latency.recall_p95_ms).toBe(42);
      expect(stats.latency.recall_p99_ms).toBe(42);
    });

    test("excludes metrics older than 24 hours", () => {
      // Insert a metric with a recent timestamp (now)
      logMetric({ event: "recall", query: "recent", result_count: 1 });

      // Insert a metric with an old timestamp (2 days ago)
      const db = getDatabase();
      db.prepare(
        `INSERT INTO metrics (timestamp, event, query, result_count, latency_ms)
         VALUES (datetime('now', '-2 days'), 'recall', 'old', 3, 50)`,
      ).run();

      const stats = getStatsForApi();
      expect(stats.operations.recall_24h).toBe(1);
      // Old latency data should also be excluded
      expect(stats.latency.recall_p50_ms).toBeNull();
    });

    test("excludes old remember metrics from 24h window", () => {
      logMetric({ event: "remember", memory_id: "recent" });

      const db = getDatabase();
      db.prepare(
        `INSERT INTO metrics (timestamp, event, memory_id)
         VALUES (datetime('now', '-2 days'), 'remember', 'old')`,
      ).run();

      const stats = getStatsForApi();
      expect(stats.operations.remember_24h).toBe(1);
    });
  });

  describe("GET /stats endpoint", () => {
    const originalPort = process.env.ENGRAM_HTTP_PORT;
    const originalHost = process.env.ENGRAM_HTTP_HOST;
    const originalScopes = process.env.ENGRAM_ENABLE_SCOPES;
    const originalContext = process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION;

    beforeEach(() => {
      process.env.ENGRAM_HTTP_PORT = "0";
      process.env.ENGRAM_HTTP_HOST = "127.0.0.1";
      process.env.ENGRAM_ENABLE_SCOPES = "0";
      process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION = "0";
    });

    afterEach(() => {
      if (originalPort === undefined) {
        delete process.env.ENGRAM_HTTP_PORT;
      } else {
        process.env.ENGRAM_HTTP_PORT = originalPort;
      }

      if (originalHost === undefined) {
        delete process.env.ENGRAM_HTTP_HOST;
      } else {
        process.env.ENGRAM_HTTP_HOST = originalHost;
      }

      if (originalScopes === undefined) {
        delete process.env.ENGRAM_ENABLE_SCOPES;
      } else {
        process.env.ENGRAM_ENABLE_SCOPES = originalScopes;
      }

      if (originalContext === undefined) {
        delete process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION;
      } else {
        process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION = originalContext;
      }
    });

    test("returns correct JSON shape on empty DB", async () => {
      const server = startHttpServer();

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/stats`);

        expect(response.status).toBe(200);
        const body = (await response.json()) as ReturnType<
          typeof getStatsForApi
        >;

        expect(body.memories.total).toBe(0);
        expect(body.memories.with_embedding_pct).toBe(0);
        expect(body.operations.recall_24h).toBe(0);
        expect(body.operations.remember_24h).toBe(0);
        expect(body.operations.recall_hit_rate_24h).toBe(0);
        expect(body.operations.recall_fallback_rate_24h).toBe(0);
        expect(body.latency.recall_p50_ms).toBeNull();
        expect(body.latency.recall_p95_ms).toBeNull();
        expect(body.latency.recall_p99_ms).toBeNull();
      } finally {
        server.stop();
      }
    });

    test("returns populated stats after inserting data", async () => {
      createMemory({ id: "m1", content: "Test memory" });
      logMetric({
        event: "recall",
        query: "test",
        result_count: 1,
        latency_ms: 25,
      });
      logMetric({ event: "remember", memory_id: "m1" });

      const server = startHttpServer();

      try {
        const response = await fetch(`http://127.0.0.1:${server.port}/stats`);

        expect(response.status).toBe(200);
        const body = (await response.json()) as ReturnType<
          typeof getStatsForApi
        >;

        expect(body.memories.total).toBe(1);
        expect(body.operations.recall_24h).toBe(1);
        expect(body.operations.remember_24h).toBe(1);
        expect(body.operations.recall_hit_rate_24h).toBe(1);
        expect(body.latency.recall_p50_ms).toBe(25);
      } finally {
        server.stop();
      }
    });
  });
});

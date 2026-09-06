import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  createMemory,
  deleteExpiredBridgeMemories,
  getDatabase,
  getMemoryById,
  getObservabilityStats,
  initDatabase,
  recordDeliveries,
  resetDatabase,
} from "../src/db";
import { startHttpServer } from "../src/http";
import { recall } from "../src/tools/recall";

/**
 * Observability contract: surfacing (returned by search) and delivery
 * (actually entered agent context) are separate events with separate
 * counters. Only delivery refreshes decay.
 */
describe("recall surfaced/delivered split", () => {
  const originalScopes = process.env.ENGRAM_ENABLE_SCOPES;

  beforeEach(() => {
    process.env.ENGRAM_ENABLE_SCOPES = "0";
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDatabase();
    if (originalScopes === undefined) {
      delete process.env.ENGRAM_ENABLE_SCOPES;
    } else {
      process.env.ENGRAM_ENABLE_SCOPES = originalScopes;
    }
  });

  test("auto recall bumps surfaced_count but not access_count", async () => {
    createMemory({ id: "m1", content: "warehouse resolver pipeline" });

    const result = await recall({ query: "warehouse", source: "auto" });
    expect(result.memories.length).toBe(1);
    expect(result.recall_id).toBeTruthy();

    const memory = getMemoryById("m1");
    expect(memory!.access_count).toBe(1); // unchanged (starts at 1)
    const row = getDatabase()
      .prepare("SELECT surfaced_count FROM memories WHERE id = 'm1'")
      .get() as { surfaced_count: number };
    expect(row.surfaced_count).toBe(1);

    const deliveries = getDatabase()
      .prepare("SELECT COUNT(*) as n FROM deliveries")
      .get() as { n: number };
    expect(deliveries.n).toBe(0);
  });

  test("deliberate recall self-delivers: access bump + delivery row", async () => {
    createMemory({ id: "m1", content: "warehouse resolver pipeline" });

    const result = await recall({ query: "warehouse" }); // default deliberate

    const memory = getMemoryById("m1");
    expect(memory!.access_count).toBe(2);

    const delivery = getDatabase()
      .prepare("SELECT * FROM deliveries WHERE memory_id = 'm1'")
      .get() as { recall_id: string; source: string; truncated: number };
    expect(delivery.recall_id).toBe(result.recall_id);
    expect(delivery.source).toBe("deliberate");
    expect(delivery.truncated).toBe(0);
  });

  test("recall metric row carries source, recall_id and surfaced memory ids", async () => {
    createMemory({ id: "m1", content: "warehouse resolver pipeline" });

    const result = await recall({
      query: "warehouse",
      source: "session-start",
    });

    const metric = getDatabase()
      .prepare("SELECT * FROM metrics WHERE event = 'recall'")
      .get() as { source: string; recall_id: string; memory_ids: string };
    expect(metric.source).toBe("session-start");
    expect(metric.recall_id).toBe(result.recall_id);
    expect(JSON.parse(metric.memory_ids)).toEqual(["m1"]);
  });

  test("recordDeliveries bumps access_count and refreshes decay state", () => {
    createMemory({ id: "m1", content: "anything" });
    getDatabase()
      .prepare("UPDATE memories SET strength = 0.3 WHERE id = 'm1'")
      .run();

    recordDeliveries([
      {
        recall_id: "r1",
        session_id: "s1",
        source: "auto",
        memory_id: "m1",
        chars: 120,
        truncated: true,
      },
    ]);

    const memory = getMemoryById("m1");
    expect(memory!.access_count).toBe(2);
    expect(memory!.strength).toBe(1.0);

    const delivery = getDatabase()
      .prepare("SELECT * FROM deliveries WHERE recall_id = 'r1'")
      .get() as { chars: number; truncated: number };
    expect(delivery.chars).toBe(120);
    expect(delivery.truncated).toBe(1);
  });
});

describe("bridge TTL sweep", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDatabase();
  });

  test("deletes only bridge memories older than the TTL", () => {
    createMemory({ id: "old-bridge", content: "[compaction-bridge] old" });
    createMemory({ id: "new-bridge", content: "[compaction-bridge] new" });
    createMemory({ id: "normal", content: "a real memory" });
    getDatabase()
      .prepare(
        "UPDATE memories SET created_at = datetime('now', '-48 hours') WHERE id IN ('old-bridge', 'normal')",
      )
      .run();

    const deleted = deleteExpiredBridgeMemories(24);

    expect(deleted).toBe(1);
    expect(getMemoryById("old-bridge")).toBeNull();
    expect(getMemoryById("new-bridge")).not.toBeNull();
    expect(getMemoryById("normal")).not.toBeNull();
  });
});

describe("observability stats", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDatabase();
  });

  test("reports working set, cohorts and per-source delivery", async () => {
    createMemory({ id: "m1", content: "warehouse resolver pipeline" });
    await recall({ query: "warehouse", source: "auto" });
    recordDeliveries([
      { recall_id: "r1", source: "auto", memory_id: "m1", chars: 100 },
    ]);
    await recall({ query: "warehouse" }); // deliberate pull of same memory

    const stats = getObservabilityStats();
    expect(stats.total_memories).toBe(1);
    expect(stats.working_set_30d).toBe(1);
    expect(stats.dead_tail_90d).toBe(0);
    expect(stats.cohort_survival.length).toBe(1);

    const sources = Object.fromEntries(
      stats.delivery_7d.map((d) => [d.source, d]),
    );
    expect(sources["auto"].recalls).toBe(1);
    expect(sources["auto"].delivered).toBe(1);
    expect(sources["deliberate"].delivered).toBe(1);

    // m1 was surfaced by auto, later deliberately delivered → a conversion
    expect(stats.auto_to_deliberate_conversions_7d).toBe(1);
  });
});

describe("http observability endpoints", () => {
  const originalPort = process.env.ENGRAM_HTTP_PORT;
  const originalQueryOnly = process.env.ENGRAM_QUERY_ONLY;

  beforeEach(() => {
    process.env.ENGRAM_HTTP_PORT = "0";
    process.env.ENGRAM_QUERY_ONLY = "0";
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDatabase();
    if (originalPort === undefined) {
      delete process.env.ENGRAM_HTTP_PORT;
    } else {
      process.env.ENGRAM_HTTP_PORT = originalPort;
    }
    if (originalQueryOnly === undefined) {
      delete process.env.ENGRAM_QUERY_ONLY;
    } else {
      process.env.ENGRAM_QUERY_ONLY = originalQueryOnly;
    }
  });

  test("recall rejects unknown source", async () => {
    const server = startHttpServer();
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/recall`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "x", source: "wiretap" }),
      });
      expect(response.status).toBe(400);
    } finally {
      server.stop();
    }
  });

  test("delivered records deliveries and bumps access", async () => {
    createMemory({ id: "m1", content: "warehouse resolver pipeline" });
    const server = startHttpServer();
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/delivered`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recall_id: "r1",
            session_id: "s1",
            source: "auto",
            memory_ids: ["m1"],
            chars: 250,
            truncated: false,
          }),
        },
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { recorded: number };
      expect(body.recorded).toBe(1);
      expect(getMemoryById("m1")!.access_count).toBe(2);
    } finally {
      server.stop();
    }
  });

  test("delivered requires recall_id and memory_ids", async () => {
    const server = startHttpServer();
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/delivered`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ memory_ids: ["m1"] }),
        },
      );
      expect(response.status).toBe(400);
    } finally {
      server.stop();
    }
  });

  test("judge audits are recorded and validated", async () => {
    const server = startHttpServer();
    try {
      const bad = await fetch(`http://127.0.0.1:${server.port}/judge/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audits: [{ session_id: "s1" }] }),
      });
      expect(bad.status).toBe(400);

      const good = await fetch(`http://127.0.0.1:${server.port}/judge/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audits: [
            {
              audit_week: "2026-W37",
              session_id: "s1",
              memory_id: "m1",
              verdict: "used",
            },
          ],
        }),
      });
      expect(good.status).toBe(200);

      const row = getDatabase().prepare("SELECT * FROM judge_audits").get() as {
        audit_week: string;
        verdict: string;
      };
      expect(row.audit_week).toBe("2026-W37");
      expect(row.verdict).toBe("used");
    } finally {
      server.stop();
    }
  });

  test("query-only mode blocks judge audits but allows delivery telemetry", async () => {
    process.env.ENGRAM_QUERY_ONLY = "1";
    createMemory({ id: "m1", content: "warehouse resolver pipeline" });
    const server = startHttpServer();
    try {
      const audit = await fetch(`http://127.0.0.1:${server.port}/judge/audit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audits: [
            { audit_week: "2026-W37", session_id: "s1", verdict: "used" },
          ],
        }),
      });
      expect(audit.status).toBe(403);

      const delivered = await fetch(
        `http://127.0.0.1:${server.port}/delivered`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recall_id: "r1", memory_ids: ["m1"] }),
        },
      );
      expect(delivered.status).toBe(200);
    } finally {
      server.stop();
    }
  });
});

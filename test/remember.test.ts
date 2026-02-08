import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  getMemoryById,
  initDatabase,
  resetDatabase,
} from "../src/db";
import { resetEmbedder } from "../src/embedding";
import { remember } from "../src/tools/remember";

describe("remember tool", () => {
  const originalScopes = process.env.ENGRAM_ENABLE_SCOPES;
  const originalIdempotency = process.env.ENGRAM_ENABLE_IDEMPOTENCY;

  beforeEach(() => {
    process.env.ENGRAM_ENABLE_SCOPES = "0";
    process.env.ENGRAM_ENABLE_IDEMPOTENCY = "0";
    resetDatabase();
    resetEmbedder();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();

    if (originalScopes === undefined) {
      delete process.env.ENGRAM_ENABLE_SCOPES;
    } else {
      process.env.ENGRAM_ENABLE_SCOPES = originalScopes;
    }

    if (originalIdempotency === undefined) {
      delete process.env.ENGRAM_ENABLE_IDEMPOTENCY;
    } else {
      process.env.ENGRAM_ENABLE_IDEMPOTENCY = originalIdempotency;
    }
  });

  test("stores a memory and returns an ID", async () => {
    const result = await remember({ content: "Test memory" });

    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const stored = getMemoryById(result.id);
    expect(stored).not.toBeNull();
    expect(stored!.content).toBe("Test memory");
  });

  test("stores memory with category", async () => {
    const result = await remember({
      content: "Prefer composition over inheritance",
      category: "decision",
    });

    const stored = getMemoryById(result.id);
    expect(stored!.category).toBe("decision");
  });

  test("stores memory without category", async () => {
    const result = await remember({ content: "Some fact" });

    const stored = getMemoryById(result.id);
    expect(stored!.category).toBeNull();
  });

  test("generates unique IDs for each memory", async () => {
    const result1 = await remember({ content: "Memory 1" });
    const result2 = await remember({ content: "Memory 2" });

    expect(result1.id).not.toBe(result2.id);
  });

  test("stores embedding with memory", async () => {
    const result = await remember({ content: "Test memory with embedding" });

    const stored = getMemoryById(result.id);
    expect(stored).not.toBeNull();
    expect(stored!.embedding).not.toBeNull();
    // Embedding should be a Buffer with float32 data
    // bge-small-en-v1.5 produces 384-dim embeddings = 384 * 4 bytes = 1536 bytes
    expect(stored!.embedding!.length).toBe(384 * 4);
  });

  test("stores scoped fields when scopes feature is enabled", async () => {
    process.env.ENGRAM_ENABLE_SCOPES = "1";

    const result = await remember({
      content: "Scoped memory",
      scope_id: "project-a",
      chat_id: "chat-1",
      thread_id: "thread-1",
      task_id: "task-1",
      metadata: { source: "test" },
    });

    const stored = getMemoryById(result.id);
    expect(stored!.scope_id).toBe("project-a");
    expect(stored!.chat_id).toBe("chat-1");
    expect(stored!.thread_id).toBe("thread-1");
    expect(stored!.task_id).toBe("task-1");
    expect(stored!.metadata_json).toBe('{"source":"test"}');
  });

  test("returns same result for duplicate idempotency key when enabled", async () => {
    process.env.ENGRAM_ENABLE_IDEMPOTENCY = "1";

    const first = await remember({
      content: "Idempotent memory",
      idempotency_key: "remember-key-1",
    });
    const second = await remember({
      content: "Idempotent memory",
      idempotency_key: "remember-key-1",
    });

    expect(second.id).toBe(first.id);
  });

  test("does not collide idempotency keys across scopes", async () => {
    process.env.ENGRAM_ENABLE_IDEMPOTENCY = "1";
    process.env.ENGRAM_ENABLE_SCOPES = "1";

    const first = await remember({
      content: "Scoped idempotency A",
      scope_id: "project-a",
      idempotency_key: "shared-key",
    });

    const second = await remember({
      content: "Scoped idempotency B",
      scope_id: "project-b",
      idempotency_key: "shared-key",
    });

    expect(first.id).not.toBe(second.id);
  });
});

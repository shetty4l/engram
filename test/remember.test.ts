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

  describe("upsert", () => {
    test("creates memory when no existing match", async () => {
      process.env.ENGRAM_ENABLE_IDEMPOTENCY = "1";

      const result = await remember({
        content: "New topic summary",
        category: "fact",
        idempotency_key: "topic-summary:onboarding",
        upsert: true,
      });

      expect(result.status).toBe("created");
      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );

      const stored = getMemoryById(result.id);
      expect(stored).not.toBeNull();
      expect(stored!.content).toBe("New topic summary");
      expect(stored!.category).toBe("fact");
    });

    test("updates existing memory when idempotency key matches", async () => {
      process.env.ENGRAM_ENABLE_IDEMPOTENCY = "1";

      const created = await remember({
        content: "Original summary",
        category: "fact",
        metadata: { version: 1 },
        idempotency_key: "topic-summary:onboarding",
        upsert: true,
      });

      const updated = await remember({
        content: "Updated summary",
        category: "decision",
        metadata: { version: 2 },
        idempotency_key: "topic-summary:onboarding",
        upsert: true,
      });

      expect(updated.status).toBe("updated");
      expect(updated.id).toBe(created.id);

      const stored = getMemoryById(created.id);
      expect(stored!.content).toBe("Updated summary");
      expect(stored!.category).toBe("decision");
      expect(stored!.metadata_json).toBe('{"version":2}');
    });

    test("does not match keys across different scopes", async () => {
      process.env.ENGRAM_ENABLE_IDEMPOTENCY = "1";
      process.env.ENGRAM_ENABLE_SCOPES = "1";

      const first = await remember({
        content: "Scope A summary",
        scope_id: "scope-a",
        idempotency_key: "topic-summary:shared",
        upsert: true,
      });

      const second = await remember({
        content: "Scope B summary",
        scope_id: "scope-b",
        idempotency_key: "topic-summary:shared",
        upsert: true,
      });

      expect(first.status).toBe("created");
      expect(second.status).toBe("created");
      expect(first.id).not.toBe(second.id);
    });

    test("throws when upsert is true but idempotency_key is missing", async () => {
      await expect(
        remember({ content: "No key", upsert: true }),
      ).rejects.toThrow("upsert requires idempotency_key");
    });

    test("preserves created_at, access_count, strength after update", async () => {
      process.env.ENGRAM_ENABLE_IDEMPOTENCY = "1";

      const created = await remember({
        content: "Original",
        idempotency_key: "topic-summary:preserve",
        upsert: true,
      });

      const beforeUpdate = getMemoryById(created.id)!;

      // Small delay to ensure updated_at differs
      await new Promise((resolve) => setTimeout(resolve, 1100));

      await remember({
        content: "Updated",
        idempotency_key: "topic-summary:preserve",
        upsert: true,
      });

      const afterUpdate = getMemoryById(created.id)!;

      expect(afterUpdate.created_at).toBe(beforeUpdate.created_at);
      expect(afterUpdate.access_count).toBe(beforeUpdate.access_count);
      expect(afterUpdate.strength).toBe(beforeUpdate.strength);
      expect(afterUpdate.updated_at).not.toBe(beforeUpdate.updated_at);
    });

    test("nulls omitted optional fields on update (full replace)", async () => {
      process.env.ENGRAM_ENABLE_IDEMPOTENCY = "1";

      const created = await remember({
        content: "With metadata",
        category: "fact",
        metadata: { source: "test" },
        idempotency_key: "topic-summary:replace",
        upsert: true,
      });

      const beforeUpdate = getMemoryById(created.id)!;
      expect(beforeUpdate.category).toBe("fact");
      expect(beforeUpdate.metadata_json).toBe('{"source":"test"}');

      await remember({
        content: "Without metadata",
        idempotency_key: "topic-summary:replace",
        upsert: true,
      });

      const afterUpdate = getMemoryById(created.id)!;
      expect(afterUpdate.content).toBe("Without metadata");
      expect(afterUpdate.category).toBeNull();
      expect(afterUpdate.metadata_json).toBeNull();
    });

    test("upsert works even when idempotency feature flag is disabled", async () => {
      // ENGRAM_ENABLE_IDEMPOTENCY is "0" from beforeEach
      const created = await remember({
        content: "Original",
        category: "fact",
        idempotency_key: "topic-summary:no-flag",
        upsert: true,
      });

      expect(created.status).toBe("created");

      const updated = await remember({
        content: "Updated",
        category: "decision",
        idempotency_key: "topic-summary:no-flag",
        upsert: true,
      });

      expect(updated.status).toBe("updated");
      expect(updated.id).toBe(created.id);

      const stored = getMemoryById(created.id)!;
      expect(stored.content).toBe("Updated");
    });

    test("non-upsert idempotency replay is unchanged and returns status created", async () => {
      process.env.ENGRAM_ENABLE_IDEMPOTENCY = "1";

      const first = await remember({
        content: "Idempotent memory",
        idempotency_key: "replay-key",
      });

      const replayed = await remember({
        content: "Idempotent memory",
        idempotency_key: "replay-key",
      });

      expect(first.status).toBe("created");
      expect(replayed.status).toBe("created");
      expect(replayed.id).toBe(first.id);

      // Content should not have changed
      const stored = getMemoryById(first.id);
      expect(stored!.content).toBe("Idempotent memory");
    });

    test("regular remember without key returns status created", async () => {
      const result = await remember({ content: "Simple memory" });

      expect(result.status).toBe("created");
    });

    test("non-upsert replay returns status created after prior upsert update", async () => {
      process.env.ENGRAM_ENABLE_IDEMPOTENCY = "1";

      // Create via upsert
      const created = await remember({
        content: "Version 1",
        idempotency_key: "ledger-test",
        upsert: true,
      });
      expect(created.status).toBe("created");

      // Update via upsert
      const updated = await remember({
        content: "Version 2",
        idempotency_key: "ledger-test",
        upsert: true,
      });
      expect(updated.status).toBe("updated");
      expect(updated.id).toBe(created.id);

      // Replay via non-upsert — should return "created", not "updated"
      const replayed = await remember({
        content: "Version 2",
        idempotency_key: "ledger-test",
      });
      expect(replayed.status).toBe("created");
      expect(replayed.id).toBe(created.id);
    });
  });
});

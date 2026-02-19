import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  getMemoryById,
  getMetricsSummary,
  initDatabase,
  resetDatabase,
} from "../src/db";
import { resetEmbedder } from "../src/embedding";
import { forget } from "../src/tools/forget";
import { remember } from "../src/tools/remember";

describe("forget tool", () => {
  const originalScopes = process.env.ENGRAM_ENABLE_SCOPES;

  beforeEach(() => {
    process.env.ENGRAM_ENABLE_SCOPES = "0";
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
  });

  test("deletes a stored memory", async () => {
    const memResult = await remember({ content: "Disposable memory" });
    expect(memResult.ok).toBe(true);
    if (!memResult.ok) throw new Error("expected ok");

    const result = await forget({ id: memResult.value.id });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.value).toEqual({ id: memResult.value.id, deleted: true });
    expect(getMemoryById(memResult.value.id)).toBeNull();
  });

  test("returns deleted false when memory does not exist", async () => {
    const result = await forget({ id: "does-not-exist" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");

    expect(result.value).toEqual({ id: "does-not-exist", deleted: false });
  });

  test("logs forget metric event", async () => {
    const memResult = await remember({
      content: "Memory to forget",
      session_id: "session-forget",
    });
    expect(memResult.ok).toBe(true);
    if (!memResult.ok) throw new Error("expected ok");

    await forget({ id: memResult.value.id, session_id: "session-forget" });

    const summary = getMetricsSummary("session-forget");
    expect(summary.total_remembers).toBe(1);
    expect(summary.total_recalls).toBe(0);
  });

  test("deletes unscoped memory without scope_id when scopes enabled", async () => {
    // Create memory without scope_id (unscoped)
    const memResult = await remember({ content: "Unscoped memory" });
    expect(memResult.ok).toBe(true);
    if (!memResult.ok) throw new Error("expected ok");

    // Enable scopes, then forget without scope_id
    process.env.ENGRAM_ENABLE_SCOPES = "1";
    const result = await forget({ id: memResult.value.id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.deleted).toBe(true);
    expect(getMemoryById(memResult.value.id)).toBeNull();
  });

  test("cannot delete scoped memory without scope_id", async () => {
    process.env.ENGRAM_ENABLE_SCOPES = "1";

    // Create memory with scope_id
    const memResult = await remember({
      content: "Scoped memory",
      scope_id: "project-a",
    });
    expect(memResult.ok).toBe(true);
    if (!memResult.ok) throw new Error("expected ok");

    // Try to forget without scope_id -- should not match (scope_id IS NULL guard)
    const result = await forget({ id: memResult.value.id });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.deleted).toBe(false);
    expect(getMemoryById(memResult.value.id)).not.toBeNull();
  });

  test("deletes scoped memory with correct scope_id", async () => {
    process.env.ENGRAM_ENABLE_SCOPES = "1";

    // Create memory with scope_id
    const memResult = await remember({
      content: "Scoped memory",
      scope_id: "project-a",
    });
    expect(memResult.ok).toBe(true);
    if (!memResult.ok) throw new Error("expected ok");

    // Forget with matching scope_id
    const result = await forget({
      id: memResult.value.id,
      scope_id: "project-a",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.value.deleted).toBe(true);
    expect(getMemoryById(memResult.value.id)).toBeNull();
  });
});

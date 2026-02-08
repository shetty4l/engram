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
    const memory = await remember({ content: "Disposable memory" });

    const result = await forget({ id: memory.id });

    expect(result).toEqual({ id: memory.id, deleted: true });
    expect(getMemoryById(memory.id)).toBeNull();
  });

  test("returns deleted false when memory does not exist", async () => {
    const result = await forget({ id: "does-not-exist" });

    expect(result).toEqual({ id: "does-not-exist", deleted: false });
  });

  test("logs forget metric event", async () => {
    const memory = await remember({
      content: "Memory to forget",
      session_id: "session-forget",
    });

    await forget({ id: memory.id, session_id: "session-forget" });

    const summary = getMetricsSummary("session-forget");
    expect(summary.total_remembers).toBe(1);
    expect(summary.total_recalls).toBe(0);
  });

  test("requires scope_id when scopes are enabled", async () => {
    process.env.ENGRAM_ENABLE_SCOPES = "1";

    await expect(forget({ id: "missing-scope" })).rejects.toThrow(
      "scope_id is required when scopes are enabled",
    );
  });
});

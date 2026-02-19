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

  test("returns err when scope_id missing and scopes are enabled", async () => {
    process.env.ENGRAM_ENABLE_SCOPES = "1";

    const result = await forget({ id: "missing-scope" });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("scope_id is required when scopes are enabled");
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getCapabilities } from "../src/capabilities";
import {
  closeDatabase,
  createMemory,
  initDatabase,
  resetDatabase,
} from "../src/db";
import { resetEmbedder } from "../src/embedding";
import { contextHydrate } from "../src/tools/context-hydrate";

describe("capabilities and context hydration", () => {
  const originalScopes = process.env.ENGRAM_ENABLE_SCOPES;
  const originalIdempotency = process.env.ENGRAM_ENABLE_IDEMPOTENCY;
  const originalContext = process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION;
  const originalWorkItems = process.env.ENGRAM_ENABLE_WORK_ITEMS;

  beforeEach(() => {
    process.env.ENGRAM_ENABLE_SCOPES = "0";
    process.env.ENGRAM_ENABLE_IDEMPOTENCY = "0";
    process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION = "0";
    process.env.ENGRAM_ENABLE_WORK_ITEMS = "0";
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

    if (originalContext === undefined) {
      delete process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION;
    } else {
      process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION = originalContext;
    }

    if (originalWorkItems === undefined) {
      delete process.env.ENGRAM_ENABLE_WORK_ITEMS;
    } else {
      process.env.ENGRAM_ENABLE_WORK_ITEMS = originalWorkItems;
    }
  });

  test("returns feature flags through capabilities", () => {
    process.env.ENGRAM_ENABLE_SCOPES = "1";
    process.env.ENGRAM_ENABLE_IDEMPOTENCY = "1";
    process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION = "1";

    const caps = getCapabilities("0.1.0");
    expect(caps.features.scopes).toBe(true);
    expect(caps.features.idempotency).toBe(true);
    expect(caps.features.context_hydration).toBe(true);
    expect(caps.tools).toContain("capabilities");
    expect(caps.tools).toContain("context_hydrate");
  });

  test("hides context_hydrate when feature is disabled", () => {
    const caps = getCapabilities("0.1.0");
    expect(caps.features.context_hydration).toBe(false);
    expect(caps.tools).not.toContain("context_hydrate");
  });

  test("hydrates context from recall fallback path", async () => {
    createMemory({ id: "m1", content: "First context memory" });
    createMemory({ id: "m2", content: "Second context memory" });

    const result = await contextHydrate({ limit: 1 });
    expect(result.context).toHaveLength(1);
    expect(result.fallback_mode).toBe(true);
  });
});

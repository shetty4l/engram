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
  beforeEach(() => {
    resetDatabase();
    resetEmbedder();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
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
});

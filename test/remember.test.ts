import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  getMemoryById,
  initDatabase,
  resetDatabase,
} from "../src/db";
import { remember } from "../src/tools/remember";

describe("remember tool", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("stores a memory and returns an ID", () => {
    const result = remember({ content: "Test memory" });

    expect(result.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const stored = getMemoryById(result.id);
    expect(stored).not.toBeNull();
    expect(stored!.content).toBe("Test memory");
  });

  test("stores memory with category", () => {
    const result = remember({
      content: "Prefer composition over inheritance",
      category: "decision",
    });

    const stored = getMemoryById(result.id);
    expect(stored!.category).toBe("decision");
  });

  test("stores memory without category", () => {
    const result = remember({ content: "Some fact" });

    const stored = getMemoryById(result.id);
    expect(stored!.category).toBeNull();
  });

  test("generates unique IDs for each memory", () => {
    const result1 = remember({ content: "Memory 1" });
    const result2 = remember({ content: "Memory 2" });

    expect(result1.id).not.toBe(result2.id);
  });
});

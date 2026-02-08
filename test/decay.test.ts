import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  createMemory,
  getAllMemoriesForDecay,
  getDatabase,
  getMemoriesBelowStrength,
  getMemoryById,
  initDatabase,
  pruneMemoriesBelowStrength,
  resetDatabase,
  updateMemoryAccess,
  updateMemoryStrength,
} from "../src/db";
import { calculateDecayedStrength, daysSince } from "../src/db/decay";
import { resetEmbedder } from "../src/embedding";
import { recall } from "../src/tools/recall";

describe("Decay Calculation", () => {
  test("returns full strength for recently accessed memory", () => {
    // Memory accessed just now
    const now = new Date().toISOString();
    const strength = calculateDecayedStrength(now, 1, 1.0);

    // Should be close to 1.0 (accounting for access count boost)
    expect(strength).toBeGreaterThanOrEqual(0.99);
    expect(strength).toBeLessThanOrEqual(1.0);
  });

  test("decays strength over time", () => {
    // Memory accessed 7 days ago
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const strength = calculateDecayedStrength(sevenDaysAgo, 1, 1.0);

    // 0.95^7 ≈ 0.698, with access_count=1 boost of log(2)/log(2) = 1.0
    expect(strength).toBeGreaterThan(0.6);
    expect(strength).toBeLessThan(0.8);
  });

  test("decays more over longer time", () => {
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const fourteenDaysAgo = new Date(
      Date.now() - 14 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const strength7 = calculateDecayedStrength(sevenDaysAgo, 1, 1.0);
    const strength14 = calculateDecayedStrength(fourteenDaysAgo, 1, 1.0);

    expect(strength14).toBeLessThan(strength7);
  });

  test("boosts strength for high access count", () => {
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const lowAccess = calculateDecayedStrength(sevenDaysAgo, 1, 1.0);
    const highAccess = calculateDecayedStrength(sevenDaysAgo, 10, 1.0);

    expect(highAccess).toBeGreaterThan(lowAccess);
  });

  test("caps strength at 1.0", () => {
    // Even with very high access count, should not exceed 1.0
    const now = new Date().toISOString();
    const strength = calculateDecayedStrength(now, 1000, 1.0);

    expect(strength).toBeLessThanOrEqual(1.0);
  });

  test("handles zero access count with decay", () => {
    // Memory accessed a week ago with 0 access count
    // access_count = 0 means log(1) = 0, normalized boost = 0, so strength = 0
    const weekAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    const strength = calculateDecayedStrength(weekAgo, 0, 1.0);

    expect(strength).toBe(0);
  });

  test("returns base strength for recently accessed regardless of access count", () => {
    // Even with 0 access count, if accessed just now, return base strength
    // (This is a quirk but acceptable - access_count=0 shouldn't happen in practice)
    const now = new Date().toISOString();
    const strength = calculateDecayedStrength(now, 0, 1.0);

    expect(strength).toBe(1.0);
  });

  test("respects base strength", () => {
    const sevenDaysAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();

    const fullBase = calculateDecayedStrength(sevenDaysAgo, 1, 1.0);
    const halfBase = calculateDecayedStrength(sevenDaysAgo, 1, 0.5);

    expect(halfBase).toBeLessThan(fullBase);
    expect(halfBase).toBeCloseTo(fullBase / 2, 2);
  });
});

describe("daysSince", () => {
  test("returns 0 for current time", () => {
    const now = new Date().toISOString();
    expect(daysSince(now)).toBeCloseTo(0, 1);
  });

  test("returns 1 for yesterday", () => {
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    expect(daysSince(yesterday)).toBeCloseTo(1, 1);
  });

  test("returns 7 for a week ago", () => {
    const weekAgo = new Date(
      Date.now() - 7 * 24 * 60 * 60 * 1000,
    ).toISOString();
    expect(daysSince(weekAgo)).toBeCloseTo(7, 1);
  });
});

describe("Database Decay Functions", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("updateMemoryAccess boosts strength to 1.0", () => {
    // Create a memory and manually lower its strength
    createMemory({
      id: "test-decay-1",
      content: "Test memory",
      category: "fact",
    });

    // Manually update strength to simulate decay
    updateMemoryStrength("test-decay-1", 0.5);

    // Verify it was lowered
    let memory = getMemoryById("test-decay-1");
    expect(memory!.strength).toBe(0.5);

    // Access it - should boost back to 1.0
    updateMemoryAccess("test-decay-1");

    memory = getMemoryById("test-decay-1");
    expect(memory!.strength).toBe(1.0);
    expect(memory!.access_count).toBe(2); // Initial 1 + access
  });

  test("updateMemoryStrength updates strength", () => {
    createMemory({
      id: "test-strength-1",
      content: "Test memory",
    });

    updateMemoryStrength("test-strength-1", 0.75);

    const memory = getMemoryById("test-strength-1");
    expect(memory!.strength).toBe(0.75);
  });

  test("getAllMemoriesForDecay returns all memories", () => {
    createMemory({ id: "m1", content: "Memory 1" });
    createMemory({ id: "m2", content: "Memory 2" });
    createMemory({ id: "m3", content: "Memory 3" });

    const memories = getAllMemoriesForDecay();
    expect(memories.length).toBe(3);
    expect(memories[0]).toHaveProperty("last_accessed");
    expect(memories[0]).toHaveProperty("access_count");
  });

  test("getMemoriesBelowStrength finds weak memories", () => {
    createMemory({ id: "strong", content: "Strong memory" });
    createMemory({ id: "weak", content: "Weak memory" });

    updateMemoryStrength("weak", 0.05);

    const belowThreshold = getMemoriesBelowStrength(0.1);
    expect(belowThreshold.length).toBe(1);
    expect(belowThreshold[0].id).toBe("weak");
  });

  test("pruneMemoriesBelowStrength deletes weak memories", () => {
    createMemory({ id: "keep", content: "Keep this" });
    createMemory({ id: "prune1", content: "Prune this 1" });
    createMemory({ id: "prune2", content: "Prune this 2" });

    updateMemoryStrength("prune1", 0.05);
    updateMemoryStrength("prune2", 0.08);

    const deleted = pruneMemoriesBelowStrength(0.1);
    expect(deleted).toBe(2);

    // Verify only 'keep' remains
    expect(getMemoryById("keep")).not.toBeNull();
    expect(getMemoryById("prune1")).toBeNull();
    expect(getMemoryById("prune2")).toBeNull();
  });
});

// --- Test helpers ---

/**
 * Backdate a memory's last_accessed via direct SQL.
 * Simulates a memory that hasn't been accessed in N days.
 */
function setLastAccessed(id: string, daysAgo: number): void {
  const db = getDatabase();
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  db.prepare("UPDATE memories SET last_accessed = $date WHERE id = $id").run({
    $date: date.toISOString(),
    $id: id,
  });
}

// --- Recall + Decay Integration Tests ---
// These use createMemory (no embeddings) so recall routes through FTS5/fallback.
// This keeps them fast and suitable for test:core.

describe("Recall Decay Integration", () => {
  beforeEach(() => {
    resetDatabase();
    resetEmbedder();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  test("recall does not persist decay for non-returned memories (FTS5)", async () => {
    // Create 2 memories with distinct content for FTS matching
    createMemory({ id: "match", content: "TypeScript programming language" });
    createMemory({ id: "nomatch", content: "Chocolate cake recipe" });

    // Backdate both to 30 days ago
    setLastAccessed("match", 30);
    setLastAccessed("nomatch", 30);

    // Recall with query that only matches "match"
    await recall({ query: "TypeScript" });

    // The non-matched memory's DB strength should be UNCHANGED
    // Decay is computed on-the-fly from last_accessed, not persisted
    const nomatch = getMemoryById("nomatch");
    expect(nomatch!.strength).toBe(1.0);
  });

  test("recall does not persist decay for non-returned memories (fallback)", async () => {
    // Create 2 memories
    createMemory({ id: "mem-a", content: "First memory" });
    createMemory({ id: "mem-b", content: "Second memory" });

    // Backdate both
    setLastAccessed("mem-a", 30);
    setLastAccessed("mem-b", 30);

    // Empty query = fallback mode, limit=1 means only 1 returned
    const result = await recall({ query: "", limit: 1 });
    expect(result.memories.length).toBe(1);
    expect(result.fallback_mode).toBe(true);

    // The non-returned memory should have unchanged DB strength
    const returnedId = result.memories[0].id;
    const nonReturnedId = returnedId === "mem-a" ? "mem-b" : "mem-a";
    const nonReturned = getMemoryById(nonReturnedId);
    expect(nonReturned!.strength).toBe(1.0);
  });

  test("multiple recalls do not compound decay for non-returned memories", async () => {
    // Create a memory that won't match any of our queries
    createMemory({
      id: "bystander",
      content: "Quantum physics research notes",
    });
    // And one that will match
    createMemory({
      id: "target",
      content: "JavaScript framework comparison",
    });

    setLastAccessed("bystander", 30);
    setLastAccessed("target", 30);

    // Run 3 recalls with queries that don't match "bystander"
    await recall({ query: "JavaScript" });
    await recall({ query: "JavaScript" });
    await recall({ query: "JavaScript" });

    // Bystander's strength should still be 1.0 — never touched
    const bystander = getMemoryById("bystander");
    expect(bystander!.strength).toBe(1.0);
  });

  test("recall filters old memories below min_strength", async () => {
    // Create memory and backdate to 200 days ago
    // Effective strength: 1.0 * 0.95^200 ≈ 0.00004 — well below default min_strength of 0.1
    createMemory({
      id: "ancient",
      content: "Very old forgotten memory about databases",
    });
    setLastAccessed("ancient", 200);

    const result = await recall({ query: "databases" });

    // Should not be returned (effective strength below min_strength)
    expect(result.memories.length).toBe(0);

    // DB strength should remain unchanged — not persisted
    const ancient = getMemoryById("ancient");
    expect(ancient!.strength).toBe(1.0);
  });

  test("recall boosts returned memory strength to 1.0", async () => {
    createMemory({
      id: "recalled-mem",
      content: "Important TypeScript pattern",
    });

    // Manually lower strength (as if decay --apply had been run)
    updateMemoryStrength("recalled-mem", 0.5);

    // Recall it
    await recall({ query: "TypeScript" });

    // Should be boosted back to 1.0 and access_count incremented
    const mem = getMemoryById("recalled-mem");
    expect(mem!.strength).toBe(1.0);
    expect(mem!.access_count).toBe(2); // 1 initial + 1 from recall
  });

  test("recall updates last_accessed for returned memories", async () => {
    createMemory({
      id: "old-accessed",
      content: "Python data science library",
    });

    // Backdate to 10 days ago
    setLastAccessed("old-accessed", 10);

    const before = getMemoryById("old-accessed");
    const oldDate = new Date(before!.last_accessed);

    // Recall it
    await recall({ query: "Python" });

    const after = getMemoryById("old-accessed");
    const newDate = new Date(after!.last_accessed);

    // last_accessed should be updated to recent (within last few seconds)
    expect(newDate.getTime()).toBeGreaterThan(oldDate.getTime());
    const secondsAgo = (Date.now() - newDate.getTime()) / 1000;
    expect(secondsAgo).toBeLessThan(5);
  });

  test("returned memory shows decayed strength in result but DB has 1.0", async () => {
    createMemory({
      id: "decayed-vis",
      content: "Rust memory safety guarantees",
    });

    // Backdate to 7 days ago — effective strength ≈ 0.698
    setLastAccessed("decayed-vis", 7);

    const result = await recall({ query: "Rust" });

    // The RETURNED strength should reflect decay (less than 1.0)
    expect(result.memories.length).toBe(1);
    expect(result.memories[0].strength).toBeLessThan(1.0);
    expect(result.memories[0].strength).toBeGreaterThan(0.5); // 0.95^7 ≈ 0.698

    // But the DB should have 1.0 (boosted by access)
    const mem = getMemoryById("decayed-vis");
    expect(mem!.strength).toBe(1.0);
  });

  test("min_strength parameter filters correctly with decay", async () => {
    // Fresh memory — effective strength ≈ 1.0
    createMemory({ id: "fresh", content: "Brand new coding pattern" });

    // 20-day-old memory — effective strength ≈ 1.0 * 0.95^20 ≈ 0.358
    createMemory({ id: "stale", content: "Old coding convention" });
    setLastAccessed("stale", 20);

    // Recall with min_strength=0.5 — should only return "fresh"
    const result = await recall({ query: "coding", min_strength: 0.5 });

    expect(result.memories.length).toBe(1);
    expect(result.memories[0].id).toBe("fresh");

    // Stale memory's DB strength should be unchanged
    const stale = getMemoryById("stale");
    expect(stale!.strength).toBe(1.0);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  countMemories,
  createMemory,
  getMemoryById,
  initDatabase,
  insertMemoryRaw,
  resetDatabase,
} from "../src/db";
import { embeddingToBuffer } from "../src/embedding";
import {
  deserializeMemory,
  type ExportedMemory,
  exportMemories,
  exportMemoriesNDJSON,
  importMemories,
  resolveConflict,
  serializeMemory,
} from "../src/sync";

/** Create a fake normalized embedding (unit vector). */
function fakeEmbedding(seed: number): Float32Array {
  const dims = 384;
  const emb = new Float32Array(dims);
  for (let i = 0; i < dims; i++) {
    emb[i] = Math.sin(seed * (i + 1));
  }
  // Normalize to unit vector
  let norm = 0;
  for (let i = 0; i < dims; i++) {
    norm += emb[i] * emb[i];
  }
  norm = Math.sqrt(norm);
  for (let i = 0; i < dims; i++) {
    emb[i] /= norm;
  }
  return emb;
}

describe("sync", () => {
  beforeEach(() => {
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
  });

  describe("export", () => {
    test("produces valid NDJSON with all fields", () => {
      createMemory({
        id: "mem-1",
        content: "Test memory",
        category: "fact",
        scope_id: "scope-a",
        idempotency_key: "key-1",
        embedding: embeddingToBuffer(fakeEmbedding(1)),
      });

      const lines = [...exportMemoriesNDJSON({ includeEmbeddings: true })];
      expect(lines).toHaveLength(1);

      const parsed = deserializeMemory(lines[0]);
      expect(parsed.v).toBe(1);
      expect(parsed.id).toBe("mem-1");
      expect(parsed.content).toBe("Test memory");
      expect(parsed.category).toBe("fact");
      expect(parsed.scope_id).toBe("scope-a");
      expect(parsed.idempotency_key).toBe("key-1");
      expect(parsed.created_at).toBeDefined();
      expect(parsed.updated_at).toBeDefined();
      expect(parsed.last_accessed).toBeDefined();
      expect(parsed.access_count).toBe(1);
      expect(parsed.strength).toBe(1.0);
      expect(parsed.embedding).not.toBeNull();
      // Verify embedding is valid base64
      const buf = Buffer.from(parsed.embedding!, "base64");
      expect(buf.byteLength).toBe(384 * 4); // Float32 = 4 bytes per element
    });

    test("with --no-embeddings omits embedding", () => {
      createMemory({
        id: "mem-1",
        content: "Test memory",
        embedding: embeddingToBuffer(fakeEmbedding(1)),
      });

      const lines = [...exportMemoriesNDJSON({ includeEmbeddings: false })];
      expect(lines).toHaveLength(1);

      const parsed = deserializeMemory(lines[0]);
      expect(parsed.embedding).toBeNull();
    });

    test("exportMemories yields ExportedMemory objects", () => {
      createMemory({ id: "mem-1", content: "First" });
      createMemory({ id: "mem-2", content: "Second" });

      const memories = [...exportMemories({ includeEmbeddings: false })];
      expect(memories).toHaveLength(2);
      expect(memories[0].v).toBe(1);
      expect(memories[1].v).toBe(1);
    });
  });

  describe("import", () => {
    function makeNDJSONLine(overrides: Partial<ExportedMemory> = {}): string {
      const mem: ExportedMemory = {
        v: 1,
        id: `import-${Math.random().toString(36).slice(2, 8)}`,
        content: "Imported memory",
        category: null,
        scope_id: null,
        chat_id: null,
        thread_id: null,
        task_id: null,
        metadata_json: null,
        idempotency_key: null,
        created_at: "2026-01-01 00:00:00",
        updated_at: "2026-01-01 00:00:00",
        last_accessed: "2026-01-01 00:00:00",
        access_count: 5,
        strength: 0.8,
        embedding: null,
        ...overrides,
      };
      return JSON.stringify(mem);
    }

    test("import into empty DB inserts all memories", async () => {
      const lines = [
        makeNDJSONLine({ id: "a", content: "Alpha" }),
        makeNDJSONLine({ id: "b", content: "Beta" }),
        makeNDJSONLine({ id: "c", content: "Gamma" }),
      ];

      const result = await importMemories(lines, {
        dryRun: false,
        reembed: false,
        similarityThreshold: 0.92,
      });

      expect(result.inserted).toBe(3);
      expect(result.skippedDuplicate).toBe(0);
      expect(result.resolved.localWins).toBe(0);
      expect(result.resolved.remoteWins).toBe(0);
      expect(countMemories()).toBe(3);
    });

    test("import with idempotency key conflict: latest updated_at wins", async () => {
      // Create local memory with older timestamp
      createMemory({
        id: "local-1",
        content: "Old local content",
        idempotency_key: "shared-key",
      });

      // Import remote memory with same idempotency key but newer timestamp
      const lines = [
        makeNDJSONLine({
          id: "remote-1",
          content: "Newer remote content",
          idempotency_key: "shared-key",
          updated_at: "2099-01-01 00:00:00",
        }),
      ];

      const result = await importMemories(lines, {
        dryRun: false,
        reembed: false,
        similarityThreshold: 0.92,
      });

      expect(result.resolved.remoteWins).toBe(1);
      expect(result.resolved.localWins).toBe(0);
      // The local ID should be preserved (keeps local ID to avoid orphans)
      const updated = getMemoryById("local-1");
      expect(updated).not.toBeNull();
      expect(updated!.content).toBe("Newer remote content");
    });

    test("import with idempotency key conflict: local newer → skip", async () => {
      // Create local memory with newer timestamp
      createMemory({
        id: "local-1",
        content: "Newer local content",
        idempotency_key: "shared-key",
      });

      // Import remote memory with same idempotency key but older timestamp
      const lines = [
        makeNDJSONLine({
          id: "remote-1",
          content: "Older remote content",
          idempotency_key: "shared-key",
          updated_at: "2000-01-01 00:00:00",
        }),
      ];

      const result = await importMemories(lines, {
        dryRun: false,
        reembed: false,
        similarityThreshold: 0.92,
      });

      expect(result.resolved.localWins).toBe(1);
      expect(result.resolved.remoteWins).toBe(0);
      // Local content unchanged
      const mem = getMemoryById("local-1");
      expect(mem!.content).toBe("Newer local content");
    });

    test("import skips unkeyed memory when embedding similarity >= threshold", async () => {
      const emb = fakeEmbedding(42);
      createMemory({
        id: "existing-1",
        content: "Existing memory with embedding",
        embedding: embeddingToBuffer(emb),
      });

      // Import with the exact same embedding — should be duplicate
      const embBase64 = Buffer.from(
        emb.buffer,
        emb.byteOffset,
        emb.byteLength,
      ).toString("base64");

      const lines = [
        makeNDJSONLine({
          id: "new-1",
          content: "Should be detected as duplicate",
          idempotency_key: null,
          embedding: embBase64,
        }),
      ];

      const result = await importMemories(lines, {
        dryRun: false,
        reembed: false,
        similarityThreshold: 0.92,
      });

      expect(result.skippedDuplicate).toBe(1);
      expect(result.inserted).toBe(0);
      expect(countMemories()).toBe(1); // Only the original
    });

    test("import inserts unkeyed memory when no similar match exists", async () => {
      const emb1 = fakeEmbedding(1);
      createMemory({
        id: "existing-1",
        content: "Existing memory",
        embedding: embeddingToBuffer(emb1),
      });

      // Import with a very different embedding
      const emb2 = fakeEmbedding(9999);
      const embBase64 = Buffer.from(
        emb2.buffer,
        emb2.byteOffset,
        emb2.byteLength,
      ).toString("base64");

      const lines = [
        makeNDJSONLine({
          id: "new-1",
          content: "Completely different memory",
          idempotency_key: null,
          embedding: embBase64,
        }),
      ];

      const result = await importMemories(lines, {
        dryRun: false,
        reembed: false,
        similarityThreshold: 0.92,
      });

      expect(result.inserted).toBe(1);
      expect(result.skippedDuplicate).toBe(0);
      expect(countMemories()).toBe(2);
    });

    test("import dry-run writes nothing but returns correct counts", async () => {
      const lines = [
        makeNDJSONLine({ id: "a", content: "Alpha" }),
        makeNDJSONLine({ id: "b", content: "Beta" }),
      ];

      const result = await importMemories(lines, {
        dryRun: true,
        reembed: false,
        similarityThreshold: 0.92,
      });

      expect(result.inserted).toBe(2);
      expect(countMemories()).toBe(0); // Nothing written
    });
  });

  describe("round-trip", () => {
    test("export → import → same count and content", async () => {
      // Populate source DB
      createMemory({
        id: "rt-1",
        content: "Round-trip memory 1",
        category: "fact",
      });
      createMemory({
        id: "rt-2",
        content: "Round-trip memory 2",
        category: "decision",
      });
      createMemory({ id: "rt-3", content: "Round-trip memory 3" });

      // Export
      const lines = [...exportMemoriesNDJSON({ includeEmbeddings: true })];
      expect(lines).toHaveLength(3);

      // Re-init to a fresh empty DB
      closeDatabase();
      resetDatabase();
      initDatabase(":memory:");
      expect(countMemories()).toBe(0);

      // Import
      const result = await importMemories(lines, {
        dryRun: false,
        reembed: false,
        similarityThreshold: 0.92,
      });

      expect(result.inserted).toBe(3);
      expect(countMemories()).toBe(3);

      // Verify content
      const m1 = getMemoryById("rt-1");
      expect(m1).not.toBeNull();
      expect(m1!.content).toBe("Round-trip memory 1");
      expect(m1!.category).toBe("fact");

      const m2 = getMemoryById("rt-2");
      expect(m2).not.toBeNull();
      expect(m2!.content).toBe("Round-trip memory 2");
      expect(m2!.category).toBe("decision");
    });
  });

  describe("insertMemoryRaw", () => {
    test("preserves all original fields", () => {
      const raw = insertMemoryRaw({
        id: "raw-1",
        content: "Raw memory content",
        category: "insight",
        scope_id: "scope-x",
        chat_id: "chat-1",
        thread_id: "thread-1",
        task_id: "task-1",
        metadata_json: '{"key":"value"}',
        idempotency_key: "idem-1",
        created_at: "2020-06-15 12:00:00",
        updated_at: "2021-03-20 08:30:00",
        last_accessed: "2021-03-20 08:30:00",
        access_count: 42,
        strength: 0.75,
        embedding: null,
      });

      expect(raw.id).toBe("raw-1");
      expect(raw.content).toBe("Raw memory content");
      expect(raw.category).toBe("insight");
      expect(raw.scope_id).toBe("scope-x");
      expect(raw.chat_id).toBe("chat-1");
      expect(raw.thread_id).toBe("thread-1");
      expect(raw.task_id).toBe("task-1");
      expect(raw.metadata_json).toBe('{"key":"value"}');
      expect(raw.idempotency_key).toBe("idem-1");
      expect(raw.created_at).toBe("2020-06-15 12:00:00");
      expect(raw.updated_at).toBe("2021-03-20 08:30:00");
      expect(raw.last_accessed).toBe("2021-03-20 08:30:00");
      expect(raw.access_count).toBe(42);
      expect(raw.strength).toBe(0.75);

      // Verify via getMemoryById too
      const fetched = getMemoryById("raw-1");
      expect(fetched).not.toBeNull();
      expect(fetched!.access_count).toBe(42);
      expect(fetched!.strength).toBe(0.75);
      expect(fetched!.created_at).toBe("2020-06-15 12:00:00");
    });
  });

  describe("resolveConflict", () => {
    test("remote wins when remote is newer", () => {
      const local = {
        updated_at: "2025-01-01 00:00:00",
      } as any;
      const remote = {
        updated_at: "2026-01-01 00:00:00",
      } as ExportedMemory;

      expect(resolveConflict(local, remote)).toBe("remote");
    });

    test("local wins when local is newer", () => {
      const local = {
        updated_at: "2026-01-01 00:00:00",
      } as any;
      const remote = {
        updated_at: "2025-01-01 00:00:00",
      } as ExportedMemory;

      expect(resolveConflict(local, remote)).toBe("local");
    });

    test("local wins on tie", () => {
      const ts = "2025-06-15 12:00:00";
      const local = { updated_at: ts } as any;
      const remote = { updated_at: ts } as ExportedMemory;

      expect(resolveConflict(local, remote)).toBe("local");
    });
  });

  describe("serializeMemory / deserializeMemory", () => {
    test("round-trips correctly", () => {
      createMemory({
        id: "ser-1",
        content: "Serialization test",
        category: "fact",
      });
      const mem = getMemoryById("ser-1")!;

      const line = serializeMemory(mem, false);
      const parsed = deserializeMemory(line);

      expect(parsed.id).toBe("ser-1");
      expect(parsed.content).toBe("Serialization test");
      expect(parsed.category).toBe("fact");
      expect(parsed.v).toBe(1);
      expect(parsed.embedding).toBeNull();
    });

    test("deserializeMemory throws on invalid version", () => {
      const badLine = JSON.stringify({ v: 99, id: "x", content: "y" });
      expect(() => deserializeMemory(badLine)).toThrow(
        "unsupported export version",
      );
    });

    test("deserializeMemory throws on missing fields", () => {
      const badLine = JSON.stringify({ v: 1 });
      expect(() => deserializeMemory(badLine)).toThrow(
        "missing required fields",
      );
    });
  });
});

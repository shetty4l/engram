/**
 * Sync module for export/import of memories across engram instances.
 * Uses NDJSON format for streaming-friendly serialization.
 */

import { createLogger } from "@shetty4l/core/log";
import type { Memory } from "./db";
import {
  findMemoryByIdempotencyKey,
  getAllMemoriesIterator,
  getMemoryById,
  insertMemoryRaw,
} from "./db";
import {
  bufferToEmbedding,
  cosineSimilarity,
  embed,
  embeddingToBuffer,
} from "./embedding";

const log = createLogger("engram");

// ── Types ──────────────────────────────────────────────────────────────

export interface ExportedMemory {
  v: 1;
  id: string;
  content: string;
  category: string | null;
  scope_id: string | null;
  chat_id: string | null;
  thread_id: string | null;
  task_id: string | null;
  metadata_json: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  last_accessed: string;
  access_count: number;
  strength: number;
  embedding: string | null; // base64-encoded Float32Array
}

export interface ImportResult {
  inserted: number;
  skippedDuplicate: number;
  resolved: {
    localWins: number;
    remoteWins: number;
  };
}

export interface ExportOptions {
  includeEmbeddings: boolean;
}

export interface ImportOptions {
  dryRun: boolean;
  reembed: boolean;
  similarityThreshold: number;
}

// ── NDJSON Helpers ─────────────────────────────────────────────────────

/**
 * Serialize a Memory row into an ExportedMemory JSON string (one NDJSON line).
 */
export function serializeMemory(
  memory: Memory,
  includeEmbeddings: boolean,
): string {
  const exported: ExportedMemory = {
    v: 1,
    id: memory.id,
    content: memory.content,
    category: memory.category,
    scope_id: memory.scope_id,
    chat_id: memory.chat_id,
    thread_id: memory.thread_id,
    task_id: memory.task_id,
    metadata_json: memory.metadata_json,
    idempotency_key: memory.idempotency_key,
    created_at: memory.created_at,
    updated_at: memory.updated_at,
    last_accessed: memory.last_accessed,
    access_count: memory.access_count,
    strength: memory.strength,
    embedding:
      includeEmbeddings && memory.embedding
        ? Buffer.from(
            memory.embedding.buffer,
            memory.embedding.byteOffset,
            memory.embedding.byteLength,
          ).toString("base64")
        : null,
  };
  return JSON.stringify(exported);
}

/**
 * Deserialize an NDJSON line into an ExportedMemory object.
 * Throws on invalid JSON or missing required fields.
 */
export function deserializeMemory(line: string): ExportedMemory {
  const parsed = JSON.parse(line) as ExportedMemory;
  if (parsed.v !== 1) {
    throw new Error(`unsupported export version: ${parsed.v}`);
  }
  if (!parsed.id || !parsed.content) {
    throw new Error("missing required fields: id, content");
  }
  return parsed;
}

// ── Export ──────────────────────────────────────────────────────────────

/**
 * Export all memories as an async generator of ExportedMemory objects.
 * Yields one memory at a time for streaming.
 */
export function* exportMemories(
  opts: ExportOptions = { includeEmbeddings: true },
): Generator<ExportedMemory> {
  for (const memory of getAllMemoriesIterator()) {
    const line = serializeMemory(memory, opts.includeEmbeddings);
    yield JSON.parse(line) as ExportedMemory;
  }
}

/**
 * Export all memories as an async generator of NDJSON lines.
 */
export function* exportMemoriesNDJSON(
  opts: ExportOptions = { includeEmbeddings: true },
): Generator<string> {
  for (const memory of getAllMemoriesIterator()) {
    yield serializeMemory(memory, opts.includeEmbeddings);
  }
}

// ── Import ─────────────────────────────────────────────────────────────

/**
 * Decode an ExportedMemory's base64 embedding back to a Buffer.
 */
function decodeEmbedding(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

/**
 * Resolve conflict between a local and remote memory sharing the same idempotency key.
 * The memory with the latest `updated_at` wins.
 * Returns "local" if local wins, "remote" if remote wins.
 */
export function resolveConflict(
  local: Memory,
  remote: ExportedMemory,
): "local" | "remote" {
  const localTime = new Date(local.updated_at).getTime();
  const remoteTime = new Date(remote.updated_at).getTime();
  // Remote wins only if strictly newer; ties go to local (keep existing)
  return remoteTime > localTime ? "remote" : "local";
}

/**
 * Check if an incoming unkeyed memory is a duplicate of any existing memory
 * based on embedding cosine similarity.
 */
function isDuplicateByEmbedding(
  incomingEmbedding: Buffer,
  existingMemories: Array<{ embedding: Buffer | null }>,
  threshold: number,
): boolean {
  const incoming = bufferToEmbedding(incomingEmbedding);
  for (const existing of existingMemories) {
    if (!existing.embedding) continue;
    const existingEmb = bufferToEmbedding(existing.embedding);
    const similarity = cosineSimilarity(incoming, existingEmb);
    if (similarity >= threshold) {
      return true;
    }
  }
  return false;
}

/**
 * Import memories from an iterable of NDJSON lines.
 * Performs conflict-aware merge:
 * - Keyed memories (with idempotency_key): resolve by updated_at
 * - Unkeyed memories: dedup by embedding cosine similarity
 * - Exact ID matches: resolve by updated_at
 */
export async function importMemories(
  lines: Iterable<string>,
  opts: ImportOptions = {
    dryRun: false,
    reembed: false,
    similarityThreshold: 0.92,
  },
): Promise<ImportResult> {
  const result: ImportResult = {
    inserted: 0,
    skippedDuplicate: 0,
    resolved: { localWins: 0, remoteWins: 0 },
  };

  // Collect existing memories with embeddings for similarity dedup (only if needed)
  let existingEmbeddings: Array<{ embedding: Buffer | null }> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let exported: ExportedMemory;
    try {
      exported = deserializeMemory(trimmed);
    } catch (e) {
      log(
        `warning: skipping invalid NDJSON line — ${e instanceof Error ? e.message : String(e)}`,
      );
      continue;
    }

    // Decode embedding if present and not re-embedding, or regenerate if reembed
    let embeddingBuffer: Buffer | null = null;
    if (opts.reembed) {
      const embeddingResult = await embed(exported.content);
      if (embeddingResult.ok) {
        embeddingBuffer = embeddingToBuffer(embeddingResult.value);
      } else {
        log(
          `warning: re-embedding failed for ${exported.id}, storing without vector — ${embeddingResult.error}`,
        );
      }
    } else if (exported.embedding) {
      embeddingBuffer = decodeEmbedding(exported.embedding);
    }

    // 1. Check for exact ID match
    const existingById = getMemoryById(exported.id);
    if (existingById) {
      const winner = resolveConflict(existingById, exported);
      if (winner === "local") {
        result.resolved.localWins++;
        continue;
      }
      // Remote wins — update via raw insert (INSERT OR REPLACE)
      if (!opts.dryRun) {
        insertMemoryRaw({
          id: exported.id,
          content: exported.content,
          category: exported.category,
          scope_id: exported.scope_id,
          chat_id: exported.chat_id,
          thread_id: exported.thread_id,
          task_id: exported.task_id,
          metadata_json: exported.metadata_json,
          idempotency_key: exported.idempotency_key,
          created_at: exported.created_at,
          updated_at: exported.updated_at,
          last_accessed: exported.last_accessed,
          access_count: exported.access_count,
          strength: exported.strength,
          embedding: embeddingBuffer,
        });
      }
      result.resolved.remoteWins++;
      continue;
    }

    // 2. Check for idempotency key match
    if (exported.idempotency_key) {
      const existingByKey = findMemoryByIdempotencyKey(
        exported.idempotency_key,
        exported.scope_id ?? undefined,
      );
      if (existingByKey) {
        const winner = resolveConflict(existingByKey, exported);
        if (winner === "local") {
          result.resolved.localWins++;
          continue;
        }
        // Remote wins — replace
        if (!opts.dryRun) {
          insertMemoryRaw({
            id: existingByKey.id, // Keep local ID to avoid orphans
            content: exported.content,
            category: exported.category,
            scope_id: exported.scope_id,
            chat_id: exported.chat_id,
            thread_id: exported.thread_id,
            task_id: exported.task_id,
            metadata_json: exported.metadata_json,
            idempotency_key: exported.idempotency_key,
            created_at: exported.created_at,
            updated_at: exported.updated_at,
            last_accessed: exported.last_accessed,
            access_count: exported.access_count,
            strength: exported.strength,
            embedding: embeddingBuffer,
          });
        }
        result.resolved.remoteWins++;
        continue;
      }
    }

    // 3. Unkeyed memory: check embedding similarity
    if (!exported.idempotency_key && embeddingBuffer) {
      // Lazily load existing embeddings
      if (!existingEmbeddings) {
        existingEmbeddings = [];
        for (const m of getAllMemoriesIterator()) {
          existingEmbeddings.push({ embedding: m.embedding });
        }
      }

      if (
        isDuplicateByEmbedding(
          embeddingBuffer,
          existingEmbeddings,
          opts.similarityThreshold,
        )
      ) {
        result.skippedDuplicate++;
        continue;
      }

      // Not a duplicate — will be inserted. Add to existing embeddings for future checks within this batch.
      existingEmbeddings.push({ embedding: embeddingBuffer });
    }

    // 4. Insert new memory
    if (!opts.dryRun) {
      insertMemoryRaw({
        id: exported.id,
        content: exported.content,
        category: exported.category,
        scope_id: exported.scope_id,
        chat_id: exported.chat_id,
        thread_id: exported.thread_id,
        task_id: exported.task_id,
        metadata_json: exported.metadata_json,
        idempotency_key: exported.idempotency_key,
        created_at: exported.created_at,
        updated_at: exported.updated_at,
        last_accessed: exported.last_accessed,
        access_count: exported.access_count,
        strength: exported.strength,
        embedding: embeddingBuffer,
      });
    }
    result.inserted++;
  }

  return result;
}

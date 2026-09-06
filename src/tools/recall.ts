import { createLogger } from "@shetty4l/core/log";
import { getConfig } from "../config";
import {
  getAllMemoriesWithEmbeddings,
  logMetric,
  type MemoryFilters,
  recordDeliveries,
  searchMemories,
  updateMemorySurfaced,
} from "../db";
import { calculateDecayedStrength } from "../db/decay";
import { bufferToEmbedding, cosineSimilarity, embed } from "../embedding";

const log = createLogger("engram");

/**
 * Traffic classes for recall observability.
 * - deliberate: agent explicitly asked (MCP tool / direct API). Full payload
 *   reaches the agent, so delivery is recorded immediately.
 * - judge: offline audit reads. Self-delivered like deliberate.
 * - auto / session-start / bridge: client-side injection paths. Only
 *   surfaced_count is bumped here; the client confirms what actually entered
 *   context via POST /delivered.
 */
export const RECALL_SOURCES = [
  "deliberate",
  "auto",
  "session-start",
  "bridge",
  "judge",
] as const;
export type RecallSource = (typeof RECALL_SOURCES)[number];

const SELF_DELIVERED_SOURCES: ReadonlySet<RecallSource> = new Set([
  "deliberate",
  "judge",
]);

export interface RecallInput {
  query: string;
  limit?: number;
  category?: string;
  min_strength?: number;
  session_id?: string;
  scope_id?: string;
  chat_id?: string;
  thread_id?: string;
  task_id?: string;
  source?: RecallSource;
}

export interface RecallMemory {
  id: string;
  content: string;
  category: string | null;
  scope_id: string | null;
  idempotency_key: string | null;
  strength: number;
  relevance: number;
  created_at: string;
  access_count: number;
}

export interface RecallOutput {
  recall_id: string;
  memories: RecallMemory[];
  fallback_mode: boolean;
}

/**
 * Record surfacing for all returned memories, plus immediate delivery for
 * self-delivered sources. Injection sources (auto/session-start/bridge) get
 * their delivery recorded later via POST /delivered.
 */
function recordRecallAccess(
  memories: RecallMemory[],
  recallId: string,
  source: RecallSource,
  sessionId: string | undefined,
): void {
  for (const memory of memories) {
    updateMemorySurfaced(memory.id);
  }
  if (SELF_DELIVERED_SOURCES.has(source)) {
    recordDeliveries(
      memories.map((m) => ({
        recall_id: recallId,
        session_id: sessionId,
        source,
        memory_id: m.id,
        chars: m.content.length,
        truncated: false,
      })),
    );
  }
}

/**
 * Semantic search using embeddings.
 * Falls back to FTS5 if no embeddings available.
 */
export async function recall(input: RecallInput): Promise<RecallOutput> {
  const startTime = performance.now();
  const config = getConfig();
  const limit = input.limit ?? config.memory.defaultRecallLimit;
  const minStrength = input.min_strength ?? config.memory.minStrength;
  const source: RecallSource = input.source ?? "deliberate";
  const recallId = crypto.randomUUID();
  const filters: MemoryFilters = config.features.scopes
    ? {
        scope_id: input.scope_id,
        chat_id: input.chat_id,
        thread_id: input.thread_id,
        task_id: input.task_id,
      }
    : {};

  // Empty query falls back to recent memories
  const isFallback = !input.query.trim();
  if (isFallback) {
    return recallFallback(
      input,
      limit,
      minStrength,
      filters,
      startTime,
      recallId,
      source,
    );
  }

  // Try semantic search first
  const memoriesWithEmbeddings = getAllMemoriesWithEmbeddings(filters);

  if (memoriesWithEmbeddings.length === 0) {
    // No embeddings available, fall back to FTS5
    return recallFTS5(
      input,
      limit,
      minStrength,
      filters,
      startTime,
      recallId,
      source,
    );
  }

  // Generate query embedding
  const queryEmbeddingResult = await embed(input.query);

  // If embedding fails, fall back to FTS5 search
  if (!queryEmbeddingResult.ok) {
    log(
      `warning: query embedding failed, falling back to FTS5 — ${queryEmbeddingResult.error}`,
    );
    return recallFTS5(
      input,
      limit,
      minStrength,
      filters,
      startTime,
      recallId,
      source,
    );
  }

  const queryEmbedding = queryEmbeddingResult.value;

  // Recency-aware ranking config. Among semantically similar memories,
  // newer ones should win — mirrors how human recall favors recent context.
  const { recencyWeight, recencyHalfLifeDays } = config.recall;
  const now = Date.now();

  // Compute similarity for all memories with embeddings
  // Apply decay to strength before filtering
  const allDecayed = memoriesWithEmbeddings.map((m) => {
    const memoryEmbedding = bufferToEmbedding(m.embedding!);
    const similarity = cosineSimilarity(queryEmbedding, memoryEmbedding);
    const decayedStrength = calculateDecayedStrength(
      m.last_accessed,
      m.access_count,
      m.strength,
    );

    // Recency score: exponential decay from creation time.
    // A memory `recencyHalfLifeDays` old scores 0.5; brand new scores ~1.0.
    const ageDays = (now - new Date(m.created_at).getTime()) / 86_400_000;
    const recencyScore = Math.pow(
      0.5,
      Math.max(ageDays, 0) / recencyHalfLifeDays,
    );

    // Blend semantic relevance with recency. recencyWeight=0 reproduces
    // legacy pure-similarity ranking.
    const score =
      similarity * (1 - recencyWeight) + recencyScore * recencyWeight;

    return {
      id: m.id,
      content: m.content,
      category: m.category,
      scope_id: m.scope_id,
      idempotency_key: m.idempotency_key,
      strength: decayedStrength,
      relevance: score,
      created_at: m.created_at,
      access_count: m.access_count,
    };
  });

  const scoredMemories = allDecayed
    .filter((m) => m.strength >= minStrength)
    .filter((m) => !input.category || m.category === input.category)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);

  // Surfacing never refreshes decay; only delivery does. Non-returned
  // memories are NOT mutated — decay is computed on-the-fly from
  // last_accessed, so persisting would cause double-decay.
  recordRecallAccess(scoredMemories, recallId, source, input.session_id);

  // Log metric
  logMetric({
    session_id: input.session_id,
    event: "recall",
    query: input.query,
    result_count: scoredMemories.length,
    was_fallback: false,
    latency_ms: performance.now() - startTime,
    source,
    recall_id: recallId,
    memory_ids: scoredMemories.map((m) => m.id),
  });

  return {
    recall_id: recallId,
    memories: scoredMemories,
    fallback_mode: false,
  };
}

/**
 * FTS5-based search fallback when embeddings not available.
 */
function recallFTS5(
  input: RecallInput,
  limit: number,
  minStrength: number,
  filters: MemoryFilters,
  startTime: number,
  recallId: string,
  source: RecallSource,
): RecallOutput {
  let results = searchMemories(input.query, limit * 2, filters);

  // Apply decay and filter by min_strength
  const decayedResults = results.map((m) => ({
    ...m,
    decayedStrength: calculateDecayedStrength(
      m.last_accessed,
      m.access_count,
      m.strength,
    ),
  }));

  let filtered = decayedResults.filter((m) => m.decayedStrength >= minStrength);

  // Filter by category if provided
  if (input.category) {
    filtered = filtered.filter((m) => m.category === input.category);
  }

  // Apply limit
  filtered = filtered.slice(0, limit);

  // Transform to output format
  // BM25 returns negative scores (closer to 0 = better match)
  const memories: RecallMemory[] = filtered.map((m) => ({
    id: m.id,
    content: m.content,
    category: m.category,
    scope_id: m.scope_id,
    idempotency_key: m.idempotency_key,
    strength: m.decayedStrength,
    relevance: Math.exp(m.rank), // e^rank normalizes BM25
    created_at: m.created_at,
    access_count: m.access_count,
  }));

  // Surfacing never refreshes decay; only delivery does.
  recordRecallAccess(memories, recallId, source, input.session_id);

  // Log metric
  logMetric({
    session_id: input.session_id,
    event: "recall",
    query: input.query,
    result_count: memories.length,
    was_fallback: false,
    latency_ms: performance.now() - startTime,
    source,
    recall_id: recallId,
    memory_ids: memories.map((m) => m.id),
  });

  return {
    recall_id: recallId,
    memories,
    fallback_mode: false,
  };
}

/**
 * Fallback to recent memories when query is empty.
 */
function recallFallback(
  input: RecallInput,
  limit: number,
  minStrength: number,
  filters: MemoryFilters,
  startTime: number,
  recallId: string,
  source: RecallSource,
): RecallOutput {
  let results = searchMemories("", limit * 2, filters);

  // Apply decay and filter by min_strength
  const decayedResults = results.map((m) => ({
    ...m,
    decayedStrength: calculateDecayedStrength(
      m.last_accessed,
      m.access_count,
      m.strength,
    ),
  }));

  let filtered = decayedResults.filter((m) => m.decayedStrength >= minStrength);

  // Filter by category if provided
  if (input.category) {
    filtered = filtered.filter((m) => m.category === input.category);
  }

  // Apply limit
  filtered = filtered.slice(0, limit);

  const memories: RecallMemory[] = filtered.map((m) => ({
    id: m.id,
    content: m.content,
    category: m.category,
    scope_id: m.scope_id,
    idempotency_key: m.idempotency_key,
    strength: m.decayedStrength,
    relevance: m.decayedStrength, // Use decayed strength as relevance for fallback
    created_at: m.created_at,
    access_count: m.access_count,
  }));

  // Surfacing never refreshes decay; only delivery does.
  recordRecallAccess(memories, recallId, source, input.session_id);

  // Log metric
  logMetric({
    session_id: input.session_id,
    event: "recall",
    query: input.query,
    result_count: memories.length,
    was_fallback: true,
    latency_ms: performance.now() - startTime,
    source,
    recall_id: recallId,
    memory_ids: memories.map((m) => m.id),
  });

  return {
    recall_id: recallId,
    memories,
    fallback_mode: true,
  };
}

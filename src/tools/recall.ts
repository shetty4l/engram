import { getConfig } from "../config";
import {
  getAllMemoriesWithEmbeddings,
  logMetric,
  type MemoryFilters,
  searchMemories,
  updateMemoryAccess,
} from "../db";
import { calculateDecayedStrength } from "../db/decay";
import { bufferToEmbedding, cosineSimilarity, embed } from "../embedding";

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
}

export interface RecallMemory {
  id: string;
  content: string;
  category: string | null;
  strength: number;
  relevance: number;
  created_at: string;
  access_count: number;
}

export interface RecallOutput {
  memories: RecallMemory[];
  fallback_mode: boolean;
}

/**
 * Semantic search using embeddings.
 * Falls back to FTS5 if no embeddings available.
 */
export async function recall(input: RecallInput): Promise<RecallOutput> {
  const config = getConfig();
  const limit = input.limit ?? config.memory.defaultRecallLimit;
  const minStrength = input.min_strength ?? config.memory.minStrength;
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
    return recallFallback(input, limit, minStrength, filters);
  }

  // Try semantic search first
  const memoriesWithEmbeddings = getAllMemoriesWithEmbeddings(filters);

  if (memoriesWithEmbeddings.length === 0) {
    // No embeddings available, fall back to FTS5
    return recallFTS5(input, limit, minStrength, filters);
  }

  // Generate query embedding
  const queryEmbeddingResult = await embed(input.query);

  // If embedding fails, fall back to FTS5 search
  if (!queryEmbeddingResult.ok) {
    console.error(
      `engram: warning: query embedding failed, falling back to FTS5 — ${queryEmbeddingResult.error}`,
    );
    return recallFTS5(input, limit, minStrength, filters);
  }

  const queryEmbedding = queryEmbeddingResult.value;

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
    return {
      id: m.id,
      content: m.content,
      category: m.category,
      strength: decayedStrength,
      relevance: similarity,
      created_at: m.created_at,
      access_count: m.access_count,
    };
  });

  const scoredMemories = allDecayed
    .filter((m) => m.strength >= minStrength)
    .filter((m) => !input.category || m.category === input.category)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);

  // Update access patterns for returned memories (boosts strength to 1.0)
  // Non-returned memories are NOT mutated — decay is computed on-the-fly
  // from last_accessed, so persisting would cause double-decay.
  for (const memory of scoredMemories) {
    updateMemoryAccess(memory.id);
  }

  // Log metric
  logMetric({
    session_id: input.session_id,
    event: "recall",
    query: input.query,
    result_count: scoredMemories.length,
    was_fallback: false,
  });

  return {
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

  // Update access patterns (boosts strength to 1.0)
  // Non-returned memories are NOT mutated — decay is ephemeral.
  for (const memory of filtered) {
    updateMemoryAccess(memory.id);
  }

  // Transform to output format
  // BM25 returns negative scores (closer to 0 = better match)
  const memories: RecallMemory[] = filtered.map((m) => ({
    id: m.id,
    content: m.content,
    category: m.category,
    strength: m.decayedStrength,
    relevance: Math.exp(m.rank), // e^rank normalizes BM25
    created_at: m.created_at,
    access_count: m.access_count,
  }));

  // Log metric
  logMetric({
    session_id: input.session_id,
    event: "recall",
    query: input.query,
    result_count: memories.length,
    was_fallback: false,
  });

  return {
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

  // Update access patterns (boosts strength to 1.0)
  // Non-returned memories are NOT mutated — decay is ephemeral.
  for (const memory of filtered) {
    updateMemoryAccess(memory.id);
  }

  const memories: RecallMemory[] = filtered.map((m) => ({
    id: m.id,
    content: m.content,
    category: m.category,
    strength: m.decayedStrength,
    relevance: m.decayedStrength, // Use decayed strength as relevance for fallback
    created_at: m.created_at,
    access_count: m.access_count,
  }));

  // Log metric
  logMetric({
    session_id: input.session_id,
    event: "recall",
    query: input.query,
    result_count: memories.length,
    was_fallback: true,
  });

  return {
    memories,
    fallback_mode: true,
  };
}

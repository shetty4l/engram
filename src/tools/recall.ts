import { getConfig } from "../config";
import {
  getAllMemoriesWithEmbeddings,
  logMetric,
  type MemoryFilters,
  searchMemories,
  updateMemoryAccess,
} from "../db";
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
  const queryEmbedding = await embed(input.query);

  // Compute similarity for all memories with embeddings
  const scoredMemories = memoriesWithEmbeddings
    .map((m) => {
      const memoryEmbedding = bufferToEmbedding(m.embedding!);
      const similarity = cosineSimilarity(queryEmbedding, memoryEmbedding);
      return {
        id: m.id,
        content: m.content,
        category: m.category,
        strength: m.strength,
        relevance: similarity,
        created_at: m.created_at,
        access_count: m.access_count,
      };
    })
    .filter((m) => m.strength >= minStrength)
    .filter((m) => !input.category || m.category === input.category)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);

  // Update access patterns for returned memories
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

  // Filter by min_strength
  results = results.filter((m) => m.strength >= minStrength);

  // Filter by category if provided
  if (input.category) {
    results = results.filter((m) => m.category === input.category);
  }

  // Apply limit
  results = results.slice(0, limit);

  // Update access patterns
  for (const memory of results) {
    updateMemoryAccess(memory.id);
  }

  // Transform to output format
  // BM25 returns negative scores (closer to 0 = better match)
  const memories: RecallMemory[] = results.map((m) => ({
    id: m.id,
    content: m.content,
    category: m.category,
    strength: m.strength,
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

  // Filter by min_strength
  results = results.filter((m) => m.strength >= minStrength);

  // Filter by category if provided
  if (input.category) {
    results = results.filter((m) => m.category === input.category);
  }

  // Apply limit
  results = results.slice(0, limit);

  // Update access patterns
  for (const memory of results) {
    updateMemoryAccess(memory.id);
  }

  const memories: RecallMemory[] = results.map((m) => ({
    id: m.id,
    content: m.content,
    category: m.category,
    strength: m.strength,
    relevance: m.strength, // Use strength as relevance for fallback
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

import { getConfig } from "../config";
import { logMetric, searchMemories, updateMemoryAccess } from "../db";

export interface RecallInput {
  query: string;
  limit?: number;
  category?: string;
  min_strength?: number;
  session_id?: string;
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

export function recall(input: RecallInput): RecallOutput {
  const config = getConfig();
  const limit = input.limit ?? config.memory.defaultRecallLimit;
  const minStrength = input.min_strength ?? config.memory.minStrength;

  // Search memories using FTS5 (falls back to recent if query empty)
  const isFallback = !input.query.trim();
  let results = searchMemories(input.query, limit * 2); // Fetch more to filter

  // Filter by min_strength
  results = results.filter((m) => m.strength >= minStrength);

  // Filter by category if provided
  if (input.category) {
    results = results.filter((m) => m.category === input.category);
  }

  // Apply limit
  results = results.slice(0, limit);

  // Update access patterns for returned memories
  for (const memory of results) {
    updateMemoryAccess(memory.id);
  }

  // Transform to output format
  // BM25 returns negative scores (closer to 0 = better match)
  // Convert to 0-1 scale where 1 = best match
  const result: RecallMemory[] = results.map((m) => ({
    id: m.id,
    content: m.content,
    category: m.category,
    strength: m.strength,
    relevance: isFallback ? m.strength : Math.exp(m.rank), // e^rank normalizes BM25
    created_at: m.created_at,
    access_count: m.access_count,
  }));

  // Log metric
  logMetric({
    session_id: input.session_id,
    event: "recall",
    query: input.query,
    result_count: result.length,
    was_fallback: isFallback,
  });

  return {
    memories: result,
    fallback_mode: isFallback,
  };
}

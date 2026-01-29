import { getConfig } from "../config";
import { getAllMemories, updateMemoryAccess } from "../db";

export interface RecallInput {
  query: string;
  limit?: number;
  category?: string;
  min_strength?: number;
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

  // Slice 1: No semantic search yet, just return all memories
  // filtered by category and min_strength
  let memories = getAllMemories(limit * 2); // Fetch more to filter

  // Filter by min_strength
  memories = memories.filter((m) => m.strength >= minStrength);

  // Filter by category if provided
  if (input.category) {
    memories = memories.filter((m) => m.category === input.category);
  }

  // Apply limit
  memories = memories.slice(0, limit);

  // Update access patterns for returned memories
  for (const memory of memories) {
    updateMemoryAccess(memory.id);
  }

  // Transform to output format
  const result: RecallMemory[] = memories.map((m) => ({
    id: m.id,
    content: m.content,
    category: m.category,
    strength: m.strength,
    relevance: m.strength, // In Slice 1, relevance = strength (no similarity yet)
    created_at: m.created_at,
    access_count: m.access_count,
  }));

  return {
    memories: result,
    fallback_mode: true, // Always fallback in Slice 1 (no embeddings)
  };
}

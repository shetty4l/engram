import { createMemory, logMetric } from "../db";
import { embed, embeddingToBuffer } from "../embedding";

export interface RememberInput {
  content: string;
  category?: string;
  session_id?: string;
}

export interface RememberOutput {
  id: string;
  // Future: merged_with, conflict_detected, conflict_with
}

export async function remember(input: RememberInput): Promise<RememberOutput> {
  const id = crypto.randomUUID();

  // Generate embedding for semantic search
  const embeddingVector = await embed(input.content);
  const embeddingBuffer = embeddingToBuffer(embeddingVector);

  createMemory({
    id,
    content: input.content,
    category: input.category,
    embedding: embeddingBuffer,
  });

  // Log metric
  logMetric({
    session_id: input.session_id,
    event: "remember",
    memory_id: id,
  });

  return { id };
}

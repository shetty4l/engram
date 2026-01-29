import { createMemory, logMetric } from "../db";

export interface RememberInput {
  content: string;
  category?: string;
  session_id?: string;
}

export interface RememberOutput {
  id: string;
  // Future: merged_with, conflict_detected, conflict_with
}

export function remember(input: RememberInput): RememberOutput {
  const id = crypto.randomUUID();

  createMemory({
    id,
    content: input.content,
    category: input.category,
  });

  // Log metric
  logMetric({
    session_id: input.session_id,
    event: "remember",
    memory_id: id,
  });

  return { id };
}

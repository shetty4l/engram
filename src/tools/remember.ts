import { createMemory } from "../db";

export interface RememberInput {
  content: string;
  category?: string;
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

  return { id };
}

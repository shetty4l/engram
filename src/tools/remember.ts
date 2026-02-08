import { getConfig } from "../config";
import {
  createMemory,
  getIdempotencyResult,
  logMetric,
  saveIdempotencyResult,
} from "../db";
import { embed, embeddingToBuffer } from "../embedding";

export interface RememberInput {
  content: string;
  category?: string;
  session_id?: string;
  scope_id?: string;
  chat_id?: string;
  thread_id?: string;
  task_id?: string;
  metadata?: Record<string, unknown>;
  idempotency_key?: string;
}

export interface RememberOutput {
  id: string;
  // Future: merged_with, conflict_detected, conflict_with
}

export async function remember(input: RememberInput): Promise<RememberOutput> {
  const config = getConfig();
  const scopeIdForIdempotency = config.features.scopes
    ? input.scope_id
    : undefined;

  if (config.features.idempotency && input.idempotency_key) {
    const existing = getIdempotencyResult<RememberOutput>(
      input.idempotency_key,
      "remember",
      scopeIdForIdempotency,
    );
    if (existing) {
      return existing;
    }
  }

  const id = crypto.randomUUID();

  // Generate embedding for semantic search
  const embeddingVector = await embed(input.content);
  const embeddingBuffer = embeddingToBuffer(embeddingVector);

  createMemory({
    id,
    content: input.content,
    category: input.category,
    scope_id: config.features.scopes ? input.scope_id : undefined,
    chat_id: config.features.scopes ? input.chat_id : undefined,
    thread_id: config.features.scopes ? input.thread_id : undefined,
    task_id: config.features.scopes ? input.task_id : undefined,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : undefined,
    idempotency_key: config.features.idempotency
      ? input.idempotency_key
      : undefined,
    embedding: embeddingBuffer,
  });

  // Log metric
  logMetric({
    session_id: input.session_id,
    event: "remember",
    memory_id: id,
  });

  const output = { id };

  if (config.features.idempotency && input.idempotency_key) {
    saveIdempotencyResult(
      input.idempotency_key,
      "remember",
      scopeIdForIdempotency,
      output,
    );
  }

  return output;
}

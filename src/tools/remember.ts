import { createLogger } from "@shetty4l/core/log";
import { err, ok, type Result } from "@shetty4l/core/result";
import { getConfig } from "../config";
import {
  createMemory,
  findMemoryByIdempotencyKey,
  getIdempotencyResult,
  logMetric,
  saveIdempotencyResult,
  updateMemoryContent,
} from "../db";
import { embed, embeddingToBuffer } from "../embedding";

const log = createLogger("engram");

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
  upsert?: boolean;
}

export interface RememberOutput {
  id: string;
  status: "created" | "updated";
}

export async function remember(
  input: RememberInput,
): Promise<Result<RememberOutput>> {
  const config = getConfig();
  const scopeIdForIdempotency = config.features.scopes
    ? input.scope_id
    : undefined;

  // Upsert path: check for existing memory by idempotency_key, update if found
  if (input.upsert) {
    if (!input.idempotency_key) {
      return err("upsert requires idempotency_key");
    }

    const existing = findMemoryByIdempotencyKey(
      input.idempotency_key,
      scopeIdForIdempotency,
    );

    if (existing) {
      const embeddingResult = await embed(input.content);
      let embeddingBuffer: Buffer | undefined;
      if (embeddingResult.ok) {
        embeddingBuffer = embeddingToBuffer(embeddingResult.value);
      } else {
        log(
          `warning: embedding failed, storing without vector — ${embeddingResult.error}`,
        );
      }

      updateMemoryContent(existing.id, {
        content: input.content,
        category: input.category,
        metadata_json: input.metadata
          ? JSON.stringify(input.metadata)
          : undefined,
        embedding: embeddingBuffer,
      });

      logMetric({
        session_id: input.session_id,
        event: "upsert",
        memory_id: existing.id,
      });

      const output: RememberOutput = { id: existing.id, status: "updated" };

      if (config.features.idempotency) {
        saveIdempotencyResult(
          input.idempotency_key,
          "remember",
          scopeIdForIdempotency,
          { id: existing.id },
        );
      }

      return ok(output);
    }

    // No existing memory found — fall through to create path
  }

  // Non-upsert idempotency replay: return cached result if key matches
  if (!input.upsert && config.features.idempotency && input.idempotency_key) {
    const cachedResult = getIdempotencyResult<{ id: string }>(
      input.idempotency_key,
      "remember",
      scopeIdForIdempotency,
    );
    if (!cachedResult.ok) {
      // Corrupt idempotency data — log and continue to create path
      log(`warning: ${cachedResult.error}`);
    } else if (cachedResult.value !== null) {
      return ok({ id: cachedResult.value.id, status: "created" });
    }
  }

  // Create path
  const id = crypto.randomUUID();

  const embeddingResult = await embed(input.content);
  let embeddingBuffer: Buffer | undefined;
  if (embeddingResult.ok) {
    embeddingBuffer = embeddingToBuffer(embeddingResult.value);
  } else {
    log(
      `warning: embedding failed, storing without vector — ${embeddingResult.error}`,
    );
  }

  createMemory({
    id,
    content: input.content,
    category: input.category,
    scope_id: config.features.scopes ? input.scope_id : undefined,
    chat_id: config.features.scopes ? input.chat_id : undefined,
    thread_id: config.features.scopes ? input.thread_id : undefined,
    task_id: config.features.scopes ? input.task_id : undefined,
    metadata_json: input.metadata ? JSON.stringify(input.metadata) : undefined,
    idempotency_key:
      config.features.idempotency || input.upsert
        ? input.idempotency_key
        : undefined,
    embedding: embeddingBuffer,
  });

  logMetric({
    session_id: input.session_id,
    event: "remember",
    memory_id: id,
  });

  const output: RememberOutput = { id, status: "created" };

  if (config.features.idempotency && input.idempotency_key) {
    saveIdempotencyResult(
      input.idempotency_key,
      "remember",
      scopeIdForIdempotency,
      { id },
    );
  }

  return ok(output);
}

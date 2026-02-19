/**
 * Embedding module for semantic search.
 * Uses Transformers.js with ONNX WASM backend for local embeddings.
 */

import {
  type FeatureExtractionPipeline,
  pipeline,
} from "@huggingface/transformers";
import { err, ok, type Result } from "@shetty4l/core/result";
import { getConfig } from "./config";

let embedder: FeatureExtractionPipeline | null = null;
let isInitializing = false;
let initPromise: Promise<Result<FeatureExtractionPipeline>> | null = null;

/**
 * Get or initialize the embedding pipeline.
 * Lazy-loads the model on first use.
 * Returns Err on model load failure instead of throwing.
 */
export async function getEmbedder(): Promise<
  Result<FeatureExtractionPipeline>
> {
  if (embedder) {
    return ok(embedder);
  }

  // Prevent multiple simultaneous initializations
  if (isInitializing && initPromise) {
    return initPromise;
  }

  isInitializing = true;
  const config = getConfig();

  initPromise = (async (): Promise<Result<FeatureExtractionPipeline>> => {
    try {
      const pipe = await pipeline(
        "feature-extraction",
        config.embedding.model,
        {
          dtype: "q8" as const, // Quantized for smaller size
          cache_dir: config.embedding.cacheDir,
        },
      );
      return ok(pipe as FeatureExtractionPipeline);
    } catch (e) {
      return err(
        `embedding model load failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  })();

  try {
    const result = await initPromise;
    if (result.ok) {
      embedder = result.value;
    }
    return result;
  } finally {
    isInitializing = false;
    initPromise = null;
  }
}

/**
 * Generate embedding for a text string.
 * Returns normalized Float32Array suitable for cosine similarity,
 * or Err on pipeline failure.
 */
export async function embed(text: string): Promise<Result<Float32Array>> {
  const extractorResult = await getEmbedder();
  if (!extractorResult.ok) {
    return extractorResult;
  }

  try {
    const output = await extractorResult.value(text, {
      pooling: "mean",
      normalize: true,
    });
    return ok(output.data as Float32Array);
  } catch (e) {
    return err(
      `embedding failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Generate embeddings for multiple texts.
 * More efficient than calling embed() multiple times.
 * Returns Err if the embedder cannot be loaded.
 */
export async function embedBatch(
  texts: string[],
): Promise<Result<Float32Array[]>> {
  const extractorResult = await getEmbedder();
  if (!extractorResult.ok) {
    return extractorResult;
  }

  const results: Float32Array[] = [];

  // Process one at a time to avoid memory issues with large batches
  try {
    for (const text of texts) {
      const output = await extractorResult.value(text, {
        pooling: "mean",
        normalize: true,
      });
      results.push(output.data as Float32Array);
    }
    return ok(results);
  } catch (e) {
    return err(
      `batch embedding failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Compute cosine similarity between two embeddings.
 * Both embeddings should be normalized (which embed() ensures).
 * Returns value between -1 and 1, where 1 = identical.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
  }

  // Since embeddings are normalized, dot product = cosine similarity
  return dotProduct;
}

/**
 * Convert Float32Array embedding to Buffer for SQLite BLOB storage.
 */
export function embeddingToBuffer(embedding: Float32Array): Buffer {
  return Buffer.from(
    embedding.buffer,
    embedding.byteOffset,
    embedding.byteLength,
  );
}

/**
 * Convert SQLite BLOB Buffer back to Float32Array embedding.
 */
export function bufferToEmbedding(buffer: Buffer): Float32Array {
  // Create a copy to avoid issues with buffer reuse
  const arrayBuffer = buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  );
  return new Float32Array(arrayBuffer);
}

/**
 * Check if embedder is loaded (for status reporting).
 */
export function isEmbedderLoaded(): boolean {
  return embedder !== null;
}

/**
 * Preload the embedder model.
 * Call this at startup to avoid latency on first embed() call.
 * Returns Err if the model cannot be loaded.
 */
export async function preloadEmbedder(): Promise<Result<void>> {
  const result = await getEmbedder();
  if (!result.ok) {
    return result;
  }
  return ok(undefined);
}

/**
 * Reset embedder state (for testing).
 */
export function resetEmbedder(): void {
  embedder = null;
  isInitializing = false;
  initPromise = null;
}

/**
 * Configuration for Engram.
 *
 * Load order:
 *   1. Defaults (hardcoded)
 *   2. Config file (~/.config/engram/config.json)
 *   3. Environment variables (ENGRAM_* env vars)
 *
 * String values in the config file support ${ENV_VAR} interpolation.
 * Fully backwards compatible — if no config file exists, behaves as before.
 */

import { expandPath, getDataDir, loadJsonConfig } from "@shetty4l/core/config";
import { createLogger } from "@shetty4l/core/log";
import type { Result } from "@shetty4l/core/result";
import { err, ok } from "@shetty4l/core/result";
import { join } from "path";

const log = createLogger("engram");

// --- Types ---

export interface Config {
  database: {
    path: string;
  };
  memory: {
    defaultRecallLimit: number;
    minStrength: number;
  };
  decay: {
    /** Daily decay rate (0.95 = 5% decay per day) */
    rate: number;
    /** Strength to set when a memory is accessed */
    accessBoostStrength: number;
  };
  http: {
    port: number;
    host: string;
  };
  embedding: {
    model: string;
    cacheDir: string;
  };
  features: {
    scopes: boolean;
    idempotency: boolean;
    contextHydration: boolean;
    workItems: boolean;
  };
}

/** Where the config was loaded from. */
export type ConfigSource = "file" | "defaults";

export interface ConfigLoadResult {
  config: Config;
  source: ConfigSource;
  path: string;
}

// --- Flat config file schema ---

/**
 * The config file uses a flat schema that maps to Config fields.
 * loadJsonConfig merges this onto defaults, then env vars override.
 */
interface ConfigFileSchema {
  port?: number;
  host?: string;
  dataDir?: string;
  dbPath?: string;
  embeddingModel?: string;
  embeddingCacheDir?: string;
  decayRate?: number;
  accessBoostStrength?: number;
  defaultRecallLimit?: number;
  minStrength?: number;
  scopes?: boolean;
  idempotency?: boolean;
  contextHydration?: boolean;
  workItems?: boolean;
}

const FILE_DEFAULTS: ConfigFileSchema = {
  port: 7749,
  host: "127.0.0.1",
  embeddingModel: "Xenova/bge-small-en-v1.5",
  decayRate: 0.95,
  accessBoostStrength: 1.0,
  defaultRecallLimit: 10,
  minStrength: 0.1,
  scopes: true,
  idempotency: true,
  contextHydration: true,
  workItems: true,
};

// --- Helpers ---

/**
 * Parse a float from an env var, returning the default on NaN.
 * Logs a warning if the value is present but not a valid number.
 */
function parseFloatEnv(
  envName: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseFloat(raw);
  if (Number.isNaN(parsed)) {
    log(
      `warning: ${envName}="${raw}" is not a valid number, using default ${defaultValue}`,
    );
    return defaultValue;
  }
  return parsed;
}

/**
 * Parse a port from an env var, returning the default on invalid input.
 * Valid range: 0-65535 (0 = OS-assigned).
 */
function parsePortEnv(
  envName: string,
  raw: string | undefined,
  defaultValue: number,
): number {
  if (raw === undefined) return defaultValue;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 0 || parsed > 65535) {
    log(
      `warning: ${envName}="${raw}" is not a valid port (0-65535), using default ${defaultValue}`,
    );
    return defaultValue;
  }
  return parsed;
}

// --- Load ---

/**
 * Load config with file support and env var overrides.
 * Returns Result with config, source, and path metadata.
 */
export function loadConfig(configPath?: string): Result<ConfigLoadResult> {
  const loaded = loadJsonConfig({
    name: "engram",
    defaults: FILE_DEFAULTS as Record<string, unknown>,
    configPath,
  });

  if (!loaded.ok) return err(loaded.error);

  const fileConfig = loaded.value.config as unknown as ConfigFileSchema;
  const source = loaded.value.source;
  const path = loaded.value.path;

  const dataDir = getDataDir("engram");

  // Build the full Config, starting from file values (which include defaults),
  // then applying env var overrides on top.
  const config: Config = {
    database: {
      path: process.env.ENGRAM_DB_PATH
        ? expandPath(process.env.ENGRAM_DB_PATH)
        : fileConfig.dbPath
          ? expandPath(fileConfig.dbPath)
          : fileConfig.dataDir
            ? join(expandPath(fileConfig.dataDir), "engram.db")
            : join(dataDir, "engram.db"),
    },
    memory: {
      defaultRecallLimit: fileConfig.defaultRecallLimit ?? 10,
      minStrength: fileConfig.minStrength ?? 0.1,
    },
    decay: {
      rate: parseFloatEnv(
        "ENGRAM_DECAY_RATE",
        process.env.ENGRAM_DECAY_RATE,
        fileConfig.decayRate ?? 0.95,
      ),
      accessBoostStrength: parseFloatEnv(
        "ENGRAM_ACCESS_BOOST_STRENGTH",
        process.env.ENGRAM_ACCESS_BOOST_STRENGTH,
        fileConfig.accessBoostStrength ?? 1.0,
      ),
    },
    http: {
      port: parsePortEnv(
        "ENGRAM_HTTP_PORT",
        process.env.ENGRAM_HTTP_PORT,
        fileConfig.port ?? 7749,
      ),
      host: process.env.ENGRAM_HTTP_HOST || fileConfig.host || "127.0.0.1",
    },
    embedding: {
      model:
        process.env.ENGRAM_EMBEDDING_MODEL ||
        fileConfig.embeddingModel ||
        "Xenova/bge-small-en-v1.5",
      cacheDir: fileConfig.embeddingCacheDir
        ? expandPath(fileConfig.embeddingCacheDir)
        : join(dataDir, "models"),
    },
    features: {
      scopes:
        process.env.ENGRAM_ENABLE_SCOPES !== undefined
          ? process.env.ENGRAM_ENABLE_SCOPES !== "0"
          : (fileConfig.scopes ?? true),
      idempotency:
        process.env.ENGRAM_ENABLE_IDEMPOTENCY !== undefined
          ? process.env.ENGRAM_ENABLE_IDEMPOTENCY !== "0"
          : (fileConfig.idempotency ?? true),
      contextHydration:
        process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION !== undefined
          ? process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION !== "0"
          : (fileConfig.contextHydration ?? true),
      workItems:
        process.env.ENGRAM_ENABLE_WORK_ITEMS !== undefined
          ? process.env.ENGRAM_ENABLE_WORK_ITEMS !== "0"
          : (fileConfig.workItems ?? true),
    },
  };

  return ok({ config, source, path });
}

// --- Legacy API (backwards compatible) ---

/**
 * Get the resolved config. Convenience wrapper that loads config
 * and falls back to defaults on error (preserving existing behavior).
 */
export function getConfig(): Config {
  const result = loadConfig();
  if (!result.ok) {
    log(`warning: config load failed (${result.error}), using defaults`);
    // Fall back to pure env-var config (original behavior)
    return loadConfig()?.ok
      ? (loadConfig() as { ok: true; value: ConfigLoadResult }).value.config
      : getFallbackConfig();
  }
  return result.value.config;
}

/** Pure env-var fallback config (original getConfig behavior). */
function getFallbackConfig(): Config {
  const dataDir = getDataDir("engram");
  return {
    database: {
      path: process.env.ENGRAM_DB_PATH
        ? expandPath(process.env.ENGRAM_DB_PATH)
        : join(dataDir, "engram.db"),
    },
    memory: { defaultRecallLimit: 10, minStrength: 0.1 },
    decay: {
      rate: parseFloatEnv(
        "ENGRAM_DECAY_RATE",
        process.env.ENGRAM_DECAY_RATE,
        0.95,
      ),
      accessBoostStrength: parseFloatEnv(
        "ENGRAM_ACCESS_BOOST_STRENGTH",
        process.env.ENGRAM_ACCESS_BOOST_STRENGTH,
        1.0,
      ),
    },
    http: {
      port: parsePortEnv(
        "ENGRAM_HTTP_PORT",
        process.env.ENGRAM_HTTP_PORT,
        7749,
      ),
      host: process.env.ENGRAM_HTTP_HOST || "127.0.0.1",
    },
    embedding: {
      model: process.env.ENGRAM_EMBEDDING_MODEL || "Xenova/bge-small-en-v1.5",
      cacheDir: join(dataDir, "models"),
    },
    features: {
      scopes: process.env.ENGRAM_ENABLE_SCOPES !== "0",
      idempotency: process.env.ENGRAM_ENABLE_IDEMPOTENCY !== "0",
      contextHydration: process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION !== "0",
      workItems: process.env.ENGRAM_ENABLE_WORK_ITEMS !== "0",
    },
  };
}

/**
 * Log active feature flags. Call once at startup.
 */
export function logFeatureFlags(): void {
  const { features } = getConfig();
  const enabled = Object.entries(features)
    .filter(([, v]) => v)
    .map(([k]) => k);
  log(`features: ${enabled.length > 0 ? enabled.join(", ") : "none"}`);
}

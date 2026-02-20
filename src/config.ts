import { expandPath, getDataDir } from "@shetty4l/core/config";
import { createLogger } from "@shetty4l/core/log";
import { join } from "path";

const log = createLogger("engram");

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

export function getConfig(): Config {
  const dataDir = getDataDir("engram");

  return {
    database: {
      path: process.env.ENGRAM_DB_PATH
        ? expandPath(process.env.ENGRAM_DB_PATH)
        : join(dataDir, "engram.db"),
    },
    memory: {
      defaultRecallLimit: 10,
      minStrength: 0.1,
    },
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

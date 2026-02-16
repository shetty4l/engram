import { homedir } from "os";
import { join } from "path";

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

function expandPath(path: string): string {
  if (path.startsWith("~")) {
    return join(homedir(), path.slice(1));
  }
  return path;
}

function getDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME;
  if (xdgData) {
    return join(xdgData, "engram");
  }
  return join(homedir(), ".local", "share", "engram");
}

export function getConfig(): Config {
  const dataDir = getDataDir();

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
      rate: process.env.ENGRAM_DECAY_RATE
        ? parseFloat(process.env.ENGRAM_DECAY_RATE)
        : 0.95,
      accessBoostStrength: process.env.ENGRAM_ACCESS_BOOST_STRENGTH
        ? parseFloat(process.env.ENGRAM_ACCESS_BOOST_STRENGTH)
        : 1.0,
    },
    http: {
      port: process.env.ENGRAM_HTTP_PORT
        ? parseInt(process.env.ENGRAM_HTTP_PORT, 10)
        : 7749,
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

export function getDataDirectory(): string {
  return getDataDir();
}

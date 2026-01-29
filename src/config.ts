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
  http: {
    port: number;
    host: string;
  };
  embedding: {
    model: string;
    cacheDir: string;
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
  };
}

export function getDataDirectory(): string {
  return getDataDir();
}

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { closeDatabase, initDatabase, resetDatabase } from "../src/db";
import { preloadEmbedder } from "../src/embedding";
import { startHttpServer } from "../src/http";

type ToolSchema = {
  name: string;
  inputSchema: { properties: { category?: { enum?: string[] } } };
};

describe("mcp category schemas", () => {
  const originalEnv = {
    ENGRAM_HTTP_PORT: process.env.ENGRAM_HTTP_PORT,
    ENGRAM_HTTP_HOST: process.env.ENGRAM_HTTP_HOST,
    ENGRAM_ENABLE_CONTEXT_HYDRATION:
      process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION,
    ENGRAM_QUERY_ONLY: process.env.ENGRAM_QUERY_ONLY,
    ENGRAM_DB_PATH: process.env.ENGRAM_DB_PATH,
  };

  beforeAll(async () => {
    await preloadEmbedder();
  });

  beforeEach(() => {
    process.env.ENGRAM_HTTP_PORT = "0";
    process.env.ENGRAM_HTTP_HOST = "127.0.0.1";
    process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION = "1";
    process.env.ENGRAM_QUERY_ONLY = "0";
    process.env.ENGRAM_DB_PATH = join(
      tmpdir(),
      "engram-mcp-categories-test.db",
    );
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDatabase();
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  const mcpHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  async function rpc<T>(
    port: number,
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { result: T };
    return body.result;
  }

  function parseToolText<T>(result: {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }): T {
    expect(result.isError).not.toBe(true);
    return JSON.parse(result.content[0]!.text) as T;
  }

  test("remember, recall, and context_hydrate advertise the miss category", async () => {
    const server = startHttpServer();

    try {
      const { tools } = await rpc<{ tools: ToolSchema[] }>(
        server.port,
        "tools/list",
        {},
      );

      for (const name of ["remember", "recall", "context_hydrate"]) {
        const tool = tools.find((t) => t.name === name);
        expect(tool).toBeDefined();
        expect(tool!.inputSchema.properties.category?.enum).toContain("miss");
      }
    } finally {
      server.stop();
    }
  });

  test("a miss memory round-trips through remember and recall", async () => {
    const server = startHttpServer();

    try {
      const stored = parseToolText<{ id: string }>(
        await rpc(server.port, "tools/call", {
          name: "remember",
          arguments: {
            content: "memory miss: recalled deploy path was stale",
            category: "miss",
            scope_id: "test-miss-scope",
          },
        }),
      );

      const recalled = parseToolText<{
        memories: Array<{ id: string; category: string | null }>;
      }>(
        await rpc(server.port, "tools/call", {
          name: "recall",
          arguments: {
            query: "memory miss stale deploy path",
            category: "miss",
            scope_id: "test-miss-scope",
          },
        }),
      );

      expect(recalled.memories.map((m) => m.id)).toContain(stored.id);
      expect(recalled.memories.every((m) => m.category === "miss")).toBe(true);
    } finally {
      server.stop();
    }
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeDatabase,
  createMemory,
  initDatabase,
  resetDatabase,
} from "../src/db";
import { startHttpServer } from "../src/http";
import type { ExportedMemory } from "../src/sync";

describe("http server", () => {
  const originalPort = process.env.ENGRAM_HTTP_PORT;
  const originalHost = process.env.ENGRAM_HTTP_HOST;
  const originalScopes = process.env.ENGRAM_ENABLE_SCOPES;
  const originalContext = process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION;

  beforeEach(() => {
    process.env.ENGRAM_HTTP_PORT = "0";
    process.env.ENGRAM_HTTP_HOST = "127.0.0.1";
    process.env.ENGRAM_ENABLE_SCOPES = "0";
    process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION = "0";
    resetDatabase();
    initDatabase(":memory:");
  });

  afterEach(() => {
    closeDatabase();
    resetDatabase();

    if (originalPort === undefined) {
      delete process.env.ENGRAM_HTTP_PORT;
    } else {
      process.env.ENGRAM_HTTP_PORT = originalPort;
    }

    if (originalHost === undefined) {
      delete process.env.ENGRAM_HTTP_HOST;
    } else {
      process.env.ENGRAM_HTTP_HOST = originalHost;
    }

    if (originalScopes === undefined) {
      delete process.env.ENGRAM_ENABLE_SCOPES;
    } else {
      process.env.ENGRAM_ENABLE_SCOPES = originalScopes;
    }

    if (originalContext === undefined) {
      delete process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION;
    } else {
      process.env.ENGRAM_ENABLE_CONTEXT_HYDRATION = originalContext;
    }
  });

  test("forget without scope_id targets unscoped memories when scopes enabled", async () => {
    process.env.ENGRAM_ENABLE_SCOPES = "1";
    const server = startHttpServer();

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/forget`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "memory-1" }),
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { id: string; deleted: boolean };
      expect(body.id).toBe("memory-1");
      expect(body.deleted).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("capabilities hides context_hydrate when disabled", async () => {
    const server = startHttpServer();

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/capabilities`,
      );
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        tools: string[];
        features: { context_hydration: boolean };
      };

      expect(body.features.context_hydration).toBe(false);
      expect(body.tools).not.toContain("context_hydrate");
    } finally {
      server.stop();
    }
  });

  test("remember returns 400 when upsert is true without idempotency_key", async () => {
    const server = startHttpServer();

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/remember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "test", upsert: true }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("upsert requires idempotency_key");
    } finally {
      server.stop();
    }
  });

  /** MCP requests require Accept header with both JSON and SSE content types. */
  const mcpHeaders = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };

  test("POST /mcp with initialize returns valid MCP JSON-RPC response", async () => {
    const server = startHttpServer();

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      });

      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        jsonrpc: string;
        id: number;
        result: {
          protocolVersion: string;
          capabilities: { tools: Record<string, unknown> };
          serverInfo: { name: string; version: string };
        };
      };

      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe(1);
      expect(body.result.serverInfo.name).toBe("engram");
      expect(body.result.capabilities.tools).toBeDefined();

      // CORS headers injected
      expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(response.headers.get("Access-Control-Expose-Headers")).toBe(
        "mcp-session-id",
      );
    } finally {
      server.stop();
    }
  });

  test("GET /mcp returns 405 in stateless mode", async () => {
    const server = startHttpServer();

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`);

      expect(response.status).toBe(405);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("Method not allowed");
    } finally {
      server.stop();
    }
  });

  test("GET /export returns NDJSON with correct content-type", async () => {
    // Seed some memories
    createMemory({
      id: "exp-1",
      content: "Export test memory 1",
      category: "fact",
    });
    createMemory({ id: "exp-2", content: "Export test memory 2" });

    const server = startHttpServer();

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/export`);
      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");

      const body = await response.text();
      const lines = body.split("\n").filter((l) => l.trim());
      expect(lines).toHaveLength(2);

      // Each line is valid JSON with v:1
      for (const line of lines) {
        const parsed = JSON.parse(line) as ExportedMemory;
        expect(parsed.v).toBe(1);
        expect(parsed.content).toBeDefined();
      }
    } finally {
      server.stop();
    }
  });

  test("POST /import with valid NDJSON returns summary", async () => {
    const server = startHttpServer();

    try {
      const ndjson = [
        JSON.stringify({
          v: 1,
          id: "imp-1",
          content: "Imported 1",
          category: null,
          scope_id: null,
          chat_id: null,
          thread_id: null,
          task_id: null,
          metadata_json: null,
          idempotency_key: null,
          created_at: "2026-01-01 00:00:00",
          updated_at: "2026-01-01 00:00:00",
          last_accessed: "2026-01-01 00:00:00",
          access_count: 1,
          strength: 1.0,
          embedding: null,
        }),
        JSON.stringify({
          v: 1,
          id: "imp-2",
          content: "Imported 2",
          category: null,
          scope_id: null,
          chat_id: null,
          thread_id: null,
          task_id: null,
          metadata_json: null,
          idempotency_key: null,
          created_at: "2026-01-01 00:00:00",
          updated_at: "2026-01-01 00:00:00",
          last_accessed: "2026-01-01 00:00:00",
          access_count: 1,
          strength: 1.0,
          embedding: null,
        }),
      ].join("\n");

      const response = await fetch(`http://127.0.0.1:${server.port}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/x-ndjson" },
        body: ndjson,
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        inserted: number;
        skippedDuplicate: number;
        resolved: { localWins: number; remoteWins: number };
        dry_run: boolean;
      };
      expect(body.inserted).toBe(2);
      expect(body.skippedDuplicate).toBe(0);
      expect(body.dry_run).toBe(false);
    } finally {
      server.stop();
    }
  });

  test("POST /import?dry_run=1 returns preview without writing", async () => {
    const server = startHttpServer();

    try {
      const ndjson = JSON.stringify({
        v: 1,
        id: "dry-1",
        content: "Dry run memory",
        category: null,
        scope_id: null,
        chat_id: null,
        thread_id: null,
        task_id: null,
        metadata_json: null,
        idempotency_key: null,
        created_at: "2026-01-01 00:00:00",
        updated_at: "2026-01-01 00:00:00",
        last_accessed: "2026-01-01 00:00:00",
        access_count: 1,
        strength: 1.0,
        embedding: null,
      });

      const response = await fetch(
        `http://127.0.0.1:${server.port}/import?dry_run=1`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-ndjson" },
          body: ndjson,
        },
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        inserted: number;
        dry_run: boolean;
      };
      expect(body.inserted).toBe(1);
      expect(body.dry_run).toBe(true);
    } finally {
      server.stop();
    }
  });

  test("POST /mcp tools/list returns engram tools", async () => {
    const server = startHttpServer();

    try {
      // First initialize
      await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0" },
          },
        }),
      });

      // Then list tools (stateless — each request is independent)
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "POST",
        headers: mcpHeaders,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        }),
      });

      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        jsonrpc: string;
        id: number;
        result: { tools: Array<{ name: string }> };
      };

      const toolNames = body.result.tools.map((t) => t.name);
      expect(toolNames).toContain("remember");
      expect(toolNames).toContain("recall");
      expect(toolNames).toContain("forget");
      expect(toolNames).toContain("capabilities");
    } finally {
      server.stop();
    }
  });
});

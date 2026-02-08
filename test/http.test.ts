import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { closeDatabase, initDatabase, resetDatabase } from "../src/db";
import { startHttpServer } from "../src/http";

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

  test("requires scope_id for forget when scopes feature enabled", async () => {
    process.env.ENGRAM_ENABLE_SCOPES = "1";
    const server = startHttpServer();

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/forget`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "memory-1" }),
      });

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("scope_id is required when scopes are enabled");
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
});

/**
 * HTTP Server for Engram
 *
 * Provides REST API for memory operations:
 * - POST /remember - Store a memory
 * - POST /recall - Retrieve memories
 * - GET /health - Health check
 *
 * Used by OpenCode plugin for silent memory extraction.
 */

import { getConfig } from "./config";
import { initDatabase } from "./db";
import { type RecallInput, recall } from "./tools/recall";
import { type RememberInput, remember } from "./tools/remember";

const VERSION = "0.1.0";
const startTime = Date.now();

interface HttpServer {
  port: number;
  stop: () => void;
}

export function startHttpServer(): HttpServer {
  const config = getConfig();
  const { port, host } = config.http;

  // Ensure database is initialized
  initDatabase();

  const server = Bun.serve({
    port,
    hostname: host,
    fetch: handleRequest,
  });

  console.error(`Engram HTTP server listening on http://${host}:${port}`);

  return {
    port: server.port ?? port,
    stop: () => server.stop(),
  };
}

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  // CORS headers for local development
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Handle preflight requests
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  try {
    // Health check
    if (path === "/health" && method === "GET") {
      return Response.json(
        {
          status: "ok",
          version: VERSION,
          uptime: Math.floor((Date.now() - startTime) / 1000),
        },
        { headers },
      );
    }

    // Remember endpoint
    if (path === "/remember" && method === "POST") {
      const body = (await req.json()) as RememberInput;

      if (!body.content) {
        return Response.json(
          { error: "content is required" },
          { status: 400, headers },
        );
      }

      const result = await remember(body);
      return Response.json(result, { headers });
    }

    // Recall endpoint
    if (path === "/recall" && method === "POST") {
      const body = (await req.json()) as RecallInput;

      if (body.query === undefined) {
        return Response.json(
          { error: "query is required" },
          { status: 400, headers },
        );
      }

      const result = await recall(body);
      return Response.json(result, { headers });
    }

    // Not found
    return Response.json({ error: "Not found" }, { status: 404, headers });
  } catch (error) {
    console.error("HTTP request error:", error);
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Internal server error",
      },
      { status: 500, headers },
    );
  }
}

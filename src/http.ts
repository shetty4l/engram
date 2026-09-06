/**
 * HTTP Server for Engram
 *
 * Provides REST API for memory operations:
 * - POST /remember - Store a memory
 * - POST /recall - Retrieve memories
 * - POST /forget - Delete a memory by ID
 * - POST /context/hydrate - Hydrate assistant context (feature-flagged)
 * - GET /export - Stream all memories as NDJSON
 * - POST /import - Import memories from NDJSON body
 * - GET /capabilities - Feature discovery
 * - GET /health - Health check (handled by core)
 * - POST|DELETE /mcp - Streamable HTTP MCP transport (stateless)
 */

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  corsHeaders,
  createServer,
  type HttpServer,
  jsonError,
  jsonOk,
} from "@shetty4l/core/http";
import { createLogger } from "@shetty4l/core/log";
import { getCapabilities } from "./capabilities";
import { getConfig, logFeatureFlags } from "./config";
import {
  deleteExpiredBridgeMemories,
  getStatsForApi,
  initDatabase,
  insertJudgeAudits,
  type JudgeAuditRecord,
  logMetric,
  recordDeliveries,
} from "./db";
import { createMcpServer } from "./mcp-server";
import {
  exportMemoriesNDJSON,
  type ImportResult,
  importMemories,
} from "./sync";
import {
  type ContextHydrateInput,
  contextHydrate,
} from "./tools/context-hydrate";
import { type ForgetInput, forget } from "./tools/forget";
import {
  RECALL_SOURCES,
  type RecallInput,
  type RecallSource,
  recall,
} from "./tools/recall";
import { type RememberInput, remember } from "./tools/remember";
import { VERSION } from "./version";

const log = createLogger("engram");

/** Delivery feedback payload from injection clients (persona plugin etc). */
interface DeliveredInput {
  recall_id: string;
  session_id?: string;
  source?: string;
  memory_ids: string[];
  chars?: number;
  truncated?: boolean;
}

/** Parse JSON body from request, returning a 400 jsonError on failure. */
async function parseJsonBody<T>(req: Request): Promise<T | Response> {
  try {
    return (await req.json()) as T;
  } catch {
    return jsonError(400, "Invalid JSON body");
  }
}

export function startHttpServer(): HttpServer {
  const config = getConfig();
  const { port, host } = config.http;

  // Ensure database is initialized
  initDatabase();

  const server = createServer({
    name: "engram",
    port,
    host,
    version: VERSION,
    onRequest: async (req: Request, url: URL) => {
      const start = performance.now();
      const response = await routeRequest(req, url);

      if (response && url.pathname !== "/stats") {
        const latency = (performance.now() - start).toFixed(0);
        log(`${req.method} ${url.pathname} ${response.status} ${latency}ms`);
      }

      return response;
    },
  });

  log(`v${VERSION}: listening on http://${host}:${server.port}`);
  logFeatureFlags();

  // Bridge TTL sweep: compaction-bridge memories are meant to live minutes;
  // client cleanup failures used to leak them permanently. Skipped in
  // query-only mode — replicas receive deletions via sync.
  if (!config.queryOnly) {
    const sweepBridges = () => {
      try {
        const deleted = deleteExpiredBridgeMemories();
        if (deleted > 0) {
          log(`bridge sweep: deleted ${deleted} expired bridge memories`);
        }
      } catch (err) {
        log(`bridge sweep failed: ${err}`);
      }
    };
    sweepBridges();
    const timer = setInterval(sweepBridges, 60 * 60 * 1000);
    timer.unref?.();
  }

  return server;
}

async function routeRequest(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;
  const config = getConfig();

  if (
    config.queryOnly &&
    ((path === "/remember" && method === "POST") ||
      (path === "/forget" && method === "POST") ||
      (path === "/import" && method === "POST") ||
      (path === "/export" && method === "GET"))
  ) {
    return jsonError(403, "Endpoint disabled in query-only mode");
  }

  if (path === "/capabilities" && method === "GET") {
    return jsonOk(getCapabilities(VERSION));
  }

  if (path === "/stats" && method === "GET") {
    return jsonOk(getStatsForApi());
  }

  // Remember endpoint
  if (path === "/remember" && method === "POST") {
    const bodyOrError = await parseJsonBody<RememberInput>(req);
    if (bodyOrError instanceof Response) return bodyOrError;
    const body = bodyOrError;

    if (!body.content) {
      return jsonError(400, "content is required");
    }

    const result = await remember(body);
    if (!result.ok) {
      return jsonError(400, result.error);
    }
    return jsonOk(result.value);
  }

  // Recall endpoint
  if (path === "/recall" && method === "POST") {
    const bodyOrError = await parseJsonBody<RecallInput>(req);
    if (bodyOrError instanceof Response) return bodyOrError;
    const body = bodyOrError;

    if (body.query === undefined) {
      return jsonError(400, "query is required");
    }

    if (
      body.source !== undefined &&
      !RECALL_SOURCES.includes(body.source as RecallSource)
    ) {
      return jsonError(
        400,
        `source must be one of: ${RECALL_SOURCES.join(", ")}`,
      );
    }

    const result = await recall(body);
    return jsonOk(result);
  }

  // Delivery feedback: client confirms which recalled memories actually
  // entered agent context. Allowed in query-only mode — it is telemetry
  // about reads, not memory content.
  if (path === "/delivered" && method === "POST") {
    const bodyOrError = await parseJsonBody<DeliveredInput>(req);
    if (bodyOrError instanceof Response) return bodyOrError;
    const body = bodyOrError;

    if (!body.recall_id) {
      return jsonError(400, "recall_id is required");
    }
    if (!Array.isArray(body.memory_ids)) {
      return jsonError(400, "memory_ids must be an array");
    }

    const perMemoryChars =
      body.chars !== undefined && body.memory_ids.length > 0
        ? Math.round(body.chars / body.memory_ids.length)
        : undefined;

    recordDeliveries(
      body.memory_ids.map((memoryId) => ({
        recall_id: body.recall_id,
        session_id: body.session_id,
        source: body.source,
        memory_id: memoryId,
        chars: perMemoryChars,
        truncated: body.truncated,
      })),
    );

    logMetric({
      session_id: body.session_id,
      event: "delivered",
      result_count: body.memory_ids.length,
      source: body.source,
      recall_id: body.recall_id,
      memory_ids: body.memory_ids,
    });

    return jsonOk({ recorded: body.memory_ids.length });
  }

  // Judge audit ingestion (orchestrator-write-only by convention)
  if (path === "/judge/audit" && method === "POST") {
    if (config.queryOnly) {
      return jsonError(403, "Endpoint disabled in query-only mode");
    }
    const bodyOrError = await parseJsonBody<{ audits: JudgeAuditRecord[] }>(
      req,
    );
    if (bodyOrError instanceof Response) return bodyOrError;
    const body = bodyOrError;

    if (!Array.isArray(body.audits) || body.audits.length === 0) {
      return jsonError(400, "audits must be a non-empty array");
    }
    for (const audit of body.audits) {
      if (!audit.audit_week || !audit.session_id || !audit.verdict) {
        return jsonError(
          400,
          "each audit requires audit_week, session_id, verdict",
        );
      }
    }

    insertJudgeAudits(body.audits);
    return jsonOk({ recorded: body.audits.length });
  }

  // Forget endpoint
  if (path === "/forget" && method === "POST") {
    const bodyOrError = await parseJsonBody<ForgetInput>(req);
    if (bodyOrError instanceof Response) return bodyOrError;
    const body = bodyOrError;

    if (!body.id) {
      return jsonError(400, "id is required");
    }

    const result = await forget(body);
    if (!result.ok) {
      return jsonError(400, result.error);
    }
    return jsonOk(result.value);
  }

  // Context hydrate endpoint
  if (path === "/context/hydrate" && method === "POST") {
    if (!config.features.contextHydration) {
      return jsonError(403, "context hydration is disabled");
    }

    const bodyOrError = await parseJsonBody<ContextHydrateInput>(req);
    if (bodyOrError instanceof Response) return bodyOrError;

    const result = await contextHydrate(bodyOrError);
    return jsonOk(result);
  }

  // Export endpoint — streams NDJSON
  if (path === "/export" && method === "GET") {
    const noEmbeddings = url.searchParams.get("no_embeddings") === "1";
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const line of exportMemoriesNDJSON({
          includeEmbeddings: !noEmbeddings,
        })) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        ...corsHeaders(),
      },
    });
  }

  // Import endpoint — accepts streaming NDJSON body
  if (path === "/import" && method === "POST") {
    const dryRun = url.searchParams.get("dry_run") === "1";
    const reembed = url.searchParams.get("reembed") === "1";
    const similarityParam = url.searchParams.get("similarity");
    const similarityThreshold = similarityParam
      ? Number.parseFloat(similarityParam)
      : 0.92;

    if (
      Number.isNaN(similarityThreshold) ||
      similarityThreshold < 0 ||
      similarityThreshold > 1
    ) {
      return jsonError(400, "similarity must be a number between 0 and 1");
    }

    // Buffers the full body rather than streaming — conscious tradeoff for
    // simplicity at current scale. Revisit if import payloads grow large.
    const body = await req.text();
    const lines = body.split("\n").filter((l) => l.trim());

    const result: ImportResult = await importMemories(lines, {
      dryRun,
      reembed,
      similarityThreshold,
    });

    return jsonOk({ ...result, dry_run: dryRun });
  }

  // Streamable HTTP MCP endpoint (stateless, per-request server)
  if (path === "/mcp") {
    if (method === "GET") {
      // SSE endpoint not supported in stateless mode
      return jsonError(405, "Method not allowed (stateless MCP — no SSE)");
    }

    if (method === "POST" || method === "DELETE") {
      const mcpServer = createMcpServer();
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await mcpServer.connect(transport);

      const mcpResponse = await transport.handleRequest(req);

      // Inject CORS headers — MCP responses bypass core's jsonOk/jsonError
      const headers = new Headers(mcpResponse.headers);
      for (const [key, value] of Object.entries(corsHeaders())) {
        headers.set(key, value);
      }
      headers.set("Access-Control-Expose-Headers", "mcp-session-id");

      return new Response(mcpResponse.body, {
        status: mcpResponse.status,
        statusText: mcpResponse.statusText,
        headers,
      });
    }
  }

  // Not found — return null so core's createServer generates the 404
  return null;
}

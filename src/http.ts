/**
 * HTTP Server for Engram
 *
 * Provides REST API for memory operations:
 * - POST /remember - Store a memory
 * - POST /recall - Retrieve memories
 * - POST /forget - Delete a memory by ID
 * - POST /context/hydrate - Hydrate assistant context (feature-flagged)
 * - GET /capabilities - Feature discovery
 * - GET /health - Health check (handled by core)
 *
 * Used by OpenCode plugin for silent memory extraction.
 */

import {
  createServer,
  type HttpServer,
  jsonError,
  jsonOk,
} from "@shetty4l/core/http";
import { createLogger } from "@shetty4l/core/log";
import { getCapabilities } from "./capabilities";
import { getConfig, logFeatureFlags } from "./config";
import { initDatabase } from "./db";
import {
  type ContextHydrateInput,
  contextHydrate,
} from "./tools/context-hydrate";
import { type ForgetInput, forget } from "./tools/forget";
import { type RecallInput, recall } from "./tools/recall";
import { type RememberInput, remember } from "./tools/remember";
import { VERSION } from "./version";

const log = createLogger("engram");

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

      if (response) {
        const latency = (performance.now() - start).toFixed(0);
        log(`${req.method} ${url.pathname} ${response.status} ${latency}ms`);
      }

      return response;
    },
  });

  log(`v${VERSION}: listening on http://${host}:${server.port}`);
  logFeatureFlags();

  return server;
}

async function routeRequest(req: Request, url: URL): Promise<Response | null> {
  const path = url.pathname;
  const method = req.method;

  if (path === "/capabilities" && method === "GET") {
    return jsonOk(getCapabilities(VERSION));
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

    const result = await recall(body);
    return jsonOk(result);
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
    const featureConfig = getConfig();
    if (!featureConfig.features.contextHydration) {
      return jsonError(403, "context hydration is disabled");
    }

    const bodyOrError = await parseJsonBody<ContextHydrateInput>(req);
    if (bodyOrError instanceof Response) return bodyOrError;

    const result = await contextHydrate(bodyOrError);
    return jsonOk(result);
  }

  // Not found — return null so core's createServer generates the 404
  return null;
}

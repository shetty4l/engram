import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { getCapabilities } from "./capabilities";
import { getConfig } from "./config";
import { initDatabase } from "./db";
import {
  type ContextHydrateInput,
  contextHydrate,
} from "./tools/context-hydrate";
import { type ForgetInput, forget } from "./tools/forget";
import { type RecallInput, recall } from "./tools/recall";
import { type RememberInput, remember } from "./tools/remember";
import { VERSION } from "./version";

/** Return an MCP error response (isError: true) for validation failures. */
function mcpError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// Initialize database on startup
initDatabase();

const server = new Server(
  {
    name: "engram",
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const config = getConfig();
  const tools: Array<Record<string, unknown>> = [
    {
      name: "remember",
      description:
        "Store a memory for later retrieval. Prefer upsert when a memory has a stable identity by providing upsert=true with a deterministic idempotency_key; use normal create for one-off notes.",
      inputSchema: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The memory content to store",
          },
          category: {
            type: "string",
            description:
              "Optional category: decision, pattern, fact, preference, insight",
            enum: ["decision", "pattern", "fact", "preference", "insight"],
          },
          session_id: {
            type: "string",
            description:
              "Optional session identifier from the calling harness (e.g., OpenCode session ID)",
          },
          scope_id: {
            type: "string",
            description: "Optional scope identifier for isolation",
          },
          chat_id: {
            type: "string",
            description: "Optional chat identifier",
          },
          thread_id: {
            type: "string",
            description: "Optional thread identifier",
          },
          task_id: {
            type: "string",
            description: "Optional task identifier",
          },
          metadata: {
            type: "object",
            description: "Optional structured metadata",
          },
          idempotency_key: {
            type: "string",
            description:
              "Optional stable identity key for retries and updates (recommended format: <scope>:<category>:<topic-slug>, lowercase and deterministic)",
          },
          upsert: {
            type: "boolean",
            description:
              "When true, update the existing memory matching idempotency_key instead of creating a new one (preferred for durable memories with stable keys). Requires idempotency_key. Full-replace semantics: omitted optional fields are set to null.",
          },
        },
        required: ["content"],
      },
    },
    {
      name: "recall",
      description:
        "Retrieve relevant memories. Returns memories ordered by relevance and strength.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "What to search for",
          },
          limit: {
            type: "number",
            description: "Maximum number of memories to return (default: 10)",
          },
          category: {
            type: "string",
            description: "Filter by category",
            enum: ["decision", "pattern", "fact", "preference", "insight"],
          },
          min_strength: {
            type: "number",
            description: "Minimum strength threshold (0.0-1.0, default: 0.1)",
          },
          session_id: {
            type: "string",
            description:
              "Optional session identifier from the calling harness (e.g., OpenCode session ID)",
          },
          scope_id: {
            type: "string",
            description: "Optional scope identifier for isolation",
          },
          chat_id: {
            type: "string",
            description: "Optional chat identifier",
          },
          thread_id: {
            type: "string",
            description: "Optional thread identifier",
          },
          task_id: {
            type: "string",
            description: "Optional task identifier",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "forget",
      description: "Delete a stored memory by ID.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Memory ID to delete",
          },
          session_id: {
            type: "string",
            description:
              "Optional session identifier from the calling harness (e.g., OpenCode session ID)",
          },
          scope_id: {
            type: "string",
            description: "Optional scope identifier guard",
          },
        },
        required: ["id"],
      },
    },
    {
      name: "capabilities",
      description:
        "Discover supported engram features for compatibility-safe client opt-in.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
  ];

  if (config.features.contextHydration) {
    tools.push({
      name: "context_hydrate",
      description:
        "Hydrate contextual memories for an assistant turn. Equivalent to recall with optional empty query.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Optional query string; empty recalls recent/high-signal memories",
          },
          limit: {
            type: "number",
            description: "Maximum number of context entries",
          },
          category: {
            type: "string",
            description: "Optional category filter",
            enum: ["decision", "pattern", "fact", "preference", "insight"],
          },
          min_strength: {
            type: "number",
            description: "Minimum strength threshold",
          },
          session_id: {
            type: "string",
            description: "Optional session identifier",
          },
          scope_id: {
            type: "string",
            description: "Optional scope identifier",
          },
          chat_id: {
            type: "string",
            description: "Optional chat identifier",
          },
          thread_id: {
            type: "string",
            description: "Optional thread identifier",
          },
          task_id: {
            type: "string",
            description: "Optional task identifier",
          },
        },
      },
    });
  }

  return {
    tools,
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "remember": {
      const input = args as unknown as RememberInput;
      if (!input.content) {
        return mcpError("content is required");
      }
      const result = await remember(input);
      if (!result.ok) {
        return mcpError(result.error);
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.value, null, 2),
          },
        ],
      };
    }

    case "recall": {
      const input = args as unknown as RecallInput;
      if (input.query === undefined) {
        return mcpError("query is required");
      }
      const result = await recall(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "forget": {
      const input = args as unknown as ForgetInput;
      if (!input.id) {
        return mcpError("id is required");
      }
      const result = await forget(input);
      if (!result.ok) {
        return mcpError(result.error);
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result.value, null, 2),
          },
        ],
      };
    }

    case "capabilities": {
      const result = getCapabilities(VERSION);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "context_hydrate": {
      const config = getConfig();
      if (!config.features.contextHydration) {
        return mcpError("context_hydrate is disabled");
      }

      const input = (args ?? {}) as unknown as ContextHydrateInput;
      const result = await contextHydrate(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    default:
      return mcpError(`Unknown tool: ${name}`);
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("engram: mcp server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

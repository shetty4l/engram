import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { initDatabase } from "./db";
import { type ForgetInput, forget } from "./tools/forget";
import { type RecallInput, recall } from "./tools/recall";
import { type RememberInput, remember } from "./tools/remember";

// Initialize database on startup
initDatabase();

const server = new Server(
  {
    name: "engram",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "remember",
        description:
          "Store a memory for later retrieval. Use this to save decisions, patterns, facts, preferences, or insights.",
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
          },
          required: ["id"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "remember": {
      const input = args as unknown as RememberInput;
      if (!input.content) {
        throw new Error("content is required");
      }
      const result = await remember(input);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    case "recall": {
      const input = args as unknown as RecallInput;
      if (input.query === undefined) {
        throw new Error("query is required");
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
        throw new Error("id is required");
      }
      const result = await forget(input);
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
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Engram MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

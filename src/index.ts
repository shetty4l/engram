import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { initDatabase } from "./db";
import { createMcpServer } from "./mcp-server";

initDatabase();

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
console.error("engram: mcp server running on stdio");

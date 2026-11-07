import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolHandlers, TOOLS } from "./tool-handlers.js";

export const SERVER_NAME = "podcastindex-mcp";
export const SERVER_VERSION = "0.3.0";

/**
 * Build an MCP Server wired to the given tool handlers. Transport-agnostic:
 * stdio connects one instance for the process lifetime; HTTP builds one per
 * request (stateless mode).
 */
export function createMcpServer(toolHandlers: ToolHandlers): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    toolHandlers.handleToolCall(
      request.params.name,
      request.params.arguments ?? {}
    )
  );

  return server;
}

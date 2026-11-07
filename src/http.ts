import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./server.js";
import type { ToolHandlers } from "./tool-handlers.js";

export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/health";
const MAX_BODY_BYTES = 1024 * 1024; // 1 MiB — tool args are tiny

const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]", "::1"];

export interface HttpOptions {
  /**
   * Hostnames (without port) accepted in the Host header, for DNS-rebinding
   * protection. Empty/undefined disables the check.
   */
  allowedHosts?: string[];
  /** If set, every /mcp request must send `Authorization: Bearer <token>`. */
  authToken?: string;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTNAMES.includes(host);
}

/** Default allowed Host names for a given bind address. */
export function defaultAllowedHosts(bindHost: string): string[] | undefined {
  return isLoopbackHost(bindHost) ? LOOPBACK_HOSTNAMES : undefined;
}

function hostnameOf(hostHeader: string | undefined): string | undefined {
  if (!hostHeader) return undefined;
  // "[::1]:3000" -> "[::1]", "localhost:3000" -> "localhost"
  if (hostHeader.startsWith("[")) {
    const end = hostHeader.indexOf("]");
    return end === -1 ? hostHeader : hostHeader.slice(0, end + 1);
  }
  return hostHeader.split(":")[0];
}

function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }));
}

class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Build a Node HTTP server exposing the MCP Streamable HTTP transport at
 * `/mcp` (stateless: a fresh MCP server + transport per POST) and a
 * liveness probe at `/health`. Does not call listen().
 */
export function createHttpServer(
  toolHandlers: ToolHandlers,
  options: HttpOptions = {}
): HttpServer {
  const allowedHosts = options.allowedHosts?.length
    ? options.allowedHosts.map((h) => h.toLowerCase())
    : undefined;

  return createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://placeholder").pathname;

      if (allowedHosts) {
        const hostname = hostnameOf(req.headers.host)?.toLowerCase();
        if (!hostname || !allowedHosts.includes(hostname)) {
          sendJsonRpcError(res, 403, -32000, "Forbidden: invalid Host header");
          return;
        }
      }

      if (path === HEALTH_PATH && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (path !== MCP_PATH) {
        sendJsonRpcError(res, 404, -32000, "Not found");
        return;
      }

      if (
        options.authToken &&
        !tokenMatches(req.headers.authorization, options.authToken)
      ) {
        sendJsonRpcError(res, 401, -32001, "Unauthorized", {
          "WWW-Authenticate": "Bearer",
        });
        return;
      }

      // Stateless mode: no sessions, so no standalone SSE stream (GET) and
      // nothing to terminate (DELETE).
      if (req.method !== "POST") {
        sendJsonRpcError(res, 405, -32000, "Method not allowed", {
          Allow: "POST",
        });
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          sendJsonRpcError(res, 413, -32600, "Request body too large");
        } else {
          sendJsonRpcError(res, 400, -32700, "Parse error: invalid JSON");
        }
        return;
      }

      const server = createMcpServer(toolHandlers);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      console.error("Error handling MCP HTTP request:", err);
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, -32603, "Internal server error");
      } else {
        res.end();
      }
    }
  });
}

#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PodcastIndexApiClient } from "./api-client.js";
import { ToolHandlers } from "./tool-handlers.js";
import { createMcpServer } from "./server.js";
import {
  createHttpServer,
  defaultAllowedHosts,
  isLoopbackHost,
  MCP_PATH,
} from "./http.js";

const API_KEY = process.env.PODCASTINDEX_API_KEY ?? "";
const API_SECRET = process.env.PODCASTINDEX_API_SECRET ?? "";

if (!API_KEY || !API_SECRET) {
  console.error(
    "Warning: PODCASTINDEX_API_KEY and/or PODCASTINDEX_API_SECRET are not set. " +
      "The server will start, but tool calls will fail until both are configured."
  );
  console.error(
    "Get free API credentials at https://api.podcastindex.org/. See README.md."
  );
}

/** `--transport http` / `--transport=http` wins over MCP_TRANSPORT. */
function resolveTransport(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--transport") return argv[i + 1] ?? "";
    if (argv[i].startsWith("--transport=")) {
      return argv[i].slice("--transport=".length);
    }
  }
  return process.env.MCP_TRANSPORT ?? "stdio";
}

const toolHandlers = new ToolHandlers(
  new PodcastIndexApiClient(API_KEY, API_SECRET),
  Boolean(API_KEY && API_SECRET)
);

async function runStdio() {
  const server = createMcpServer(toolHandlers);
  await server.connect(new StdioServerTransport());
  process.on("SIGINT", () => process.exit(0));
}

async function runHttp() {
  const host = process.env.MCP_HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${process.env.PORT}`);
  }
  const authToken = process.env.MCP_AUTH_TOKEN || undefined;
  const allowedHosts = process.env.MCP_ALLOWED_HOSTS
    ? process.env.MCP_ALLOWED_HOSTS.split(",").map((h) => h.trim()).filter(Boolean)
    : defaultAllowedHosts(host);

  if (!isLoopbackHost(host) && !authToken) {
    console.error(
      `Warning: listening on ${host} without MCP_AUTH_TOKEN. Anyone who can ` +
        "reach this port can spend your Podcast Index API quota."
    );
  }

  const httpServer = createHttpServer(toolHandlers, { allowedHosts, authToken });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, resolve);
  });
  const shownHost = host.includes(":") ? `[${host}]` : host;
  console.error(
    `podcastindex-mcp listening on http://${shownHost}:${port}${MCP_PATH}`
  );

  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const transport = resolveTransport(process.argv.slice(2));
const run =
  transport === "http"
    ? runHttp
    : transport === "stdio"
      ? runStdio
      : () =>
          Promise.reject(
            new Error(`Unknown transport "${transport}" (use stdio or http)`)
          );

run().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

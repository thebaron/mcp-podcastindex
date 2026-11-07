import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import type { Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { request as httpRequest } from "node:http";
import { createHttpServer, defaultAllowedHosts } from "../http.js";
import { ToolHandlers, TOOLS } from "../tool-handlers.js";
import { PodcastIndexApiClient } from "../api-client.js";

const mockApiClient = {
  searchByTerm: vi.fn().mockResolvedValue({ feeds: [{ id: 42 }] }),
};

const handlers = new ToolHandlers(
  mockApiClient as unknown as PodcastIndexApiClient
);

const ACCEPT = "application/json, text/event-stream";
const TOKEN = "s3cret-token";

function rpc(method: string, params: unknown = {}, id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const INIT_PARAMS = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "0.0.0" },
};

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("HTTP transport (no auth, loopback host check)", () => {
  let server: HttpServer;
  let base: string;

  beforeAll(async () => {
    server = createHttpServer(handlers, {
      allowedHosts: defaultAllowedHosts("127.0.0.1"),
    });
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (body: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT },
      body,
    });

  it("serves /health", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("returns 404 for unknown paths", async () => {
    expect((await fetch(`${base}/nope`)).status).toBe(404);
  });

  it("rejects GET on /mcp with 405 (stateless)", async () => {
    const res = await fetch(`${base}/mcp`, { headers: { Accept: ACCEPT } });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
  });

  it("handles initialize", async () => {
    const res = await post(rpc("initialize", INIT_PARAMS));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.serverInfo.name).toBe("podcastindex-mcp");
    expect(json.result.capabilities.tools).toBeDefined();
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("lists all tools", async () => {
    const res = await post(rpc("tools/list"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.result.tools).toHaveLength(TOOLS.length);
  });

  it("calls a tool through the API client", async () => {
    const res = await post(
      rpc("tools/call", { name: "search_by_term", arguments: { q: "ai" } })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(mockApiClient.searchByTerm).toHaveBeenCalled();
    expect(json.result.content[0].text).toContain("42");
  });

  it("returns a parse error for invalid JSON", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("rejects a foreign Host header (DNS rebinding)", async () => {
    const { port } = server.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/mcp",
          method: "POST",
          headers: {
            Host: "evil.example.com",
            "Content-Type": "application/json",
            Accept: ACCEPT,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on("error", reject);
      req.end(rpc("tools/list"));
    });
    expect(status).toBe(403);
  });
});

describe("HTTP transport (bearer auth)", () => {
  let server: HttpServer;
  let base: string;

  beforeAll(async () => {
    server = createHttpServer(handlers, { authToken: TOKEN });
    base = await listen(server);
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const post = (auth?: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: ACCEPT,
        ...(auth ? { Authorization: auth } : {}),
      },
      body: rpc("tools/list"),
    });

  it("rejects requests without a token", async () => {
    const res = await post();
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects a wrong token", async () => {
    expect((await post("Bearer wrong")).status).toBe(401);
  });

  it("accepts the correct token", async () => {
    const res = await post(`Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect((await res.json()).result.tools).toHaveLength(TOOLS.length);
  });

  it("leaves /health unauthenticated", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });
});

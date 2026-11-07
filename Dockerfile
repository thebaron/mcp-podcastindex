# podcastindex-mcp — MCP server for the Podcast Index API (stdio or Streamable HTTP)
# Build:  docker build -t podcastindex-mcp .
# Run (stdio): docker run -i --rm -e PODCASTINDEX_API_KEY=... -e PODCASTINDEX_API_SECRET=... podcastindex-mcp
# Run (HTTP):  docker run --rm -p 3000:3000 -e MCP_TRANSPORT=http -e MCP_HOST=0.0.0.0 \
#                -e MCP_AUTH_TOKEN=... -e PODCASTINDEX_API_KEY=... -e PODCASTINDEX_API_SECRET=... podcastindex-mcp

# Pin the multi-architecture base for reproducible MCP Catalog builds.
# Dependabot checks the pinned node/alpine tag weekly for a new digest.
FROM node:26-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94 AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:26-alpine3.24@sha256:c6ad9e9c1d80f6eb607c26b4b0a132ff7a2344fad1c78ea3baa2a7d4c8de6d94
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/build ./build

# Runtime environment variables (optional at startup — the server starts and
# answers introspection without them; tool calls fail with a clear error
# until both are set):
#   PODCASTINDEX_API_KEY    — free API key from https://api.podcastindex.org/
#   PODCASTINDEX_API_SECRET — matching API secret
# HTTP mode (see README): MCP_TRANSPORT=http, MCP_HOST, PORT, MCP_AUTH_TOKEN,
# MCP_ALLOWED_HOSTS

EXPOSE 3000

USER node
CMD ["node", "build/index.js"]

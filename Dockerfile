# Standalone MCP server image for tri (src/mcp-server.ts) -- no OpenClaw
# involved, see AGENTS.md and README's "Standalone MCP server" section.
#
#   docker build -t tri-mcp .
#
# Run (stdio, the default transport):
#
#   docker run -i --rm \
#     -e TRILIUM_URL=https://trilium.example.com \
#     -e TRILIUM_TOKEN=your-etapi-token \
#     tri-mcp
#
# Or Streamable HTTP (loopback-only by default; expose on all interfaces via
# MCP_HOST=0.0.0.0, e.g. behind a reverse proxy on a bridged network). The
# app has NO built-in auth -- only expose non-loopback behind an authenticated
# proxy (Caddy Basic auth), list the proxy's public hostname in
# MCP_ALLOWED_HOSTS (DNS-rebinding protection), and prefer TRILIUM_READ_ONLY:
#
#   docker run --rm -p 3000:3000 -e MCP_TRANSPORT=http \
#     -e MCP_HOST=0.0.0.0 -e MCP_ALLOWED_HOSTS=mcp.example.com \
#     -e TRILIUM_URL=... -e TRILIUM_TOKEN=... \
#     tri-mcp
#
# To keep secrets out of plaintext env, TRILIUM_URL_FILE / TRILIUM_TOKEN_FILE
# take a path to a (Docker-secret) file whose trimmed contents are used
# instead -- e.g. -e TRILIUM_TOKEN_FILE=/run/secrets/token

FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod=false
COPY . .
RUN pnpm run build
RUN pnpm install --frozen-lockfile --prod

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
# The semantic index is the only state this server keeps -- give it a
# writable, volume-mountable home outside the container's own filesystem
# rather than defaulting under $HOME (which a non-root user may not own).
RUN mkdir -p /data && chown node:node /data
ENV TRILIUM_SEMANTIC_INDEX_PATH=/data/semantic-index.db
VOLUME ["/data"]
EXPOSE 3000
USER node
ENTRYPOINT ["node", "dist/mcp-server.js"]

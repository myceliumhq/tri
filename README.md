# tri

[![CI](https://github.com/myceliumhq/tri/actions/workflows/ci.yml/badge.svg)](https://github.com/myceliumhq/tri/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An agent-facing CLI for [TriliumNext](https://triliumnotes.org/) Notes, talking to its
[ETAPI](https://docs.triliumnotes.org/user-guide/advanced-usage/etapi) REST API. Search, read,
write, and lightly organize notes -- covering the same workflows you'd otherwise do by hand in
Trilium's own UI.

Built for coding agents: token-cheap `--help`, deterministic exit codes, file-path-based
attachment I/O (bytes never round-trip through an agent's context), no interactive prompts.

A standalone [MCP](https://modelcontextprotocol.io) server is also included, for hosts without a
shell.

## Use

No install step needed -- `npx` fetches and caches it on first run:

```bash
export TRILIUM_URL=https://trilium.example.com
export TRILIUM_TOKEN=your-etapi-token  # Options -> ETAPI -> Create new ETAPI token

npx @myceliumhq/tri doctor
npx @myceliumhq/tri search "#book #year >= 1950"
npx @myceliumhq/tri note read abc123
npx @myceliumhq/tri note append abc123 --file notes.md
npx @myceliumhq/tri tree root --depth 3
npx @myceliumhq/tri journal today
npx @myceliumhq/tri attach add abc123 ./diagram.png
```

Prefer a global install to skip `npx`'s resolve step on every call (or if you're scripting many
invocations in a loop):

```bash
npm install --global @myceliumhq/tri
tri doctor
```

See `tri <command> --help` for flags on any command, or the bundled skill
(`skills/trilium/SKILL.md`) for the full command reference and decision guidance.

## Semantic search

`tri search` is Trilium's own lexical/attribute query language by default. Optional semantic
search is available as a separate sidecar, `tri-semanticd` -- this package's own binary, built on
[`@myceliumhq/semanticd`](https://github.com/myceliumhq/semanticd) with this repo's Trilium
adapter wired in directly. Run it alongside your Trilium instance and it syncs a local vector
index:

```bash
export TRILIUM_URL=https://trilium.example.com
export TRILIUM_TOKEN=your-etapi-token
export EMBEDDING_PROVIDER=local   # zero-API-key CPU model; or openai-compatible, see semanticd's README

npx -p @myceliumhq/tri tri-semanticd
```

Or as a container: `ghcr.io/myceliumhq/tri-semanticd:<version>` (built from `Dockerfile.semanticd`,
published on every tagged release). Once it's running, point both the CLI and the standalone MCP
server below at it with `TRILIUM_SEMANTICD_URL` -- `tri search` fuses its own lexical results with
the sidecar's over HTTP (`GET /query?q=...`) automatically, no separate mode to pick:

```bash
export TRILIUM_SEMANTICD_URL=http://localhost:4499
npx @myceliumhq/tri search "book recommendations"
```

Unset (or the sidecar unreachable), `tri search` transparently falls back to lexical-only --
nothing to configure to keep using it without a sidecar.

## Standalone MCP server

The same functionality also runs outside a shell entirely, as an ordinary MCP server (stdio or
Streamable HTTP), via [`@myceliumhq/mcp`](https://github.com/myceliumhq/toolkit/tree/main/packages/mcp).
Useful for any MCP client -- Claude Desktop, Claude Code, etc.

Configuration is env vars instead of a config file:

| Env var | Required | Notes |
| --- | --- | --- |
| `TRILIUM_URL` | yes | Base URL of the Trilium instance |
| `TRILIUM_TOKEN` | yes | ETAPI token |
| `TRILIUM_URL_FILE` / `TRILIUM_TOKEN_FILE` | no | Docker-secret variants: path to a file whose trimmed contents are used instead |
| `TRILIUM_READ_ONLY` | no | Set to exactly `true` to register only read tools -- write tools aren't registered at all, so they can't be listed or called. Not a substitute for authenticating the HTTP transport |
| `TRILIUM_SEMANTICD_URL` | no | Base URL of a deployed `tri-semanticd` sidecar (see "Semantic search" above). Unset falls back to lexical/attribute-only search |
| `TRILIUM_SEMANTIC_SEARCH_ENABLED` | no | Set to exactly `false` to skip semantic search even if `TRILIUM_SEMANTICD_URL` is set |
| `MCP_TRANSPORT` | no | `stdio` (default) or `http` |
| `MCP_PORT` | no | Only used with `MCP_TRANSPORT=http`; default `3000` |
| `MCP_HOST` | no | Only used with `MCP_TRANSPORT=http`; default `127.0.0.1` (loopback-only). Set to `0.0.0.0` only behind an authenticated reverse proxy, and only with `MCP_ALLOWED_HOSTS` set (or startup fails) |
| `MCP_ALLOWED_HOSTS` | no | Comma-separated hostnames the server accepts in `Host` (DNS-rebinding protection). Required when `MCP_HOST=0.0.0.0` |

```bash
pnpm run build
TRILIUM_URL=https://trilium.example.com TRILIUM_TOKEN=your-etapi-token pnpm run start:mcp
```

A `Dockerfile` is included for building a container image locally (`Dockerfile.semanticd` for the
semantic search sidecar above).

## Development

See [CONTRIBUTING.md](./CONTRIBUTING.md) for dev setup, regenerating API types, and commit
conventions.

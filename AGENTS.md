# AGENTS.md

## Using this CLI

No install needed for one-off use: `npx @myceliumhq/tri <command>`. Needs `TRILIUM_URL` and
`TRILIUM_TOKEN` set (an ETAPI token from Trilium's Options -> ETAPI). Read
`skills/trilium/SKILL.md` first for the command reference and decision guidance instead of
discovering it via `--help` alone -- it also covers safety rules (never write without being
asked, never guess between multiple matches).

@README.md has what this package does and how end users configure it.
@CONTRIBUTING.md has full dev setup, the commit convention, and the release process — read it before committing or touching CI.

## Layout

- `src/cli/` — the `tri` CLI (primary interface): `index.ts` wires Commander subcommands from
  `commands/*.ts` onto `@myceliumhq/toolkit`'s `createProgram`/`runProgram`; `etapi.ts` maps ETAPI
  errors to this toolkit's exit-code contract (404→3, 401/403→4); `config.ts` resolves
  `TRILIUM_URL`/`TRILIUM_TOKEN` lazily so `--help` never requires them set.
- `src/agent-tool.ts` — the `AnyAgentTool` shape tool factories type their return value against
- `src/tools/` — one file per tool group (notes, tree, attributes, attachments, revisions, calendar, html)
- `src/tools/html.ts` — shared HTML<->plain-text conversion and bounded line-range reading, used by every content-reading/writing tool
- `src/client.ts` — typed Trilium ETAPI client
- `src/generated/trilium-schema.d.ts` — generated, do not hand-edit (see CONTRIBUTING.md)
- `src/semantic/` — `handle.ts` is a thin client of a deployed `tri-semanticd` sidecar (via
  `@myceliumhq/semanticd`'s `createSemanticdClient`), not a local embedding/index engine -- this
  package holds no vector store of its own. `source-adapter.ts` is the trilium-specific piece the
  sidecar actually syncs against (implements `@myceliumhq/index`'s `SourceAdapter`, consumed via
  `semantic-adapter.ts`/`semanticd-bin.ts`, not by `handle.ts`). `query.ts` strips Trilium's
  query-language operators out of a `search` string before sending the free-text remainder to the
  sidecar. Don't reintroduce a local sqlite-vec/embedding-provider implementation in `handle.ts` --
  running that logic twice (once here, once in the sidecar) is exactly the duplication
  `tri-semanticd` exists to eliminate.
- `src/mcp-server.ts` — standalone MCP server entrypoint on `@myceliumhq/mcp` (stdio/HTTP), configured
  via env vars (see README's "Standalone MCP server" section); `createAllTools` there is
  deliberately narrower than the full set implemented under `src/tools/` (see its own doc comment).
  `src/mcp-server-config.ts` holds the (tested) env-var parsing.
- `src/semanticd-bin.ts` — the `tri-semanticd` binary: passes `semantic-adapter.ts`'s
  `createAdapter()` straight into `@myceliumhq/semanticd`'s `runSemanticd()`. `Dockerfile.semanticd`
  builds a container image from it, published by `.github/workflows/docker-semanticd.yml` on every
  tagged release.
- `skills/` — agent skills bundled with the package
- `*.test.ts` — colocated with the source they test

## Working in this repo

- Run `pnpm run build`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run test` before committing.
  `build`'s `tsc` excludes test files from the compile; `typecheck` is the one that type-checks them.
- Commit messages **must** follow Conventional Commits — semantic-release derives the npm version
  and GitHub release from them on every push to `main`. A non-conventional message just won't ship.
- Never hand-edit `version` in `package.json` — semantic-release owns it.
- A brand-new package's first npm publish is a manual, one-time bootstrap step (see
  CONTRIBUTING.md) — don't try to "fix" a failing first release by adding more workflow logic.

## Things not to re-derive

- **Repo/image naming**: the upstream project was `TriliumNext/Notes` until mid-2025 (now archived
  on GitHub) and `triliumnext/notes` on Docker Hub. Active development moved to
  `TriliumNext/Trilium` (GitHub) / `triliumnext/trilium` (Docker Hub) — don't resurrect the old
  names from search results or older docs that predate the rename.
- **ETAPI has no pagination**: `/notes` search takes only `limit`, no page/offset.
  `src/semantic/source-adapter.ts`'s `listChanged` pages around this by re-querying with an
  advancing `utcDateModified >= <cursor>` filter — read its doc comment before changing that logic.
- **`blobId` is a free content hash**: every note in a search response already carries `blobId`, so
  it's used directly as `@myceliumhq/index`'s `contentHash` — an unchanged note's content never needs
  to be fetched during sync. Don't reintroduce a fetch-then-hash pattern (that's paperless-ngx's
  adapter, which has no equivalent field to use instead).
- **No batch note-fetch endpoint**: unlike paperless-ngx's `id__in`, ETAPI has nothing like
  "get many notes by id" — resolving a list of ids to names/titles is always N individual GETs.
  Keep those bounded (see `MAX_RESOLVE_NAMES` in `src/tools/notes.ts`).

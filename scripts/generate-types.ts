/**
 * Regenerates src/generated/trilium-schema.d.ts from TriliumNext/Trilium's
 * bundled ETAPI OpenAPI spec, pinned to a specific release tag.
 *
 * Note the repo name: the project was TriliumNext/Notes until mid-2025,
 * which is now archived on GitHub -- active development continues at
 * TriliumNext/Trilium (also a rename from `triliumnext/notes` to
 * `triliumnext/trilium` on Docker Hub). Don't resurrect the old repo/image
 * names from an older version of this comment or from search results that
 * predate the rename.
 *
 * Unlike paperless-ngx, a running Trilium server doesn't serve its own
 * ETAPI OpenAPI document over HTTP (checked against a live instance: no
 * /etapi/openapi.yaml, no schema route) -- the spec only exists as a
 * static asset in the server source tree
 * (apps/server/src/assets/etapi.openapi.yaml, unchanged by the monorepo
 * restructure that moved most other server code under packages/). Fetching
 * it from GitHub at a pinned tag keeps the generated types matched to a
 * specific, known-good Trilium version instead of whatever the default
 * branch happens to contain.
 *
 * Usage: pnpm run generate:types -- v0.104.1
 * (defaults to the version below if no tag is given)
 */
import { curlToFile, generateTypes } from "./openapi-codegen.js";

const DEFAULT_TAG = "v0.104.1";
const tag = process.argv[2] ?? DEFAULT_TAG;

const specUrl = `https://raw.githubusercontent.com/TriliumNext/Trilium/${tag}/apps/server/src/assets/etapi.openapi.yaml`;

generateTypes({
  outPath: "src/generated/trilium-schema.d.ts",
  fetchSchema: (tmpDir) => curlToFile(tmpDir, "etapi.openapi.yaml", ["-fsSL", specUrl]),
});

console.log(`(generated from tag ${tag})`);

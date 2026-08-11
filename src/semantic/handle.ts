import { createSemanticdClient } from "@myceliumhq/semanticd";
import { extractFreeTextTerms } from "./query.js";
import type { SemanticMatch } from "./types.js";

export type SemanticSearchPluginConfig = {
  enabled?: boolean;
  // Base URL of a semanticd sidecar (its own SEMANTICD_PORT, typically
  // reached at the sidecar's compose/container hostname) running
  // @myceliumhq/tri/semantic-adapter (e.g. the tri-semanticd binary/image
  // this package ships) against the same Trilium instance.
  semanticdUrl?: string;
};

export type Logger = {
  info?: (message: string) => void;
  warn: (message: string) => void;
  error?: (message: string) => void;
};

export type SemanticSearchHandle = {
  // False whenever semantic search isn't configured/reachable (disabled by
  // config, no semanticdUrl given, the sidecar unreachable, ...). `search`
  // still exists and is always safe to call -- it just always resolves to
  // `[]`, which is exactly the pre-existing stub behavior
  // trilium_search_notes already tolerates.
  available: boolean;
  search: (rawSearch: string | undefined, limit: number) => Promise<SemanticMatch[]>;
  dispose: () => Promise<void>;
};

function unavailableHandle(): SemanticSearchHandle {
  return {
    available: false,
    search: async () => [],
    dispose: async () => {},
  };
}

export type SemanticSearchHostDeps = {
  config: SemanticSearchPluginConfig | undefined;
  logger: Logger;
};

// Wires this host to a semanticd sidecar over HTTP -- never throws, always
// resolves to an unavailable handle if semantic search isn't configured,
// so a caller can fail open to lexical/attribute-only search.
export function createSemanticSearchCore(deps: SemanticSearchHostDeps): SemanticSearchHandle {
  if (deps.config?.enabled === false) {
    return unavailableHandle();
  }

  const semanticdUrl = deps.config?.semanticdUrl;
  if (!semanticdUrl) {
    deps.logger.warn(
      "semantic search: TRILIUM_SEMANTICD_URL not set, falling back to lexical/attribute-only search",
    );
    return unavailableHandle();
  }

  const client = createSemanticdClient(semanticdUrl);

  return {
    available: true,
    // Trilium mixes plain fulltext tokens and structured `#label`/
    // `~relation`/`note.property` operators in the same `search` string --
    // extractFreeTextTerms pulls the free-text portion back out before
    // querying semanticd (a pure structured-filter query has nothing to
    // embed, same no-op the sidecar's own search already applies to an
    // empty term).
    search: async (rawSearch, limit) => {
      const searchTerm = rawSearch ? extractFreeTextTerms(rawSearch) : "";
      if (!searchTerm) return [];
      try {
        const matches = await client.query(searchTerm, limit);
        return matches.map((match) => ({
          noteId: match.sourceId,
          snippet: match.snippet,
          score: match.score,
          startLine: match.startLine,
          endLine: match.endLine,
        }));
      } catch (err) {
        deps.logger.warn(
          `semantic search: query against semanticd failed, falling back to lexical/attribute-only search: ${describe(err)}`,
        );
        return [];
      }
    },
    dispose: async () => {},
  };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

import { createSemanticdClient } from "@myceliumhq/semanticd";
import {
  addSubcommand,
  type Command,
  parseBoundedInt,
  writeJsonLines,
  writeStderr,
  writeTable,
  writeTruncationNotice,
} from "@myceliumhq/toolkit";
import { unwrap } from "../../client.js";
import { extractFreeTextTerms } from "../../semantic/query.js";
import { resolveClientHandle } from "../config.js";
import { unwrapCli } from "../etapi.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;
const RRF_K = 60;

type Row = {
  noteId: string;
  title: string;
  type: string;
  url: string;
  content_snippet?: string;
  content_snippet_start_line?: number;
  content_snippet_end_line?: number;
  // Only set when semantic fusion actually ran. "semantic" (no lexical hit
  // at all) is the real no-match proxy an agent should key on -- semantic
  // similarity scores are NOT a calibrated confidence measure (live-tested:
  // a nonsense query and a genuinely relevant one can score within ~0.05 of
  // each other against the same index), so don't threshold on the score
  // itself, only on whether a lexical hit backs it up.
  match_source?: "lexical" | "semantic" | "both";
  semantic_score?: number;
};

// Fuses lexical rank order with semantic rank order via Reciprocal Rank
// Fusion -- same RRF_K and approach as the MCP server's
// trilium_search_notes (src/tools/notes.ts's mergeSemanticMatches), just
// working over plain noteId lists here instead of full shaped objects.
// Returns the final ordered noteId list, capped at `limit`; resolving an
// id (lexical or semantic-only) to a displayable row is the caller's job.
function fuseRankedIds(
  lexicalIds: string[],
  semanticIds: string[],
  limit: number,
): { ids: string[]; truncated: boolean } {
  const lexicalRank = new Map(lexicalIds.map((id, i) => [id, i + 1]));
  const semanticRank = new Map(semanticIds.map((id, i) => [id, i + 1]));
  const semanticOnly = semanticIds.filter((id) => !lexicalRank.has(id));
  const pool = [...lexicalIds, ...semanticOnly];

  const score = (id: string): number => {
    let s = 0;
    const lr = lexicalRank.get(id);
    const sr = semanticRank.get(id);
    if (lr !== undefined) s += 1 / (RRF_K + lr);
    if (sr !== undefined) s += 1 / (RRF_K + sr);
    return s;
  };

  const ids = pool
    .map((id, index) => ({ id, index, score: score(id) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((r) => r.id);

  return { ids, truncated: pool.length > limit };
}

export function registerSearch(program: Command): void {
  addSubcommand(program, "search <query...>")
    .summary(
      "Lexical/attribute search over notes, hybridized with semantic search when configured.",
    )
    .description(
      "Lexical/attribute search over Trilium's own query language -- free text, #label filters, " +
        "note.property comparisons. See Trilium's search syntax docs for the full grammar. When " +
        "TRILIUM_SEMANTICD_URL is set (a deployed tri-semanticd sidecar), results are fused with a " +
        "semantic search pass automatically -- no separate mode to pick, same as the MCP server's " +
        "trilium_search_notes. --json rows then include match_source (lexical/semantic/both); " +
        "semantic-only results with no lexical backing print a stderr warning (semantic similarity " +
        "scores are not a calibrated relevance measure).",
    )
    .option("--limit <n>", `Max results, capped at ${MAX_LIMIT}.`, String(DEFAULT_LIMIT))
    .option("--json", "Emit JSONL (one result per line) instead of a table.")
    .addHelpText("after", '\nExample: tri search "#book #year >= 1950"')
    .action(async (queryParts: string[], options: { limit: string; json?: boolean }) => {
      const query = queryParts.join(" ");
      const limit = parseBoundedInt(options.limit, { min: 1, max: MAX_LIMIT, flag: "--limit" });

      const semanticdUrl = process.env.TRILIUM_SEMANTICD_URL;
      // Only the free-text portion of `query` means anything to embed --
      // a pure structured-filter query (e.g. "#book #year >= 1950") has
      // nothing to fuse, so semantic search is skipped rather than
      // querying the sidecar with an empty term.
      const searchTerm = semanticdUrl ? extractFreeTextTerms(query) : "";
      const useSemantic = semanticdUrl !== undefined && searchTerm.length > 0;

      const { client, baseUrl } = resolveClientHandle();
      // Without semantic fusion, request one extra row so a result count
      // exactly equal to `limit` can be told apart from a truncated one.
      // With fusion, fetch exactly `limit` instead -- matching the MCP
      // tool's own approach -- since the fused candidate pool (lexical +
      // semantic-only) already gives a truncation signal of its own
      // (see fuseRankedIds); over-fetching lexical here would make that
      // check fire almost unconditionally.
      const etapiLimit = useSemantic ? limit : limit + 1;
      const result = await unwrapCli(
        client.GET("/notes", { params: { query: { search: query, limit: etapiLimit } } }),
      );

      const rowById = new Map<string, Row>();
      const lexicalIds: string[] = [];
      for (const note of result.results) {
        if (typeof note.noteId !== "string") continue;
        lexicalIds.push(note.noteId);
        rowById.set(note.noteId, {
          noteId: note.noteId,
          title: note.title ?? "",
          type: note.type ?? "",
          url: `${baseUrl}/#${note.noteId}`,
        });
      }

      let finalIds: string[];
      let truncated: boolean;
      // Populated only on a successful semantic pass -- used below to tag
      // each row's match_source/semantic_score, and to warn when every
      // result is semantic-only (see the no-lexical-hits check after rows
      // are built).
      let semanticIds: string[] = [];
      const semanticScoreById = new Map<string, number>();

      if (useSemantic) {
        try {
          const semanticClient = createSemanticdClient(semanticdUrl as string);
          const semanticMatches = await semanticClient.query(searchTerm, limit);

          for (const match of semanticMatches) {
            const noteId = String(match.sourceId);
            const row = rowById.get(noteId);
            if (row) {
              row.content_snippet = match.snippet;
              row.content_snippet_start_line = match.startLine;
              row.content_snippet_end_line = match.endLine;
            }
          }

          // Resolve any semantic-only id (found by meaning, absent from
          // the lexical batch) so it can be displayed -- ETAPI has no
          // batch "get many notes by id" endpoint, so this is N
          // individual GETs, bounded by how many semantic-only misses
          // there are. Fetched concurrently, no ordering dependency.
          semanticIds = semanticMatches.map((match) => String(match.sourceId));
          for (const match of semanticMatches) {
            semanticScoreById.set(String(match.sourceId), match.score);
          }
          const missingIds = semanticIds.filter((id) => !rowById.has(id));
          await Promise.all(
            missingIds.map(async (noteId) => {
              try {
                const note = unwrap(
                  await client.GET("/notes/{noteId}", { params: { path: { noteId } } }),
                );
                const match = semanticMatches.find((m) => String(m.sourceId) === noteId);
                rowById.set(noteId, {
                  noteId,
                  title: note.title ?? "",
                  type: note.type ?? "",
                  url: `${baseUrl}/#${noteId}`,
                  ...(match
                    ? {
                        content_snippet: match.snippet,
                        content_snippet_start_line: match.startLine,
                        content_snippet_end_line: match.endLine,
                      }
                    : {}),
                });
              } catch {
                // Deleted between the sidecar's last sync and this search
                // -- skip rather than fail the whole search over one
                // stale vector-index entry.
              }
            }),
          );

          const fused = fuseRankedIds(lexicalIds, semanticIds, limit);
          finalIds = fused.ids;
          truncated = fused.truncated;
        } catch {
          // Sidecar unreachable/erroring -- fail open to lexical-only,
          // same as the MCP server's own handle.search() contract.
          // Truncation is unknown at this point (only `limit` lexical
          // rows were fetched, not limit+1), so this conservatively
          // reports "not truncated" rather than guessing.
          finalIds = lexicalIds.slice(0, limit);
          truncated = false;
        }
      } else {
        truncated = lexicalIds.length > limit;
        finalIds = lexicalIds.slice(0, limit);
      }

      const lexicalIdSet = new Set(lexicalIds);
      const semanticIdSet = new Set(semanticIds);
      const rows = finalIds
        .map((id) => rowById.get(id))
        .filter((row): row is Row => row !== undefined)
        .map((row) => {
          if (!useSemantic) return row;
          const inLexical = lexicalIdSet.has(row.noteId);
          const inSemantic = semanticIdSet.has(row.noteId);
          return {
            ...row,
            match_source: inLexical && inSemantic ? "both" : inLexical ? "lexical" : "semantic",
            ...(semanticScoreById.has(row.noteId)
              ? { semantic_score: semanticScoreById.get(row.noteId) }
              : {}),
          } as Row;
        });

      // The real no-match signal: fusion still returns nearest-neighbor
      // semantic hits for nonsense queries (cosine similarity has no
      // reliable "nothing matches" floor -- verified against the live
      // index), so zero lexical hits is what actually means "this query
      // found nothing," not an empty result list.
      if (useSemantic && lexicalIds.length === 0 && rows.length > 0) {
        const bestScore = Math.max(...rows.map((r) => r.semantic_score ?? 0));
        writeStderr(
          `# no lexical matches for this query -- ${rows.length} semantic-only result(s) shown ` +
            `(best score ${bestScore.toFixed(3)}). Semantic similarity is not a calibrated ` +
            "relevance score; verify these are actually relevant before relying on them.",
        );
      }

      if (options.json) {
        writeJsonLines(rows);
      } else {
        writeTable(rows, [
          { header: "ID", value: (r) => r.noteId, maxWidth: 22 },
          { header: "TYPE", value: (r) => r.type, maxWidth: 8 },
          { header: "TITLE", value: (r) => r.title, maxWidth: 60 },
        ]);
      }

      if (truncated) {
        writeTruncationNotice({ shown: rows.length, limitFlag: "--limit" });
      }
    });
}

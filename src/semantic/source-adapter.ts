import { DEFAULT_SEMANTIC_INDEX_CONFIG, type SourceAdapter } from "@myceliumhq/index";
import type { TriliumClient } from "../client.js";
import { unwrap } from "../client.js";
import { htmlToMarkdown, normalizeLineEndings } from "../tools/html.js";
import { INDEXABLE_TYPES_FILTER } from "./query.js";

// One ETAPI page's `limit` -- matches @myceliumhq/index's own default
// maxItemsPerSync, so a normal sync pass fits in a single request; the
// paging loop below only kicks in for a larger first backfill or if a host
// raises maxItemsPerSync past this.
const PAGE_SIZE = DEFAULT_SEMANTIC_INDEX_CONFIG.maxItemsPerSync;

type NoteRow = { noteId: string; type: string; blobId: string; utcDateModified: string };

// The single trilium-specific piece bridging its ETAPI to @myceliumhq/index's
// generic SourceAdapter contract. Trilium's /notes search has no
// offset/cursor param, only a flat `limit` -- so this pages by re-querying
// with an advancing `note.utcDateModified >= <cursor>` filter instead (`>=`
// not `>`, same reason as the watermark itself: Trilium can stamp the same
// utcDateModified on multiple notes touched by one bulk edit, and there's
// no secondary sort key to break that tie deterministically -- re-seeing a
// boundary note is harmless, since @myceliumhq/index's own contentHash
// short-circuit makes it a no-op). Stops once a page comes back smaller
// than PAGE_SIZE (genuinely caught up) or the cursor fails to advance
// (every remaining note is tied at the exact same instant -- no further
// query can make progress).
//
// Trilium's search response already carries `blobId`, a real content hash,
// for free -- so unlike paperless-ngx's adapter, this never needs to fetch
// a note's content just to detect that it hasn't changed. `type` (needed by
// fetchContent to know whether a note is CKEditor HTML or raw source) isn't
// part of @myceliumhq/index's SourceAdapter contract, so it's cached here the
// same way paperless-ngx's adapter caches content -- populated per note in
// listChanged, consumed and cleared in fetchContent.
export function createTriliumSourceAdapter(
  clientPromise: Promise<TriliumClient>,
): SourceAdapter<string> {
  const typeCache = new Map<string, string>();

  return {
    name: "trilium",
    async *listChanged(since) {
      const client = await clientPromise;
      let cursor = since;

      while (true) {
        // Cursor condition goes first, INDEXABLE_TYPES_FILTER parenthesized
        // and second -- see that constant's own comment: a query starting
        // with `(` silently matches nothing against Trilium's ETAPI search.
        const search = cursor
          ? `note.utcDateModified >= "${cursor}" AND (${INDEXABLE_TYPES_FILTER})`
          : INDEXABLE_TYPES_FILTER;
        const result = unwrap(
          await client.GET("/notes", {
            params: {
              query: {
                search,
                orderBy: "utcDateModified",
                orderDirection: "asc",
                limit: PAGE_SIZE,
              },
            },
          }),
        );

        const rows: NoteRow[] = result.results
          .filter(
            (
              note,
            ): note is typeof note & { noteId: string; blobId: string; utcDateModified: string } =>
              typeof note.noteId === "string" &&
              typeof note.blobId === "string" &&
              typeof note.utcDateModified === "string",
          )
          .map((note) => ({
            noteId: note.noteId,
            type: note.type ?? "text",
            blobId: note.blobId,
            utcDateModified: note.utcDateModified,
          }));
        if (rows.length === 0) return;

        for (const row of rows) {
          typeCache.set(row.noteId, row.type);
          yield { id: row.noteId, contentHash: row.blobId, modifiedAt: row.utcDateModified };
        }

        const newest = rows.at(-1)?.utcDateModified;
        if (rows.length < PAGE_SIZE || newest === cursor) return;
        cursor = newest;
      }
    },
    async fetchContent(id) {
      const client = await clientPromise;
      // unwrap() returns undefined for a successful-but-empty body (e.g. an
      // organizer note with no text of its own) -- see client.ts's own
      // comment. Coerced to "" since this is always a string in practice.
      const rawContent =
        unwrap(
          await client.GET("/notes/{noteId}/content", {
            params: { path: { noteId: id } },
            // openapi-fetch defaults to JSON.parse regardless of the real
            // (always text/html) Content-Type here -- see src/tools/notes.ts's
            // identical override.
            parseAs: "text",
          }),
        ) ?? "";
      const type = typeCache.get(id) ?? "text";
      typeCache.delete(id);
      // Only `text` notes are CKEditor HTML; `code` notes (also indexed,
      // see INDEXABLE_TYPES_FILTER) are raw source and are embedded as-is.
      const embedSource = type === "text" ? htmlToMarkdown(rawContent) : rawContent;
      return normalizeLineEndings(embedSource);
    },
  };
}

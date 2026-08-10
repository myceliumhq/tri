import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { TriliumClient, TriliumClientHandle } from "../client.js";
import { noteUrl, toToolResult, unwrap } from "../client.js";
import type { SemanticSearchHandle } from "../semantic/handle.js";
import type { SemanticMatch } from "../semantic/types.js";
import {
  applyTextEdits,
  contentStatusFor,
  extractSnippet,
  formatContentForWrite,
  htmlToMarkdown,
  normalizeLineEndings,
  readRange,
} from "./html.js";

const MAX_SEARCH_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 20;

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(limit ?? fallback, 1), MAX_SEARCH_LIMIT);
}

// -- Semantic search integration seam --
//
// Mirrors @transmitt0r/openclaw-plugin-paperless-ngx's src/tools/documents.ts
// seam comment: a plugin-owned semantic/embeddings index lives in
// src/semantic/, populated and queried over Trilium's own ETAPI content
// (note content leaves the machine to be embedded -- see the README).
// trilium_search_notes is hybrid (Trilium's own lexical+attribute search,
// plus this semantic layer) internally; the choice of strategy is never
// exposed as a param or separate tool, for the same reason paperless-ngx
// gives: a tool-calling model doesn't reliably pick the better option even
// when told to, so folding it into the one `search` behavior the model
// already knows sidesteps that failure mode entirely.
async function fetchSemanticMatches(
  handlePromise: Promise<SemanticSearchHandle>,
  rawSearch: string | undefined,
  limit: number,
): Promise<SemanticMatch[]> {
  try {
    const handle = await handlePromise;
    return await handle.search(rawSearch, limit);
  } catch {
    return [];
  }
}

const RRF_K = 60;

type ShapedNote = Record<string, unknown> & { noteId?: unknown };

function withSemanticSnippet(note: ShapedNote, match: SemanticMatch): ShapedNote {
  return {
    ...note,
    content_snippet: match.snippet,
    content_snippet_start_line: match.startLine,
    content_snippet_end_line: match.endLine,
  };
}

// Fuses Trilium's own lexical/attribute-search ranking with the semantic
// layer's ranking via Reciprocal Rank Fusion -- same approach and RRF_K as
// paperless-ngx's mergeSemanticMatches, for the same reason: the two
// scores live on incomparable scales (Trilium exposes no relevance score
// at all via ETAPI, only result order; the semantic side is a cosine
// similarity), so RRF only needs rank position from each side. A
// semantic-only match (found by meaning, absent from Trilium's own
// results) is fetched individually -- ETAPI has no batch "get many notes
// by id" endpoint the way paperless-ngx's `id__in` does, so this is N
// individual GETs, bounded by how many semantic-only misses there are
// (typically small relative to `limit`).
async function mergeSemanticMatches(
  client: TriliumClient,
  baseUrl: string,
  notes: ShapedNote[],
  semanticMatches: SemanticMatch[],
  limit: number,
): Promise<{ notes: ShapedNote[]; truncated: boolean }> {
  if (semanticMatches.length === 0) {
    // No candidate pool to fuse -- but if the lexical fetch alone already
    // hit the cap, there may be more matches beyond it that were never
    // returned (Trilium's /notes has no total-count field to check against).
    return { notes, truncated: notes.length >= limit };
  }

  const lexicalRankById = new Map<string, number>();
  for (const [index, note] of notes.entries()) {
    if (typeof note.noteId === "string") lexicalRankById.set(note.noteId, index + 1);
  }
  const semanticById = new Map(semanticMatches.map((match) => [match.noteId, match]));
  const semanticRankById = new Map<string, number>();
  for (const [index, match] of semanticMatches.entries()) {
    semanticRankById.set(match.noteId, index + 1);
  }

  const missingIds = semanticMatches
    .map((match) => match.noteId)
    .filter((id) => !lexicalRankById.has(id));

  // Fetched concurrently (like resolveLinkedNoteNames' identical per-id
  // fan-out), not one at a time -- there's no ordering dependency between
  // these fetches, so a sequential loop only added latency proportional to
  // how many semantic-only misses there were.
  const semanticOnlyResults = await Promise.all(
    missingIds.map(async (noteId) => {
      try {
        const rawNote = unwrap(
          await client.GET("/notes/{noteId}", { params: { path: { noteId } } }),
        );
        // Shaped the same way as every lexical hit -- otherwise a
        // semantic-only match leaks the full raw note (attributes, blobId,
        // isProtected, branch ids) while every other result in the same
        // response has already been trimmed down.
        const note = shapeNoteForSearch(baseUrl, rawNote as Record<string, unknown>);
        const match = semanticById.get(noteId);
        return match ? withSemanticSnippet(note, match) : note;
      } catch {
        // The note may have been deleted between the semantic index's last
        // sync pass and this search -- skip it rather than fail the whole
        // search over one stale vector-index entry.
        return undefined;
      }
    }),
  );
  const semanticOnlyNotes = semanticOnlyResults.filter(
    (note): note is ShapedNote => note !== undefined,
  );

  const upgradedLexical = notes.map((note) => {
    const match = typeof note.noteId === "string" ? semanticById.get(note.noteId) : undefined;
    return match ? withSemanticSnippet(note, match) : note;
  });

  const rrfScore = (id: string | undefined): number => {
    if (id === undefined) return 0;
    const lexicalRank = lexicalRankById.get(id);
    const semanticRank = semanticRankById.get(id);
    let score = 0;
    if (lexicalRank !== undefined) score += 1 / (RRF_K + lexicalRank);
    if (semanticRank !== undefined) score += 1 / (RRF_K + semanticRank);
    return score;
  };

  const candidatePool = [...upgradedLexical, ...semanticOnlyNotes];
  const merged = candidatePool
    .map((note, index) => ({
      note,
      index,
      score: rrfScore(typeof note.noteId === "string" ? note.noteId : undefined),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(({ note }) => ({
      ...note,
      // Guarded the same way every other noteId access in this function is
      // (ETAPI schema types Note.noteId as optional) -- a note without one
      // just doesn't get a `url` rather than masking a possible `undefined`
      // behind a cast.
      ...(typeof note.noteId === "string" ? { url: noteUrl(baseUrl, note.noteId) } : {}),
    }));

  // candidatePool can exceed `limit` before the slice above (more fused
  // candidates than fit) even when neither side's raw fetch count did --
  // that's a real truncation the caller has no other way to detect.
  return { notes: merged, truncated: candidatePool.length > limit };
}

// Trilium's search response carries no match excerpt or relevance score
// of its own (unlike paperless-ngx's, which includes OCR content that a
// content_snippet can be sliced from) -- a lexical/attribute-only hit
// therefore has no content_snippet at all here. Only a result the
// semantic layer also matched gets one, from the matched chunk's text
// (see withSemanticSnippet below) -- there's no cheap way to produce an
// excerpt for a purely lexical match without an extra content fetch per
// result on every search call.
type FlattenedAttributes = {
  labels?: string[];
  relations?: { name: string; value: string; attribute_id: string }[];
};

// Shared by shapeNoteForSearch and createGetNoteTool -- a note's raw
// `attributes` array mixes labels and relations together with 8 raw ETAPI
// fields per entry (attributeId/noteId/type/name/value/position/
// isInheritable/utcDateModified), most of which a tool-calling model never
// needs. Labels flatten to a compact "name=value" string (matching what
// trilium_create_attribute's own description already promises exists);
// relations keep their attribute_id since that's required to call
// trilium_update_attribute/trilium_delete_attribute on them.
function flattenAttributes(attributes: unknown): FlattenedAttributes {
  if (!Array.isArray(attributes)) return {};
  const attrs = attributes as Record<string, unknown>[];
  const labels = attrs
    .filter((a) => a.type === "label")
    .map((a) => (a.value ? `${a.name}=${a.value}` : `${a.name}`));
  const relations = attrs
    .filter((a) => a.type === "relation")
    .map((a) => ({
      name: a.name as string,
      value: a.value as string,
      attribute_id: a.attributeId as string,
    }));
  return {
    ...(labels.length > 0 ? { labels } : {}),
    ...(relations.length > 0 ? { relations } : {}),
  };
}

// Strips fields with no agent value on top of attributes/branch ids:
// blobId (an internal content hash, never actionable by a tool-calling
// model), isProtected, bare parentNoteIds/childNoteIds (ids with no titles,
// low value at search time), and utcDateCreated/utcDateModified (the same
// two instants dateCreated/dateModified already encode, offset included).
function shapeNoteForSearch(baseUrl: string, note: Record<string, unknown>): ShapedNote {
  const {
    attributes,
    parentBranchIds,
    childBranchIds,
    parentNoteIds,
    childNoteIds,
    blobId,
    isProtected,
    utcDateCreated,
    utcDateModified,
    ...rest
  } = note;
  return {
    ...rest,
    url: typeof note.noteId === "string" ? noteUrl(baseUrl, note.noteId) : undefined,
    ...flattenAttributes(attributes),
  };
}

const searchNotesParams = Type.Object({
  search: Type.String({
    description:
      "Trilium's own query language: free-text tokens and/or structured filters in one string -- " +
      '#labelName / #labelName="value" for labels, ~relationName for relations, note.propertyName ' +
      "for system properties (type, isArchived, dateCreated, ...), AND/OR/NOT with parentheses, " +
      "quoted phrases for exact match, comparison operators (=, !=, *=* contains, =* starts-with, " +
      "*= ends-with, >=/<=/>/<, %= regex). Examples: 'project plan', '\"exact phrase\"', " +
      "'towers #book', '#year >= 1950 AND #year < 1960'. Also understands meaning, not just these " +
      "keywords -- hybridized with a semantic layer automatically, no separate mode to pick.",
  }),
  ancestor_note_id: Type.Optional(
    Type.String({
      description: "Scope the search to this note's subtree. Omit to search the whole vault.",
    }),
  ),
  ancestor_depth: Type.Optional(
    Type.String({
      description:
        "Depth constraint relative to ancestor_note_id (or root): 'eq1' exactly 1 (direct children), " +
        "'lt4' less than 4, 'gt2' greater than 2, etc.",
    }),
  ),
  include_archived_notes: Type.Optional(
    Type.Boolean({ description: "Include archived notes in results. Defaults to false." }),
  ),
  order_by: Type.Optional(
    Type.String({
      description:
        "Property or label to sort by, e.g. 'title', '#publicationDate', 'dateModified', 'contentSize'.",
    }),
  ),
  order_direction: Type.Optional(
    Type.Union([Type.Literal("asc"), Type.Literal("desc")], { description: "Defaults to 'asc'." }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description: `Max results, capped at ${MAX_SEARCH_LIMIT}. Defaults to ${DEFAULT_SEARCH_LIMIT}.`,
    }),
  ),
});

export function createSearchNotesTool(
  handlePromise: Promise<TriliumClientHandle>,
  semanticHandlePromise: Promise<SemanticSearchHandle>,
): AnyAgentTool {
  return {
    name: "trilium_search_notes",
    label: "Search Trilium notes",
    description:
      "Search or filter notes. Never returns full note content, and results generally carry no " +
      "excerpt either -- Trilium's own search API doesn't expose one. The exception: when the " +
      "semantic layer also matched a result (see below), it gets a content_snippet plus " +
      "content_snippet_start_line/end_line you can pass straight to trilium_read_note_content. " +
      "Otherwise, read a result's content directly with trilium_read_note_content(noteId) to see why " +
      "it matched. Each result includes a `url` to open it directly in the Trilium web UI, `labels` " +
      "(a flat list of the note's own label attributes), and `relations` (typed links to other notes, " +
      "each as {name, value: target noteId, attribute_id} -- pass attribute_id to " +
      "trilium_update_attribute/trilium_delete_attribute to act on one). Results are capped at " +
      `${MAX_SEARCH_LIMIT}; a \`truncated: true\` in the response means more matches likely exist ` +
      "than were returned -- narrow the search (e.g. via ancestor_note_id) rather than assuming " +
      "you've seen everything.",
    parameters: searchNotesParams,
    execute: async (_toolCallId, params: Static<typeof searchNotesParams>) => {
      const { client, baseUrl } = await handlePromise;
      const limit = clampLimit(params.limit, DEFAULT_SEARCH_LIMIT);

      // Neither fetch depends on the other's output (only the merge step
      // below consumes both), so they run concurrently instead of paying
      // both round trips end to end -- same reasoning as createGetNoteTool's
      // Promise.all further down in this file.
      const [result, semanticMatches] = await Promise.all([
        client
          .GET("/notes", {
            params: {
              query: {
                search: params.search,
                ancestorNoteId: params.ancestor_note_id,
                ancestorDepth: params.ancestor_depth,
                includeArchivedNotes: params.include_archived_notes,
                orderBy: params.order_by,
                orderDirection: params.order_direction,
                limit,
              },
            },
          })
          .then(unwrap),
        fetchSemanticMatches(semanticHandlePromise, params.search, limit),
      ]);

      const shaped = result.results.map((note) =>
        shapeNoteForSearch(baseUrl, note as Record<string, unknown>),
      );

      const { notes: merged, truncated } = await mergeSemanticMatches(
        client,
        baseUrl,
        shaped,
        semanticMatches,
        limit,
      );

      return toToolResult({
        results: merged,
        count: merged.length,
        ...(truncated ? { truncated: true } : {}),
      });
    },
  };
}

const MAX_RESOLVE_NAMES = 50;

// `maxCount` is a caller-supplied slice of a *shared* budget (see
// createGetNoteTool below) rather than a hardcoded per-call constant --
// resolve_names' own doc comment promises a single combined cap across
// parents and children, and this used to apply MAX_RESOLVE_NAMES to each
// side independently, silently allowing up to 100 total resolutions.
async function resolveLinkedNoteNames(
  client: TriliumClient,
  noteIds: string[],
  branchIds: string[],
  maxCount: number,
): Promise<{
  names: { noteId: string; branchId?: string; title: string; type: string }[];
  truncated: boolean;
}> {
  const truncated = noteIds.length > maxCount;
  const idsToResolve = noteIds.slice(0, maxCount);
  const names = await Promise.all(
    idsToResolve.map(async (noteId, i) => {
      try {
        const note = unwrap(await client.GET("/notes/{noteId}", { params: { path: { noteId } } }));
        return { noteId, branchId: branchIds[i], title: note.title ?? "", type: note.type ?? "" };
      } catch {
        return { noteId, branchId: branchIds[i], title: "(unavailable)", type: "" };
      }
    }),
  );
  return { names, truncated };
}

const getNoteParams = Type.Object({
  note_id: Type.String({ description: "Note id." }),
  resolve_names: Type.Optional(
    Type.Boolean({
      description:
        `Resolve parentNoteIds/childNoteIds to {noteId, branchId, title, type} instead of bare ids, ` +
        `so tree navigation doesn't need a follow-up call per id. Capped at ${MAX_RESOLVE_NAMES} ids ` +
        "total (parents + children combined); beyond that, only the first are resolved and " +
        "`names_truncated: true` is set. Defaults to true.",
    }),
  ),
  include_attachments: Type.Optional(
    Type.Boolean({
      description: "Include this note's attachments (metadata only). Defaults to false.",
    }),
  ),
  include_revisions: Type.Optional(
    Type.Boolean({
      description:
        "Include this note's revision history (metadata only, not content). Defaults to false.",
    }),
  ),
  excerpt_search: Type.Optional(
    Type.String({
      description:
        "If given, include a short content_snippet around the first place this term appears in " +
        "the note's content -- the same kind of excerpt trilium_search_notes returns for a semantic " +
        "match, scoped to one note you already know the id of. Never returns the full note; use " +
        "trilium_read_note_content for that.",
    }),
  ),
});

export function createGetNoteTool(handlePromise: Promise<TriliumClientHandle>): AnyAgentTool {
  return {
    name: "trilium_get_note",
    label: "Get a Trilium note",
    description:
      "Fetch a single note's metadata by id -- title, type, tree placement, and its raw `attributes` " +
      "array alongside flattened `labels` (string list) and `relations` ({name, value: target " +
      "noteId, attribute_id}) for convenience. Never returns full content; pass excerpt_search for a " +
      "short content_snippet around one term, or use trilium_read_note_content for the full thing. " +
      "By default also resolves parent/child note ids to titles (see resolve_names) so browsing the " +
      "tree rarely needs more than one follow-up call.",
    parameters: getNoteParams,
    execute: async (_toolCallId, params: Static<typeof getNoteParams>) => {
      const { client, baseUrl } = await handlePromise;
      const note = unwrap(
        await client.GET("/notes/{noteId}", { params: { path: { noteId: params.note_id } } }),
      );

      const wantsNames = params.resolve_names ?? true;
      const parentIds = note.parentNoteIds ?? [];
      const childIds = note.childNoteIds ?? [];
      // Shares one MAX_RESOLVE_NAMES-sized budget across parents+children
      // (parents get first claim on it, children get whatever's left) --
      // see resolveLinkedNoteNames's own comment for why this replaced two
      // independent 50-id caps.
      const parentBudget = Math.min(parentIds.length, MAX_RESOLVE_NAMES);
      const childBudget = Math.max(0, MAX_RESOLVE_NAMES - parentBudget);

      // None of these five fetches depends on any other's result, so they
      // run concurrently instead of paying the sum of all five latencies
      // sequentially when a caller asks for several of these in one call.
      const [parents, children, attachments, revisions, rawContent] = await Promise.all([
        wantsNames
          ? resolveLinkedNoteNames(client, parentIds, note.parentBranchIds ?? [], parentBudget)
          : Promise.resolve(undefined),
        wantsNames
          ? resolveLinkedNoteNames(client, childIds, note.childBranchIds ?? [], childBudget)
          : Promise.resolve(undefined),
        params.include_attachments
          ? client
              .GET("/notes/{noteId}/attachments", { params: { path: { noteId: params.note_id } } })
              .then(unwrap)
          : Promise.resolve(undefined),
        params.include_revisions
          ? client
              .GET("/notes/{noteId}/revisions", { params: { path: { noteId: params.note_id } } })
              .then(unwrap)
          : Promise.resolve(undefined),
        params.excerpt_search !== undefined
          ? client
              .GET("/notes/{noteId}/content", {
                params: { path: { noteId: params.note_id } },
                parseAs: "text",
              })
              // unwrap() returns undefined for a successful-but-empty body,
              // same as "not requested" below (Promise.resolve(undefined))
              // -- coerce to "" so `rawContent !== undefined` still means
              // "excerpt_search was requested" rather than conflating the
              // two.
              .then((r) => unwrap(r) ?? "")
          : Promise.resolve(undefined),
      ]);

      const result: Record<string, unknown> = {
        ...note,
        url: noteUrl(baseUrl, params.note_id),
        ...flattenAttributes(note.attributes),
      };
      if (parents && children) {
        result.parents = parents.names;
        result.children = children.names;
        if (parents.truncated || children.truncated) result.names_truncated = true;
        // Each resolved parent/child entry already carries its own noteId,
        // so the raw id arrays are now 100% redundant with parents/children
        // -- drop them rather than encoding the same tree edges twice.
        delete result.parentNoteIds;
        delete result.childNoteIds;
        delete result.parentBranchIds;
        delete result.childBranchIds;
      }
      if (attachments) result.attachments = attachments;
      if (revisions) result.revisions = revisions;
      if (rawContent !== undefined) {
        // `note` (already fetched above) tells us the real type -- no
        // content sniffing needed. Only `text` notes are CKEditor HTML;
        // anything else (e.g. `code`) is raw source, left untouched.
        const excerptSource = note.type === "text" ? htmlToMarkdown(rawContent) : rawContent;
        result.content_snippet = extractSnippet(
          normalizeLineEndings(excerptSource),
          params.excerpt_search,
        );
      }

      return toToolResult(result);
    },
  };
}

const readNoteContentParams = Type.Object({
  note_id: Type.String({ description: "Note id." }),
  start_line: Type.Optional(
    Type.Integer({ description: "1-indexed starting line (inclusive). Defaults to 1." }),
  ),
  end_line: Type.Optional(
    Type.Integer({
      description:
        "1-indexed ending line (inclusive). Defaults to start_line + 199, capped at 500 lines per call.",
    }),
  ),
  raw_html: Type.Optional(
    Type.Boolean({
      description:
        "Return the note's stored CKEditor HTML as-is instead of converting it to Markdown. " +
        "Defaults to false -- Markdown is this plugin's normal content contract (see " +
        "trilium_update_note), so the converted form is what you'll usually want to read, edit, and " +
        "write straight back. Has no effect on notes whose content isn't HTML (e.g. `code` notes) -- " +
        "those are always returned as-is.",
    }),
  ),
});

export function createReadNoteContentTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_read_note_content",
    label: "Read a Trilium note's content",
    description:
      "Read a note's content, bounded to a line range. Call with no start_line/end_line for the " +
      "first 200 lines, or pass a range to jump to a specific section (e.g. one located via " +
      "content_snippet_start_line/end_line from trilium_search_notes). Capped at 500 lines per call " +
      "regardless of what's requested. `total_lines` in the response tells you whether there's more: " +
      "if end_line < total_lines, call again with start_line: end_line + 1. `text`-type note content " +
      "(CKEditor HTML) is converted to Markdown by default -- pass raw_html: true for the original " +
      "markup. `content_status` is 'empty' for a note with no content yet, 'present' otherwise.",
    parameters: readNoteContentParams,
    execute: async (_toolCallId, params: Static<typeof readNoteContentParams>) => {
      const { client } = await handlePromise;
      // Neither fetch depends on the other's output, so they run
      // concurrently -- the note metadata is what tells us whether this is
      // really a `text` note (CKEditor HTML) worth converting, rather than
      // sniffing the content itself the way this used to work.
      const [rawContent, note] = await Promise.all([
        client
          .GET("/notes/{noteId}/content", {
            params: { path: { noteId: params.note_id } },
            // openapi-fetch defaults every response to JSON.parse
            // regardless of the actual Content-Type header -- this
            // endpoint always returns text/html, never JSON, so parseAs
            // must be overridden explicitly or a real HTML response
            // throws a JSON parse error.
            parseAs: "text",
          })
          // unwrap() returns undefined for a successful-but-empty body --
          // see client.ts's own comment. Coerced to "" for the
          // content_status: "empty" case documented above.
          .then((r) => unwrap(r) ?? ""),
        client
          .GET("/notes/{noteId}", { params: { path: { noteId: params.note_id } } })
          .then(unwrap),
      ]);
      const wantsMarkdown = !(params.raw_html ?? false) && note.type === "text";
      const content = normalizeLineEndings(wantsMarkdown ? htmlToMarkdown(rawContent) : rawContent);
      const range = readRange(
        "trilium_read_note_content",
        content,
        params.start_line,
        params.end_line,
      );
      return toToolResult({
        note_id: params.note_id,
        ...range,
        content_status: contentStatusFor(content),
      });
    },
  };
}

const createNoteParams = Type.Object({
  parent_note_id: Type.String({ description: "Note id of the parent note in the tree." }),
  title: Type.String({ description: "Note title." }),
  type: Type.Union(
    [
      Type.Literal("text"),
      Type.Literal("code"),
      Type.Literal("file"),
      Type.Literal("image"),
      Type.Literal("search"),
      Type.Literal("book"),
      Type.Literal("relationMap"),
      Type.Literal("render"),
    ],
    { description: "Note type. 'text' is the common case for prose notes." },
  ),
  mime: Type.Optional(
    Type.String({
      description: "Required only for 'code'/'file'/'image' types, e.g. 'application/json'.",
    }),
  ),
  content: Type.Optional(
    Type.String({
      description:
        "Initial content. For 'text' notes, write Markdown (headings, bold, lists, links) -- it's " +
        "always converted to Trilium's native HTML for you, there is no way to write raw HTML " +
        "verbatim. Written byte-for-byte for every other type (e.g. 'code' notes: raw source).",
    }),
  ),
  note_position: Type.Optional(
    Type.Integer({
      description:
        "Position among siblings. Normal ordering is 10, 20, 30, ... -- use e.g. 5 for first.",
    }),
  ),
  prefix: Type.Optional(
    Type.String({ description: "Branch-specific title prefix, shown only in this tree location." }),
  ),
});

export function createCreateNoteTool(handlePromise: Promise<TriliumClientHandle>): AnyAgentTool {
  return {
    name: "trilium_create_note",
    label: "Create a Trilium note",
    description:
      "Create a note and place it in the tree under parent_note_id. Returns the created note and the " +
      "branch (tree placement) that resulted. Use trilium_create_attribute afterward to add labels/" +
      "relations, and trilium_place_note_in_tree to also clone it elsewhere.",
    parameters: createNoteParams,
    execute: async (_toolCallId, params: Static<typeof createNoteParams>) => {
      const { client, baseUrl } = await handlePromise;
      const result = unwrap(
        await client.POST("/create-note", {
          body: {
            parentNoteId: params.parent_note_id,
            title: params.title,
            type: params.type,
            mime: params.mime,
            content: params.content ? formatContentForWrite(params.content, params.type) : "",
            notePosition: params.note_position,
            prefix: params.prefix,
          },
        }),
      );
      return toToolResult({
        note: {
          ...result.note,
          url: result.note?.noteId ? noteUrl(baseUrl, result.note.noteId) : undefined,
        },
        branch: result.branch,
      });
    },
  };
}

const updateNoteParams = Type.Object({
  note_id: Type.String({ description: "Note id to update." }),
  title: Type.Optional(Type.String({ description: "New title." })),
  type: Type.Optional(
    Type.Union(
      [
        Type.Literal("text"),
        Type.Literal("code"),
        Type.Literal("file"),
        Type.Literal("image"),
        Type.Literal("search"),
        Type.Literal("book"),
        Type.Literal("relationMap"),
        Type.Literal("render"),
        Type.Literal("noteMap"),
        Type.Literal("mermaid"),
        Type.Literal("webView"),
        Type.Literal("shortcut"),
        Type.Literal("doc"),
        Type.Literal("contentWidget"),
        Type.Literal("launcher"),
      ],
      {
        description:
          "New note type. Rarely needed -- only change this if you know what you're doing.",
      },
    ),
  ),
  mime: Type.Optional(Type.String({ description: "New MIME type." })),
  content: Type.Optional(
    Type.String({
      description:
        "Content to write when content_mode is 'replace' or 'append' (default 'replace'). For a " +
        "'text' note, write Markdown -- always converted to Trilium's native HTML, there is no way " +
        "to write raw HTML verbatim. Written byte-for-byte for every other type. Ignored when " +
        "content_mode is 'edit' (use `edits` instead).",
    }),
  ),
  content_mode: Type.Optional(
    Type.Union([Type.Literal("replace"), Type.Literal("append"), Type.Literal("edit")], {
      description:
        "'replace' (default) overwrites the note's content entirely using `content`. 'append' adds " +
        "`content` to the end of the existing content, entirely server-side -- the existing body " +
        "never has to pass through your context first. 'edit' applies targeted find-and-replace " +
        "edits from `edits` instead -- far cheaper than 'replace' for a small change to a large " +
        "note, since the unchanged content never has to pass through your context either way. Not " +
        "supported for 'text' notes (their content is CKEditor HTML, not raw source -- a literal " +
        "find/replace risks altering unrelated formatting elsewhere in the note); use 'replace' or " +
        "'append' for those instead.",
    }),
  ),
  edits: Type.Optional(
    Type.Array(
      Type.Object({
        old_text: Type.String({
          description:
            "Exact text to find and replace. Must occur exactly once in the note's content -- " +
            "include enough surrounding context that it uniquely identifies one location.",
        }),
        new_text: Type.String({ description: "Replacement text." }),
      }),
      {
        description:
          "One or more find-and-replace edits, applied in order (so a later edit may target text an " +
          "earlier one introduced). Only used when content_mode is 'edit'.",
      },
    ),
  ),
});

export function createUpdateNoteTool(handlePromise: Promise<TriliumClientHandle>): AnyAgentTool {
  return {
    name: "trilium_update_note",
    label: "Update a Trilium note",
    description:
      "Update a note's title/type/mime and/or its content in one call. For a 'text' note, write " +
      "`content` as Markdown -- always converted to Trilium's native HTML, there is no way to write " +
      "raw HTML verbatim. content_mode defaults to 'replace' (the whole body is overwritten -- read " +
      "the note first with trilium_read_note_content if you need to preserve part of it and aren't " +
      "just appending); pass content_mode: 'append' to add `content` to the end of the existing body " +
      "entirely server-side, or content_mode: 'edit' with `edits` for one or more targeted find-and-" +
      "replace changes to a non-'text' note without resending the rest of its content. Consider " +
      "trilium_create_revision before a large content rewrite so the previous version stays " +
      "recoverable.",
    parameters: updateNoteParams,
    execute: async (_toolCallId, params: Static<typeof updateNoteParams>) => {
      const { client, baseUrl } = await handlePromise;
      const hasMetadataChanges =
        params.title !== undefined || params.type !== undefined || params.mime !== undefined;

      let note: Record<string, unknown> | undefined;
      if (hasMetadataChanges) {
        note = unwrap(
          await client.PATCH("/notes/{noteId}", {
            params: { path: { noteId: params.note_id } },
            body: { title: params.title, type: params.type, mime: params.mime },
          }),
        );
      }

      if (params.content_mode === "edit") {
        if (!params.edits || params.edits.length === 0) {
          throw new Error(
            "trilium_update_note: content_mode 'edit' requires at least one entry in `edits`.",
          );
        }
        // Same type-resolution logic as the replace/append branch below --
        // needed here to reject a 'text' note before ever fetching its
        // content, not just to pick a conversion.
        let effectiveType = params.type ?? (note?.type as string | undefined);
        if (effectiveType === undefined) {
          const current = unwrap(
            await client.GET("/notes/{noteId}", { params: { path: { noteId: params.note_id } } }),
          );
          effectiveType = current.type;
        }
        if (effectiveType === "text") {
          throw new Error(
            "trilium_update_note: content_mode 'edit' isn't supported for 'text' notes -- their " +
              "content is CKEditor HTML, not raw source, so a literal find/replace risks altering " +
              "unrelated formatting elsewhere in the note. Use content_mode 'replace' or 'append' " +
              "instead.",
          );
        }
        // unwrap() returns undefined for a successful-but-empty body -- see
        // client.ts's own comment. Coerced to "" (an empty note is a valid,
        // if unproductive, edit target).
        const existing =
          unwrap(
            await client.GET("/notes/{noteId}/content", {
              params: { path: { noteId: params.note_id } },
              parseAs: "text",
            }),
          ) ?? "";
        const result = applyTextEdits(
          existing,
          params.edits.map((e) => ({ oldText: e.old_text, newText: e.new_text })),
        );
        if (!result.ok) {
          throw new Error(`trilium_update_note: ${result.error}`);
        }
        unwrap(
          await client.PUT("/notes/{noteId}/content", {
            params: { path: { noteId: params.note_id } },
            headers: { "Content-Type": "text/plain" },
            body: result.content,
            bodySerializer: (body: unknown) => body as string,
          }),
        );
        note = unwrap(
          await client.GET("/notes/{noteId}", { params: { path: { noteId: params.note_id } } }),
        );
      } else if (params.content !== undefined) {
        // formatContentForWrite only converts Markdown for a `text` note,
        // so the real type must be known before calling it -- silently
        // defaulting to "text" would risk mangling a `code` note's raw
        // source with Markdown conversion. params.type (this call) and
        // note.type (from the PATCH above, if metadata changed) are free;
        // only when neither is available does this pay for an extra
        // metadata fetch.
        let effectiveType = params.type ?? (note?.type as string | undefined);
        if (effectiveType === undefined) {
          const current = unwrap(
            await client.GET("/notes/{noteId}", { params: { path: { noteId: params.note_id } } }),
          );
          effectiveType = current.type;
        }
        let contentToWrite = formatContentForWrite(params.content, effectiveType ?? "text");
        if (params.content_mode === "append") {
          // unwrap() returns undefined for a successful-but-empty body --
          // see client.ts's own comment. Coerced to "" so appending to an
          // empty note just writes params.content, not a crash.
          const existing =
            unwrap(
              await client.GET("/notes/{noteId}/content", {
                params: { path: { noteId: params.note_id } },
                parseAs: "text",
              }),
            ) ?? "";
          // A `text` note's HTML blocks (e.g. adjacent <p> tags) don't need
          // an extra separator; anything else (raw source) does, unless the
          // existing content already ends in one.
          const separator =
            existing.length > 0 && effectiveType !== "text" && !existing.endsWith("\n") ? "\n" : "";
          contentToWrite = existing + separator + contentToWrite;
        }
        // ETAPI's content endpoint takes a bare `text/plain` body, not
        // JSON -- override both the serializer (skip JSON.stringify) and
        // the Content-Type header (openapi-fetch defaults to
        // application/json for every request otherwise). Routed through
        // unwrap() (not a bare await) so a failed write throws instead of
        // silently falling through to the re-fetch below and reporting the
        // note's stale, pre-write content back as if the write succeeded.
        unwrap(
          await client.PUT("/notes/{noteId}/content", {
            params: { path: { noteId: params.note_id } },
            headers: { "Content-Type": "text/plain" },
            body: contentToWrite,
            bodySerializer: (body: unknown) => body as string,
          }),
        );
        note = unwrap(
          await client.GET("/notes/{noteId}", { params: { path: { noteId: params.note_id } } }),
        );
      } else if (note === undefined) {
        // No metadata change and no content write -- the only thing left to
        // do is report current state, so this is the sole fetch (unlike the
        // content-write branch above, nothing here is discarded unread).
        note = unwrap(
          await client.GET("/notes/{noteId}", { params: { path: { noteId: params.note_id } } }),
        );
      }

      return toToolResult({ ...note, url: noteUrl(baseUrl, params.note_id) });
    },
  };
}

const deleteNoteParams = Type.Object({
  note_id: Type.String({ description: "Note id to delete." }),
});

export function createDeleteNoteTool(handlePromise: Promise<TriliumClientHandle>): AnyAgentTool {
  return {
    name: "trilium_delete_note",
    label: "Delete a Trilium note",
    description:
      "Delete a note (and, if it has children, its whole subtree). This moves it to Trilium's " +
      "deleted-notes state rather than erasing it immediately -- trilium_undelete_note can restore it " +
      "as long as at least one of its former parent notes still exists and isn't itself deleted. " +
      "Treat this as a real, user-facing destructive action: confirm with the user before deleting " +
      "anything they didn't explicitly ask to remove.",
    parameters: deleteNoteParams,
    execute: async (_toolCallId, params: Static<typeof deleteNoteParams>) => {
      const { client } = await handlePromise;
      unwrap(
        await client.DELETE("/notes/{noteId}", { params: { path: { noteId: params.note_id } } }),
      );
      return toToolResult({ note_id: params.note_id, deleted: true });
    },
  };
}

const undeleteNoteParams = Type.Object({
  note_id: Type.String({ description: "Note id to restore." }),
});

export function createUndeleteNoteTool(handlePromise: Promise<TriliumClientHandle>): AnyAgentTool {
  return {
    name: "trilium_undelete_note",
    label: "Restore a deleted Trilium note",
    description:
      "Restore a previously deleted note. Requires that the note still has at least one parent that " +
      "is itself not deleted -- if the whole ancestor chain was deleted together, restore from the " +
      "top of that chain down.",
    parameters: undeleteNoteParams,
    execute: async (_toolCallId, params: Static<typeof undeleteNoteParams>) => {
      const { client } = await handlePromise;
      const result = unwrap(
        await client.POST("/notes/{noteId}/undelete", {
          params: { path: { noteId: params.note_id } },
        }),
      );
      return toToolResult({ note_id: params.note_id, success: result.success ?? true });
    },
  };
}

const MAX_RECENT_CHANGES = 200;
const DEFAULT_RECENT_CHANGES = 30;

const getRecentChangesParams = Type.Object({
  ancestor_note_id: Type.Optional(
    Type.String({
      description: "Limit to changes within this note's subtree. Defaults to the whole vault.",
    }),
  ),
  limit: Type.Optional(
    Type.Integer({
      description:
        `Max changes to return, most recent first, capped at ${MAX_RECENT_CHANGES}. Defaults to ` +
        `${DEFAULT_RECENT_CHANGES}. Trilium's own endpoint returns the full history uncapped -- this ` +
        "trims what's returned to you client-side, so a very large vault's full history is still " +
        "fetched over the network for this call even though only `limit` entries come back.",
    }),
  ),
});

export function createGetRecentChangesTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_get_recent_changes",
    label: "Get recent Trilium note changes",
    description:
      "List recent note creations, modifications, and deletions -- newest first. Useful for 'what did " +
      "I change today/this week' style questions. Each entry has noteId, title (as of the change), " +
      "current_title, current_isDeleted, and a timestamp; deleted entries also carry " +
      "canBeUndeleted. Trilium's own endpoint has no server-side limit, so `total_available` in the " +
      "response is the true total count regardless of `limit` -- if it's larger than `count`, there " +
      "are more changes than were returned; narrow with ancestor_note_id rather than assuming " +
      "you've seen everything.",
    parameters: getRecentChangesParams,
    execute: async (_toolCallId, params: Static<typeof getRecentChangesParams>) => {
      const { client } = await handlePromise;
      const result = unwrap(
        await client.GET("/notes/history", {
          params: { query: { ancestorNoteId: params.ancestor_note_id } },
        }),
      );
      const limit = clampLimit(params.limit, DEFAULT_RECENT_CHANGES);
      // Trilium's own response is already newest-first (confirmed against
      // a live instance); slicing here just bounds what reaches the model.
      const changes = result.slice(0, limit);
      return toToolResult({ changes, count: changes.length, total_available: result.length });
    },
  };
}

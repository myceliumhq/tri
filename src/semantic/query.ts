// Helpers for Trilium's own search query language (the `search` param on
// GET /notes -- see https://triliumnext.github.io/Docs/Wiki/search.html).
// Unlike paperless-ngx, where `search` (free text) and `query` (Whoosh
// syntax) are two separate tool params, Trilium mixes plain fulltext
// tokens and structured `#label`/`~relation`/`note.property` operators in
// the same string -- so the semantic layer needs to pull the free-text
// portion back out of whatever the caller passed as `search` before it
// can embed anything meaningful from it.

// Strips label (#name), relation (~name), and note.property references
// -- along with the comparison operator and value that usually follow
// them -- leaving whatever plain fulltext tokens remain. Best-effort, not
// a real parser for Trilium's grammar: quoted phrases are unquoted but
// kept, boolean keywords and parentheses are dropped. If a query is pure
// structured filtering (e.g. `#book #year >= 1950`), this returns an
// empty string, which callers treat as "nothing to embed" (see
// search.ts's no-op on an empty term, same as paperless-ngx's).
export function extractFreeTextTerms(search: string): string {
  return (
    search
      .replace(
        /[#~]note\.[a-zA-Z_.]+\s*(?:=|!=|>=|<=|>|<|\*=\*|=\*|\*=|%=)?\s*("[^"]*"|'[^']*'|\S+)?/g,
        " ",
      )
      .replace(
        /\bnote\.[a-zA-Z_.]+\s*(?:=|!=|>=|<=|>|<|\*=\*|=\*|\*=|%=)?\s*("[^"]*"|'[^']*'|\S+)?/g,
        " ",
      )
      .replace(
        /[#~][a-zA-Z_][a-zA-Z0-9_.]*\s*(?:=|!=|>=|<=|>|<|\*=\*|=\*|\*=|%=)\s*("[^"]*"|'[^']*'|\S+)?/g,
        " ",
      )
      .replace(/[#~][a-zA-Z_][a-zA-Z0-9_.]*/g, " ")
      // Case-sensitive on purpose: Trilium's own boolean-operator convention
      // is uppercase (every example in its docs and this plugin's own tool
      // description writes "AND"/"OR"/"NOT"), and a case-insensitive match
      // here previously deleted the ordinary lowercase English words "and",
      // "or", "not" out of completely unrelated free text (e.g. "salt and
      // pepper") before it ever reached the embedding call. `orderBy`/
      // `limit`/`asc`/`desc` are never stripped at all -- those are separate
      // ETAPI query *params* (see createSearchNotesTool), never embedded
      // inside the `search` string itself, so there was nothing for them to
      // legitimately match here in the first place.
      .replace(/\b(AND|OR|NOT)\b/g, " ")
      .replace(/[()]/g, " ")
      .replace(/["']/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}

// Trilium's EntityId pattern (`[a-zA-Z0-9_]{4,32}`) never matches an empty
// string, so `note.noteId != ""` is true for every note that exists --
// used as an unconditional "match everything" base filter, since the
// `search` param is required and non-empty (there's no wildcard/`*`
// shorthand for "all notes" in the grammar).
export const MATCH_ALL_NOTES = 'note.noteId != ""';

// Scopes a sync pass to the two note types this plugin indexes textual
// content for -- see sync.ts's own doc comment for why `file`/`image`/
// `canvas`/etc. are out of scope.
//
// Deliberately unparenthesized: Trilium's ETAPI search parser silently
// returns zero results for any query whose *first* token is `(` (verified
// against a live 0.104.1 instance -- `(note.type = "text")` alone matches
// nothing, while the identical expression anywhere but the leading
// position matches correctly). Since this constant is used standalone as
// the whole query in the no-cursor case, it must not start with `(`.
// source-adapter.ts wraps it in parens itself when ANDing it with a
// cursor condition, where it's safely non-leading.
export const INDEXABLE_TYPES_FILTER = 'note.type = "text" OR note.type = "code"';

// Trilium stores both a LocalDateTime (`dateModified`, in whatever
// offset was current on the server when it was written) and a UtcDateTime
// (`utcDateModified`, format `YYYY-MM-DD HH:MM:SS.sssZ`) per note. The
// sync watermark filter compares against `utcDateModified` specifically
// -- this plugin's process and the Trilium server aren't guaranteed to be
// in the same timezone, so building a LocalDateTime literal from this
// process's own offset could silently misalign against a server-side
// LocalDateTime written in a different one. UTC has no such ambiguity.
export function toUtcDateTimeLiteral(date: Date): string {
  // `Date#toISOString()` already produces `YYYY-MM-DDTHH:MM:SS.sssZ` --
  // only the `T`/`Z` separator differs from Trilium's own UtcDateTime
  // pattern, which uses a space before a bare trailing `Z`.
  return date.toISOString().replace("T", " ");
}

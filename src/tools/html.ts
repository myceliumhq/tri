// Shared helpers for Trilium's `text`-type note content, which Trilium's
// own CKEditor-based UI always stores as HTML -- unlike paperless-ngx's
// OCR content, which is already plain text. Markdown is this plugin's one
// content contract for `text`-type notes, in both directions: writes are
// Markdown by default (converted to HTML server-side via `marked`) and
// reads convert stored HTML back to Markdown by default (via
// `node-html-markdown`), so an agent reading a note's content can edit it
// and write the result straight back with the same syntax. There is
// deliberately no auto-detection between Markdown/HTML/plain-text -- a
// prior heuristic ("does this look like HTML?") silently mis-stored literal
// Markdown syntax (e.g. "# Heading" saved as the literal text "# Heading"
// instead of a real heading) whenever a caller didn't already know to opt
// out, which is exactly what every model's default instinct produces when
// asked to write "note content". There is also deliberately no HTML
// escape hatch -- mirrors Trilium's own first-party MCP tool implementation
// (`note_tools.ts`), which has none either. Neither direction applies to
// non-`text` note types (`code` notes are raw source) -- every call site
// gates that on the note's actual `type` metadata, never on sniffing the
// content itself.
import { marked } from "marked";
import { NodeHtmlMarkdown } from "node-html-markdown";

// `String.slice` operates on UTF-16 code units, so a boundary computed by
// character count can land inside a surrogate pair (emoji, some CJK) and
// split it into two unpaired/replacement-rendering halves. Mirrors
// paperless-ngx's src/tools/documents.ts helpers of the same name.
export function backAwayFromLowSurrogate(str: string, index: number): number {
  const code = str.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index - 1 : index;
}
export function forwardPastHighSurrogate(str: string, index: number): number {
  const code = str.charCodeAt(index - 1);
  return code >= 0xd800 && code <= 0xdbff ? index + 1 : index;
}

export function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

// Trilium's content endpoint always returns text/html regardless of note
// type (there's no separate raw-source endpoint for `code` notes), so this
// is only ever called once a caller has already confirmed the note's type
// is `text` from real metadata -- never from sniffing the content itself.
export function htmlToMarkdown(html: string): string {
  return NodeHtmlMarkdown.translate(html, { bulletMarker: "-" });
}

// Converts Markdown to the HTML Trilium's CKEditor-based UI expects to
// store for a `text` note. Synchronous: `marked.parse` only returns a
// Promise when async walkTokens/extensions are configured, which this
// plugin doesn't use.
export function markdownToHtml(markdown: string): string {
  // marked always appends a trailing newline after the last block --
  // trimmed for a clean stored value (CKEditor doesn't care either way,
  // but an untrimmed value would be a needless cosmetic inconsistency).
  return (marked.parse(markdown, { async: false }) as string).trim();
}

// Shared by every content-write tool that can target a `text`-type note
// (notes.ts's create/update): converts Markdown to HTML for a `text` note,
// verbatim passthrough for every other type (`code`/etc. notes are raw
// source, not Markdown or HTML -- conversion would corrupt them). Mirrors
// Trilium's own first-party MCP tool implementation exactly (`note_tools.ts`:
// `type === "text" ? markdownImport.renderToHtml(content, title) : content`)
// -- deliberately no HTML escape hatch, matching that upstream precedent.
export function formatContentForWrite(content: string, noteType: string): string {
  return noteType === "text" ? markdownToHtml(content) : content;
}

export type TextEdit = { oldText: string; newText: string };
export type TextEditResult = { ok: true; content: string } | { ok: false; error: string };

// Mirrors Trilium's own first-party MCP tool implementation almost verbatim
// (`note_tools.ts`'s `applyTextEdits` helper) -- same all-or-nothing
// semantics, same uniqueness requirement, same error messages, since that
// design was already well-considered and there's no reason to diverge from
// it. Each edit's oldText must occur exactly once in the content at the
// moment it's applied; edits are applied in order, so a later edit may
// target text an earlier edit introduced. If any edit fails to match (or
// matches ambiguously), no edit is committed.
export function applyTextEdits(content: string, edits: TextEdit[]): TextEditResult {
  let result = content;

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    if (!edit) continue;
    const { oldText, newText } = edit;
    const label = edits.length > 1 ? ` (edit ${i + 1} of ${edits.length})` : "";

    if (oldText === "") {
      return { ok: false, error: `oldText must not be empty${label}.` };
    }
    if (oldText === newText) {
      return {
        ok: false,
        error: `oldText and newText are identical${label} -- nothing to change.`,
      };
    }

    const firstIndex = result.indexOf(oldText);
    if (firstIndex === -1) {
      return { ok: false, error: `oldText not found in the note content${label}.` };
    }
    if (result.indexOf(oldText, firstIndex + oldText.length) !== -1) {
      return {
        ok: false,
        error:
          `oldText is not unique${label} -- it matches more than once. ` +
          "Include more surrounding context so it identifies a single location.",
      };
    }

    result = result.slice(0, firstIndex) + newText + result.slice(firstIndex + oldText.length);
  }

  return { ok: true, content: result };
}

export type ContentStatus = "present" | "null" | "empty";

export function contentStatusFor(content: string): ContentStatus {
  return content === "" ? "empty" : "present";
}

export const MAX_RANGE_LINES = 500;
export const DEFAULT_RANGE_LINES = 200;

export type BoundedRead = {
  start_line: number;
  end_line: number;
  total_lines: number;
  content: string;
};

// Caps `content` to a requested (or default) line range, the same bound
// used across every bounded-read tool in this plugin -- mirrors
// paperless-ngx's src/tools/documents.ts capContentForResponse/read-range
// logic. `toolName` is shared by three different tools (note/attachment/
// revision content reads), so it's a param rather than hardcoded, letting
// each caller's thrown error stay attributable the same way every other
// hand-thrown Error in the tool files already is.
//
// This only bounds what's *returned* to the caller, not the work done to
// produce it: every caller already fetched the note/attachment/revision's
// *entire* content over HTTP (ETAPI's content endpoints have no Range-
// header/partial-fetch support to bound that part), and ran the full
// string through htmlToMarkdown's conversion and this function's own
// content.split("\n") before this slice happens. Reading lines 1-10 of a
// very large note still pays that full cost -- accepted the same way
// paperless-ngx's sibling function accepts it, since neither API offers a
// cheaper alternative.
export function readRange(
  toolName: string,
  content: string,
  startLineParam: number | undefined,
  endLineParam: number | undefined,
): BoundedRead {
  const startLine = Math.max(1, startLineParam ?? 1);
  if (endLineParam !== undefined && endLineParam < startLine) {
    throw new Error(
      `${toolName}: end_line (${endLineParam}) is before start_line (${startLine}) -- pass an end_line greater than or equal to start_line.`,
    );
  }
  const lines = content.split("\n");
  const requestedEnd = endLineParam ?? startLine + DEFAULT_RANGE_LINES - 1;
  const endLine = Math.max(
    startLine,
    Math.min(requestedEnd, startLine + MAX_RANGE_LINES - 1, lines.length),
  );
  const isEmptyRange = startLine > lines.length;
  const slice = isEmptyRange ? [] : lines.slice(startLine - 1, endLine);
  return {
    start_line: startLine,
    end_line: isEmptyRange ? startLine - 1 : endLine,
    total_lines: lines.length,
    content: slice.join("\n"),
  };
}

const SNIPPET_CONTEXT_CHARS = 160;

// Best-effort preview around the first place `term` occurs in `content`.
// Mirrors paperless-ngx's extractSnippet, minus the Whoosh-syntax
// stripping (Trilium's own query language is stripped separately by
// src/semantic/query.ts before it ever reaches this function).
export function extractSnippet(content: string, term: string | undefined): string {
  const trimmed = content.trim();
  const leadingExcerpt = () => {
    if (trimmed.length <= SNIPPET_CONTEXT_CHARS * 2) return trimmed;
    const cut = forwardPastHighSurrogate(trimmed, SNIPPET_CONTEXT_CHARS * 2);
    return `${trimmed.slice(0, cut)}…`;
  };
  if (!term) return leadingExcerpt();

  const lowerContent = content.toLowerCase();
  const idx = lowerContent.indexOf(term.toLowerCase());
  if (idx === -1) return leadingExcerpt();

  const start = backAwayFromLowSurrogate(content, Math.max(0, idx - SNIPPET_CONTEXT_CHARS));
  const end = forwardPastHighSurrogate(
    content,
    Math.min(content.length, idx + term.length + SNIPPET_CONTEXT_CHARS),
  );
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

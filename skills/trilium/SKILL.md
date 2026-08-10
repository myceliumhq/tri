---
name: "trilium"
description: "Search, read, and lightly organize the user's Trilium notes with the `tri` CLI (search, read, write, tree, journal, attach, attr). On-demand: find a note, check what's in the journal, attach an image, add a label."
---

# Trilium Notes (`tri` CLI)

`tri --help` lists every command; `tri <command> --help` shows its flags. Config comes from
`TRILIUM_URL`/`TRILIUM_TOKEN` env vars -- run `tri doctor` first if a command fails with a config
error.

## Commands

| Command | Use it for |
| --- | --- |
| `tri search <query> [--limit N]` | Trilium's own query language: free text + `#label`/`~relation`/`note.property` filters, AND/OR/NOT. Hybrid lexical+semantic automatically -- no separate mode to pick. |
| `tri note get <id>` | Metadata: title, type, labels, relations, parent/child ids. No content. |
| `tri note read <id>` | Content to stdout, as Markdown for `text` notes (raw source for `code` notes). |
| `tri note write <id> [--file f.md]` | Replace a note's content entirely. Reads Markdown from `--file` or stdin. |
| `tri note append <id> [--file f.md]` | Add to the end of a note's content, server-side -- prefer this over read-then-write when you're only adding, not editing. |
| `tri tree <id> [--depth N]` | Indented subtree outline with ids inline, for browsing structure. |
| `tri journal [date\|today]` | Get-or-create the day journal note. Use this for "today's note" / "this week", not `search`. |
| `tri attach add <id> <file>` | Attach a file (e.g. an image) to a note -- the file's bytes go straight from disk, never through your own context. |
| `tri attach get <id> [--out path]` | Attachment metadata, or download its bytes. |
| `tri attr list/create/update/del` | Labels and relations by id -- `attr list <id>` first to get an `attributeId` before update/del. |
| `tri doctor` | Verify config and connectivity. |

## Facts

- Every command's default output is compact (table or JSON); pass `--json` on `search`/`attach list`
  for JSONL instead of a table.
- `search` never returns full content -- read a specific note with `note read` to see why it
  matched.
- Content for `text`-type notes is Markdown, always, both ways: write Markdown to `note write`/
  `note append`, and `note read` converts the stored HTML back to Markdown. Never hand-author HTML
  for ordinary prose. `code`-type notes are raw source, byte-for-byte, no conversion.
- Prefer `note append` over `note read` + `note write` when you're only adding content -- it's one
  call instead of two, and the existing body never has to pass through your context.
- Exit codes are deterministic: `0` ok, `2` bad usage (fix the command), `3` not found (bad id),
  `4` config/auth (run `tri doctor`). Branch on these instead of parsing stderr text.

## Procedure

1. `tri search "<query>"` -- usually sufficient alone.
2. Add filters only from constraints the user actually gave: `#labelName` for a known tag,
   `note.type = "code"` for a note type, a date comparison for a time range.
3. Zero results -> broaden: synonyms, partial words, drop filters one at a time.
4. Present compactly: title, `url` (as a link, always).
5. Multiple plausible matches -> list for the user to pick, never guess.
6. Need a note's tree context -> `tri tree <id>` rather than chasing raw ids by hand.

## Safety rules

- Never create, edit, or delete a note, attribute, or attachment unless the user explicitly asked
  for that action -- this skill is search/retrieval-first, since everyone's own filing and tagging
  conventions differ too much for a one-size-fits-all write skill.
- Never guess when multiple matches are plausible -- present options.
- Never fabricate or assume a note's existence or content.
- `note write` replaces a note's entire content -- read it first if you need to preserve part of
  it, and never write empty content unless the user explicitly wants the note cleared.

## No shell available?

The same functionality is also exposed as OpenClaw agent tools (`trilium_search_notes`,
`trilium_get_note`, `trilium_read_note_content`, `trilium_create_note`, `trilium_update_note`,
`trilium_get_calendar_note`, `trilium_create_attachment`, `trilium_create_attribute`, etc.) and as
a standalone MCP server -- see the package README for both.

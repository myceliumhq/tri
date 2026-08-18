import {
  addSubcommand,
  CliError,
  type Command,
  EXIT_CODES,
  parseBoundedInt,
  writeJson,
  writeStderr,
  writeStdout,
} from "@myceliumhq/toolkit";
import { formatContentForWrite, htmlToMarkdown, normalizeLineEndings } from "../../tools/html.js";
import { resolveClientHandle } from "../config.js";
import { readContentInput } from "../content-input.js";
import { unwrapCli } from "../etapi.js";

const NOTE_TYPES = [
  "text",
  "code",
  "file",
  "image",
  "search",
  "book",
  "relationMap",
  "render",
] as const;
const MAX_POSITION = 1_000_000;

function collectOption(value: string, previous: string[]): string[] {
  return previous.concat(value);
}

function splitNameValue(arg: string): { name: string; value: string | undefined } {
  const eq = arg.indexOf("=");
  if (eq === -1) return { name: arg, value: undefined };
  return { name: arg.slice(0, eq), value: arg.slice(eq + 1) };
}

function parsePosition(raw: string | undefined): number | undefined {
  return raw === undefined
    ? undefined
    : parseBoundedInt(raw, { min: 0, max: MAX_POSITION, flag: "--position" });
}

type CreateNoteOptions = {
  title: string;
  content?: string;
  file?: string;
  allowEmpty?: boolean;
  type: string;
  label: string[];
  mime?: string;
  position?: string;
};

export async function createNoteAction(
  parentNoteId: string,
  options: CreateNoteOptions,
): Promise<void> {
  if (!NOTE_TYPES.includes(options.type as (typeof NOTE_TYPES)[number])) {
    throw new CliError(`invalid note type: ${options.type}`, { exitCode: EXIT_CODES.usage });
  }
  if (options.content !== undefined && options.file !== undefined) {
    throw new CliError("--content and --file cannot be used together", {
      exitCode: EXIT_CODES.usage,
    });
  }
  // Validate labels up front -- a bad --label must fail before the note is
  // created, not after, so a typo never leaves an orphaned note behind.
  const parsedLabels = options.label.map((label) => {
    const { name, value } = splitNameValue(label);
    if (!name) {
      throw new CliError("label name is empty", { exitCode: EXIT_CODES.usage });
    }
    return { name, value };
  });

  const content =
    options.content ??
    readContentInput(options.file, "tri note create", { allowEmpty: options.allowEmpty });
  const type = options.type as (typeof NOTE_TYPES)[number];
  const notePosition = parsePosition(options.position);
  const { client, baseUrl } = resolveClientHandle();
  const result = await unwrapCli(
    client.POST("/create-note", {
      body: {
        parentNoteId,
        title: options.title,
        type,
        mime: options.mime,
        content: formatContentForWrite(content, type),
        notePosition,
      },
    }),
  );
  const noteId = result.note?.noteId;
  const labels: string[] = [];
  for (const { name, value } of parsedLabels) {
    await unwrapCli(
      client.POST("/attributes", {
        body: { noteId, type: "label", name, value },
      }),
    );
    labels.push(value === undefined ? name : `${name}=${value}`);
  }

  writeJson({
    noteId,
    title: result.note?.title ?? options.title,
    type: result.note?.type ?? type,
    url: `${baseUrl}/#${noteId}`,
    ...(labels.length > 0 ? { labels } : {}),
  });
}

function flattenAttributes(attributes: unknown): { labels: string[]; relations: unknown[] } {
  const attrs = Array.isArray(attributes) ? (attributes as Record<string, unknown>[]) : [];
  return {
    labels: attrs
      .filter((a) => a.type === "label")
      .map((a) => (a.value ? `${a.name}=${a.value}` : `${a.name}`)),
    relations: attrs
      .filter((a) => a.type === "relation")
      .map((a) => ({ name: a.name, value: a.value, attributeId: a.attributeId })),
  };
}

// ETAPI's content endpoint takes a bare `text/plain` body, not JSON --
// override both the serializer (skip JSON.stringify) and the Content-Type
// header (openapi-fetch defaults to application/json for every request
// otherwise). Shared by write and append below.
async function putContent(
  client: ReturnType<typeof resolveClientHandle>["client"],
  noteId: string,
  content: string,
): Promise<void> {
  await unwrapCli(
    client.PUT("/notes/{noteId}/content", {
      params: { path: { noteId } },
      headers: { "Content-Type": "text/plain" },
      body: content,
      bodySerializer: (body: unknown) => body as string,
    }),
  );
}

export function registerNote(program: Command): void {
  const note = addSubcommand(program, "note")
    .summary("Note metadata, content, create/read/write/append.")
    .description("Note metadata and content -- get, create, read, write, append.");

  addSubcommand(note, "create <parentNoteId>")
    .summary("Create a note under a parent note.")
    .description(
      "Create a note under the specified parent, with optional labels and initial content.",
    )
    .requiredOption("--title <t>", "Note title.")
    .option("--file <path>", "Read content from this file instead of stdin.")
    .option("--content <text>", "Short content snippet instead of --file or stdin.")
    .option("--allow-empty", "Allow empty content from --file or stdin.")
    .option("--type <type>", "Note type.", "text")
    .option("--label <name=value>", "Add a label; may omit =value.", collectOption, [])
    .option("--mime <mime>", "MIME type for code, file, or image notes.")
    .option("--position <n>", "Display order among the parent's children.")
    .addHelpText(
      "after",
      "\nExample: tri note create root --title 'Project notes' --content '# Plan'",
    )
    .action(createNoteAction);

  addSubcommand(note, "get <noteId>")
    .summary("Note metadata: title, type, labels, relations.")
    .description("Note metadata: title, type, labels, relations, parent/child ids. No content.")
    .action(async (noteId: string) => {
      const { client, baseUrl } = resolveClientHandle();
      const result = await unwrapCli(
        client.GET("/notes/{noteId}", { params: { path: { noteId } } }),
      );
      const { labels, relations } = flattenAttributes(result.attributes);

      writeJson({
        noteId: result.noteId,
        title: result.title,
        type: result.type,
        dateCreated: result.dateCreated,
        dateModified: result.dateModified,
        url: `${baseUrl}/#${result.noteId}`,
        ...(labels.length > 0 ? { labels } : {}),
        ...(relations.length > 0 ? { relations } : {}),
        parentNoteIds: result.parentNoteIds ?? [],
        childNoteIds: result.childNoteIds ?? [],
      });
    });

  addSubcommand(note, "read <noteId>")
    .summary("Note content to stdout, as markdown.")
    .description(
      "Note content to stdout, converted to markdown for text notes (code notes print as-is). " +
        "Pipe-clean: only content goes to stdout, everything else to stderr. Empty output is " +
        "ambiguous by itself (a genuinely empty note looks identical to a container/folder note " +
        "that only organizes children) -- when content comes back empty and the note has children, " +
        "a stderr note says so, since `note get` was already fetched for this call anyway.",
    )
    .addHelpText("after", "\nExample: tri note read abc123 > note.md")
    .action(async (noteId: string) => {
      const { client } = resolveClientHandle();
      // Independent requests -- `note` is only consulted afterward to
      // decide HTML->markdown conversion, so both round trips run
      // concurrently.
      const [meta, raw] = await Promise.all([
        unwrapCli(client.GET("/notes/{noteId}", { params: { path: { noteId } } })),
        unwrapCli(
          client.GET("/notes/{noteId}/content", { params: { path: { noteId } }, parseAs: "text" }),
        ).then((content) => content ?? ""),
      ]);

      const content = meta.type === "text" ? htmlToMarkdown(raw) : raw;
      const normalized = normalizeLineEndings(content);

      // Disambiguate "genuinely empty" from "container note with no
      // content of its own" -- both would otherwise print nothing and
      // exit 0 identically, and `meta` (with childNoteIds) is already in
      // hand from the request above, so this costs nothing extra.
      if (normalized.trim().length === 0) {
        const childCount = meta.childNoteIds?.length ?? 0;
        writeStderr(
          childCount > 0
            ? `# this note has no content of its own but has ${childCount} child note(s) -- ` +
                "likely a container/folder note, not truly empty. Use `tri tree` or `note get` " +
                "to see its structure."
            : "# this note has no content and no children -- it is genuinely empty.",
        );
      }

      writeStdout(normalized);
    });

  addSubcommand(note, "write <noteId>")
    .summary("Replace a note's content entirely.")
    .description(
      "Replace a note's content entirely. Reads Markdown from --file or stdin; for a 'text' note " +
        "it's converted to Trilium's native HTML (there is no way to write raw HTML verbatim), " +
        "written byte-for-byte for every other type. Overwrites the whole body -- use `tri note " +
        "read` first if you need to preserve part of it, or `tri note append` to add to the end.",
    )
    .option("--file <path>", "Read content from this file instead of stdin.")
    .option(
      "--allow-empty",
      "Allow writing empty content (guards against an accidental empty pipe/file).",
    )
    .addHelpText("after", "\nExample: tri note write abc123 --file draft.md")
    .action(async (noteId: string, options: { file?: string; allowEmpty?: boolean }) => {
      const rawContent = readContentInput(options.file, "tri note write", {
        allowEmpty: options.allowEmpty,
      });

      const { client, baseUrl } = resolveClientHandle();
      const meta = await unwrapCli(client.GET("/notes/{noteId}", { params: { path: { noteId } } }));
      await putContent(client, noteId, formatContentForWrite(rawContent, meta.type ?? "text"));

      writeJson({ noteId, url: `${baseUrl}/#${noteId}`, contentMode: "replace" });
    });

  addSubcommand(note, "append <noteId>")
    .summary("Add content to the end of a note.")
    .description(
      "Add content to the end of a note's existing body, entirely server-side -- the existing " +
        "content never has to pass through your context. Same Markdown/HTML conversion rules as " +
        "`tri note write`.",
    )
    .option("--file <path>", "Read content from this file instead of stdin.")
    .option(
      "--allow-empty",
      "Allow appending empty content (guards against an accidental empty pipe/file).",
    )
    .addHelpText("after", "\nExample: echo '## New section' | tri note append abc123")
    .action(async (noteId: string, options: { file?: string; allowEmpty?: boolean }) => {
      const rawContent = readContentInput(options.file, "tri note append", {
        allowEmpty: options.allowEmpty,
      });

      const { client, baseUrl } = resolveClientHandle();
      // Independent requests -- neither the note's type nor its existing
      // content depends on the other, so both round trips run
      // concurrently.
      const [meta, existing] = await Promise.all([
        unwrapCli(client.GET("/notes/{noteId}", { params: { path: { noteId } } })),
        unwrapCli(
          client.GET("/notes/{noteId}/content", { params: { path: { noteId } }, parseAs: "text" }),
        ).then((content) => content ?? ""),
      ]);

      const noteType = meta.type ?? "text";
      const formatted = formatContentForWrite(rawContent, noteType);
      // A `text` note's HTML blocks (e.g. adjacent <p> tags) don't need an
      // extra separator; raw-source types do, unless the existing content
      // already ends in one.
      const separator =
        existing.length > 0 && noteType !== "text" && !existing.endsWith("\n") ? "\n" : "";
      await putContent(client, noteId, existing + separator + formatted);

      writeJson({ noteId, url: `${baseUrl}/#${noteId}`, contentMode: "append" });
    });
}

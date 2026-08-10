import { readFileSync, writeFileSync } from "node:fs";
import { basename, extname } from "node:path";
import {
  addSubcommand,
  CliError,
  type Command,
  EXIT_CODES,
  parseBoundedInt,
  writeJson,
  writeTruncationNotice,
} from "@myceliumhq/toolkit";
import { resolveClientHandle } from "../config.js";
import { unwrapCli } from "../etapi.js";

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".zip": "application/zip",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

const MAX_LIST_LIMIT = 200;
const DEFAULT_LIST_LIMIT = 50;

function guessMime(filePath: string): string {
  return EXT_MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function readFileOrThrow(filePath: string): Buffer {
  try {
    return readFileSync(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`cannot read file: ${message}`, { exitCode: EXIT_CODES.usage });
  }
}

export function registerAttach(program: Command): void {
  const attach = addSubcommand(program, "attach")
    .summary("Note attachments -- list, add, get.")
    .description(
      "Manage attachments -- supplementary files owned by a note without being notes themselves " +
        "(e.g. an inline image).",
    );

  addSubcommand(attach, "list <noteId>")
    .summary("List a note's attachments.")
    .option("--limit <n>", `Max results, capped at ${MAX_LIST_LIMIT}.`, String(DEFAULT_LIST_LIMIT))
    .action(async (noteId: string, options: { limit: string }) => {
      const limit = parseBoundedInt(options.limit, {
        min: 1,
        max: MAX_LIST_LIMIT,
        flag: "--limit",
      });

      const { client } = resolveClientHandle();
      const attachments = await unwrapCli(
        client.GET("/notes/{noteId}/attachments", { params: { path: { noteId } } }),
      );

      const truncated = attachments.length > limit;
      writeJson(
        attachments.slice(0, limit).map((a) => ({
          attachmentId: a.attachmentId,
          title: a.title,
          mime: a.mime,
          role: a.role,
        })),
      );
      if (truncated) {
        writeTruncationNotice({ shown: limit, total: attachments.length, limitFlag: "--limit" });
      }
    });

  addSubcommand(attach, "add <noteId> <file>")
    .summary("Attach a file to a note.")
    .description(
      "Upload a file's raw bytes as a new attachment owned by noteId -- the intended way to add " +
        "an image or other binary file to a note. A file path in, never inline content: the bytes " +
        "never have to pass through an agent's context this way, unlike an MCP tool call.",
    )
    .option("--mime <type>", "MIME type. Guessed from the file extension if omitted.")
    .option("--title <name>", "Attachment title. Defaults to the file's basename.")
    .option(
      "--role <role>",
      "Attachment role, e.g. 'file' or 'image'. Guessed from mime if omitted.",
    )
    .addHelpText("after", "\nExample: tri attach add abc123 ./diagram.png")
    .action(
      async (
        noteId: string,
        filePath: string,
        options: { mime?: string; title?: string; role?: string },
      ) => {
        const mime = options.mime ?? guessMime(filePath);
        const title = options.title ?? basename(filePath);
        const role = options.role ?? (mime.startsWith("image/") ? "image" : "file");
        const bytes = readFileOrThrow(filePath);

        const { client } = resolveClientHandle();
        // Created with empty content first, then the raw bytes are PUT
        // separately below -- mirrors postAttachment's own contract (its
        // `content` field is for small text bodies created inline; a
        // binary upload always goes through the dedicated content PUT).
        const created = await unwrapCli(
          client.POST("/attachments", {
            body: { ownerId: noteId, title, mime, content: "", role },
          }),
        );
        const attachmentId = created.attachmentId;
        if (attachmentId === undefined) {
          throw new CliError("attachment creation returned no attachmentId");
        }

        try {
          // ETAPI's OpenAPI spec types this endpoint's body as `text/plain:
          // string`, but it accepts and round-trips arbitrary binary bytes
          // byte-for-byte in practice (verified directly against a live
          // instance) -- the spec just doesn't model non-text attachment
          // uploads. bodySerializer here mirrors the text-content PUTs
          // elsewhere in this file (skip JSON.stringify, pass the body
          // through as-is); the cast is needed because the generated type
          // says `string`, but a Buffer is a valid fetch BodyInit.
          await unwrapCli(
            client.PUT("/attachments/{attachmentId}/content", {
              params: { path: { attachmentId } },
              headers: { "Content-Type": "application/octet-stream" },
              body: bytes as unknown as string,
              bodySerializer: (body: unknown) => body as string,
            }),
          );
        } catch (error) {
          // The metadata POST above already persisted an (empty-content)
          // attachment record -- if the content upload then fails, clean
          // that record up rather than leaving an orphaned empty
          // attachment behind for the caller to discover later via `attach
          // list`. Best-effort: a failure here isn't surfaced over the
          // original, more actionable error.
          try {
            await client.DELETE("/attachments/{attachmentId}", {
              params: { path: { attachmentId } },
            });
          } catch {
            // ignored, see above
          }
          const message = error instanceof Error ? error.message : String(error);
          const prefixed = `content upload failed, created attachment ${attachmentId} was removed: ${message}`;
          // Preserve the original failure's exit code (e.g. a 404/401 from
          // the PUT maps to exit 3/4 via unwrapCli) -- only the message
          // changes to note the cleanup, not the CliError's exitCode/fix.
          throw error instanceof CliError
            ? new CliError(prefixed, { exitCode: error.exitCode, fix: error.fix })
            : new Error(prefixed);
        }

        writeJson({ attachmentId, ownerId: noteId, title, mime, role });
      },
    );

  addSubcommand(attach, "get <attachmentId>")
    .summary("Get attachment metadata, or download its bytes.")
    .description(
      "Fetch an attachment's metadata (title, mime, role). Pass --out to also download its raw " +
        "content to a file instead of printing metadata only.",
    )
    .option("--out <path>", "Download the attachment's content to this file.")
    .addHelpText("after", "\nExample: tri attach get abc123 --out ./diagram.png")
    .action(async (attachmentId: string, options: { out?: string }) => {
      const { client } = resolveClientHandle();
      const wantsContent = options.out !== undefined;

      // Independent requests when both are needed -- metadata doesn't
      // depend on content or vice versa, so they run concurrently instead
      // of paying two round trips end to end (matches note.ts's read
      // action for the same access shape).
      const [attachment, buffer] = await Promise.all([
        unwrapCli(
          client.GET("/attachments/{attachmentId}", { params: { path: { attachmentId } } }),
        ),
        wantsContent
          ? unwrapCli(
              client.GET("/attachments/{attachmentId}/content", {
                params: { path: { attachmentId } },
                parseAs: "arrayBuffer",
              }),
            )
          : Promise.resolve(undefined),
      ]);

      if (options.out !== undefined && buffer !== undefined) {
        writeFileSync(options.out, Buffer.from(buffer as ArrayBuffer));
      }

      writeJson({
        attachmentId: attachment.attachmentId,
        title: attachment.title,
        mime: attachment.mime,
        role: attachment.role,
        ...(options.out !== undefined ? { downloadedTo: options.out } : {}),
      });
    });
}

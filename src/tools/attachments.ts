import { type Static, Type } from "typebox";
import type { AnyAgentTool } from "../agent-tool.js";
import type { TriliumClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";
import { contentStatusFor, htmlToMarkdown, normalizeLineEndings, readRange } from "./html.js";

// Attachments have no dedicated "list by note" endpoint search of their
// own within this file -- use trilium_get_note's include_attachments flag
// to list a note's attachments (GET /notes/{noteId}/attachments), and
// these tools once you have a specific attachmentId.
//
// Deliberately no create/update-attachment tools here: both would need a
// `content` param carrying arbitrary bytes as a JSON string, which has no
// safe encoding for real binary content (an image, a PDF) over MCP -- a
// model inlining raw bytes as text corrupts them, and there's no base64
// encode/decode step to make that safe. That's exactly the gap the `tri`
// CLI's `attach add <noteId> <file>` exists to close: a file path in,
// bytes read straight from disk, never round-tripped through a model's
// context at all. Use the CLI for attaching/replacing content; this file
// only keeps the read/delete tools, which have no such encoding problem.

function isTextSafeMime(mime: string): boolean {
  return mime.startsWith("text/") || mime === "application/json" || mime === "application/xml";
}

const getAttachmentParams = Type.Object({
  attachment_id: Type.String({ description: "Attachment id." }),
  include_content: Type.Optional(
    Type.Boolean({
      description:
        "Also fetch and include the attachment's content (bounded, see start_line/end_line). Only " +
        "safe for text-ish mime types (text/*, application/json, application/xml) -- rejected for " +
        "anything else, since reading binary content as text would corrupt it; use the `tri` CLI's " +
        "`attach get --out` to download binary content to a file instead. Defaults to false.",
    }),
  ),
  start_line: Type.Optional(
    Type.Integer({ description: "Only used with include_content. 1-indexed, defaults to 1." }),
  ),
  end_line: Type.Optional(
    Type.Integer({
      description:
        "Only used with include_content. Defaults to start_line + 199, capped at 500 lines.",
    }),
  ),
  raw_html: Type.Optional(
    Type.Boolean({
      description:
        "Only used with include_content. Skip HTML-to-Markdown conversion (only applies when mime " +
        "is text/html anyway). Defaults to false.",
    }),
  ),
});

export function createGetAttachmentTool(handlePromise: Promise<TriliumClientHandle>): AnyAgentTool {
  return {
    name: "trilium_get_attachment",
    label: "Get a Trilium attachment",
    description:
      "Fetch an attachment's metadata (title, mime, role, contentLength) by id, optionally including " +
      "its content for text-ish mime types (bounded like trilium_read_note_content). For binary " +
      "content (images, PDFs, ...), use the `tri` CLI's `attach get --out` instead -- there is no " +
      "safe way to carry binary bytes through this tool.",
    parameters: getAttachmentParams,
    execute: async (_toolCallId, params: Static<typeof getAttachmentParams>) => {
      const { client } = await handlePromise;
      const attachment = unwrap(
        await client.GET("/attachments/{attachmentId}", {
          params: { path: { attachmentId: params.attachment_id } },
        }),
      );
      if (!params.include_content) return toToolResult(attachment);

      const mime = attachment.mime ?? "";
      if (!isTextSafeMime(mime)) {
        throw new Error(
          `trilium_get_attachment: include_content isn't supported for mime '${mime}' -- ` +
            "reading binary content as text would corrupt it. Use the tri CLI's " +
            "'attach get <id> --out <path>' to download it instead.",
        );
      }

      const rawContent = unwrap(
        await client.GET("/attachments/{attachmentId}/content", {
          params: { path: { attachmentId: params.attachment_id } },
          // See src/tools/notes.ts's identical override -- openapi-fetch
          // defaults to JSON.parse regardless of the real (text/html)
          // Content-Type here.
          parseAs: "text",
        }),
      );
      // Attachments have no `type` field (only `mime`) -- gate on that
      // real metadata instead of sniffing the content itself.
      const wantsMarkdown = !(params.raw_html ?? false) && attachment.mime === "text/html";
      const content = normalizeLineEndings(wantsMarkdown ? htmlToMarkdown(rawContent) : rawContent);
      const range = readRange(
        "trilium_get_attachment",
        content,
        params.start_line,
        params.end_line,
      );
      return toToolResult({ ...attachment, ...range, content_status: contentStatusFor(content) });
    },
  };
}

const deleteAttachmentParams = Type.Object({
  attachment_id: Type.String({ description: "Attachment id to delete." }),
});

export function createDeleteAttachmentTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_delete_attachment",
    label: "Delete a Trilium attachment",
    description:
      "Permanently delete an attachment by id. There is no undelete for attachments (unlike notes).",
    parameters: deleteAttachmentParams,
    execute: async (_toolCallId, params: Static<typeof deleteAttachmentParams>) => {
      const { client } = await handlePromise;
      unwrap(
        await client.DELETE("/attachments/{attachmentId}", {
          params: { path: { attachmentId: params.attachment_id } },
        }),
      );
      return toToolResult({ attachment_id: params.attachment_id, deleted: true });
    },
  };
}

import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { TriliumClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";
import { contentStatusFor, htmlToMarkdown, normalizeLineEndings, readRange } from "./html.js";

// Attachments have no dedicated "list by note" endpoint search of their
// own within this file -- use trilium_get_note's include_attachments flag
// to list a note's attachments (GET /notes/{noteId}/attachments), and
// these tools once you have (or are creating) a specific attachmentId.

const createAttachmentParams = Type.Object({
  owner_id: Type.String({
    description: "The owning note's id (or a revisionId, for a revision's own attachment).",
  }),
  title: Type.String({ description: "Attachment title/filename." }),
  mime: Type.String({ description: "MIME type, e.g. 'image/png', 'application/pdf'." }),
  content: Type.Optional(Type.String({ description: "Attachment content." })),
  role: Type.Optional(
    Type.String({
      description: "Attachment role, e.g. 'file', 'image' -- how Trilium's UI treats it.",
    }),
  ),
  position: Type.Optional(
    Type.Integer({ description: "Display order among this owner's attachments." }),
  ),
});

export function createCreateAttachmentTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_create_attachment",
    label: "Create a Trilium attachment",
    description:
      "Create an attachment owned by a note (or revision). Attachments are for supplementary files " +
      "that belong to a note without being notes themselves (e.g. an inline image). Save the returned " +
      "attachmentId -- there's no way to list attachments back except via trilium_get_note's " +
      "include_attachments on the owning note.",
    parameters: createAttachmentParams,
    execute: async (_toolCallId, params: Static<typeof createAttachmentParams>) => {
      const { client } = await handlePromise;
      const result = unwrap(
        await client.POST("/attachments", {
          body: {
            ownerId: params.owner_id,
            title: params.title,
            mime: params.mime,
            content: params.content ?? "",
            role: params.role,
            position: params.position,
          },
        }),
      );
      return toToolResult(result);
    },
  };
}

const getAttachmentParams = Type.Object({
  attachment_id: Type.String({ description: "Attachment id." }),
  include_content: Type.Optional(
    Type.Boolean({
      description:
        "Also fetch and include the attachment's content (bounded, see start_line/end_line). Defaults to false.",
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
      "its content (bounded like trilium_read_note_content).",
    parameters: getAttachmentParams,
    execute: async (_toolCallId, params: Static<typeof getAttachmentParams>) => {
      const { client } = await handlePromise;
      const attachment = unwrap(
        await client.GET("/attachments/{attachmentId}", {
          params: { path: { attachmentId: params.attachment_id } },
        }),
      );
      if (!params.include_content) return toToolResult(attachment);

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

const updateAttachmentParams = Type.Object({
  attachment_id: Type.String({ description: "Attachment id to update." }),
  title: Type.Optional(Type.String({ description: "New title." })),
  mime: Type.Optional(Type.String({ description: "New MIME type." })),
  role: Type.Optional(Type.String({ description: "New role." })),
  position: Type.Optional(Type.Integer({ description: "New display order." })),
  content: Type.Optional(
    Type.String({
      description:
        "Full replacement content, if given -- written verbatim, with no auto-HTML-wrapping (unlike " +
        "trilium_update_note's content). Attachments are arbitrary mime-typed blobs, not guaranteed " +
        "CKEditor-authored HTML the way a `text`-type note's content is, so there's no safe default " +
        "assumption to auto-format against.",
    }),
  ),
});

export function createUpdateAttachmentTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_update_attachment",
    label: "Update a Trilium attachment",
    description:
      "Update an attachment's title/mime/role/position and/or replace its full content in one call " +
      "(content is a full replacement, same as trilium_update_note).",
    parameters: updateAttachmentParams,
    execute: async (_toolCallId, params: Static<typeof updateAttachmentParams>) => {
      const { client } = await handlePromise;
      const hasMetadataChanges =
        params.title !== undefined ||
        params.mime !== undefined ||
        params.role !== undefined ||
        params.position !== undefined;

      let attachment: Record<string, unknown> | undefined;
      if (hasMetadataChanges) {
        attachment = unwrap(
          await client.PATCH("/attachments/{attachmentId}", {
            params: { path: { attachmentId: params.attachment_id } },
            body: {
              title: params.title,
              mime: params.mime,
              role: params.role,
              position: params.position,
            },
          }),
        );
      }

      if (params.content !== undefined) {
        // See notes.ts's identical unwrap() usage on its content PUT -- a
        // failed write must throw here rather than silently falling through
        // to the re-fetch below and reporting stale content as success.
        // Written verbatim (no formatContentForWrite) -- see
        // updateAttachmentParams' content doc comment for why.
        unwrap(
          await client.PUT("/attachments/{attachmentId}/content", {
            params: { path: { attachmentId: params.attachment_id } },
            headers: { "Content-Type": "text/plain" },
            body: params.content,
            bodySerializer: (body: unknown) => body as string,
          }),
        );
        attachment = unwrap(
          await client.GET("/attachments/{attachmentId}", {
            params: { path: { attachmentId: params.attachment_id } },
          }),
        );
      } else if (attachment === undefined) {
        // No metadata change and no content write -- the only thing left to
        // do is report current state, so this is the sole fetch (unlike the
        // content-write branch above, nothing here is discarded unread).
        attachment = unwrap(
          await client.GET("/attachments/{attachmentId}", {
            params: { path: { attachmentId: params.attachment_id } },
          }),
        );
      }

      return toToolResult(attachment);
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

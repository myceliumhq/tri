import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { TriliumClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";

const createAttributeParams = Type.Object({
  note_id: Type.String({ description: "Note id to attach this attribute to." }),
  type: Type.Union([Type.Literal("label"), Type.Literal("relation")], {
    description:
      "'label' is a key-value tag (e.g. #priority=high); 'relation' is a typed link to another note.",
  }),
  name: Type.String({ description: "Attribute name, no whitespace (e.g. 'priority', 'author')." }),
  value: Type.Optional(
    Type.String({
      description:
        "For a label: the value (omit for a bare flag-style label like #archived). For a relation: " +
        "REQUIRED, the target note's id.",
    }),
  ),
  is_inheritable: Type.Optional(
    Type.Boolean({ description: "Whether child notes inherit this attribute. Defaults to false." }),
  ),
  position: Type.Optional(
    Type.Integer({ description: "Display order among this note's attributes." }),
  ),
});

export function createCreateAttributeTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_create_attribute",
    label: "Create a Trilium label or relation",
    description:
      "Add a label (key-value tag) or relation (typed link to another note) to a note. Check the " +
      "note's existing attributes first (trilium_get_note's `attributes`/`labels`) to avoid creating " +
      "a near-duplicate -- Trilium allows multiple attributes with the same name on one note (e.g. " +
      "several ~author relations), so this never silently overwrites an existing one; use " +
      "trilium_update_attribute with the existing attributeId instead if that's what you want.",
    parameters: createAttributeParams,
    execute: async (_toolCallId, params: Static<typeof createAttributeParams>) => {
      const { client } = await handlePromise;
      if (params.type === "relation" && !params.value) {
        throw new Error(
          "trilium_create_attribute: a relation requires `value` (the target note's id).",
        );
      }
      const result = unwrap(
        await client.POST("/attributes", {
          body: {
            noteId: params.note_id,
            type: params.type,
            name: params.name,
            value: params.value,
            isInheritable: params.is_inheritable,
            position: params.position,
          },
        }),
      );
      return toToolResult(result);
    },
  };
}

const updateAttributeParams = Type.Object({
  attribute_id: Type.String({ description: "Attribute id to update." }),
  value: Type.Optional(
    Type.String({
      description:
        "New value. For a label, any string. For a relation, Trilium only accepts repositioning via " +
        "this endpoint (not changing the target) -- to point a relation at a different note, delete " +
        "it and create a new one instead.",
    }),
  ),
  position: Type.Optional(
    Type.Integer({ description: "New display order among this note's attributes." }),
  ),
});

export function createUpdateAttributeTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_update_attribute",
    label: "Update a Trilium label or relation",
    description:
      "Update an existing attribute's value and/or position by id. Only value (labels only) and " +
      "position are actually mutable via this endpoint -- name/type can't change; delete and recreate " +
      "instead if you need a different name, type, or relation target.",
    parameters: updateAttributeParams,
    execute: async (_toolCallId, params: Static<typeof updateAttributeParams>) => {
      const { client } = await handlePromise;
      const result = unwrap(
        await client.PATCH("/attributes/{attributeId}", {
          params: { path: { attributeId: params.attribute_id } },
          body: { value: params.value, position: params.position },
        }),
      );
      return toToolResult(result);
    },
  };
}

const deleteAttributeParams = Type.Object({
  attribute_id: Type.String({ description: "Attribute id to delete." }),
});

export function createDeleteAttributeTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_delete_attribute",
    label: "Delete a Trilium label or relation",
    description: "Remove a label or relation from a note by its attributeId.",
    parameters: deleteAttributeParams,
    execute: async (_toolCallId, params: Static<typeof deleteAttributeParams>) => {
      const { client } = await handlePromise;
      unwrap(
        await client.DELETE("/attributes/{attributeId}", {
          params: { path: { attributeId: params.attribute_id } },
        }),
      );
      return toToolResult({ attribute_id: params.attribute_id, deleted: true });
    },
  };
}

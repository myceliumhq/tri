import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { TriliumClientHandle } from "../client.js";
import { toToolResult, unwrap } from "../client.js";

const placeNoteInTreeParams = Type.Object({
  note_id: Type.String({ description: "Note id to place (clone) into the tree." }),
  parent_note_id: Type.String({ description: "Parent note id to place it under." }),
  prefix: Type.Optional(
    Type.String({ description: "Branch-specific title prefix, shown only in this tree location." }),
  ),
  note_position: Type.Optional(
    Type.Integer({
      description: "Position among siblings at this location. Normal ordering is 10, 20, 30, ...",
    }),
  ),
  is_expanded: Type.Optional(
    Type.Boolean({ description: "Whether this location should render expanded." }),
  ),
});

export function createPlaceNoteInTreeTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_place_note_in_tree",
    label: "Place (clone) a Trilium note in the tree",
    description:
      "Place an existing note under parent_note_id -- this is how Trilium notes get cloned into " +
      "multiple locations, and also how you move/reorder/reprefix a note that's already there: if a " +
      "branch (placement) between this note and this parent already exists, its prefix/position/" +
      "is_expanded are updated in place instead of creating a duplicate placement. To remove a note " +
      "from one specific location (without deleting the note itself, if it has other placements), use " +
      "trilium_remove_note_from_location with that location's branchId instead.",
    parameters: placeNoteInTreeParams,
    execute: async (_toolCallId, params: Static<typeof placeNoteInTreeParams>) => {
      const { client } = await handlePromise;
      const result = unwrap(
        await client.POST("/branches", {
          body: {
            noteId: params.note_id,
            parentNoteId: params.parent_note_id,
            prefix: params.prefix,
            notePosition: params.note_position,
            isExpanded: params.is_expanded,
          },
        }),
      );
      // Best-effort UI-freshness nicety, not a data-correctness requirement:
      // Trilium doesn't push notePosition changes to already-open clients
      // without this (per the endpoint's own description) -- the write
      // itself is already durable regardless of whether this succeeds, so
      // failures here are swallowed rather than surfaced as a tool error.
      if (params.note_position !== undefined) {
        try {
          await client.POST("/refresh-note-ordering/{parentNoteId}", {
            params: { path: { parentNoteId: params.parent_note_id } },
          });
        } catch {
          // non-critical, see above
        }
      }
      return toToolResult(result);
    },
  };
}

const removeNoteFromLocationParams = Type.Object({
  branch_id: Type.String({
    description:
      "Branch id identifying the placement to remove -- get this from a note's parents/children " +
      "(trilium_get_note's resolved parent/child entries each include their branchId) rather than " +
      "guessing it.",
  }),
});

export function createRemoveNoteFromLocationTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_remove_note_from_location",
    label: "Remove a Trilium note from one tree location",
    description:
      "Remove one placement (branch) of a note from the tree. If this is the note's only remaining " +
      "placement, the note itself is deleted (same recoverability as trilium_delete_note -- " +
      "trilium_undelete_note can restore it). If the note is cloned into other locations too, only " +
      "this one placement disappears and the note remains everywhere else.",
    parameters: removeNoteFromLocationParams,
    execute: async (_toolCallId, params: Static<typeof removeNoteFromLocationParams>) => {
      const { client } = await handlePromise;
      unwrap(
        await client.DELETE("/branches/{branchId}", {
          params: { path: { branchId: params.branch_id } },
        }),
      );
      return toToolResult({ branch_id: params.branch_id, removed: true });
    },
  };
}

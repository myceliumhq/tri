// Read-only mode for the standalone MCP server (TRILIUM_READ_ONLY=true).
//
// This module is deliberately dependency-free -- no `openclaw`, no client,
// no server -- so the tool partition below can be unit-tested without
// standing anything up. Everything here is name-based: AnyAgentTool.parameters
// is a TypeBox TSchema, but a name is a plain string, so nothing in this file
// needs to touch TypeBox at all.
//
// Only the standalone server consults this. The OpenClaw plugin path
// (src/index.ts + openclaw.plugin.json) registers the full tool set
// unconditionally: OpenClaw isn't the remote-exposure surface this guards,
// and its manifest contract is a fixed list that must keep matching what
// register() registers.

/**
 * Tools that only ever read from Trilium. This is the exact set the
 * standalone server keeps when read-only mode is on.
 *
 * `trilium_get_calendar_note` is deliberately NOT here even though its name and
 * ETAPI surface read as a lookup: Trilium's calendar/inbox endpoints
 * materialize the journal note for a date if it doesn't exist yet (the tool is
 * documented as "get or create"). That is a write to the database on a GET, so
 * keeping it would break the read-only mode's core property -- a remotely
 * exposed server must never cause a write, not merely "a write that destroys
 * content." It lives in WRITE_TOOL_NAMES for that reason.
 */
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
  "trilium_search_notes",
  "trilium_get_note",
  "trilium_read_note_content",
  "trilium_get_recent_changes",
  "trilium_get_attachment",
  "trilium_read_revision_content",
]);

/**
 * Tools that create, mutate or delete Trilium state -- everything read-only
 * mode drops.
 *
 * This isn't used by the filter (which keys off READ_ONLY_TOOL_NAMES alone);
 * it exists so a test can assert that every tool the app registers is
 * classified one way or the other. Without that assertion, a newly added tool
 * would silently land on the "dropped in read-only mode" side by default --
 * fail-safe for security, but silent, and silence is how a read tool goes
 * missing from a read-only deployment for a release or two.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "trilium_create_note",
  "trilium_update_note",
  "trilium_delete_note",
  "trilium_undelete_note",
  "trilium_place_note_in_tree",
  "trilium_remove_note_from_location",
  "trilium_create_attribute",
  "trilium_update_attribute",
  "trilium_delete_attribute",
  "trilium_create_attachment",
  "trilium_update_attachment",
  "trilium_delete_attachment",
  "trilium_create_revision",
  // Materializes the journal note on GET -- a write, see READ_ONLY_TOOL_NAMES.
  "trilium_get_calendar_note",
]);

/**
 * Trim a tool list down to the read-only tools when read-only mode is on.
 *
 * The trim is hard: filtered-out tools are never handed to createMcpServer, so
 * they don't appear in tools/list and there is no tools/call handler to reach.
 * That matters because the motivating deployment is MCP-over-HTTP, where the
 * server is reachable by anything that can hit the port -- a tool that is
 * merely flagged, annotated or "discouraged in the description" is still a live
 * mutation endpoint. Not registering it at all is the only version of this that
 * is actually a security property.
 *
 * @param tools every tool the server would otherwise register.
 * @param readOnly whether read-only mode is on; when false this is a no-op.
 * @param readOnlyNames names to keep, defaulting to this app's read-only set.
 *   Parameterized so tests can exercise the filter against a fixture set.
 */
export function filterReadOnlyTools<T extends { name: string }>(
  tools: readonly T[],
  readOnly: boolean,
  readOnlyNames: ReadonlySet<string> = READ_ONLY_TOOL_NAMES,
): T[] {
  if (!readOnly) return [...tools];
  return tools.filter((tool) => readOnlyNames.has(tool.name));
}

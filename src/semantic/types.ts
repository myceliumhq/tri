// The agent-facing contract trilium_search_notes merges into its lexical
// results (see src/tools/notes.ts). startLine/endLine let the caller chain
// straight into trilium_read_note_content instead of only getting matched
// text with no way to locate it in the note. The store/sync/search engine
// itself lives in @myceliumhq/index -- see src/semantic/handle.ts for how
// this plugin wires that up.
export type SemanticMatch = {
  noteId: string;
  snippet: string;
  score: number;
  startLine: number;
  endLine: number;
};

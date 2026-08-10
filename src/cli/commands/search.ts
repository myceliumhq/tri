import {
  addSubcommand,
  type Command,
  parseBoundedInt,
  writeJsonLines,
  writeTable,
  writeTruncationNotice,
} from "@myceliumhq/toolkit";
import { resolveClientHandle } from "../config.js";
import { unwrapCli } from "../etapi.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 10;

export function registerSearch(program: Command): void {
  addSubcommand(program, "search <query...>")
    .summary("Lexical/attribute search over notes.")
    .description(
      "Lexical/attribute search over Trilium's own query language -- free text, #label filters, " +
        "note.property comparisons. See Trilium's search syntax docs for the full grammar.",
    )
    .option("--limit <n>", `Max results, capped at ${MAX_LIMIT}.`, String(DEFAULT_LIMIT))
    .option("--json", "Emit JSONL (one result per line) instead of a table.")
    .addHelpText("after", '\nExample: tri search "#book #year >= 1950"')
    .action(async (queryParts: string[], options: { limit: string; json?: boolean }) => {
      const query = queryParts.join(" ");
      const limit = parseBoundedInt(options.limit, { min: 1, max: MAX_LIMIT, flag: "--limit" });

      const { client, baseUrl } = resolveClientHandle();
      // Request one extra row so a result count exactly equal to `limit`
      // can be told apart from a truncated one -- without this, an
      // exact-limit match count fires the truncation notice for nothing.
      const result = await unwrapCli(
        client.GET("/notes", { params: { query: { search: query, limit: limit + 1 } } }),
      );

      const truncated = result.results.length > limit;
      const rows = result.results.slice(0, limit).map((note) => ({
        noteId: note.noteId ?? "",
        title: note.title ?? "",
        type: note.type ?? "",
        url: note.noteId ? `${baseUrl}/#${note.noteId}` : "",
      }));

      if (options.json) {
        writeJsonLines(rows);
      } else {
        writeTable(rows, [
          { header: "ID", value: (r) => r.noteId, maxWidth: 22 },
          { header: "TYPE", value: (r) => r.type, maxWidth: 8 },
          { header: "TITLE", value: (r) => r.title, maxWidth: 60 },
        ]);
      }

      if (truncated) {
        writeTruncationNotice({ shown: rows.length, limitFlag: "--limit" });
      }
    });
}

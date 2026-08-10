import { addSubcommand, type Command, writeJson } from "@myceliumhq/toolkit";
import { resolveClientHandle } from "../config.js";
import { unwrapCli } from "../etapi.js";

function todayDate(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function registerJournal(program: Command): void {
  addSubcommand(program, "journal [date]")
    .summary("Get or create a day's journal note.")
    .description(
      "Get the day journal note for a date (YYYY-MM-DD), created automatically if it doesn't " +
        "exist yet -- matching Trilium's own journal feature. Defaults to today.",
    )
    .addHelpText("after", "\nExample: tri journal 2026-08-10")
    .action(async (dateArg: string | undefined) => {
      const date = dateArg === undefined || dateArg === "today" ? todayDate() : dateArg;

      const { client, baseUrl } = resolveClientHandle();
      const note = await unwrapCli(
        client.GET("/calendar/days/{date}", { params: { path: { date } } }),
      );

      // unwrapCli already throws on failure, so a successful response here
      // is guaranteed to carry a real noteId -- build url unconditionally
      // rather than re-guarding against a case that can't occur (matches
      // note.ts's identical reasoning for its own url field).
      writeJson({
        noteId: note.noteId,
        title: note.title,
        date,
        url: `${baseUrl}/#${note.noteId}`,
      });
    });
}

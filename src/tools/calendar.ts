import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-entry";
import { type Static, Type } from "typebox";
import type { TriliumClient, TriliumClientHandle } from "../client.js";
import { noteUrl, toToolResult, unwrap } from "../client.js";

const getCalendarNoteParams = Type.Object({
  kind: Type.Union(
    [
      Type.Literal("day"),
      Type.Literal("week"),
      Type.Literal("month"),
      Type.Literal("year"),
      Type.Literal("inbox"),
    ],
    { description: "Which calendar/journal note to fetch or create." },
  ),
  date: Type.String({
    description:
      "Format depends on kind: 'day'/'inbox' take YYYY-MM-DD (e.g. 2026-07-27); 'week' takes an ISO " +
      "week YYYY-Www (e.g. 2026-W30); 'month' takes YYYY-MM; 'year' takes YYYY.",
  }),
});

async function fetchCalendarNote(
  client: TriliumClient,
  kind: Static<typeof getCalendarNoteParams>["kind"],
  date: string,
): Promise<Record<string, unknown>> {
  switch (kind) {
    case "day":
      return unwrap(await client.GET("/calendar/days/{date}", { params: { path: { date } } }));
    case "inbox":
      return unwrap(await client.GET("/inbox/{date}", { params: { path: { date } } }));
    case "week":
      return unwrap(
        await client.GET("/calendar/weeks/{week}", { params: { path: { week: date } } }),
      );
    case "month":
      return unwrap(
        await client.GET("/calendar/months/{month}", { params: { path: { month: date } } }),
      );
    case "year":
      return unwrap(
        await client.GET("/calendar/years/{year}", { params: { path: { year: date } } }),
      );
    default:
      throw new Error(`trilium_get_calendar_note: unknown kind '${kind satisfies never}'`);
  }
}

export function createGetCalendarNoteTool(
  handlePromise: Promise<TriliumClientHandle>,
): AnyAgentTool {
  return {
    name: "trilium_get_calendar_note",
    label: "Get or create a Trilium journal/calendar note",
    description:
      "Get the day/week/month/year journal note for a given date, or the fixed inbox note for a " +
      "given date -- created automatically if it doesn't exist yet, matching Trilium's own journal " +
      "feature. Use this instead of trilium_search_notes when the user refers to 'today's note', " +
      "'this week's journal', an inbox, etc.",
    parameters: getCalendarNoteParams,
    execute: async (_toolCallId, params: Static<typeof getCalendarNoteParams>) => {
      const { client, baseUrl } = await handlePromise;
      const note = await fetchCalendarNote(client, params.kind, params.date);
      const noteId = note.noteId;
      return toToolResult({
        ...note,
        url: typeof noteId === "string" ? noteUrl(baseUrl, noteId) : undefined,
      });
    },
  };
}

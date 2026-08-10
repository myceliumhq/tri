import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriliumClient } from "../client.js";
import { createGetCalendarNoteTool } from "./calendar.js";

const BASE_URL = "https://trilium.example.com";

type Route = {
  test: (pathname: string, method: string) => boolean;
  handle: (req: Request) => Response | unknown;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(routes: Route[]) {
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const request = input as Request;
    const url = new URL(request.url);
    const route = routes.find((r) => r.test(url.pathname, request.method));
    if (!route) throw new Error(`Unhandled request in test: ${request.method} ${url.pathname}`);
    const result = route.handle(request);
    return result instanceof Response ? result : jsonResponse(result);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function setup(routes: Route[]) {
  stubFetch(routes);
  const client = createTriliumClient({ baseUrl: BASE_URL, apiToken: "test-token" });
  return Promise.resolve({ client, baseUrl: BASE_URL });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("trilium_get_calendar_note", () => {
  it("routes 'day' to /calendar/days/{date}", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/calendar/days/2026-07-27" && m === "GET",
        handle: () => jsonResponse({ noteId: "day1" }),
      },
    ]);
    const tool = createGetCalendarNoteTool(handle);
    const result = (await tool.execute("call1", { kind: "day", date: "2026-07-27" })).details as {
      noteId: string;
      url: string;
    };
    expect(result.noteId).toBe("day1");
    expect(result.url).toBe(`${BASE_URL}/#day1`);
  });

  it("routes 'week' to /calendar/weeks/{week}", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/calendar/weeks/2026-W30" && m === "GET",
        handle: () => jsonResponse({ noteId: "week1" }),
      },
    ]);
    const tool = createGetCalendarNoteTool(handle);
    const result = (await tool.execute("call1", { kind: "week", date: "2026-W30" })).details as {
      noteId: string;
    };
    expect(result.noteId).toBe("week1");
  });

  it("routes 'inbox' to /inbox/{date}", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/inbox/2026-07-27" && m === "GET",
        handle: () => jsonResponse({ noteId: "inbox1" }),
      },
    ]);
    const tool = createGetCalendarNoteTool(handle);
    const result = (await tool.execute("call1", { kind: "inbox", date: "2026-07-27" })).details as {
      noteId: string;
    };
    expect(result.noteId).toBe("inbox1");
  });
});

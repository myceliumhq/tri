import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriliumClient } from "../client.js";
import { createCreateRevisionTool, createReadRevisionContentTool } from "./revisions.js";

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
function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}
function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ status, code, message }, status);
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

describe("trilium_create_revision", () => {
  it("returns revision_created:true on a real 204 success", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/revision" && m === "POST",
        handle: () => new Response(null, { status: 204 }),
      },
    ]);
    const tool = createCreateRevisionTool(handle);
    const result = await tool.execute("call1", { note_id: "note1" });
    expect(result.details).toEqual({ note_id: "note1", revision_created: true });
  });

  // Regression test for a real bug found in review: the POST call's
  // result was never inspected, so a failed snapshot still reported
  // revision_created:true.
  it("throws instead of reporting success when the snapshot actually fails", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/revision" && m === "POST",
        handle: () => errorResponse(404, "NOTE_NOT_FOUND", "no such note"),
      },
    ]);
    const tool = createCreateRevisionTool(handle);
    await expect(tool.execute("call1", { note_id: "note1" })).rejects.toThrow(/NOTE_NOT_FOUND/);
  });
});

describe("trilium_read_revision_content", () => {
  it("converts a text-type revision's HTML content to Markdown by default", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/revisions/rev1/content" && m === "GET",
        handle: () => textResponse("<h1>old content</h1>"),
      },
      {
        test: (p, m) => p === "/etapi/revisions/rev1" && m === "GET",
        handle: () => jsonResponse({ revisionId: "rev1", type: "text" }),
      },
    ]);
    const tool = createReadRevisionContentTool(handle);
    const result = (await tool.execute("call1", { revision_id: "rev1" })).details as {
      content: string;
    };
    expect(result.content).toBe("# old content");
  });

  // Regression test for the real bug this whole fix responds to: gating on
  // the revision's real type metadata, not sniffing the content itself.
  it("returns a code-type revision's content byte-for-byte", async () => {
    const rawSource = "# not a heading\nconst x = 1;";
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/revisions/rev1/content" && m === "GET",
        handle: () => textResponse(rawSource),
      },
      {
        test: (p, m) => p === "/etapi/revisions/rev1" && m === "GET",
        handle: () => jsonResponse({ revisionId: "rev1", type: "code" }),
      },
    ]);
    const tool = createReadRevisionContentTool(handle);
    const result = (await tool.execute("call1", { revision_id: "rev1" })).details as {
      content: string;
    };
    expect(result.content).toBe(rawSource);
  });
});

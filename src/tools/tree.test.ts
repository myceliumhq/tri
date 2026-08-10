import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriliumClient } from "../client.js";
import { createPlaceNoteInTreeTool, createRemoveNoteFromLocationTool } from "./tree.js";

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

describe("trilium_place_note_in_tree", () => {
  it("creates a branch and best-effort refreshes ordering when a position is given", async () => {
    let refreshCalled = false;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/branches" && m === "POST",
        handle: () =>
          jsonResponse({ branchId: "root_note1", noteId: "note1", parentNoteId: "root" }, 201),
      },
      {
        test: (p, m) => p === "/etapi/refresh-note-ordering/root" && m === "POST",
        handle: () => {
          refreshCalled = true;
          return new Response(null, { status: 204 });
        },
      },
    ]);
    const tool = createPlaceNoteInTreeTool(handle);
    const result = await tool.execute("call1", {
      note_id: "note1",
      parent_note_id: "root",
      note_position: 10,
    });
    expect((result.details as { branchId: string }).branchId).toBe("root_note1");
    expect(refreshCalled).toBe(true);
  });

  it("does not fail the call if the best-effort ordering refresh itself fails", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/branches" && m === "POST",
        handle: () => jsonResponse({ branchId: "root_note1" }, 201),
      },
      {
        test: (p, m) => p === "/etapi/refresh-note-ordering/root" && m === "POST",
        handle: () => errorResponse(500, "INTERNAL_ERROR", "boom"),
      },
    ]);
    const tool = createPlaceNoteInTreeTool(handle);
    const result = await tool.execute("call1", {
      note_id: "note1",
      parent_note_id: "root",
      note_position: 10,
    });
    expect((result.details as { branchId: string }).branchId).toBe("root_note1");
  });
});

describe("trilium_remove_note_from_location", () => {
  it("returns removed:true on a real 204 success", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/branches/root_note1" && m === "DELETE",
        handle: () => new Response(null, { status: 204 }),
      },
    ]);
    const tool = createRemoveNoteFromLocationTool(handle);
    const result = await tool.execute("call1", { branch_id: "root_note1" });
    expect(result.details).toEqual({ branch_id: "root_note1", removed: true });
  });

  // Regression test for a real bug found in review: the DELETE call's
  // result was never inspected, so a failed removal still reported
  // removed:true.
  it("throws instead of reporting success when the DELETE actually fails", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/branches/root_note1" && m === "DELETE",
        handle: () => errorResponse(404, "BRANCH_NOT_FOUND", "no such branch"),
      },
    ]);
    const tool = createRemoveNoteFromLocationTool(handle);
    await expect(tool.execute("call1", { branch_id: "root_note1" })).rejects.toThrow(
      /BRANCH_NOT_FOUND/,
    );
  });
});

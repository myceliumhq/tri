import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriliumClient } from "../client.js";
import {
  createCreateAttributeTool,
  createDeleteAttributeTool,
  createUpdateAttributeTool,
} from "./attributes.js";

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

describe("trilium_create_attribute", () => {
  it("creates a label", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attributes" && m === "POST",
        handle: () =>
          jsonResponse(
            { attributeId: "attr1", type: "label", name: "priority", value: "high" },
            201,
          ),
      },
    ]);
    const tool = createCreateAttributeTool(handle);
    const result = await tool.execute("call1", {
      note_id: "note1",
      type: "label",
      name: "priority",
      value: "high",
    });
    expect((result.details as { attributeId: string }).attributeId).toBe("attr1");
  });

  it("rejects a relation with no target value before making a network call", async () => {
    const handle = setup([]);
    const tool = createCreateAttributeTool(handle);
    await expect(
      tool.execute("call1", { note_id: "note1", type: "relation", name: "author" }),
    ).rejects.toThrow(/requires `value`/);
  });
});

describe("trilium_update_attribute", () => {
  it("patches value/position", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attributes/attr1" && m === "PATCH",
        handle: () => jsonResponse({ attributeId: "attr1", value: "low" }),
      },
    ]);
    const tool = createUpdateAttributeTool(handle);
    const result = await tool.execute("call1", { attribute_id: "attr1", value: "low" });
    expect((result.details as { value: string }).value).toBe("low");
  });
});

describe("trilium_delete_attribute", () => {
  it("returns deleted:true on a real 204 success", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attributes/attr1" && m === "DELETE",
        handle: () => new Response(null, { status: 204 }),
      },
    ]);
    const tool = createDeleteAttributeTool(handle);
    const result = await tool.execute("call1", { attribute_id: "attr1" });
    expect(result.details).toEqual({ attribute_id: "attr1", deleted: true });
  });

  // Regression test for a real bug found in review: the DELETE call's
  // result was never inspected, so a failed delete still reported
  // deleted:true.
  it("throws instead of reporting success when the DELETE actually fails", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attributes/attr1" && m === "DELETE",
        handle: () => errorResponse(404, "ATTRIBUTE_NOT_FOUND", "no such attribute"),
      },
    ]);
    const tool = createDeleteAttributeTool(handle);
    await expect(tool.execute("call1", { attribute_id: "attr1" })).rejects.toThrow(
      /ATTRIBUTE_NOT_FOUND/,
    );
  });
});

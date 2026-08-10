import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriliumClient } from "../client.js";
import {
  createCreateAttachmentTool,
  createDeleteAttachmentTool,
  createGetAttachmentTool,
  createUpdateAttachmentTool,
} from "./attachments.js";

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

describe("trilium_create_attachment", () => {
  it("writes content verbatim, with no auto-HTML-wrapping", async () => {
    let postBody: unknown;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attachments" && m === "POST",
        handle: async (req) => {
          postBody = await req.json();
          return jsonResponse({ attachmentId: "att1" }, 201);
        },
      },
    ]);
    const tool = createCreateAttachmentTool(handle);
    await tool.execute("call1", {
      owner_id: "note1",
      title: "file.txt",
      mime: "text/plain",
      content: "hello world",
    });
    expect((postBody as { content: string }).content).toBe("hello world");
  });
});

describe("trilium_get_attachment", () => {
  it("converts an HTML-mime attachment's content to Markdown when requested", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attachments/att1" && m === "GET",
        handle: () => jsonResponse({ attachmentId: "att1", title: "note.html", mime: "text/html" }),
      },
      {
        test: (p, m) => p === "/etapi/attachments/att1/content" && m === "GET",
        handle: () => textResponse("<h1>attachment body</h1>"),
      },
    ]);
    const tool = createGetAttachmentTool(handle);
    const result = (await tool.execute("call1", { attachment_id: "att1", include_content: true }))
      .details as {
      content: string;
    };
    expect(result.content).toBe("# attachment body");
  });

  // Regression test for the real bug this whole fix responds to: gating on
  // real mime metadata, not sniffing the content itself -- an attachment
  // whose mime isn't text/html must be returned byte-for-byte even if its
  // content happens to contain characters that look like HTML tags.
  it("returns a non-HTML-mime attachment's content byte-for-byte", async () => {
    const rawContent = "<not-real-html>just plain text</not-real-html>";
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attachments/att1" && m === "GET",
        handle: () => jsonResponse({ attachmentId: "att1", title: "note.txt", mime: "text/plain" }),
      },
      {
        test: (p, m) => p === "/etapi/attachments/att1/content" && m === "GET",
        handle: () => textResponse(rawContent),
      },
    ]);
    const tool = createGetAttachmentTool(handle);
    const result = (await tool.execute("call1", { attachment_id: "att1", include_content: true }))
      .details as {
      content: string;
    };
    expect(result.content).toBe(rawContent);
  });
});

describe("trilium_update_attachment", () => {
  it("writes content verbatim (no formatContentForWrite -- see attachments.ts's own doc comment)", async () => {
    let putBody: string | undefined;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attachments/att1/content" && m === "PUT",
        handle: async (req) => {
          putBody = await req.text();
          return new Response(null, { status: 204 });
        },
      },
      {
        test: (p, m) => p === "/etapi/attachments/att1" && m === "GET",
        handle: () => jsonResponse({ attachmentId: "att1" }),
      },
    ]);
    const tool = createUpdateAttachmentTool(handle);
    await tool.execute("call1", { attachment_id: "att1", content: "plain text, not wrapped" });
    expect(putBody).toBe("plain text, not wrapped");
  });

  // Regression test for a real bug found in review: the content PUT's
  // result was discarded, so a failed write fell through to a re-fetch
  // and reported stale content as success. With no metadata fields given,
  // a content-only update no longer does a pre-write GET at all (see the
  // next test) -- so this asserts zero GETs happened, not one.
  it("throws instead of silently returning stale content when the content PUT fails", async () => {
    let getCount = 0;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attachments/att1/content" && m === "PUT",
        handle: () => errorResponse(400, "VALIDATION_ERROR", "bad content"),
      },
      {
        test: (p, m) => p === "/etapi/attachments/att1" && m === "GET",
        handle: () => {
          getCount += 1;
          return jsonResponse({ attachmentId: "att1" });
        },
      },
    ]);
    const tool = createUpdateAttachmentTool(handle);
    await expect(tool.execute("call1", { attachment_id: "att1", content: "x" })).rejects.toThrow(
      /VALIDATION_ERROR/,
    );
    expect(getCount).toBe(0);
  });

  // Regression test for a real perf issue found in review: a content-only
  // update used to do a pre-write GET whose result was immediately
  // discarded, then a second GET after the PUT -- 3 calls where 2 suffice.
  it("does a content-only update in exactly one GET (no wasted pre-write fetch)", async () => {
    let getCount = 0;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attachments/att1/content" && m === "PUT",
        handle: () => new Response(null, { status: 204 }),
      },
      {
        test: (p, m) => p === "/etapi/attachments/att1" && m === "GET",
        handle: () => {
          getCount += 1;
          return jsonResponse({ attachmentId: "att1" });
        },
      },
    ]);
    const tool = createUpdateAttachmentTool(handle);
    await tool.execute("call1", { attachment_id: "att1", content: "hello" });
    expect(getCount).toBe(1);
  });
});

describe("trilium_delete_attachment", () => {
  it("returns deleted:true on a real 204 success", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attachments/att1" && m === "DELETE",
        handle: () => new Response(null, { status: 204 }),
      },
    ]);
    const tool = createDeleteAttachmentTool(handle);
    const result = await tool.execute("call1", { attachment_id: "att1" });
    expect(result.details).toEqual({ attachment_id: "att1", deleted: true });
  });

  // Regression test for a real bug found in review: the DELETE call's
  // result was never inspected, so a failed delete still reported
  // deleted:true.
  it("throws instead of reporting success when the DELETE actually fails", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/attachments/att1" && m === "DELETE",
        handle: () => errorResponse(404, "ATTACHMENT_NOT_FOUND", "no such attachment"),
      },
    ]);
    const tool = createDeleteAttachmentTool(handle);
    await expect(tool.execute("call1", { attachment_id: "att1" })).rejects.toThrow(
      /ATTACHMENT_NOT_FOUND/,
    );
  });
});

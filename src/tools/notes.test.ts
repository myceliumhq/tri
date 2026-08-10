import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriliumClient } from "../client.js";
import type { SemanticSearchHandle } from "../semantic/handle.js";
import type { SemanticMatch } from "../semantic/types.js";
import {
  createCreateNoteTool,
  createDeleteNoteTool,
  createGetNoteTool,
  createGetRecentChangesTool,
  createReadNoteContentTool,
  createSearchNotesTool,
  createUndeleteNoteTool,
  createUpdateNoteTool,
} from "./notes.js";

const BASE_URL = "https://trilium.example.com";

type Route = {
  test: (pathname: string, method: string) => boolean;
  handle: (request: Request) => Response | unknown;
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

function noSemanticHandle(): Promise<SemanticSearchHandle> {
  return Promise.resolve({ available: false, search: async () => [], dispose: async () => {} });
}
function fakeSemanticHandle(matches: SemanticMatch[]): Promise<SemanticSearchHandle> {
  return Promise.resolve({ available: true, search: async () => matches, dispose: async () => {} });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function baseNote(overrides: Record<string, unknown> = {}) {
  return {
    noteId: "note1",
    title: "Test Note",
    type: "text",
    mime: "text/html",
    isProtected: false,
    blobId: "blob1",
    attributes: [],
    parentNoteIds: ["root"],
    childNoteIds: [],
    parentBranchIds: ["root_note1"],
    childBranchIds: [],
    dateCreated: "2026-01-01 00:00:00.000+0000",
    dateModified: "2026-01-01 00:00:00.000+0000",
    utcDateCreated: "2026-01-01 00:00:00.000Z",
    utcDateModified: "2026-01-01 00:00:00.000Z",
    ...overrides,
  };
}

describe("trilium_delete_note", () => {
  it("returns deleted:true on a real 204 success", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "DELETE",
        handle: () => new Response(null, { status: 204 }),
      },
    ]);
    const tool = createDeleteNoteTool(handle);
    const result = await tool.execute("call1", { note_id: "note1" });
    expect(result.details).toEqual({ note_id: "note1", deleted: true });
  });

  // Regression test for a real bug found in review: the DELETE call's
  // result was never inspected, so a failed delete still reported
  // deleted:true.
  it("throws instead of reporting success when the DELETE actually fails", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "DELETE",
        handle: () => errorResponse(400, "NOTE_IS_PROTECTED", "Note 'note1' is protected"),
      },
    ]);
    const tool = createDeleteNoteTool(handle);
    await expect(tool.execute("call1", { note_id: "note1" })).rejects.toThrow(/NOTE_IS_PROTECTED/);
  });
});

describe("trilium_undelete_note", () => {
  it("returns success on a real success response", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/undelete" && m === "POST",
        handle: () => jsonResponse({ success: true }),
      },
    ]);
    const tool = createUndeleteNoteTool(handle);
    const result = await tool.execute("call1", { note_id: "note1" });
    expect(result.details).toEqual({ note_id: "note1", success: true });
  });
});

describe("trilium_update_note", () => {
  it("patches metadata-only changes without touching content", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "PATCH",
        handle: () => jsonResponse(baseNote({ title: "New Title" })),
      },
    ]);
    const tool = createUpdateNoteTool(handle);
    const result = await tool.execute("call1", { note_id: "note1", title: "New Title" });
    expect((result.details as { title: string }).title).toBe("New Title");
  });

  it("writes content verbatim/auto-wrapped, then re-fetches the note", async () => {
    let putBody: string | undefined;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "PUT",
        handle: async (req) => {
          putBody = await req.text();
          return new Response(null, { status: 204 });
        },
      },
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => jsonResponse(baseNote()),
      },
    ]);
    const tool = createUpdateNoteTool(handle);
    await tool.execute("call1", { note_id: "note1", content: "hello" });
    expect(putBody).toBe("<p>hello</p>");
  });

  // Regression test for a real bug found in review: the content PUT's
  // result was discarded, so a failed write fell through to a re-fetch and
  // reported the note's stale, pre-write content back as success. With no
  // metadata fields given, effectiveType is unknown and must be resolved
  // before deciding whether to Markdown-convert (see the note below) --
  // that's the one GET that legitimately happens here, before the PUT is
  // even attempted; the PUT then fails and there must be no *second* GET
  // afterward pretending the write succeeded.
  it("throws instead of silently returning stale content when the content PUT fails", async () => {
    let getCount = 0;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "PUT",
        handle: () => errorResponse(400, "NOTE_IS_PROTECTED", "cannot write protected note"),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => {
          getCount += 1;
          return jsonResponse(baseNote());
        },
      },
    ]);
    const tool = createUpdateNoteTool(handle);
    await expect(
      tool.execute("call1", { note_id: "note1", content: "new content" }),
    ).rejects.toThrow(/NOTE_IS_PROTECTED/);
    expect(getCount).toBe(1);
  });

  // A content-only update whose note type is genuinely unknown (no
  // metadata change given, so no PATCH response to read type off of) pays
  // for one metadata GET to resolve it before writing -- this is a
  // deliberate safety trade-off, not a regression: without it, the
  // Markdown conversion could silently mangle a `code` note's raw source.
  // Total: type-check GET + content PUT + final result GET = 3 calls (2 of
  // them to the same GET route, hence getCount reaching 2).
  it("resolves the note's type via one extra GET before deciding whether to convert", async () => {
    let getCount = 0;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "PUT",
        handle: () => new Response(null, { status: 204 }),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => {
          getCount += 1;
          return jsonResponse(baseNote());
        },
      },
    ]);
    const tool = createUpdateNoteTool(handle);
    await tool.execute("call1", { note_id: "note1", content: "hello" });
    expect(getCount).toBe(2);
  });

  // When a metadata change is given in the same call, the PATCH response
  // already carries the note's type -- no extra GET needed before deciding
  // whether to Markdown-convert the content.
  it("skips the type-check GET when a metadata change already reveals the type", async () => {
    let getCount = 0;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "PATCH",
        handle: () => jsonResponse(baseNote({ title: "New Title" })),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "PUT",
        handle: () => new Response(null, { status: 204 }),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => {
          getCount += 1;
          return jsonResponse(baseNote());
        },
      },
    ]);
    const tool = createUpdateNoteTool(handle);
    await tool.execute("call1", { note_id: "note1", title: "New Title", content: "hello" });
    expect(getCount).toBe(1);
  });

  it("appends to existing content server-side without the caller resending the body", async () => {
    let putBody: string | undefined;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
        handle: () => textResponse("<p>existing</p>"),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "PUT",
        handle: async (req) => {
          putBody = await req.text();
          return new Response(null, { status: 204 });
        },
      },
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => jsonResponse(baseNote()),
      },
    ]);
    const tool = createUpdateNoteTool(handle);
    await tool.execute("call1", {
      note_id: "note1",
      content: "more",
      content_mode: "append",
    });
    expect(putBody).toBe("<p>existing</p><p>more</p>");
  });

  // Regression test: appending to a note with no existing content used to
  // throw "trilium ETAPI returned no data" -- the GET for `existing` sees a
  // 200 with an empty body, which openapi-fetch surfaces as data: undefined
  // the same way it does for a bare 204 (see client.test.ts).
  it("appends to an empty note without throwing", async () => {
    let putBody: string | undefined;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
        handle: () => textResponse(""),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "PUT",
        handle: async (req) => {
          putBody = await req.text();
          return new Response(null, { status: 204 });
        },
      },
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => jsonResponse(baseNote()),
      },
    ]);
    const tool = createUpdateNoteTool(handle);
    await tool.execute("call1", {
      note_id: "note1",
      content: "first content",
      content_mode: "append",
    });
    expect(putBody).toBe("<p>first content</p>");
  });

  describe("content_mode: edit", () => {
    it("applies a targeted find-and-replace edit to a code note without resending the whole body", async () => {
      let putBody: string | undefined;
      const handle = setup([
        {
          test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
          handle: () => jsonResponse(baseNote({ type: "code", mime: "application/javascript" })),
        },
        {
          test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
          handle: () => textResponse("const x = 1;\nconst y = 2;"),
        },
        {
          test: (p, m) => p === "/etapi/notes/note1/content" && m === "PUT",
          handle: async (req) => {
            putBody = await req.text();
            return new Response(null, { status: 204 });
          },
        },
      ]);
      const tool = createUpdateNoteTool(handle);
      await tool.execute("call1", {
        note_id: "note1",
        content_mode: "edit",
        edits: [{ old_text: "const x = 1;", new_text: "const x = 100;" }],
      });
      expect(putBody).toBe("const x = 100;\nconst y = 2;");
    });

    it("applies multiple edits in order", async () => {
      let putBody: string | undefined;
      const handle = setup([
        {
          test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
          handle: () => jsonResponse(baseNote({ type: "code" })),
        },
        {
          test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
          handle: () => textResponse("hello world"),
        },
        {
          test: (p, m) => p === "/etapi/notes/note1/content" && m === "PUT",
          handle: async (req) => {
            putBody = await req.text();
            return new Response(null, { status: 204 });
          },
        },
      ]);
      const tool = createUpdateNoteTool(handle);
      await tool.execute("call1", {
        note_id: "note1",
        content_mode: "edit",
        edits: [
          { old_text: "hello", new_text: "hi there" },
          { old_text: "hi there world", new_text: "hi there, world!" },
        ],
      });
      expect(putBody).toBe("hi there, world!");
    });

    it("rejects content_mode: edit on a 'text' note before ever fetching its content", async () => {
      let contentFetched = false;
      const handle = setup([
        {
          test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
          handle: () => jsonResponse(baseNote({ type: "text" })),
        },
        {
          test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
          handle: () => {
            contentFetched = true;
            return textResponse("<p>hello</p>");
          },
        },
      ]);
      const tool = createUpdateNoteTool(handle);
      await expect(
        tool.execute("call1", {
          note_id: "note1",
          content_mode: "edit",
          edits: [{ old_text: "hello", new_text: "hi" }],
        }),
      ).rejects.toThrow(/isn't supported for 'text' notes/);
      expect(contentFetched).toBe(false);
    });

    it("throws with no write when oldText isn't found", async () => {
      const handle = setup([
        {
          test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
          handle: () => jsonResponse(baseNote({ type: "code" })),
        },
        {
          test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
          handle: () => textResponse("hello world"),
        },
        {
          test: (p, m) => p === "/etapi/notes/note1/content" && m === "PUT",
          handle: () => {
            throw new Error("should never PUT when an edit fails to match");
          },
        },
      ]);
      const tool = createUpdateNoteTool(handle);
      await expect(
        tool.execute("call1", {
          note_id: "note1",
          content_mode: "edit",
          edits: [{ old_text: "missing", new_text: "x" }],
        }),
      ).rejects.toThrow(/not found/);
    });

    it("throws when edits is empty", async () => {
      const handle = setup([]);
      const tool = createUpdateNoteTool(handle);
      await expect(
        tool.execute("call1", { note_id: "note1", content_mode: "edit", edits: [] }),
      ).rejects.toThrow(/requires at least one entry/);
    });

    it("skips the type-check GET when a metadata change already reveals the type", async () => {
      let getCount = 0;
      const handle = setup([
        {
          test: (p, m) => p === "/etapi/notes/note1" && m === "PATCH",
          handle: () => jsonResponse(baseNote({ type: "code", title: "New Title" })),
        },
        {
          test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
          handle: () => textResponse("hello"),
        },
        {
          test: (p, m) => p === "/etapi/notes/note1/content" && m === "PUT",
          handle: () => new Response(null, { status: 204 }),
        },
        {
          test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
          handle: () => {
            getCount += 1;
            return jsonResponse(baseNote({ type: "code" }));
          },
        },
      ]);
      const tool = createUpdateNoteTool(handle);
      await tool.execute("call1", {
        note_id: "note1",
        title: "New Title",
        content_mode: "edit",
        edits: [{ old_text: "hello", new_text: "hi" }],
      });
      // Only the final result GET, not an extra type-check GET before it.
      expect(getCount).toBe(1);
    });
  });
});

describe("trilium_get_note", () => {
  it("resolves parent/child ids to names by default", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => jsonResponse(baseNote({ parentNoteIds: ["root"], childNoteIds: [] })),
      },
      {
        test: (p, m) => p === "/etapi/notes/root" && m === "GET",
        handle: () => jsonResponse(baseNote({ noteId: "root", title: "Root", parentNoteIds: [] })),
      },
    ]);
    const tool = createGetNoteTool(handle);
    const result = (await tool.execute("call1", { note_id: "note1" })).details as {
      parents: { noteId: string; title: string }[];
      names_truncated?: boolean;
    };
    expect(result.parents).toEqual([
      { noteId: "root", branchId: "root_note1", title: "Root", type: "text" },
    ]);
    expect(result.names_truncated).toBeUndefined();
  });

  // Regression test for a real bug found in review: resolve_names' own
  // doc comment promises a single 50-id cap shared across parents and
  // children, but the old implementation applied 50 to each independently
  // (up to 100 total). 60 parents + 60 children should now resolve
  // exactly 50 parents and 0 children (parents get first claim).
  it("shares a single combined 50-id budget across parents and children, not 50 each", async () => {
    const parentIds = Array.from({ length: 60 }, (_, i) => `parent${i}`);
    const childIds = Array.from({ length: 60 }, (_, i) => `child${i}`);
    const routes: Route[] = [
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => jsonResponse(baseNote({ parentNoteIds: parentIds, childNoteIds: childIds })),
      },
      {
        test: (p, m) => /^\/etapi\/notes\/(parent|child)\d+$/.test(p) && m === "GET",
        handle: (req) => {
          const id = new URL(req.url).pathname.split("/").at(-1);
          return jsonResponse(baseNote({ noteId: id, title: id }));
        },
      },
    ];
    const handle = setup(routes);
    const tool = createGetNoteTool(handle);
    const result = (await tool.execute("call1", { note_id: "note1" })).details as {
      parents: unknown[];
      children: unknown[];
      names_truncated?: boolean;
    };
    expect(result.parents).toHaveLength(50);
    expect(result.children).toHaveLength(0);
    expect(result.names_truncated).toBe(true);
  });

  it("fetches attachments, revisions, and an excerpt_search snippet when requested", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => jsonResponse(baseNote({ parentNoteIds: [], childNoteIds: [] })),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1/attachments" && m === "GET",
        handle: () => jsonResponse([{ attachmentId: "a1", title: "att" }]),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1/revisions" && m === "GET",
        handle: () => jsonResponse([{ revisionId: "r1" }]),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
        handle: () => textResponse("<p>some content with findme in it</p>"),
      },
    ]);
    const tool = createGetNoteTool(handle);
    const result = (
      await tool.execute("call1", {
        note_id: "note1",
        resolve_names: false,
        include_attachments: true,
        include_revisions: true,
        excerpt_search: "findme",
      })
    ).details as { attachments: unknown[]; revisions: unknown[]; content_snippet: string };
    expect(result.attachments).toEqual([{ attachmentId: "a1", title: "att" }]);
    expect(result.revisions).toEqual([{ revisionId: "r1" }]);
    expect(result.content_snippet).toContain("findme");
  });

  // Regression test for a real token-efficiency issue found in review: the
  // raw parent/child id arrays used to survive alongside the resolved
  // parents/children, encoding the same tree edges twice. Also checks that
  // attributes get flattened into labels/relations here the same way
  // trilium_search_notes already does.
  it("drops raw parent/child id arrays once resolved, and flattens attributes", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () =>
          jsonResponse(
            baseNote({
              parentNoteIds: ["root"],
              childNoteIds: [],
              attributes: [{ attributeId: "a1", type: "label", name: "archived" }],
            }),
          ),
      },
      {
        test: (p, m) => p === "/etapi/notes/root" && m === "GET",
        handle: () => jsonResponse(baseNote({ noteId: "root", title: "Root", parentNoteIds: [] })),
      },
    ]);
    const tool = createGetNoteTool(handle);
    const result = (await tool.execute("call1", { note_id: "note1" })).details as Record<
      string,
      unknown
    >;
    expect(result.parentNoteIds).toBeUndefined();
    expect(result.childNoteIds).toBeUndefined();
    expect(result.parentBranchIds).toBeUndefined();
    expect(result.childBranchIds).toBeUndefined();
    expect(result.labels).toEqual(["archived"]);
  });
});

describe("trilium_read_note_content", () => {
  it("converts a text note's HTML content to Markdown by default and bounds the range", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
        handle: () => textResponse("<h1>line one</h1><p>line two</p>"),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => jsonResponse(baseNote()),
      },
    ]);
    const tool = createReadNoteContentTool(handle);
    const result = (await tool.execute("call1", { note_id: "note1" })).details as {
      content: string;
      content_status: string;
    };
    expect(result.content).toBe("# line one\n\nline two");
    expect(result.content_status).toBe("present");
  });

  it("returns raw HTML when raw_html is true", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
        handle: () => textResponse("<p>keep me</p>"),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => jsonResponse(baseNote()),
      },
    ]);
    const tool = createReadNoteContentTool(handle);
    const result = (await tool.execute("call1", { note_id: "note1", raw_html: true })).details as {
      content: string;
    };
    expect(result.content).toBe("<p>keep me</p>");
  });

  // Regression test for the real bug this whole fix responds to (see
  // html.test.ts): a `code` note's raw source must never be run through
  // HTML-to-Markdown conversion, gated on real type metadata rather than
  // sniffing whether the content happens to contain "#"/"-" characters.
  it("returns a code note's content byte-for-byte, never Markdown-converted", async () => {
    const rawSource = "# not a heading\nconst x = 1;\n- not a list";
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
        handle: () => textResponse(rawSource),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => jsonResponse(baseNote({ type: "code", mime: "application/javascript" })),
      },
    ]);
    const tool = createReadNoteContentTool(handle);
    const result = (await tool.execute("call1", { note_id: "note1" })).details as {
      content: string;
    };
    expect(result.content).toBe(rawSource);
  });

  // Regression test: an empty-content note is a 200 with an empty body,
  // which openapi-fetch surfaces as data: undefined the same way it does
  // for a bare 204 (see client.test.ts). Before coercing that to "" at this
  // call site, reading an empty note's content threw "trilium ETAPI
  // returned no data" instead of reporting content_status: "empty".
  it("reports content_status: 'empty' for a note with no content, instead of throwing", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
        handle: () => textResponse(""),
      },
      {
        test: (p, m) => p === "/etapi/notes/note1" && m === "GET",
        handle: () => jsonResponse(baseNote()),
      },
    ]);
    const tool = createReadNoteContentTool(handle);
    const result = (await tool.execute("call1", { note_id: "note1" })).details as {
      content: string;
      content_status: string;
    };
    expect(result.content).toBe("");
    expect(result.content_status).toBe("empty");
  });
});

describe("trilium_create_note", () => {
  it("auto-wraps plain-text content into HTML paragraphs", async () => {
    let postBody: unknown;
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/create-note" && m === "POST",
        handle: async (req) => {
          postBody = await req.json();
          return jsonResponse({ note: baseNote(), branch: { branchId: "root_note1" } }, 201);
        },
      },
    ]);
    const tool = createCreateNoteTool(handle);
    await tool.execute("call1", {
      parent_note_id: "root",
      title: "New note",
      type: "text",
      content: "hello world",
    });
    expect((postBody as { content: string }).content).toBe("<p>hello world</p>");
  });
});

describe("trilium_search_notes", () => {
  it("returns lexical results with a url and no content_snippet when the semantic layer found nothing", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes" && m === "GET",
        handle: () => jsonResponse({ results: [baseNote()] }),
      },
    ]);
    const tool = createSearchNotesTool(handle, noSemanticHandle());
    const result = (await tool.execute("call1", { search: "test" })).details as {
      results: { url: string; content_snippet?: string }[];
    };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.url).toBe(`${BASE_URL}/#note1`);
    expect(result.results[0]?.content_snippet).toBeUndefined();
  });

  it("merges in a semantic-only match by fetching it and attaching a content_snippet", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes" && m === "GET",
        handle: () => jsonResponse({ results: [] }),
      },
      {
        test: (p, m) => p === "/etapi/notes/note2" && m === "GET",
        handle: () => jsonResponse(baseNote({ noteId: "note2", title: "Semantic Match" })),
      },
    ]);
    const matches: SemanticMatch[] = [
      { noteId: "note2", snippet: "matched text", score: 0.9, startLine: 1, endLine: 2 },
    ];
    const tool = createSearchNotesTool(handle, fakeSemanticHandle(matches));
    const result = (await tool.execute("call1", { search: "test" })).details as {
      results: { noteId: string; content_snippet: string }[];
    };
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.noteId).toBe("note2");
    expect(result.results[0]?.content_snippet).toBe("matched text");
  });

  // Regression test for a real goal-reachability issue found in review:
  // the tool's own description promised a raw `attributes` array but the
  // implementation dropped relations entirely -- and stripped several
  // other dead fields (blobId, isProtected, raw id arrays, duplicate UTC
  // timestamps) that had no agent value.
  it("flattens labels/relations and strips dead fields from results", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes" && m === "GET",
        handle: () =>
          jsonResponse({
            results: [
              baseNote({
                attributes: [
                  { attributeId: "a1", type: "label", name: "priority", value: "high" },
                  { attributeId: "a2", type: "relation", name: "author", value: "note9" },
                ],
              }),
            ],
          }),
      },
    ]);
    const tool = createSearchNotesTool(handle, noSemanticHandle());
    const result = (await tool.execute("call1", { search: "test" })).details as {
      results: Record<string, unknown>[];
    };
    const [note] = result.results;
    expect(note?.labels).toEqual(["priority=high"]);
    expect(note?.relations).toEqual([{ name: "author", value: "note9", attribute_id: "a2" }]);
    expect(note?.attributes).toBeUndefined();
    expect(note?.blobId).toBeUndefined();
    expect(note?.isProtected).toBeUndefined();
    expect(note?.parentNoteIds).toBeUndefined();
    expect(note?.childNoteIds).toBeUndefined();
    expect(note?.utcDateCreated).toBeUndefined();
    expect(note?.utcDateModified).toBeUndefined();
  });

  // Regression test for a real goal-reachability issue found in review:
  // there was no way to tell whether a search hit the 100-result cap and
  // silently omitted matches.
  it("flags truncated:true when the result count hits the requested limit", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes" && m === "GET",
        handle: () =>
          jsonResponse({ results: [baseNote({ noteId: "n1" }), baseNote({ noteId: "n2" })] }),
      },
    ]);
    const tool = createSearchNotesTool(handle, noSemanticHandle());
    const result = (await tool.execute("call1", { search: "test", limit: 2 })).details as {
      truncated?: boolean;
    };
    expect(result.truncated).toBe(true);
  });

  it("omits truncated when fewer results than the limit come back", async () => {
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes" && m === "GET",
        handle: () => jsonResponse({ results: [baseNote()] }),
      },
    ]);
    const tool = createSearchNotesTool(handle, noSemanticHandle());
    const result = (await tool.execute("call1", { search: "test", limit: 5 })).details as {
      truncated?: boolean;
    };
    expect(result.truncated).toBeUndefined();
  });
});

describe("trilium_get_recent_changes", () => {
  it("trims to the requested limit while reporting the true total available", async () => {
    const changes = Array.from({ length: 10 }, (_, i) => ({ noteId: `n${i}`, title: `n${i}` }));
    const handle = setup([
      {
        test: (p, m) => p === "/etapi/notes/history" && m === "GET",
        handle: () => jsonResponse(changes),
      },
    ]);
    const tool = createGetRecentChangesTool(handle);
    const result = (await tool.execute("call1", { limit: 3 })).details as {
      changes: unknown[];
      count: number;
      total_available: number;
    };
    expect(result.count).toBe(3);
    expect(result.total_available).toBe(10);
  });
});

import { DEFAULT_SEMANTIC_INDEX_CONFIG } from "@myceliumhq/index";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriliumClient } from "../client.js";
import { createTriliumSourceAdapter } from "./source-adapter.js";

const BASE_URL = "https://trilium.example.com";
const PAGE_SIZE = DEFAULT_SEMANTIC_INDEX_CONFIG.maxItemsPerSync;

type Route = {
  test: (pathname: string, method: string) => boolean;
  handle: (request: Request) => unknown;
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
function textResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
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

function adapter() {
  const client = createTriliumClient({ baseUrl: BASE_URL, apiToken: "test-token" });
  return createTriliumSourceAdapter(Promise.resolve(client));
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

type NoteFixture = { noteId: string; blobId: string; utcDateModified: string; type?: string };

function fixture(id: string, blobId: string, modified: string, type = "text"): NoteFixture {
  return { noteId: id, blobId, utcDateModified: modified, type };
}

describe("createTriliumSourceAdapter", () => {
  it("yields id/contentHash/modifiedAt for every note in a single page", async () => {
    const notesRoute: Route = {
      test: (p, m) => p === "/etapi/notes" && m === "GET",
      handle: () => ({
        results: [
          fixture("note1", "blobA", "2026-01-01 00:00:00.000Z"),
          fixture("note2", "blobB", "2026-01-02 00:00:00.000Z"),
        ],
      }),
    };
    stubFetch([notesRoute]);
    const sourceAdapter = adapter();
    const items = await collect(sourceAdapter.listChanged(undefined));

    expect(items).toEqual([
      { id: "note1", contentHash: "blobA", modifiedAt: "2026-01-01 00:00:00.000Z" },
      { id: "note2", contentHash: "blobB", modifiedAt: "2026-01-02 00:00:00.000Z" },
    ]);
  });

  it("sends note.utcDateModified >= <since> (inclusive) when a watermark is given", async () => {
    const notesRoute: Route = {
      test: (p, m) => p === "/etapi/notes" && m === "GET",
      handle: () => ({ results: [] }),
    };
    const fetchMock = stubFetch([notesRoute]);
    const sourceAdapter = adapter();
    await collect(sourceAdapter.listChanged("2026-01-01 00:00:00.000Z"));

    const request = fetchMock.mock.calls[0]?.[0] as Request;
    const search = new URL(request.url).searchParams.get("search");
    expect(search).toContain('note.utcDateModified >= "2026-01-01 00:00:00.000Z"');
  });

  it("never sends a search string starting with '(' -- Trilium's ETAPI search silently matches nothing for a leading paren", async () => {
    const notesRoute: Route = {
      test: (p, m) => p === "/etapi/notes" && m === "GET",
      handle: () => ({ results: [] }),
    };
    const fetchMock = stubFetch([notesRoute]);

    await collect(adapter().listChanged(undefined));
    const noCursorRequest = fetchMock.mock.calls[0]?.[0] as Request;
    const noCursorSearch = new URL(noCursorRequest.url).searchParams.get("search");
    expect(noCursorSearch?.startsWith("(")).toBe(false);

    fetchMock.mockClear();
    await collect(adapter().listChanged("2026-01-01 00:00:00.000Z"));
    const withCursorRequest = fetchMock.mock.calls[0]?.[0] as Request;
    const withCursorSearch = new URL(withCursorRequest.url).searchParams.get("search");
    expect(withCursorSearch?.startsWith("(")).toBe(false);
  });

  it("pages by re-querying with an advancing cursor when a page comes back full", async () => {
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) =>
      fixture(`note${i}`, `blob${i}`, `2026-01-01 00:00:${String(i).padStart(2, "0")}.000Z`),
    );
    const secondPage = [fixture("noteLast", "blobLast", "2026-01-02 00:00:00.000Z")];
    let call = 0;
    const notesRoute: Route = {
      test: (p, m) => p === "/etapi/notes" && m === "GET",
      handle: () => {
        call += 1;
        return { results: call === 1 ? firstPage : secondPage };
      },
    };
    const fetchMock = stubFetch([notesRoute]);
    const sourceAdapter = adapter();
    const items = await collect(sourceAdapter.listChanged(undefined));

    expect(items).toHaveLength(PAGE_SIZE + 1);
    expect(items.at(-1)).toMatchObject({ id: "noteLast" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondRequest = fetchMock.mock.calls[1]?.[0] as Request;
    const search = new URL(secondRequest.url).searchParams.get("search");
    expect(search).toContain(`note.utcDateModified >= "${firstPage.at(-1)?.utcDateModified}"`);
  });

  it("stops instead of looping forever when every note in a full page shares one timestamp", async () => {
    const stuckPage = Array.from({ length: PAGE_SIZE }, (_, i) =>
      fixture(`note${i}`, `blob${i}`, "2026-01-01 00:00:00.000Z"),
    );
    const notesRoute: Route = {
      test: (p, m) => p === "/etapi/notes" && m === "GET",
      handle: () => ({ results: stuckPage }),
    };
    const fetchMock = stubFetch([notesRoute]);
    const sourceAdapter = adapter();
    const items = await collect(sourceAdapter.listChanged("2026-01-01 00:00:00.000Z"));

    expect(items).toHaveLength(PAGE_SIZE);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("listAllIds yields every indexable note id, paging by the same advancing cursor as listChanged", async () => {
    const firstPage = Array.from({ length: PAGE_SIZE }, (_, i) =>
      fixture(`note${i}`, `blob${i}`, `2026-01-01 00:00:${String(i).padStart(2, "0")}.000Z`),
    );
    const secondPage = [fixture("noteLast", "blobLast", "2026-01-02 00:00:00.000Z")];
    let call = 0;
    const notesRoute: Route = {
      test: (p, m) => p === "/etapi/notes" && m === "GET",
      handle: () => {
        call += 1;
        return { results: call === 1 ? firstPage : secondPage };
      },
    };
    const fetchMock = stubFetch([notesRoute]);
    const sourceAdapter = adapter();
    const ids = await collect(sourceAdapter.listAllIds?.() ?? (async function* () {})());

    expect(ids).toHaveLength(PAGE_SIZE + 1);
    expect(ids.at(-1)).toBe("noteLast");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fetchContent converts a text note's HTML to markdown using the type cached by listChanged", async () => {
    const notesRoute: Route = {
      test: (p, m) => p === "/etapi/notes" && m === "GET",
      handle: () => ({ results: [fixture("note1", "blobA", "2026-01-01 00:00:00.000Z", "text")] }),
    };
    const contentRoute: Route = {
      test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
      handle: () => textResponse("<p>hello</p>"),
    };
    stubFetch([notesRoute, contentRoute]);
    const sourceAdapter = adapter();
    await collect(sourceAdapter.listChanged(undefined));

    const content = await sourceAdapter.fetchContent("note1");
    expect(content).toBe("hello");
  });

  it('fetchContent returns "" for an empty-content note instead of throwing', async () => {
    const notesRoute: Route = {
      test: (p, m) => p === "/etapi/notes" && m === "GET",
      handle: () => ({ results: [fixture("note1", "blobA", "2026-01-01 00:00:00.000Z", "text")] }),
    };
    const contentRoute: Route = {
      test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
      handle: () => textResponse(""),
    };
    stubFetch([notesRoute, contentRoute]);
    const sourceAdapter = adapter();
    await collect(sourceAdapter.listChanged(undefined));

    const content = await sourceAdapter.fetchContent("note1");
    expect(content).toBe("");
  });

  it("fetchContent leaves a code note's content untouched (no markdown conversion)", async () => {
    const notesRoute: Route = {
      test: (p, m) => p === "/etapi/notes" && m === "GET",
      handle: () => ({ results: [fixture("note1", "blobA", "2026-01-01 00:00:00.000Z", "code")] }),
    };
    const contentRoute: Route = {
      test: (p, m) => p === "/etapi/notes/note1/content" && m === "GET",
      handle: () => textResponse("const x = 1;\r\n"),
    };
    stubFetch([notesRoute, contentRoute]);
    const sourceAdapter = adapter();
    await collect(sourceAdapter.listChanged(undefined));

    const content = await sourceAdapter.fetchContent("note1");
    expect(content).toBe("const x = 1;\n");
  });

  it("fetchContent falls back to treating an uncached note as text", async () => {
    const contentRoute: Route = {
      test: (p, m) => p === "/etapi/notes/note42/content" && m === "GET",
      handle: () => textResponse("<p>direct</p>"),
    };
    stubFetch([contentRoute]);
    const sourceAdapter = adapter();

    const content = await sourceAdapter.fetchContent("note42");
    expect(content).toBe("direct");
  });
});

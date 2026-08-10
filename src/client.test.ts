import { afterEach, describe, expect, it, vi } from "vitest";
import { createTriliumClient, unwrap } from "./client.js";

describe("unwrap", () => {
  it("returns data on success", () => {
    expect(unwrap({ data: { noteId: "abc1" } })).toEqual({ noteId: "abc1" });
  });

  it("throws with the ETAPI error code and message", () => {
    expect(() =>
      unwrap({
        error: { status: 400, code: "NOTE_IS_PROTECTED", message: "Note 'x' is protected" },
      }),
    ).toThrow(/NOTE_IS_PROTECTED: Note 'x' is protected/);
  });

  it("falls back to stringifying an error without a code/message shape", () => {
    expect(() => unwrap({ error: "plain string error" })).toThrow(/plain string error/);
  });

  it("throws when data is missing", () => {
    expect(() => unwrap({})).toThrow(/no data/);
  });

  it("surfaces the HTTP status for a non-2xx response with an empty body", () => {
    const response = new Response(null, { status: 401, statusText: "Unauthorized" });
    expect(() => unwrap({ response })).toThrow(/401/);
  });

  // Regression test for a real bug found testing semantic search against a
  // live Trilium instance: openapi-fetch returns `data: undefined` for any
  // *successful* response with an empty body, not just a bare 204 (it
  // special-cases `Content-Length: 0` the same way). An empty-content note
  // (a container/organizer note with no text of its own -- entirely
  // ordinary, not an error) is a 200 with an empty body, so unwrap() used to
  // throw "no data" for it, breaking semantic sync (every such note failed
  // to index) and read_note_content/trilium_update_note (both crashed
  // instead of returning/editing empty content).
  it("returns undefined, not a thrown error, for a successful response with an empty body that isn't a bare 204", () => {
    const response = new Response("", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    expect(unwrap({ response })).toBeUndefined();
  });
});

describe("createTriliumClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the token as an unprefixed Authorization header, appends /etapi, and strips trailing slashes", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createTriliumClient({
      baseUrl: "https://trilium.example.com/",
      apiToken: "test-token",
    });
    await client.GET("/notes", { params: { query: { search: "test" } } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0]?.[0] as Request;
    expect(request.url).toBe("https://trilium.example.com/etapi/notes?search=test");
    expect(request.headers.get("authorization")).toBe("test-token");
  });

  // Regression test for a real bug found testing against a live Trilium
  // instance: openapi-fetch defaults every response to JSON.parse
  // regardless of the actual Content-Type header (confirmed by reading its
  // source -- `parseAs = "json"` is a static default, not content-type
  // sniffed). Content endpoints (/notes/{id}/content and friends) always
  // return text/html, never JSON -- a real response body like
  // "<p>hello</p>" threw "Unexpected token '<' ... is not valid JSON"
  // until every content-reading call passed `parseAs: "text"` explicitly.
  it("returns the raw text body for a content endpoint given parseAs: 'text', instead of throwing a JSON parse error", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        new Response("<p>hello</p>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = createTriliumClient({
      baseUrl: "https://trilium.example.com",
      apiToken: "test-token",
    });
    const result = await client.GET("/notes/{noteId}/content", {
      params: { path: { noteId: "abc1" } },
      parseAs: "text",
    });

    expect(result.error).toBeUndefined();
    expect(result.data).toBe("<p>hello</p>");
  });
});

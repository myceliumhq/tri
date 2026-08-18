import { createInterface } from "node:readline/promises";
import { type CliError, writeJson, writeStderr, writeStdout } from "@myceliumhq/toolkit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClientHandle } from "../config.js";
import {
  createNoteAction,
  createRevisionAction,
  deleteNoteAction,
  listRevisionsAction,
  readRevisionAction,
  undeleteNoteAction,
  writeNoteAction,
} from "./note.js";

vi.mock("@myceliumhq/toolkit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myceliumhq/toolkit")>();
  return { ...actual, writeJson: vi.fn(), writeStderr: vi.fn(), writeStdout: vi.fn() };
});
vi.mock("../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config.js")>();
  return { ...actual, resolveClientHandle: vi.fn() };
});
vi.mock("../content-input.js", () => ({ readContentInput: vi.fn(() => "new content") }));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

const post = vi.fn();
const get = vi.fn();
const del = vi.fn();
const writeJsonMock = vi.mocked(writeJson);
const writeStderrMock = vi.mocked(writeStderr);
const writeStdoutMock = vi.mocked(writeStdout);
const resolveClientHandleMock = vi.mocked(resolveClientHandle);
const createInterfaceMock = vi.mocked(createInterface);

function setupClient() {
  post.mockImplementation(async (path: string) =>
    path === "/create-note"
      ? { data: { note: { noteId: "new123", title: "Created", type: "text" } } }
      : { data: { attributeId: "attr123" } },
  );
  resolveClientHandleMock.mockReturnValue({
    client: { GET: get, POST: post, DELETE: del } as never,
    baseUrl: "https://trilium.example.com",
  });
}

describe("note create", () => {
  beforeEach(() => {
    post.mockReset();
    del.mockReset();
    createInterfaceMock.mockReset();
    writeJsonMock.mockReset();
    writeStderrMock.mockReset();
    writeStdoutMock.mockReset();
    vi.unstubAllEnvs();
    setupClient();
  });

  it("posts the parent, title, default type, and content", async () => {
    await createNoteAction("root", {
      title: "Created",
      content: "hello",
      type: "text",
      label: [],
    });

    expect(post).toHaveBeenCalledWith("/create-note", {
      body: {
        parentNoteId: "root",
        title: "Created",
        type: "text",
        mime: undefined,
        content: "<p>hello</p>",
        notePosition: undefined,
      },
    });
  });

  it("converts Markdown for text and preserves code content", async () => {
    await createNoteAction("root", {
      title: "Text",
      content: "# Heading",
      type: "text",
      label: [],
    });
    expect(post.mock.calls[0]?.[1].body.content).toBe("<h1>Heading</h1>");

    post.mockClear();
    await createNoteAction("root", {
      title: "Code",
      content: "# not markdown\n",
      type: "code",
      label: [],
    });
    expect(post.mock.calls[0]?.[1].body.content).toBe("# not markdown\n");
  });

  it("creates each label after the note and returns its id and url", async () => {
    await createNoteAction("root", {
      title: "Created",
      content: "body",
      type: "text",
      label: ["a=1", "b"],
    });

    expect(post).toHaveBeenNthCalledWith(2, "/attributes", {
      body: { noteId: "new123", type: "label", name: "a", value: "1" },
    });
    expect(post).toHaveBeenNthCalledWith(3, "/attributes", {
      body: { noteId: "new123", type: "label", name: "b", value: undefined },
    });
    expect(writeJsonMock).toHaveBeenCalledWith({
      noteId: "new123",
      title: "Created",
      type: "text",
      url: "https://trilium.example.com/#new123",
      labels: ["a=1", "b"],
    });
  });

  it("rejects invalid types and conflicting content inputs", async () => {
    await expect(
      createNoteAction("root", { title: "Bad", content: "x", type: "invalid", label: [] }),
    ).rejects.toMatchObject({ exitCode: 2 } satisfies Partial<CliError>);
    await expect(
      createNoteAction("root", {
        title: "Bad",
        content: "x",
        file: "f.md",
        type: "text",
        label: [],
      }),
    ).rejects.toMatchObject({ exitCode: 2 } satisfies Partial<CliError>);
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a malformed label before creating the note", async () => {
    await expect(
      createNoteAction("root", {
        title: "Bad",
        content: "x",
        type: "text",
        label: ["=empty"],
      }),
    ).rejects.toMatchObject({ exitCode: 2 } satisfies Partial<CliError>);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("note revisions", () => {
  const get = vi.fn();
  const postRevision = vi.fn();

  beforeEach(() => {
    get.mockReset();
    postRevision.mockReset();
    writeJsonMock.mockReset();
    writeStdoutMock.mockReset();
    writeStderrMock.mockReset();
    resolveClientHandleMock.mockReturnValue({
      client: { GET: get, POST: postRevision } as never,
      baseUrl: "https://trilium.example.com",
    });
  });

  it("creates a revision", async () => {
    postRevision.mockResolvedValue({ data: undefined, response: { ok: true } });
    await createRevisionAction("abc123");
    expect(postRevision).toHaveBeenCalledWith("/notes/{noteId}/revision", {
      params: { path: { noteId: "abc123" } },
    });
    expect(writeJsonMock).toHaveBeenCalledWith({ noteId: "abc123", revisionCreated: true });
  });

  it("lists trimmed revisions in server order", async () => {
    get.mockResolvedValue({
      data: [
        {
          revisionId: "r2",
          title: "New",
          type: "text",
          utcDateCreated: "2026-08-18T12:00:00Z",
          contentLength: 3,
          source: "api",
          blobId: "secret",
        },
      ],
    });
    await listRevisionsAction("abc123");
    expect(writeJsonMock).toHaveBeenCalledWith([
      {
        revisionId: "r2",
        title: "New",
        type: "text",
        utcDateCreated: "2026-08-18T12:00:00Z",
        contentLength: 3,
        source: "api",
      },
    ]);
  });

  it("reads a revision as Markdown or raw HTML", async () => {
    get.mockImplementation(async (path: string) =>
      path === "/revisions/{revisionId}" ? { data: { type: "text" } } : { data: "<h1>Title</h1>" },
    );
    await readRevisionAction("r1", {});
    expect(writeStdoutMock).toHaveBeenCalledWith("# Title");

    writeStdoutMock.mockReset();
    await readRevisionAction("r1", { rawHtml: true });
    expect(writeStdoutMock).toHaveBeenCalledWith("<h1>Title</h1>");
  });
});

describe("automatic note revisions", () => {
  const get = vi.fn();
  const postRevision = vi.fn();
  const put = vi.fn();

  beforeEach(() => {
    get.mockReset();
    postRevision.mockReset();
    put.mockReset();
    writeJsonMock.mockReset();
    vi.unstubAllEnvs();
    vi.stubEnv("TRILIUM_REVISION_INTERVAL", "5m");
    resolveClientHandleMock.mockReturnValue({
      client: { GET: get, POST: postRevision, PUT: put } as never,
      baseUrl: "https://trilium.example.com",
    });
    get.mockImplementation(async (path: string) => {
      if (path === "/notes/{noteId}") return { data: { type: "text" } };
      if (path === "/notes/{noteId}/revisions") {
        return { data: [{ utcDateCreated: new Date(Date.now() - 10 * 60 * 1000).toISOString() }] };
      }
      return { data: "<p>old</p>" };
    });
    postRevision.mockResolvedValue({ data: undefined, response: { ok: true } });
    put.mockResolvedValue({ data: undefined, response: { ok: true } });
  });

  it("creates an older revision before writing", async () => {
    await writeNoteAction("abc123", {});
    expect(postRevision).toHaveBeenCalled();
    expect(put).toHaveBeenCalled();
    expect(postRevision.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      put.mock.invocationCallOrder[0] ?? 0,
    );
    expect(writeJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({ revisionCreated: true, contentMode: "replace" }),
    );
  });

  it("skips a revision within the interval", async () => {
    get.mockImplementation(async (path: string) => {
      if (path === "/notes/{noteId}") return { data: { type: "text" } };
      if (path === "/notes/{noteId}/revisions") {
        return { data: [{ utcDateCreated: new Date().toISOString() }] };
      }
      return { data: "<p>old</p>" };
    });
    await writeNoteAction("abc123", {});
    expect(postRevision).not.toHaveBeenCalled();
    expect(writeJsonMock).toHaveBeenCalledWith(expect.objectContaining({ revisionCreated: false }));
  });

  it("disables revision checks at zero", async () => {
    vi.stubEnv("TRILIUM_REVISION_INTERVAL", "0");
    await writeNoteAction("abc123", {});
    expect(get).not.toHaveBeenCalledWith("/notes/{noteId}/revisions", expect.anything());
    expect(postRevision).not.toHaveBeenCalled();
    expect(writeJsonMock).toHaveBeenCalledWith(expect.objectContaining({ revisionCreated: false }));
  });

  it("rejects an invalid interval as usage", async () => {
    vi.stubEnv("TRILIUM_REVISION_INTERVAL", "five minutes");
    await expect(writeNoteAction("abc123", {})).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe("note delete and undelete", () => {
  beforeEach(() => {
    post.mockReset();
    del.mockReset();
    writeJsonMock.mockReset();
    setupClient();
    del.mockResolvedValue({ data: undefined, response: new Response(null, { status: 204 }) });
    post.mockResolvedValue({ data: { success: true } });
    get.mockResolvedValue({ data: { noteId: "abc123", title: "Titel" } });
  });

  it("deletes with --yes without fetching metadata", async () => {
    await deleteNoteAction("abc123", { yes: true });
    expect(del).toHaveBeenCalledWith("/notes/{noteId}", { params: { path: { noteId: "abc123" } } });
    expect(writeJsonMock).toHaveBeenCalledWith({ deleted: true, noteId: "abc123" });
  });

  it("deletes immediately when stdin is not a TTY", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    await deleteNoteAction("abc123", {});
    expect(del).toHaveBeenCalled();
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  });

  it("aborts a TTY delete when confirmation is not y", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
    const close = vi.fn();
    createInterfaceMock.mockReturnValue({
      question: vi.fn().mockResolvedValue("n"),
      close,
    } as never);
    await deleteNoteAction("abc123", {});
    expect(del).not.toHaveBeenCalled();
    expect(writeJsonMock).toHaveBeenCalledWith({ deleted: false, noteId: "abc123" });
    expect(close).toHaveBeenCalled();
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else Reflect.deleteProperty(process.stdin, "isTTY");
  });

  it("undeletes and reports the server success value", async () => {
    await undeleteNoteAction("abc123");
    expect(post).toHaveBeenCalledWith("/notes/{noteId}/undelete", {
      params: { path: { noteId: "abc123" } },
    });
    expect(writeJsonMock).toHaveBeenCalledWith({ restored: true, noteId: "abc123", success: true });
  });
});

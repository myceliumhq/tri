import { createInterface } from "node:readline/promises";
import { type CliError, writeJson } from "@myceliumhq/toolkit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClientHandle } from "../config.js";
import { createNoteAction, deleteNoteAction, undeleteNoteAction } from "./note.js";

vi.mock("@myceliumhq/toolkit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myceliumhq/toolkit")>();
  return { ...actual, writeJson: vi.fn() };
});
vi.mock("../config.js", () => ({ resolveClientHandle: vi.fn() }));
vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));

const post = vi.fn();
const get = vi.fn();
const del = vi.fn();
const writeJsonMock = vi.mocked(writeJson);
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
    get.mockReset();
    del.mockReset();
    writeJsonMock.mockReset();
    createInterfaceMock.mockReset();
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

describe("note delete and undelete", () => {
  beforeEach(() => {
    post.mockReset();
    get.mockReset();
    del.mockReset();
    writeJsonMock.mockReset();
    setupClient();
    del.mockResolvedValue({ data: undefined, response: new Response(null, { status: 204 }) });
    post.mockResolvedValue({ data: { success: true } });
    get.mockResolvedValue({ data: { noteId: "abc123", title: "Titel" } });
  });

  it("deletes with --yes without fetching metadata", async () => {
    await deleteNoteAction("abc123", { yes: true });
    expect(get).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("/notes/{noteId}", { params: { path: { noteId: "abc123" } } });
    expect(writeJsonMock).toHaveBeenCalledWith({ deleted: true, noteId: "abc123" });
  });

  it("deletes immediately when stdin is not a TTY", async () => {
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    await deleteNoteAction("abc123", {});
    expect(get).not.toHaveBeenCalled();
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
    expect(get).toHaveBeenCalledWith("/notes/{noteId}", { params: { path: { noteId: "abc123" } } });
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

  it("maps a delete 404 to exit code 3", async () => {
    del.mockResolvedValue({
      data: undefined,
      error: {},
      response: new Response(null, { status: 404 }),
    });
    await expect(deleteNoteAction("abc123", { yes: true })).rejects.toMatchObject({ exitCode: 3 });
  });
});

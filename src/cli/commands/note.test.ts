import { type CliError, writeJson } from "@myceliumhq/toolkit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveClientHandle } from "../config.js";
import { createNoteAction } from "./note.js";

vi.mock("@myceliumhq/toolkit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myceliumhq/toolkit")>();
  return { ...actual, writeJson: vi.fn() };
});
vi.mock("../config.js", () => ({ resolveClientHandle: vi.fn() }));

const post = vi.fn();
const writeJsonMock = vi.mocked(writeJson);
const resolveClientHandleMock = vi.mocked(resolveClientHandle);

function setupClient() {
  post.mockImplementation(async (path: string) =>
    path === "/create-note"
      ? { data: { note: { noteId: "new123", title: "Created", type: "text" } } }
      : { data: { attributeId: "attr123" } },
  );
  resolveClientHandleMock.mockReturnValue({
    client: { POST: post } as never,
    baseUrl: "https://trilium.example.com",
  });
}

describe("note create", () => {
  beforeEach(() => {
    post.mockReset();
    writeJsonMock.mockReset();
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

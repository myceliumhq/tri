import { describe, expect, it } from "vitest";
import {
  applyTextEdits,
  contentStatusFor,
  extractSnippet,
  formatContentForWrite,
  htmlToMarkdown,
  markdownToHtml,
  readRange,
} from "./html.js";

describe("markdownToHtml", () => {
  it("converts headings, bold, and lists to real HTML", () => {
    const html = markdownToHtml("# Heading\n\nSome **bold** text.\n\n- one\n- two\n");
    expect(html).toContain("<h1>Heading</h1>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<li>one</li>");
    expect(html).toContain("<li>two</li>");
  });

  it("does not mangle literal markdown-looking characters that aren't meant as syntax", () => {
    // A lone "#" with no space, or "**" without a matching pair, should not
    // produce broken/half-converted markup.
    expect(markdownToHtml("price is 5 * 3 = 15")).toContain("5 * 3 = 15");
  });
});

describe("htmlToMarkdown", () => {
  it("converts headings, bold, and lists back to Markdown", () => {
    const md = htmlToMarkdown("<h1>Heading</h1><p>Some <strong>bold</strong> text</p>");
    expect(md).toContain("# Heading");
    expect(md).toContain("**bold**");
  });

  it("uses a dash bullet marker for lists (not the library's default asterisk)", () => {
    const md = htmlToMarkdown("<ul><li>one</li><li>two</li></ul>");
    expect(md).toBe("- one\n- two");
  });

  it("passes plain text through unchanged (no HTML to convert)", () => {
    expect(htmlToMarkdown("just plain text")).toBe("just plain text");
  });
});

describe("formatContentForWrite", () => {
  it("converts Markdown to HTML for a 'text' note", () => {
    const result = formatContentForWrite("# Hello\n\n**world**", "text");
    expect(result).toContain("<h1>Hello</h1>");
    expect(result).toContain("<strong>world</strong>");
  });

  // Regression test for the real bug this replaces: literal Markdown syntax
  // (e.g. "# Inbox") used to be stored as-is inside a <p> tag instead of
  // being rendered as a heading, because the old auto-detection only
  // recognized real HTML tags, not Markdown.
  it("does not leave literal Markdown syntax unconverted for a 'text' note", () => {
    const result = formatContentForWrite("# Inbox", "text");
    expect(result).not.toContain("# Inbox");
    expect(result).toContain("<h1>Inbox</h1>");
  });

  // Regression test for the related bug this fix specifically guards
  // against: a `code` note's raw source must never be run through Markdown
  // conversion, even though it might contain "#"/"-"/"*" characters that
  // would otherwise look like Markdown syntax. There is deliberately no
  // format override to opt back into conversion for a non-'text' note --
  // mirrors Trilium's own first-party MCP tool implementation, which has
  // none either.
  it("never converts content for a non-'text' note", () => {
    const code = "# comment, not a heading\nconst x = [1, 2, 3];\n- not a list either";
    expect(formatContentForWrite(code, "code")).toBe(code);
  });
});

describe("applyTextEdits", () => {
  it("replaces a unique match", () => {
    const result = applyTextEdits("const x = 1;", [{ oldText: "x = 1", newText: "x = 2" }]);
    expect(result).toEqual({ ok: true, content: "const x = 2;" });
  });

  it("applies multiple edits in order, a later edit may target text an earlier one introduced", () => {
    const result = applyTextEdits("hello world", [
      { oldText: "hello", newText: "hi there" },
      { oldText: "hi there world", newText: "hi there, world!" },
    ]);
    expect(result).toEqual({ ok: true, content: "hi there, world!" });
  });

  it("fails when oldText is empty", () => {
    const result = applyTextEdits("anything", [{ oldText: "", newText: "x" }]);
    expect(result).toEqual({ ok: false, error: "oldText must not be empty." });
  });

  it("fails when oldText and newText are identical", () => {
    const result = applyTextEdits("anything", [{ oldText: "same", newText: "same" }]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/identical/);
  });

  it("fails when oldText isn't found", () => {
    const result = applyTextEdits("hello world", [{ oldText: "missing", newText: "x" }]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/not found/);
  });

  it("fails when oldText matches more than once", () => {
    const result = applyTextEdits("foo bar foo", [{ oldText: "foo", newText: "baz" }]);
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toMatch(/not unique/);
  });

  it("commits nothing if any edit in the sequence fails (all-or-nothing)", () => {
    const original = "hello world";
    const result = applyTextEdits(original, [
      { oldText: "hello", newText: "hi" },
      { oldText: "missing", newText: "x" },
    ]);
    expect(result.ok).toBe(false);
    // The first edit's effect must not leak into the error result's absence
    // of a `content` field -- there's nothing partially applied to observe,
    // but this asserts the shape doesn't accidentally carry one through.
    expect(result).not.toHaveProperty("content");
  });

  it("labels the failing edit's position when multiple edits are given", () => {
    const result = applyTextEdits("hello world", [
      { oldText: "hello", newText: "hi" },
      { oldText: "missing", newText: "x" },
    ]);
    expect((result as { error: string }).error).toMatch(/\(edit 2 of 2\)/);
  });
});

describe("contentStatusFor", () => {
  it("returns 'empty' for an empty string and 'present' otherwise", () => {
    expect(contentStatusFor("")).toBe("empty");
    expect(contentStatusFor("x")).toBe("present");
  });
});

describe("readRange", () => {
  const content = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");

  it("defaults to the first 200 lines from line 1", () => {
    const result = readRange("test_tool", content, undefined, undefined);
    expect(result).toEqual({ start_line: 1, end_line: 10, total_lines: 10, content });
  });

  it("respects an explicit start/end range", () => {
    const result = readRange("test_tool", content, 3, 5);
    expect(result).toEqual({
      start_line: 3,
      end_line: 5,
      total_lines: 10,
      content: "line3\nline4\nline5",
    });
  });

  it("caps the range at MAX_RANGE_LINES from start_line", () => {
    const long = Array.from({ length: 600 }, (_, i) => `l${i + 1}`).join("\n");
    const result = readRange("test_tool", long, 1, 599);
    expect(result.end_line).toBe(500);
  });

  it("throws when end_line is before start_line, prefixed with the caller's tool name", () => {
    expect(() => readRange("trilium_read_note_content", content, 5, 3)).toThrow(
      /^trilium_read_note_content: .*end_line/,
    );
  });

  it("returns an empty slice when start_line is past the end of the content", () => {
    const result = readRange("test_tool", content, 20, undefined);
    expect(result).toEqual({ start_line: 20, end_line: 19, total_lines: 10, content: "" });
  });
});

describe("extractSnippet", () => {
  it("returns a window of context around the matched term", () => {
    const content = `${"x".repeat(200)} findme ${"y".repeat(200)}`;
    const snippet = extractSnippet(content, "findme");
    expect(snippet).toContain("findme");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
  });

  it("falls back to a leading excerpt when the term isn't found", () => {
    expect(extractSnippet("short content", "nope")).toBe("short content");
  });

  it("returns the whole trimmed content when short and no term is given", () => {
    expect(extractSnippet("  short content  ", undefined)).toBe("short content");
  });
});

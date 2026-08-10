import { describe, expect, it } from "vitest";
import { extractFreeTextTerms, MATCH_ALL_NOTES, toUtcDateTimeLiteral } from "./query.js";

describe("extractFreeTextTerms", () => {
  it("passes plain fulltext queries through unchanged", () => {
    expect(extractFreeTextTerms("towers tolkien")).toBe("towers tolkien");
  });

  it("strips label filters, leaving free text", () => {
    expect(extractFreeTextTerms("towers #book")).toBe("towers");
  });

  it("strips label filters with a comparison and value", () => {
    expect(extractFreeTextTerms("project plan #year >= 1950")).toBe("project plan");
  });

  it("strips relation filters", () => {
    expect(extractFreeTextTerms("rings ~author.title *=* Tolkien")).toBe("rings");
  });

  it("strips note.property filters and boolean keywords", () => {
    expect(extractFreeTextTerms('report AND note.dateModified >= "2026-01-01"')).toBe("report");
  });

  it("returns an empty string for a pure structured/attribute query", () => {
    expect(extractFreeTextTerms("#book #year >= 1950 AND #year < 1960")).toBe("");
  });

  it("unquotes an exact-match phrase", () => {
    expect(extractFreeTextTerms('"Two Towers"')).toBe("Two Towers");
  });

  // Regression test for a real bug found in review: the operator-stripping
  // regex was case-insensitive, so it deleted the ordinary lowercase
  // English words "and"/"or"/"not" out of completely unrelated free text
  // before it ever reached the embedding call.
  it("does not strip lowercase 'and'/'or'/'not' when they're ordinary English words, not operators", () => {
    expect(extractFreeTextTerms("salt and pepper")).toBe("salt and pepper");
    expect(extractFreeTextTerms("terms and conditions")).toBe("terms and conditions");
    expect(extractFreeTextTerms("this or that")).toBe("this or that");
    expect(extractFreeTextTerms("do not disturb")).toBe("do not disturb");
  });

  it("does not strip 'limit'/'asc'/'desc' -- those are separate query params, never part of `search`", () => {
    expect(extractFreeTextTerms("limit the damage asc desc")).toBe("limit the damage asc desc");
  });
});

describe("toUtcDateTimeLiteral", () => {
  it("formats a Date into Trilium's UtcDateTime pattern", () => {
    const date = new Date(Date.UTC(2026, 6, 27, 15, 30, 45, 123));
    expect(toUtcDateTimeLiteral(date)).toBe("2026-07-27 15:30:45.123Z");
  });
});

describe("MATCH_ALL_NOTES", () => {
  it("is a non-empty query string", () => {
    expect(MATCH_ALL_NOTES.length).toBeGreaterThan(0);
  });
});

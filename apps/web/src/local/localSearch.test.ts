import { describe, expect, it } from "vitest";
import { buildLocalIndex, searchLocal } from "./localSearch";

const notes = [
  { path: "migraine/triggers.md", title: "Migraine Triggers", content: "Chocolate and red wine seem to trigger attacks." },
  { path: "recipes/pasta.md", title: "Pasta Recipe", content: "Boil pasta, add tomato sauce and basil." },
  { path: "journal/2026-07-01.md", title: "Journal", content: "Had a headache today, possibly a migraine starting." },
];

describe("buildLocalIndex / searchLocal", () => {
  it("finds notes by body content", () => {
    const index = buildLocalIndex(notes);
    const hits = searchLocal(index, "pasta");
    expect(hits.map((h) => h.path)).toContain("recipes/pasta.md");
  });

  it("ranks a title match above a body-only match for the same term", () => {
    const index = buildLocalIndex(notes);
    const hits = searchLocal(index, "migraine");
    expect(hits.length).toBeGreaterThanOrEqual(2);
    expect(hits[0].path).toBe("migraine/triggers.md");
    expect(hits.map((h) => h.path)).toEqual(
      expect.arrayContaining(["migraine/triggers.md", "journal/2026-07-01.md"]),
    );
  });

  it("returns hits with path/title/score", () => {
    const index = buildLocalIndex(notes);
    const [hit] = searchLocal(index, "chocolate");
    expect(hit).toMatchObject({ path: "migraine/triggers.md", title: "Migraine Triggers" });
    expect(typeof hit.score).toBe("number");
  });

  it("matches on word prefixes", () => {
    const index = buildLocalIndex(notes);
    const hits = searchLocal(index, "migr");
    expect(hits.map((h) => h.path)).toContain("migraine/triggers.md");
  });

  it("empty query returns no hits", () => {
    const index = buildLocalIndex(notes);
    expect(searchLocal(index, "")).toEqual([]);
    expect(searchLocal(index, "   ")).toEqual([]);
  });

  it("empty index returns no hits", () => {
    const index = buildLocalIndex([]);
    expect(searchLocal(index, "anything")).toEqual([]);
  });

  it("a note with no title (null) is still indexed and searchable by content", () => {
    const index = buildLocalIndex([{ path: "untitled.md", title: null, content: "unique-token-xyz" }]);
    const hits = searchLocal(index, "unique-token-xyz");
    expect(hits).toEqual([{ path: "untitled.md", title: null, score: expect.any(Number) }]);
  });
});

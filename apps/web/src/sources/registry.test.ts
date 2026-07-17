import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addFolderSource,
  addServerSource,
  listSources,
  removeSource,
  renameSource,
} from "./registry";

describe("sources registry", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("starts empty", () => {
    expect(listSources()).toEqual([]);
  });

  it("adds a server source and lists it", () => {
    const source = addServerSource("My Server", "https://x.dev");
    expect(source).toEqual({ id: "s1", kind: "server", label: "My Server", url: "https://x.dev" });
    expect(listSources()).toEqual([source]);
  });

  it("adds a folder source and lists it", () => {
    const source = addFolderSource("My Notes", "/Users/me/notes");
    expect(source).toEqual({
      id: "s1",
      kind: "folder",
      label: "My Notes",
      path: "/Users/me/notes",
    });
    expect(listSources()).toEqual([source]);
  });

  it("persists across a localStorage round trip (simulates a fresh read)", () => {
    addServerSource("My Server", "https://x.dev");
    addFolderSource("My Notes", "/Users/me/notes");

    const raw = localStorage.getItem("ndbrain.sources");
    expect(raw).not.toBeNull();
    // A second, independent read (as a fresh module load would do) must see
    // the same data, not something cached in memory.
    localStorage.setItem("ndbrain.sources", raw as string);
    expect(listSources()).toHaveLength(2);
  });

  it("keeps insertion order stable", () => {
    addServerSource("First", "https://first.dev");
    addFolderSource("Second", "/second");
    addServerSource("Third", "https://third.dev");

    expect(listSources().map((s) => s.label)).toEqual(["First", "Second", "Third"]);
  });

  it("assigns unique, sequential ids", () => {
    const a = addServerSource("A", "https://a.dev");
    const b = addFolderSource("B", "/b");
    const c = addServerSource("C", "https://c.dev");

    expect([a.id, b.id, c.id]).toEqual(["s1", "s2", "s3"]);
  });

  it("removes a source by id", () => {
    const a = addServerSource("A", "https://a.dev");
    const b = addFolderSource("B", "/b");

    removeSource(a.id);

    expect(listSources()).toEqual([b]);
  });

  it("renames a source by id", () => {
    const a = addServerSource("A", "https://a.dev");

    renameSource(a.id, "Renamed");

    expect(listSources()[0]?.label).toBe("Renamed");
  });

  it("normalizes a server URL by stripping the trailing slash", () => {
    const source = addServerSource("My Server", "https://x.dev/");
    expect(source.url).toBe("https://x.dev");
  });

  it("throws on a non-http(s) URL and persists nothing", () => {
    expect(() => addServerSource("Bad", "ftp://x")).toThrow();
    expect(listSources()).toEqual([]);
  });

  it("throws on an unparseable URL and persists nothing", () => {
    expect(() => addServerSource("Bad", "nonsense")).toThrow();
    expect(listSources()).toEqual([]);
  });

  it("throws on an empty/whitespace label and persists nothing", () => {
    expect(() => addServerSource("", "https://x.dev")).toThrow();
    expect(() => addServerSource("   ", "https://x.dev")).toThrow();
    expect(() => addFolderSource("   ", "/some/path")).toThrow();
    expect(listSources()).toEqual([]);
  });

  it("throws on an empty folder path and persists nothing", () => {
    expect(() => addFolderSource("My Notes", "")).toThrow();
    expect(() => addFolderSource("My Notes", "   ")).toThrow();
    expect(listSources()).toEqual([]);
  });

  it("returns [] instead of crashing on corrupt JSON in storage", () => {
    localStorage.setItem("ndbrain.sources", "{not valid json");
    expect(listSources()).toEqual([]);
  });

  it("skips entries with an unknown kind while keeping valid ones", () => {
    localStorage.setItem(
      "ndbrain.sources",
      JSON.stringify({
        nextId: 3,
        sources: [
          { id: "s1", kind: "weird", label: "Broken" },
          { id: "s2", kind: "server", label: "Good Server", url: "https://good.dev" },
        ],
      }),
    );
    expect(listSources()).toEqual([
      { id: "s2", kind: "server", label: "Good Server", url: "https://good.dev" },
    ]);
  });

  it("is a no-op and lists [] when localStorage is unavailable", () => {
    const original = globalThis.localStorage;
    // @ts-expect-error - deliberately simulating an environment without localStorage
    delete globalThis.localStorage;
    try {
      expect(listSources()).toEqual([]);
      expect(() => addServerSource("A", "https://a.dev")).not.toThrow();
      expect(() => removeSource("s1")).not.toThrow();
      expect(() => renameSource("s1", "B")).not.toThrow();
    } finally {
      vi.stubGlobal("localStorage", original);
    }
  });
});

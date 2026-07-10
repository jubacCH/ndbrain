import { describe, expect, it } from "vitest";
import { buildTree, type TreeFile, type TreeFolder } from "./buildTree";

describe("buildTree", () => {
  it("returns an empty array for no notes", () => {
    expect(buildTree([])).toEqual([]);
  });

  it("places a root-level note directly in the returned array", () => {
    const tree = buildTree([{ path: "readme.md", title: "Readme" }]);
    expect(tree).toEqual([{ type: "file", path: "readme.md", name: "readme.md", title: "Readme" }]);
  });

  it("falls back to the filename when title is null", () => {
    const tree = buildTree([{ path: "untitled.md", title: null }]);
    expect(tree[0]).toMatchObject({ name: "untitled.md", title: null });
  });

  it("groups notes under a single folder node", () => {
    const tree = buildTree([
      { path: "projects/a.md", title: "A" },
      { path: "projects/b.md", title: "B" },
    ]);

    expect(tree).toHaveLength(1);
    const folder = tree[0] as TreeFolder;
    expect(folder).toMatchObject({ type: "folder", path: "projects", name: "projects" });
    expect(folder.children).toHaveLength(2);
  });

  it("builds nested folders for multi-segment paths", () => {
    const tree = buildTree([{ path: "projects/ndbrain/notes.md", title: "Notes" }]);

    const top = tree[0] as TreeFolder;
    expect(top).toMatchObject({ type: "folder", path: "projects", name: "projects" });

    const nested = top.children[0] as TreeFolder;
    expect(nested).toMatchObject({ type: "folder", path: "projects/ndbrain", name: "ndbrain" });

    const file = nested.children[0] as TreeFile;
    expect(file).toMatchObject({ type: "file", path: "projects/ndbrain/notes.md", name: "notes.md" });
  });

  it("does not duplicate a folder shared by notes in different subfolders", () => {
    const tree = buildTree([
      { path: "projects/a/one.md", title: null },
      { path: "projects/b/two.md", title: null },
    ]);

    const projects = tree[0] as TreeFolder;
    expect(projects.children).toHaveLength(2);
    expect(projects.children.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("sorts folders before files at the same level", () => {
    const tree = buildTree([
      { path: "z.md", title: null },
      { path: "a-folder/inner.md", title: null },
    ]);

    expect(tree.map((n) => n.type)).toEqual(["folder", "file"]);
  });

  it("sorts alphabetically, case-insensitively, within each group", () => {
    const tree = buildTree([
      { path: "banana.md", title: null },
      { path: "Apple.md", title: null },
      { path: "cherry.md", title: null },
    ]);

    expect(tree.map((n) => n.name)).toEqual(["Apple.md", "banana.md", "cherry.md"]);
  });

  it("sorts folders and files independently, recursively", () => {
    const tree = buildTree([
      { path: "folder/z.md", title: null },
      { path: "folder/a.md", title: null },
      { path: "zeta/note.md", title: null },
      { path: "alpha/note.md", title: null },
    ]);

    expect(tree.map((n) => n.name)).toEqual(["alpha", "folder", "zeta"]);
    const folder = tree.find((n) => n.name === "folder") as TreeFolder;
    expect(folder.children.map((c) => c.name)).toEqual(["a.md", "z.md"]);
  });

  it("preserves the full path on nested files for selection", () => {
    const tree = buildTree([{ path: "a/b/c/d.md", title: "Deep" }]);
    let node = tree[0] as TreeFolder;
    while (node.children[0].type === "folder") {
      node = node.children[0] as TreeFolder;
    }
    expect((node.children[0] as TreeFile).path).toBe("a/b/c/d.md");
  });
});

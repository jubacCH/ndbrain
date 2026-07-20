import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { createApiClient } from "../api/client";
import { LocalNotesStore } from "../local/localStore";
import { SourcesContext, type SourcesContextValue } from "../sources/SourcesProvider";
import type { NoteSelection, SourceRuntime } from "../sources/types";
import { AppStateProvider, useAppState } from "./AppState";
import { EditorPane } from "./EditorPane";

// Real `mermaid` is a large dependency lazily loaded by the collaborative
// `<Editor>`'s live-preview extensions (see `Editor.test.tsx`'s identical
// mock) - stubbed here since `EditorPane` mounts the real `<Editor>`.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg>diagram</svg>" }),
  },
}));

// `EditorPane` imports `createCollabProvider` directly (its `providerFactory`
// wraps it) - mocking it here is the seam that lets these tests inspect
// exactly what `wsUrl` (if any) each source's provider factory was built
// with, without opening a real WebSocket. `<Editor>` itself is NOT mocked:
// `EditorPane` always supplies an explicit `providerFactory` prop, so
// `Editor.tsx`'s own default import of `createCollabProvider` is never
// reached either way.
const { createCollabProviderMock } = vi.hoisted(() => ({ createCollabProviderMock: vi.fn() }));
vi.mock("../api/collab", () => ({
  createCollabProvider: (...args: unknown[]) => createCollabProviderMock(...args),
}));

// `<LocalEditor>` mounts real CodeMirror, which jsdom cannot drive via
// simulated keystrokes (see `LocalEditor.test.tsx`'s doc comment). `EditorPane`
// hardcodes the import (no injection prop like the old `LocalNotesView` had),
// so the equivalent seam here is mocking the module itself with a plain
// textarea - `LocalNotesView.test.tsx`'s `FakeEditor` convention, just via
// `vi.mock` instead of a prop.
vi.mock("../editor/LocalEditor", () => ({
  LocalEditor: (props: { path: string; content: string; onChange: (content: string) => void }) => (
    <textarea
      aria-label="local note content"
      data-path={props.path}
      value={props.content}
      onChange={(event) => props.onChange(event.target.value)}
    />
  ),
}));

function makeFakeHandle() {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  const provider = {
    document: ydoc,
    awareness: null,
    on: vi.fn(),
    off: vi.fn(),
  };
  return {
    provider: provider as unknown as import("../api/collab").CollabProviderHandle["provider"],
    ydoc,
    ytext,
    destroy: vi.fn(() => ydoc.destroy()),
  };
}

/** `ApiClient` has private fields, so tests build a real instance and spy on
 *  the methods under test (same convention as `notes/SourceSection.test.tsx`),
 *  rather than a structural fake object. */
function makeServerRuntime(id: string, label: string, url: string) {
  const client = createApiClient(url);
  vi.spyOn(client, "getCollabToken").mockReturnValue(`token-${id}`);
  const runtime: SourceRuntime = { def: { id, kind: "server", label, url }, state: "connected", kind: "server", client };
  return { runtime, client };
}

function makeFolderRuntime(
  id: string,
  label: string,
  overrides: {
    readLocal?: (rel: string) => Promise<string>;
    writeLocal?: (rel: string, content: string) => Promise<void>;
  } = {},
) {
  const store = new LocalNotesStore(`/tmp/${id}`);
  vi.spyOn(store, "readLocal").mockImplementation(overrides.readLocal ?? (async () => ""));
  vi.spyOn(store, "writeLocal").mockImplementation(overrides.writeLocal ?? (async () => undefined));
  const runtime: SourceRuntime = { def: { id, kind: "folder", label, path: `/tmp/${id}` }, state: "connected", kind: "folder", store };
  return { runtime, store };
}

function fakeSourcesValue(sources: SourceRuntime[]): SourcesContextValue {
  return {
    sources,
    addServer: vi.fn(),
    addFolder: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn(),
  };
}

/** Drives `AppState`'s `selection` from the outside (there is no other public
 *  way to set it - it is normally the sidebar's job) so each test/rerender
 *  can put `<EditorPane>` in front of whichever selection it wants to assert
 *  against. */
function Harness({ selection }: { selection: NoteSelection | null }) {
  const { setSelection } = useAppState();
  useEffect(() => {
    setSelection(selection);
  }, [selection, setSelection]);
  return <EditorPane />;
}

function tree(sources: SourceRuntime[], selection: NoteSelection | null) {
  return (
    <SourcesContext.Provider value={fakeSourcesValue(sources)}>
      <AppStateProvider>
        <Harness selection={selection} />
      </AppStateProvider>
    </SourcesContext.Provider>
  );
}

function renderPane(sources: SourceRuntime[], selection: NoteSelection | null) {
  return render(tree(sources, selection));
}

describe("<EditorPane>", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    createCollabProviderMock.mockReset();
  });

  it("shows a placeholder when nothing is selected", () => {
    renderPane([], null);
    expect(screen.getByText(/select a note to start editing/i)).toBeInTheDocument();
  });

  it("derives a per-source ws URL for the provider factory - two server sources never cross-connect", async () => {
    createCollabProviderMock.mockImplementation(() => makeFakeHandle());
    const { runtime: serverA } = makeServerRuntime("a", "Alpha", "https://alpha.example.com");
    const { runtime: serverB } = makeServerRuntime("b", "Beta", "http://beta.example.com");
    const sources = [serverA, serverB];

    const { rerender } = renderPane(sources, { sourceId: "a", path: "one.md" });
    await waitFor(() => expect(createCollabProviderMock).toHaveBeenCalledTimes(1));
    expect(createCollabProviderMock.mock.calls[0][0]).toMatchObject({
      path: "one.md",
      token: "token-a",
      wsUrl: "wss://alpha.example.com/collab",
    });

    rerender(tree(sources, { sourceId: "b", path: "two.md" }));

    await waitFor(() => expect(createCollabProviderMock).toHaveBeenCalledTimes(2));
    expect(createCollabProviderMock.mock.calls[1][0]).toMatchObject({
      path: "two.md",
      token: "token-b",
      wsUrl: "ws://beta.example.com/collab",
    });
  });

  it("passes no wsUrl for the browser-origin source (def.url === \"\"), preserving the location fallback", async () => {
    createCollabProviderMock.mockImplementation(() => makeFakeHandle());
    const { runtime: origin } = makeServerRuntime("origin", "Server", "");

    renderPane([origin], { sourceId: "origin", path: "note.md" });

    await waitFor(() => expect(createCollabProviderMock).toHaveBeenCalledTimes(1));
    const opts = createCollabProviderMock.mock.calls[0][0] as { wsUrl?: string };
    expect(opts.wsUrl).toBeUndefined();
  });

  it("routes a folder selection through readLocal/LocalEditor without ever calling fetch", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { runtime: folder, store } = makeFolderRuntime("f1", "My Laptop", {
      readLocal: vi.fn(async () => "hello local"),
    });

    renderPane([folder], { sourceId: "f1", path: "note.md" });

    const textarea = await screen.findByLabelText("local note content");
    expect(textarea).toHaveValue("hello local");
    expect(store.readLocal).toHaveBeenCalledWith("note.md");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createCollabProviderMock).not.toHaveBeenCalled();
  });

  it("debounces LocalEditor edits into a single writeLocal call carrying only the final content", async () => {
    const { runtime: folder, store } = makeFolderRuntime("f1", "My Laptop", { readLocal: async () => "original" });
    renderPane([folder], { sourceId: "f1", path: "note.md" });
    const textarea = await screen.findByLabelText("local note content");

    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: "o" } });
    fireEvent.change(textarea, { target: { value: "or" } });
    fireEvent.change(textarea, { target: { value: "original + final" } });
    expect(store.writeLocal).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(400);
    vi.useRealTimers();

    expect(store.writeLocal).toHaveBeenCalledTimes(1);
    expect(store.writeLocal).toHaveBeenCalledWith("note.md", "original + final");
  });

  it("flushes a pending edit immediately when switching notes, instead of losing it", async () => {
    const { runtime: folder, store } = makeFolderRuntime("f1", "My Laptop", {
      readLocal: vi.fn(async (rel: string) => (rel === "a.md" ? "content a" : "content b")),
    });
    const sources = [folder];
    const { rerender } = renderPane(sources, { sourceId: "f1", path: "a.md" });
    const textarea = await screen.findByLabelText("local note content");
    expect(textarea).toHaveValue("content a");

    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: "edited a" } });
    expect(store.writeLocal).not.toHaveBeenCalled();

    rerender(tree(sources, { sourceId: "f1", path: "b.md" }));

    // Flushed synchronously (via the outgoing effect's cleanup) - never had
    // to wait out the rest of the debounce window.
    expect(store.writeLocal).toHaveBeenCalledWith("a.md", "edited a");

    vi.useRealTimers();
    await screen.findByDisplayValue("content b");
  });

  it("flushes a pending edit on unmount instead of dropping it", async () => {
    const { runtime: folder, store } = makeFolderRuntime("f1", "My Laptop", { readLocal: async () => "original" });
    const { unmount } = renderPane([folder], { sourceId: "f1", path: "note.md" });
    const textarea = await screen.findByLabelText("local note content");

    vi.useFakeTimers();
    fireEvent.change(textarea, { target: { value: "edited before unmount" } });
    expect(store.writeLocal).not.toHaveBeenCalled();

    unmount();
    vi.useRealTimers();

    expect(store.writeLocal).toHaveBeenCalledWith("note.md", "edited before unmount");
  });

  it("destroys the previous collab provider on every switch away from a server source", async () => {
    createCollabProviderMock.mockImplementation(() => makeFakeHandle());
    const { runtime: server } = makeServerRuntime("s1", "Alpha", "https://alpha.example.com");
    const { runtime: folder } = makeFolderRuntime("f1", "My Laptop", { readLocal: async () => "" });
    const sources = [server, folder];

    const { rerender } = renderPane(sources, { sourceId: "s1", path: "note.md" });
    await waitFor(() => expect(createCollabProviderMock).toHaveBeenCalledTimes(1));
    const firstHandle = createCollabProviderMock.mock.results[0].value as ReturnType<typeof makeFakeHandle>;

    rerender(tree(sources, { sourceId: "f1", path: "note.md" }));
    await waitFor(() => expect(firstHandle.destroy).toHaveBeenCalledTimes(1));

    rerender(tree(sources, { sourceId: "s1", path: "note.md" }));
    await waitFor(() => expect(createCollabProviderMock).toHaveBeenCalledTimes(2));
    const secondHandle = createCollabProviderMock.mock.results[1].value as ReturnType<typeof makeFakeHandle>;
    expect(secondHandle.destroy).not.toHaveBeenCalled();
  });

  it("shows the source label and path in the doc header for a server selection", async () => {
    createCollabProviderMock.mockImplementation(() => makeFakeHandle());
    const { runtime: server } = makeServerRuntime("s1", "Alpha", "https://alpha.example.com");

    renderPane([server], { sourceId: "s1", path: "notes/deploy.md" });

    expect(await screen.findByRole("heading", { name: "deploy" })).toBeInTheDocument();
    expect(screen.getByText(/Alpha/)).toBeInTheDocument();
    expect(screen.getByText(/notes\/deploy\.md/)).toBeInTheDocument();
  });

  it("shows the source label and path in the doc header for a folder selection", async () => {
    const { runtime: folder } = makeFolderRuntime("f1", "My Laptop", { readLocal: async () => "text" });

    renderPane([folder], { sourceId: "f1", path: "ideas/note.md" });

    expect(await screen.findByRole("heading", { name: "note" })).toBeInTheDocument();
    expect(screen.getByText(/My Laptop/)).toBeInTheDocument();
    expect(screen.getByText(/ideas\/note\.md/)).toBeInTheDocument();
  });
});

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createApiClient, type NoteSummary } from "../api/client";
import { LocalNotesStore, type LocalNoteSummary } from "../local/localStore";
import { SourcesContext, type SourcesContextValue } from "../sources/SourcesProvider";
import type { NoteSelection, SourceRuntime } from "../sources/types";
import { SourceSection } from "./SourceSection";

/** `ApiClient` has private fields, so tests build a real instance and mock
 *  the methods under test directly (same convention as
 *  `panels/BacklinksPanel.test.tsx`), rather than a structural fake object. */
function serverRuntime(
  id: string,
  label: string,
  overrides: { listNotes?: NoteSummary[]; putNote?: (path: string, content: string) => Promise<void> } = {},
): SourceRuntime {
  const client = createApiClient("");
  vi.spyOn(client, "listNotes").mockResolvedValue(overrides.listNotes ?? []);
  vi.spyOn(client, "putNote").mockImplementation(overrides.putNote ?? vi.fn().mockResolvedValue(undefined));
  return { def: { id, kind: "server", label, url: "" }, state: "connected", kind: "server", client };
}

function folderRuntime(
  id: string,
  label: string,
  overrides: { listLocal?: LocalNoteSummary[]; writeLocal?: (rel: string, content: string) => Promise<void> } = {},
): SourceRuntime {
  const store = new LocalNotesStore("/tmp/notes");
  vi.spyOn(store, "listLocal").mockResolvedValue(overrides.listLocal ?? []);
  vi.spyOn(store, "writeLocal").mockImplementation(overrides.writeLocal ?? vi.fn().mockResolvedValue(undefined));
  return { def: { id, kind: "folder", label, path: "/tmp/notes" }, state: "connected", kind: "folder", store };
}

function fakeSourcesValue(overrides: Partial<SourcesContextValue> = {}): SourcesContextValue {
  return {
    sources: [],
    addServer: vi.fn(),
    addFolder: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    login: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn(),
    ...overrides,
  };
}

function renderSection(
  runtime: SourceRuntime,
  opts: { selection?: NoteSelection | null; showHeader?: boolean; sourcesValue?: Partial<SourcesContextValue> } = {},
) {
  const onSelect = vi.fn();
  const sourcesValue = fakeSourcesValue(opts.sourcesValue);
  render(
    <SourcesContext.Provider value={sourcesValue}>
      <SourceSection
        runtime={runtime}
        selection={opts.selection ?? null}
        onSelect={onSelect}
        showHeader={opts.showHeader ?? true}
      />
    </SourcesContext.Provider>,
  );
  return { onSelect, sourcesValue };
}

describe("SourceSection", () => {
  describe("header", () => {
    it("shows the source label and note count when showHeader is true", async () => {
      const runtime = serverRuntime("s1", "My Server", {
        listNotes: [{ path: "a.md", title: "A" }],
      });
      renderSection(runtime, { showHeader: true });

      const section = screen.getByRole("region", { name: "My Server" });
      expect(within(section).getByText("My Server")).toBeInTheDocument();
      await waitFor(() => expect(within(section).getByText("1")).toBeInTheDocument());
    });

    it("renders no section header at all when showHeader is false", async () => {
      const runtime = serverRuntime("s1", "My Server", { listNotes: [] });
      renderSection(runtime, { showHeader: false });

      await screen.findByText(/no notes yet/i);
      expect(screen.queryByText("My Server")).not.toBeInTheDocument();
    });

    it("marks a folder section with a 'device' marker", () => {
      const runtime = folderRuntime("f1", "Laptop Notes");
      renderSection(runtime, { showHeader: true });

      const section = screen.getByRole("region", { name: "Laptop Notes" });
      expect(within(section).getByText(/device/i)).toBeInTheDocument();
    });

    it("does not show a device marker for a server section", () => {
      const runtime = serverRuntime("s1", "My Server");
      renderSection(runtime, { showHeader: true });

      const section = screen.getByRole("region", { name: "My Server" });
      expect(within(section).queryByText(/device/i)).not.toBeInTheDocument();
    });
  });

  describe("listing notes", () => {
    it("lists notes for a server source via client.listNotes()", async () => {
      const runtime = serverRuntime("s1", "Server", {
        listNotes: [
          { path: "projects/a.md", title: "A" },
          { path: "b.md", title: null },
        ],
      });
      renderSection(runtime);

      expect(await screen.findByText("A")).toBeInTheDocument();
      expect(screen.getByText("b.md")).toBeInTheDocument();
    });

    it("lists notes for a folder source via store.listLocal()", async () => {
      const runtime = folderRuntime("f1", "Notes", {
        listLocal: [{ path: "a.md", title: "A" }],
      });
      renderSection(runtime);

      expect(await screen.findByText("A")).toBeInTheDocument();
      if (runtime.kind === "folder") {
        expect(runtime.store.listLocal).toHaveBeenCalledTimes(1);
      }
    });

    it("calls onSelect with {sourceId, path} when a note is clicked", async () => {
      const runtime = serverRuntime("s1", "Server", { listNotes: [{ path: "a.md", title: "A" }] });
      const { onSelect } = renderSection(runtime);

      fireEvent.click(await screen.findByText("A"));

      expect(onSelect).toHaveBeenCalledWith({ sourceId: "s1", path: "a.md" });
    });
  });

  describe("connecting state", () => {
    it("shows a quiet hint and never attempts to list notes", () => {
      const client = createApiClient("");
      const listNotes = vi.spyOn(client, "listNotes").mockResolvedValue([]);
      const runtime: SourceRuntime = {
        def: { id: "s1", kind: "server", label: "Server", url: "" },
        state: "connecting",
        kind: "server",
        client,
      };
      renderSection(runtime);

      expect(screen.getAllByText(/connecting/i).length).toBeGreaterThan(0);
      expect(listNotes).not.toHaveBeenCalled();
    });
  });

  describe("needs-login state", () => {
    it("shows a sign-in form and calls login(id, username, password) on submit", async () => {
      const client = createApiClient("");
      const runtime: SourceRuntime = {
        def: { id: "s1", kind: "server", label: "Flaky Server", url: "" },
        state: "needs-login",
        kind: "server",
        client,
      };
      const login = vi.fn().mockResolvedValue(undefined);
      renderSection(runtime, { sourcesValue: { login } });

      fireEvent.change(screen.getByLabelText(/username/i), { target: { value: "julian" } });
      fireEvent.change(screen.getByLabelText(/password/i), { target: { value: "hunter2" } });
      fireEvent.click(screen.getByRole("button", { name: /sign in/i }));

      await waitFor(() => expect(login).toHaveBeenCalledWith("s1", "julian", "hunter2"));
    });

    it("does not attempt to list notes while needing login", () => {
      const client = createApiClient("");
      const listNotes = vi.spyOn(client, "listNotes").mockResolvedValue([]);
      const runtime: SourceRuntime = {
        def: { id: "s1", kind: "server", label: "Server", url: "" },
        state: "needs-login",
        kind: "server",
        client,
      };
      renderSection(runtime);

      expect(listNotes).not.toHaveBeenCalled();
    });
  });

  describe("unreachable state", () => {
    it("shows an error and a Retry button that calls retry(id)", () => {
      const client = createApiClient("");
      const runtime: SourceRuntime = {
        def: { id: "s1", kind: "server", label: "Down Server", url: "" },
        state: "unreachable",
        kind: "server",
        client,
      };
      const retry = vi.fn();
      renderSection(runtime, { sourcesValue: { retry } });

      expect(screen.getByRole("alert")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: /retry/i }));

      expect(retry).toHaveBeenCalledWith("s1");
    });
  });

  describe("degraded state isolation", () => {
    it("a needs-login section does not block a normally-connected section", async () => {
      const flaky: SourceRuntime = {
        def: { id: "flaky", kind: "server", label: "Flaky", url: "" },
        state: "needs-login",
        kind: "server",
        client: createApiClient(""),
      };
      const ok = serverRuntime("ok", "Ok", { listNotes: [{ path: "a.md", title: "A" }] });

      render(
        <SourcesContext.Provider value={fakeSourcesValue()}>
          <SourceSection runtime={flaky} selection={null} onSelect={vi.fn()} showHeader />
          <SourceSection runtime={ok} selection={null} onSelect={vi.fn()} showHeader />
        </SourcesContext.Provider>,
      );

      expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
      expect(await screen.findByText("A")).toBeInTheDocument();
    });

    it("an unreachable section does not block a normally-connected section", async () => {
      const down: SourceRuntime = {
        def: { id: "down", kind: "server", label: "Down", url: "" },
        state: "unreachable",
        kind: "server",
        client: createApiClient(""),
      };
      const ok = serverRuntime("ok", "Ok", { listNotes: [{ path: "a.md", title: "A" }] });

      render(
        <SourcesContext.Provider value={fakeSourcesValue()}>
          <SourceSection runtime={down} selection={null} onSelect={vi.fn()} showHeader />
          <SourceSection runtime={ok} selection={null} onSelect={vi.fn()} showHeader />
        </SourcesContext.Provider>,
      );

      expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
      expect(await screen.findByText("A")).toBeInTheDocument();
    });
  });

  describe("creating a new note via the inline input", () => {
    it("creates a note in a server section via client.putNote and selects it", async () => {
      const putNote = vi.fn().mockResolvedValue(undefined);
      const runtime = serverRuntime("s1", "Server", { listNotes: [], putNote });
      const { onSelect } = renderSection(runtime);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));
      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.change(input, { target: { value: "new-note.md" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(putNote).toHaveBeenCalledWith("new-note.md", "# new-note\n"));
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith({ sourceId: "s1", path: "new-note.md" }));
    });

    it("creates a note in a folder section via store.writeLocal and never touches fetch", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const writeLocal = vi.fn().mockResolvedValue(undefined);
      const runtime = folderRuntime("f1", "Notes", { listLocal: [], writeLocal });
      const { onSelect } = renderSection(runtime);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));
      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.change(input, { target: { value: "new-note.md" } });
      fireEvent.keyDown(input, { key: "Enter" });

      await waitFor(() => expect(writeLocal).toHaveBeenCalledWith("new-note.md", "# new-note\n"));
      await waitFor(() => expect(onSelect).toHaveBeenCalledWith({ sourceId: "f1", path: "new-note.md" }));
      expect(fetchMock).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });

    it("enforces the .md extension and does not create the note", async () => {
      const putNote = vi.fn();
      const runtime = serverRuntime("s1", "Server", { listNotes: [], putNote });
      renderSection(runtime);

      await screen.findByText(/no notes yet/i);
      fireEvent.click(screen.getByText("+ New note"));
      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.change(input, { target: { value: "no-extension" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByRole("alert")).toHaveTextContent(/\.md/);
      expect(putNote).not.toHaveBeenCalled();
    });

    it("rejects a colliding path with an inline error instead of overwriting", async () => {
      const putNote = vi.fn();
      const runtime = serverRuntime("s1", "Server", {
        listNotes: [{ path: "existing.md", title: "Existing" }],
        putNote,
      });
      renderSection(runtime);

      await screen.findByText("Existing");
      fireEvent.click(screen.getByText("+ New note"));
      const input = screen.getByRole("textbox", { name: /path/i });
      fireEvent.change(input, { target: { value: "existing.md" } });
      fireEvent.keyDown(input, { key: "Enter" });

      expect(await screen.findByRole("alert")).toHaveTextContent(/already exists/i);
      expect(putNote).not.toHaveBeenCalled();
    });
  });
});

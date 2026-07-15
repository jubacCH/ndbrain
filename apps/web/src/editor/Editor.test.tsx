import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Editor, type ProviderFactory } from "./Editor";
import type { CollabProviderHandle } from "../api/collab";

// Real `mermaid` is a large dependency lazily loaded on first render (see
// `live-preview/mermaid.ts`) - stubbed here so the split-panel integration
// test below (clicking a rendered diagram) never touches it for real.
vi.mock("mermaid", () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: "<svg>diagram</svg>" }),
  },
}));

/** A render smoke for `<Editor>`: mounts a real CodeMirror `EditorView` bound
 *  to a real `Y.Doc`/`Y.Text`/`y-protocols` `Awareness` (so `yCollab` gets the
 *  actual shapes it expects), but the "provider" itself is a fake plain object
 *  - no real `@hocuspocus/provider`, no real WebSocket. That's the seam
 *  `providerFactory` exists for (see `Editor.tsx`'s doc comment): a real
 *  server round trip is explicitly out of scope here (Task 10's E2E covers
 *  that) - this only proves the component mounts, wires awareness, and tears
 *  down cleanly given a connection of the right shape. */
function makeFakeHandle(
  initialContent = "# hello\n",
): { handle: CollabProviderHandle; awareness: Awareness; ydoc: Y.Doc; ytext: Y.Text } {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, initialContent);
  const awareness = new Awareness(ydoc);

  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const provider = {
    document: ydoc,
    awareness,
    on(event: string, fn: (...args: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    off(event: string, fn: (...args: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.forEach((fn) => fn(...args));
    },
    destroy: vi.fn(),
  };

  const handle: CollabProviderHandle = {
    // The fake satisfies the structural surface `Editor.tsx` actually touches
    // (`.awareness`, `.document.clientID`, `.on`/`.off`, `.destroy`); cast past
    // the nominal `HocuspocusProvider` type for this test-only fake.
    provider: provider as unknown as CollabProviderHandle["provider"],
    ydoc,
    ytext,
    destroy() {
      provider.destroy();
      ydoc.destroy();
    },
  };

  return { handle, awareness, ydoc, ytext };
}

describe("<Editor>", () => {
  afterEach(() => {
    cleanup();
  });

  it("mounts a CodeMirror view seeded from the Y.Text, without crashing", async () => {
    const { handle } = makeFakeHandle();
    const providerFactory: ProviderFactory = () => handle;

    render(<Editor path="myai/deploy.md" token="tok" providerFactory={providerFactory} />);

    await waitFor(() => {
      expect(screen.getByTestId("editor-host").querySelector(".cm-editor")).toBeInTheDocument();
    });
    expect(screen.getByTestId("editor-host").textContent).toContain("hello");
  });

  it("shows a connecting status before any status event, then reflects a connected event", async () => {
    const { handle } = makeFakeHandle();
    const providerFactory: ProviderFactory = () => handle;

    render(<Editor path="myai/deploy.md" token="tok" providerFactory={providerFactory} />);

    expect(screen.getByText("Connecting…")).toBeInTheDocument();

    (handle.provider as unknown as { emit(event: string, ...args: unknown[]): void }).emit("status", {
      status: "connected",
    });

    await waitFor(() => expect(screen.getByText("Connected")).toBeInTheDocument());
  });

  it("shows offline once a disconnected status event fires", async () => {
    const { handle } = makeFakeHandle();
    const providerFactory: ProviderFactory = () => handle;

    render(<Editor path="myai/deploy.md" token="tok" providerFactory={providerFactory} />);

    (handle.provider as unknown as { emit(event: string, ...args: unknown[]): void }).emit("status", {
      status: "disconnected",
    });

    await waitFor(() => expect(screen.getByText("Offline")).toBeInTheDocument());
  });

  it("shows a distinct authentication-failed status when the provider rejects the token", async () => {
    const { handle } = makeFakeHandle();
    const providerFactory: ProviderFactory = () => handle;

    render(<Editor path="myai/deploy.md" token="stale-token" providerFactory={providerFactory} />);

    (handle.provider as unknown as { emit(event: string, ...args: unknown[]): void }).emit(
      "authenticationFailed",
      { reason: "invalid token" },
    );

    await waitFor(() => expect(screen.getByText("Authentication failed")).toBeInTheDocument());
    expect(screen.queryByText("Offline")).not.toBeInTheDocument();
  });

  it("renders an agent activity line once an agent's awareness state appears", async () => {
    const { handle, awareness } = makeFakeHandle();
    const providerFactory: ProviderFactory = () => handle;

    render(<Editor path="myai/deploy.md" token="tok" providerFactory={providerFactory} />);

    expect(screen.queryByText(/is editing/)).not.toBeInTheDocument();

    // Simulate the server injecting a remote agent-awareness state (see
    // `apps/server/src/collab/awareness.ts`'s `setAgentAwarenessState`) - a
    // distinct client id, then the same "change"/"awarenessChange" broadcast
    // the provider forwards from the real `Awareness` instance.
    awareness.states.set(999, { user: { name: "MyAI", agent: true, color: "#f59f00" } });
    (handle.provider as unknown as { emit(event: string, ...args: unknown[]): void }).emit("awarenessChange", {});

    await waitFor(() => expect(screen.getByText("🤖 MyAI is editing…")).toBeInTheDocument());
  });

  it("tears down the provider and destroys the editor view on unmount", async () => {
    const { handle } = makeFakeHandle();
    const providerFactory: ProviderFactory = () => handle;
    const destroySpy = vi.spyOn(handle, "destroy");

    const { unmount } = render(<Editor path="myai/deploy.md" token="tok" providerFactory={providerFactory} />);
    await waitFor(() => {
      expect(screen.getByTestId("editor-host").querySelector(".cm-editor")).toBeInTheDocument();
    });

    unmount();

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it("recreates the provider when the path changes", async () => {
    const first = makeFakeHandle();
    const second = makeFakeHandle();
    const factory = vi.fn<ProviderFactory>((opts) => (opts.path === "a.md" ? first.handle : second.handle));

    const { rerender } = render(<Editor path="a.md" token="tok" providerFactory={factory} />);
    await waitFor(() => expect(factory).toHaveBeenCalledWith({ path: "a.md", token: "tok" }));

    rerender(<Editor path="b.md" token="tok" providerFactory={factory} />);

    await waitFor(() => expect(factory).toHaveBeenCalledWith({ path: "b.md", token: "tok" }));
    expect(first.handle.provider.destroy).toHaveBeenCalledTimes(1);
  });

  it("renders live-preview formatted by default and shows raw markdown source once toggled (Plan 7 Task 4)", async () => {
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText("content");
    ytext.insert(0, "**bold**");
    const handle: CollabProviderHandle = {
      provider: {
        document: ydoc,
        awareness: null,
        on: vi.fn(),
        off: vi.fn(),
      } as unknown as CollabProviderHandle["provider"],
      ydoc,
      ytext,
      destroy: vi.fn(),
    };
    const providerFactory: ProviderFactory = () => handle;

    render(<Editor path="myai/deploy.md" token="tok" providerFactory={providerFactory} />);

    const host = await waitFor(() => screen.getByTestId("editor-host"));
    await waitFor(() => expect(host.querySelector(".cm-editor")).toBeInTheDocument());

    // Formatted (default): the `**` markers are hidden, only "bold" shows.
    expect(host.textContent).not.toContain("**");
    expect(host.textContent).toContain("bold");

    fireEvent.click(screen.getByTestId("raw-toggle"));

    // Raw: the exact markdown source is visible again, doc content unchanged.
    await waitFor(() => expect(host.textContent).toContain("**bold**"));
    expect(ytext.toString()).toBe("**bold**");
  });

  it("clicking a rendered mermaid diagram opens the split panel, and saving writes the new code back into the fence (Plan 7 Task 6)", async () => {
    // Needs a real `Awareness` (via `makeFakeHandle`, not a bare-bones fake
    // with `awareness: null`) so `yCollab` actually binds and the panel's
    // `view.dispatch` syncs back into `ytext` - without it the `EditorView`
    // is only ever seeded from `ytext` once and never synced further.
    const { handle, ytext } = makeFakeHandle("before\n\n```mermaid\ngraph TD\nA-->B\n```\n\nafter");
    const providerFactory: ProviderFactory = () => handle;

    render(<Editor path="myai/deploy.md" token="tok" providerFactory={providerFactory} />);

    const host = await waitFor(() => screen.getByTestId("editor-host"));
    const diagram = await waitFor(() => {
      const el = host.querySelector(".cm-lp-mermaid");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });

    fireEvent.click(diagram);

    const panel = await waitFor(() => screen.getByRole("dialog", { name: "Mermaid-Diagramm bearbeiten" }));
    expect(screen.getByLabelText("Mermaid-Code")).toHaveValue("graph TD\nA-->B");

    fireEvent.change(screen.getByLabelText("Mermaid-Code"), { target: { value: "graph LR\nX-->Y" } });
    fireEvent.click(screen.getByText("Übernehmen"));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(panel).not.toBeInTheDocument();
    // Only the fence's interior changed - the ``` markers and the rest of
    // the document are byte-identical to before.
    await waitFor(() => expect(ytext.toString()).toBe("before\n\n```mermaid\ngraph LR\nX-->Y\n```\n\nafter"));
  });

  it("clicking a rendered mermaid diagram then cancelling leaves the document unchanged (Plan 7 Task 6)", async () => {
    const { handle, ytext } = makeFakeHandle("```mermaid\ngraph TD\nA-->B\n```");
    const providerFactory: ProviderFactory = () => handle;

    render(<Editor path="myai/deploy.md" token="tok" providerFactory={providerFactory} />);

    const host = await waitFor(() => screen.getByTestId("editor-host"));
    const diagram = await waitFor(() => {
      const el = host.querySelector(".cm-lp-mermaid");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    fireEvent.click(diagram);

    await waitFor(() => screen.getByRole("dialog", { name: "Mermaid-Diagramm bearbeiten" }));
    fireEvent.change(screen.getByLabelText("Mermaid-Code"), { target: { value: "graph LR\nX-->Y" } });
    fireEvent.click(screen.getByText("Abbrechen"));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(ytext.toString()).toBe("```mermaid\ngraph TD\nA-->B\n```");
  });
});

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { Editor, type ProviderFactory } from "./Editor";
import type { CollabProviderHandle } from "../api/collab";

/** A render smoke for `<Editor>`: mounts a real CodeMirror `EditorView` bound
 *  to a real `Y.Doc`/`Y.Text`/`y-protocols` `Awareness` (so `yCollab` gets the
 *  actual shapes it expects), but the "provider" itself is a fake plain object
 *  - no real `@hocuspocus/provider`, no real WebSocket. That's the seam
 *  `providerFactory` exists for (see `Editor.tsx`'s doc comment): a real
 *  server round trip is explicitly out of scope here (Task 10's E2E covers
 *  that) - this only proves the component mounts, wires awareness, and tears
 *  down cleanly given a connection of the right shape. */
function makeFakeHandle(): { handle: CollabProviderHandle; awareness: Awareness; ydoc: Y.Doc } {
  const ydoc = new Y.Doc();
  const ytext = ydoc.getText("content");
  ytext.insert(0, "# hello\n");
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

  return { handle, awareness, ydoc };
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
});

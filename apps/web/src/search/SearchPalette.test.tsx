import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SearchHit } from "../api/client";
import { AppStateProvider, useAppState } from "../shell/AppState";
import { SearchPalette, type SearchClient } from "./SearchPalette";

const HIT_A: SearchHit = { path: "notes/a.md", title: "Note A", snippet: "some **matched** text", rank: 1 };
const HIT_B: SearchHit = { path: "notes/b.md", title: null, snippet: "plain snippet", rank: 2 };

// Real (unmocked) timers throughout — a short debounce override keeps the tests
// fast without fighting fake-timer/React-scheduler interaction quirks.
const TEST_DEBOUNCE_MS = 15;

function SelectedPathProbe() {
  const { selection } = useAppState();
  return <div data-testid="selected-path">{selection?.path ?? "none"}</div>;
}

function renderPalette(
  overrides: { client?: SearchClient; open?: boolean; onClose?: () => void; debounceMs?: number } = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const client: SearchClient = overrides.client ?? { search: vi.fn().mockResolvedValue([]) };
  render(
    <AppStateProvider>
      <SelectedPathProbe />
      <SearchPalette
        open={overrides.open ?? true}
        onClose={onClose}
        client={client}
        debounceMs={overrides.debounceMs ?? TEST_DEBOUNCE_MS}
      />
    </AppStateProvider>,
  );
  return { onClose, client };
}

describe("SearchPalette", () => {
  it("renders nothing when closed", () => {
    renderPalette({ open: false });
    expect(screen.queryByLabelText(/search notes/i)).not.toBeInTheDocument();
  });

  it("shows a prompt to type when the query is empty", () => {
    renderPalette();
    expect(screen.getByText(/type to search/i)).toBeInTheDocument();
  });

  it("debounces the search call: rapid keystrokes only fire one request", async () => {
    const search = vi.fn().mockResolvedValue([HIT_A]);
    renderPalette({ client: { search } });

    fireEvent.change(screen.getByLabelText(/search notes/i), { target: { value: "hel" } });
    fireEvent.change(screen.getByLabelText(/search notes/i), { target: { value: "hello" } });

    expect(search).not.toHaveBeenCalled();

    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    expect(search).toHaveBeenCalledWith("hello");
  });

  it("renders hit titles and bold-parsed snippets", async () => {
    renderPalette({ client: { search: vi.fn().mockResolvedValue([HIT_A]) } });

    fireEvent.change(screen.getByLabelText(/search notes/i), { target: { value: "matched" } });

    await waitFor(() => expect(screen.getByText("Note A")).toBeInTheDocument());
    const strong = screen.getByText("matched");
    expect(strong.tagName).toBe("STRONG");
  });

  it("falls back to the path when a hit has no title", async () => {
    renderPalette({ client: { search: vi.fn().mockResolvedValue([HIT_B]) } });

    fireEvent.change(screen.getByLabelText(/search notes/i), { target: { value: "plain" } });

    await waitFor(() => expect(screen.getByText("notes/b.md")).toBeInTheDocument());
  });

  it("shows a no-results state after a search with no hits", async () => {
    renderPalette({ client: { search: vi.fn().mockResolvedValue([]) } });

    fireEvent.change(screen.getByLabelText(/search notes/i), { target: { value: "nothing" } });

    await waitFor(() => expect(screen.getByText(/no results found/i)).toBeInTheDocument());
  });

  it("selects a note and closes the palette on result click", async () => {
    const { onClose } = renderPalette({ client: { search: vi.fn().mockResolvedValue([HIT_A]) } });

    fireEvent.change(screen.getByLabelText(/search notes/i), { target: { value: "matched" } });
    await waitFor(() => expect(screen.getByText("Note A")).toBeInTheDocument());

    fireEvent.click(screen.getByText("Note A"));

    expect(screen.getByTestId("selected-path")).toHaveTextContent("notes/a.md");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("selects the active result and closes on Enter", async () => {
    const { onClose } = renderPalette({ client: { search: vi.fn().mockResolvedValue([HIT_A, HIT_B]) } });

    fireEvent.change(screen.getByLabelText(/search notes/i), { target: { value: "note" } });
    await waitFor(() => expect(screen.getByText("Note A")).toBeInTheDocument());

    fireEvent.keyDown(document, { key: "Enter" });

    expect(screen.getByTestId("selected-path")).toHaveTextContent("notes/a.md");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves the active result down/up with arrow keys before selecting on Enter", async () => {
    const { onClose } = renderPalette({ client: { search: vi.fn().mockResolvedValue([HIT_A, HIT_B]) } });

    fireEvent.change(screen.getByLabelText(/search notes/i), { target: { value: "note" } });
    await waitFor(() => expect(screen.getByText("Note A")).toBeInTheDocument());

    fireEvent.keyDown(document, { key: "ArrowDown" });
    fireEvent.keyDown(document, { key: "Enter" });

    expect(screen.getByTestId("selected-path")).toHaveTextContent("notes/b.md");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without changing the selection", () => {
    const { onClose } = renderPalette();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("selected-path")).toHaveTextContent("none");
  });

  it("ignores a stale response if the query changed again before the first one resolved", async () => {
    let resolveFirst!: (hits: SearchHit[]) => void;
    const search = vi
      .fn()
      .mockImplementationOnce(() => new Promise<SearchHit[]>((resolve) => (resolveFirst = resolve)))
      .mockImplementationOnce(() => Promise.resolve([HIT_B]));
    renderPalette({ client: { search } });

    const input = screen.getByLabelText(/search notes/i);
    fireEvent.change(input, { target: { value: "first" } });
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));

    fireEvent.change(input, { target: { value: "second" } });
    await waitFor(() => expect(screen.getByText("notes/b.md")).toBeInTheDocument());

    // The first (superseded) request resolves late — its stale result must be
    // discarded rather than clobbering the second, already-rendered result.
    resolveFirst([HIT_A]);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(screen.queryByText("Note A")).not.toBeInTheDocument();
  });
});

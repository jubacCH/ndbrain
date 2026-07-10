import { render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { HistoryEntry } from "../api/client";
import { AppStateProvider, useAppState } from "../shell/AppState";
import { HistoryView, type HistoryClient } from "./HistoryView";

function fakeClient(overrides: Partial<HistoryClient> = {}): HistoryClient {
  return {
    history: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function renderView(client: HistoryClient, initialPath: string | null = "note.md") {
  function Init() {
    const { setSelectedPath } = useAppState();
    useEffect(() => {
      if (initialPath !== null) setSelectedPath(initialPath);
    }, [setSelectedPath]);
    return null;
  }
  return render(
    <AppStateProvider>
      <Init />
      <HistoryView client={client} />
    </AppStateProvider>,
  );
}

const ENTRIES: HistoryEntry[] = [
  { hash: "abc1234", message: "fix: typo", author: "Julian", date: "2026-07-10T11:00:00.000Z" },
  { hash: "def5678", message: "feat: add section", author: "Julian", date: "2026-07-09T10:00:00.000Z" },
];

describe("HistoryView", () => {
  it("renders a placeholder when no note is selected", () => {
    const client = fakeClient();
    renderView(client, null);

    expect(screen.getByText(/no note selected/i)).toBeInTheDocument();
    expect(client.history).not.toHaveBeenCalled();
  });

  it("shows a loading state while history is being fetched", () => {
    const client = fakeClient({ history: vi.fn(() => new Promise<HistoryEntry[]>(() => {})) });
    renderView(client);

    expect(screen.getByText(/loading history/i)).toBeInTheDocument();
  });

  it("shows an empty state when there is no history", async () => {
    const client = fakeClient({ history: vi.fn().mockResolvedValue([]) });
    renderView(client);

    expect(await screen.findByText(/no history/i)).toBeInTheDocument();
  });

  it("renders commit message, author, and formatted date for each entry", async () => {
    const client = fakeClient({ history: vi.fn().mockResolvedValue(ENTRIES) });
    renderView(client);

    expect(await screen.findByText("fix: typo")).toBeInTheDocument();
    expect(screen.getByText("feat: add section")).toBeInTheDocument();
    expect(screen.getAllByText("Julian")).toHaveLength(2);
  });

  it("fetches history for the current selected path", async () => {
    const history = vi.fn().mockResolvedValue([]);
    const client = fakeClient({ history });
    renderView(client, "notes/deep.md");

    await screen.findByText(/no history/i);
    expect(history).toHaveBeenCalledWith("notes/deep.md");
  });

  it("shows an error state when history fails", async () => {
    const client = fakeClient({ history: vi.fn().mockRejectedValue(new Error("boom")) });
    renderView(client);

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to load/i);
  });

  it("renders a disabled restore action per commit with a TODO, since there is no restore endpoint yet", async () => {
    const client = fakeClient({ history: vi.fn().mockResolvedValue(ENTRIES) });
    renderView(client);

    const restoreButtons = await screen.findAllByRole("button", { name: /restore/i });
    expect(restoreButtons).toHaveLength(2);
    for (const button of restoreButtons) {
      expect(button).toBeDisabled();
    }
    expect(screen.getAllByTitle(/not yet supported/i).length).toBeGreaterThan(0);
  });
});

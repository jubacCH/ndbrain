import { fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { AppStateProvider, useAppState } from "../shell/AppState";
import { BacklinksPanel, type BacklinksClient } from "./BacklinksPanel";

function fakeClient(overrides: Partial<BacklinksClient> = {}): BacklinksClient {
  return {
    backlinks: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/** Renders the currently selected path next to the panel so tests can assert on
 *  the context side-effect of clicking a backlink without reaching into internals. */
function SelectedPathProbe() {
  const { selectedPath } = useAppState();
  return <div data-testid="selected-path">{selectedPath ?? "none"}</div>;
}

function renderPanel(client: BacklinksClient, initialPath: string | null = "note.md") {
  function Init() {
    const { setSelectedPath } = useAppState();
    useEffect(() => {
      if (initialPath !== null) setSelectedPath(initialPath);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    return null;
  }
  return render(
    <AppStateProvider>
      <Init />
      <BacklinksPanel client={client} />
      <SelectedPathProbe />
    </AppStateProvider>,
  );
}

describe("BacklinksPanel", () => {
  it("renders a placeholder when no note is selected", () => {
    const client = fakeClient();
    renderPanel(client, null);

    expect(screen.getByText(/no note selected/i)).toBeInTheDocument();
    expect(client.backlinks).not.toHaveBeenCalled();
  });

  it("shows a loading state while backlinks are being fetched", () => {
    const client = fakeClient({ backlinks: vi.fn(() => new Promise<string[]>(() => {})) });
    renderPanel(client);

    expect(screen.getByText(/loading backlinks/i)).toBeInTheDocument();
  });

  it("shows an empty state when there are no backlinks", async () => {
    const client = fakeClient({ backlinks: vi.fn().mockResolvedValue([]) });
    renderPanel(client);

    expect(await screen.findByText(/no backlinks/i)).toBeInTheDocument();
  });

  it("renders the list of backlink source paths", async () => {
    const client = fakeClient({
      backlinks: vi.fn().mockResolvedValue(["projects/a.md", "b.md"]),
    });
    renderPanel(client);

    expect(await screen.findByText("projects/a.md")).toBeInTheDocument();
    expect(screen.getByText("b.md")).toBeInTheDocument();
  });

  it("clicking a backlink sets it as the selected path via AppState", async () => {
    const client = fakeClient({ backlinks: vi.fn().mockResolvedValue(["other.md"]) });
    renderPanel(client);

    const link = await screen.findByText("other.md");
    fireEvent.click(link);

    expect(screen.getByTestId("selected-path")).toHaveTextContent("other.md");
  });

  it("fetches with the current path and refetches when selectedPath changes", async () => {
    const backlinks = vi.fn().mockResolvedValue([]);
    const client = fakeClient({ backlinks });
    renderPanel(client, "note.md");

    await screen.findByText(/no backlinks/i);
    expect(backlinks).toHaveBeenCalledTimes(1);
    expect(backlinks).toHaveBeenCalledWith("note.md");
  });

  it("refetches exactly once per selectedPath change, without looping", async () => {
    const backlinks = vi.fn().mockResolvedValue([]);
    const client = fakeClient({ backlinks });

    function Init() {
      const { setSelectedPath } = useAppState();
      useEffect(() => {
        setSelectedPath("first.md");
      }, [setSelectedPath]);
      return null;
    }

    function Switcher() {
      const { setSelectedPath } = useAppState();
      return (
        <button type="button" onClick={() => setSelectedPath("second.md")}>
          switch
        </button>
      );
    }

    render(
      <AppStateProvider>
        <Init />
        <BacklinksPanel client={client} />
        <Switcher />
      </AppStateProvider>,
    );

    await screen.findByText(/no backlinks/i);
    expect(backlinks).toHaveBeenCalledTimes(1);
    expect(backlinks).toHaveBeenLastCalledWith("first.md");

    fireEvent.click(screen.getByText("switch"));

    await vi.waitFor(() => expect(backlinks).toHaveBeenCalledTimes(2));
    expect(backlinks).toHaveBeenLastCalledWith("second.md");
  });

  it("shows an error state when backlinks fails", async () => {
    const client = fakeClient({ backlinks: vi.fn().mockRejectedValue(new Error("boom")) });
    renderPanel(client);

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to load/i);
  });
});

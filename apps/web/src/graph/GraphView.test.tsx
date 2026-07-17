import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import type { Graph } from "../api/client";
import { AppStateProvider, useAppState } from "../shell/AppState";
import { GraphView, type GraphClient } from "./GraphView";

// react-force-graph-2d renders to <canvas> via a bespoke render loop that
// jsdom can't drive — this shallow-mocks the third-party component so we can
// assert on the props OUR code passes it (data, colors, click handler)
// without needing a real browser. Our own logic (buildGraphData, GraphView's
// state/wiring) is never mocked.
vi.mock("react-force-graph-2d", () => ({
  default: (props: {
    graphData: { nodes: { id: string; title: string | null }[]; links: unknown[] };
    onNodeClick: (node: { id: string }) => void;
    nodeColor: (node: { id: string }) => string;
  }) => (
    <div data-testid="force-graph-stub">
      {props.graphData.nodes.map((node) => (
        <button
          key={node.id}
          type="button"
          data-color={props.nodeColor(node)}
          onClick={() => props.onNodeClick(node)}
        >
          {node.id}
        </button>
      ))}
    </div>
  ),
}));

function fakeClient(overrides: Partial<GraphClient> = {}): GraphClient {
  return {
    graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    ...overrides,
  };
}

function renderView(client: GraphClient, initialPath: string | null = null) {
  function Init() {
    const { setSelection } = useAppState();
    useEffect(() => {
      if (initialPath !== null) setSelection({ sourceId: "origin", path: initialPath });
    }, [setSelection]);
    return null;
  }
  return render(
    <AppStateProvider>
      <Init />
      <GraphView client={client} />
    </AppStateProvider>,
  );
}

const GRAPH: Graph = {
  nodes: [
    { id: "a.md", title: "A" },
    { id: "b.md", title: "B" },
  ],
  edges: [{ source: "a.md", target: "b.md" }],
};

describe("GraphView", () => {
  it("shows a loading state before the graph resolves", () => {
    const client = fakeClient({ graph: vi.fn(() => new Promise<Graph>(() => {})) });
    renderView(client);

    expect(screen.getByText(/loading graph/i)).toBeInTheDocument();
  });

  it("fetches the graph on mount", () => {
    const client = fakeClient();
    renderView(client);

    expect(client.graph).toHaveBeenCalledTimes(1);
  });

  it("shows an empty state when the vault has no notes", async () => {
    const client = fakeClient({ graph: vi.fn().mockResolvedValue({ nodes: [], edges: [] }) });
    renderView(client);

    expect(await screen.findByText(/no notes yet/i)).toBeInTheDocument();
  });

  it("shows an error state when the fetch fails", async () => {
    const client = fakeClient({ graph: vi.fn().mockRejectedValue(new Error("boom")) });
    renderView(client);

    expect(await screen.findByRole("alert")).toHaveTextContent(/failed to load/i);
  });

  it("renders the global graph by default with all nodes", async () => {
    const client = fakeClient({ graph: vi.fn().mockResolvedValue(GRAPH) });
    renderView(client);

    expect(await screen.findByText("a.md")).toBeInTheDocument();
    expect(screen.getByText("b.md")).toBeInTheDocument();
  });

  it("defaults to the Global scope button being pressed", async () => {
    const client = fakeClient({ graph: vi.fn().mockResolvedValue(GRAPH) });
    renderView(client);
    await screen.findByText("a.md");

    expect(screen.getByRole("button", { name: "Global" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Local" })).toHaveAttribute("aria-pressed", "false");
  });

  it("switching to Local with no selected note prompts the user to select one", async () => {
    const client = fakeClient({ graph: vi.fn().mockResolvedValue(GRAPH) });
    renderView(client, null);
    await screen.findByText("a.md");

    fireEvent.click(screen.getByRole("button", { name: "Local" }));

    expect(screen.getByText(/select a note/i)).toBeInTheDocument();
    expect(screen.queryByText("a.md")).not.toBeInTheDocument();
  });

  it("switching to Local with a selected note shows only its neighborhood", async () => {
    const graph: Graph = {
      nodes: [
        { id: "a.md", title: "A" },
        { id: "b.md", title: "B" },
        { id: "unrelated.md", title: "U" },
      ],
      edges: [
        { source: "a.md", target: "b.md" },
      ],
    };
    const client = fakeClient({ graph: vi.fn().mockResolvedValue(graph) });
    renderView(client, "a.md");
    await screen.findByText("a.md");

    fireEvent.click(screen.getByRole("button", { name: "Local" }));

    expect(screen.getByText("a.md")).toBeInTheDocument();
    expect(screen.getByText("b.md")).toBeInTheDocument();
    expect(screen.queryByText("unrelated.md")).not.toBeInTheDocument();
  });

  it("clicking a node navigates the app's selected path", async () => {
    const client = fakeClient({ graph: vi.fn().mockResolvedValue(GRAPH) });
    let observedPath: string | null = null;

    function Observer() {
      const { selection } = useAppState();
      observedPath = selection?.path ?? null;
      return null;
    }

    render(
      <AppStateProvider>
        <Observer />
        <GraphView client={client} />
      </AppStateProvider>,
    );
    await screen.findByText("a.md");

    fireEvent.click(screen.getByText("b.md"));

    expect(observedPath).toBe("b.md");
  });

  it("highlights the currently selected node with a distinct color", async () => {
    const client = fakeClient({ graph: vi.fn().mockResolvedValue(GRAPH) });
    renderView(client, "a.md");
    await screen.findByText("a.md");

    const selectedButton = screen.getByText("a.md");
    const otherButton = screen.getByText("b.md");
    expect(selectedButton.getAttribute("data-color")).not.toBe(otherButton.getAttribute("data-color"));
  });

  it("the refresh button re-fetches the graph", async () => {
    const graphFn = vi.fn().mockResolvedValue(GRAPH);
    const client = fakeClient({ graph: graphFn });
    renderView(client);
    await screen.findByText("a.md");

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

    expect(graphFn).toHaveBeenCalledTimes(2);
  });

  it("re-fetches when the selected note changes", async () => {
    const graphFn = vi.fn().mockResolvedValue(GRAPH);
    const client = fakeClient({ graph: graphFn });

    function Harness() {
      const { setSelection } = useAppState();
      return (
        <>
          <button type="button" onClick={() => setSelection({ sourceId: "origin", path: "c.md" })}>
            select-c
          </button>
          <GraphView client={client} />
        </>
      );
    }

    render(
      <AppStateProvider>
        <Harness />
      </AppStateProvider>,
    );
    await screen.findByText("a.md");
    expect(graphFn).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("select-c"));
    await waitFor(() => expect(graphFn).toHaveBeenCalledTimes(2));
  });
});

/** Obsidian-style graph view: fetches `GET /api/v1/graph` and renders it with
 *  `react-force-graph-2d`. Two scopes:
 *   - "global": the whole vault graph.
 *   - "local": just `useAppState().selectedPath` and its neighbors
 *     (`localNeighborhood`, depth 1).
 *  Clicking a node navigates to it via `setSelectedPath`; the currently
 *  selected note is highlighted. The graph re-fetches whenever the selected
 *  note changes (cheap enough for a vault-sized graph, and simplest way to
 *  pick up new links after a save) plus a manual refresh button. */

import { useCallback, useEffect, useMemo, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import { apiClient, type Graph } from "../api/client";
import { useAppState } from "../shell/AppState";
import { useTheme } from "../theme/useTheme";
import { localNeighborhood, toForceGraph, type ForceGraphData } from "./buildGraphData";
import styles from "./GraphView.module.css";

/** Structural subset of `ApiClient` this component needs — lets tests inject a
 *  fake without constructing a real client (same pattern as `BacklinksClient`). */
export interface GraphClient {
  graph(): Promise<Graph>;
}

export type GraphScope = "global" | "local";

export interface GraphViewProps {
  client?: GraphClient;
}

interface ThemeColors {
  background: string;
  node: string;
  selectedNode: string;
  link: string;
}

const LIGHT_COLORS: ThemeColors = {
  background: "#ffffff",
  node: "#3457d5",
  selectedNode: "#c0362c",
  link: "#dde1e7",
};

const DARK_COLORS: ThemeColors = {
  background: "#0e1116",
  node: "#5b7cfa",
  selectedNode: "#ef6a61",
  link: "#2a313c",
};

export function GraphView({ client = apiClient }: GraphViewProps = {}) {
  const { selectedPath, setSelectedPath } = useAppState();
  const { resolvedTheme } = useTheme();
  const [graph, setGraph] = useState<Graph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<GraphScope>("global");

  const refresh = useCallback(() => {
    setError(null);
    client
      .graph()
      .then((result) => setGraph(result))
      .catch(() => setError("Failed to load graph."));
  }, [client]);

  // Re-fetch on mount and whenever the selected note changes — good enough for
  // v1 to pick up newly-saved links without a polling loop or websocket.
  useEffect(() => {
    refresh();
  }, [refresh, selectedPath]);

  const data: ForceGraphData | null = useMemo(() => {
    if (graph === null) return null;
    if (scope === "local") {
      if (selectedPath === null) return { nodes: [], links: [] };
      return localNeighborhood(graph, selectedPath);
    }
    return toForceGraph(graph);
  }, [graph, scope, selectedPath]);

  const colors = resolvedTheme === "dark" ? DARK_COLORS : LIGHT_COLORS;

  const needsSelection = scope === "local" && selectedPath === null;
  const isEmpty = data !== null && data.nodes.length === 0 && !needsSelection;

  return (
    <section className={styles.panel} aria-label="Graph">
      <div className={styles.toolbar}>
        <div className={styles.scopeGroup} role="group" aria-label="Graph scope">
          <button
            type="button"
            className={styles.scopeButton}
            aria-pressed={scope === "global"}
            onClick={() => setScope("global")}
          >
            Global
          </button>
          <button
            type="button"
            className={styles.scopeButton}
            aria-pressed={scope === "local"}
            onClick={() => setScope("local")}
          >
            Local
          </button>
        </div>
        <button type="button" className={styles.refreshButton} onClick={refresh}>
          Refresh
        </button>
      </div>

      {error && (
        <p className={styles.status} role="alert">
          {error}
        </p>
      )}

      {!error && graph === null && <p className={styles.status}>Loading graph…</p>}

      {!error && graph !== null && needsSelection && (
        <p className={styles.status}>Select a note to see its local graph.</p>
      )}

      {!error && isEmpty && <p className={styles.status}>No notes yet.</p>}

      {!error && data !== null && data.nodes.length > 0 && (
        <div className={styles.canvasWrap} data-testid="graph-canvas-wrap">
          <ForceGraph2D
            graphData={data}
            nodeId="id"
            nodeLabel={(node) => (node as { id: string; title: string | null }).title ?? (node as { id: string }).id}
            nodeColor={(node) =>
              (node as { id: string }).id === selectedPath ? colors.selectedNode : colors.node
            }
            linkColor={() => colors.link}
            backgroundColor={colors.background}
            onNodeClick={(node) => setSelectedPath(String((node as { id: string }).id))}
          />
        </div>
      )}
    </section>
  );
}

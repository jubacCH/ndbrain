/** Renders the vault as a collapsible folder tree in the sidebar. Fetches
 *  `GET /notes`, builds the tree with `buildTree`, and coordinates the selected
 *  note via `useAppState()` — clicking a note is the only way this component
 *  talks to the rest of the app, so it stays decoupled from the editor (Task 6). */

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient, type NoteSummary } from "../api/client";
import { useAppState } from "../shell/AppState";
import { buildTree, type TreeNode } from "./buildTree";
import styles from "./NoteTree.module.css";

/** Structural subset of `ApiClient` this component needs — lets tests inject a
 *  fake without constructing a real client (same pattern as `AuthClient`). */
export interface NoteTreeClient {
  listNotes(): Promise<NoteSummary[]>;
  putNote(path: string, content: string): Promise<void>;
}

export interface NoteTreeProps {
  client?: NoteTreeClient;
}

export function NoteTree({ client = apiClient }: NoteTreeProps = {}) {
  const { selectedPath, setSelectedPath } = useAppState();
  const [notes, setNotes] = useState<NoteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    try {
      const result = await client.listNotes();
      setNotes(result);
      setError(null);
    } catch {
      setNotes([]);
      setError("Failed to load notes.");
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const tree = useMemo(() => buildTree(notes ?? []), [notes]);

  function toggleFolder(path: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function handleNewNote() {
    const input = window.prompt("Path for the new note (must end with .md)");
    if (!input) return;
    const path = input.trim();
    if (!path.toLowerCase().endsWith(".md")) {
      window.alert("The note path must end with .md");
      return;
    }

    const fileName = path.split("/").pop() ?? path;
    const title = fileName.slice(0, -3);
    await client.putNote(path, `# ${title}\n`);
    await refresh();
    setSelectedPath(path);
  }

  return (
    <nav className={styles.tree} aria-label="Notes">
      <div className={styles.header}>
        <span className={styles.heading}>Notes</span>
        <button type="button" className={styles.newNote} onClick={() => void handleNewNote()}>
          + New note
        </button>
      </div>

      {notes === null && !error && <p className={styles.status}>Loading notes…</p>}
      {error && (
        <p className={styles.status} role="alert">
          {error}
        </p>
      )}
      {notes !== null && !error && tree.length === 0 && (
        <p className={styles.status}>No notes yet — create your first one.</p>
      )}

      <ul className={styles.list}>
        {tree.map((node) => (
          <TreeNodeView
            key={node.path}
            node={node}
            depth={0}
            collapsed={collapsed}
            onToggleFolder={toggleFolder}
            selectedPath={selectedPath}
            onSelect={setSelectedPath}
          />
        ))}
      </ul>
    </nav>
  );
}

interface TreeNodeViewProps {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggleFolder: (path: string) => void;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

/** Indentation is expressed as discrete CSS classes (capped at 8 levels) rather
 *  than an inline `style`, so depth-based padding stays in the stylesheet. */
const MAX_INDENT_DEPTH = 8;

function depthClassName(depth: number): string {
  const clamped = Math.min(depth, MAX_INDENT_DEPTH);
  return styles[`depth${clamped}`] ?? "";
}

function TreeNodeView({ node, depth, collapsed, onToggleFolder, selectedPath, onSelect }: TreeNodeViewProps) {
  const indentClass = depthClassName(depth);

  if (node.type === "folder") {
    const isCollapsed = collapsed.has(node.path);
    return (
      <li>
        <button
          type="button"
          className={`${styles.folder} ${indentClass}`}
          onClick={() => onToggleFolder(node.path)}
          aria-expanded={!isCollapsed}
        >
          <span className={styles.disclosure} aria-hidden="true">
            {isCollapsed ? "▸" : "▾"}
          </span>
          {node.name}
        </button>
        {!isCollapsed && (
          <ul>
            {node.children.map((child) => (
              <TreeNodeView
                key={child.path}
                node={child}
                depth={depth + 1}
                collapsed={collapsed}
                onToggleFolder={onToggleFolder}
                selectedPath={selectedPath}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isSelected = node.path === selectedPath;
  return (
    <li>
      <button
        type="button"
        className={
          isSelected ? `${styles.note} ${styles.selected} ${indentClass}` : `${styles.note} ${indentClass}`
        }
        onClick={() => onSelect(node.path)}
        aria-current={isSelected ? "page" : undefined}
      >
        {node.title ?? node.name}
      </button>
    </li>
  );
}

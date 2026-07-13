/** Tabbed right-panel switcher for the currently selected note: Backlinks /
 *  Graph / History. Owns its own tab state — per `AppShell`'s doc comment, the
 *  shell itself only ever sees a `ReactNode` for `rightPanel` and has no idea
 *  these three views exist. Only the active tab's view is mounted, so switching
 *  tabs re-fetches fresh data rather than juggling three permanently-live
 *  subscriptions for a panel that's only ever showing one at a time. */

import { useState } from "react";
import { BacklinksPanel } from "../panels/BacklinksPanel";
import { GraphView } from "../graph/GraphView";
import { HistoryView } from "../history/HistoryView";
import styles from "./RightPanel.module.css";

type RightPanelTab = "backlinks" | "graph" | "history";

const TABS: Array<{ id: RightPanelTab; label: string }> = [
  { id: "backlinks", label: "Backlinks" },
  { id: "graph", label: "Graph" },
  { id: "history", label: "History" },
];

export function RightPanel() {
  const [tab, setTab] = useState<RightPanelTab>("backlinks");

  return (
    <div className={styles.panel}>
      <div className={styles.tabs} role="tablist" aria-label="Note panels">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? `${styles.tab} ${styles.active}` : styles.tab}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className={styles.content}>
        {tab === "backlinks" && <BacklinksPanel />}
        {tab === "graph" && <GraphView />}
        {tab === "history" && <HistoryView />}
      </div>
    </div>
  );
}

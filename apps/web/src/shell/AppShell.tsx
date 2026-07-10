/** The authed app layout: sidebar (brand, search trigger, note tree slot, settings
 *  nav, theme toggle, user/logout) + main content slot + an optional right panel
 *  slot. This is the STABLE contract later tasks build on:
 *
 *  - `sidebar` — Task 5 passes `<NoteTree />`; nothing else about the shell needs
 *    to change if the sidebar's contents change later.
 *  - `main` — the editor (Task 6) renders here, keyed by `useAppState().selectedPath`.
 *  - `rightPanel` — omitted/undefined hides the panel entirely; Task 8 (backlinks)
 *    and Task 9 (graph) pass content here, e.g. via their own internal tab state.
 *  - `onSearchClick` / `onSettingsClick` — wired up for real by Task 7 (search
 *    palette) and Task 9 (settings view) respectively; both are optional so the
 *    shell renders sensibly before those tasks land.
 *
 *  Note selection itself is NOT a prop here — it flows through `AppState`
 *  (`useAppState()` in `shell/AppState.tsx`), so `sidebar` and `main` coordinate
 *  without the shell needing to broker it. */

import type { ReactNode } from "react";
import { useTheme } from "../theme/useTheme";
import styles from "./AppShell.module.css";

export interface AppShellProps {
  /** Sidebar content below the search trigger — the note tree (Task 5+). */
  sidebar: ReactNode;
  /** Main content area — placeholder now, the editor from Task 6 onward. */
  main: ReactNode;
  /** Right panel content (backlinks/graph). Omit to hide the panel entirely. */
  rightPanel?: ReactNode;
  /** Currently signed-in username, shown next to the logout button. */
  username?: string | null;
  onLogout: () => void;
  /** Fired by the search-trigger button. Task 7 wires this to open the search palette. */
  onSearchClick?: () => void;
  /** Fired by the Settings nav item. Task 9 wires this to show the settings view. */
  onSettingsClick?: () => void;
}

export function AppShell({
  sidebar,
  main,
  rightPanel,
  username,
  onLogout,
  onSearchClick,
  onSettingsClick,
}: AppShellProps) {
  const { resolvedTheme, toggleTheme } = useTheme();

  return (
    <div className={rightPanel ? `${styles.shell} ${styles.withRightPanel}` : styles.shell}>
      <aside className={styles.sidebar} aria-label="Notes navigation">
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            ◆
          </span>
          <span className={styles.brandName}>ndBrain</span>
        </div>

        <button type="button" className={styles.searchTrigger} onClick={() => onSearchClick?.()}>
          Search…
        </button>

        <div className={styles.tree}>{sidebar}</div>

        <div className={styles.sidebarFooter}>
          <button type="button" className={styles.navButton} onClick={() => onSettingsClick?.()}>
            Settings
          </button>

          <button
            type="button"
            className={styles.themeToggle}
            onClick={toggleTheme}
            aria-label={resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {resolvedTheme === "dark" ? "🌙" : "☀️"}
          </button>

          <div className={styles.userRow}>
            {username && <span className={styles.username}>{username}</span>}
            <button type="button" className={styles.logout} onClick={onLogout}>
              Log out
            </button>
          </div>
        </div>
      </aside>

      <main className={styles.main} aria-label="Note content">
        {main}
      </main>

      {rightPanel && (
        <aside className={styles.rightPanel} aria-label="Panels">
          {rightPanel}
        </aside>
      )}
    </div>
  );
}

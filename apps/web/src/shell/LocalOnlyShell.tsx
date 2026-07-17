/** Minimal desktop-client shell for local-only mode (see
 *  `local/localOnlyMode.ts`): no server, no login, no `AuthProvider`.
 *
 *  Rendered by `App.tsx` instead of `AuthedShell` whenever `isLocalOnly()` is
 *  true. Its only content is the already-built `<LocalNotesView>` (folder
 *  picker, `.md` list, editor, on-device search) - this component adds just
 *  enough chrome around it (brand, a "Local only" indicator, a theme toggle,
 *  a way back to the server flow, and a statusbar reflecting the notes
 *  folder/count) to not feel like a bare component dropped on a blank page.
 *  Deliberately does not reuse `AppShell`: that layout assumes an authed
 *  session (sidebar note tree, logout, settings, right panel) that simply
 *  doesn't exist here. */

import { useState } from "react";
import { useTheme } from "../theme/useTheme";
import { LocalNotesView, type LocalNotesStatus } from "../local/LocalNotesView";
import styles from "./LocalOnlyShell.module.css";

export interface LocalOnlyShellProps {
  /** Fired by "Connect to a server…" - the parent clears the persisted
   *  local-only flag (`setLocalOnly(false)`) and transitions back to
   *  `ServerUrlView`. This component never touches that flag itself. */
  onConnectServer: () => void;
}

export function LocalOnlyShell({ onConnectServer }: LocalOnlyShellProps) {
  const { resolvedTheme, toggleTheme } = useTheme();
  // `LocalNotesView` already owns the folder/notes-count state (it needs it
  // for its own list pane) — rather than duplicating that fs/store lookup
  // here just to render a statusbar, it reports its current folder/count up
  // through this callback whenever either changes. Kept optional on
  // `LocalNotesView` so it stays standalone-usable without a shell (it is
  // also rendered directly by `AppRoot`'s "Local" tab, with no statusbar).
  const [status, setStatus] = useState<LocalNotesStatus>({ folder: null, count: 0 });

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <svg className={styles.logo} width="22" height="17" viewBox="0 0 26 20" fill="none" aria-hidden="true">
            <circle className={styles.logoRing1} cx="9.5" cy="10" r="6.5" strokeWidth="3" />
            <circle className={styles.logoRing2} cx="16.5" cy="10" r="6.5" strokeWidth="3" />
          </svg>
          <span className={styles.brandName}>ndBrain</span>
          <span className={styles.badge}>Local only</span>
        </div>

        <div className={styles.actions}>
          <button
            type="button"
            className={styles.themeToggle}
            onClick={toggleTheme}
            aria-label={resolvedTheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          >
            {resolvedTheme === "dark" ? (
              // Sun — shown in dark mode as the affordance to switch to light.
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <circle cx="7.5" cy="7.5" r="3" stroke="currentColor" strokeWidth="1.2" />
                <path
                  d="M7.5 1v1.6M7.5 12.4V14M14 7.5h-1.6M2.6 7.5H1M12.34 2.66l-1.13 1.13M3.79 11.21l-1.13 1.13M12.34 12.34l-1.13-1.13M3.79 3.79 2.66 2.66"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            ) : (
              // Crescent moon — shown in light mode as the affordance to switch to dark.
              <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                <path
                  d="M11.5 8.7A4.6 4.6 0 1 1 6.3 3.5a3.7 3.7 0 0 0 5.2 5.2Z"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>

          <button type="button" className={styles.connect} onClick={onConnectServer}>
            Connect to a server…
          </button>
        </div>
      </header>

      <main className={styles.main}>
        <LocalNotesView onStatusChange={setStatus} />
      </main>

      <footer className={styles.statusbar}>
        {status.folder ? (
          <>
            <span className={styles.statusFolder} title={status.folder}>
              {status.folder}
            </span>
            <span className={styles.statusCount}>{status.count === 1 ? "1 note" : `${status.count} notes`}</span>
            <span className={styles.statusSpacer} />
            <span className={styles.statusMode}>markdown · local</span>
          </>
        ) : (
          <span className={styles.statusFolder}>no folder</span>
        )}
      </footer>
    </div>
  );
}

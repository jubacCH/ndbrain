/** Minimal desktop-client shell for local-only mode (see
 *  `local/localOnlyMode.ts`): no server, no login, no `AuthProvider`.
 *
 *  Rendered by `App.tsx` instead of `AuthedShell` whenever `isLocalOnly()` is
 *  true. Its only content is the already-built `<LocalNotesView>` (folder
 *  picker, `.md` list, editor, on-device search) - this component adds just
 *  enough chrome around it (brand, a "Local only" indicator, a theme toggle,
 *  and a way back to the server flow) to not feel like a bare component
 *  dropped on a blank page. Deliberately does not reuse `AppShell`: that
 *  layout assumes an authed session (sidebar note tree, logout, settings,
 *  right panel) that simply doesn't exist here. */

import { useTheme } from "../theme/useTheme";
import { LocalNotesView } from "../local/LocalNotesView";
import styles from "./LocalOnlyShell.module.css";

export interface LocalOnlyShellProps {
  /** Fired by "Connect to a server…" - the parent clears the persisted
   *  local-only flag (`setLocalOnly(false)`) and transitions back to
   *  `ServerUrlView`. This component never touches that flag itself. */
  onConnectServer: () => void;
}

export function LocalOnlyShell({ onConnectServer }: LocalOnlyShellProps) {
  const { resolvedTheme, toggleTheme } = useTheme();

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            ◆
          </span>
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
            {resolvedTheme === "dark" ? "🌙" : "☀️"}
          </button>

          <button type="button" className={styles.connect} onClick={onConnectServer}>
            Connect to a server…
          </button>
        </div>
      </header>

      <main className={styles.main}>
        <LocalNotesView />
      </main>
    </div>
  );
}

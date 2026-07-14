/** Assembles the authed app experience out of the standalone pieces Tasks 5-9
 *  built: `NoteTree` in the sidebar, the collaborative `Editor` (or `Settings`)
 *  in the main slot, a tabbed Backlinks/Graph/History `RightPanel`, and the
 *  global Cmd/Ctrl-K search palette. This is the final wiring point Task 10
 *  exists for — everything here is glue over the stable `AppShell`/`AppState`
 *  contracts, not a new one. */

import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { Editor } from "../editor/Editor";
import { LocalNotesView } from "../local/LocalNotesView";
import { NoteTree } from "../notes/NoteTree";
import { isTauri } from "../platform/tauri";
import { SearchPalette } from "../search/SearchPalette";
import { useSearchPalette } from "../search/useSearchPalette";
import { AppShell } from "./AppShell";
import { AppStateProvider, useAppState } from "./AppState";
import { RightPanel } from "./RightPanel";
import { SettingsArea } from "./SettingsArea";
import styles from "./AppRoot.module.css";

interface MainContentProps {
  settingsOpen: boolean;
  /** Latches true the first time Settings is opened and never resets — see
   *  `SettingsArea`'s doc comment on why it stays mounted (hidden via CSS)
   *  rather than unmounting on close, once it's been opened at all. */
  settingsEverOpened: boolean;
  onCloseSettings: () => void;
  /** Tauri-only local-notes area (Task 5) — same open/everOpened/mount-once
   *  pattern as Settings above. Both `localOpen`/`localEverOpened` stay false
   *  forever in the browser (nothing can flip them: `AppShell`'s "Local" nav
   *  button, the only trigger, is never rendered there — see `AuthedApp`
   *  below), so `<LocalNotesView>` is never mounted in the browser build. */
  localOpen: boolean;
  localEverOpened: boolean;
}

function MainContent({
  settingsOpen,
  settingsEverOpened,
  onCloseSettings,
  localOpen,
  localEverOpened,
}: MainContentProps) {
  const { selectedPath } = useAppState();
  const { token } = useAuth();

  return (
    <div className={styles.mainStack}>
      {!settingsOpen && !localOpen && (
        <div className={styles.mainSlot}>
          {selectedPath ? (
            <Editor path={selectedPath} token={token} key={selectedPath} />
          ) : (
            <p className={styles.placeholder}>Select a note to start editing.</p>
          )}
        </div>
      )}

      {localEverOpened && (
        <div className={localOpen ? styles.mainSlot : styles.hidden}>
          <LocalNotesView />
        </div>
      )}

      {settingsEverOpened && (
        <div className={settingsOpen ? styles.mainSlot : styles.hidden}>
          <SettingsArea open={settingsOpen} onClose={onCloseSettings} />
        </div>
      )}
    </div>
  );
}

function AuthedApp() {
  const { username, logout } = useAuth();
  const { open, openPalette, closePalette } = useSearchPalette();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsEverOpened, setSettingsEverOpened] = useState(false);
  const [localOpen, setLocalOpen] = useState(false);
  const [localEverOpened, setLocalEverOpened] = useState(false);

  useEffect(() => {
    if (settingsOpen) setSettingsEverOpened(true);
  }, [settingsOpen]);

  useEffect(() => {
    if (localOpen) setLocalEverOpened(true);
  }, [localOpen]);

  function toggleSettings() {
    setSettingsOpen((wasOpen) => {
      const next = !wasOpen;
      if (next) setLocalOpen(false);
      return next;
    });
  }

  function toggleLocal() {
    setLocalOpen((wasOpen) => {
      const next = !wasOpen;
      if (next) setSettingsOpen(false);
      return next;
    });
  }

  return (
    <>
      <AppShell
        sidebar={<NoteTree />}
        main={
          <MainContent
            settingsOpen={settingsOpen}
            settingsEverOpened={settingsEverOpened}
            onCloseSettings={() => setSettingsOpen(false)}
            localOpen={localOpen}
            localEverOpened={localEverOpened}
          />
        }
        rightPanel={settingsOpen || localOpen ? undefined : <RightPanel />}
        username={username}
        onLogout={() => void logout()}
        onSearchClick={openPalette}
        onSettingsClick={toggleSettings}
        // Only handed to `AppShell` at all when running in Tauri — see
        // `AppShellProps.onLocalClick`'s doc comment: omitting the prop (vs.
        // passing a no-op) is what hides the "Local" nav button entirely in
        // the browser build.
        onLocalClick={isTauri() ? toggleLocal : undefined}
      />

      <SearchPalette open={open} onClose={closePalette} />
    </>
  );
}

/** Public entry point Task 10's `App.tsx` renders once `useAuth()` reports an
 *  authenticated session. Owns `AppStateProvider` itself so everything under it
 *  (sidebar, editor, right panel, search palette) shares one `selectedPath`
 *  without `App.tsx` needing to know that wiring exists. */
export function AppRoot() {
  return (
    <AppStateProvider>
      <AuthedApp />
    </AppStateProvider>
  );
}

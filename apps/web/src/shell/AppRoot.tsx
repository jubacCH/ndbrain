/** Assembles the authed app experience out of the standalone pieces Tasks 5-9
 *  built: `NoteTree` in the sidebar, the collaborative `Editor` (or `Settings`)
 *  in the main slot, a tabbed Backlinks/Graph/History `RightPanel`, and the
 *  global Cmd/Ctrl-K search palette. This is the final wiring point Task 10
 *  exists for — everything here is glue over the stable `AppShell`/`AppState`
 *  contracts, not a new one. */

import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { Editor } from "../editor/Editor";
import { NoteTree } from "../notes/NoteTree";
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
}

function MainContent({ settingsOpen, settingsEverOpened, onCloseSettings }: MainContentProps) {
  const { selectedPath } = useAppState();
  const { token } = useAuth();

  return (
    <div className={styles.mainStack}>
      {!settingsOpen && (
        <div className={styles.mainSlot}>
          {selectedPath ? (
            <Editor path={selectedPath} token={token} key={selectedPath} />
          ) : (
            <p className={styles.placeholder}>Select a note to start editing.</p>
          )}
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

  useEffect(() => {
    if (settingsOpen) setSettingsEverOpened(true);
  }, [settingsOpen]);

  return (
    <>
      <AppShell
        sidebar={<NoteTree />}
        main={
          <MainContent
            settingsOpen={settingsOpen}
            settingsEverOpened={settingsEverOpened}
            onCloseSettings={() => setSettingsOpen(false)}
          />
        }
        rightPanel={settingsOpen ? undefined : <RightPanel />}
        username={username}
        onLogout={() => void logout()}
        onSearchClick={openPalette}
        onSettingsClick={() => setSettingsOpen((v) => !v)}
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

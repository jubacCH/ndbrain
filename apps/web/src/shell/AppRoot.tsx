/** Assembles the authed app experience out of the standalone pieces Tasks 5-9
 *  and Plan 8 built: a `SourceSection` per registered source in the sidebar
 *  (Task 6's unified sidebar — one section per source, never two separate
 *  UIs for "local" vs "server"), the collaborative `Editor` (or `Settings`)
 *  in the main slot, a tabbed Backlinks/Graph/History `RightPanel`, and the
 *  global Cmd/Ctrl-K search palette. This is the final wiring point Task 10
 *  exists for — everything here is glue over the stable `AppShell`/`AppState`
 *  contracts, not a new one.
 *
 *  The standalone "Local" nav button/panel (Task 5's `<LocalNotesView>`) is
 *  gone: a folder source's notes now show inline as their own sidebar
 *  section, side by side with every server section, so there is no separate
 *  place left for it to open. */

import { useEffect, useState } from "react";
import { useAuth } from "../auth/useAuth";
import { SourceSection } from "../notes/SourceSection";
import { SearchPalette } from "../search/SearchPalette";
import { useSearchPalette } from "../search/useSearchPalette";
import { useSources } from "../sources/useSources";
import { AppShell } from "./AppShell";
import { AppStateProvider, useAppState } from "./AppState";
import { EditorPane } from "./EditorPane";
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
  return (
    <div className={styles.mainStack}>
      {!settingsOpen && (
        <div className={styles.mainSlot}>
          <EditorPane />
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

/** The sidebar: one `SourceSection` per registered source, in registry order
 *  (`useSources()` already returns them that way — see `SourcesProvider`).
 *  `showHeader` is false only when there is exactly one source, i.e. the
 *  plain browser build's single implicit "origin" source — that is the hard
 *  no-regression requirement: a lone source must never grow a redundant
 *  "SERVER" header nobody asked for. */
function Sidebar() {
  const { sources } = useSources();
  const { selection, setSelection } = useAppState();
  const showHeader = sources.length > 1;

  return (
    <div className={styles.sidebar}>
      {sources.map((runtime) => (
        <SourceSection
          key={runtime.def.id}
          runtime={runtime}
          selection={selection}
          onSelect={setSelection}
          showHeader={showHeader}
        />
      ))}
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

  function toggleSettings() {
    setSettingsOpen((wasOpen) => !wasOpen);
  }

  return (
    <>
      <AppShell
        sidebar={<Sidebar />}
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
        onSettingsClick={toggleSettings}
      />

      <SearchPalette open={open} onClose={closePalette} />
    </>
  );
}

/** Public entry point Task 10's `App.tsx` renders once `useAuth()` reports an
 *  authenticated session. Owns `AppStateProvider` itself so everything under it
 *  (sidebar, editor, right panel, search palette) shares one `selection`
 *  without `App.tsx` needing to know that wiring exists. */
export function AppRoot() {
  return (
    <AppStateProvider>
      <AuthedApp />
    </AppStateProvider>
  );
}

/** App-wide coordination state shared by the shell and everything that plugs into
 *  it (unified sidebar, editor, search, backlinks, graph). Keeping this as context —
 *  rather than prop-drilling through `AppShell` — is the stable contract later tasks
 *  build on: any component under `<AppStateProvider>` can read/set the selected note
 *  without the shell needing to know about it.
 *
 *  The selection is a `NoteSelection` (source id + path), not a bare path: once more
 *  than one source can be registered (Plan 8), a path alone is ambiguous — the same
 *  relative path could exist in two different sources. */

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { NoteSelection } from "../sources/types";

export interface AppStateValue {
  /** The note currently open in the main/editor slot, or null when nothing is
   *  selected (main slot should show a placeholder). */
  selection: NoteSelection | null;
  setSelection: (selection: NoteSelection | null) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [selection, setSelection] = useState<NoteSelection | null>(null);
  const value = useMemo<AppStateValue>(() => ({ selection, setSelection }), [selection]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within an AppStateProvider");
  return ctx;
}

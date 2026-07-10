/** App-wide coordination state shared by the shell and everything that plugs into
 *  it (note tree, editor, search, backlinks, graph). Keeping this as context — rather
 *  than prop-drilling through `AppShell` — is the stable contract later tasks build on:
 *  any component under `<AppStateProvider>` can read/set the selected note without the
 *  shell needing to know about it. */

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export interface AppStateValue {
  /** Vault-relative path of the note currently open in the main/editor slot, or
   *  null when nothing is selected (main slot should show a placeholder). */
  selectedPath: string | null;
  setSelectedPath: (path: string | null) => void;
}

const AppStateContext = createContext<AppStateValue | null>(null);

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const value = useMemo<AppStateValue>(() => ({ selectedPath, setSelectedPath }), [selectedPath]);
  return <AppStateContext.Provider value={value}>{children}</AppStateContext.Provider>;
}

export function useAppState(): AppStateValue {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error("useAppState must be used within an AppStateProvider");
  return ctx;
}

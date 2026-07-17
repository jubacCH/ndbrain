import { useContext } from "react";
import { SourcesContext, type SourcesContextValue } from "./SourcesProvider";

/** Reads the current source runtimes and source-management actions from the
 *  nearest `<SourcesProvider>`. Throws if used outside of one, same
 *  convention as `useAuth`/`AuthProvider`. */
export function useSources(): SourcesContextValue {
  const ctx = useContext(SourcesContext);
  if (!ctx) throw new Error("useSources must be used within a SourcesProvider");
  return ctx;
}

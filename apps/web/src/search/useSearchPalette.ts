/** Wires the global Cmd/Ctrl-K shortcut to a controlled open/close boolean, so any
 *  consumer can do `const { open, closePalette } = useSearchPalette()` and pass
 *  those straight through to `<SearchPalette open={open} onClose={closePalette} />`.
 *  `openPalette` is exposed too, so the shell's search button can open the palette
 *  the same way the keyboard shortcut does. */

import { useCallback, useEffect, useState } from "react";

export interface UseSearchPaletteResult {
  open: boolean;
  openPalette: () => void;
  closePalette: () => void;
}

export function useSearchPalette(): UseSearchPaletteResult {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const openPalette = useCallback(() => setOpen(true), []);
  const closePalette = useCallback(() => setOpen(false), []);

  return { open, openPalette, closePalette };
}

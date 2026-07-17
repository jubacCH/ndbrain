/** Cmd/Ctrl-K search palette: a debounced hybrid-search overlay over
 *  `GET /api/v1/search`. Fully controlled via `open`/`onClose` so the shell's
 *  search button and `useSearchPalette`'s keyboard shortcut can both drive it —
 *  see `search/useSearchPalette.ts` for the self-contained Cmd-K wiring. */

import { useEffect, useRef, useState } from "react";
import { apiClient, type SearchHit } from "../api/client";
import { useAppState } from "../shell/AppState";
import { parseSnippet } from "./parseSnippet";
import styles from "./SearchPalette.module.css";

/** Structural subset of `ApiClient` this component needs — lets tests inject a
 *  fake without constructing a real client (same pattern as `AuthClient`). */
export interface SearchClient {
  search(q: string): Promise<SearchHit[]>;
}

export interface SearchPaletteProps {
  open: boolean;
  onClose: () => void;
  client?: SearchClient;
  /** Debounce delay before firing the search request. Defaults to 200ms;
   *  overridable so tests don't have to wait on the real-world value. */
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 200;

/** Fallback source id used when jumping to a search hit with no prior
 *  selection to inherit a source from — see `GraphView`'s identical constant
 *  for the full rationale (this component has the same not-yet-source-aware
 *  gap, since `/search` is still a single global endpoint). */
const FALLBACK_SOURCE_ID = "origin";

export function SearchPalette({ open, onClose, client = apiClient, debounceMs = DEFAULT_DEBOUNCE_MS }: SearchPaletteProps) {
  const { selection, setSelection } = useAppState();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);

  // Reset transient state every time the palette opens, and move focus to the input.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    setSearched(false);
    setActiveIndex(0);
    inputRef.current?.focus();
  }, [open]);

  // Debounced search — a monotonically increasing request id guards against a
  // stale response (from a superseded keystroke) overwriting fresher results.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setSearched(false);
      return;
    }

    const id = ++requestId.current;
    const timer = setTimeout(() => {
      client
        .search(trimmed)
        .then((result) => {
          if (requestId.current !== id) return;
          setHits(result);
          setSearched(true);
          setActiveIndex(0);
        })
        .catch(() => {
          if (requestId.current !== id) return;
          setHits([]);
          setSearched(true);
        });
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [query, open, client, debounceMs]);

  useEffect(() => {
    if (!open) return;

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((i) => Math.min(i + 1, hits.length - 1));
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (event.key === "Enter") {
        const hit = hits[activeIndex];
        if (hit) selectHit(hit);
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, hits, activeIndex, onClose]);

  if (!open) return null;

  function selectHit(hit: SearchHit) {
    setSelection({ sourceId: selection?.sourceId ?? FALLBACK_SOURCE_ID, path: hit.path });
    onClose();
  }

  const trimmedQuery = query.trim();

  return (
    <div className={styles.overlay} role="presentation" onClick={onClose}>
      <div
        className={styles.palette}
        role="dialog"
        aria-modal="true"
        aria-label="Search palette"
        onClick={(event) => event.stopPropagation()}
      >
        <div className={styles.queryRow}>
          <input
            ref={inputRef}
            className={styles.input}
            type="text"
            aria-label="Search notes"
            placeholder="Search notes…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <span className={styles.escHint} aria-hidden="true">
            esc
          </span>
        </div>

        <div className={styles.results}>
          {trimmedQuery === "" && <p className={styles.status}>Type to search your notes.</p>}
          {trimmedQuery !== "" && searched && hits.length === 0 && (
            <p className={styles.status}>No results found.</p>
          )}

          <ul className={styles.list}>
            {hits.map((hit, index) => (
              <li key={hit.path}>
                <button
                  type="button"
                  className={index === activeIndex ? `${styles.result} ${styles.active}` : styles.result}
                  onClick={() => selectHit(hit)}
                  onMouseEnter={() => setActiveIndex(index)}
                >
                  <span className={styles.resultRow}>
                    <span className={styles.resultTitle}>{hit.title ?? hit.path}</span>
                    {hit.title && <span className={styles.resultPath}>{hit.path}</span>}
                  </span>
                  <span className={styles.resultSnippet}>
                    {parseSnippet(hit.snippet).map((segment, i) =>
                      segment.bold ? <strong key={i}>{segment.text}</strong> : <span key={i}>{segment.text}</span>,
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

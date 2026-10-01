/**
 * The search view's query, its filters and its results.
 *
 * Second cut out of `Shell`, and a cleaner seam than the file browser: nothing
 * outside the search view reads any of this, and the one request it makes needs
 * nothing from the rest of the shell except somewhere to put an error and a way
 * to say "show the search view".
 *
 * The sequence guard is the reason this deserves its own file rather than a
 * tidier spot in `Shell`. This field does not debounce — every keystroke is a
 * request — so answers routinely arrive out of the order they were asked for. A
 * slow reply for "prox" landing after a fast one for "proxmox" leaves the wrong
 * results sitting under the right query, and nothing on screen says so. The
 * palette solves the same problem differently, by waiting for a pause, which is
 * why the two cannot share one mechanism.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { api, type SearchHit } from './api';
import { copy } from './copy';

/** What a search is narrowed by, beside the words. */
export interface Filters {
  tag?: string;
  dir?: string;
  days?: number;
  /** A frontmatter key, optionally pinned to one of its values. */
  prop?: string;
  propValue?: string;
}

export interface SearchDeps {
  /** Puts the search view on screen; running a search implies wanting to see it. */
  showSearchView: () => void;
  setError: (message: string | null) => void;
  /**
   * The notes, as the trigger for re-reading the vault's property keys.
   *
   * A key exists exactly as long as some note declares one, so the vocabulary is
   * re-read whenever the notes changed rather than cached for the session.
   */
  notes: unknown;
}

export interface Search {
  query: string;
  /**
   * Sets the words without searching for them.
   *
   * For the palette's "search for these words", which puts the view on screen
   * its own way — through `showView`, which prefetches — and then calls
   * `runSearch` itself. Going through `onQueryChange` there would search twice
   * and navigate differently.
   */
  setQuery: (value: string) => void;
  filters: Filters;
  hits: SearchHit[];
  props: Array<{ key: string; count: number }>;
  propValues: Array<{ value: string; count: number }>;
  /** Runs a search directly, for the palette's "search for these words". */
  runSearch: (value: string, active: Filters) => Promise<void>;
  onQueryChange: (value: string) => void;
  toggleFilter: (patch: Filters) => void;
  clearFilters: () => void;
}

export function useSearch(deps: SearchDeps): Search {
  const { showSearchView, setError, notes } = deps;

  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Filters>({});
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [props, setProps] = useState<Array<{ key: string; count: number }>>([]);
  const [propValues, setPropValues] = useState<Array<{ value: string; count: number }>>([]);

  /**
   * Which search is the current one.
   *
   * A ref, because a number closed over by `useCallback` would be the one from
   * the render that made the callback, and the comparison below has to see what
   * the newest call wrote.
   */
  const searchSeq = useRef(0);

  const runSearch = useCallback(
    async (value: string, active: Filters): Promise<void> => {
      // A query with only filters is legitimate — "everything tagged #homelab" —
      // so the search runs whenever either part is present.
      const hasFilter = active.tag !== undefined || active.dir !== undefined || active.days !== undefined;
      if (value.trim() === '' && !hasFilter) {
        searchSeq.current += 1; // an in-flight search must not refill the list
        setHits([]);
        return;
      }

      showSearchView();
      const seq = (searchSeq.current += 1);
      const { hits: found } = await api.search(value.trim(), active);
      // Answers do not arrive in the order they were asked for. Without this,
      // a slow response for "prox" lands after a fast one for "proxmox" and
      // leaves the wrong results sitting under the right query.
      if (seq !== searchSeq.current) return;
      setHits(found);
    },
    [showSearchView],
  );

  const onQueryChange = useCallback(
    (value: string): void => {
      setQuery(value);
      void runSearch(value, filters).catch(() => setError(copy.errors.searchFailed));
    },
    [runSearch, filters, setError],
  );

  const toggleFilter = useCallback(
    (patch: Filters): void => {
      const next: Filters = { ...filters };
      for (const [key, value] of Object.entries(patch) as Array<[keyof Filters, unknown]>) {
        if (next[key] === value) delete next[key];
        else Object.assign(next, { [key]: value });
      }
      // A value only means something under its key. Dropping the key has to drop
      // the value with it, or the next search filters on a pair that is no longer
      // on screen.
      if (next.prop === undefined) delete next.propValue;
      setFilters(next);
      void runSearch(query, next).catch(() => setError(copy.errors.searchFailed));

      if (next.prop !== undefined && next.prop !== filters.prop) {
        api
          .propValues(next.prop)
          .then(({ values }) => setPropValues(values))
          .catch(() => setPropValues([]));
      } else if (next.prop === undefined) {
        setPropValues([]);
      }
    },
    [filters, query, runSearch, setError],
  );

  const clearFilters = useCallback((): void => {
    setFilters({});
    setPropValues([]);
    void runSearch(query, {}).catch(() => undefined);
  }, [query, runSearch]);

  useEffect(() => {
    // The vault's own vocabulary, re-read whenever its notes changed: a key
    // exists exactly as long as some note declares it.
    api
      .propKeys()
      .then(({ props: list }) => setProps(list))
      .catch(() => undefined);
  }, [notes]);

  return { query, setQuery, filters, hits, props, propValues, runSearch, onQueryChange, toggleFilter, clearFilters };
}

/**
 * Server state, in one place.
 *
 * Before this, the shell held every server answer in `useState` and re-fetched
 * by hand. Three problems came out of that, and all three are structural rather
 * than sloppiness:
 *
 *  - **Every save re-read the world.** A write called `refreshTree()` — which is
 *    the whole note list *and* the whole tidy scan — plus the entire graph. At
 *    sixty notes that is 21ms and invisible. At ten thousand it is megabytes and
 *    four full table scans on every pause in typing.
 *  - **Nothing guarded against a stale answer.** There was no `AbortController`
 *    and no sequence number anywhere: click note A then note B quickly, and
 *    whichever response arrived last won. Over a slow connection you would land
 *    in B and be reading A.
 *  - **The shell owned 29 pieces of state**, most of them server answers, and
 *    every new view made it longer.
 *
 * The fix is not "a library". It is the distinction the old code could not make:
 * *server state is a cache of something owned elsewhere*, and cached data has
 * questions of its own — is it stale, is a fetch in flight, did a newer request
 * supersede this one. Local UI state (which view is open, what is typed in the
 * filter) is genuinely owned here and stays in `useState`.
 *
 * The invalidation rule that matters: a query is only re-fetched if something is
 * currently rendering it. Marking the graph stale after a save costs nothing
 * while nobody is looking at the graph — which is what makes "invalidate
 * generously" safe, where "re-fetch generously" was not.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import { api, type FileRow, type GraphData, type NoteRow, type OpenNote } from './api';

/**
 * Query keys, built in one place.
 *
 * Hand-written key arrays scattered through components are how invalidation
 * quietly stops matching: one call site writes `['note', owner, path]` and
 * another `['notes', owner, path]`, and the second never refreshes again.
 */
export const keys = {
  tree: ['tree'] as const,
  tidy: ['tidy'] as const,
  overview: ['overview'] as const,
  shares: ['shares'] as const,
  graph: ['graph'] as const,
  tags: ['tags'] as const,
  files: ['files'] as const,
  settings: ['settings'] as const,
  note: (owner: string, path: string) => ['note', owner, path] as const,
  links: (owner: string, path: string) => ['links', owner, path] as const,
  search: (q: string, filters: unknown) => ['search', q, filters] as const,
};

/**
 * How long an answer counts as fresh.
 *
 * Not zero. With `staleTime: 0` every remount re-fetches, so switching views
 * back and forth would hammer the server for data that cannot have changed in
 * the two seconds since. Writes invalidate explicitly, which is a far more
 * accurate signal than a timer.
 */
const FRESH_MS = 30_000;

export function useTree(): UseQueryResult<{ notes: NoteRow[] }> {
  return useQuery({ queryKey: keys.tree, queryFn: () => api.tree(), staleTime: FRESH_MS });
}

export function useTidy(): UseQueryResult<Awaited<ReturnType<typeof api.tidy>>> {
  return useQuery({ queryKey: keys.tidy, queryFn: () => api.tidy(), staleTime: FRESH_MS });
}

export function useOverview(enabled: boolean): UseQueryResult<Awaited<ReturnType<typeof api.overview>>> {
  return useQuery({
    queryKey: keys.overview,
    queryFn: () => api.overview(),
    staleTime: FRESH_MS,
    enabled,
  });
}

export function useShares(): UseQueryResult<Awaited<ReturnType<typeof api.shares>>> {
  return useQuery({ queryKey: keys.shares, queryFn: () => api.shares(), staleTime: FRESH_MS });
}

export function useTags(): UseQueryResult<Awaited<ReturnType<typeof api.tags>>> {
  return useQuery({ queryKey: keys.tags, queryFn: () => api.tags(), staleTime: FRESH_MS });
}

/**
 * The whole network.
 *
 * `enabled` is the whole point: the graph is only fetched while a view that
 * draws it is on screen. It used to be re-read after every single save whether
 * or not anything was showing it.
 */
export function useGraph(enabled: boolean): UseQueryResult<GraphData> {
  return useQuery({
    queryKey: keys.graph,
    queryFn: () => api.graph(),
    staleTime: FRESH_MS,
    enabled,
  });
}

export function useFiles(enabled: boolean): UseQueryResult<{
  files: FileRow[];
  dirs: string[];
  truncated: boolean;
}> {
  return useQuery({
    queryKey: keys.files,
    queryFn: () => api.files(),
    // The disk is the truth here and it can change under us — an agent writing,
    // a file dropped in over the share. Short, but not zero.
    staleTime: 5_000,
    enabled,
  });
}

/**
 * One open note.
 *
 * This is where the race lived. Two quick clicks used to be two `setOpen` calls
 * resolving in arrival order; now each note is its own cache entry under its own
 * key, and only the one currently asked for is rendered. A late answer for the
 * note you have already left updates that note's cache entry and changes nothing
 * on screen.
 */
export function useNote(ref: { owner: string; path: string } | null): UseQueryResult<OpenNote> {
  return useQuery({
    queryKey: ref === null ? ['note', 'none'] : keys.note(ref.owner, ref.path),
    queryFn: () => api.getNote(ref!.owner, ref!.path),
    enabled: ref !== null,
    // Never silently re-fetched underneath an editor: a refetch while somebody is
    // typing would swap the text out from under them.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

export function useLinks(
  ref: { owner: string; path: string } | null,
): UseQueryResult<Awaited<ReturnType<typeof api.links>>> {
  return useQuery({
    queryKey: ref === null ? ['links', 'none'] : keys.links(ref.owner, ref.path),
    queryFn: () => api.links(ref!.owner, ref!.path),
    enabled: ref !== null,
    staleTime: FRESH_MS,
  });
}

export function useSearch(
  q: string,
  filters: Record<string, unknown>,
  enabled: boolean,
): UseQueryResult<Awaited<ReturnType<typeof api.search>>> {
  return useQuery({
    queryKey: keys.search(q, filters),
    queryFn: () => api.search(q, filters),
    enabled: enabled && (q !== '' || Object.keys(filters).length > 0),
    // Keeps the previous hits on screen while the next query runs, so the list
    // does not blink empty on every keystroke.
    placeholderData: (previous) => previous,
    staleTime: 10_000,
  });
}

/**
 * The one preference the server owns.
 *
 * Fetched only on the settings page: nothing else on screen depends on it, and
 * the server already applies it when answering the queries that do.
 */
export function useSettings(enabled: boolean): UseQueryResult<Awaited<ReturnType<typeof api.settings>>> {
  return useQuery({
    queryKey: keys.settings,
    queryFn: () => api.settings(),
    staleTime: FRESH_MS,
    enabled,
  });
}

/**
 * What a write invalidates.
 *
 * Named rather than spelled out at each call site, because the interesting part
 * is what is *absent*. A content edit does not touch the tree: the note list
 * changes when notes are created, deleted or renamed, not when their text
 * changes. The old code re-read the entire tree and the entire tidy scan on
 * every autosave for no reason at all.
 */
export const invalidate = {
  /** Text changed. Links may have moved, so findings and the graph may differ. */
  afterEdit: (client: QueryClient, owner: string, path: string): void => {
    void client.invalidateQueries({ queryKey: keys.links(owner, path) });
    void client.invalidateQueries({ queryKey: keys.tidy });
    void client.invalidateQueries({ queryKey: keys.graph });
    void client.invalidateQueries({ queryKey: keys.overview });
  },

  /** A note appeared, moved or went away: everything that lists notes is stale. */
  afterStructure: (client: QueryClient): void => {
    void client.invalidateQueries({ queryKey: keys.tree });
    void client.invalidateQueries({ queryKey: keys.tidy });
    void client.invalidateQueries({ queryKey: keys.graph });
    void client.invalidateQueries({ queryKey: keys.overview });
    void client.invalidateQueries({ queryKey: keys.files });
    void client.invalidateQueries({ queryKey: keys.tags });
  },
};

/** Saves a note, then marks exactly what that could have changed. */
export function useSaveNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { owner: string; path: string; content: string; baseMtimeMs?: number }) =>
      api.putNote(vars.owner, vars.path, vars.content, vars.baseMtimeMs),
    onSuccess: (result, vars) => {
      // The cache entry for this note is updated in place rather than re-fetched:
      // we already know what was written, and re-reading it would race the next
      // keystroke.
      client.setQueryData(keys.note(vars.owner, vars.path), (previous: OpenNote | undefined) =>
        previous === undefined ? previous : { ...previous, note: result.note },
      );
      invalidate.afterEdit(client, vars.owner, vars.path);
      if (result.created || result.conflictCopy !== undefined) invalidate.afterStructure(client);
    },
  });
}

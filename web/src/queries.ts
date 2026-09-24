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

import { useSyncExternalStore } from 'react';
import {
  QueryClient,
  onlineManager,
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';

import {
  ApiError,
  ContractError,
  api,
  type FileRow,
  type GraphData,
  type OpenNote,
  type TreeData,
} from './api';
import { parseTagRegistry, REGISTRY_PATH } from './editor/tagRegistry';

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
  deleted: ['deleted'] as const,
  tasks: (filters: { dir?: string; includeDone?: boolean }) => ['tasks', filters] as const,
  overview: ['overview'] as const,
  shares: ['shares'] as const,
  graph: ['graph'] as const,
  tags: ['tags'] as const,
  files: ['files'] as const,
  settings: ['settings'] as const,
  topics: ['topics'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminKeys: (owner: string) => ['admin', 'keys', owner] as const,
  adminSpaces: ['admin', 'spaces'] as const,
  spaceMembers: (space: string) => ['admin', 'spaces', space, 'members'] as const,
  spaceTree: (space: string) => ['admin', 'spaces', space, 'tree'] as const,
  note: (owner: string, path: string) => ['note', owner, path] as const,
  tagRegistry: (owner: string) => ['tag-registry', owner] as const,
  links: (owner: string, path: string) => ['links', owner, path] as const,
  history: (owner: string, path: string) => ['history', owner, path] as const,
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

/**
 * How many times a request that could still succeed is sent again.
 *
 * Two, not three, and never for an answer the server meant. The cost of a retry
 * is somebody waiting longer for the same truth, so it is only worth paying
 * where the truth might genuinely be different next time.
 */
export const RETRY_LIMIT = 2;

/**
 * Whether a failed request is worth sending again.
 *
 * The old blanket `retry: false` was right about one thing and wrong about
 * another. Right: this server is one hop away, and most failures here are the
 * server saying no for a reason that will not change — retrying a 404 three
 * times delays telling somebody by a second and a half and changes nothing.
 * Wrong: a request that never arrived is not an answer at all, and the LAN it
 * is one hop across is exactly where a Wi-Fi handover drops a single request.
 *
 * So the decision is per error class, not per application:
 *
 *  - **`ApiError` under 500** — the server understood the question and refused
 *    it. A 404 is the truth about a note, a 403 about a right, a 409 about a
 *    conflict that an identical second request cannot resolve. A **401** is the
 *    worst one to retry: the session is over, `request` has already told the
 *    shell so, and asking again only delays the sign-in screen. A 429 is the
 *    server asking for *less* traffic, and answering that with more is rude.
 *  - **408 apart** — a timeout is the server saying the request did not finish,
 *    not that the answer is no.
 *  - **`ApiError` 500 and up** — the server fell over, or a reverse proxy
 *    answered for it. Those are the failures that are genuinely different a
 *    moment later.
 *  - **`ContractError`** — this build cannot read what the server sends. The
 *    next answer will have the same shape; only a reload fixes it.
 *  - **anything else** — what `fetch` throws when nothing came back: no
 *    network, DNS, a connection reset. The case retrying was invented for.
 *
 * Exported so the policy can be read as a table in a test rather than inferred
 * from how long a suite takes.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= RETRY_LIMIT) return false;
  if (error instanceof ContractError) return false;
  if (error instanceof ApiError) return error.status >= 500 || error.status === 408;
  return true;
}

/**
 * How long the retry waits, doubling each time.
 *
 * Short enough that two of them are still faster than noticing and pressing
 * "Try again", long enough that a server coming back up is not met with three
 * requests in the same tick.
 */
export function retryDelayMs(failureCount: number): number {
  return 400 * 2 ** failureCount;
}

/**
 * The cache the whole application reads the server through.
 *
 * A function rather than a constant so that `main.tsx` and the tests that
 * exercise the retry policy get the same client, rather than a test asserting
 * against a policy nothing in the app uses.
 *
 * `refetchOnWindowFocus` stays off, and for the reason it was turned off:
 * coming back to a tab must not pull the text out from under a half-written
 * note. `refetchOnReconnect` is the opposite case and is named here explicitly
 * — it is on by default, and leaving it implicit made it look like the same
 * decision as the two beside it. A reconnect is the one moment where everything
 * on screen is known to be as old as the outage, and the note query is exempt
 * anyway: `staleTime: Infinity` means nothing re-reads an open editor.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetry,
        retryDelay: retryDelayMs,
        refetchOnWindowFocus: false,
        refetchOnReconnect: true,
      },
    },
  });
}

/**
 * Whether the browser believes it can reach anything at all.
 *
 * Read from React Query's own online manager rather than from `navigator`
 * directly, because that manager is what decides whether a query runs or is
 * *paused* — and a paused query is precisely the state that used to render as
 * "Loading…" for as long as the outage lasted. One source for both halves means
 * the screen cannot say "loading" while the cache says "not even asking".
 */
export function useOnline(): boolean {
  return useSyncExternalStore(
    (listener) => onlineManager.subscribe(() => listener()),
    () => onlineManager.isOnline(),
    () => true,
  );
}

/** Why a view has nothing to show, when the reason is not "there is nothing". */
export type Trouble = 'offline' | 'failed';

/**
 * The distinction every view here was missing.
 *
 * `query.data ?? []` collapses three different situations into an empty list:
 * the answer said nothing, the answer has not come, and the answer never will.
 * This tells the last two apart from the first, so a view can draw its empty
 * state only when the emptiness is real.
 *
 * A query that already holds data is never in trouble, even offline — what is
 * on screen came from the server and is as true as it was a minute ago. Only a
 * view with nothing to draw has to explain itself.
 *
 * `online` is passed in rather than read from the manager here, so that the
 * answer is a function of what the caller rendered with. A component that shows
 * trouble has to be subscribed to the connection anyway (`useOnline`), and
 * taking it as an argument is what makes that a compile-time obligation rather
 * than a convention.
 */
export function troubleOf(
  query: Pick<UseQueryResult, 'isError' | 'isPending' | 'isPaused'>,
  online: boolean,
): Trouble | null {
  // Paused first, and only while nothing has ever arrived. A request that was
  // never sent is not the server's fault, and "the server is not answering"
  // would be a false accusation. A *refetch* that is paused over data already
  // on screen is not trouble at all — that data is still the server's answer.
  if (query.isPending && query.isPaused) return 'offline';
  if (query.isError) return online ? 'failed' : 'offline';
  return null;
}

export function useTree(): UseQueryResult<TreeData> {
  return useQuery({ queryKey: keys.tree, queryFn: () => api.tree(), staleTime: FRESH_MS });
}

export function useTidy(): UseQueryResult<Awaited<ReturnType<typeof api.tidy>>> {
  return useQuery({ queryKey: keys.tidy, queryFn: () => api.tidy(), staleTime: FRESH_MS });
}

/**
 * Recently deleted notes. Only while the tidy view is open: every row asks the
 * host's history whether it can be brought back, which is a look, not a poll.
 */
export function useDeleted(enabled: boolean): UseQueryResult<Awaited<ReturnType<typeof api.deleted>>> {
  return useQuery({ queryKey: keys.deleted, queryFn: () => api.deleted(), staleTime: FRESH_MS, enabled });
}

export function useTasks(
  filters: { dir?: string; includeDone?: boolean },
  enabled: boolean,
): UseQueryResult<Awaited<ReturnType<typeof api.tasks>>> {
  return useQuery({
    queryKey: keys.tasks(filters),
    queryFn: () => api.tasks(filters),
    staleTime: FRESH_MS,
    enabled,
  });
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
 * The tags the vault *allows*, which is not the same list as `useTags`.
 *
 * That one reports what is in use, read out of the index — including every typo
 * ever committed. This one is a note a person maintains, and it is the only
 * thing `/tag` is allowed to offer, because a menu built from what is in use
 * would help a typo spread.
 *
 * A vault without the note simply has no registry; that is not an error, so the
 * answer is `null` and the menu says it has nothing to offer.
 */
export function useTagRegistry(owner: string | null): UseQueryResult<string[] | null> {
  return useQuery({
    queryKey: keys.tagRegistry(owner ?? ''),
    queryFn: async () => {
      try {
        const note = await api.getNote(owner!, REGISTRY_PATH);
        return parseTagRegistry(note.note.content);
      } catch {
        return null;
      }
    },
    enabled: owner !== null,
    // A vocabulary changes a few times a year, and the cost of a stale one is
    // an option missing for a minute.
    staleTime: 5 * 60_000,
    retry: false,
  });
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

/**
 * The files of one vault: the caller's own when `owner` is omitted, otherwise
 * the part of somebody else's (a space) the caller's shares reach.
 */
export function useFiles(enabled: boolean, owner?: string): UseQueryResult<{
  files: FileRow[];
  dirs: string[];
  truncated: boolean;
}> {
  return useQuery({
    // Under the one `files` prefix, so every invalidation of files reaches all vaults.
    queryKey: [...keys.files, owner ?? ''],
    queryFn: () => api.files(owner),
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
 * One note's recorded versions.
 *
 * Keyed per note like the note itself, so switching between two notes cannot
 * leave one's history showing under the other's name.
 */
export function useHistory(
  ref: { owner: string; path: string } | null,
): UseQueryResult<Awaited<ReturnType<typeof api.history>>> {
  return useQuery({
    queryKey: ref === null ? ['history', 'none'] : keys.history(ref.owner, ref.path),
    queryFn: () => api.history(ref!.owner, ref!.path),
    enabled: ref !== null,
    staleTime: FRESH_MS,
  });
}

/**
 * Notes whose metadata is prose rather than tags.
 *
 * Only while the tidy view is open. It reads every note in the vault to answer,
 * which is fine as a deliberate look and wasteful as a background poll.
 */
export function useTopics(enabled: boolean): UseQueryResult<Awaited<ReturnType<typeof api.topics>>> {
  return useQuery({
    queryKey: keys.topics,
    queryFn: () => api.topics(),
    staleTime: FRESH_MS,
    enabled,
  });
}

export function useAdminUsers(enabled: boolean): UseQueryResult<Awaited<ReturnType<typeof api.adminUsers>>> {
  return useQuery({ queryKey: keys.adminUsers, queryFn: () => api.adminUsers(), enabled, staleTime: 5_000 });
}

export function useAdminSpaces(enabled: boolean): UseQueryResult<Awaited<ReturnType<typeof api.adminSpaces>>> {
  return useQuery({ queryKey: keys.adminSpaces, queryFn: () => api.adminSpaces(), enabled, staleTime: 5_000 });
}

export function useSpaceMembers(
  space: string | null,
): UseQueryResult<Awaited<ReturnType<typeof api.spaceMembers>>> {
  return useQuery({
    queryKey: keys.spaceMembers(space ?? ''),
    queryFn: () => api.spaceMembers(space!),
    enabled: space !== null,
    staleTime: 5_000,
  });
}

export function useSpaceTree(
  space: string | null,
): UseQueryResult<Awaited<ReturnType<typeof api.spaceTree>>> {
  return useQuery({
    queryKey: keys.spaceTree(space ?? ''),
    queryFn: () => api.spaceTree(space!),
    enabled: space !== null,
    staleTime: 5_000,
  });
}

export function useAdminKeys(owner: string, enabled: boolean): UseQueryResult<Awaited<ReturnType<typeof api.adminKeys>>> {
  return useQuery({
    queryKey: keys.adminKeys(owner),
    queryFn: () => api.adminKeys(owner),
    enabled: enabled && owner !== '',
    staleTime: 5_000,
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
    void client.invalidateQueries({ queryKey: keys.history(owner, path) });
    void client.invalidateQueries({ queryKey: keys.tidy });
    void client.invalidateQueries({ queryKey: keys.graph });
    void client.invalidateQueries({ queryKey: keys.overview });
    // Every `keys.tasks(filters)` entry, whatever filters it was fetched with —
    // a checkbox anywhere in the text can appear, move or disappear.
    void client.invalidateQueries({ queryKey: ['tasks'] });
  },

  /** A note appeared, moved or went away: everything that lists notes is stale. */
  afterStructure: (client: QueryClient): void => {
    void client.invalidateQueries({ queryKey: keys.tree });
    void client.invalidateQueries({ queryKey: keys.tidy });
    // Recently deleted is a list of notes like any other: a delete adds to it,
    // a restore or a new note under the same name takes a row out of it.
    void client.invalidateQueries({ queryKey: keys.deleted });
    void client.invalidateQueries({ queryKey: keys.graph });
    void client.invalidateQueries({ queryKey: keys.overview });
    void client.invalidateQueries({ queryKey: keys.files });
    void client.invalidateQueries({ queryKey: keys.tags });
    void client.invalidateQueries({ queryKey: keys.topics });
  },

  /**
   * A note went away. Everything that lists notes, as for any structural
   * change, and more besides: its open tasks leave the task list, every link
   * that pointed at it is now dead (the neighbours' link lists say so), and
   * what was cached about the note itself is dropped rather than marked stale —
   * nothing should render it again, and a stale entry is exactly what would.
   */
  afterDelete: (client: QueryClient, owner: string, path: string): void => {
    invalidate.afterStructure(client);
    void client.invalidateQueries({ queryKey: ['tasks'] });
    void client.invalidateQueries({ queryKey: ['links'] });
    client.removeQueries({ queryKey: keys.note(owner, path), exact: true });
    client.removeQueries({ queryKey: keys.history(owner, path), exact: true });
    client.removeQueries({ queryKey: ['inspector-note', owner, path], exact: true });
  },
};

/** Saves a note, then marks exactly what that could have changed. */
export function useSaveNote() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: { owner: string; path: string; content: string; baseHash?: string }) =>
      api.putNote(vars.owner, vars.path, vars.content, vars.baseHash),
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

/**
 * Flips one task's checkbox from the task list.
 *
 * The note's own cache entry is invalidated too, not just refreshed lists: if
 * the same note happens to be open in the editor, its stale in-memory text
 * would otherwise overwrite this toggle the next time that tab autosaves.
 */
export function useToggleTask() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      owner: string;
      task: { path: string; line: number; text: string; done: boolean };
      done: boolean;
    }) => api.toggleTask(vars.owner, vars.task, vars.done),
    onSuccess: (_result, vars) => {
      invalidate.afterEdit(client, vars.owner, vars.task.path);
      void client.invalidateQueries({ queryKey: keys.note(vars.owner, vars.task.path) });
    },
  });
}

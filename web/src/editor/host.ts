/**
 * The editor's embeds and previews, answered from the API.
 *
 * Resolution follows the index rather than guessing: the open note's outgoing
 * links already say which note each `[[target]]` points at, by the same rules
 * the backlinks and the tidy view use. A link typed a second ago is not in the
 * index yet, and only for that one does this fall back to the quick finder —
 * with the index's preference order (path before title, shortest path first),
 * and within this vault only, because links end at the vault's boundary.
 *
 * Answers are kept for half a minute. Hovering the same link twice, or a note
 * that embeds one note four times, should not be five requests.
 */

import { api } from '../api';
import type { EmbedHost, LinkedNote, LinkPreview } from './embeds';

const TTL_MS = 30_000;

export function createEmbedHost(
  owner: string,
  notePath: string,
  open: (owner: string, path: string) => void,
): EmbedHost {
  const notes = new Map<string, { at: number; value: Promise<LinkedNote | null> }>();
  const previews = new Map<string, Promise<LinkPreview | null>>();
  let outgoing: { at: number; value: Promise<Map<string, string>> } | null = null;

  const links = (): Promise<Map<string, string>> => {
    if (outgoing !== null && Date.now() - outgoing.at < TTL_MS) return outgoing.value;
    const value = api
      .links(owner, notePath)
      .then(({ outgoing: rows }) => {
        const map = new Map<string, string>();
        for (const row of rows) {
          if (row.targetPath !== null && row.owner === owner) {
            map.set(row.targetRaw.trim().toLowerCase(), row.targetPath);
          }
        }
        return map;
      })
      .catch(() => new Map<string, string>());
    outgoing = { at: Date.now(), value };
    return value;
  };

  const find = async (target: string): Promise<string | null> => {
    const key = target.toLowerCase();
    const indexed = (await links()).get(key);
    if (indexed !== undefined) return indexed;

    const { notes: found } = await api.quickFind(target);
    const mine = found.filter((note) => note.owner === owner);
    const byPath = mine.find(
      (note) => note.path.toLowerCase() === `${key}.md` || note.path.toLowerCase() === key,
    );
    if (byPath !== undefined) return byPath.path;
    const byTitle = mine
      .filter((note) => note.title.toLowerCase() === key)
      .sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
    return byTitle[0]?.path ?? null;
  };

  return {
    resolve(target) {
      const key = target.trim().toLowerCase();
      const hit = notes.get(key);
      if (hit !== undefined && Date.now() - hit.at < TTL_MS) return hit.value;

      const value = find(target.trim())
        .then(async (path) => {
          if (path === null) return null;
          const opened = await api.getNote(owner, path);
          return { owner, path, title: opened.note.title, content: opened.note.content };
        })
        .catch(() => null);
      notes.set(key, { at: Date.now(), value });
      return value;
    },

    open,

    unfurl(url) {
      let value = previews.get(url);
      if (value === undefined) {
        // The server keeps its own longer cache; this one only stops a note
        // from asking twice while it is open.
        value = api
          .unfurl(url)
          .then(({ preview }) => preview)
          .catch(() => null);
        previews.set(url, value);
      }
      return value;
    },
  };
}

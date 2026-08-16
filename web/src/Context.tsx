/**
 * The context panel beside the open note.
 *
 * Answers the question the tree cannot: what is this note connected to. Links
 * that point nowhere are shown here rather than hidden — a broken link is a
 * finding to act on, and the panel offers to create the missing note, which is
 * the only sensible thing to do about it.
 *
 * Collapsible, because the writing surface should be able to have the screen.
 */


import type { Ref } from './api';
import { copy } from './copy';
import { useHistory, useLinks } from './queries';
import { HistoryPanel } from './History';

export function ContextPanel({
  note,
  self,
  canCreate,
  onRestored,
  onOpen,
  onCreate,
}: {
  note: Ref | null;
  /** The signed-in account, so a foreign note can say whose it is. */
  self: string;
  /** False on a note shared read-only: filling a gap would be refused anyway. */
  canCreate: boolean;
  /** Called after a restore, so the editor reloads the text it now shows. */
  onRestored: () => void;
  onOpen: (owner: string, path: string) => void;
  onCreate: (title: string) => void;
  /** Changes whenever the note was saved, so the panel refreshes with it. */
}): React.JSX.Element {

  const owner = note?.owner ?? null;
  const notePath = note?.path ?? null;

  /**
   * Read through the cache, keyed by the note it belongs to.
   *
   * The hand-rolled version had a `current` flag to ignore a late answer, which
   * is the same guard written once per component and forgotten in the next one.
   * Keyed caching does it structurally: an answer for a note nobody is looking at
   * updates that note's entry and never reaches this render.
   */
  const ref = owner === null || notePath === null ? null : { owner, path: notePath };
  const linksQuery = useLinks(ref);
  const historyQuery = useHistory(ref);
  const backlinks = linksQuery.data?.backlinks ?? [];
  const outgoing = linksQuery.data?.outgoing ?? [];

  const dead = outgoing.filter((link) => link.targetPath === null);
  const live = outgoing.filter((link) => link.targetPath !== null);

  if (notePath === null) return <></>;

  return (
    <section className="ctx" aria-label="Kontext">
      <>
            <section>
              <h4>{copy.context.linksHere} · {backlinks.length}</h4>
              {backlinks.length === 0 && (
                <p className="empty" style={{ padding: '.2rem 0' }}>
                  {copy.context.orphanedNote}
                </p>
              )}
              {backlinks.map((link) => (
                <button
                  type="button"
                  className="ref"
                  key={`${link.owner}:${link.source}:${link.offset}`}
                  onClick={() => onOpen(link.owner, link.source)}
                >
                  {titleOf(link.source)}
                  <small>{link.source}</small>
                </button>
              ))}
            </section>

            <section>
              <h4>{copy.context.linksOut} · {live.length}</h4>
              {live.length === 0 && (
                <p className="empty" style={{ padding: '.2rem 0' }}>
                  No links yet. Type <code>[[</code> in the editor.
                </p>
              )}
              {live.map((link) => (
                <button
                  type="button"
                  className="ref"
                  key={`${link.owner}:${link.targetPath}:${link.offset}`}
                  onClick={() => link.targetPath !== null && onOpen(link.owner, link.targetPath)}
                >
                  {titleOf(link.targetPath ?? '')}
                  {link.heading !== null && <small>↳ {link.heading}</small>}
                </button>
              ))}
            </section>

            {dead.length > 0 && (
              <section>
                <h4>{copy.context.pointsNowhere} · {dead.length}</h4>
                {dead.map((link) => (
                  <div className="dead-link" key={`${link.targetRaw}:${link.offset}`}>
                    <span className="pill p-crit">{link.targetRaw}</span>
                    {canCreate && (
                      <button type="button" className="btn" onClick={() => onCreate(link.targetRaw)}>
                        anlegen
                      </button>
                    )}
                  </div>
                ))}
              </section>
            )}

            <section>
              <h4>{copy.context.file}</h4>
              <span className="ref mono" style={{ fontSize: '.74rem', display: 'block' }}>
                {notePath}
              </span>
              {/* Named only when it is somebody else's — see the tree for why
                  your own vault is never labelled. */}
              {owner !== null && owner !== self && (
                <span className="ref mono" style={{ fontSize: '.74rem', display: 'block' }}>
                  {copy.context.vaultOf(owner)}
                </span>
              )}
            </section>

            {/* Last, and only for a note that has one. Everything above is about
                what this note *is*; the history is about what it was. */}
            {ref !== null && (
              <HistoryPanel
                owner={ref.owner}
                path={ref.path}
                available={historyQuery.data?.available ?? false}
                versions={historyQuery.data?.versions ?? []}
                canWrite={canCreate}
                onRestored={onRestored}
              />
            )}
      </>
    </section>
  );
}

function titleOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

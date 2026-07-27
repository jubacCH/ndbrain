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

import { useEffect, useState } from 'react';

import { api, type LinkRow } from './api';

export function ContextPanel({
  notePath,
  open,
  onToggle,
  onOpen,
  onCreate,
  reloadKey,
}: {
  notePath: string | null;
  open: boolean;
  onToggle: () => void;
  onOpen: (path: string) => void;
  onCreate: (title: string) => void;
  /** Changes whenever the note was saved, so the panel refreshes with it. */
  reloadKey: number;
}): React.JSX.Element {
  const [backlinks, setBacklinks] = useState<LinkRow[]>([]);
  const [outgoing, setOutgoing] = useState<LinkRow[]>([]);

  useEffect(() => {
    if (notePath === null) {
      setBacklinks([]);
      setOutgoing([]);
      return;
    }

    let current = true;
    api
      .links(notePath)
      .then((data) => {
        if (!current) return;
        setBacklinks(data.backlinks);
        setOutgoing(data.outgoing);
      })
      .catch(() => undefined);

    return () => {
      current = false;
    };
  }, [notePath, reloadKey]);

  if (!open) {
    return (
      <aside className="ctx collapsed">
        <button type="button" className="ctx-toggle" onClick={onToggle} aria-expanded={false} title="Kontext einblenden">
          ◀
        </button>
      </aside>
    );
  }

  const dead = outgoing.filter((link) => link.targetPath === null);
  const live = outgoing.filter((link) => link.targetPath !== null);

  return (
    <aside className="ctx" aria-label="Kontext">
      <button type="button" className="ctx-toggle" onClick={onToggle} aria-expanded title="Kontext ausblenden">
        ▶
      </button>

      <div className="ctx-inner">
        {notePath === null && <p className="empty">Keine Notiz geöffnet.</p>}

        {notePath !== null && (
          <>
            <section>
              <h4>Verweist hierher · {backlinks.length}</h4>
              {backlinks.length === 0 && (
                <p className="empty" style={{ padding: '.2rem 0' }}>
                  Niemand — diese Notiz ist verwaist.
                </p>
              )}
              {backlinks.map((link) => (
                <button
                  type="button"
                  className="ref"
                  key={`${link.source}:${link.offset}`}
                  onClick={() => onOpen(link.source)}
                >
                  {titleOf(link.source)}
                  <small>{link.source}</small>
                </button>
              ))}
            </section>

            <section>
              <h4>Verweist auf · {live.length}</h4>
              {live.length === 0 && (
                <p className="empty" style={{ padding: '.2rem 0' }}>
                  Noch keine Links. Tippe <code>[[</code> im Editor.
                </p>
              )}
              {live.map((link) => (
                <button
                  type="button"
                  className="ref"
                  key={`${link.targetPath}:${link.offset}`}
                  onClick={() => link.targetPath !== null && onOpen(link.targetPath)}
                >
                  {titleOf(link.targetPath ?? '')}
                  {link.heading !== null && <small>↳ {link.heading}</small>}
                </button>
              ))}
            </section>

            {dead.length > 0 && (
              <section>
                <h4>Zeigt ins Leere · {dead.length}</h4>
                {dead.map((link) => (
                  <div className="dead-link" key={`${link.targetRaw}:${link.offset}`}>
                    <span className="pill p-crit">{link.targetRaw}</span>
                    <button type="button" className="btn" onClick={() => onCreate(link.targetRaw)}>
                      anlegen
                    </button>
                  </div>
                ))}
              </section>
            )}

            <section>
              <h4>Datei</h4>
              <span className="ref mono" style={{ fontSize: '.74rem', display: 'block' }}>
                {notePath}
              </span>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}

function titleOf(path: string): string {
  return (path.split('/').pop() ?? path).replace(/\.md$/i, '');
}

/**
 * A look at the note behind a `[[wikilink]]` without leaving this one.
 *
 * Hovering a link shows the opening of the note it points to; Ctrl- or
 * Cmd-click opens it. A plain click still puts the cursor in the link, because
 * a link is also text somebody edits — a wiki where every click navigates is a
 * wiki where fixing a typo in a link takes three tries.
 */

import type { Extension } from '@codemirror/state';
import { EditorView, hoverTooltip } from '@codemirror/view';

import { copy } from '../copy';
import { embedHost, excerpt, linkTarget } from './embeds';

const WIKILINK = /(!?)\[\[([^\]\n]+)]]/g;

/** The wikilink under a position, if any — embeds included. */
export function wikilinkAt(
  view: EditorView,
  pos: number,
): { from: number; to: number; inner: string } | null {
  const line = view.state.doc.lineAt(pos);
  WIKILINK.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKILINK.exec(line.text)) !== null) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (pos >= from && pos <= to) return { from, to, inner: match[2] ?? '' };
  }
  return null;
}

const preview = hoverTooltip(
  (view, pos) => {
    const link = wikilinkAt(view, pos);
    const host = view.state.facet(embedHost)();
    if (link === null || host === null) return null;
    const { note, heading } = linkTarget(link.inner);
    if (note === '') return null;

    return {
      pos: link.from,
      end: link.to,
      above: true,
      create: () => {
        const card = document.createElement('div');
        card.className = 'cm-link-preview';

        const head = document.createElement('div');
        head.className = 'cm-card-head';
        const title = document.createElement('span');
        title.className = 'cm-card-title';
        title.textContent = note;
        head.append(title);

        const body = document.createElement('div');
        body.className = 'cm-card-body';
        body.textContent = copy.editor.embed.loading;
        card.append(head, body);

        void host
          .resolve(note)
          .then((found) => {
            body.replaceChildren();
            if (found === null) {
              card.classList.add('cm-card-missing');
              body.textContent = copy.editor.embed.noteMissing;
              return;
            }
            title.textContent = found.title;
            const open = document.createElement('button');
            open.type = 'button';
            open.className = 'cm-card-action';
            open.textContent = copy.editor.embed.open;
            open.addEventListener('click', () => host.open(found.owner, found.path));
            head.append(open);

            for (const line of excerpt(found.content, heading, 10, found.title)) {
              const row = document.createElement('div');
              const isHeading = /^#{1,6}\s+(.*)$/.exec(line);
              if (isHeading !== null) row.className = 'cm-card-heading';
              row.textContent = isHeading?.[1] ?? line;
              body.append(row);
            }
          })
          .catch(() => {
            body.textContent = copy.editor.embed.noteMissing;
          });

        return { dom: card };
      },
    };
  },
  // Long enough that sweeping the pointer across a paragraph does not set off a
  // request per link, short enough to feel like an answer.
  { hoverTime: 450 },
);

const followOnModClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    if (!(event.ctrlKey || event.metaKey) || event.button !== 0) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
    if (pos === null) return false;
    const link = wikilinkAt(view, pos);
    const host = view.state.facet(embedHost)();
    if (link === null || host === null) return false;

    event.preventDefault();
    const { note } = linkTarget(link.inner);
    void host.resolve(note).then((found) => {
      if (found !== null) host.open(found.owner, found.path);
    });
    return true;
  },
});

export function linkPreview(): Extension {
  return [preview, followOnModClick];
}

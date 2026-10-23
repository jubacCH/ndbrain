/**
 * Things in a note that are shown as what they stand for: a diagram, a formula,
 * another note, an attachment, the page behind a link.
 *
 * The same contract as the rest of live preview holds, and it is the reason
 * this can exist at all in a tool that rejected rich text: the file keeps the
 * Markdown, byte for byte — a fenced `mermaid` block, `$…$`, `![[Note]]`, a bare
 * URL — and every one of them reads correctly in any other editor. What happens
 * here only changes what is drawn while the cursor is elsewhere. Clicking a
 * drawn embed puts the cursor into its source, and the source is what shows.
 *
 * The heavy renderers (Mermaid is most of a megabyte, KaTeX brings its fonts)
 * are loaded the first time a note needs them, never with the bundle. Somebody
 * whose notes contain no diagram never downloads a diagram library.
 */

import {
  Facet,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet } from '@codemirror/view';

import { copy } from '../copy';

/* ---- what the editor needs from the application ------------------------ */

/** A note a wikilink resolved to, with its text. */
export interface LinkedNote {
  owner: string;
  path: string;
  title: string;
  content: string;
}

/** What the server read off the page behind a URL. */
export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  site: string | null;
}

/**
 * The application's side of embeds and link previews.
 *
 * Behind a getter like the tag registry, and for the same reason: the editor
 * outlives the callbacks it was built with, and rebuilding it to hand over a new
 * one would throw the cursor out of the sentence.
 */
export interface EmbedHost {
  /** The note a `[[target]]` names, as the index resolves it — or null. */
  resolve: (target: string) => Promise<LinkedNote | null>;
  open: (owner: string, path: string) => void;
  unfurl: (url: string) => Promise<LinkPreview | null>;
}

export const embedHost = Facet.define<() => EmbedHost | null, () => EmbedHost | null>({
  combine: (values) => values[0] ?? (() => null),
});

/* ---- shared helpers ----------------------------------------------------- */

/** The target of a wikilink without its `#heading` and `|label`. */
export function linkTarget(inner: string): { note: string; heading: string | null } {
  const target = inner.split('|')[0] ?? '';
  const hash = target.indexOf('#');
  return hash === -1
    ? { note: target.trim(), heading: null }
    : { note: target.slice(0, hash).trim(), heading: target.slice(hash + 1).trim() || null };
}

/**
 * The opening of a note as plain lines, for a preview card.
 *
 * Without the frontmatter, which is addressing rather than content, and cut to
 * one section when a heading is asked for — `![[Proxmox#Backup]]` means the
 * backup section, not the whole note.
 */
export function excerpt(
  content: string,
  heading: string | null,
  limit = 14,
  title: string | null = null,
): string[] {
  let lines = content.split('\n');
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
    if (end !== -1) lines = lines.slice(end + 1);
  }

  if (heading !== null) {
    const wanted = heading.toLowerCase();
    const start = lines.findIndex((line) => {
      const match = /^(#{1,6})\s+(.*)$/.exec(line);
      return match !== null && (match[2] ?? '').trim().toLowerCase() === wanted;
    });
    if (start !== -1) {
      const level = /^#+/.exec(lines[start] ?? '')?.[0].length ?? 1;
      const rest = lines.slice(start + 1);
      const stop = rest.findIndex((line) => {
        const match = /^(#{1,6})\s/.exec(line);
        return match !== null && (match[1]?.length ?? 7) <= level;
      });
      lines = stop === -1 ? rest : rest.slice(0, stop);
    }
  }

  // Blank lines carry no content in a glance, only height; and a leading
  // heading that repeats the card's own title says the same thing twice.
  lines = lines.filter((line) => line.trim() !== '');
  const first = /^#\s+(.*)$/.exec(lines[0] ?? '');
  if (title !== null && first !== null && first[1]?.trim().toLowerCase() === title.toLowerCase()) {
    lines.shift();
  }
  const cut = lines.slice(0, limit);
  if (lines.length > limit) cut.push('…');
  return cut;
}

/** Fills a card body with excerpt lines, headings told apart by weight. */
function fillExcerpt(body: HTMLElement, lines: readonly string[]): void {
  body.replaceChildren();
  for (const line of lines) {
    const row = document.createElement('div');
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      row.className = 'cm-card-heading';
      row.textContent = heading[1] ?? '';
    } else {
      // Plain text on purpose: an excerpt is a glance, and running the note
      // through a renderer here would be the second Markdown model this project
      // promised not to have.
      row.textContent = line;
    }
    body.append(row);
  }
}

/** Puts the cursor at the start of an embed's source, which reveals it. */
function editSource(view: EditorView, dom: HTMLElement): void {
  if (view.state.readOnly) return;
  const pos = view.posAtDOM(dom);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: false });
  view.focus();
}

/** Clicks on the card itself edit; clicks on its links and buttons do not. */
function clickToEdit(view: EditorView, dom: HTMLElement): void {
  dom.addEventListener('mousedown', (event) => {
    if ((event.target as HTMLElement).closest('a, button') !== null) return;
    event.preventDefault();
    editSource(view, dom);
  });
}

function isDark(): boolean {
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme !== null) return theme === 'dark';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

/* ---- the lazy renderers ------------------------------------------------- */

type KaTeX = typeof import('katex').default;
let katexLoad: Promise<KaTeX> | null = null;

function loadKatex(): Promise<KaTeX> {
  katexLoad ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')]).then(
    ([module]) => module.default,
  );
  return katexLoad;
}

type Mermaid = typeof import('mermaid').default;
let mermaidLoad: Promise<Mermaid> | null = null;
let diagramSeq = 0;

async function renderDiagram(source: string, dark: boolean): Promise<string> {
  mermaidLoad ??= import('mermaid').then((module) => module.default);
  const mermaid = await mermaidLoad;
  mermaid.initialize({
    startOnLoad: false,
    // Strict: a shared note is somebody else's text, and Mermaid's looser modes
    // let a diagram carry clickable script.
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'neutral',
    fontFamily: 'inherit',
  });
  const id = `ndbrain-diagram-${++diagramSeq}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return svg;
  } finally {
    // A failed render leaves its scratch element in the body.
    document.getElementById(`d${id}`)?.remove();
  }
}

/* ---- widgets ------------------------------------------------------------ */

/** `$…$` and `$$…$$`, typeset. */
export class MathWidget extends WidgetType {
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof MathWidget && other.tex === this.tex && other.display === this.display;
  }

  override toDOM(view: EditorView): HTMLElement {
    const element = document.createElement(this.display ? 'div' : 'span');
    element.className = this.display ? 'cm-math cm-math-display' : 'cm-math';
    // The source until the typesetter arrives, and the source if it fails: a
    // formula that does not parse must still be readable as what was written.
    element.textContent = this.display ? `$$${this.tex}$$` : `$${this.tex}$`;

    void loadKatex()
      .then((katex) => {
        katex.render(this.tex, element, {
          displayMode: this.display,
          throwOnError: true,
          trust: false,
        });
      })
      .catch(() => element.classList.add('cm-math-broken'));

    if (this.display) clickToEdit(view, element);
    return element;
  }

  override get estimatedHeight(): number {
    return this.display ? 48 : -1;
  }
}

/** A fenced `mermaid` block, drawn. */
export class DiagramWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly dark: boolean,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof DiagramWidget && other.source === this.source && other.dark === this.dark;
  }

  override toDOM(view: EditorView): HTMLElement {
    const frame = document.createElement('div');
    frame.className = 'cm-diagram';
    frame.setAttribute('role', 'img');
    frame.setAttribute('aria-label', copy.editor.embed.diagram);
    frame.textContent = copy.editor.embed.drawing;

    void renderDiagram(this.source, this.dark)
      .then((svg) => {
        // Mermaid's own sanitiser has run over this in strict mode.
        frame.innerHTML = svg;
      })
      .catch((error: unknown) => {
        frame.classList.add('cm-diagram-broken');
        frame.replaceChildren();
        const message = document.createElement('div');
        message.className = 'cm-card-meta';
        message.textContent = `${copy.editor.embed.diagramFailed}${
          error instanceof Error ? ` — ${error.message.split('\n')[0]}` : ''
        }`;
        const source = document.createElement('pre');
        source.textContent = this.source;
        frame.append(message, source);
      });

    clickToEdit(view, frame);
    return frame;
  }

  override get estimatedHeight(): number {
    return 220;
  }
}

/** `![[Another note]]` — the opening of that note, in a card. */
export class NoteEmbedWidget extends WidgetType {
  constructor(readonly inner: string) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof NoteEmbedWidget && other.inner === this.inner;
  }

  override toDOM(view: EditorView): HTMLElement {
    const { note, heading } = linkTarget(this.inner);
    const card = document.createElement('div');
    card.className = 'cm-note-embed';

    const head = document.createElement('div');
    head.className = 'cm-card-head';
    const title = document.createElement('span');
    title.className = 'cm-card-title';
    title.textContent = heading === null ? note : `${note} › ${heading}`;
    head.append(title);

    const body = document.createElement('div');
    body.className = 'cm-card-body';
    body.textContent = copy.editor.embed.loading;
    card.append(head, body);

    const host = view.state.facet(embedHost)();
    if (host === null) {
      body.textContent = copy.editor.embed.noteMissing;
    } else {
      void host
        .resolve(note)
        .then((found) => {
          if (found === null) {
            card.classList.add('cm-card-missing');
            body.textContent = copy.editor.embed.noteMissing;
            return;
          }
          title.textContent = heading === null ? found.title : `${found.title} › ${heading}`;
          const open = document.createElement('button');
          open.type = 'button';
          open.className = 'cm-card-action';
          open.textContent = copy.editor.embed.open;
          open.addEventListener('click', () => host.open(found.owner, found.path));
          head.append(open);
          fillExcerpt(body, excerpt(found.content, heading, 14, found.title));
        })
        .catch(() => {
          body.textContent = copy.editor.embed.noteMissing;
        });
    }

    clickToEdit(view, card);
    return card;
  }

  override get estimatedHeight(): number {
    return 160;
  }
}

/**
 * `![[report.pdf]]` — anything that is neither a picture nor a note.
 *
 * A download link and nothing more. The server sends everything that is not a
 * known image as an attachment, on purpose (see the files routes): a PDF or an
 * HTML file shown inline on this origin is a script host next to the session.
 */
export class AttachmentWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly url: string,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof AttachmentWidget && other.url === this.url;
  }

  override toDOM(view: EditorView): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'cm-attachment';

    const kind = document.createElement('span');
    kind.className = 'cm-attachment-kind';
    const dot = this.name.lastIndexOf('.');
    kind.textContent = dot === -1 ? copy.editor.embed.file : this.name.slice(dot + 1).toUpperCase();

    const link = document.createElement('a');
    link.href = this.url;
    link.download = this.name;
    link.textContent = this.name;
    link.title = copy.editor.embed.download;

    chip.append(kind, link);
    clickToEdit(view, chip);
    return chip;
  }
}

/**
 * A bare URL alone in its paragraph, as a card with the page's own title.
 *
 * Text only. A preview picture would have to come from the linked site, which
 * the page's content security policy does not allow and which would tell that
 * site who is reading the note.
 */
export class LinkCardWidget extends WidgetType {
  constructor(readonly url: string) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof LinkCardWidget && other.url === this.url;
  }

  override toDOM(view: EditorView): HTMLElement {
    const card = document.createElement('div');
    card.className = 'cm-linkcard';

    const text = document.createElement('div');
    text.className = 'cm-linkcard-text';

    const title = document.createElement('a');
    title.className = 'cm-card-title';
    title.href = this.url;
    title.target = '_blank';
    // No referrer: the page behind a link in a private note has no business
    // learning which private note it was linked from.
    title.rel = 'noopener noreferrer';
    title.textContent = this.url;

    const description = document.createElement('div');
    description.className = 'cm-linkcard-description';

    const site = document.createElement('div');
    site.className = 'cm-card-meta';
    try {
      site.textContent = new URL(this.url).host;
    } catch {
      site.textContent = this.url;
    }

    text.append(title, description, site);
    card.append(text);

    const host = view.state.facet(embedHost)();
    void host
      ?.unfurl(this.url)
      .then((preview) => {
        if (preview === null) return;
        if (preview.title !== null) title.textContent = preview.title;
        if (preview.description !== null) description.textContent = preview.description;
        if (preview.site !== null) site.textContent = preview.site;
      })
      .catch(() => undefined);

    clickToEdit(view, card);
    return card;
  }

  override get estimatedHeight(): number {
    return 84;
  }
}

/* ---- inline finders, used by live preview ------------------------------ */

/**
 * `$…$` the way Pandoc reads it, which is what keeps shell variables out.
 *
 * The opening `$` must be followed by something other than a space, the
 * closing one preceded by something other than a space and not followed by a
 * digit. So `$HOME and $PATH` is two dollar signs and no formula, and so is
 * "between $5 and $10" — the vault is full of both.
 */
export const INLINE_MATH = /(?<![\\$\w])\$(?![\s$])((?:\\.|[^$\n\\])+?)(?<![\s\\])\$(?![\d$])/g;

/** `==highlighted==`, as Obsidian and AFFiNE's Markdown export write it. */
export const HIGHLIGHT = /(?<!=)==(?![\s=])([^=\n]+?)(?<!\s)==(?!=)/g;

/** A line that is nothing but a URL, optionally in angle brackets. */
export const BARE_URL = /^\s*<?(https?:\/\/[^\s<>]+)>?\s*$/;

/* ---- block embeds: diagrams and display math --------------------------- */

interface Block {
  from: number;
  to: number;
  widget: WidgetType;
}

/**
 * Finds the blocks that are drawn whole: fenced `mermaid` code and `$$` math.
 *
 * Textual, like the table finder, and for the same reason — a block decoration
 * comes from the state, and at that point the syntax tree of a long note may
 * not have been parsed this far yet. Other fences are stepped over, so `$$` in a
 * shell snippet stays a shell snippet.
 */
export function findBlocks(state: EditorState): Block[] {
  const blocks: Block[] = [];
  const doc = state.doc;
  const dark = typeof document === 'undefined' ? false : isDark();

  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    const fence = /^ {0,3}(`{3,}|~{3,})\s*([\w-]*)/.exec(line.text);

    if (fence !== null) {
      const marker = fence[1] ?? '```';
      const language = (fence[2] ?? '').toLowerCase();
      let end = n + 1;
      while (end <= doc.lines) {
        const text = doc.line(end).text.trim();
        if (text.startsWith(marker[0]!.repeat(marker.length)) && /^[`~]+$/.test(text)) break;
        end++;
      }
      // An unclosed fence runs to the end of the note, as CommonMark has it.
      const last = Math.min(end, doc.lines);
      if (language === 'mermaid' && end <= doc.lines) {
        const source = doc.sliceString(line.to + 1, doc.line(last).from - 1);
        if (source.trim() !== '') {
          blocks.push({
            from: line.from,
            to: doc.line(last).to,
            widget: new DiagramWidget(source, dark),
          });
        }
      }
      n = last;
      continue;
    }

    const single = /^\s*\$\$(.+?)\$\$\s*$/.exec(line.text);
    if (single !== null) {
      blocks.push({ from: line.from, to: line.to, widget: new MathWidget(single[1] ?? '', true) });
      continue;
    }

    if (line.text.trim() === '$$') {
      let end = n + 1;
      while (end <= doc.lines && doc.line(end).text.trim() !== '$$') end++;
      if (end > doc.lines) continue;
      const tex = doc.sliceString(line.to + 1, doc.line(end).from - 1);
      if (tex.trim() !== '') {
        blocks.push({ from: line.from, to: doc.line(end).to, widget: new MathWidget(tex, true) });
      }
      n = end;
    }
  }

  return blocks;
}

function touched(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

function buildBlocks(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const block of findBlocks(state)) {
    // The source comes back while the cursor is in it, like every other piece
    // of notation here — a diagram is written as text and read as a picture.
    if (touched(state, block.from, block.to)) continue;
    ranges.push(Decoration.replace({ widget: block.widget, block: true }).range(block.from, block.to));
  }
  return Decoration.set(ranges, true);
}

/** Sent when light and dark swap, so diagrams are drawn again in the other theme. */
const themeChanged = StateEffect.define<null>();

const blockDecorations = StateField.define<DecorationSet>({
  create: buildBlocks,
  update: (value, transaction) =>
    transaction.docChanged ||
    transaction.selection ||
    transaction.effects.some((effect) => effect.is(themeChanged))
      ? buildBlocks(transaction.state)
      : value,
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Watches the theme. Mermaid bakes its colours into the SVG, so a diagram
 * drawn in daylight stays a white box after the switch to night unless it is
 * drawn again — tokens cannot reach inside it.
 */
const themeWatch = ViewPlugin.fromClass(
  class {
    readonly observer: MutationObserver;
    readonly media: MediaQueryList | null;
    gone = false;
    readonly notify = (): void => {
      // Next frame: the attribute change can arrive in the middle of an update.
      requestAnimationFrame(() => {
        if (!this.gone) this.view.dispatch({ effects: themeChanged.of(null) });
      });
    };

    constructor(readonly view: EditorView) {
      this.observer = new MutationObserver(this.notify);
      this.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      this.media = window.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
      this.media?.addEventListener('change', this.notify);
    }

    destroy(): void {
      this.gone = true;
      this.observer.disconnect();
      this.media?.removeEventListener('change', this.notify);
    }
  },
);

export function blockEmbeds(): Extension {
  return [blockDecorations, themeWatch];
}

/** Lines a drawn block currently covers, for live preview to keep out of. */
export function drawnBlockAt(state: EditorState, pos: number): boolean {
  let hit = false;
  state.field(blockDecorations, false)?.between(pos, pos, () => {
    hit = true;
    return false;
  });
  return hit;
}

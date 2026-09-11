/**
 * The `/` menu.
 *
 * Two things are being checked here. That the menu inserts what it says it
 * inserts — including a table of the size asked for, with the cursor in its
 * first cell rather than behind the whole thing. And that `/tag` can only ever
 * offer what the vault's registry allows, since the entire point of it is that a
 * tag outside the registry never gets typed in the first place.
 */

import { CompletionContext, type Completion } from '@codemirror/autocomplete';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { describe, expect, it } from 'vitest';

import { noteExtensions } from '../src/Editor';
import { slashSource } from '../src/editor/commands';
import { findTables } from '../src/editor/table';
import { parseTagRegistry } from '../src/editor/tagRegistry';

const REGISTRY = [
  '# Tag-Registry — erlaubte Tags',
  '',
  '## type/  (Form der Notiz)',
  '',
  '`type/howto` · `type/reference` · `type/gotcha` · `type/project`',
  '',
  '## status/  (nur in 00_Inbox & 10_Projects)',
  '',
  '`status/active` · `status/done`',
  '',
  '## topic/  (Sachgebiet)',
  '',
  '`topic/proxmox` · `topic/homelab`',
  '',
  '### Abgleich noch offen',
  '',
  'Im Umlauf, aber ungeprüft: observability · myai · secondbrain · joplin.',
  'Auch `observability` steht hier nur zur Ansicht.',
  '',
  '```markdown',
  '## topic/  (Beispiel)',
  '`topic/beispiel`',
  '```',
].join('\n');

/**
 * The registry as it actually stands in the vault, on 2026-09-11.
 *
 * Worth having verbatim, because it disagrees with the brief in the one place
 * that matters: the "Abgleich noch offen" box spells its unapproved candidates
 * *in backticks*. A parser that only took backticks would offer every one of
 * them. What keeps them out is the second rule — a value counts only under a
 * `## prefix/` heading and only if it carries that prefix — and the box sits
 * inside the `topic/` section, where `observability` is not a `topic/` anything.
 */
const REAL_REGISTRY = [
  '---',
  'created: 2026-06-06',
  'updated: 2026-06-06',
  '',
  'tags: [governance]',
  '---',
  '> **type:** reference',
  '> **topic:** governance',
  '> **updated:** 2026-09-11',
  '',
  '**Regel:** Notizbuch = Wohnort (Lebenszyklus). Tag = jede Querschnitt-Dimension. Pflicht je Notiz: **1× `type/` + ≥1× `topic/`**.',
  '',
  '## type/  (Form der Notiz)',
  '`type/howto` · `type/reference` · `type/gotcha` · `type/idea` · `type/meeting` · `type/clipping` · `type/log` · `type/moc` · `type/project`',
  '',
  '## status/  (nur in 00_Inbox & 10_Projects)',
  '`status/inbox` · `status/triaged` · `status/active` · `status/wip` · `status/done` · `status/stale`',
  '',
  '## topic/  (Sachgebiet — kuratiert erweiterbar)',
  '`topic/proxmox` · `topic/docker` · `topic/networking` · `topic/unifi` · `topic/paperless` · `topic/n8n` · `topic/ai` · `topic/finanzen` · `topic/homelab` · `topic/infrastruktur` · `topic/backup` · `topic/governance` · `topic/monitoring` · `topic/tooling`',
  '',
  '> **2026-08-17 — Abgleich noch offen.** Die fünf hinteren sind nachgetragen, weil',
  '> sie im Vault längst verwendet wurden. Weitere im Umlauf, aber ungeprüft:',
  '> `observability`, `myai`, `secondbrain`, `joplin`, `runbook`, `navigation`,',
  '> `todo`. Vor dem Aufräumen entscheiden, welche davon echte Sachgebiete sind und',
  '> welche nur Zustand oder Form beschreiben — Letzteres gehört zu `type/` oder',
  '> `status/`, nicht hierher.',
  '',
  '## src/  (Herkunft — nur vom Ingest-Layer gesetzt)',
  '`src/manual` · `src/email` · `src/calendar` · `src/web` · `src/chat` · `src/paperless` · `src/n8n`',
].join('\n');

const ALLOWED = [
  'type/howto',
  'type/reference',
  'type/gotcha',
  'type/project',
  'status/active',
  'status/done',
  'topic/proxmox',
  'topic/homelab',
];

function open(doc: string, tags: readonly string[] | null = ALLOWED): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      extensions: noteExtensions({ owner: 'julian', path: 'Notiz.md', tags: () => tags }),
    }),
    parent: document.body,
  });
  view.dispatch({ selection: { anchor: doc.length } });
  return view;
}

function menu(view: EditorView): readonly Completion[] {
  const pos = view.state.selection.main.head;
  return slashSource(new CompletionContext(view.state, pos, true))?.options ?? [];
}

function pick(view: EditorView, label: string): void {
  const pos = view.state.selection.main.head;
  const result = slashSource(new CompletionContext(view.state, pos, true));
  if (result === null) throw new Error('no menu');
  const option = result.options.find((candidate) => candidate.label === label);
  if (option === undefined) throw new Error(`no command ${label}: ${result.options.map((o) => o.label).join(', ')}`);
  (option.apply as (view: EditorView, option: Completion, from: number, to: number) => void)(
    view,
    option,
    result.from,
    pos,
  );
}

describe('inserting a table', () => {
  it('puts the cursor in the first cell, not behind the table', () => {
    const view = open('/');
    pick(view, 'Table 2×2');

    expect(findTables(view.state.doc.toString())).toHaveLength(1);
    const active = document.activeElement as HTMLInputElement | null;
    expect(active?.dataset['row']).toBe('0');
    expect(active?.dataset['column']).toBe('0');
    view.destroy();
  });

  it('takes the size from the command itself', () => {
    const view = open('/table3x4');
    expect(menu(view).map((option) => option.label)).toEqual(['Table 3×4']);

    pick(view, 'Table 3×4');
    const table = findTables(view.state.doc.toString())[0];
    expect(table?.rows).toHaveLength(3);
    expect(table?.columns).toBe(4);
    view.destroy();
  });

  it('caps a size nobody meant, and says that it did', () => {
    const view = open('/table50x50');
    const [option] = menu(view);
    expect(option?.label).toBe('Table 20×10');
    expect(option?.detail).toContain('capped');

    pick(view, 'Table 20×10');
    expect(findTables(view.state.doc.toString())[0]?.columns).toBe(10);
    view.destroy();
  });

  it('still means a 2×2 grid without a size', () => {
    const view = open('/');
    expect(menu(view).some((option) => option.label === 'Table 2×2')).toBe(true);
    view.destroy();
  });
});

describe('the rest of the menu', () => {
  it('opens on a slash at the start of a line and not inside a path', () => {
    const view = open('/');
    expect(menu(view).length).toBeGreaterThan(5);
    view.destroy();

    const path = open('siehe /opt/ndbrain');
    expect(menu(path)).toEqual([]);
    path.destroy();
  });

  it('leaves status out of the frontmatter it inserts', () => {
    const view = open('/');
    pick(view, 'Frontmatter');

    const text = view.state.doc.toString();
    expect(text).toContain('type:');
    expect(text).toContain('updated:');
    expect(text).not.toContain('status:');
    view.destroy();
  });

  it('writes a dated section the way the vault asks for one', () => {
    const view = open('/');
    pick(view, 'Date section');

    const today = new Date();
    const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    expect(view.state.doc.toString()).toBe(`## ${iso} — `);
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    view.destroy();
  });

  it('writes a warning block with the cursor after it', () => {
    const view = open('/');
    pick(view, 'Warning');

    expect(view.state.doc.toString()).toBe('> ⚠️ **Achtung:** ');
    expect(view.state.selection.main.head).toBe(view.state.doc.length);
    view.destroy();
  });
});

describe('tags come from the registry', () => {
  it('reads the approved values and nothing else', () => {
    expect(parseTagRegistry(REGISTRY)).toEqual(ALLOWED);
  });

  it('ignores the candidates that are only under discussion', () => {
    const parsed = parseTagRegistry(REGISTRY);
    for (const loose of ['observability', 'myai', 'secondbrain', 'joplin']) {
      expect(parsed).not.toContain(loose);
    }
    // Even in backticks: the section it stands under approves nothing.
    expect(parsed).not.toContain('observability');
    // And an example in a fenced block is an example.
    expect(parsed).not.toContain('topic/beispiel');
  });

  it('reads the vault\'s own registry without picking up what it only discusses', () => {
    const parsed = parseTagRegistry(REAL_REGISTRY);

    expect(parsed).toHaveLength(36);
    expect(parsed.slice(0, 2)).toEqual(['type/howto', 'type/reference']);
    expect(parsed).toContain('status/stale');
    expect(parsed).toContain('topic/tooling');
    expect(parsed).toContain('src/n8n');

    // In backticks, inside the `topic/` section, and still not offered: they
    // are not `topic/` anything, which is the whole test.
    for (const loose of ['observability', 'myai', 'secondbrain', 'joplin', 'runbook', 'navigation', 'todo']) {
      expect(parsed).not.toContain(loose);
    }
    // Nor the bare prefixes the prose mentions.
    expect(parsed).not.toContain('type/');
    expect(parsed).not.toContain('status/');
  });

  it('offers the allowed tags and inserts the one picked', () => {
    const view = open('/tag');
    expect(menu(view).map((option) => option.label)).toEqual(ALLOWED.map((tag) => `#${tag}`));

    pick(view, '#topic/proxmox');
    expect(view.state.doc.toString()).toBe('#topic/proxmox');
    view.destroy();
  });

  it('narrows as more is typed', () => {
    const view = open('/tagtopic');
    expect(menu(view).map((option) => option.label)).toEqual(['#topic/proxmox', '#topic/homelab']);
    view.destroy();
  });

  it('says so rather than guessing when the registry cannot be read', () => {
    const view = open('/tag', null);
    const options = menu(view);
    expect(options).toHaveLength(1);
    expect(options[0]?.label).toContain('unavailable');

    pick(view, options[0]?.label ?? '');
    // Nothing invented: the typed text is still all there is.
    expect(view.state.doc.toString()).toBe('/tag');
    view.destroy();
  });
});

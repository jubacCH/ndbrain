/**
 * The `/` menu: type a slash at the start of a line and pick what to insert.
 *
 * This exists instead of a toolbar. A toolbar costs permanent screen area and a
 * row of icons, and the design direction rules both out; the slash menu costs
 * nothing until it is asked for, and it names its commands in words rather than
 * pictures. It also happens to be the only formatting affordance that works on
 * a phone, where there are no modifier keys but there is always a slash.
 *
 * It deliberately only *inserts structure*. Making an already-written word bold
 * is the keyboard's job (see `./format`), because by the time you have selected
 * something, typing a slash would replace it.
 */

import {
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { Facet } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

import { blankTable } from './table';
import { focusCell } from './tableView';
import { REGISTRY_PATH } from './tagRegistry';

/**
 * A slash at the start of a line, plus whatever has been typed since.
 *
 * Anchored to the line start on purpose. These notes are full of paths like
 * `/opt/ndbrain` and `/srv/ndbrain/vaults`, and a menu that opened after every
 * space would spend its life flickering at text that is not a command.
 */
const SLASH = /^(\s*)\/(\w*)$/;

/**
 * `/table3x4` — rows first, columns second, and both spelled out in the menu
 * before anything is inserted, because "3x4" is genuinely ambiguous.
 *
 * No space in the form: `/table 3x4` would mean letting the menu survive a
 * space after the slash, and the whole reason it is anchored to `^\s*\/\w*$` is
 * that these notes are full of `/opt/ndbrain` and `/srv/…`. A menu that opened
 * again after every space would flicker at text that is not a command.
 */
const TABLE_SIZE = /^table(\d+)x(\d+)$/i;

/**
 * Where a table stops being a table and becomes a spreadsheet.
 *
 * Ten columns is already wider than the pane, and twenty rows is quicker to
 * grow with Enter than to type a number for. Over the limit the menu shows the
 * size it will actually insert, so nothing happens silently.
 */
const MAX_ROWS = 20;
const MAX_COLUMNS = 10;

/**
 * How the menu reaches the tags the vault allows.
 *
 * A getter, not a value: the registry is fetched after the editor is built, and
 * rebuilding the editor to deliver it would cost the cursor its place.
 */
export const tagContext = Facet.define<
  () => readonly string[] | null,
  () => readonly string[] | null
>({
  combine: (values) => values[0] ?? (() => null),
});

interface Command {
  label: string;
  detail: string;
  /** Text to insert. `|` marks where the cursor ends up and is removed. */
  insert: string;
  /**
   * Where the cursor goes, counted in the inserted text.
   *
   * For anything whose own syntax contains a pipe — a table — since the `|`
   * marker cannot tell the two apart.
   */
  caret?: number;
  /** Finishes a command that insertion alone does not, such as a table. */
  then?: (view: EditorView, start: number) => void;
}

/** Today, written out in full — the form the vault's conventions ask for. */
function today(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** A grid of the given size, with the cursor waiting in its first cell. */
function table(rows: number, columns: number, detail: string): Command {
  return {
    label: `Table ${rows}×${columns}`,
    detail,
    insert: blankTable(rows, columns),
    // Two: past the opening `| ` of the first cell. The pipe marker every other
    // command uses would land on the table's own syntax, which is why the
    // cursor used to end up behind the whole table instead of inside it.
    caret: 2,
    then: (view, start) => focusCell(view, view.state.doc.lineAt(start).number, 0, 0),
  };
}

function commands(): Command[] {
  return [
    { label: 'Heading 1', detail: '#', insert: '# |' },
    { label: 'Heading 2', detail: '##', insert: '## |' },
    { label: 'Heading 3', detail: '###', insert: '### |' },
    { label: 'Task', detail: '- [ ]', insert: '- [ ] |' },
    { label: 'Bullet list', detail: '-', insert: '- |' },
    { label: 'Numbered list', detail: '1.', insert: '1. |' },
    { label: 'Quote', detail: '>', insert: '> |' },
    { label: 'Code block', detail: '```', insert: '```|\n\n```' },
    table(2, 2, '| … |  ·  /table3x4 for a size'),
    {
      // The form the vault's own writing rules ask for when something is added
      // to a note that already exists: its own dated section, never a sentence
      // slipped into somebody else's paragraph.
      label: 'Date section',
      detail: `## ${today()} — …`,
      insert: `## ${today()} — |`,
    },
    { label: 'Warning', detail: '> ⚠️ **Achtung:**', insert: '> ⚠️ **Achtung:** |' },
    {
      label: 'Tag',
      detail: 'from the registry',
      // Types the command out and asks again: the second pass answers with the
      // allowed values rather than with this list.
      insert: '/tag',
      caret: 4,
      then: (view) => startCompletion(view),
    },
    { label: 'Divider', detail: '---', insert: '---\n|' },
    { label: 'Link a note', detail: '[[ ]]', insert: '[[|' },
    { label: 'Date', detail: today(), insert: `${today()}|` },
    {
      // No `status:`. The folder a project note sits in is its lifecycle
      // (`11_Active` against `19_Done`), and a second field beside it drifts.
      label: 'Frontmatter',
      detail: 'type · updated',
      insert: `---\ntype: |\nupdated: ${today()}\n---\n`,
    },
  ];
}

function toCompletion(command: Command, index: number): Completion {
  const marked = command.caret === undefined;
  const caret = marked ? command.insert.indexOf('|') : command.caret;
  const text = marked ? command.insert.replace('|', '') : command.insert;

  return {
    label: command.label,
    detail: command.detail,
    type: 'keyword',
    // Without a boost the menu sorts alphabetically, which buries headings —
    // by far the most-reached-for command — under Frontmatter and Datum. The
    // order in `commands()` is the order of expected use.
    boost: 99 - index * 4,
    apply: (view: EditorView, _completion: Completion, from: number, to: number): void => {
      // `from` sits just after the slash, because that is what the typed text
      // is filtered against. The slash itself still has to go.
      const start = from - 1;
      view.dispatch({
        changes: { from: start, to, insert: text },
        selection: { anchor: start + (caret === undefined || caret === -1 ? text.length : caret) },
        scrollIntoView: true,
        userEvent: 'input.complete',
      });
      command.then?.(view, start);
    },
  };
}

/** `/table3x4`, capped, and saying so where it is capped. */
function sizedTable(rows: number, columns: number): Completion {
  const capped = { rows: clamp(rows, MAX_ROWS), columns: clamp(columns, MAX_COLUMNS) };
  const detail =
    capped.rows === rows && capped.columns === columns
      ? `${capped.rows} rows · ${capped.columns} columns`
      : `capped at ${capped.rows} rows · ${capped.columns} columns`;

  return toCompletion(table(capped.rows, capped.columns, detail), 0);
}

function clamp(value: number, most: number): number {
  return Math.max(1, Math.min(most, value));
}

/**
 * The allowed tags, as options.
 *
 * When the registry cannot be read the menu says so and inserts nothing. The
 * tempting fallback — offering the tags already in the index — would quietly
 * turn the one place that keeps the vocabulary closed into a place that spreads
 * whatever is already loose in it.
 */
function tagOptions(allowed: readonly string[] | null, typed: string): Completion[] {
  if (allowed === null) {
    return [
      {
        label: 'Tag registry unavailable',
        detail: REGISTRY_PATH,
        type: 'text',
        apply: (): void => undefined,
      },
    ];
  }

  const needle = typed.toLowerCase();
  return allowed
    .filter((tag) => tag.toLowerCase().includes(needle))
    .map((tag, index) => ({
      label: `#${tag}`,
      type: 'keyword',
      boost: 99 - index,
      apply: (view: EditorView, _completion: Completion, from: number, to: number): void => {
        const start = from - 1;
        view.dispatch({
          changes: { from: start, to, insert: `#${tag}` },
          selection: { anchor: start + tag.length + 1 },
          scrollIntoView: true,
          userEvent: 'input.complete',
        });
      },
    }));
}

function slashSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const match = SLASH.exec(before);
  if (match === null) return null;

  const indent = match[1] ?? '';
  const typed = match[2] ?? '';
  // One past the slash: CodeMirror filters on the text between `from` and the
  // cursor, and a leading slash would have to be part of every label.
  const from = line.from + indent.length + 1;

  const size = TABLE_SIZE.exec(typed);
  if (size !== null) {
    // Filtering off: "table3x4" matches no label, and the one option this
    // answers with is the answer to exactly what was typed.
    return { from, options: [sizedTable(Number(size[1]), Number(size[2]))], filter: false };
  }

  if (/^tag./i.test(typed) || typed.toLowerCase() === 'tag') {
    return {
      from,
      options: tagOptions(context.state.facet(tagContext)(), typed.slice(3)),
      filter: false,
    };
  }

  return {
    from,
    options: commands().map(toCompletion),
    validFor: /^\w*$/,
  };
}

export { slashSource };

/** Standalone form, for wiring the slash menu on its own. */
export function slashCommands() {
  return autocompletion({ override: [slashSource], icons: false });
}

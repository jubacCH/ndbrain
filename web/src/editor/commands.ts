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
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import type { EditorView } from '@codemirror/view';

/**
 * A slash at the start of a line, plus whatever has been typed since.
 *
 * Anchored to the line start on purpose. These notes are full of paths like
 * `/opt/ndbrain` and `/srv/ndbrain/vaults`, and a menu that opened after every
 * space would spend its life flickering at text that is not a command.
 */
const SLASH = /^(\s*)\/(\w*)$/;

interface Command {
  label: string;
  detail: string;
  /** Text to insert. `|` marks where the cursor ends up and is removed. */
  insert: string;
}

/** Today, written out in full — the form the vault's conventions ask for. */
function today(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function commands(): Command[] {
  return [
    { label: 'Überschrift 1', detail: '#', insert: '# |' },
    { label: 'Überschrift 2', detail: '##', insert: '## |' },
    { label: 'Überschrift 3', detail: '###', insert: '### |' },
    { label: 'Aufgabe', detail: '- [ ]', insert: '- [ ] |' },
    { label: 'Liste', detail: '-', insert: '- |' },
    { label: 'Nummerierte Liste', detail: '1.', insert: '1. |' },
    { label: 'Zitat', detail: '>', insert: '> |' },
    { label: 'Code-Block', detail: '```', insert: '```|\n\n```' },
    {
      label: 'Tabelle',
      detail: '| … |',
      insert: '| | |\n| --- | --- |\n| | |',
    },
    { label: 'Trennlinie', detail: '---', insert: '---\n|' },
    { label: 'Notiz verlinken', detail: '[[ ]]', insert: '[[|' },
    { label: 'Datum', detail: today(), insert: `${today()}|` },
    {
      label: 'Frontmatter',
      detail: 'type · status · updated',
      insert: `---\ntype: |\nstatus: \nupdated: ${today()}\n---\n`,
    },
  ];
}

function toCompletion(command: Command, index: number): Completion {
  const { insert } = command;
  const caret = insert.indexOf('|');
  const text = insert.replace('|', '');

  return {
    label: command.label,
    detail: command.detail,
    type: 'keyword',
    // Without a boost the menu sorts alphabetically, which buries headings —
    // by far the most-reached-for command — under Frontmatter and Datum. The
    // order in `commands()` is the order of expected use.
    boost: 99 - index * 8,
    apply: (view: EditorView, _completion: Completion, from: number, to: number): void => {
      // `from` sits just after the slash, because that is what the typed text
      // is filtered against. The slash itself still has to go.
      const start = from - 1;
      view.dispatch({
        changes: { from: start, to, insert: text },
        selection: { anchor: start + (caret === -1 ? text.length : caret) },
        scrollIntoView: true,
        userEvent: 'input.complete',
      });
    },
  };
}

function slashSource(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const match = SLASH.exec(before);
  if (match === null) return null;

  const indent = match[1] ?? '';
  return {
    // One past the slash: CodeMirror filters on the text between `from` and the
    // cursor, and a leading slash would have to be part of every label.
    from: line.from + indent.length + 1,
    options: commands().map(toCompletion),
    validFor: /^\w*$/,
  };
}

export { slashSource };

/** Standalone form, for wiring the slash menu on its own. */
export function slashCommands() {
  return autocompletion({ override: [slashSource], icons: false });
}

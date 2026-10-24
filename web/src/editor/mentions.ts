/**
 * `@` to mention a person.
 *
 * In the file a mention is an ordinary Markdown link:
 *
 *     [@Julian Bach](ndbrain:user/acc_f01bbea2…)
 *
 * The link text is the name as it was when the mention was written, which is
 * what Obsidian, a diff or a file manager show. The target is the account's id,
 * because that is the one thing about an account that never changes: display
 * names and login names can both be edited, and a mention that keyed on either
 * would point at nobody — or at somebody else — after a rename. In the editor
 * the link is drawn as a chip with the person's *current* name, and the name in
 * the file is only the fallback for somebody this client knows nothing about.
 *
 * Who can be mentioned is who this client already knows: the people whose
 * notes are shared with it, the people it shares with, and — for an
 * administrator — every account. Nothing here asks the server for a list of
 * accounts it would not otherwise give out.
 */

import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { syntaxTree } from '@codemirror/language';
import { Facet, type EditorState } from '@codemirror/state';
import { WidgetType } from '@codemirror/view';
import type { SyntaxNode } from '@lezer/common';

import { copy } from '../copy';

export interface Person {
  /** The account id: what the mention links to. */
  id: string;
  /** What the mention says, and what the chip shows. */
  name: string;
  /** The person writing — offered too, marked as such. */
  self?: boolean;
}

/**
 * The people who can be mentioned, read through a getter for the same reason as
 * the tag registry: they arrive from the server after the editor is built.
 */
export const mentionContext = Facet.define<() => readonly Person[], () => readonly Person[]>({
  combine: (values) => values[0] ?? (() => []),
});

/** The scheme a mention links with. Not a web address, so nothing opens it. */
const SCHEME = 'ndbrain:user/';

/**
 * A mention, whole, as written in the file.
 *
 * The id is what ids are on the server (`assertUserId`): letters, digits,
 * `_` and `-`. The name may hold anything a link text can, escaped brackets
 * included.
 */
export const MENTION = /^\[@((?:\\.|[^\]\\])*)\]\(ndbrain:user\/([A-Za-z0-9_-]+)\)$/;

/**
 * An `@` being typed: at the start of a line or after a space or an opening
 * bracket, never inside a word. That keeps `julian@example.com` an address
 * rather than a menu that opens in the middle of it.
 */
const TYPING = /(?:^|[\s([{])@([^\s@[\]()]*)$/;

/** The Markdown for one mention. */
export function mentionLink(person: Pick<Person, 'id' | 'name'>): string {
  return `[@${escapeLinkText(person.name)}](${SCHEME}${person.id})`;
}

/** Brackets and backslashes in a name would end the link text early. */
function escapeLinkText(name: string): string {
  return name.replace(/[\\[\]]/g, (character) => `\\${character}`);
}

export function unescapeLinkText(text: string): string {
  return text.replace(/\\(.)/g, '$1');
}

/** Code is quoted text: an `@` there is a character, not a mention. */
function inCode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node !== null; node = node.parent) {
    if (/^(InlineCode|FencedCode|CodeBlock|CodeText)$/.test(node.name)) return true;
  }
  return false;
}

export function mentionSource(context: CompletionContext): CompletionResult | null {
  const match = context.matchBefore(TYPING);
  if (match === null) return null;

  // The match may begin with the space or bracket in front of the `@`; the
  // menu replaces from the `@` itself.
  const from = match.from + match.text.lastIndexOf('@');
  if (inCode(context.state, from)) return null;

  const people = context.state.facet(mentionContext)();
  if (people.length === 0) return null;

  const options: Completion[] = people.map((person) => ({
    label: `@${person.name}`,
    ...(person.self === true ? { detail: copy.editor.mention.self } : {}),
    apply: `${mentionLink(person)} `,
    // Yourself last: mentioning somebody else is the usual reason to type `@`.
    boost: person.self === true ? -1 : 0,
    type: 'mention',
  }));

  return {
    from,
    options,
    // Typing on narrows the same list; a space or a second `@` ends it.
    validFor: /^@[^\s@[\]()]*$/,
  };
}

/** The name to show for a mention: the person's current one if known. */
export function mentionName(people: readonly Person[], id: string, written: string): string {
  return people.find((person) => person.id === id)?.name ?? unescapeLinkText(written);
}

/** A mention in the prose, drawn as a chip. */
export class MentionWidget extends WidgetType {
  constructor(
    readonly name: string,
    readonly known: boolean,
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof MentionWidget && other.name === this.name && other.known === this.known;
  }

  override toDOM(): HTMLElement {
    const chip = document.createElement('span');
    chip.className = this.known ? 'cm-mention' : 'cm-mention is-unknown';
    chip.textContent = `@${this.name}`;
    chip.title = this.known ? copy.editor.mention.title(this.name) : copy.editor.mention.unknown;
    return chip;
  }

  /** A click puts the caret there and shows the link, like every other mark. */
  override ignoreEvent(): boolean {
    return false;
  }
}

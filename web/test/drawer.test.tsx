/**
 * The sidebar drawer on a phone, as a keyboard meets it.
 *
 * On a narrow window the sidebar stops being a landmark beside the page and
 * becomes a panel over it — and that is a dialog, whatever it is drawn like. It
 * was not one. It had no role, so nothing announced it; the focus stayed on
 * `body` where it was, so the first Tab went into the header behind the panel;
 * the main area was neither `inert` nor hidden, so the whole page was still in
 * the tab order under it; and Escape did nothing at all. The only way out with
 * a keyboard was to find the ✕ — six or more Tab stops away, because the drawer
 * holds the entire tree.
 *
 * `Menu.tsx` is the pattern this follows: focus in, focus back, Escape, and
 * nothing reachable behind it while it is open.
 *
 * Every test here sends the real key and looks at where the focus ended up or
 * whether the panel is gone. An `aria-modal` that traps nothing is exactly the
 * failure this is about, so the attribute is never the assertion.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { NoteRow, User } from '../src/api';
import { App } from '../src/App';
import { copy } from '../src/copy';

vi.mock('../src/Brain', () => ({ Brain: () => <canvas data-testid="brain" /> }));
vi.mock('../src/Editor', () => ({
  Editor: (props: { path: string }) => <div data-testid="editor">{props.path}</div>,
}));
vi.mock('../src/Context', () => ({ ContextPanel: () => <div /> }));

const server = vi.hoisted(() => ({
  signedIn: null as User | null,
  notes: [] as NoteRow[],
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  const fake: Record<string, (...args: never[]) => Promise<unknown>> = {
    me: async () => ({ user: server.signedIn }),
    tree: async () => ({ notes: server.notes, dirs: [] }),
    shares: async () => ({ granted: [], received: [] }),
    tags: async () => ({ tags: [] }),
    pulse: async () => ({ events: [], now: 1 }),
    propKeys: async () => ({ props: [] }),
    quickFind: async () => ({ notes: server.notes }),
    graph: async () => ({ nodes: [], edges: [] }),
    getNote: async (owner: string, path: string) => ({
      owner,
      canWrite: true,
      note: { path, title: path, content: '', size: 0, mtimeMs: 1 },
    }),
  };
  const api = new Proxy(fake, { get: (target, key: string) => target[key] ?? (() => new Promise(() => {})) });
  return { ...real, api };
});

function row(path: string): NoteRow {
  return { owner: 'julian', path, title: path.replace(/\.md$/, ''), size: 1, mtimeMs: 0 };
}

let user: ReturnType<typeof userEvent.setup>;

/** A window narrow enough that the sidebar is a drawer; see DRAWER_QUERY. */
function narrow(is: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('max-width') ? is : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

beforeEach(() => {
  user = userEvent.setup();
  window.localStorage.clear();
  Element.prototype.scrollIntoView = () => {};
  narrow(true);
  server.signedIn = { id: 'julian', displayName: 'Julian', role: 'user' };
  server.notes = [row('Plan.md'), row('Index.md')];
});

afterEach(() => {
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

function mount(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

/** Opens the drawer the way a thumb does, and answers with it. */
async function openDrawer(): Promise<HTMLElement> {
  const menu = await screen.findByRole('button', { name: copy.nav.menu });
  await user.click(menu);
  return screen.findByRole('dialog', { name: copy.nav.label });
}

describe('the drawer on a narrow window', () => {
  it('is a dialog, so something announces it', async () => {
    mount();
    const drawer = await openDrawer();
    expect(drawer).toHaveAttribute('aria-modal', 'true');
  });

  it('puts the focus inside itself instead of leaving it on the body', async () => {
    mount();
    const drawer = await openDrawer();

    expect(document.activeElement).not.toBe(document.body);
    expect(drawer.contains(document.activeElement)).toBe(true);
  });

  it('closes on Escape and hands the focus back to the button that opened it', async () => {
    mount();
    await openDrawer();
    const menu = screen.getByRole('button', { name: copy.nav.menu });

    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('dialog', { name: copy.nav.label })).toBeNull());
    expect(document.activeElement).toBe(menu);
  });

  it('closes on the ✕ and hands the focus back too', async () => {
    mount();
    const drawer = await openDrawer();
    const menu = screen.getByRole('button', { name: copy.nav.menu });

    await user.click(within(drawer).getByRole('button', { name: copy.nav.closeMenu }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: copy.nav.label })).toBeNull());
    expect(document.activeElement).toBe(menu);
  });

  it('keeps Tab inside itself, however far it is walked', async () => {
    mount();
    const drawer = await openDrawer();

    // Further than the drawer has stops, so the wrap is walked over more than
    // once — the failure was that six stops in, the focus was in the header
    // behind the panel.
    for (let press = 0; press < 40; press += 1) {
      await user.tab();
      expect(drawer.contains(document.activeElement), `after ${press + 1} tabs`).toBe(true);
    }
  });

  it('keeps Shift+Tab inside itself as well', async () => {
    mount();
    const drawer = await openDrawer();

    for (let press = 0; press < 40; press += 1) {
      await user.tab({ shift: true });
      expect(drawer.contains(document.activeElement), `after ${press + 1} back-tabs`).toBe(true);
    }
  });

  /*
   * The shell re-renders constantly while the drawer is open — a poll answers,
   * a filter is typed, a query settles. None of that reopened the drawer, so
   * none of it may move the focus: a hook that re-runs its effect on every
   * render hands the focus back to whatever opened the panel and then puts it
   * on the panel again, which makes typing inside the drawer impossible.
   */
  it('leaves the focus alone while the shell re-renders under it', async () => {
    mount();
    const drawer = await openDrawer();
    const filter = within(drawer).getByLabelText(copy.nav.filterLabel);

    // Typing in the filter is App state, so each key re-renders the whole shell
    // and the drawer with it.
    await user.click(filter);
    await user.keyboard('plan');

    expect(document.activeElement).toBe(filter);
    expect(filter).toHaveValue('plan');
  });

  /*
   * The trap above is what actually holds a keyboard; `inert` is what tells a
   * screen reader and a real browser's own focus order the same thing. jsdom
   * implements neither, so this one can only be the attribute — which is why
   * it is not the test that stands for "you cannot get out".
   */
  it('takes the page behind it out of reach while it is open', async () => {
    mount();
    await openDrawer();
    const work = document.querySelector('.work')!;
    expect(work).toHaveAttribute('inert');

    await user.keyboard('{Escape}');
    await waitFor(() => expect(work).not.toHaveAttribute('inert'));
  });
});

describe('the sidebar on a wide window', () => {
  it('is a landmark rather than a dialog, and Escape means nothing to it', async () => {
    narrow(false);
    mount();
    await screen.findByRole('button', { name: copy.shell.account });

    const nav = screen.getByRole('navigation', { name: copy.nav.label });
    expect(screen.queryByRole('dialog', { name: copy.nav.label })).toBeNull();

    // Nothing to close, and nothing that may swallow the key from the rest of
    // the shell: the palette and the dialogs want Escape too.
    within(nav).getByLabelText(copy.nav.filterLabel).focus();
    await user.keyboard('{Escape}');
    expect(screen.getByRole('navigation', { name: copy.nav.label })).toBe(nav);
  });
});

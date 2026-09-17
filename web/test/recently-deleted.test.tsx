/**
 * Recently deleted, at the end of Tidy up.
 *
 * What the server decided is shown and nothing is invented: a row that can be
 * restored asks first and says shares do not come back; a row that cannot
 * keeps its button, disabled, with the reason beside it.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeletedNote } from '../src/api';
import { copy } from '../src/copy';
import { OwnersContext } from '../src/owners';
import { RecentlyDeleted } from '../src/RecentlyDeleted';

const server = vi.hoisted(() => ({
  notes: [] as DeletedNote[],
  restored: [] as Array<[string, string]>,
  /** The path the server answers a restore with. */
  restoredAs: null as string | null,
}));

vi.mock('../src/api', async (original) => {
  const real = await original<typeof import('../src/api')>();
  return {
    ...real,
    api: {
      ...real.api,
      deleted: async () => ({ notes: server.notes }),
      restoreDeleted: async (owner: string, path: string) => {
        server.restored.push([owner, path]);
        const at = server.restoredAs ?? path;
        server.notes = server.notes.filter((row) => !(row.owner === owner && row.path === path));
        return {
          note: { path: at, title: 'x', content: '', size: 0, mtimeMs: 0 },
          samePath: at === path,
        };
      },
    },
  };
});

function deleted(overrides: Partial<DeletedNote> = {}): DeletedNote {
  return {
    owner: 'julian',
    path: 'Projekt/Plan.md',
    title: 'Plan',
    folder: 'Projekt',
    actor: 'julian',
    at: Date.now() - 60_000,
    restore: 'ready',
    savedAt: Date.now() - 120_000,
    ...overrides,
  };
}

let confirm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  server.notes = [];
  server.restored = [];
  server.restoredAs = null;
  confirm = vi.fn(() => true);
  vi.stubGlobal('confirm', confirm);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function mount(onOpen = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <OwnersContext.Provider
        value={new Map([
          ['julian', { id: 'julian', kind: 'person' as const, displayName: 'Julian' }],
          ['familie', { id: 'familie', kind: 'space' as const, displayName: 'Familie' }],
        ])}
      >
        <RecentlyDeleted self="julian" onOpen={onOpen} />
      </OwnersContext.Provider>
    </QueryClientProvider>,
  );
  return onOpen;
}

function rowOf(title: string): HTMLElement {
  const cell = screen.getByText(title, { selector: 'td' });
  return cell.closest('tr') as HTMLElement;
}

describe('the list', () => {
  it('names the note, its folder with the space it was in, when and by whom it was deleted', async () => {
    server.notes = [
      deleted(),
      deleted({ owner: 'familie', path: 'Ferien/Packliste.md', title: 'Packliste', folder: 'Ferien', actor: 'ramona' }),
    ];
    mount();

    await screen.findByText('Plan', { selector: 'td' });
    const plan = rowOf('Plan');
    expect(within(plan).getByText('Projekt')).toBeInTheDocument();
    expect(plan).toHaveTextContent('by julian');

    const packliste = rowOf('Packliste');
    expect(within(packliste).getByText('Familie · Ferien')).toBeInTheDocument();
    expect(packliste).toHaveTextContent('by ramona');
  });

  it('says so when nothing was deleted', async () => {
    mount();
    expect(await screen.findByText(copy.deleted.empty)).toBeInTheDocument();
  });
});

describe('restoring', () => {
  it('asks first, saying shares do not come back, then restores and offers to open the note', async () => {
    const user = userEvent.setup();
    server.notes = [deleted()];
    const onOpen = mount();

    await user.click(await screen.findByRole('button', { name: copy.deleted.restoreNamed('Plan') }));

    expect(confirm).toHaveBeenCalledWith(copy.deleted.confirm('Plan'));
    expect(copy.deleted.confirm('Plan')).toMatch(/Shares it had do not come back/);
    await waitFor(() => expect(server.restored).toEqual([['julian', 'Projekt/Plan.md']]));
    expect(await screen.findByRole('status')).toHaveTextContent(copy.deleted.restored('Plan'));

    await user.click(screen.getByRole('button', { name: copy.deleted.open }));
    expect(onOpen).toHaveBeenCalledWith('julian', 'Projekt/Plan.md');
  });

  it('restores nothing when the question is cancelled', async () => {
    const user = userEvent.setup();
    confirm.mockReturnValue(false);
    server.notes = [deleted()];
    mount();

    await user.click(await screen.findByRole('button', { name: copy.deleted.restoreNamed('Plan') }));
    expect(server.restored).toEqual([]);
  });

  it('says where the note came back when its old place was taken', async () => {
    const user = userEvent.setup();
    server.notes = [deleted()];
    server.restoredAs = 'Projekt/Plan (wiederhergestellt 2026-09-17).md';
    const onOpen = mount();

    await user.click(await screen.findByRole('button', { name: copy.deleted.restoreNamed('Plan') }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      copy.deleted.restoredElsewhere('Plan', 'Projekt/Plan (wiederhergestellt 2026-09-17).md'),
    );
    await user.click(screen.getByRole('button', { name: copy.deleted.open }));
    expect(onOpen).toHaveBeenCalledWith('julian', 'Projekt/Plan (wiederhergestellt 2026-09-17).md');
  });
});

describe('a note that cannot be restored', () => {
  it.each([
    ['no-history', copy.deleted.why['no-history']],
    ['no-commit', copy.deleted.why['no-commit']],
    ['no-version', copy.deleted.why['no-version']],
  ] as const)('keeps its button disabled and says why (%s)', async (restore, why) => {
    const user = userEvent.setup();
    server.notes = [deleted({ restore, savedAt: null })];
    mount();

    const button = await screen.findByRole('button', { name: copy.deleted.restoreNamed('Plan') });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(why);
    expect(screen.getByText(why)).toBeVisible();
    await user.click(button);
    expect(confirm).not.toHaveBeenCalled();
    expect(server.restored).toEqual([]);
  });
});

describe('the delete question', () => {
  it('counts what a bulk delete can and cannot bring back', () => {
    expect(copy.ask.afterDelete({ restorable: 3, unsaved: 0, notYours: 0, history: true })).toBe(
      'Their last saved versions can be restored from Tidy up for 30 days.',
    );
    expect(copy.ask.afterDelete({ restorable: 2, unsaved: 1, notYours: 0, history: true })).toBe(
      '2 can be restored from Tidy up for 30 days, 1 cannot.',
    );
    expect(copy.ask.afterDelete({ restorable: 0, unsaved: 4, notYours: 0, history: false })).toBe(
      'This server keeps no history, so they cannot be restored.',
    );
    expect(copy.ask.afterDelete(null)).toBe('');
  });
});

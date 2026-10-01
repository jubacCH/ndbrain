/**
 * Admin → agent keys, and when they run out.
 *
 * The server refusing an expired key is only half of an expiry; the other half
 * is that somebody sees it coming. A key that dies overnight with nothing said
 * is an agent getting a 401 in the morning for no visible reason, so this pins
 * that the table says *how long is left* rather than only a date, and that it
 * says it loudly exactly while there is still something to do about it.
 *
 * It also pins the form's default. "Until revoked" is one option among four and
 * not the preselected one: the key nobody renews is the key that outlives
 * whatever it was made for.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminView, type AdminProps } from '../src/Admin';
import { copy } from '../src/copy';
import type { AdminUser, ApiKey } from '../src/api';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 5, 15, 12);

const USERS: AdminUser[] = [
  { id: 'julian', guid: 'acc_julianjulianjulianjulianjulianju', loginName: 'julian', displayName: 'Julian', role: 'admin', disabled: false, createdAt: 0, notes: 10 },
];

function key(name: string, expiresAt: number | null, revoked = false): ApiKey {
  return {
    id: `key_${name}`,
    owner: 'verein',
    name,
    scope: '',
    canWrite: false,
    createdAt: 0,
    lastUsedAt: null,
    expiresAt,
    revoked,
  };
}

function renderAdmin(keys: ApiKey[], onCreateKey = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = {
    users: USERS,
    keys,
    self: 'julian',
    busy: false,
    onCreateUser: vi.fn(async () => undefined),
    onResetPassword: vi.fn(async () => undefined),
    onSetDisabled: vi.fn(async () => undefined),
    onRenameUser: vi.fn(async () => undefined),
    onCreateKey,
    onRevokeKey: vi.fn(async () => undefined),
    onPickOwner: vi.fn(),
    // A space, because the key section is a space's now: somebody's own agent
    // keys are theirs and are not listed on this screen.
    keyOwner: 'verein',
    spaces: {
      spaces: [{ id: 'verein', displayName: 'Verein', disabled: false, noteCount: 0, members: 0 }],
      onCreate: vi.fn(async () => undefined),
      onRename: vi.fn(async () => undefined),
      onSetDisabled: vi.fn(async () => undefined),
      onAddMember: vi.fn(async () => undefined),
      onRemoveMember: vi.fn(async () => undefined),
    },
  } as AdminProps;

  render(
    <QueryClientProvider client={client}>
      <AdminView {...props} />
    </QueryClientProvider>,
  );
  return { onCreateKey };
}

/** The `Expires` cell of the row whose name matches. */
function expiryCell(name: string): HTMLElement {
  const row = screen.getByText(name).closest('tr');
  expect(row).not.toBeNull();
  const cells = within(row as HTMLElement).getAllByRole('cell');
  return cells[2] as HTMLElement;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('when a key runs out', () => {
  it('shows a date while there is nothing to do yet', () => {
    renderAdmin([key('ruhig', NOW + 200 * DAY)]);
    const cell = expiryCell('ruhig');

    expect(cell).not.toHaveTextContent(copy.admin.expired);
    // Quiet: a deadline eight months out is information, not a warning.
    expect(cell.querySelector('.pill')).toBeNull();
    expect(cell.textContent).not.toBe('');
  });

  it('counts the days down once it is close, and says so loudly', () => {
    renderAdmin([key('bald', NOW + 3 * DAY)]);
    const cell = expiryCell('bald');

    // In days, not as a date: a date needs arithmetic before anybody knows
    // whether to act on it, which is how the deadline gets missed.
    expect(cell).toHaveTextContent(copy.admin.expiresIn(3));
    expect(cell.querySelector('.pill.p-warn')).not.toBeNull();
  });

  it('says plainly that one has already gone', () => {
    renderAdmin([key('vorbei', NOW - DAY)]);
    const cell = expiryCell('vorbei');

    expect(cell).toHaveTextContent(copy.admin.expired);
    expect(cell.querySelector('.pill.p-crit')).not.toBeNull();
  });

  it('says so, quietly, where there is no deadline at all', () => {
    // The four keys that predate expiry look like this, and so does the key for
    // a monthly job. Neither is a warning.
    renderAdmin([key('unbefristet', null)]);
    const cell = expiryCell('unbefristet');

    expect(cell).toHaveTextContent(copy.admin.noExpiry);
    expect(cell.querySelector('.pill')).toBeNull();
  });

  it('does not dress up the deadline of a key that is already revoked', () => {
    renderAdmin([key('widerrufen', NOW + DAY, true)]);
    const cell = expiryCell('widerrufen');

    expect(cell.querySelector('.pill')).toBeNull();
  });
});

describe('the lifetime a new key is given', () => {
  it('is a year unless somebody says otherwise', async () => {
    const { onCreateKey } = renderAdmin([], vi.fn(async () => ({ ...key('x', null), secret: 's' })));

    await userEvent.type(screen.getByLabelText(copy.admin.keyName), 'Claude');
    await userEvent.click(screen.getByRole('button', { name: copy.admin.createKey }));

    expect(onCreateKey).toHaveBeenCalledWith('verein', 'Claude', '', false, 365);
  });

  it('can be told to last until revoked, which has to be chosen', async () => {
    const { onCreateKey } = renderAdmin([], vi.fn(async () => ({ ...key('x', null), secret: 's' })));

    await userEvent.type(screen.getByLabelText(copy.admin.keyName), 'Monatslauf');
    await userEvent.selectOptions(
      screen.getByLabelText(copy.admin.lifetime),
      copy.admin.lifetimeForever,
    );
    await userEvent.click(screen.getByRole('button', { name: copy.admin.createKey }));

    expect(onCreateKey).toHaveBeenCalledWith('verein', 'Monatslauf', '', false, null);
  });
});

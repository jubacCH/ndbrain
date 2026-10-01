/**
 * Renaming an account from the administrator's screen.
 *
 * A space could be renamed and a person could not, which is the wrong way
 * round: a space is named once by whoever makes it, and a person is the one
 * whose name turns out to be spelled wrong, or who marries, or who was created
 * in a hurry as "neu". Everybody could already change their own display name;
 * nobody could change anybody else's.
 *
 * What these hold on to is the line it must not cross. The sign-in name is the
 * folder the vault lives in, so it is the one thing on this screen that cannot
 * be edited, and a control that looked as though it could would be a promise
 * the server refuses.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AdminView, type AdminProps } from '../src/Admin';
import { copy } from '../src/copy';
import type { AdminUser } from '../src/api';

const USERS: AdminUser[] = [
  { id: 'acc_julianjulianjulianjulianjulianju', loginName: 'julian', displayName: 'Julian', role: 'admin', disabled: false, createdAt: 0, notes: 10 },
  { id: 'acc_ramonaramonaramonaramonaramonara', loginName: 'ramona', displayName: 'Ramona', role: 'user', disabled: false, createdAt: 0, notes: 3 },
];

function renderAdmin(over: Partial<AdminProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onRenameUser = vi.fn(async () => undefined);
  const props = {
    users: USERS,
    keys: [],
    // The signed-in account's identifier, which is what the shell passes
    // (`self={user.id}`). The guard that keeps somebody from disabling their
    // own account compares against it, so a login here would make that guard
    // silently stop matching — which is what this fixture was doing.
    self: USERS[0]!.id,
    busy: false,
    onCreateUser: vi.fn(async () => undefined),
    onResetPassword: vi.fn(async () => undefined),
    onSetDisabled: vi.fn(async () => undefined),
    onRenameUser,
    onCreateKey: vi.fn(),
    onRevokeKey: vi.fn(async () => undefined),
    onPickOwner: vi.fn(),
    keyOwner: 'julian',
    spaces: {
      spaces: [],
      onCreate: vi.fn(async () => undefined),
      onRename: vi.fn(async () => undefined),
      onSetDisabled: vi.fn(async () => undefined),
      onAddMember: vi.fn(async () => undefined),
      onRemoveMember: vi.fn(async () => undefined),
    },
    ...over,
  } as unknown as AdminProps;

  render(
    <QueryClientProvider client={client}>
      <AdminView {...props} />
    </QueryClientProvider>,
  );
  return { onRenameUser };
}

/**
 * One account's row, found by its sign-in name.
 *
 * By the id and not the display name, because the display name is the thing
 * under test: once the form is open it is a field rather than text, and a
 * helper that looked for it would stop finding the row exactly when the test
 * needs it most.
 */
const rowOf = (id: string): HTMLElement => screen.getByText(id).closest('tr') as HTMLElement;

async function openRename(id: string): Promise<HTMLElement> {
  const row = rowOf(id);
  await userEvent.click(within(row).getByRole('button', { name: copy.admin.rename }));
  return row;
}

describe('the control', () => {
  it('starts from the name the account has, not from nothing', async () => {
    renderAdmin();
    const row = await openRename('ramona');
    expect(within(row).getByLabelText(copy.admin.newNameFor('ramona'))).toHaveValue('Ramona');
  });

  it('offers nothing to save until the name is actually different', async () => {
    renderAdmin();
    const row = await openRename('ramona');
    const save = within(row).getByRole('button', { name: copy.admin.saveName });
    expect(save).toBeDisabled();

    await userEvent.type(within(row).getByLabelText(copy.admin.newNameFor('ramona')), ' Bachmann');
    expect(save).toBeEnabled();
  });

  it('sends the trimmed name and closes', async () => {
    const { onRenameUser } = renderAdmin();
    const row = await openRename('ramona');

    const field = within(row).getByLabelText(copy.admin.newNameFor('ramona'));
    await userEvent.clear(field);
    await userEvent.type(field, '  Ramona Bachmann  ');
    await userEvent.click(within(row).getByRole('button', { name: copy.admin.saveName }));

    // Only what changed: a request that resends an unchanged login can be
    // refused on the uniqueness of the name it already has.
    expect(onRenameUser).toHaveBeenCalledWith(USERS[1]!.id, { displayName: 'Ramona Bachmann' });
    expect(within(rowOf('ramona')).queryByRole('button', { name: copy.admin.saveName })).toBeNull();
  });

  /**
   * The point of the whole arrangement: this is the name somebody types, and
   * changing it writes one row. The id underneath is the vault's directory and
   * the key every share, session and agent key hangs off, so it does not move.
   */
  it('changes the sign-in name, and says so separately from the display name', async () => {
    const { onRenameUser } = renderAdmin();
    const row = await openRename('ramona');

    const login = within(row).getByLabelText(copy.admin.newLoginFor('ramona'));
    await userEvent.clear(login);
    await userEvent.type(login, 'ramona-b');
    await userEvent.click(within(row).getByRole('button', { name: copy.admin.saveName }));

    expect(onRenameUser).toHaveBeenCalledWith(USERS[1]!.id, { loginName: 'ramona-b' });
  });

  it('sends both when both were changed', async () => {
    const { onRenameUser } = renderAdmin();
    const row = await openRename('ramona');

    await userEvent.type(within(row).getByLabelText(copy.admin.newNameFor('ramona')), ' B.');
    await userEvent.type(within(row).getByLabelText(copy.admin.newLoginFor('ramona')), '-b');
    await userEvent.click(within(row).getByRole('button', { name: copy.admin.saveName }));

    expect(onRenameUser).toHaveBeenCalledWith(USERS[1]!.id, {
      displayName: 'Ramona B.',
      loginName: 'ramona-b',
    });
  });

  /*
   * Gone with the design it described.
   *
   * There was an hour in which the id stayed the readable name and only the
   * login moved, so the two could come apart and the folder on disk kept the
   * old one — and this screen said so. The id is the identifier and the folder
   * again, drawn at random and never equal to a name, so there is nothing left
   * to come apart from. The test is removed rather than reworded because the
   * behaviour is gone, not because it became inconvenient.
   */

  it('sends nothing on a cancel', async () => {
    const { onRenameUser } = renderAdmin();
    const row = await openRename('ramona');

    await userEvent.type(within(row).getByLabelText(copy.admin.newNameFor('ramona')), 'x');
    await userEvent.click(within(row).getByRole('button', { name: copy.admin.cancel }));

    expect(onRenameUser).not.toHaveBeenCalled();
  });

  /**
   * A draft left over from a cancelled edit would be a rename nobody meant to
   * make, waiting behind a button somebody presses for a different reason.
   */
  it('forgets a cancelled edit when it is opened again', async () => {
    renderAdmin();
    const row = await openRename('ramona');
    await userEvent.type(within(row).getByLabelText(copy.admin.newNameFor('ramona')), 'xyz');
    await userEvent.click(within(row).getByRole('button', { name: copy.admin.cancel }));

    const again = await openRename('ramona');
    expect(within(again).getByLabelText(copy.admin.newNameFor('ramona'))).toHaveValue('Ramona');
  });
});

describe('the identifier', () => {
  /**
   * The thing that makes renaming free: every name on this row can change, and
   * this one cannot. It is on the administrator's screen and on no other.
   */
  it('is shown beside the account, and is not one of the names', async () => {
    renderAdmin();
    const row = rowOf('ramona');
    const guid = USERS[1]!.id;

    expect(within(row).getByText(guid)).toBeInTheDocument();

    await openRename('ramona');
    const fields = within(rowOf('ramona')).getAllByRole('textbox');
    for (const field of fields) expect(field).not.toHaveValue(guid);
  });
});

describe('what it does not touch', () => {
  /**
   * The id is the vault's folder on disk. Offering it here would be a field
   * whose save is refused, which is worse than not offering it.
   */
  /**
   * Two fields, and the id is neither of them.
   *
   * The id is the vault's directory name and the key every foreign key hangs
   * off, in a schema with no `ON UPDATE CASCADE`. Offering it here would be a
   * field whose save is a migration.
   */
  it('offers the display name and the login, and no way to edit the id', async () => {
    renderAdmin();
    const row = await openRename('ramona');

    const fields = within(row).getAllByRole('textbox');
    expect(fields.map((field) => field.getAttribute('aria-label'))).toEqual([
      copy.admin.newNameFor('ramona'),
      copy.admin.newLoginFor('ramona'),
    ]);
  });

  it('is offered on the administrator’s own row too, unlike disabling', async () => {
    renderAdmin();
    const own = rowOf('julian');

    expect(within(own).getByRole('button', { name: copy.admin.rename })).toBeInTheDocument();
    // Disabling yourself is the one that would lock everybody out.
    expect(within(own).queryByRole('button', { name: copy.admin.disable })).toBeNull();
  });
});

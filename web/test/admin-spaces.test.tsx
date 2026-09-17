/**
 * Admin → Spaces.
 *
 * The screen where a space is born, named and given members. What is pinned
 * here is what an administrator must be able to rely on: the naming rule and
 * the fact that the account name is for good are said before submitting; a
 * member's extent is picked from the space's own tree; and a key can be made
 * for a space from the same key form as for a person.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminView, type AdminProps } from '../src/Admin';
import { spaceNameProblem } from '../src/AdminSpaces';
import { api, type AdminSpace, type AdminUser, type Share } from '../src/api';
import { copy } from '../src/copy';

const USERS: AdminUser[] = [
  { id: 'julian', displayName: 'Julian', role: 'admin', disabled: false, createdAt: 0, notes: 10, keys: 1 },
  { id: 'anna', displayName: 'Anna', role: 'user', disabled: false, createdAt: 0, notes: 3, keys: 0 },
  { id: 'otto', displayName: 'Otto', role: 'user', disabled: true, createdAt: 0, notes: 0, keys: 0 },
];

const SPACES: AdminSpace[] = [
  { id: 'familie', displayName: 'Familie', disabled: false, noteCount: 12, members: 3 },
  { id: 'verein', displayName: 'Verein', disabled: true, noteCount: 0, members: 0 },
];

const MEMBERS: Share[] = [
  { id: 'm1', owner: 'familie', prefix: '', grantee: 'anna', canWrite: true, createdAt: 0, kind: 'vault' },
  { id: 'm2', owner: 'familie', prefix: 'Rezepte/', grantee: 'otto', canWrite: false, createdAt: 0, kind: 'folder' },
  { id: 'm3', owner: 'familie', prefix: 'Ferien/Plan.md', grantee: 'julian', canWrite: false, createdAt: 0, kind: 'note' },
];

/** The space's own tree, as the admin-only route answers it: paths and titles. */
const TREE = {
  dirs: ['Ferien', 'Rezepte'],
  notes: [
    { path: 'Ferien/Plan.md', title: 'Plan' },
    { path: 'Rezepte/Zopf.md', title: 'Zopf' },
  ],
};

function renderAdmin(overrides: Partial<AdminProps['spaces']> = {}, props: Partial<AdminProps> = {}) {
  const spaces = {
    spaces: SPACES,
    onCreate: vi.fn(async () => undefined),
    onRename: vi.fn(async () => undefined),
    onSetDisabled: vi.fn(async () => undefined),
    onAddMember: vi.fn(async () => undefined),
    onRemoveMember: vi.fn(async () => undefined),
    ...overrides,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const all = {
    users: USERS,
    keys: [],
    self: 'julian',
    busy: false,
    onCreateUser: vi.fn(async () => undefined),
    onResetPassword: vi.fn(async () => undefined),
    onSetDisabled: vi.fn(async () => undefined),
    onCreateKey: vi.fn(),
    onRevokeKey: vi.fn(async () => undefined),
    onPickOwner: vi.fn(),
    keyOwner: 'julian',
    spaces,
    ...props,
  } as AdminProps;
  render(
    <QueryClientProvider client={client}>
      <AdminView {...all} />
    </QueryClientProvider>,
  );
  return { spaces, props: all, section: screen.getByRole('region', { name: copy.spaces.title }) };
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.spyOn(api, 'spaceMembers').mockResolvedValue(MEMBERS);
  vi.spyOn(api, 'spaceTree').mockResolvedValue(TREE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the list of spaces', () => {
  it('shows each space with its name, notes, members and whether it is disabled', () => {
    const { section } = renderAdmin();
    const rows = within(section).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Familie');
    expect(rows[0]).toHaveTextContent('familie');
    expect(within(rows[0]!).getAllByRole('cell')[1]).toHaveTextContent('12');
    expect(within(rows[0]!).getAllByRole('cell')[2]).toHaveTextContent('3');
    expect(rows[0]).not.toHaveTextContent(copy.admin.disabled);
    expect(rows[1]).toHaveTextContent(copy.admin.disabled);
  });

  it('renames by display name only', async () => {
    const { section, spaces } = renderAdmin();
    await userEvent.click(within(section).getByRole('button', { name: copy.spaces.renameLabel('Familie') }));
    const field = within(section).getByLabelText(copy.spaces.displayNameFor('familie'));
    await userEvent.clear(field);
    await userEvent.type(field, 'Familie Bachmann');
    await userEvent.click(within(section).getByRole('button', { name: copy.admin.set }));
    expect(spaces.onRename).toHaveBeenCalledWith('familie', 'Familie Bachmann');
  });

  it('disables after asking, and enables without', async () => {
    const { section, spaces } = renderAdmin();
    await userEvent.click(within(section).getByRole('button', { name: copy.spaces.disableLabel('Familie') }));
    expect(window.confirm).toHaveBeenCalledWith(copy.spaces.confirmDisable('Familie'));
    expect(spaces.onSetDisabled).toHaveBeenCalledWith('familie', true);

    vi.mocked(window.confirm).mockClear();
    await userEvent.click(within(section).getByRole('button', { name: copy.spaces.enableLabel('Verein') }));
    expect(window.confirm).not.toHaveBeenCalled();
    expect(spaces.onSetDisabled).toHaveBeenCalledWith('verein', false);
  });

  it('does not disable when the question is declined', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const { section, spaces } = renderAdmin();
    await userEvent.click(within(section).getByRole('button', { name: copy.spaces.disableLabel('Familie') }));
    expect(spaces.onSetDisabled).not.toHaveBeenCalled();
  });

  it('keeps spaces out of the accounts table, even if the server lists them there', () => {
    renderAdmin({}, { users: [...USERS, { ...USERS[1]!, id: 'familie', displayName: 'Familie' }] });
    const accounts = screen.getByRole('heading', { name: copy.admin.accounts }).parentElement!;
    const table = within(accounts).getAllByRole('table')[0]!;
    expect(within(table).queryByText('familie')).toBeNull();
  });
});

describe('creating a space', () => {
  it('explains the naming rule and that the account name is permanent before anything is typed', () => {
    const { section } = renderAdmin();
    const form = within(section).getByRole('heading', { name: copy.spaces.newSpace }).closest('form')!;
    expect(within(form).getByText(copy.spaces.nameRule)).toBeInTheDocument();
    expect(within(form).getByText(copy.spaces.idIsPermanent)).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: copy.spaces.create })).toBeDisabled();
  });

  it('refuses a name against the rule, or one a person or space already has', async () => {
    const { section } = renderAdmin();
    const field = within(section).getByLabelText(copy.spaces.accountName);
    const submit = within(section).getByRole('button', { name: copy.spaces.create });

    await userEvent.type(field, 'Meine Familie');
    expect(within(section).getByRole('alert')).toHaveTextContent(copy.spaces.nameInvalid);
    expect(submit).toBeDisabled();

    await userEvent.clear(field);
    await userEvent.type(field, 'Anna');
    expect(within(section).getByRole('alert')).toHaveTextContent(copy.spaces.nameTaken('Anna'));
    expect(submit).toBeDisabled();
  });

  it('creates with account name and display name', async () => {
    const { section, spaces } = renderAdmin();
    await userEvent.type(within(section).getByLabelText(copy.spaces.accountName), 'garten');
    await userEvent.type(within(section).getByLabelText(copy.admin.displayName), 'Schrebergarten');
    await userEvent.click(within(section).getByRole('button', { name: copy.spaces.create }));
    expect(spaces.onCreate).toHaveBeenCalledWith('garten', 'Schrebergarten');
  });

  it('pins the rule to the server’s account names', () => {
    const taken = new Set(['anna']);
    expect(spaceNameProblem('familie', taken)).toBeNull();
    expect(spaceNameProblem('verein_2026-a', taken)).toBeNull();
    expect(spaceNameProblem('-verein', taken)).toBe(copy.spaces.nameInvalid);
    expect(spaceNameProblem('a/b', taken)).toBe(copy.spaces.nameInvalid);
    expect(spaceNameProblem('x'.repeat(65), taken)).toBe(copy.spaces.nameInvalid);
    expect(spaceNameProblem('ANNA', taken)).toBe(copy.spaces.nameTaken('ANNA'));
  });
});

describe('members of a space', () => {
  async function manage() {
    const rendered = renderAdmin();
    await userEvent.click(within(rendered.section).getByRole('button', { name: copy.spaces.manageLabel('Familie') }));
    const panel = await screen.findByRole('region', { name: copy.spaces.membersOf('Familie') });
    return { ...rendered, panel };
  }

  it('lists who has what, with the extent’s icon and word, and the right', async () => {
    const { panel } = await manage();
    expect(api.spaceMembers).toHaveBeenCalledWith('familie');
    const rows = (await within(panel).findAllByRole('row')).slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent(`anna${copy.spaces.extent.vault}`);
    expect(rows[0]).toHaveTextContent(copy.shares.readWrite);
    expect(rows[1]).toHaveTextContent(`${copy.spaces.extent.folder}Rezepte/`);
    expect(rows[2]).toHaveTextContent(`${copy.spaces.extent.note}Ferien/Plan.md`);
    expect(rows[2]!.querySelector('[data-kind="note"] svg')).not.toBeNull();
  });

  it('adds a person to a single note picked from the space’s tree', async () => {
    const { panel, spaces } = await manage();
    const form = within(panel).getByRole('heading', { name: copy.spaces.addMember }).closest('form')!;

    // Disabled people are not offered.
    expect(within(form).queryByRole('option', { name: /Otto/ })).toBeNull();
    await userEvent.selectOptions(within(form).getByLabelText(copy.shareNote.person), 'anna');
    await userEvent.click(within(form).getByLabelText(copy.spaces.extent.note));
    const picker = await within(form).findByLabelText(copy.spaces.pickNote);
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      copy.spaces.choose,
      'Ferien/Plan.md',
      'Rezepte/Zopf.md',
    ]);
    await userEvent.selectOptions(picker, 'Rezepte/Zopf.md');
    await userEvent.click(within(form).getByLabelText(copy.shareNote.write));
    await userEvent.click(within(form).getByRole('button', { name: copy.spaces.add }));

    expect(spaces.onAddMember).toHaveBeenCalledWith('familie', 'anna', 'note', 'Rezepte/Zopf.md', true);
  });

  it('adds a folder, or the whole space with no path at all', async () => {
    const { panel, spaces } = await manage();
    const form = within(panel).getByRole('heading', { name: copy.spaces.addMember }).closest('form')!;

    await userEvent.selectOptions(within(form).getByLabelText(copy.shareNote.person), 'anna');
    await userEvent.click(within(form).getByLabelText(copy.spaces.extent.folder));
    await userEvent.selectOptions(await within(form).findByLabelText(copy.spaces.pickFolder), 'Rezepte');
    await userEvent.click(within(form).getByRole('button', { name: copy.spaces.add }));
    expect(spaces.onAddMember).toHaveBeenLastCalledWith('familie', 'anna', 'folder', 'Rezepte', false);

    await waitFor(() => expect(within(form).getByLabelText(copy.shareNote.person)).toHaveValue(''));
    await userEvent.selectOptions(within(form).getByLabelText(copy.shareNote.person), 'julian');
    await userEvent.click(within(form).getByLabelText(copy.spaces.extent.vault));
    await userEvent.click(within(form).getByRole('button', { name: copy.spaces.add }));
    expect(spaces.onAddMember).toHaveBeenLastCalledWith('familie', 'julian', 'vault', '', false);
  });

  it('picks from the space’s own tree, which an administrator gets without being a member', async () => {
    vi.mocked(api.spaceTree).mockResolvedValue({
      // An empty folder the notes do not name, and a folder only a note's path names.
      dirs: ['Leer'],
      notes: [
        { path: 'Rezepte/Brot/Zopf.md', title: 'Zopf' },
        { path: 'Budget.md', title: 'Budget' },
      ],
    });
    const { panel } = await manage();
    expect(api.spaceTree).toHaveBeenCalledWith('familie');
    const form = within(panel).getByRole('heading', { name: copy.spaces.addMember }).closest('form')!;

    await userEvent.click(within(form).getByLabelText(copy.spaces.extent.folder));
    const folders = await within(form).findByLabelText(copy.spaces.pickFolder);
    expect(within(folders).getAllByRole('option').map((o) => o.textContent)).toEqual([
      copy.spaces.choose,
      'Leer',
      'Rezepte',
      'Rezepte/Brot',
    ]);

    await userEvent.click(within(form).getByLabelText(copy.spaces.extent.note));
    const notes = within(form).getByLabelText(copy.spaces.pickNote);
    expect(within(notes).getAllByRole('option').map((o) => o.textContent)).toEqual([
      copy.spaces.choose,
      'Budget.md',
      'Rezepte/Brot/Zopf.md',
    ]);
    expect(within(form).queryByText(copy.spaces.notVisible)).toBeNull();
  });

  it('says there is nothing to pick in an empty space, and adds nothing', async () => {
    vi.mocked(api.spaceTree).mockResolvedValue({ dirs: [], notes: [] });
    const { panel } = await manage();
    const form = within(panel).getByRole('heading', { name: copy.spaces.addMember }).closest('form')!;
    await userEvent.selectOptions(within(form).getByLabelText(copy.shareNote.person), 'anna');
    await userEvent.click(within(form).getByLabelText(copy.spaces.extent.note));
    expect(await within(form).findByText(copy.spaces.nothingToPick.note)).toBeInTheDocument();
    expect(within(form).queryByRole('textbox')).toBeNull();
    expect(within(form).getByRole('button', { name: copy.spaces.add })).toBeDisabled();
  });

  it('takes a typed path where the space’s tree cannot be read', async () => {
    vi.mocked(api.spaceTree).mockRejectedValue(new Error('offline'));
    const { panel, spaces } = await manage();
    const form = within(panel).getByRole('heading', { name: copy.spaces.addMember }).closest('form')!;

    await userEvent.selectOptions(within(form).getByLabelText(copy.shareNote.person), 'anna');
    await userEvent.click(within(form).getByLabelText(copy.spaces.extent.note));
    expect(await within(form).findByText(copy.spaces.notVisible)).toBeInTheDocument();
    await userEvent.type(within(form).getByPlaceholderText(copy.spaces.noteExample), 'Geheim/Liste.md');
    await userEvent.click(within(form).getByRole('button', { name: copy.spaces.add }));
    expect(spaces.onAddMember).toHaveBeenCalledWith('familie', 'anna', 'note', 'Geheim/Liste.md', false);
  });

  it('withdraws a member after asking', async () => {
    const { panel, spaces } = await manage();
    await userEvent.click(await within(panel).findByRole('button', { name: copy.spaces.removeLabel('otto') }));
    expect(window.confirm).toHaveBeenCalledWith(copy.spaces.confirmRemove('otto', 'Familie'));
    expect(spaces.onRemoveMember).toHaveBeenCalledWith('familie', MEMBERS[1]);
  });
});

describe('keys for a space', () => {
  it('offers spaces beside people as the account a key is for', async () => {
    const { props } = renderAdmin();
    const select = screen.getByRole('combobox', { name: copy.admin.forAccount });
    const groups = within(select).getAllByRole('group');
    expect(groups.map((g) => g.getAttribute('label'))).toEqual([copy.admin.people, copy.admin.spacesGroup]);
    expect(within(groups[1]!).getAllByRole('option').map((o) => o.getAttribute('value'))).toEqual(['familie', 'verein']);

    await userEvent.selectOptions(select, 'familie');
    expect(props.onPickOwner).toHaveBeenCalledWith('familie');
  });

  it('says what a space’s key reaches when one is picked', () => {
    renderAdmin({}, { keyOwner: 'familie' });
    expect(screen.getByText(copy.admin.keysForSpace)).toBeInTheDocument();
  });
});

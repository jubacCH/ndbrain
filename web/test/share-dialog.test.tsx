/**
 * "Share…" on one note.
 *
 * What it must get right: a note of your own goes through your shares, a
 * space's note through the space's members; the list of existing shares shows
 * this note's own and nothing that merely has a similar name; a folder or vault
 * share that reaches the note is shown but cannot be withdrawn from here.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api, type Share } from '../src/api';
import { copy } from '../src/copy';
import { ShareDialog, type ShareDialogProps } from '../src/ShareDialog';

function share(id: string, kind: Share['kind'], prefix: string, grantee: string, canWrite = false, owner = 'julian'): Share {
  return { id, owner, prefix, grantee, canWrite, createdAt: 0, kind };
}

const PLAN = { owner: 'julian', path: 'Projekt/Plan.md', title: 'Plan' };

const GRANTED = [
  share('s1', 'note', 'Projekt/Plan.md', 'anna', true),
  share('s2', 'note', 'Projekt/Plan.md.bak', 'bert'),
  share('s3', 'note', 'Projekt/Plan2.md', 'carla'),
  share('s8', 'note', 'Projekt/Plan', 'hanna'),
  share('s4', 'folder', 'Projekt/', 'dora'),
  share('s5', 'folder', 'Projekte/', 'emil'),
  share('s6', 'vault', '', 'finn'),
  share('s7', 'note', 'Projekt/Plan.md', 'gina', false, 'anna'),
];

function open(props: Partial<ShareDialogProps> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <ShareDialog
        note={PLAN}
        user={{ id: 'julian', role: 'user' }}
        ownerKind="person"
        ownerLabel="julian"
        granted={GRANTED}
        people={['anna', 'bert']}
        onClose={onClose}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { onClose, dialog: screen.getByRole('dialog', { name: copy.shareNote.title('Plan') }) };
}

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('sharing a note of your own', () => {
  it('lists exactly the shares of this note, not of its neighbours', () => {
    const { dialog } = open();
    const own = within(dialog).getByRole('region', { name: copy.shareNote.existing });
    const exact = within(own).getAllByRole('list')[0]!;

    expect(within(exact).getByText('anna')).toBeInTheDocument();
    for (const name of ['bert', 'carla', 'gina', 'hanna']) expect(within(own).queryByText(name)).toBeNull();
  });

  it('shows the folder and vault shares that reach the note, without a way to withdraw them here', () => {
    const { dialog } = open();
    const wider = within(dialog).getByText(copy.shareNote.wider).nextElementSibling as HTMLElement;
    expect(within(wider).getByText('dora')).toBeInTheDocument();
    expect(within(wider).getByText('finn')).toBeInTheDocument();
    expect(within(wider).queryByText('emil')).toBeNull();
    expect(within(wider).queryByRole('button')).toBeNull();
  });

  it('grants the note itself, readable or writable, through your own shares', async () => {
    const grant = vi.spyOn(api, 'grantShare').mockResolvedValue({ share: share('s9', 'note', PLAN.path, 'bert') });
    const member = vi.spyOn(api, 'addSpaceMember');
    const { dialog } = open();

    await userEvent.type(within(dialog).getByLabelText(copy.shareNote.person), 'bert');
    await userEvent.click(within(dialog).getByLabelText(copy.shareNote.write));
    await userEvent.click(within(dialog).getByRole('button', { name: copy.shareNote.share }));

    await waitFor(() => expect(grant).toHaveBeenCalledWith('bert', 'note', 'Projekt/Plan.md', true));
    expect(member).not.toHaveBeenCalled();
    await waitFor(() => expect(within(dialog).getByLabelText(copy.shareNote.person)).toHaveValue(''));
  });

  it('withdraws a share of the note after asking', async () => {
    const revoke = vi.spyOn(api, 'revokeShare').mockResolvedValue(undefined);
    const { dialog } = open();

    await userEvent.click(within(dialog).getByRole('button', { name: copy.shareNote.withdrawLabel('anna') }));

    expect(window.confirm).toHaveBeenCalledWith(copy.shareNote.confirmWithdraw('anna', 'Plan'));
    await waitFor(() => expect(revoke).toHaveBeenCalledWith('s1'));
  });

  it('says what the server said when a grant is refused', async () => {
    const { ApiError } = await import('../src/api');
    vi.spyOn(api, 'grantShare').mockRejectedValue(new ApiError(404, 'not_found', 'no such account'));
    const { dialog } = open();

    await userEvent.type(within(dialog).getByLabelText(copy.shareNote.person), 'nobody');
    await userEvent.click(within(dialog).getByRole('button', { name: copy.shareNote.share }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('no such account');
  });

  it('closes on Escape and on the close button', async () => {
    const { onClose, dialog } = open();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dialog).getByRole('button', { name: copy.shareNote.close }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('starts with the cursor in the person field', () => {
    const { dialog } = open();
    expect(within(dialog).getByLabelText(copy.shareNote.person)).toHaveFocus();
  });
});

describe('sharing a note in a space, as administrator', () => {
  const NOTE = { owner: 'familie', path: 'Ferien.md', title: 'Ferien' };

  it('reads and writes the space’s members, never your own shares', async () => {
    const members = vi.spyOn(api, 'spaceMembers').mockResolvedValue([
      share('m1', 'note', 'Ferien.md', 'anna', false, 'familie'),
      share('m2', 'note', 'Ferien.md.bak', 'bert', false, 'familie'),
      share('m3', 'vault', '', 'carla', true, 'familie'),
    ]);
    const add = vi.spyOn(api, 'addSpaceMember').mockResolvedValue(undefined);
    const grant = vi.spyOn(api, 'grantShare');

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ShareDialog
          note={NOTE}
          user={{ id: 'julian', role: 'admin' }}
          ownerKind="space"
          ownerLabel="Familie"
          granted={GRANTED}
          people={[]}
          onClose={vi.fn()}
        />
      </QueryClientProvider>,
    );
    const dialog = screen.getByRole('dialog', { name: copy.shareNote.title('Ferien') });
    expect(within(dialog).getByText(copy.shareNote.inSpace('Familie'), { exact: false })).toBeInTheDocument();

    const region = within(dialog).getByRole('region', { name: copy.shareNote.existing });
    expect(await within(region).findByText('anna')).toBeInTheDocument();
    expect(within(region).queryByText('bert')).toBeNull();
    expect(within(region).getByText('carla')).toBeInTheDocument();
    // Your own shares of a same-named note elsewhere are not this note's.
    expect(within(region).queryByText('dora')).toBeNull();
    expect(members).toHaveBeenCalledWith('familie');

    await userEvent.type(within(dialog).getByLabelText(copy.shareNote.person), 'dora');
    await userEvent.click(within(dialog).getByRole('button', { name: copy.shareNote.share }));
    await waitFor(() => expect(add).toHaveBeenCalledWith('familie', 'dora', 'note', 'Ferien.md', false));
    expect(grant).not.toHaveBeenCalled();
  });
});

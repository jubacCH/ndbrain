/**
 * Agent keys on a person's own settings page.
 *
 * Making a key was an administrator's job. With one account that is invisible;
 * with three it means nobody but the operator can connect an agent to their own
 * notes, and the operator is handed a steady trickle of requests to make keys
 * for vaults they have no other reason to touch.
 *
 * The table and the form are the administrator's, imported rather than copied.
 * What these pin is the two things that differ — no account is asked for, and a
 * key with no deadline is not on offer — and the one thing that must not: the
 * secret is shown once and the page says so.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiKey } from '../src/api';
import { copy } from '../src/copy';
import { DEFAULT_PREFS } from '../src/prefs';
import { SettingsView, type SettingsProps } from '../src/Settings';

const DAY = 86_400_000;

function key(over: Partial<ApiKey> = {}): ApiKey {
  return {
    id: 'key_1',
    owner: 'julian',
    name: 'Claude',
    scope: '',
    canWrite: false,
    createdAt: Date.now(),
    lastUsedAt: null,
    expiresAt: Date.now() + 200 * DAY,
    revoked: false,
    ...over,
  };
}

function mount(props: Partial<SettingsProps> = {}) {
  const onCreateKey = vi.fn().mockResolvedValue({ ...key(), secret: 'ndb_' + 'a'.repeat(64) });
  const onRevokeKey = vi.fn().mockResolvedValue(undefined);
  render(
    <SettingsView
      prefs={DEFAULT_PREFS}
      onPrefs={vi.fn()}
      staleDays={90}
      onStaleDays={vi.fn()}
      user={{ id: 'julian', displayName: 'Julian', role: 'user' }}
      onSignedOutEverywhere={vi.fn()}
      onRenamed={vi.fn()}
      keys={[]}
      onCreateKey={onCreateKey}
      onRevokeKey={onRevokeKey}
      {...props}
    />,
  );
  return { onCreateKey, onRevokeKey };
}

/** The section, so nothing is matched against the rest of a long page. */
const section = (): HTMLElement =>
  screen.getByRole('heading', { name: copy.admin.agentKeys }).closest('section') as HTMLElement;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the list', () => {
  it('shows a key with its scope and whether it may write', () => {
    mount({ keys: [key({ name: 'Claude', scope: '10_Projects/', canWrite: true })] });
    const rows = within(section()).getByRole('table');

    expect(within(rows).getByText('Claude')).toBeInTheDocument();
    expect(within(rows).getByText('10_Projects/')).toBeInTheDocument();
    expect(within(rows).getByText(copy.admin.canWrite)).toBeInTheDocument();
  });

  it('says plainly when there are none, rather than showing an empty table', () => {
    mount();
    expect(within(section()).getByText(copy.admin.noKeys)).toBeInTheDocument();
    expect(within(section()).queryByRole('table')).toBeNull();
  });

  it('asks no account: there is only one it could be', () => {
    mount({ keys: [key()] });
    expect(within(section()).queryByLabelText(copy.admin.forAccount)).toBeNull();
  });
});

describe('making one', () => {
  /**
   * The server refuses a key with no deadline on this route, so offering it
   * here would be a control that fails on submit — the kind of thing that is
   * found by trying it rather than by reading the screen.
   */
  it('does not offer a key that never runs out', async () => {
    mount();
    const lifetime = within(section()).getByLabelText(copy.admin.lifetime);

    const offered = within(lifetime).getAllByRole('option').map((o) => o.textContent);
    expect(offered).toContain(copy.admin.lifetimeYear);
    expect(offered).not.toContain(copy.admin.lifetimeForever);
  });

  it('sends the name, the scope and the write flag, with no owner anywhere', async () => {
    const { onCreateKey } = mount();
    const box = section();

    await userEvent.type(within(box).getByLabelText(copy.admin.keyName), 'Claude');
    await userEvent.type(within(box).getByLabelText(copy.admin.scope), '10_Projects');
    await userEvent.click(within(box).getByLabelText(copy.admin.mayWrite));
    await userEvent.click(within(box).getByRole('button', { name: copy.admin.createKey }));

    expect(onCreateKey).toHaveBeenCalledWith('Claude', '10_Projects', true, 365);
  });

  /** The whole security model: only the hash is stored, so this is the one sight of it. */
  it('shows the secret once, and says that is the only time', async () => {
    const { onCreateKey } = mount();
    onCreateKey.mockResolvedValue({ ...key(), secret: 'ndb_geheim' });
    const box = section();

    await userEvent.type(within(box).getByLabelText(copy.admin.keyName), 'Claude');
    await userEvent.click(within(box).getByRole('button', { name: copy.admin.createKey }));

    expect(await within(section()).findByText(copy.admin.secretOnce)).toBeInTheDocument();
    expect(within(section()).getByDisplayValue('ndb_geheim')).toBeInTheDocument();

    // And it goes when it has been taken, rather than sitting on the page.
    await userEvent.click(within(section()).getByRole('button', { name: copy.admin.gotIt }));
    expect(screen.queryByDisplayValue('ndb_geheim')).toBeNull();
  });
});

describe('revoking one', () => {
  it('asks first, and does nothing on a no', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { onRevokeKey } = mount({ keys: [key({ name: 'Claude' })] });

    await userEvent.click(within(section()).getByRole('button', { name: copy.admin.revoke }));

    expect(confirm).toHaveBeenCalledWith(copy.settings.confirmRevokeMine('Claude'));
    expect(onRevokeKey).not.toHaveBeenCalled();
  });

  it('revokes on a yes, and says so', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onRevokeKey } = mount({ keys: [key({ id: 'key_7', name: 'Claude' })] });

    await userEvent.click(within(section()).getByRole('button', { name: copy.admin.revoke }));

    expect(onRevokeKey).toHaveBeenCalledWith('key_7');
    expect(await screen.findByText(copy.admin.keyRevoked('Claude'))).toBeInTheDocument();
  });

  it('offers nothing to revoke on a key that already is', () => {
    mount({ keys: [key({ revoked: true })] });
    expect(within(section()).queryByRole('button', { name: copy.admin.revoke })).toBeNull();
    expect(within(section()).getByText(copy.admin.revoked)).toBeInTheDocument();
  });
});

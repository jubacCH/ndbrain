/**
 * The file browser and the crash screen.
 *
 * Grouped because both are about the same thing: not losing something. The
 * browser is how a file gets back out of the vault; the boundary is how the
 * sentence you were writing gets back out of a broken render.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Boundary } from '../src/Boundary';
import { FilesView, humanSize } from '../src/Files';
import type { FileRow } from '../src/api';
import { copy } from '../src/copy';

function file(path: string, size = 100, isNote = path.endsWith('.md')): FileRow {
  return { owner: 'julian', path, size, mtimeMs: 1_700_000_000_000, isNote };
}

const FILES = [
  file('20_Areas/21_Homelab/Proxmox.md'),
  file('20_Areas/21_Homelab/rack.png', 2048),
  file('Willkommen.md', 33),
];
const DIRS = ['20_Areas', '20_Areas/21_Homelab', 'Leer'];

function renderFiles(props: Partial<Parameters<typeof FilesView>[0]> = {}) {
  const handlers = {
    onDir: vi.fn(),
    onUpload: vi.fn(),
    onReplace: vi.fn(),
    onDelete: vi.fn(),
    onOpenNote: vi.fn(),
  };
  render(
    <FilesView
      files={FILES}
      dirs={DIRS}
      truncated={false}
      owner="julian"
      busy={false}
      dir=""
      {...handlers}
      {...props}
    />,
  );
  return handlers;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a space in the file browser', () => {
  const VAULTS = [
    { id: 'julian', label: 'julian', space: false },
    { id: 'familie', label: 'Familie Bachmann', space: true },
  ];

  it('offers the spaces beside the own vault, by display name, and switches to the root of one', async () => {
    const onVault = vi.fn();
    const handlers = renderFiles({ vaults: VAULTS, onVault, dir: '20_Areas' });
    const picker = screen.getByLabelText(copy.files.vaultPicker);
    expect(within(picker).getAllByRole('option').map((o) => o.textContent)).toEqual([
      copy.files.ownVault,
      copy.files.spaceOption('Familie Bachmann'),
    ]);
    await userEvent.selectOptions(picker, 'familie');
    expect(onVault).toHaveBeenCalledWith('familie');
    expect(handlers.onDir).toHaveBeenCalledWith('');
  });

  it('shows no picker when there is only the own vault', () => {
    renderFiles({ vaults: VAULTS.slice(0, 1), onVault: vi.fn() });
    expect(screen.queryByLabelText(copy.files.vaultPicker)).toBeNull();
  });

  it('offers only what the membership allows: no import, replace or delete where it cannot write, no export of a space', () => {
    renderFiles({
      owner: 'familie',
      vaults: VAULTS,
      onVault: vi.fn(),
      dir: '20_Areas/21_Homelab',
      mayWrite: (path) => path.endsWith('.png'),
      mayAddTo: () => false,
    });
    expect(screen.getByRole('button', { name: /Familie Bachmann/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.files.import })).toBeNull();
    expect(screen.queryByRole('link', { name: copy.files.downloadAll })).toBeNull();
    const rows = screen.getAllByRole('row').slice(1);
    const proxmox = rows.find((row) => row.textContent?.includes('Proxmox.md'))!;
    const rack = rows.find((row) => row.textContent?.includes('rack.png'))!;
    expect(within(proxmox).queryByRole('button', { name: copy.files.delete })).toBeNull();
    expect(within(proxmox).getByRole('link', { name: copy.files.download })).toBeInTheDocument();
    expect(within(rack).getByRole('button', { name: copy.files.delete })).toBeInTheDocument();
  });
});

describe('sizes', () => {
  it('reads as a person would say it', () => {
    expect(humanSize(0)).toBe('0 B');
    expect(humanSize(999)).toBe('999 B');
    expect(humanSize(2048)).toBe('2.0 KB');
    expect(humanSize(1024 * 1024 * 3.5)).toBe('3.5 MB');
  });

  it('drops the decimal once the number is big enough not to need it', () => {
    expect(humanSize(1024 * 25)).toBe('25 KB');
  });
});

describe('browsing', () => {
  it('shows one folder at a time, not a flat dump of the vault', () => {
    renderFiles();

    expect(screen.getByText('Areas')).toBeInTheDocument();
    expect(screen.getByText('Willkommen.md')).toBeInTheDocument();
    // Two levels down, so not on screen at the root.
    expect(screen.queryByText('rack.png')).not.toBeInTheDocument();
  });

  it('keeps an empty folder visible', () => {
    // The whole reason folders come back separately from files: an empty one
    // exists only as a directory, and it vanished from every other view.
    renderFiles();

    expect(screen.getByText('Leer')).toBeInTheDocument();
  });

  it('says how much is inside a folder', () => {
    renderFiles();

    const row = screen.getByText('Areas').closest('tr');
    expect(within(row!).getByText('2 files')).toBeInTheDocument();
  });

  it('navigates by the real path, not the shown one', async () => {
    const user = userEvent.setup();
    const { onDir } = renderFiles();

    await user.click(screen.getByText('Areas'));

    // Shown as "Areas", addressed as "20_Areas" — the disk keeps its digits.
    expect(onDir).toHaveBeenCalledWith('20_Areas');
  });

  it('shows files of the folder it is looking at', () => {
    renderFiles({ dir: '20_Areas/21_Homelab' });

    expect(screen.getByText('rack.png')).toBeInTheDocument();
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
  });

  it('offers a way back up through the crumbs', () => {
    renderFiles({ dir: '20_Areas/21_Homelab' });

    const crumbs = screen.getByLabelText('Folder');
    expect(within(crumbs).getByText('Vault')).toBeEnabled();
    // The last crumb is where you are, so it is a label rather than a control.
    expect(within(crumbs).getByText(/Homelab/)).toBeDisabled();
  });
});

describe('acting on a file', () => {
  it('links a download at the file, with its owner', () => {
    renderFiles({ dir: '20_Areas/21_Homelab' });

    const row = screen.getByText('rack.png').closest('tr');
    const link = within(row!).getByText('Download');
    expect(link).toHaveAttribute(
      'href',
      '/api/v1/files/20_Areas/21_Homelab/rack.png?owner=julian',
    );
  });

  it('asks before deleting, and passes the file through', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { onDelete } = renderFiles({ dir: '20_Areas/21_Homelab' });

    const row = screen.getByText('rack.png').closest('tr');
    await user.click(within(row!).getByText('Delete'));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('opens a note rather than only offering to download it', async () => {
    const user = userEvent.setup();
    const { onOpenNote } = renderFiles({ dir: '20_Areas/21_Homelab' });

    await user.click(screen.getByText('Proxmox.md'));

    expect(onOpenNote).toHaveBeenCalledWith('20_Areas/21_Homelab/Proxmox.md');
  });

  it('says when the listing was capped instead of implying that was all', () => {
    renderFiles({ truncated: true });

    expect(screen.getByText(/first 5000/i)).toBeInTheDocument();
  });

  it('says so when a folder is empty rather than showing a bare table', () => {
    renderFiles({ files: [], dirs: [] });

    expect(screen.getByText(/empty/i)).toBeInTheDocument();
  });
});

describe('the crash screen', () => {
  function Boom(): React.JSX.Element {
    throw new Error('render exploded');
  }

  it('replaces a blank page with something that explains itself', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(
      <Boundary>
        <Boom />
      </Boundary>,
    );

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText('Reload')).toBeInTheDocument();
  });

  it('hands back text that had not reached the server yet', () => {
    // The reason this exists at all. A render fault used to unmount everything,
    // and the only copy of a half-written paragraph went with it.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.__ndbrainPending = { path: 'Homelab/Notiz.md', content: 'ein halber Satz' };

    render(
      <Boundary>
        <Boom />
      </Boundary>,
    );

    expect(screen.getByText('Homelab/Notiz.md')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ein halber Satz')).toBeInTheDocument();

    window.__ndbrainPending = null;
  });

  it('does not offer a recovery box when nothing was pending', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.__ndbrainPending = null;

    render(
      <Boundary>
        <Boom />
      </Boundary>,
    );

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('leaves a working tree alone', () => {
    render(
      <Boundary>
        <p>alles in Ordnung</p>
      </Boundary>,
    );

    expect(screen.getByText('alles in Ordnung')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

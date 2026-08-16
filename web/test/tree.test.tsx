/**
 * The navigation, which is where a growing vault first becomes unusable.
 *
 * Measured on the real one: 72% of notes hung under a single branch, and the
 * tree opened everything by default — so reaching anything meant scrolling a
 * long alphabetical list. The three habits that fixed it are what these tests
 * pin down, because each of them is easy to undo by accident:
 *
 *  - it starts shut, and reveals the note you are actually on
 *  - typing filters, flat, each hit under its own path
 *  - numeric sort prefixes are hidden **in the display only** — the path on disk
 *    keeps its digits, and a test that let that slip would be a test that let
 *    every wikilink break
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Tree, displayName, displayPath } from '../src/Tree';
import { refKey, type NoteRow } from '../src/api';

function note(path: string): NoteRow {
  return {
    owner: 'julian',
    path,
    title: path.slice(path.lastIndexOf('/') + 1).replace(/\.md$/, ''),
    size: 10,
    mtimeMs: 1_700_000_000_000,
  };
}

const NOTES = [
  note('20_Areas/21_Homelab/Proxmox Cluster.md'),
  note('20_Areas/21_Homelab/Hardware & NAS.md'),
  note('20_Areas/22_Selfhosted-Services/CT 104 — Paperless.md'),
  note('00_Inbox/Notiz.md'),
  note('Willkommen.md'),
];

function renderTree(props: Partial<Parameters<typeof Tree>[0]> = {}) {
  const onSelect = vi.fn();
  render(
    <Tree
      notes={NOTES}
      self="julian"
      received={[]}
      selected={null}
      findings={new Map()}
      filter=""
      hidePrefixes
      onSelect={onSelect}
      onRenameFolder={vi.fn()}
      {...props}
    />,
  );
  return { onSelect };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('sort prefixes', () => {
  it('hides a prefix that exists only to force an order', () => {
    expect(displayName('20_Areas')).toBe('Areas');
    expect(displayName('00_Inbox')).toBe('Inbox');
    expect(displayName('22_Selfhosted-Services')).toBe('Selfhosted-Services');
  });

  it('keeps digits that are the name rather than a sorting device', () => {
    // The rule is narrow on purpose: a date and a count are not sort prefixes.
    expect(displayName('2026-07-27')).toBe('2026-07-27');
    expect(displayName('100 Ideen')).toBe('100 Ideen');
    expect(displayName('3D-Druck')).toBe('3D-Druck');
  });

  it('reads a whole path the way the tree shows it', () => {
    expect(displayPath('20_Areas/21_Homelab/Proxmox Cluster.md')).toBe('Areas › Homelab');
  });
});

describe('the closed-by-default tree', () => {
  it('shows the top level only', () => {
    renderTree();

    expect(screen.getByText('Areas')).toBeInTheDocument();
    // A note three levels down must not be on screen before anything is opened.
    expect(screen.queryByText('Proxmox Cluster')).not.toBeInTheDocument();
  });

  it('says how much a shut folder is hiding', () => {
    renderTree();

    const areas = screen.getByText('Areas').closest('button');
    expect(within(areas!).getByText('3')).toBeInTheDocument();
  });

  it('opens on click and remembers it', async () => {
    const user = userEvent.setup();
    const { unmount } = { unmount: renderTree() && (() => undefined) };
    void unmount;

    await user.click(screen.getByText('Areas'));
    expect(screen.getByText('Homelab')).toBeInTheDocument();

    // Persisted, so the shape of the tree survives a reload.
    expect(window.localStorage.getItem('ndbrain.openFolders')).toContain('20_Areas');
  });

  it('reveals the note that is selected, however deep it sits', () => {
    // Opening a note from search, a link or the palette must not leave the tree
    // looking like it has lost track of where you are.
    renderTree({ selected: { owner: 'julian', path: '20_Areas/21_Homelab/Proxmox Cluster.md' } });

    expect(screen.getByText('Proxmox Cluster')).toBeInTheDocument();
  });
});

describe('the filter', () => {
  it('lists matches flat, each under its own path', () => {
    renderTree({ filter: 'proxmox' });

    expect(screen.getByText('Proxmox Cluster')).toBeInTheDocument();
    // The location is shown as read, not as stored.
    expect(screen.getByText('Areas › Homelab')).toBeInTheDocument();
    expect(screen.queryByText('Notiz')).not.toBeInTheDocument();
  });

  it('matches what is on screen, not only what is on disk', () => {
    // Somebody types what the tree shows them: "homelab", never "21_homelab".
    renderTree({ filter: 'homelab' });

    expect(screen.getByText('Proxmox Cluster')).toBeInTheDocument();
    expect(screen.getByText('Hardware & NAS')).toBeInTheDocument();
  });

  it('treats several words as all of them', () => {
    renderTree({ filter: 'homelab hardware' });

    expect(screen.getByText('Hardware & NAS')).toBeInTheDocument();
    expect(screen.queryByText('Proxmox Cluster')).not.toBeInTheDocument();
  });

  it('says so when nothing matches', () => {
    renderTree({ filter: 'zzgibtesnicht' });

    expect(screen.getByText('No match.')).toBeInTheDocument();
  });

  it('hands back the real path, digits and all', async () => {
    // The one that would break every wikilink if display and identity were ever
    // allowed to become the same string.
    const user = userEvent.setup();
    const { onSelect } = renderTree({ filter: 'proxmox' });

    await user.click(screen.getByText('Proxmox Cluster'));

    expect(onSelect).toHaveBeenCalledWith('julian', '20_Areas/21_Homelab/Proxmox Cluster.md');
  });
});

describe('findings', () => {
  const marked = '20_Areas/21_Homelab/Proxmox Cluster.md';

  it('marks a note that has one', () => {
    renderTree({
      filter: 'proxmox',
      findings: new Map([[refKey('julian', marked), 'crit' as const]]),
    });

    expect(document.querySelector('.st-crit')).not.toBeNull();
  });

  it('keys the marker by vault as well as path', () => {
    // A marker keyed by path alone would light up a note of the same name in
    // somebody else's shared vault. Same path, wrong owner: no marker at all.
    renderTree({
      filter: 'proxmox',
      findings: new Map([[refKey('ramona', marked), 'crit' as const]]),
    });

    expect(document.querySelector('.st-crit')).toBeNull();
  });
});

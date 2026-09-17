/**
 * The page's copy of the server's share rule.
 *
 * Only ever decides whether a control is drawn, never whether a write is sent —
 * but a control drawn on a note the caller cannot touch is a promise the server
 * then breaks, and a note share read as a prefix would draw it on every
 * neighbour whose name happens to start the same way. The neighbours below are
 * the ones the server's own tests use: a backup copy, a numbered sibling, and a
 * path that treats the note as a folder.
 */

import { describe, expect, it } from 'vitest';

import type { Share } from '../src/api';
import { covers, mayChange, mayChangeFolder, mayRead, mayShare } from '../src/rights';

function share(kind: Share['kind'], prefix: string, canWrite = true, owner = 'anna'): Share {
  return { id: `${kind}:${prefix}`, owner, prefix, grantee: 'julian', canWrite, createdAt: 0, kind };
}

describe('a note share', () => {
  const note = share('note', 'Projekt/Plan.md');

  it('covers exactly its own path', () => {
    expect(covers(note, 'Projekt/Plan.md')).toBe(true);
  });

  it.each(['Projekt/Plan.md.bak', 'Projekt/Plan2.md', 'Projekt/Plan.md/x', 'Projekt/Plan', 'Projekt/', 'projekt/plan.md'])(
    'does not cover the neighbour %s',
    (path) => {
      expect(covers(note, path)).toBe(false);
      expect(mayChange('julian', [note], 'anna', path)).toBe(false);
      expect(mayRead('julian', [note], 'anna', path)).toBe(false);
    },
  );

  it('lets its path be changed when it carries write access, and only then', () => {
    expect(mayChange('julian', [note], 'anna', 'Projekt/Plan.md')).toBe(true);
    expect(mayChange('julian', [share('note', 'Projekt/Plan.md', false)], 'anna', 'Projekt/Plan.md')).toBe(false);
    expect(mayRead('julian', [share('note', 'Projekt/Plan.md', false)], 'anna', 'Projekt/Plan.md')).toBe(true);
  });

  it('opens nothing in another vault with the same path', () => {
    expect(mayChange('julian', [note], 'bert', 'Projekt/Plan.md')).toBe(false);
  });
});

describe('a folder share', () => {
  const folder = share('folder', 'Projekt/');

  it('covers everything under the folder, at any depth', () => {
    expect(covers(folder, 'Projekt/Plan.md')).toBe(true);
    expect(covers(folder, 'Projekt/Alt/Plan.md')).toBe(true);
  });

  it('stops at the folder boundary the trailing slash draws', () => {
    expect(covers(folder, 'Projekte/Plan.md')).toBe(false);
    expect(covers(folder, 'Projekt.md')).toBe(false);
  });
});

describe('a vault share', () => {
  it('covers every path in that vault', () => {
    expect(covers(share('vault', ''), 'Anything/at/all.md')).toBe(true);
  });
});

describe('the caller’s own vault', () => {
  it('is always changeable, with no share at all', () => {
    expect(mayChange('julian', [], 'julian', 'Projekt/Plan.md')).toBe(true);
    expect(mayRead('julian', [], 'julian', 'Projekt/Plan.md')).toBe(true);
  });
});

describe('who may share a note', () => {
  it('is its owner', () => {
    expect(mayShare({ id: 'julian', role: 'user' }, 'julian', 'person')).toBe(true);
  });

  it('is not somebody who holds it through a share, even with write access', () => {
    expect(mayShare({ id: 'julian', role: 'user' }, 'anna', 'person')).toBe(false);
    expect(mayShare({ id: 'julian', role: 'admin' }, 'anna', 'person')).toBe(false);
  });

  it('is an administrator inside a space, and nobody else there', () => {
    expect(mayShare({ id: 'julian', role: 'admin' }, 'familie', 'space')).toBe(true);
    expect(mayShare({ id: 'julian', role: 'user' }, 'familie', 'space')).toBe(false);
  });
});

describe('adding files to a folder', () => {
  const inSpace = (kind: Share['kind'], prefix: string, canWrite = true): Share => share(kind, prefix, canWrite, 'familie');

  it('is allowed at and below a writable folder share, and in the own vault anywhere', () => {
    expect(mayChangeFolder('julian', [], 'julian', '')).toBe(true);
    expect(mayChangeFolder('julian', [inSpace('folder', 'Ferien/')], 'familie', 'Ferien')).toBe(true);
    expect(mayChangeFolder('julian', [inSpace('folder', 'Ferien/')], 'familie', 'Ferien/2026')).toBe(true);
    expect(mayChangeFolder('julian', [inSpace('vault', '')], 'familie', '')).toBe(true);
  });

  it('is refused beside it, above it, read-only, and through a note share spelled like the folder', () => {
    expect(mayChangeFolder('julian', [inSpace('folder', 'Ferien/')], 'familie', '')).toBe(false);
    expect(mayChangeFolder('julian', [inSpace('folder', 'Ferien/')], 'familie', 'Ferien2')).toBe(false);
    expect(mayChangeFolder('julian', [inSpace('folder', 'Ferien/', false)], 'familie', 'Ferien')).toBe(false);
    expect(mayChangeFolder('julian', [inSpace('note', 'Ferien/Plan.md')], 'familie', 'Ferien/Plan.md')).toBe(false);
    expect(mayChangeFolder('julian', [inSpace('folder', 'Ferien/')], 'verein', 'Ferien')).toBe(false);
  });
});

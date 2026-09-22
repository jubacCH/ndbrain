import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { InvalidPathError, InvalidUserError } from '../src/errors.js';
import {
  caseKey,
  isNotePath,
  normalizeVaultPath,
  noteTitle,
  parentDir,
  resolveInVault,
  vaultRoot,
} from '../src/vault/paths.js';

const DATA = path.resolve('/tmp/ndbrain-test-data');

describe('assertUserId / vaultRoot', () => {
  it('accepts ordinary ids', () => {
    expect(vaultRoot(DATA, 'julian')).toBe(path.resolve(DATA, 'vaults', 'julian'));
    expect(vaultRoot(DATA, 'a-b_c9')).toBe(path.resolve(DATA, 'vaults', 'a-b_c9'));
  });

  it.each([
    ['empty', ''],
    ['traversal', '..'],
    ['nested traversal', '../../etc'],
    ['separator', 'a/b'],
    ['backslash', 'a\\b'],
    ['leading dash', '-julian'],
    ['dot', 'julian.'],
    ['space', 'jul ian'],
    ['NUL byte', 'julian\u0000'],
    ['too long', 'x'.repeat(65)],
  ])('rejects a user id with %s', (_label, id) => {
    expect(() => vaultRoot(DATA, id)).toThrow(InvalidUserError);
  });
});

describe('normalizeVaultPath', () => {
  it('returns a canonical relative POSIX path', () => {
    expect(normalizeVaultPath('Homelab/Proxmox.md')).toBe('Homelab/Proxmox.md');
    expect(normalizeVaultPath('./Homelab//Proxmox.md')).toBe('Homelab/Proxmox.md');
    expect(normalizeVaultPath('Homelab/')).toBe('Homelab');
  });

  it('maps every spelling of the same note onto one string', () => {
    const forms = ['Homelab/Proxmox.md', './Homelab/Proxmox.md', 'Homelab//Proxmox.md'];
    const normalized = new Set(forms.map(normalizeVaultPath));
    expect(normalized.size).toBe(1);
  });

  /*
   * A leading dot hides the entry from every listing and from the watcher, so
   * a file written under one could never be seen, indexed or removed again.
   * `.git` is the one that decides it: the vault's history lives there, and the
   * timer that commits it runs git as root over this directory — git reads
   * several settings out of the repository and runs them as commands.
   */
  it('names the dot as the reason, so the message is actionable', () => {
    expect(() => normalizeVaultPath('.git/config')).toThrow(/begin with a dot/);
  });

  it('keeps a dot inside a name, which is ordinary', () => {
    expect(normalizeVaultPath('Homelab/v1.2 Notizen.md')).toBe('Homelab/v1.2 Notizen.md');
    expect(normalizeVaultPath('Archiv/2026.09.21.md')).toBe('Archiv/2026.09.21.md');
  });

  it('keeps unicode and spaces, which are legitimate in note names', () => {
    expect(normalizeVaultPath('Küche/Rezept für Brot.md')).toBe('Küche/Rezept für Brot.md');
    expect(normalizeVaultPath('Notizen/2026 — Juli.md')).toBe('Notizen/2026 — Juli.md');
  });

  it.each([
    ['upward traversal', '../secrets.md'],
    ['traversal in the middle', 'Homelab/../../secrets.md'],
    ['bare traversal', '..'],
    ['absolute posix path', '/etc/passwd'],
    ['windows drive path', 'C:/Windows/system.ini'],
    ['drive-relative path', 'C:notes.md'],
    ['backslash separator', 'Homelab\\Proxmox.md'],
    ['NUL byte', 'Homelab/Prox\u0000mox.md'],
    ['control character', 'Homelab/Prox\u001Fmox.md'],
    ['reserved device name', 'aux.md'],
    ['reserved name in a folder', 'Homelab/con.md'],
    ['trailing space', 'Homelab/Proxmox.md '],
    ['trailing dot', 'Homelab/Proxmox.'],
    ['the history repository', '.git/config'],
    ['a hidden file anywhere below', 'Homelab/.git/hooks/pre-commit'],
    ['a hidden folder of another tool', '.obsidian/workspace.json'],
    ['a hidden note', 'Homelab/.secret.md'],
    ['empty', ''],
    ['root itself', '.'],
  ])('rejects %s', (_label, input) => {
    expect(() => normalizeVaultPath(input)).toThrow(InvalidPathError);
  });
});

describe('resolveInVault — the tenant boundary', () => {
  it('resolves inside the owner vault', () => {
    const resolved = resolveInVault(DATA, 'julian', 'Homelab/Proxmox.md');
    expect(resolved).toBe(path.resolve(DATA, 'vaults', 'julian', 'Homelab', 'Proxmox.md'));
  });

  it('never lets one user address another user\'s file', () => {
    const attempts = [
      '../ramona/Geheim.md',
      '../../vaults/ramona/Geheim.md',
      'Homelab/../../ramona/Geheim.md',
      './../ramona/Geheim.md',
      '....//ramona/Geheim.md'.replace('....//', '../'), // guards against naive `..` stripping
    ];

    for (const attempt of attempts) {
      expect(() => resolveInVault(DATA, 'julian', attempt)).toThrow(InvalidPathError);
    }
  });

  it('treats a percent-encoded traversal as one literal file name', () => {
    // `%2F` is not a separator here — it is two ordinary characters, so this is a
    // (strange but harmless) note inside the caller's own vault.
    //
    // The danger lives one layer up: decoding twice turns this into real
    // traversal. v1 shipped exactly that bug and it was caught in review, so the
    // HTTP layer decodes once, then calls this function, and never the other way
    // round. Asserting containment here makes the contract explicit.
    const resolved = resolveInVault(DATA, 'julian', 'Homelab%2F..%2Framona%2FGeheim.md');
    expect(resolved.startsWith(vaultRoot(DATA, 'julian') + path.sep)).toBe(true);
  });

  it('refuses the same name spelled as a hidden one, for the other reason', () => {
    // `..%2Framona%2FGeheim.md` is no more traversal than the name above, but it
    // is a file whose name begins with a dot, so the rule against hidden entries
    // catches it first. Named here so that a later reader does not mistake the
    // rejection for a traversal defence that never applied.
    expect(() => resolveInVault(DATA, 'julian', '..%2Framona%2FGeheim.md')).toThrow(
      /begin with a dot/,
    );
  });

  it('keeps two users with the same note path apart', () => {
    const a = resolveInVault(DATA, 'julian', 'Homelab/Proxmox.md');
    const b = resolveInVault(DATA, 'ramona', 'Homelab/Proxmox.md');
    expect(a).not.toBe(b);
    expect(a.startsWith(vaultRoot(DATA, 'julian') + path.sep)).toBe(true);
    expect(b.startsWith(vaultRoot(DATA, 'ramona') + path.sep)).toBe(true);
  });

  it('rejects a malformed owner before touching the path', () => {
    expect(() => resolveInVault(DATA, '../ramona', 'Note.md')).toThrow(InvalidUserError);
  });

  it('does not confuse a vault with one whose name is a prefix of it', () => {
    // `julian` and `julian2` share a prefix; containment must compare on the separator.
    const root = vaultRoot(DATA, 'julian');
    const other = resolveInVault(DATA, 'julian2', 'Note.md');
    expect(other.startsWith(root + path.sep)).toBe(false);
  });
});

describe('path helpers', () => {
  it('recognises note paths', () => {
    expect(isNotePath('a/b.md')).toBe(true);
    expect(isNotePath('a/b.MD')).toBe(true);
    expect(isNotePath('a/b.txt')).toBe(false);
    expect(isNotePath('a/b')).toBe(false);
  });

  it('derives the title from the file name, as decided', () => {
    expect(noteTitle('Homelab/Proxmox Cluster.md')).toBe('Proxmox Cluster');
    expect(noteTitle('Proxmox.md')).toBe('Proxmox');
    expect(noteTitle('Homelab')).toBe('Homelab');
  });

  it('finds the parent directory', () => {
    expect(parentDir('Homelab/Container/CT120.md')).toBe('Homelab/Container');
    expect(parentDir('Proxmox.md')).toBe('');
  });
});

describe('caseKey', () => {
  it('folds case so that two spellings collide', () => {
    expect(caseKey('Homelab/Proxmox.md')).toBe(caseKey('homelab/PROXMOX.md'));
  });

  it('folds unicode composition, so macOS and Linux spellings collide', () => {
    const composed = 'M\u00FCller.md'; // ü as a single code point (NFC)
    const decomposed = 'Mu\u0308ller.md'; // u + combining diaeresis (NFD)
    expect(composed).not.toBe(decomposed);
    expect(caseKey(composed)).toBe(caseKey(decomposed));
  });

  it('keeps genuinely different names apart', () => {
    expect(caseKey('Proxmox.md')).not.toBe(caseKey('Proxmox2.md'));
  });
});

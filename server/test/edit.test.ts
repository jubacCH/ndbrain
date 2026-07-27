import { describe, expect, it } from 'vitest';

import { addTag, removeTag } from '../src/markdown/edit.js';
import { parseNote } from '../src/markdown/parse.js';

/** What matters is not the exact bytes of the frontmatter but what it parses to. */
function tagsOf(source: string): string[] {
  return parseNote(source).tags;
}

describe('addTag', () => {
  it('extends a flow list', () => {
    const source = '---\ntags: [homelab, proxmox]\ntitel: Test\n---\n# Inhalt\n';
    const result = addTag(source, 'wartung');

    expect(tagsOf(result)).toEqual(['homelab', 'proxmox', 'wartung']);
    expect(result).toContain('titel: Test');
    expect(result).toContain('# Inhalt');
  });

  it('extends a block list', () => {
    const source = '---\ntags:\n  - homelab\n  - proxmox\n---\nText\n';
    const result = addTag(source, 'wartung');

    expect(tagsOf(result)).toEqual(['homelab', 'proxmox', 'wartung']);
    expect(result).toContain('Text');
  });

  it('extends an inline scalar list', () => {
    const source = '---\ntags: homelab, proxmox\n---\nText\n';
    expect(tagsOf(addTag(source, 'wartung'))).toEqual(['homelab', 'proxmox', 'wartung']);
  });

  it('adds a tags key to frontmatter that has none', () => {
    const source = '---\ntitel: Ohne Tags\n---\nText\n';
    const result = addTag(source, 'neu');

    expect(tagsOf(result)).toEqual(['neu']);
    expect(result).toContain('titel: Ohne Tags');
    expect(result).toContain('Text');
  });

  it('creates frontmatter when there is none', () => {
    const result = addTag('# Nur Text\n\nMehr.\n', 'neu');

    expect(tagsOf(result)).toEqual(['neu']);
    expect(result.startsWith('---\n')).toBe(true);
    expect(result).toContain('# Nur Text');
  });

  it('leaves the note untouched when the tag is already there', () => {
    // A bulk tag over a mixed selection must not rewrite — and re-date — files
    // that needed nothing.
    for (const source of [
      '---\ntags: [homelab]\n---\nText\n',
      '---\ntags:\n  - homelab\n---\nText\n',
      '---\ntags: [Homelab]\n---\nText\n',
      '---\ntags: ["#homelab"]\n---\nText\n',
    ]) {
      expect(addTag(source, 'homelab')).toBe(source);
      expect(addTag(source, '#homelab')).toBe(source);
    }
  });

  it('does not reformat the rest of the frontmatter', () => {
    // Round-tripping through a YAML library would reorder keys and change quote
    // style; rewriting somebody's file to suit our parser is the thing this
    // product exists not to do.
    const source =
      '---\nzuletzt:   2026-07-27\ntags: [homelab]\n"quoted key": \'einfach\'\nliste:\n  - eins\n  - zwei\n---\nText\n';
    const result = addTag(source, 'neu');

    expect(result).toContain('zuletzt:   2026-07-27');
    expect(result).toContain('"quoted key": \'einfach\'');
    expect(result).toContain('  - eins');
    expect(tagsOf(result)).toEqual(['homelab', 'neu']);
  });

  it('keeps the body byte-identical', () => {
    const body = '# Titel\n\nAbsatz mit [[Link]] und `code`.\n\n- [ ] Aufgabe\n';
    const result = addTag(`---\ntags: [a]\n---\n${body}`, 'b');
    expect(result.endsWith(body)).toBe(true);
  });

  it('handles CRLF files', () => {
    const source = '---\r\ntags: [homelab]\r\n---\r\nText\r\n';
    const result = addTag(source, 'neu');

    expect(tagsOf(result)).toEqual(['homelab', 'neu']);
    expect(result).toContain('Text\r\n');
  });

  it('ignores an empty tag', () => {
    expect(addTag('Text\n', '   ')).toBe('Text\n');
    expect(addTag('Text\n', '#')).toBe('Text\n');
  });

  it('strips a leading hash from the tag it adds', () => {
    expect(tagsOf(addTag('Text\n', '#neu'))).toEqual(['neu']);
  });
});

describe('removeTag', () => {
  it('removes from a flow list', () => {
    const result = removeTag('---\ntags: [homelab, proxmox]\n---\nText\n', 'proxmox');
    expect(tagsOf(result)).toEqual(['homelab']);
  });

  it('removes from a block list', () => {
    const result = removeTag('---\ntags:\n  - homelab\n  - proxmox\n---\nText\n', 'homelab');
    expect(tagsOf(result)).toEqual(['proxmox']);
  });

  it('is case-insensitive and tolerates a leading hash', () => {
    expect(tagsOf(removeTag('---\ntags: [Homelab]\n---\n', '#homelab'))).toEqual([]);
  });

  it('leaves a note without that tag alone', () => {
    const source = '---\ntags: [homelab]\n---\nText\n';
    expect(removeTag(source, 'gibtsnicht')).toBe(source);
  });

  it('does not touch inline tags in the body', () => {
    // Removing a word from the middle of somebody's prose is not what "untag"
    // means; only the frontmatter is metadata.
    const result = removeTag('---\ntags: [homelab]\n---\nText mit #homelab drin\n', 'homelab');
    expect(result).toContain('Text mit #homelab drin');
  });
});

import { describe, expect, it } from 'vitest';

import { parseNote } from '../src/markdown/parse.js';

describe('frontmatter', () => {
  it('reads a YAML block at the very start', () => {
    const note = parseNote('---\ntags: [homelab, proxmox]\nangelegt: 2026-05-14\n---\n# Titel\n');
    expect(note.frontmatter).toMatchObject({ tags: ['homelab', 'proxmox'] });
    expect(note.body).toBe('# Titel\n');
    expect(note.frontmatterError).toBeNull();
  });

  it('ignores a `---` further down, which is just a horizontal rule', () => {
    const source = '# Titel\n\n---\n\nAbschnitt zwei.\n';
    const note = parseNote(source);
    expect(note.frontmatter).toBeNull();
    expect(note.body).toBe(source);
  });

  it('keeps a `---` inside the body out of the closing-fence search', () => {
    const note = parseNote('---\ntitle: Test\n---\nDavor\n\n---\n\nDanach\n');
    expect(note.frontmatter).toMatchObject({ title: 'Test' });
    expect(note.body).toBe('Davor\n\n---\n\nDanach\n');
  });

  it('stays readable when the YAML is broken', () => {
    const note = parseNote('---\ntags: [unclosed\n---\nText\n');
    expect(note.frontmatter).toBeNull();
    expect(note.frontmatterError).not.toBeNull();
    expect(note.body).toBe('Text\n');
  });

  it('handles an empty block', () => {
    const note = parseNote('---\n\n---\nText\n');
    expect(note.body).toBe('Text\n');
  });
});

describe('wikilinks', () => {
  it('finds plain, aliased and heading forms', () => {
    const note = parseNote('Siehe [[Proxmox]], [[UniFi ZBF|die Firewall]] und [[LXC#Storage]].\n');
    expect(note.wikilinks).toHaveLength(3);
    expect(note.wikilinks[0]).toMatchObject({ target: 'Proxmox', alias: null, heading: null });
    expect(note.wikilinks[1]).toMatchObject({ target: 'UniFi ZBF', alias: 'die Firewall' });
    expect(note.wikilinks[2]).toMatchObject({ target: 'LXC', heading: 'Storage' });
  });

  it('handles target, heading and alias together', () => {
    const note = parseNote('[[Proxmox#Storage|hier]]\n');
    expect(note.wikilinks[0]).toMatchObject({
      target: 'Proxmox',
      heading: 'Storage',
      alias: 'hier',
    });
  });

  it('records the raw text so a rename can replace it verbatim', () => {
    const note = parseNote('vorher [[Alte Notiz|Anzeige]] nachher\n');
    const link = note.wikilinks[0]!;
    expect(link.raw).toBe('[[Alte Notiz|Anzeige]]');
    expect('vorher [[Alte Notiz|Anzeige]] nachher\n'.slice(link.offset, link.offset + link.raw.length))
      .toBe(link.raw);
  });

  it('reports offsets relative to the whole file, not the body', () => {
    const source = '---\ntitle: T\n---\n[[Ziel]]\n';
    const note = parseNote(source);
    const link = note.wikilinks[0]!;
    expect(source.slice(link.offset, link.offset + link.raw.length)).toBe('[[Ziel]]');
  });

  it('ignores brackets inside a fenced code block', () => {
    const note = parseNote('Echt: [[Proxmox]]\n\n```md\nBeispiel: [[Nicht Echt]]\n```\n');
    expect(note.wikilinks.map((l) => l.target)).toEqual(['Proxmox']);
  });

  it('ignores brackets inside an inline code span', () => {
    const note = parseNote('Schreibe `[[Ziel]]` um einen Link zu setzen. Echt: [[Ziel]]\n');
    expect(note.wikilinks).toHaveLength(1);
  });

  it('ignores brackets in a tilde fence and in one with an info string', () => {
    const note = parseNote('~~~\n[[A]]\n~~~\n\n```typescript\n[[B]]\n```\n\n[[C]]\n');
    expect(note.wikilinks.map((l) => l.target)).toEqual(['C']);
  });

  it('does not treat an unterminated backtick as a code span', () => {
    const note = parseNote('Ein ` einzelner Backtick und [[Ziel]]\n');
    expect(note.wikilinks).toHaveLength(1);
  });

  it('skips an empty target', () => {
    expect(parseNote('[[]] und [[   ]]\n').wikilinks).toHaveLength(0);
  });
});

describe('tags', () => {
  it('finds inline tags and merges them with frontmatter, frontmatter first', () => {
    const note = parseNote('---\ntags: [homelab]\n---\nText mit #proxmox und #vlan30\n');
    expect(note.tags).toEqual(['homelab', 'proxmox', 'vlan30']);
  });

  it('does not treat a heading as a tag', () => {
    const note = parseNote('# Überschrift\n\n## Zweite\n\n#echtertag\n');
    expect(note.tags).toEqual(['echtertag']);
  });

  it('does not treat a URL fragment or a number as a tag', () => {
    const note = parseNote('Siehe https://example.com/page#section und Ticket #42.\n');
    expect(note.tags).toEqual([]);
  });

  it('ignores a shebang inside a code fence', () => {
    const note = parseNote('```sh\n#!/bin/sh\n#kommentar\n```\n\n#echt\n');
    expect(note.tags).toEqual(['echt']);
  });

  it('supports nested and hyphenated tags', () => {
    const note = parseNote('#type/notiz #smart-home #ä_umlaut\n');
    expect(note.tags).toEqual(['type/notiz', 'smart-home', 'ä_umlaut']);
  });

  it('deduplicates case-insensitively but keeps the first spelling', () => {
    const note = parseNote('#Homelab und #homelab\n');
    expect(note.tags).toEqual(['Homelab']);
  });

  it('accepts a frontmatter tag list written as a string', () => {
    const note = parseNote('---\ntags: homelab, proxmox\n---\n');
    expect(note.tags).toEqual(['homelab', 'proxmox']);
  });

  it('strips a leading hash in frontmatter tags', () => {
    const note = parseNote('---\ntags: ["#homelab"]\n---\n');
    expect(note.tags).toEqual(['homelab']);
  });
});

describe('tasks', () => {
  it('finds open and done tasks with their line numbers', () => {
    const note = parseNote('# Offen\n\n- [ ] RAM prüfen\n- [x] Quorum verifiziert\n* [ ] Stern\n');
    expect(note.tasks).toEqual([
      { done: false, text: 'RAM prüfen', line: 3 },
      { done: true, text: 'Quorum verifiziert', line: 4 },
      { done: false, text: 'Stern', line: 5 },
    ]);
  });

  it('accepts an uppercase X and indented tasks', () => {
    const note = parseNote('  - [X] Erledigt\n');
    expect(note.tasks[0]).toMatchObject({ done: true, text: 'Erledigt' });
  });

  it('ignores task syntax inside a code fence', () => {
    const note = parseNote('```\n- [ ] Beispiel\n```\n\n- [ ] Echt\n');
    expect(note.tasks).toHaveLength(1);
    expect(note.tasks[0]?.text).toBe('Echt');
  });

  it('does not treat a plain list item as a task', () => {
    expect(parseNote('- Kein Task\n- [nicht] wirklich\n').tasks).toHaveLength(0);
  });
});

describe('external links', () => {
  it('finds Markdown links', () => {
    const note = parseNote('Siehe [die Doku](https://pve.proxmox.com/wiki) dazu.\n');
    expect(note.links[0]).toMatchObject({ text: 'die Doku', url: 'https://pve.proxmox.com/wiki' });
  });

  it('accepts a title and angle brackets', () => {
    const note = parseNote('[a](https://x.test "Titel") und [b](<https://y.test>)\n');
    expect(note.links.map((l) => l.url)).toEqual(['https://x.test', 'https://y.test']);
  });

  it('does not read a wikilink as an external link', () => {
    const note = parseNote('[[Ziel]](nicht-echt)\n');
    expect(note.links).toHaveLength(0);
    expect(note.wikilinks).toHaveLength(1);
  });
});

describe('real-world shapes', () => {
  it('survives a note that mixes everything, including CRLF', () => {
    const source = [
      '---',
      'tags: [homelab, proxmox]',
      '---',
      '# Proxmox Cluster',
      '',
      'Zwei Nodes, Qdevice auf [[dns01]]. Siehe `pct exec 120 -- docker ps`.',
      '',
      '```bash',
      '# nicht ein tag',
      'pct set 120 --memory 1024   # [[auch kein link]]',
      '```',
      '',
      '- [ ] RAM prüfen #wartung',
      '- [x] Quorum ok',
      '',
      'Mehr in [[UniFi ZBF|der Firewall-Notiz]] und auf [pve.proxmox.com](https://pve.proxmox.com).',
      '',
    ].join('\r\n');

    const note = parseNote(source);

    expect(note.frontmatter).toMatchObject({ tags: ['homelab', 'proxmox'] });
    expect(note.wikilinks.map((l) => l.target)).toEqual(['dns01', 'UniFi ZBF']);
    expect(note.tags).toEqual(['homelab', 'proxmox', 'wartung']);
    expect(note.tasks).toHaveLength(2);
    expect(note.links.map((l) => l.url)).toEqual(['https://pve.proxmox.com']);
  });

  it('handles an empty file and a file that is only frontmatter', () => {
    expect(parseNote('')).toMatchObject({ tags: [], wikilinks: [], tasks: [] });
    expect(parseNote('---\ntitle: Leer\n---\n').body).toBe('');
  });
});

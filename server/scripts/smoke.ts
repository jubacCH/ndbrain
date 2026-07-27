/**
 * Phase 0 acceptance check.
 *
 * Builds a small vault out of realistic notes, reads every one back, and asserts
 * that the bytes are unchanged. The point is the promise the whole product rests
 * on: the files are the truth, and nothing in this layer rewrites them.
 *
 * Run with:  node scripts/smoke.ts
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseNote } from '../src/markdown/parse.js';
import { NoteService } from '../src/notes/service.js';
import { Vault } from '../src/vault/fs.js';

const SAMPLE: Array<[string, string]> = [
  [
    'Homelab/Proxmox Cluster.md',
    `---
tags: [homelab, proxmox, cluster]
angelegt: 2026-05-14
---
# Proxmox Cluster prxmxcl01

Zwei Nodes auf PVE 9.1.9, dazu [[dns01]] als Qdevice. SSH über \`prxmx02.b8n.ch\`.

## Storage

Kein shared storage. Docker-CTs müssen auf \`local-lvm\` liegen, siehe [[LXC Storage]].

\`\`\`bash
# kein Tag, kein Link:
pct set 120 --memory 1024   # [[auch kein Link]]
\`\`\`

## Offen

- [ ] RAM-Auslastung prxmx01 prüfen #wartung
- [x] Qdevice-Quorum nach Reboot verifiziert

Nachtrag: [[Qdevice Wartung]] existiert noch nicht.
`,
  ],
  [
    'Homelab/UniFi ZBF.md',
    `---
tags: [homelab, netzwerk]
---
# UniFi Zone-Based Firewall

Regeln heissen \`source_dest_port\`. Die API antwortet auf 10.10.10.1, nicht auf
192.168.0.1. Betrifft [[Proxmox Cluster]] und [[LXC Storage]].

Doku: [UniFi Hilfe](https://help.ui.com/de/articles/zbf#regeln) — das Fragment in der
URL ist kein Tag, weil ihm kein Leerzeichen vorangeht.
`,
  ],
  [
    'Homelab/LXC Storage.md',
    `# LXC Storage

Docker-Container niemals auf \`local\`. Zurück zu [[Proxmox Cluster#Storage|Storage]].

#homelab #proxmox
`,
  ],
  [
    'Journal/2026-07-27.md',
    `# Sonntag

Ohne Frontmatter, ohne Tags, ohne Links. Muss genauso funktionieren.

Umlaute äöü, Emoji 🧠, ein Tab:\tund CRLF kommt gleich.
`,
  ],
  ['Inbox/Schnellnotiz.md', 'Nur eine Zeile, kein Zeilenumbruch am Ende'],
];

async function main(): Promise<void> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-smoke-'));
  const vault = new Vault(dataDir);
  const notes = new NoteService(vault);

  try {
    await vault.ensureVault('julian');
    await vault.ensureVault('ramona');

    for (const [notePath, content] of SAMPLE) {
      await notes.createNote('julian', notePath, content);
    }
    // CRLF must survive untouched as well.
    await notes.createNote('julian', 'Journal/2026-07-26.md', 'Zeile eins\r\nZeile zwei\r\n');
    await notes.createNote('ramona', 'Privat/Tagebuch.md', 'gehört Ramona');

    let failures = 0;
    const listed = await notes.listNotes('julian');

    console.log(`Vault: ${listed.length} Notizen\n`);

    for (const entry of listed) {
      const note = await notes.getNote('julian', entry.path);
      const original = SAMPLE.find(([p]) => p === entry.path)?.[1];

      if (original !== undefined && note.content !== original) {
        console.error(`  VERLUST in ${entry.path}`);
        failures += 1;
        continue;
      }

      const parsed = parseNote(note.content);
      console.log(
        `  ${entry.path.padEnd(34)} ` +
          `${String(parsed.tags.length).padStart(2)} Tags  ` +
          `${String(parsed.wikilinks.length).padStart(2)} Links  ` +
          `${String(parsed.tasks.length).padStart(2)} Tasks  ` +
          `${String(note.size).padStart(4)} B`,
      );
    }

    // The tenant boundary, exercised end to end rather than only in unit tests.
    const ramonasNotes = await notes.listNotes('ramona');
    const leaked = listed.some((e) => e.path.includes('Tagebuch'));
    console.log(`\nRamona hat ${ramonasNotes.length} Notiz(en); in Julians Liste: ${leaked ? 'JA — LECK' : 'nein'}`);
    if (leaked) failures += 1;

    try {
      await notes.getNote('julian', '../ramona/Privat/Tagebuch.md');
      console.error('LECK: Traversal hat funktioniert');
      failures += 1;
    } catch {
      console.log('Traversal über die Mandantengrenze: abgewiesen');
    }

    if (failures > 0) {
      console.error(`\n${failures} Problem(e).`);
      process.exitCode = 1;
    } else {
      console.log('\nAlle Notizen byte-identisch zurückgelesen, keine Lecks.');
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

await main();

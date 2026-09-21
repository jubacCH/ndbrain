/**
 * Phase 0 acceptance check.
 *
 * Builds a small vault out of realistic notes, reads every one back, and asserts
 * that the bytes are unchanged. The point is the promise the whole product rests
 * on: the files are the truth, and nothing in this layer rewrites them.
 *
 * Run with:  node scripts/smoke.ts
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { indexFile, loadConfig } from '../src/config.js';
import { Database } from '../src/db/database.js';
import { migrate } from '../src/db/schema.js';
import { Indexer } from '../src/index/indexer.js';
import { Queries } from '../src/index/queries.js';
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

    // ---- Phase 1: Index ---------------------------------------------------
    const db = new Database(':memory:');
    migrate(db);
    const indexer = new Indexer(db, notes);
    const q = new Queries(db);

    await indexer.rebuild('julian');
    await indexer.rebuild('ramona');

    const snapshot = JSON.stringify(
      db.all('SELECT path, hash FROM notes WHERE owner = ? ORDER BY path', 'julian'),
    );

    console.log('\nIndex');
    console.log(`  Notizen          ${q.countNotes('julian')}`);
    console.log(`  Tags             ${q.tagCounts('julian').map((t) => `${t.tag}(${t.count})`).join(' ')}`);
    console.log(`  Offene Aufgaben  ${q.openTasks('julian').length}`);
    console.log(`  Verwaist         ${q.orphans('julian').length}`);
    console.log(`  Ungetaggt        ${q.untagged('julian').length}`);
    console.log(`  Links ins Leere  ${q.deadLinks('julian').map((l) => l.targetRaw).join(', ') || '—'}`);

    const hits = q.search('julian', 'qdevice');
    console.log(`\nSuche "qdevice"  → ${hits.map((h) => h.path).join(', ') || 'nichts'}`);
    console.log(
      `Backlinks auf Proxmox Cluster.md → ` +
        `${q.backlinks('julian', 'julian', 'Homelab/Proxmox Cluster.md').map((l) => l.source).join(', ') || '—'}`,
    );

    if (q.search('ramona', 'qdevice').length > 0) {
      console.error('LECK: Ramonas Suche findet Julians Notiz');
      failures += 1;
    }

    // The central promise: the index holds nothing the files do not.
    const rebuilt = new Database(':memory:');
    migrate(rebuilt);
    await new Indexer(rebuilt, notes).rebuild('julian');
    const after = JSON.stringify(
      rebuilt.all('SELECT path, hash FROM notes WHERE owner = ? ORDER BY path', 'julian'),
    );
    rebuilt.close();

    if (after !== snapshot) {
      console.error('\nIndex nach Neuaufbau NICHT identisch');
      failures += 1;
    } else {
      console.log('\nIndex gelöscht und neu gebaut: identisch — die DB ist ein Cache.');
    }

    db.close();

    failures += await startRefusesAnUnmigratableIndex();

    if (failures > 0) {
      console.error(`\n${failures} Problem(e).`);
      process.exitCode = 1;
    } else {
      console.log('Alle Notizen byte-identisch zurückgelesen, keine Lecks.');
    }
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

await main();

/**
 * The one check that needs the built entry point rather than the modules:
 * a start that cannot happen says so in one line and exits non-zero.
 *
 * `migrate` refuses a database holding two accounts whose names differ only in
 * letter case, because it must not silently leave the unique index uncreated.
 * That refusal used to surface as an unhandled rejection with a stack, which a
 * container restarting in a loop printed again every second. Nothing under
 * `test/` can see this: it is about the process, and the process only exists
 * after `tsc`, which is exactly what `npm run smoke` runs first.
 */
async function startRefusesAnUnmigratableIndex(): Promise<number> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ndbrain-start-'));
  try {
    await fs.mkdir(path.dirname(indexFile({ ...loadConfig(), dataDir })), { recursive: true });
    const db = new Database(indexFile({ ...loadConfig(), dataDir }));
    migrate(db, 10);
    for (const id of ['julian', 'Julian']) {
      db.run(
        `INSERT INTO users (id, display_name, password_hash, role, created_at, disabled_at)
         VALUES (?, ?, 'x', 'user', 1, NULL)`,
        id,
        id,
      );
    }
    db.close();

    const entry = path.join(import.meta.dirname, '..', 'src', 'main.js');
    const started = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', entry], {
      env: { ...process.env, NDBRAIN_DATA_DIR: dataDir, NDBRAIN_PORT: '0' },
      encoding: 'utf8',
      timeout: 30_000,
    });

    const said = (started.stderr ?? '').trim();
    const lines = said === '' ? [] : said.split('\n');
    const ok =
      started.status === 1 &&
      lines.length === 1 &&
      lines[0]!.startsWith('ndbrain cannot start:') &&
      lines[0]!.includes('letter case') &&
      !said.includes('    at ');

    if (ok) {
      console.log(`\nStart auf einer unmigrierbaren DB: ${lines[0]}`);
      return 0;
    }
    console.error(
      `\nStart auf einer unmigrierbaren DB: Code ${started.status}, ${lines.length} Zeile(n):\n${said.slice(0, 500)}`,
    );
    return 1;
  } finally {
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

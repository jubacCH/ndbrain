/**
 * A server restart in the middle of a session, with a person doing the restart.
 *
 * The rooms live in one process's memory, so a restart takes them with it and
 * the next connection meets a room rebuilt from the file, under a new epoch.
 * This is the case that can duplicate a whole note: a client that syncs its old
 * document into the new room inserts the text a second time as its own
 * operations. `provider.ts` refuses that and reports `rebase`; the hook then
 * hands the text over through the ordinary save path.
 *
 * That refusal is what this checks, and it is worth checking against a real
 * server: the first version of this script left it out and duly produced a
 * duplicated note, which looked exactly like a defect in the server.
 *
 * It holds a session open and waits, so whoever restarts can take their time.
 * Writes and deletes one throwaway note.
 */

import { Y, done, open, pause, read, readPassword, remove, say, signIn, write, HOST } from './session.mjs';

const PATH = '_acceptance-restart.md';
const WAIT_MINUTES = 10;

const password = await readPassword();
let cookie = await signIn(password);
await write(cookie, PATH, 'Before the restart.\n');
say(true, 'throwaway note created', PATH);

const session = await open(cookie, PATH);
say(true, 'live session open', `epoch ${session.epoch}`);
session.type('Typed and persisted.\n');

await pause(2000);
say((await read(cookie, PATH))?.includes('Typed and persisted.') === true, 'typed text reached the file');
const heldBefore = session.text();

console.log(`
──────────────────────────────────────────────────────────────
  Restart the server now. This script notices the socket
  dropping and carries on by itself. Waiting up to
  ${WAIT_MINUTES} minutes; the throwaway note is cleaned up either way.
──────────────────────────────────────────────────────────────
`);

const until = Date.now() + WAIT_MINUTES * 60_000;
while (!session.isClosed() && Date.now() < until) await pause(1000);

if (!session.isClosed()) {
  console.log('No disconnect seen — nothing restarted. Cleaning up.');
  session.close();
  await remove(cookie, PATH);
  process.exit(0);
}
say(true, 'the open socket noticed the restart', `code ${session.closedAs()?.code}`);

// Wait for the server to answer again, so a failure below is about rooms and not
// about a server that has not finished starting.
for (let i = 0; i < 60; i += 1) {
  const probe = await fetch(`${HOST}/api/v1/health`).then((r) => r.json()).catch(() => null);
  if (probe?.status === 'ok') break;
  await pause(2000);
}
cookie = await signIn(password);
say((await read(cookie, PATH))?.includes('Typed and persisted.') === true, 'persisted text survived the restart');
say((await read(cookie, PATH))?.includes('Before the restart.') === true, 'the original line survived');

// The reconnect, carrying both the document and the epoch it belonged to.
const attempt = await open(cookie, PATH, { doc: session.doc, expectEpoch: session.epoch });
say(attempt.rebase === true, 'the old document is refused in the rebuilt room', 'reported rebase');

// What the hook does next: the save path, not the CRDT.
const handed = await write(cookie, PATH, session.doc.getText('content').toString());
say(handed.ok, 'the held text is handed over through the save path', `http ${handed.status}`);

const back = await open(cookie, PATH, { doc: new Y.Doc() });
await pause(1500);
const text = back.text();
say(back.epoch !== session.epoch, 'the fresh session is in the new room', `${session.epoch} → ${back.epoch}`);
say((text.match(/Typed and persisted\./g) ?? []).length === 1, 'nothing is duplicated after the rebase', JSON.stringify(text));
say((text.match(/Before the restart\./g) ?? []).length === 1, 'the original line appears once, not twice');
say(text.length >= heldBefore.length, 'nothing was lost', `${heldBefore.length} before, ${text.length} after`);

await pause(2000);
say((await read(cookie, PATH)) === back.text(), 'the file matches the session');

back.close();
await pause(300);
say((await remove(cookie, PATH)).ok, 'throwaway note deleted');
done();

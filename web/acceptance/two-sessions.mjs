/**
 * Two people on one note, and a rename underneath them.
 *
 * The part a unit test cannot reach: whether two sockets through the real proxy
 * actually converge, whether what they agree on is what lands in the file, and
 * whether typing survives the note being moved while both are open.
 *
 * Writes and deletes one throwaway note in the account it signs in as.
 */

import { done, open, pause, read, readPassword, remove, say, signIn, write, HOST, OWNER } from './session.mjs';

const PATH = '_acceptance-two-sessions.md';
const MOVED = 'Acceptance/_acceptance-moved.md';

const cookie = await signIn(await readPassword());
say(true, 'signed in', `${HOST} as ${OWNER}`);

await write(cookie, PATH, 'Start.\n');
say(true, 'throwaway note created', PATH);

const a = await open(cookie, PATH);
const b = await open(cookie, PATH);
say(a.epoch !== undefined, 'both sessions got a hello', `epoch ${a.epoch}`);
say(a.epoch === b.epoch, 'both are in the same room');
say(a.canWrite === true, 'the session may write');

a.type('From A.\n');
await pause(700);
say(b.text().includes('From A.'), 'B sees what A typed', JSON.stringify(b.text()));

b.type('From B.\n');
await pause(700);
say(a.text().includes('From B.'), 'A sees what B typed');
say(a.text() === b.text(), 'both hold the same text', `${a.text().length} chars`);
say(a.text().includes('Start.'), 'the text that was already there survived');

// Past the persist debounce, so the file is settled.
await pause(1800);
const onDisk = await read(cookie, PATH);
say(onDisk === a.text(), 'the file matches what both sessions hold', JSON.stringify(onDisk));
say(
  (onDisk.match(/From A\./g) ?? []).length === 1 && (onDisk.match(/From B\./g) ?? []).length === 1,
  'nothing was written twice',
);

// A rename while both are open. The sessions should follow the note, and the old
// path must not come back to life.
await fetch(`${HOST}/api/v1/rename`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie },
  body: JSON.stringify({ from: PATH, to: MOVED }),
});
await pause(900);
const moved = a.control.find((m) => m.type === 'moved');
say(moved !== undefined, 'the open session is told it moved', moved?.path ?? 'no control message');

a.type('After the rename.\n');
await pause(1900);
say((await read(cookie, MOVED))?.includes('After the rename.') === true, 'typing after a rename lands in the moved note');
say((await read(cookie, PATH)) === null, 'nothing reappeared at the old path');

a.close();
b.close();
await pause(300);
say((await remove(cookie, MOVED)).ok, 'throwaway note deleted');
done();

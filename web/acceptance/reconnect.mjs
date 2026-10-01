/**
 * A connection lost and resumed, with text typed while it was gone.
 *
 * The common case — a laptop asleep, a network dropping — and the one that can
 * duplicate text: a client comes back holding a document and replays it into a
 * room that may already have the same content. The room survives here, so the
 * epoch does not change and the reconnect is an ordinary sync; `restart.mjs`
 * covers the harder case where the room was rebuilt.
 *
 * Writes and deletes one throwaway note.
 */

import { Y, done, open, pause, read, readPassword, remove, say, signIn, write } from './session.mjs';

const PATH = '_acceptance-reconnect.md';

const cookie = await signIn(await readPassword());
await write(cookie, PATH, 'Beginning.\n');
say(true, 'throwaway note created', PATH);

// The second session stays up across the outage, so the room is never empty and
// the returning client meets a room that already holds its text.
const stays = await open(cookie, PATH);
const drops = await open(cookie, PATH);
say(stays.epoch === drops.epoch, 'both are in the same room', stays.epoch);

drops.type('Before the line went.\n');
await pause(700);
say(stays.text().includes('Before the line went.'), 'the other session got it');

const held = drops.doc;
drops.socket.close();
await pause(1200);
say(drops.isClosed(), 'the socket is closed', `code ${drops.closedAs()?.code}`);

held.getText('content').insert(held.getText('content').length, 'Typed offline.\n');
say((await read(cookie, PATH))?.includes('Typed offline.') !== true, 'offline typing did not reach the server');

// Meanwhile the room moves on without us.
stays.type('From the other side meanwhile.\n');
await pause(700);

// Back with the same document and the same epoch, so this is a plain sync.
const back = await open(cookie, PATH, { doc: held, expectEpoch: stays.epoch });
say(back.rebase === false, 'the room is the same one, so no rebase was needed');
await pause(1100);
const text = back.text();

say((text.match(/Before the line went\./g) ?? []).length === 1, 'what was typed before the outage appears once', JSON.stringify(text));
say((text.match(/Beginning\./g) ?? []).length === 1, 'the original line appears once');
say(text.includes('Typed offline.'), 'what was typed offline survived the reconnect');
say(text.includes('From the other side meanwhile.'), 'what the other session wrote meanwhile is there');
say(back.text() === stays.text(), 'both sessions agree again', `${back.text().length} chars`);

await pause(1800);
say((await read(cookie, PATH)) === back.text(), 'the file matches both sessions');

stays.close();
back.close();
await pause(300);
say((await remove(cookie, PATH)).ok, 'throwaway note deleted');
done();

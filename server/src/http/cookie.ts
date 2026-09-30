/**
 * The session cookie's name, in a module of its own.
 *
 * `collab/socket.ts` needs it to read the token off the upgrade request, and
 * `http/server.ts` registers that route — so importing the name from there
 * would put the two modules in a cycle. It is re-exported from `server.ts`,
 * which is where everything else already asks for it.
 */
export const SESSION_COOKIE = 'ndbrain_session';

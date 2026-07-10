import { Hocuspocus, type Configuration } from "@hocuspocus/server";

export type CollabServerOptions = Partial<Configuration>;

/**
 * Thin factory over the installed Hocuspocus server.
 *
 * Returns the bare `Hocuspocus` collaboration-protocol instance — it owns no
 * HTTP/WebSocket listener of its own. A host process (Fastify) forwards its
 * own WebSocket upgrades into it via `instance.handleConnection(ws, request,
 * context)`, so Fastify keeps ownership of the port.
 *
 * Persistence and auth hooks (`onLoadDocument`/`onStoreDocument`/
 * `onAuthenticate`) are intentionally NOT wired here yet — later tasks add
 * them, routed through `NoteService` per the collab plan's constraints.
 */
export function createCollabServer(opts: CollabServerOptions = {}): Hocuspocus {
  return new Hocuspocus(opts);
}

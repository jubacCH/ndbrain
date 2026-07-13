import type { AuthService } from "../http/auth.js";
import type { ApiKeyService } from "../keys/service.js";
import { isPathInScope } from "../keys/scope.js";
import { Vault, VaultPathError } from "../vault/files.js";

/** Thrown for any authentication/authorization failure. Hocuspocus's
 *  `onAuthenticate` hook rejects the connection when this handler throws, so
 *  every rejection path below (missing token, invalid token, out-of-scope
 *  doc, malformed doc path) simply throws this — the caller never needs to
 *  distinguish "doesn't exist" from "not allowed" (no existence leak). */
export class CollabAuthError extends Error {}

/** Result of a successful collab authentication. */
export interface CollabAuthResult {
  /** Attributed as the git commit author for edits from this connection
   *  (username for a human session, key name for an API key). */
  actor: string;
  /** true if this connection may only read (read-only API key scope). */
  readOnly: boolean;
  /** Canonical (normalized) document name. Clients should key their
   *  Y.Docs by this normalized name to avoid duplicate docs for
   *  equivalent paths (e.g., "myai/x.md" and "myai/./x.md"). */
  documentName: string;
}

// Reuse Vault purely for `assertSafePath`, which is a pure string check and
// never touches `rootDir` (see the same pattern/reasoning in
// collab/document-manager.ts). Avoids threading a Vault dependency through
// here just to validate a path.
const pathValidator = new Vault("");

/** `Vault.assertSafePath`, wrapped to fail closed as `CollabAuthError` (never
 *  leaking the raw `VaultPathError`) — shared by every branch below that needs
 *  to normalize/validate `documentName` before trusting it. */
function assertSafeDocumentPath(documentName: string): string {
  try {
    return pathValidator.assertSafePath(documentName);
  } catch (err) {
    if (err instanceof VaultPathError) {
      throw new CollabAuthError("invalid document path");
    }
    throw err;
  }
}

/**
 * Authenticates a Hocuspocus collab connection: `params.token` may be either
 * a human session token (from `AuthService.login`) or an agent API key
 * (`ndb_<hex>`, from `ApiKeyService.create`).
 *
 * Dispatch rule: a token starting with `ndb_` is treated as an API key;
 * anything else is treated as a session token. This matches the two token
 * formats produced by the system (opaque 64-hex session tokens vs.
 * `ndb_`-prefixed keys) and lets each branch fail with a single, specific
 * reason instead of silently falling through to the other check.
 *
 * - Session (human): full-vault read-write. Scope is a key-only concept, so
 *   `documentName` is not scope-checked, but it must still pass
 *   `assertSafePath` — a malformed/traversal path is rejected either way.
 * - API key (agent): `documentName` must pass `assertSafePath` first (so
 *   normalization happens before the scope check — a raw `..` segment must
 *   never sneak past a prefix match), then must be in the key's scope.
 *   Out-of-scope throws the same generic error as "doesn't exist" so the
 *   connection reveals nothing about the vault's contents.
 *
 * `params.sessionCookie` (I1): a browser reload leaves the web client with a
 * valid `ndbrain_session` cookie but no in-memory collab token yet (no
 * `/whoami` round trip has happened before the Editor opens its `/collab`
 * connection), so `token` arrives empty and the connection would otherwise be
 * rejected outright until the user logs out and back in. This fallback is
 * deliberately narrow: it only ever runs when NO `token` was supplied at all
 * — a token that WAS supplied (an api-key, or a session token that turns out
 * to be invalid/expired) is resolved entirely on its own branch above and
 * never falls through to the cookie, so an out-of-scope or otherwise-rejected
 * token can never silently escalate into full-vault human access just
 * because a session cookie happens to also be present. A valid cookie
 * authenticates at the same trust level as the existing session-token branch
 * (full-vault read-write, canonical-path-checked); an invalid/missing cookie
 * falls through to the same "missing token" rejection as before.
 *
 * On success, returns the canonical (normalized) document name so the caller
 * can key the Y.Doc by the normalized path, preventing duplicate docs for
 * equivalent paths.
 *
 * Any failure (no token, invalid/expired/revoked token, out-of-scope doc,
 * malformed doc path) throws `CollabAuthError`, which the Hocuspocus
 * `onAuthenticate` hook maps to a rejected connection.
 */
export async function authenticateCollab(
  deps: { auth: AuthService; apiKeys: ApiKeyService },
  params: { token?: string; documentName: string; sessionCookie?: string },
): Promise<CollabAuthResult> {
  const { token, documentName, sessionCookie } = params;

  if (!token) {
    if (sessionCookie) {
      const session = deps.auth.validateSession(sessionCookie);
      if (session) {
        const safePath = assertSafeDocumentPath(documentName);
        return { actor: session.username, readOnly: false, documentName: safePath };
      }
    }
    throw new CollabAuthError("missing token");
  }

  if (token.startsWith("ndb_")) {
    const validated = await deps.apiKeys.validate(token);
    if (!validated) throw new CollabAuthError("invalid api key");

    // assertSafePath before the scope check: it normalizes the path, so a
    // traversal segment is rejected outright rather than compared (and
    // potentially prefix-matched) as raw text.
    const safePath = assertSafeDocumentPath(documentName);

    if (!isPathInScope(validated.scope, safePath)) {
      throw new CollabAuthError("document out of scope");
    }

    return {
      actor: validated.name,
      readOnly: !validated.scope.canWrite,
      documentName: safePath,
    };
  }

  const session = deps.auth.validateSession(token);
  if (!session) throw new CollabAuthError("invalid session");

  // No scope check for humans, but the path still must be well-formed.
  const safePath = assertSafeDocumentPath(documentName);

  return { actor: session.username, readOnly: false, documentName: safePath };
}

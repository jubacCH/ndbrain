/** CodeMirror 6 markdown editor with live Yjs collaboration + remote cursors.
 *
 *  Real API shapes verified against the installed packages (versions pinned in
 *  `package.json` - see the Task 6 report for the full trace):
 *
 *  - `codemirror@6.0.2`'s own package (not `@codemirror/basic-setup`, which is
 *    the deprecated pre-6.0 name) exports `basicSetup` - a bundled Extension
 *    (keymap, line numbers, history, bracket matching, etc.) plus re-exports
 *    `EditorView` from `@codemirror/view`.
 *  - `@codemirror/lang-markdown`'s `markdown()` returns the language Extension.
 *  - `y-codemirror.next@0.3.5`'s `yCollab(ytext, awareness, opts?)` returns a
 *    single Extension bundling `ySync` (the actual CRDT<->CodeMirror binding),
 *    `yRemoteSelections` (remote peers' cursor/selection decorations, reading
 *    `awareness state.user.{name,color}` - see `y-remote-selections.js`) and
 *    its base theme. This is what gives BOTH live sync and visible remote
 *    cursors for free - no manual decoration wiring needed for the human/human
 *    or human/agent case alike, EXCEPT for the agent-vs-human visual
 *    distinction: `yRemoteSelections`'s caret widget renders `state.user.name`
 *    as plain text with no hook for extra styling/markup per peer, and forking
 *    it just to prefix a label was not worth the maintenance cost. Instead
 *    `collab-cursors.ts`'s `agentActivityLabel` renders a separate "🤖 <agent>
 *    is editing…" line next to the editor (see the status bar below) - the
 *    in-editor cursor for an agent still appears (via yCollab), just without
 *    the 🤖 prefix baked into that specific widget.
 *
 *  Connection lifecycle: `provider.on("status", ...)` fires
 *  `{ status: "connecting" | "connected" | "disconnected" }` (verified against
 *  `@hocuspocus/provider`'s `WebSocketStatus` enum) - mapped to this
 *  component's own `connecting`/`connected`/`offline` status dot.
 */

import { useContext, useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { yCollab } from "y-codemirror.next";
import { createCollabProvider, type CollabProviderHandle } from "../api/collab";
import { AuthContext } from "../auth/useAuth";
import { agentActivityLabel, colorForName, peersFromAwarenessStates, type Peer } from "./collab-cursors";
import styles from "./Editor.module.css";

/** Constructs a live collab connection for one note. Matches
 *  `createCollabProvider`'s signature (`../api/collab.ts`) - injectable so
 *  tests can supply a fake and never open a real WebSocket (see
 *  `Editor.test.tsx`). */
export type ProviderFactory = (opts: { path: string; token: string | null }) => CollabProviderHandle;

export interface EditorProps {
  /** Vault-relative path of the note to edit, e.g. "myai/deploy.md". */
  path: string;
  /** Collab auth token, from `ApiClient.getCollabToken()`; null while not
   *  logged in yet (the provider then connects with an empty-string token,
   *  which the server rejects - the caller is expected to only render
   *  `<Editor>` once authenticated). */
  token: string | null;
  /** Overrides the real provider factory. Defaults to `createCollabProvider`;
   *  tests inject a fake handle instead. */
  providerFactory?: ProviderFactory;
}

type ConnectionStatus = "connecting" | "connected" | "offline" | "authFailed";

function statusLabel(status: ConnectionStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting…";
    case "offline":
      return "Offline";
    case "authFailed":
      return "Authentication failed";
  }
}

export function Editor({ path, token, providerFactory = createCollabProvider }: EditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peers, setPeers] = useState<Peer[]>([]);

  // Read auth context directly (rather than requiring `<Editor>` to receive a
  // `username` prop) so its exact call-site signature stays `{ path, token }`,
  // matching what the shell wires it up with (see the Task 6 brief). Reading
  // via `useContext(AuthContext)` rather than the throwing `useAuth()` hook
  // also means a render-smoke test doesn't need a full `<AuthProvider>` tree -
  // it just falls back to "Anonymous" when there's no context at all.
  const authCtx = useContext(AuthContext);
  const username = authCtx?.username ?? "Anonymous";

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    setStatus("connecting");
    setPeers([]);

    const handle = providerFactory({ path, token });
    const { provider, ytext } = handle;
    const awareness = provider.awareness;

    awareness?.setLocalStateField("user", { name: username, color: colorForName(username) });

    const updatePeers = () => {
      const localClientId = provider.document.clientID;
      setPeers(peersFromAwarenessStates(awareness?.getStates() ?? new Map(), localClientId));
    };
    updatePeers();

    const onStatus = ({ status: nextStatus }: { status: string }) => {
      setStatus(nextStatus === "connected" ? "connected" : nextStatus === "connecting" ? "connecting" : "offline");
    };
    // A bad/expired token doesn't surface via "status" at all — the socket stays
    // in "connecting" and Hocuspocus just keeps retrying forever, which used to
    // look identical to a normal reconnect. `authenticationFailed` fires once
    // the server rejects the token, so it gets a distinct, non-retrying status.
    const onAuthenticationFailed = () => setStatus("authFailed");
    provider.on("status", onStatus);
    provider.on("authenticationFailed", onAuthenticationFailed);
    provider.on("awarenessUpdate", updatePeers);
    provider.on("awarenessChange", updatePeers);

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [basicSetup, markdown(), ...(awareness ? [yCollab(ytext, awareness)] : [])],
      }),
    });

    return () => {
      view.destroy();
      provider.off("status", onStatus);
      provider.off("authenticationFailed", onAuthenticationFailed);
      provider.off("awarenessUpdate", updatePeers);
      provider.off("awarenessChange", updatePeers);
      handle.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, token, username, providerFactory]);

  const agentLabel = agentActivityLabel(peers);
  const humanPeers = peers.filter((peer) => !peer.agent);

  return (
    <div className={styles.editor}>
      <div className={styles.statusBar}>
        <span className={`${styles.statusDot} ${styles[status]}`} aria-hidden="true" />
        <span className={styles.statusLabel}>{statusLabel(status)}</span>

        {humanPeers.length > 0 && (
          <span className={styles.peers} aria-label="Other people editing this note">
            {humanPeers.map((peer) => (
              <span key={peer.clientId} className={styles.peer} style={{ color: peer.color }}>
                ● {peer.name}
              </span>
            ))}
          </span>
        )}

        {agentLabel && (
          <span className={styles.agentBadge} role="status">
            {agentLabel}
          </span>
        )}
      </div>

      <div ref={hostRef} className={styles.host} data-testid="editor-host" />
    </div>
  );
}

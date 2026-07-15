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
import { Prec, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { GFM } from "@lezer/markdown";
import { yCollab } from "y-codemirror.next";
import { createCollabProvider, type CollabProviderHandle } from "../api/collab";
import { AuthContext } from "../auth/useAuth";
import { agentActivityLabel, colorForName, peersFromAwarenessStates, type Peer } from "./collab-cursors";
import { livePreviewExtensions, rawCompartment, setRawMode } from "./live-preview/extensions";
import { MermaidEditPanel } from "./live-preview/MermaidEditPanel.tsx";
import { applyMermaidEdit, mermaidEditorHandler, type MermaidEditRequest } from "./live-preview/mermaidEditor";
// Explicit `.tsx` suffix: on a case-insensitive filesystem, a bare
// `"./live-preview/Toolbar"` specifier can wrongly resolve to the sibling
// `toolbar.ts` (formatting commands) instead of this component (Task 7
// finding) - the extension pins it to the right file.
import { EditorToolbar } from "./live-preview/Toolbar.tsx";
import { formatKeymap } from "./live-preview/toolbar";
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
  // Holds the live `EditorView` so the raw/formatted toggle below can reach it
  // without forcing a remount - the view itself is still created/destroyed by
  // the connection effect further down, this ref just makes it externally
  // reachable in between.
  const viewRef = useRef<EditorView | null>(null);
  // Mirrors `viewRef` in React state, purely so `<EditorToolbar>` (which needs
  // the view as a prop to dispatch formatting commands) re-renders once the
  // real view exists - set at the end of the mount effect below and cleared
  // in its cleanup. Kept separate from `viewRef` (rather than replacing it)
  // so the connection effect's dependency array doesn't have to change: code
  // that only needs synchronous access to the current view (the raw-mode
  // effect, the mermaid-save handler) keeps reading `viewRef`.
  const [view, setView] = useState<EditorView | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peers, setPeers] = useState<Peer[]>([]);
  // Raw (plain markdown source, today's behavior) vs. formatted (live-preview
  // decorations) display mode. Default is formatted (`false`) - see
  // `live-preview/extensions.ts`. The actual toggle button is a later task
  // (Plan 7 Task 7's `EditorToolbar`); this is the state + wiring it will
  // call into.
  const [raw, setRaw] = useState(false);
  // The diagram currently open in the split edit panel (Plan 7 Task 6), or
  // null when it's closed - drives whether `<MermaidEditPanel>` renders at
  // all. Set by clicking a rendered diagram, via `mermaidEditorHandler`
  // below.
  const [mermaidEdit, setMermaidEdit] = useState<MermaidEditRequest | null>(null);
  // The live "open the split editor" handler the `mermaidEditorHandler`
  // facet extension (added to the view's extensions once, below) forwards
  // to. Written directly during render (not in an effect) so it's always
  // current by the time a click can reach it - same pattern as
  // `LocalEditor.tsx`'s `onChangeRef`.
  const openMermaidEditorRef = useRef<(request: MermaidEditRequest) => void>(() => {});
  openMermaidEditorRef.current = (request) => setMermaidEdit(request);
  // Mirrors `raw` for the connection effect below (which intentionally does
  // NOT depend on `raw` - toggling it must never tear down/recreate the
  // collab connection or the `EditorView`), so a freshly (re)mounted view
  // (e.g. after a `path` change) still starts in whatever mode was last set.
  const rawRef = useRef(raw);

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
        extensions: [
          basicSetup,
          // `Mod-i` collides with `basicSetup`'s own `defaultKeymap` binding
          // (`selectParentSyntax`, with `preventDefault: true`) - verified
          // live against the installed `@codemirror/commands@6.10.4`.
          // `Prec.high` makes these bindings win regardless of extension
          // array order, without needing to fork or reorder `basicSetup`.
          Prec.high(keymap.of(formatKeymap)),
          markdown({ extensions: [GFM] }),
          rawCompartment.of(livePreviewExtensions()),
          mermaidEditorHandler.of((request) => openMermaidEditorRef.current(request)),
          ...(awareness ? [yCollab(ytext, awareness)] : []),
        ],
      }),
    });
    viewRef.current = view;
    // Sync the freshly created view to whatever raw/formatted mode was last
    // set (see `rawRef`'s doc comment above) - a no-op the first time round,
    // since the compartment already starts formatted and `raw` defaults to
    // `false`.
    setRawMode(view, rawRef.current);
    setView(view);

    return () => {
      viewRef.current = null;
      setView(null);
      view.destroy();
      provider.off("status", onStatus);
      provider.off("authenticationFailed", onAuthenticationFailed);
      provider.off("awarenessUpdate", updatePeers);
      provider.off("awarenessChange", updatePeers);
      handle.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, token, username, providerFactory]);

  // Applies a `raw` toggle to the already-mounted view in place (via the
  // compartment), instead of remounting the whole editor - see
  // `live-preview/extensions.ts`'s `setRawMode`.
  useEffect(() => {
    rawRef.current = raw;
    if (viewRef.current) setRawMode(viewRef.current, raw);
  }, [raw]);

  const agentLabel = agentActivityLabel(peers);
  const humanPeers = peers.filter((peer) => !peer.agent);

  return (
    <div className={styles.editor}>
      <EditorToolbar view={view} raw={raw} onToggleRaw={() => setRaw((current) => !current)} />

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

      {mermaidEdit && (
        <MermaidEditPanel
          code={mermaidEdit.code}
          onSave={(newCode) => {
            if (viewRef.current) applyMermaidEdit(viewRef.current, mermaidEdit, newCode);
            setMermaidEdit(null);
          }}
          onClose={() => setMermaidEdit(null)}
        />
      )}
    </div>
  );
}

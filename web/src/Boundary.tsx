/**
 * The last line of defence against a render fault.
 *
 * Without one of these, a single thrown error inside any component unmounts the
 * entire tree and leaves a blank white page with no way back but a reload. For a
 * tool that stays open all day and can be holding text that has not reached the
 * server yet, that is the wrong default: the blank page destroys the one copy of
 * a sentence that only existed in the editor.
 *
 * So this does two things beyond showing a message. It offers a reload, and — for
 * the case that actually costs something — it hands back whatever the editor had
 * pending, as text, to be copied out. A recovery path nobody can use is
 * decoration; the whole point is that the paragraph survives.
 *
 * Deliberately a class. Error boundaries are the one thing React still has no
 * hook for, and wrapping a class to look modern would add a layer without adding
 * anything.
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Where the shell parks unsaved text.
 *
 * Set by the save path on every keystroke burst and cleared once the write is
 * acknowledged, so it is only ever non-empty when there is genuinely something
 * that has not reached the server. Read through the window rather than passed as
 * a prop, because by the time this component renders, the tree that held the
 * prop is exactly what has just been torn down.
 */
declare global {
  interface Window {
    __ndbrainPending?: { path: string; content: string } | null;
  }
}

interface State {
  error: Error | null;
}

export class Boundary extends Component<{ children: ReactNode }, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged rather than swallowed: with no error tracking in place, the browser
    // console is the only record of what actually broke.
    console.error('ndBrain crashed while rendering', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const pending = window.__ndbrainPending ?? null;

    return (
      <div className="crash" role="alert">
        <div className="crash-box">
          <h1>ndBrain stopped drawing this page</h1>
          <p>
            Something in the interface threw an error. Your notes on the server are untouched — this
            went wrong in the browser, after they were saved.
          </p>

          {pending !== null && pending.content !== '' && (
            <>
              <p className="crash-warn">
                One note had changes that had not reached the server yet. Copy them out before
                reloading:
              </p>
              <p className="crash-path">{pending.path}</p>
              <textarea readOnly value={pending.content} spellCheck={false} />
            </>
          )}

          <div className="crash-actions">
            <button type="button" onClick={() => window.location.reload()}>
              Reload
            </button>
          </div>

          <details>
            <summary>What went wrong</summary>
            <pre>{`${error.name}: ${error.message}`}</pre>
          </details>
        </div>
      </div>
    );
  }
}

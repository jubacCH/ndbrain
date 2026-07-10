import type * as Y from "yjs";
import type { NoteService } from "../notes/service.js";
import { Vault } from "../vault/files.js";
import { seedYText } from "./serialize.js";

/** The field name under which note content lives in every note's Y.Doc. */
export const CONTENT_FIELD = "content";

// `assertSafePath` is a pure path check (it never touches `rootDir`), so a
// throwaway instance is enough to reuse it here without threading a `Vault`
// dependency through `DocumentManager`'s constructor.
const pathValidator = new Vault("");

/**
 * Owns the live Y.Doc registry for open notes and the load/unload lifecycle
 * around Hocuspocus's `onLoadDocument`/`afterUnloadDocument` hooks.
 *
 * Persistence back to the vault (Task 4) and external-change rebase (Task 5)
 * are deliberately out of scope here — this is load + registry only.
 */
export class DocumentManager {
  private readonly live = new Map<string, Y.Doc>();

  constructor(private readonly deps: { notes: NoteService }) {}

  /** The shared content `Y.Text` for a note's `Y.Doc`. */
  getText(ydoc: Y.Doc): Y.Text {
    return ydoc.getText(CONTENT_FIELD);
  }

  /** Whether a `Y.Doc` is currently loaded/registered as live for `path`. */
  isLive(path: string): boolean {
    return this.live.has(path);
  }

  /**
   * Seeds `ydoc`'s content from the note at `path` and registers it as live.
   * A missing note (new note) seeds an empty text rather than failing.
   */
  async load(path: string, ydoc: Y.Doc): Promise<void> {
    pathValidator.assertSafePath(path);
    const markdown = await this.deps.notes.read(path);
    seedYText(this.getText(ydoc), markdown ?? "");
    this.live.set(path, ydoc);
  }

  /** Removes the live registry entry for `path`. */
  unload(path: string): void {
    this.live.delete(path);
  }
}

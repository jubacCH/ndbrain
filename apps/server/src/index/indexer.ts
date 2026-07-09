import type { Database } from "../db/database.js";
import { parseNote } from "../vault/parser.js";
import type { Vault } from "../vault/files.js";

/** Keeps the SQLite index (notes, notes_fts, links) in sync with note content. */
export class Indexer {
  constructor(private db: Database) {}

  indexNote(path: string, raw: string): void {
    const { frontmatter, body, title, links } = parseNote(raw);
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO notes (path, title, frontmatter_json, updated_at)
           VALUES (?,?,?,datetime('now'))
           ON CONFLICT(path) DO UPDATE SET title=excluded.title,
             frontmatter_json=excluded.frontmatter_json, updated_at=excluded.updated_at`,
        )
        .run(path, title, JSON.stringify(frontmatter));
      this.db.prepare("DELETE FROM notes_fts WHERE path=?").run(path);
      this.db.prepare("INSERT INTO notes_fts (path, title, body) VALUES (?,?,?)").run(path, title ?? "", body);
      this.db.prepare("DELETE FROM links WHERE source_path=?").run(path);
      const insertLink = this.db.prepare("INSERT OR IGNORE INTO links (source_path, target) VALUES (?,?)");
      for (const target of links) insertLink.run(path, target);
    });
    tx();
  }

  removeNote(path: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM notes WHERE path=?").run(path);
      this.db.prepare("DELETE FROM notes_fts WHERE path=?").run(path);
      this.db.prepare("DELETE FROM links WHERE source_path=?").run(path);
    });
    tx();
  }

  renameNote(from: string, to: string, raw: string): void {
    this.removeNote(from);
    this.indexNote(to, raw);
  }

  async reindexAll(vault: Vault): Promise<number> {
    this.db.exec("DELETE FROM notes; DELETE FROM notes_fts; DELETE FROM links;");
    const paths = await vault.list();
    for (const path of paths) {
      const raw = await vault.read(path);
      if (raw !== null) this.indexNote(path, raw);
    }
    return paths.length;
  }
}

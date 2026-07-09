import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import type { Database } from "../db/database.js";

/** Local username/password auth with opaque session tokens (30 days). */
export class AuthService {
  constructor(private db: Database) {}

  hasUsers(): boolean {
    return (this.db.prepare("SELECT count(*) c FROM users").get() as { c: number }).c > 0;
  }

  async createUser(username: string, password: string): Promise<void> {
    const passwordHash = await argon2.hash(password);
    this.db.prepare("INSERT INTO users (username, password_hash) VALUES (?,?)").run(username, passwordHash);
  }

  async login(username: string, password: string): Promise<string | null> {
    const user = this.db.prepare("SELECT id, password_hash FROM users WHERE username=?").get(username) as
      | { id: number; password_hash: string }
      | undefined;
    if (!user || !(await argon2.verify(user.password_hash, password))) return null;
    const token = randomBytes(32).toString("hex");
    this.db
      .prepare("INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,datetime('now','+30 days'))")
      .run(token, user.id);
    return token;
  }

  validateSession(token: string): { userId: number; username: string } | null {
    const row = this.db
      .prepare(
        `SELECT u.id AS userId, u.username FROM sessions s JOIN users u ON u.id=s.user_id
         WHERE s.token=? AND s.expires_at > datetime('now')`,
      )
      .get(token) as { userId: number; username: string } | undefined;
    return row ?? null;
  }

  logout(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token=?").run(token);
  }
}

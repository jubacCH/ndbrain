/**
 * Per-account preferences that change what the server answers.
 *
 * Deliberately a short list, and it will stay short. Almost everything a person
 * can adjust — a theme, a text size, which view opens first, whether sort
 * prefixes are shown — is a property of the screen they are sitting at, and lives
 * in that browser. Storing those here would make a phone and a desktop overwrite
 * each other's preferences all day.
 *
 * What belongs here is anything the *server* has to know to answer the same
 * question the same way twice. So far that is one thing: how long a note may sit
 * untouched before the tool calls it stale. That number decides which notes are
 * reported as needing attention, which is a judgement about somebody's vault
 * rather than a fact about it — so it has to be theirs to make, and it has to be
 * the same judgement whichever device asks.
 *
 * Values are validated on the way in and clamped on the way out. A settings row
 * is user input that has been sitting in a database for months; trusting it
 * because it is "internal" is how a stored value becomes a division by zero long
 * after anybody remembers writing it.
 */

import type { Database } from '../db/database.js';

export interface UserSettings {
  /**
   * Days a note may go untouched before it counts as stale.
   *
   * Zero would mean every note is stale the moment it is saved, so the floor is
   * a day; the ceiling keeps the finding meaningful rather than switching it off
   * by setting a century.
   */
  staleDays: number;
}

export const DEFAULT_SETTINGS: UserSettings = {
  staleDays: 42,
};

export const STALE_DAYS_MIN = 1;
export const STALE_DAYS_MAX = 3650;

function clampStaleDays(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_SETTINGS.staleDays;
  return Math.min(STALE_DAYS_MAX, Math.max(STALE_DAYS_MIN, Math.trunc(value)));
}

export class SettingsService {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  get(userId: string): UserSettings {
    const rows = this.#db.all('SELECT key, value FROM user_settings WHERE user_id = ?', userId);

    const settings = { ...DEFAULT_SETTINGS };
    for (const row of rows) {
      if (String(row['key']) === 'staleDays') {
        settings.staleDays = clampStaleDays(Number(row['value']));
      }
    }
    return settings;
  }

  /**
   * Writes the settings a caller sent, ignoring what it did not.
   *
   * A partial update rather than a replace: two tabs open on this page would
   * otherwise undo each other, the later save reverting whatever the earlier one
   * changed simply because it did not know about it.
   */
  set(userId: string, patch: { staleDays?: number | undefined }): UserSettings {
    if (patch.staleDays !== undefined) {
      this.#db.run(
        `INSERT INTO user_settings (user_id, key, value) VALUES (?, 'staleDays', ?)
         ON CONFLICT (user_id, key) DO UPDATE SET value = excluded.value`,
        userId,
        String(clampStaleDays(patch.staleDays)),
      );
    }
    return this.get(userId);
  }
}

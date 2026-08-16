/**
 * The settings page.
 *
 * Grouped by what a setting *is*, not by where it is stored — the split between
 * this browser and the server is an implementation detail nobody should have to
 * hold in their head to find a switch. It is stated once, quietly, where the one
 * server-backed setting lives.
 *
 * Several of these exist because earlier work made a choice on somebody's behalf
 * and left them no way to disagree: hiding numeric sort prefixes, opening on the
 * overview, saving half a second after you stop typing. Each was a reasonable
 * default and none of them should have been permanent.
 *
 * Everything applies immediately. A settings page with a Save button invites you
 * to change three things and then wonder which of them took effect; a theme that
 * switches as you pick it needs no confirmation at all. The password form is the
 * exception, and it is an exception for a reason: it is the one action here that
 * cannot be undone by changing it back.
 */

import { useState } from 'react';

import { ApiError, api } from './api';
import { copy } from './copy';
import type { Measure, Prefs, StartView, Theme } from './prefs';

export interface SettingsProps {
  prefs: Prefs;
  onPrefs: (next: Prefs) => void;
  /** Days before a note counts as untouched; lives on the server. */
  staleDays: number | null;
  onStaleDays: (days: number) => void;
  user: { id: string; displayName: string; role: string };
  onSignedOutEverywhere: () => void;
  onRenamed: () => void;
}

const THEMES: Array<{ value: Theme; label: string; hint: string }> = [
  { value: 'system', label: 'System', hint: 'Follow the operating system' },
  { value: 'light', label: 'Light', hint: 'Always light' },
  { value: 'dark', label: 'Dark', hint: 'Always dark' },
];

const MEASURES: Array<{ value: Measure; label: string; hint: string }> = [
  { value: 'narrow', label: 'Narrow', hint: 'About 68 characters — best for continuous reading' },
  { value: 'medium', label: 'Medium', hint: 'About 92 characters' },
  { value: 'wide', label: 'Wide', hint: 'The full width of the pane' },
];

const START_VIEWS: Array<{ value: StartView; label: string }> = [
  { value: 'overview', label: 'Overview' },
  { value: 'note', label: 'The last note you had open' },
  { value: 'search', label: 'Search' },
  { value: 'files', label: 'Files' },
];

export function SettingsView({
  prefs,
  onPrefs,
  staleDays,
  onStaleDays,
  user,
  onSignedOutEverywhere,
  onRenamed,
}: SettingsProps): React.JSX.Element {
  const set = <K extends keyof Prefs>(key: K, value: Prefs[K]): void =>
    onPrefs({ ...prefs, [key]: value });

  return (
    <div className="pane padded settings">
      <h2 className="h-big">{copy.settings.title}</h2>
      <p className="h-sub">{copy.settings.subtitle}</p>

      <section className="setgroup">
        <h3 className="cap">{copy.settings.appearance}</h3>

        <div className="setrow">
          <div className="setlabel">
            <span>{copy.settings.theme}</span>
            <small>{copy.settings.themeHint}</small>
          </div>
          <div className="segmented" role="radiogroup" aria-label={copy.settings.theme}>
            {THEMES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={prefs.theme === option.value}
                title={option.hint}
                onClick={() => set('theme', option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>

        <div className="setrow">
          <div className="setlabel">
            <span>{copy.settings.textSize}</span>
            <small>{copy.settings.textSizeHint}</small>
          </div>
          <div className="slider">
            <input
              type="range"
              min={85}
              max={160}
              step={5}
              value={Math.round(prefs.textScale * 100)}
              aria-label={copy.settings.textSize}
              onChange={(event) => set('textScale', Number(event.target.value) / 100)}
            />
            <span className="sliderval">{Math.round(prefs.textScale * 100)}%</span>
          </div>
        </div>

        <div className="setrow">
          <div className="setlabel">
            <span>{copy.settings.measure}</span>
            <small>{copy.settings.measureHint}</small>
          </div>
          <div className="segmented" role="radiogroup" aria-label={copy.settings.measure}>
            {MEASURES.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={prefs.measure === option.value}
                title={option.hint}
                onClick={() => set('measure', option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="setgroup">
        <h3 className="cap">{copy.settings.navigation}</h3>

        <div className="setrow">
          <div className="setlabel">
            <span>{copy.settings.startView}</span>
            <small>{copy.settings.startViewHint}</small>
          </div>
          <select
            value={prefs.startView}
            aria-label={copy.settings.startView}
            onChange={(event) => set('startView', event.target.value as StartView)}
          >
            {START_VIEWS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <Toggle
          label={copy.settings.hidePrefixes}
          hint={copy.settings.hidePrefixesHint}
          checked={prefs.hidePrefixes}
          onChange={(value) => set('hidePrefixes', value)}
        />

        {/*
          A switch, then a count — rather than a count whose zero end doubles as
          an off switch. Somebody who wants the list gone looks for something to
          turn off; hiding that at one end of a slider means the setting exists
          and cannot be found, which is the same as not having it.

          The count remembers itself across a switch-off, so turning the list
          back on restores the length you chose rather than a default.
        */}
        <Toggle
          label={copy.settings.showRecent}
          hint={copy.settings.showRecentHint}
          checked={prefs.recentCount > 0}
          onChange={(on) => set('recentCount', on ? (prefs.lastRecentCount || 5) : 0)}
        />

        {prefs.recentCount > 0 && (
          <div className="setrow setrow-sub">
            <div className="setlabel">
              <span>{copy.settings.recentCount}</span>
              <small>{copy.settings.recentCountHint}</small>
            </div>
            <div className="slider">
              <input
                type="range"
                min={1}
                max={12}
                value={prefs.recentCount}
                aria-label={copy.settings.recentCount}
                onChange={(event) => {
                  // Both, so switching the list off and on again comes back to
                  // the length that was chosen rather than to a default.
                  const next = Number(event.target.value);
                  onPrefs({ ...prefs, recentCount: next, lastRecentCount: next });
                }}
              />
              <span className="sliderval">{prefs.recentCount}</span>
            </div>
          </div>
        )}
      </section>

      <section className="setgroup">
        <h3 className="cap">{copy.settings.writing}</h3>

        <div className="setrow">
          <div className="setlabel">
            <span>{copy.settings.saveDelay}</span>
            <small>{copy.settings.saveDelayHint}</small>
          </div>
          <div className="slider">
            <input
              type="range"
              min={200}
              max={3000}
              step={100}
              value={prefs.saveDelayMs}
              aria-label={copy.settings.saveDelay}
              onChange={(event) => set('saveDelayMs', Number(event.target.value))}
            />
            <span className="sliderval">{(prefs.saveDelayMs / 1000).toFixed(1)} s</span>
          </div>
        </div>
      </section>

      <section className="setgroup">
        <h3 className="cap">{copy.settings.findings}</h3>
        {/* The one setting that is not a property of this browser: it decides
            what the server reports, so it has to be the same answer on every
            device. Said once, here, rather than repeated on each row. */}
        <p className="setnote">{copy.settings.serverSide}</p>

        <div className="setrow">
          <div className="setlabel">
            <span>{copy.settings.staleDays}</span>
            <small>{copy.settings.staleDaysHint}</small>
          </div>
          <div className="slider">
            <input
              type="range"
              min={7}
              max={365}
              step={7}
              value={staleDays ?? 42}
              disabled={staleDays === null}
              aria-label={copy.settings.staleDays}
              onChange={(event) => onStaleDays(Number(event.target.value))}
            />
            <span className="sliderval">{copy.settings.days(staleDays ?? 42)}</span>
          </div>
        </div>
      </section>

      <AccountSection
        user={user}
        onSignedOutEverywhere={onSignedOutEverywhere}
        onRenamed={onRenamed}
      />
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="setrow">
      <div className="setlabel">
        <span>{label}</span>
        <small>{hint}</small>
      </div>
      <button
        type="button"
        className="switch"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
      >
        <span />
      </button>
    </div>
  );
}

/**
 * Account actions.
 *
 * The one place on this page with a submit button, because these are the two
 * things here that cannot be undone by changing them back.
 */
function AccountSection({
  user,
  onSignedOutEverywhere,
  onRenamed,
}: {
  user: { id: string; displayName: string; role: string };
  onSignedOutEverywhere: () => void;
  /** Re-reads the account, so the sidebar shows the new name at once. */
  onRenamed: () => void;
}): React.JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null);
  const [name, setName] = useState(user.displayName);

  const rename = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.setDisplayName(name.trim());
      setNote({ kind: 'ok', text: copy.settings.nameSaved });
      onRenamed();
    } catch (caught) {
      setNote({
        kind: 'bad',
        text: caught instanceof ApiError ? caught.message : copy.settings.nameFailed,
      });
    } finally {
      setBusy(false);
    }
  };

  const change = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (next !== repeat) {
      setNote({ kind: 'bad', text: copy.settings.passwordMismatch });
      return;
    }

    setBusy(true);
    try {
      await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setRepeat('');
      setNote({ kind: 'ok', text: copy.settings.passwordChanged });
    } catch (caught) {
      setNote({
        kind: 'bad',
        text: caught instanceof ApiError ? caught.message : copy.settings.passwordFailed,
      });
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (): Promise<void> => {
    if (!window.confirm(copy.settings.confirmSignOutAll)) return;
    setBusy(true);
    try {
      await api.revokeSessions();
      setNote({ kind: 'ok', text: copy.settings.sessionsRevoked });
      onSignedOutEverywhere();
    } catch {
      setNote({ kind: 'bad', text: copy.settings.sessionsFailed });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="setgroup">
      <h3 className="cap">{copy.settings.account}</h3>

      {/*
        The name and the account id are different things and the hint says so.
        The id is the vault's directory name and the key every share and API key
        hangs off; this is only ever a label.
      */}
      <form className="setrow" onSubmit={(event) => void rename(event)}>
        <div className="setlabel">
          <span>{copy.settings.displayName}</span>
          <small>{copy.settings.displayNameHint}</small>
        </div>
        <div className="nameedit">
          <input
            type="text"
            value={name}
            maxLength={64}
            aria-label={copy.settings.displayName}
            onChange={(event) => setName(event.target.value)}
          />
          <button type="submit" disabled={busy || name.trim() === '' || name === user.displayName}>
            {copy.settings.save}
          </button>
        </div>
      </form>

      <div className="setrow">
        <div className="setlabel">
          <span>{user.id}</span>
          <small>{user.role === 'admin' ? copy.settings.roleAdmin : copy.settings.roleUser}</small>
        </div>
      </div>

      <form className="pwform" onSubmit={(event) => void change(event)}>
        <p className="setnote">{copy.settings.passwordWhy}</p>
        <label>
          <span>{copy.settings.currentPassword}</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            required
          />
        </label>
        <label>
          <span>{copy.settings.newPassword}</span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={10}
            value={next}
            onChange={(event) => setNext(event.target.value)}
            required
          />
        </label>
        <label>
          <span>{copy.settings.repeatPassword}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(event) => setRepeat(event.target.value)}
            required
          />
        </label>
        <div className="pwactions">
          <button type="submit" disabled={busy || current === '' || next === ''}>
            {copy.settings.changePassword}
          </button>
          <button type="button" className="secondary" disabled={busy} onClick={() => void revoke()}>
            {copy.settings.signOutEverywhere}
          </button>
        </div>
        {note !== null && (
          <p className={note.kind === 'ok' ? 'setok' : 'setbad'} role="status">
            {note.text}
          </p>
        )}
      </form>
    </section>
  );
}

/**
 * The segmented controls on the settings page are radio groups, and for a while
 * they said so without behaving like one.
 *
 * `role="radiogroup"` with `role="radio"` and `aria-checked` promises two things
 * a screen reader then tells somebody: the group is one tab stop, and the arrow
 * keys move within it. Neither was true — every option was its own tab stop and
 * the arrows did nothing — which is worse than saying nothing at all, because
 * the promise is what they act on.
 *
 * The switcher in `NetworkFrame.tsx` had it right forty lines away; this pins
 * the settings page to the same behaviour, and measures the effect (the setting
 * changed, the focus moved) rather than the attribute.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { SettingsView } from '../src/Settings';
import { copy } from '../src/copy';
import { DEFAULT_PREFS, type Prefs } from '../src/prefs';

function renderSettings(prefs: Partial<Prefs> = {}) {
  const onPrefs = vi.fn();
  render(
    <SettingsView
      prefs={{ ...DEFAULT_PREFS, ...prefs }}
      onPrefs={onPrefs}
      staleDays={90}
      onStaleDays={vi.fn()}
      user={{ id: 'julian', displayName: 'Julian', role: 'user' }}
      onSignedOutEverywhere={vi.fn()}
      onRenamed={vi.fn()}
    />,
  );
  return { onPrefs };
}

const groups = () => ({
  theme: screen.getByRole('radiogroup', { name: copy.settings.theme }),
  measure: screen.getByRole('radiogroup', { name: copy.settings.measure }),
});

/**
 * Vim keys, and the key that leaves Insert mode.
 *
 * The second is a question about the first, so it is not asked before vim is
 * on. What it decides is who owns Escape — vim, or the note's own way out by
 * keyboard — which is why it is a setting at all rather than a rule.
 */
describe('the vim keys switch', () => {
  it('is off in the defaults, and hides the question that depends on it', () => {
    expect(DEFAULT_PREFS.vimMode).toBe(false);
    renderSettings();

    expect(screen.getByRole('switch', { name: copy.settings.vimMode })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.queryByRole('radiogroup', { name: copy.settings.vimLeave })).toBeNull();
  });

  it('asks which key leaves Insert mode once it is on', async () => {
    const user = userEvent.setup();
    const { onPrefs } = renderSettings({ vimMode: true, vimLeaveInsert: 'Escape' });

    const keys = screen.getByRole('radiogroup', { name: copy.settings.vimLeave });
    within(keys).getAllByRole('radio')[0]!.focus();
    await user.keyboard('{ArrowRight}');

    expect(onPrefs).toHaveBeenCalledWith(expect.objectContaining({ vimLeaveInsert: 'jk' }));
  });

  it('switches on without touching the key that was chosen before', async () => {
    const user = userEvent.setup();
    const { onPrefs } = renderSettings({ vimMode: false, vimLeaveInsert: 'kj' });

    await user.click(screen.getByRole('switch', { name: copy.settings.vimMode }));

    expect(onPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ vimMode: true, vimLeaveInsert: 'kj' }),
    );
  });
});

describe('the theme switch', () => {
  it('changes the theme on the right arrow and takes the focus with it', async () => {
    const user = userEvent.setup();
    const { onPrefs } = renderSettings({ theme: 'system' });

    const options = within(groups().theme).getAllByRole('radio');
    options[0]!.focus();
    await user.keyboard('{ArrowRight}');

    expect(onPrefs).toHaveBeenCalledWith(expect.objectContaining({ theme: 'light' }));
    expect(document.activeElement).toBe(options[1]);
  });

  it('wraps round on the left arrow from the first option', async () => {
    const user = userEvent.setup();
    const { onPrefs } = renderSettings({ theme: 'system' });

    within(groups().theme).getAllByRole('radio')[0]!.focus();
    await user.keyboard('{ArrowLeft}');

    expect(onPrefs).toHaveBeenCalledWith(expect.objectContaining({ theme: 'dark' }));
  });

  it('is one tab stop, on whichever option is checked', async () => {
    const user = userEvent.setup();
    renderSettings({ theme: 'dark' });

    const options = within(groups().theme).getAllByRole('radio');
    const seats = options.filter((option) => option.getAttribute('tabindex') === '0');
    expect(seats).toHaveLength(1);
    expect(seats[0]).toHaveAttribute('aria-checked', 'true');

    // And Tab really does step over the other two rather than through them.
    options[2]!.focus();
    await user.tab();
    expect(groups().theme.contains(document.activeElement)).toBe(false);
  });
});

describe('the measure switch', () => {
  it('changes the measure on the down arrow, as a radio group does', async () => {
    const user = userEvent.setup();
    const { onPrefs } = renderSettings({ measure: 'narrow' });

    within(groups().measure).getAllByRole('radio')[0]!.focus();
    await user.keyboard('{ArrowDown}');

    expect(onPrefs).toHaveBeenCalledWith(expect.objectContaining({ measure: 'medium' }));
  });

  it('is one tab stop of its own', () => {
    renderSettings({ measure: 'wide' });

    const options = within(groups().measure).getAllByRole('radio');
    expect(options.filter((option) => option.getAttribute('tabindex') === '0')).toHaveLength(1);
  });
});

/**
 * What is due, in the journal: a count on the day, and the tasks below.
 *
 * Three things have to hold. The calendar tells the shell the last day on
 * screen, because that is what the shell asks the server for. A day with
 * something due says so to a screen reader, not only with a number drawn for
 * the eye. And a task in the list opens the task, in its own list.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { DueTask } from '../../shared/tasklist';
import { JournalView } from '../src/Journal';

// 17 September 2026, a Thursday. The grid for September ends on Sunday 4 October,
// the one for October on Sunday 1 November: as many weeks as the month needs.
const NOW = new Date(2026, 8, 17, 10).getTime();

function due(title: string, day: string, path = 'Kunden/Acme/Website.tasks.json'): DueTask {
  return { owner: 'julian', path, id: title.replace(/\W/g, ''), title, due: day, priority: null };
}

describe('due tasks in the journal', () => {
  it('asks for the month on screen, up to its last day', async () => {
    const onRange = vi.fn();
    render(<JournalView days={new Set()} now={NOW} onOpenDay={() => undefined} onRange={onRange} />);
    expect(onRange).toHaveBeenLastCalledWith('2026-10-04');
    await userEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(onRange).toHaveBeenLastCalledWith('2026-11-01');
  });

  it('puts a count on the day and says it out loud', () => {
    render(
      <JournalView
        days={new Set()}
        now={NOW}
        onOpenDay={() => undefined}
        due={[due('Offerte', '2026-09-22'), due('Texte', '2026-09-22')]}
      />,
    );
    const day = screen.getByRole('button', { name: /September 22, 2026.*2 tasks due/ });
    expect(day).toHaveTextContent('2');
  });

  it('lists what is overdue apart from what falls this month, and opens a task', async () => {
    const onOpenTask = vi.fn();
    render(
      <JournalView
        days={new Set()}
        now={NOW}
        onOpenDay={() => undefined}
        due={[due('Alt', '2026-09-01'), due('Offerte', '2026-09-22')]}
        onOpenTask={onOpenTask}
      />,
    );
    const list = screen.getByRole('region', { name: 'Due' });
    expect(within(list).getByText('Overdue')).toBeInTheDocument();
    await userEvent.click(within(list).getByRole('button', { name: 'Open “Offerte” in Website' }));
    expect(onOpenTask).toHaveBeenCalledWith('julian', 'Kunden/Acme/Website.tasks.json', 'Offerte');
  });

  it('says when nothing is due, and shows nothing at all without task lists', () => {
    const { unmount } = render(<JournalView days={new Set()} now={NOW} onOpenDay={() => undefined} due={[]} />);
    expect(screen.getByText('Nothing from your task lists is due this month.')).toBeInTheDocument();
    unmount();
    render(<JournalView days={new Set()} now={NOW} onOpenDay={() => undefined} />);
    expect(screen.queryByRole('region', { name: 'Due' })).toBeNull();
  });
});

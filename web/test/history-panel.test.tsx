/**
 * The history panel, which had no tests at all.
 *
 * It is the only way back into a note somebody overwrote, and until now the
 * whole of it — four states, a read, a confirmation and a restore — rested on
 * nobody having broken it by accident. That is the wrong file to have no tests
 * in, so the states come first.
 *
 * What every test here is really about is one distinction. The panel used to
 * take a boolean and had two sentences to spend on it: "no history is being
 * recorded for this vault" and "no earlier versions recorded yet". A vault
 * whose sidecar was corrupt, unreadable or too slow to answer got the second
 * one, so somebody was told their note had never been changed while its entire
 * history sat unreachable on disk. Three of the four states below are
 * indistinguishable from each other unless the panel is reading `state`, and
 * that is the point of testing them one by one.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, api, type HistoryState, type Version } from '../src/api';
import { copy } from '../src/copy';
import { HistoryPanel } from '../src/History';

const OWNER = 'julian';
const PATH = 'Projekt/Plan.md';
const HOUR = 3_600_000;

const VERSIONS: Version[] = [
  { id: 'aaa1', at: Date.now() - 2 * HOUR, subject: 'Vault-Stand · 1 geändert', size: 40 },
  { id: 'bbb2', at: Date.now() - 30 * HOUR, subject: 'Vault-Stand · 2 geändert', size: 30 },
];

function show(state: HistoryState, versions: Version[] = [], canWrite = true) {
  const onRestored = vi.fn();
  render(
    <HistoryPanel
      owner={OWNER}
      path={PATH}
      state={state}
      versions={versions}
      canWrite={canWrite}
      onRestored={onRestored}
    />,
  );
  return { onRestored };
}

beforeEach(() => {
  vi.spyOn(api, 'versionContent').mockResolvedValue('Fassung eins.\n');
  vi.spyOn(api, 'restoreVersion').mockResolvedValue({
    note: { path: PATH, title: 'Plan', content: 'Fassung eins.\n', size: 14, mtimeMs: 0, hash: 'h1' },
    created: false,
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the four things an empty history can mean', () => {
  it('says the vault has no history where the host keeps none', () => {
    show('none');

    expect(screen.getByText(copy.history.noSidecar)).toBeInTheDocument();
    expect(screen.queryByText(copy.history.unreadable)).not.toBeInTheDocument();
  });

  it('says nothing has been recorded yet for a repository the timer has not reached', () => {
    show('empty');

    expect(screen.getByText(copy.history.none)).toBeInTheDocument();
    expect(screen.queryByText(copy.history.noSidecar)).not.toBeInTheDocument();
  });

  it('says nothing has been recorded yet for a note in a working history that was never edited', () => {
    // The one emptiness that is a fact about the note rather than the server,
    // and the only one that may be reported as such.
    show('ready', []);

    expect(screen.getByText(copy.history.none)).toBeInTheDocument();
    expect(screen.queryByText(copy.history.unreadable)).not.toBeInTheDocument();
  });

  it('says the history could not be read, and does not call it an absence', async () => {
    show('broken');

    const said = screen.getByText(copy.history.unreadable);
    expect(said).toBeInTheDocument();
    // Neither of the two sentences this state used to borrow. Both of them are
    // claims about what is in the history, made where nothing could look.
    expect(screen.queryByText(copy.history.none)).not.toBeInTheDocument();
    expect(screen.queryByText(copy.history.noSidecar)).not.toBeInTheDocument();
    // And it reads as a fault rather than as a quiet nothing, because a person
    // who skims past it has no other way of finding out.
    expect(said).toHaveClass('setbad');
    // Nothing is offered that cannot be delivered.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the list and the way back', () => {
  it('lists every version and counts them in the heading', () => {
    show('ready', VERSIONS);

    expect(screen.getByRole('heading', { level: 4 }).textContent).toContain('2');
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('shows a version before offering to restore it, never the other way round', async () => {
    // The list deliberately has no Restore button beside each row: that is a
    // list of chances to overwrite today's work with a version nobody read.
    show('ready', VERSIONS);
    expect(screen.queryByText(copy.history.restore)).not.toBeInTheDocument();

    await userEvent.click(screen.getAllByRole('button')[0]!);

    await waitFor(() => expect(screen.getByText(/Fassung eins\./)).toBeInTheDocument());
    expect(api.versionContent).toHaveBeenCalledWith(OWNER, PATH, 'aaa1');
    expect(screen.getByText(copy.history.restore)).toBeInTheDocument();
    // And it says what a restore is, because "restore" in most tools means
    // "lose everything after this point" and here it does not.
    expect(screen.getByText(copy.history.restoreIsAnEdit)).toBeInTheDocument();
  });

  it('offers no restore on a note the caller may only read', async () => {
    show('ready', VERSIONS, false);

    await userEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(screen.getByText(/Fassung eins\./)).toBeInTheDocument());

    expect(screen.queryByText(copy.history.restore)).not.toBeInTheDocument();
  });

  it('writes the version back and tells the editor to reload', async () => {
    const { onRestored } = show('ready', VERSIONS, true);

    await userEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(screen.getByText(copy.history.restore)).toBeInTheDocument());
    await userEvent.click(screen.getByText(copy.history.restore));

    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    expect(api.restoreVersion).toHaveBeenCalledWith(OWNER, PATH, 'aaa1');
  });

  it('restores nothing when the confirmation is declined', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    const { onRestored } = show('ready', VERSIONS, true);

    await userEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(screen.getByText(copy.history.restore)).toBeInTheDocument());
    await userEvent.click(screen.getByText(copy.history.restore));

    expect(api.restoreVersion).not.toHaveBeenCalled();
    expect(onRestored).not.toHaveBeenCalled();
  });
});

describe('when a read fails after the list was fetched', () => {
  it('blames the sidecar when the server says the sidecar is why', async () => {
    // The repository broke between the listing and the click — which is
    // exactly what a sidecar failing midway through the day looks like. The
    // server answers 503 `history_unreadable` and the panel has to pass that
    // on: "could not read that version" reads like this one version is gone.
    vi.mocked(api.versionContent).mockRejectedValue(
      new ApiError(503, 'history_unreadable', 'the history could not be read'),
    );
    show('ready', VERSIONS);

    await userEvent.click(screen.getAllByRole('button')[0]!);

    await waitFor(() => expect(screen.getByText(copy.history.unreadable)).toBeInTheDocument());
    expect(screen.queryByText(copy.history.loadFailed)).not.toBeInTheDocument();
  });

  it('keeps its own message for a failure that is not about the sidecar', async () => {
    vi.mocked(api.versionContent).mockRejectedValue(new ApiError(404, 'not_found', 'nope'));
    show('ready', VERSIONS);

    await userEvent.click(screen.getAllByRole('button')[0]!);

    await waitFor(() => expect(screen.getByText(copy.history.loadFailed)).toBeInTheDocument());
  });

  it('blames the sidecar when a restore is refused for it', async () => {
    vi.mocked(api.restoreVersion).mockRejectedValue(
      new ApiError(503, 'history_unreadable', 'the history could not be read'),
    );
    const { onRestored } = show('ready', VERSIONS, true);

    await userEvent.click(screen.getAllByRole('button')[0]!);
    await waitFor(() => expect(screen.getByText(copy.history.restore)).toBeInTheDocument());
    await userEvent.click(screen.getByText(copy.history.restore));

    await waitFor(() => expect(screen.getByText(copy.history.unreadable)).toBeInTheDocument());
    expect(onRestored).not.toHaveBeenCalled();
  });
});

describe('the delete question', () => {
  it('promises nothing about notes whose history could not be read', () => {
    // `unknown` used to be folded into `unsaved`, whose sentence is "no version
    // of them has been saved yet" — a claim of loss about notes whose versions
    // are very likely all still there behind a repository nothing could open.
    expect(
      copy.ask.afterDelete({ restorable: 0, unsaved: 0, notYours: 0, unknown: 1, history: 'broken' }),
    ).toBe('The history could not be read, so whether it can be brought back is unknown.');

    expect(
      copy.ask.afterDelete({ restorable: 0, unsaved: 0, notYours: 0, unknown: 3, history: 'broken' }),
    ).toBe('The history could not be read, so whether they can be brought back is unknown.');

    // It must not read as "this server keeps no history", which is what a
    // broken sidecar used to be reported as.
    expect(
      copy.ask.afterDelete({ restorable: 0, unsaved: 0, notYours: 0, unknown: 2, history: 'broken' }),
    ).not.toContain('keeps no history');
  });

  it('counts the ones it could not look up beside the ones it could', () => {
    expect(
      copy.ask.afterDelete({ restorable: 2, unsaved: 0, notYours: 0, unknown: 1, history: 'broken' }),
    ).toBe('2 can be restored from Tidy up for 30 days; for 1 the history could not be read.');
  });
});

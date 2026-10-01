/**
 * Making a folder, which used to be a `window.prompt`.
 *
 * The prompt threw away two things. It sent no owner, so a folder asked for in
 * a space was made in the caller's own vault instead — `POST /api/v1/folders`
 * has taken an owner and checked the share's write access the whole time, and
 * the client simply never named one. And it could only report a refusal after
 * it had closed, as a red line at the top of the screen, about a name that was
 * no longer anywhere to correct.
 *
 * So what these pin is the owner reaching the call, the path being shown before
 * it is made, and a refusal landing in the dialog rather than behind it.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../src/api';
import { copy } from '../src/copy';
import { NewFolderDialog, folderPath, type NewFolderTarget } from '../src/NewFolderDialog';

const IN_A_SPACE: NewFolderTarget = { owner: 'verein', space: 'Verein', parent: 'Sitzungen' };
const AT_THE_TOP: NewFolderTarget = { owner: 'julian', space: null, parent: '' };

function mount(target: NewFolderTarget, taken: string[] = [], onCreate = vi.fn()) {
  const onClose = vi.fn();
  render(
    <NewFolderDialog
      target={target}
      taken={new Set(taken)}
      onCreate={onCreate}
      onClose={onClose}
    />,
  );
  return { onCreate, onClose };
}

const name = (): HTMLElement => screen.getByLabelText(copy.newFolder.name);
const submit = (): HTMLElement => screen.getByRole('button', { name: copy.newFolder.submit });

describe('the path it will make', () => {
  it('joins the folder the menu was opened on with the typed name', () => {
    expect(folderPath('Sitzungen', 'Protokolle')).toBe('Sitzungen/Protokolle');
    expect(folderPath('', 'Projekte')).toBe('Projekte');
    // Slashes around the name are the person's, not the path's.
    expect(folderPath('Sitzungen', ' /Protokolle/ ')).toBe('Sitzungen/Protokolle');
    expect(folderPath('Sitzungen', '   ')).toBe('');
  });

  it('is shown before anything is sent', async () => {
    mount(IN_A_SPACE);
    await userEvent.type(name(), 'Protokolle');
    expect(screen.getByText('Sitzungen/Protokolle')).toBeInTheDocument();
  });

  it('says it needs a name rather than offering a button that does nothing', () => {
    mount(IN_A_SPACE);
    expect(screen.getByText(copy.newFolder.noName)).toBeInTheDocument();
    expect(submit()).toBeDisabled();
  });
});

describe('what it refuses before asking', () => {
  it('a name that is already a folder there', async () => {
    mount(IN_A_SPACE, ['Sitzungen/Protokolle']);
    await userEvent.type(name(), 'Protokolle');

    expect(screen.getByRole('alert')).toHaveTextContent(copy.newFolder.taken('Sitzungen/Protokolle'));
    expect(submit()).toBeDisabled();
  });

  it('a name that steps upwards, and one that begins with a dot', async () => {
    mount(AT_THE_TOP);
    await userEvent.type(name(), '../anderswo');
    expect(screen.getByRole('alert')).toHaveTextContent(copy.newFolder.upward);

    await userEvent.clear(name());
    await userEvent.type(name(), '.git');
    expect(screen.getByRole('alert')).toHaveTextContent(copy.newFolder.dotted);
  });
});

describe('making it', () => {
  /** The defect: the owner never reached the request, so a space never got one. */
  it('names the vault the row belonged to, not the caller’s', async () => {
    const { onCreate, onClose } = mount(IN_A_SPACE);
    await userEvent.type(name(), 'Protokolle');
    await userEvent.click(submit());

    expect(onCreate).toHaveBeenCalledWith('verein', 'Sitzungen/Protokolle');
    expect(onClose).toHaveBeenCalled();
  });

  it('names the space in its heading, and says nothing about your own vault', () => {
    mount(IN_A_SPACE);
    expect(screen.getByRole('heading')).toHaveTextContent(copy.newFolder.titleIn('Verein'));
  });

  it('keeps the dialog open on a refusal, and says why where the name is', async () => {
    const onCreate = vi.fn().mockRejectedValue(new ApiError(409, 'exists', 'already there'));
    const { onClose } = mount(AT_THE_TOP, [], onCreate);
    await userEvent.type(name(), 'Projekte');
    await userEvent.click(submit());

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.newFolder.taken('Projekte'));
    expect(onClose).not.toHaveBeenCalled();
    // And it can be corrected rather than started again.
    expect(name()).toHaveValue('Projekte');
  });
});

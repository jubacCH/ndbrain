/**
 * Who else is in the note, and what the connection is doing.
 *
 * One mark per name, not per cursor: a person with two tabs open is one
 * person in this row, even though both of their carets show in the text.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { copy } from '../src/copy';
import { Presence } from '../src/collab/Presence';
import type { Peer } from '../src/collab/useCollab';

const peer = (clientId: number, name: string, color: string, self = false): Peer => ({
  clientId,
  name,
  color,
  self,
});

describe('Presence', () => {
  it('lists others by initials, once per name, and never oneself', () => {
    render(
      <Presence
        status="live"
        peers={[
          peer(1, 'Julian', '#00ffff', true),
          peer(2, 'Ramona', '#ff00ff'),
          peer(3, 'Ramona', '#ff00ff'),
          peer(4, '🤖 claude-code', '#ffff00'),
        ]}
      />,
    );
    expect(screen.getAllByTitle('Ramona')).toHaveLength(1);
    expect(screen.getByTitle('🤖 claude-code')).toBeInTheDocument();
    expect(screen.queryByTitle('Julian')).toBeNull();
    expect(screen.getByText(copy.collab.live)).toBeInTheDocument();
  });

  it('shortens a name to its initials and an agent to the robot', () => {
    render(
      <Presence
        status="live"
        peers={[peer(2, 'Ramona Muster', '#ff00ff'), peer(4, '🤖 claude-code', '#ffff00')]}
      />,
    );
    expect(screen.getByTitle('Ramona Muster')).toHaveTextContent('RM');
    expect(screen.getByTitle('🤖 claude-code')).toHaveTextContent('🤖');
  });

  it('gives each mark the colour the room chose for that person', () => {
    render(<Presence status="live" peers={[peer(2, 'Ramona', 'rgb(255, 0, 255)')]} />);
    expect(screen.getByTitle('Ramona')).toHaveStyle({ background: 'rgb(255, 0, 255)' });
  });

  it('says when it is offline, and promises the text is not lost', () => {
    render(<Presence status="offline" peers={[]} />);
    expect(screen.getByText(copy.collab.offline)).toBeInTheDocument();
  });

  it('says it is still connecting', () => {
    render(<Presence status="connecting" peers={[]} />);
    expect(screen.getByText(copy.collab.connecting)).toBeInTheDocument();
  });

  it('shows nobody when nobody else is there, and still says Live', () => {
    render(<Presence status="live" peers={[peer(1, 'Julian', '#00ffff', true)]} />);
    expect(screen.queryByTitle('Julian')).toBeNull();
    expect(screen.getByText(copy.collab.live)).toBeInTheDocument();
  });

  it('tells a screen reader when the row changes rather than only redrawing it', () => {
    const { container } = render(<Presence status="live" peers={[]} />);
    expect(container.querySelector('[aria-live]')).not.toBeNull();
  });
});

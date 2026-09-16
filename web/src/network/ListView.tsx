/**
 * Placeholder for the network's list view.
 *
 * The frame around the network (`NetworkFrame.tsx`) switches to this view and
 * remembers the choice; the view itself is built separately and replaces this
 * file, keeping the signature below.
 */

import type { GraphData as GraphResponse } from '../api';
import { copy } from '../copy';

export function ListView({
  graph,
  onOpen,
}: {
  graph: GraphResponse;
  onOpen: (owner: string, path: string) => void;
}): React.JSX.Element {
  void graph;
  void onOpen;
  return (
    <div className="netplaceholder">
      <p className="empty">{copy.shell.network.notYet(copy.shell.network.list.toLowerCase())}</p>
    </div>
  );
}

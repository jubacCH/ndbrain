/**
 * Turning the metadata an import left in the prose into real tags.
 *
 * This vault has 53 notes carrying `> **type:** … **topic:** proxmox, homelab`
 * as the first line of the body, and no tags at all — so the tag filter, the tag
 * cloud and the untagged finding are switched off for want of a translation
 * nobody will do sixty times by hand.
 *
 * It is offered as a preview, not performed. The notes belong to the person
 * using this, and a migration that runs on its own is a tool editing writing it
 * was not asked to edit. So: every proposal is listed with the line it was read
 * from, each one can be unticked, and nothing is written until somebody presses
 * the button. The body is never touched either way — only the frontmatter grows.
 */

import { useState } from 'react';

import { copy } from './copy';
import type { TopicProposal } from './api';

export interface TopicsProps {
  proposals: TopicProposal[];
  busy: boolean;
  onApply: (paths: string[]) => void;
}

export function TopicsPanel({ proposals, busy, onApply }: TopicsProps): React.JSX.Element | null {
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);

  if (proposals.length === 0) return null;

  const chosen = proposals.filter((p) => !skipped.has(p.path));

  const toggle = (path: string): void =>
    setSkipped((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <section className="topics">
      <p className="topicsline">
        <strong>{copy.topics.found(proposals.length)}</strong> {copy.topics.explain}
      </p>

      <div className="topicsactions">
        <button type="button" onClick={() => setOpen((was) => !was)}>
          {open ? copy.topics.hidePreview : copy.topics.showPreview}
        </button>
        <button
          type="button"
          className="primary"
          disabled={busy || chosen.length === 0}
          onClick={() => onApply(chosen.map((p) => p.path))}
        >
          {copy.topics.apply(chosen.length)}
        </button>
      </div>

      {open && (
        <table className="tbl topicstbl">
          <thead>
            <tr>
              <th />
              <th>{copy.topics.note}</th>
              <th>{copy.topics.willGet}</th>
              <th>{copy.topics.readFrom}</th>
            </tr>
          </thead>
          <tbody>
            {proposals.map((proposal) => (
              <tr key={proposal.path} data-skipped={skipped.has(proposal.path)}>
                <td>
                  <input
                    type="checkbox"
                    checked={!skipped.has(proposal.path)}
                    aria-label={copy.topics.include(proposal.title)}
                    onChange={() => toggle(proposal.path)}
                  />
                </td>
                <td>{proposal.title}</td>
                <td>
                  {proposal.proposed.map((tag) => (
                    <span className="pill p-tag" key={tag}>
                      #{tag}
                    </span>
                  ))}
                </td>
                {/* The line the machine read, so its reading can be checked
                    rather than taken on trust. */}
                <td className="topicssrc">{proposal.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

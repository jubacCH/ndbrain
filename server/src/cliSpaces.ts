/**
 * `ndbrain-user space …`: spaces from the command line.
 *
 * Its own module rather than another branch in `cli.ts`, which runs itself on
 * import — this way the commands can be tested against a runtime without
 * spawning a process.
 */

import type { Runtime } from './runtime.js';

export const SPACE_USAGE = `  space create <name> [--display <display name>]
                              create a space: a shared vault nobody signs in to
  space list                  list spaces with their notes and members
`;

/** Runs one `space` sub-command, writing its report through `write`. */
export async function runSpaceCommand(
  runtime: Runtime,
  args: string[],
  write: (text: string) => void,
): Promise<void> {
  const [action, name, ...rest] = args;

  if (action === 'create') {
    if (name === undefined) throw new Error('usage: space create <name> [--display <display name>]');
    const at = rest.indexOf('--display');
    let displayName: string | undefined;
    if (at !== -1) {
      displayName = rest[at + 1];
      if (displayName === undefined) throw new Error('--display needs a name');
    }

    const space = await runtime.users.createSpace(name, displayName);
    write(`created space ${space.id} (${space.displayName})\n`);
    write('Add members in Admin → Spaces. Nobody can sign in as a space.\n');
    return;
  }

  if (action === 'list') {
    const spaces = runtime.users.list().filter((user) => user.kind === 'space');
    if (spaces.length === 0) {
      write('no spaces yet\n');
      return;
    }
    for (const space of spaces) {
      const flags = [
        `${runtime.app.queries.countNotes(space.id)} notes`,
        `${runtime.shares.byOwner(space.id).length} members`,
        space.disabled ? 'disabled' : null,
      ]
        .filter(Boolean)
        .join(', ');
      write(`${space.id.padEnd(20)} ${space.displayName.padEnd(24)} ${flags}\n`);
    }
    return;
  }

  throw new Error('usage: space create|list ...');
}

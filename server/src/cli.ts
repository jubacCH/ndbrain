/**
 * Account management from the command line.
 *
 * The only way an account comes into existence. Passwords are read from stdin or
 * generated, never taken from a command-line argument: arguments end up in shell
 * history and in `ps` output, where anyone on the box can read them.
 */

import { randomBytes } from 'node:crypto';

import { loadConfig } from './config.js';
import { createRuntime } from './runtime.js';

const USAGE = `ndbrain-user — manage ndBrain accounts

  create <name> [--admin]     create an account (prints a generated password)
  passwd <name>               set a new password (ends all sessions)
  disable <name>              disable an account and end its sessions
  enable <name>               re-enable an account
  list                        list accounts

The password is read from stdin when it is not a terminal, otherwise generated:

  echo -n 'my password' | ndbrain-user passwd julian

Never pass a password as an argument — it lands in shell history and in ps.
`;

/** Reads a password from stdin, or returns null when stdin is a terminal. */
async function passwordFromStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  return value.length > 0 ? value : null;
}

/** Six base32-ish groups: long enough to be safe, shaped to be typed once. */
function generatePassword(): string {
  const alphabet = 'abcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(24);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join('');
  return (chars.match(/.{1,4}/g) ?? [chars]).join('-');
}

async function main(): Promise<void> {
  const [command, name, ...rest] = process.argv.slice(2);

  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return;
  }

  const runtime = await createRuntime(loadConfig());

  try {
    switch (command) {
      case 'create': {
        if (name === undefined) throw new Error('usage: create <name> [--admin]');
        const password = (await passwordFromStdin()) ?? generatePassword();
        const generated = !process.stdin.isTTY ? false : true;

        const user = await runtime.users.create(name, password, {
          role: rest.includes('--admin') ? 'admin' : 'user',
        });

        process.stdout.write(`created ${user.id} (${user.role})\n`);
        if (generated) {
          process.stdout.write(`password: ${password}\n`);
          process.stdout.write('Write it down now — it is not stored in readable form.\n');
        }
        break;
      }

      case 'passwd': {
        if (name === undefined) throw new Error('usage: passwd <name>');
        const password = (await passwordFromStdin()) ?? generatePassword();
        const generated = process.stdin.isTTY;

        await runtime.users.setPassword(name, password);
        process.stdout.write(`password changed for ${name}; all sessions ended\n`);
        if (generated) process.stdout.write(`password: ${password}\n`);
        break;
      }

      case 'disable':
      case 'enable': {
        if (name === undefined) throw new Error(`usage: ${command} <name>`);
        runtime.users.setDisabled(name, command === 'disable');
        process.stdout.write(`${name} ${command}d\n`);
        break;
      }

      case 'list': {
        const users = runtime.users.list();
        if (users.length === 0) {
          process.stdout.write('no accounts yet\n');
          break;
        }
        for (const user of users) {
          const flags = [user.role, user.disabled ? 'disabled' : null].filter(Boolean).join(', ');
          process.stdout.write(`${user.id.padEnd(20)} ${flags}\n`);
        }
        break;
      }

      default:
        process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
        process.exitCode = 2;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    runtime.close();
  }
}

await main();

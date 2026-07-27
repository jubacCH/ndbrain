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

  key create <user> <name> [--write] [--scope <folder>]
                              create an agent key for MCP (prints the key once)
  key list <user>             list a user's agent keys
  key revoke <key-id>         revoke a key immediately
  key log <user>              recent agent tool calls

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

      case 'key': {
        // `key <action> <args…>` — the shared positional holds the sub-command.
        const action = name;
        const rest2 = rest;

        if (action === 'create') {
          const [owner, keyName] = rest2;
          if (owner === undefined || keyName === undefined) {
            throw new Error('usage: key create <user> <name> [--write] [--scope <folder>]');
          }
          const scopeIndex = rest2.indexOf('--scope');
          const options: { scope?: string; canWrite?: boolean } = {
            canWrite: rest2.includes('--write'),
          };
          if (scopeIndex !== -1) {
            const scope = rest2[scopeIndex + 1];
            if (scope === undefined) throw new Error('--scope needs a folder');
            options.scope = scope;
          }

          const { key, secret } = runtime.keys.create(owner, keyName, options);
          const lines = [
            `created ${key.id} for ${key.owner}`,
            `scope: ${key.scope === '' ? 'entire vault' : key.scope}`,
            `access: ${key.canWrite ? 'read and write' : 'read only'}`,
            '',
            secret,
            '',
            'This is the only time the key is shown. Store it now.',
          ];
          process.stdout.write(`${lines.join('\n')}\n`);
          break;
        }

        if (action === 'list') {
          const [owner] = rest2;
          if (owner === undefined) throw new Error('usage: key list <user>');
          const keys = runtime.keys.list(owner);
          if (keys.length === 0) {
            process.stdout.write('no keys\n');
            break;
          }
          for (const key of keys) {
            const flags = [
              key.canWrite ? 'write' : 'read',
              key.scope === '' ? 'whole vault' : key.scope,
              key.revoked ? 'REVOKED' : null,
              key.lastUsedAt === null ? 'never used' : `last used ${new Date(key.lastUsedAt).toISOString()}`,
            ]
              .filter(Boolean)
              .join(', ');
            process.stdout.write(`${key.id}  ${key.name.padEnd(20)} ${flags}\n`);
          }
          break;
        }

        if (action === 'revoke') {
          const [keyId] = rest2;
          if (keyId === undefined) throw new Error('usage: key revoke <key-id>');
          runtime.keys.revoke(keyId);
          process.stdout.write(`${keyId} revoked\n`);
          break;
        }

        if (action === 'log') {
          const [owner] = rest2;
          if (owner === undefined) throw new Error('usage: key log <user>');
          const entries = runtime.keys.recentAccess(owner, 50);
          if (entries.length === 0) {
            process.stdout.write('no agent activity\n');
            break;
          }
          for (const entry of entries) {
            const when = new Date(entry.at).toISOString();
            const verdict = entry.allowed ? 'ok     ' : 'REFUSED';
            process.stdout.write(`${when}  ${verdict}  ${entry.tool.padEnd(14)} ${entry.path ?? ''}\n`);
          }
          break;
        }

        throw new Error('usage: key create|list|revoke|log ...');
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

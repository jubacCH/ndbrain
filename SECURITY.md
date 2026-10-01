# Security

## Reporting something

Please report a vulnerability privately rather than in a public issue: use
GitHub's [private reporting](https://github.com/jubacCH/ndbrain/security/advisories/new)
on this repository.

This is a project maintained by one person in their own time. There is no
bounty and no response-time commitment; what there is, is that a report will be
read and answered honestly, including when the answer is "this is known and
written down below".

## What ndBrain assumes about where it runs

Knowing this is the difference between a reasonable installation and a bad one.

- **TLS is somebody else's job.** ndBrain speaks plain HTTP and expects a
  reverse proxy in front of it. The session cookie is `Secure`, so a browser
  silently discards it over plain HTTP — the login answers 200, the cookie
  never arrives, and everything after is a 401. `NDBRAIN_COOKIE_SECURE=false`
  exists for a local test and turns off `Strict-Transport-Security` with it.
- **The port is not meant to face the internet.** The published compose file
  binds it to `127.0.0.1`.
- **There is no self-registration.** An account exists only because somebody
  ran `ndbrain-user`, which takes the password on stdin and not as an argument.
- **The container needs no capabilities, no new privileges and no writable root
  filesystem**, and the published compose file gives it none of the three.

## What the boundaries are

- **A vault belongs to one account.** Every path is resolved through one place
  (`server/src/vault/paths.ts`) and an account id is restricted to what can
  safely be a directory name, because it becomes one.
- **A share is the only way across that boundary**, and it is checked on the
  server for every request rather than reflected from what a client claims.
- **A refusal is indistinguishable from an absence.** Asking for a note you may
  not read answers exactly as asking for one that does not exist, down to the
  body. The same holds for an agent key that is wrong, revoked, expired or
  belongs to a disabled account: one answer, four causes.
- **An agent key can only ever see less than the account it belongs to** — its
  owner's vault, narrowed by its own folder scope. It does not follow the
  shares that account has been given.
- **Disabling an account stops its agent keys** as well as its sessions.

## What it does not protect against

Said plainly, because a threat model that lists only strengths is marketing.

- **An administrator can read everything.** They can reset any password and
  sign in. There is no encryption at rest and notes are plain files on disk;
  anybody with the disk has the notes.
- **A compromised agent key can do what its scope allows** until it is revoked,
  and the account's own owner is the one who sees and revokes it.
- **Prompt injection is not solved here.** An agent reading a note somebody else
  wrote is reading untrusted text, and ndBrain cannot know what that text talks
  it into doing with the key it holds. Scope keys narrowly.
- **The history and backup layer is optional and lives outside the server**
  (`ops/`). Without it there is no way back from a bad write except your own
  backups.
- **An unsigned Mac client** is in `desktop/`. macOS binds a Keychain item to a
  binary's signature, so an ad-hoc build asks for permission again after every
  rebuild. Signing needs a certificate.

## Versions

The latest release is the supported one. There is no long-term support branch.

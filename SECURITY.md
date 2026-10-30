# Security policy

Geode encrypts a vault on each device and stores the result on a server the user runs. A flaw in the
encryption, the plugin or the server can expose someone's notes, so reports are welcome and handled
in private.

## Supported versions

The latest release, for the plugin and for the server. They ship together from one tag. Older
versions get no fixes: update first, then check whether the problem is still there.

## Report a vulnerability

Use GitHub's private vulnerability reporting. Open the
[Security tab](https://github.com/Hrt-Htk/geode/security) of the repository, click **Report a
vulnerability** and write the report there. It stays visible to the maintainer only, and the advisory
it creates is where the fix is published.

Never open a public issue, discussion or pull request for a security problem. If details are already
public somewhere, say where in the private report.

A report is easier to act on with:

- the plugin version and the server version, or the commit;
- what an attacker gains and what they need to start;
- steps to reproduce, or a proof of concept;
- whether a client, the server, or both are affected.

## Scope

In scope:

- **The plugin.** Encryption, chunking, merge, apply and commit, the sync transport, the local state
  files, and the tokens the plugin stores on the device.
- **The server.** HTTP and WebSocket routes, authentication, the SQLite database, the blob store, and
  the end-to-end guarantee that the server never sees note contents or file paths.
- **The cryptography.** Key derivation, the deterministic nonces, and the keyed path hashes.
- **The install and deploy scripts** in `deploy/`.

Out of scope:

- **Your own server.** Hardening, firewall, TLS certificates, backups, and where the admin token is
  kept. `README.md` and `docs/` describe the setup; a server left open or misconfigured is the
  operator's responsibility.
- **Third-party services** in front of or beside it: a reverse proxy, Tailscale, a VPS provider, a
  backup target.
- **What the design already discloses.** A lost or unlocked device, a stolen device token, a weak
  passphrase, and a server operator who reads the metadata it holds are all expected. See
  [`Network use`](README.md#network-use) and [`Privacy and security`](README.md#privacy-and-security).
- **Upstream libraries.** Report a flaw in Obsidian, `libsodium` or `@noble/hashes` to that project.
  Tell the maintainer too when Geode's use of it makes the impact worse.

## Response

Geode is a personal project, maintained by one person in their own time. There is no promised
response time and no bug bounty. Reports are read and answered as soon as possible. A confirmed
problem gets a fix in the next release, and a GitHub security advisory that credits the reporter
unless they would rather stay anonymous.

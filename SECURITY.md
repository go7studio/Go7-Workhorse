# Security

Go7 Workhorse runs coding agents on your own machine, under your own vendor
logins. That shapes what "secure" means here: the app is not a service holding
your data, it is a desk handing real tools to models that read untrusted text.

## Reporting

Open a [security advisory](https://github.com/go7studio/Go7-Workhorse/security/advisories/new).
Please do not open a public issue for a vulnerability. A first reply should
take a few days.

Say what you did, what happened, and what you expected. A proof of concept
helps; a video is not needed.

## What the app assumes

- **Your machine is trusted.** Anything running as you can read what the desk
  reads. The desk does not defend against local malware.
- **Vendor CLIs are trusted.** Grok, Claude, Codex and Cursor run as
  themselves, under their own logins, with their own network access.
- **Model output is not trusted.** A file, a web page, or a tool result can
  carry instructions. That is the surface this project actually defends.

## Where the boundaries are

- **Permission mode** decides whether a tool call needs your approval.
  `Always approve` means it does not. That is a real choice with real
  consequences, not a convenience toggle.
- **Sandbox profile** decides where file tools may reach. `Off` means
  anywhere you can reach. `Workspace` contains them to the linked folders,
  compared by resolved real path, so a symlink or junction cannot walk out.
- **Credentials** live in the OS store — Keychain on macOS, DPAPI on Windows.
  The app refuses to save an API key when that store is unavailable rather
  than writing it in plain text.
- **The local bridge** binds loopback on an ephemeral port and requires a
  bearer token minted fresh each run.

Run `Always approve` with `Sandbox off` and you have turned both boundaries
off on purpose. It is a reasonable choice on a repository you own. It is not a
reasonable default for reading someone else's code.

## In scope

- Escaping the sandbox profile by any path spelling.
- Reaching a tool, a credential, or a file the current permission mode and
  sandbox should have refused.
- Anything that makes untrusted model output act as if it were you.
- Credentials written anywhere in plain text, or leaving the machine.

## Out of scope

- Anything requiring local code execution as your user to begin with.
- `Sandbox: off` or `Always approve` behaving as documented.
- A vendor CLI's own behaviour, or what a model chooses to say.
- Findings from a fork, unless they reproduce here.

## Supply chain

Four runtime dependencies. `npm audit --omit=dev` is clean and CI fails on a
secret pattern. Releases are built in CI, signed with the studio's Developer ID
and notarized by Apple; installers are attached only when both platforms build.

# Go7 Workhorse Launch Readiness Handoff

This checklist prepares the repository for a future public handoff without taking external action. Organization setup, domain work, trademark checks, repository transfer, visibility changes, and GitHub settings changes remain operator actions.

## Naming

- Repository and handoff name: Go7 Workhorse.
- Installable desktop application name: Go7 Workhorse.
- npm package name: `go7-workhorse`.
- Current repository remote: `git@github.com:Spikey222/Go7-Workhorse.git`.

## Local Repository Prep

- [x] README opens with the full Go7 Workhorse name.
- [x] README uses a generic checkout path instead of a machine-specific Windows user path.
- [x] Package metadata description, product name, and author identify Go7 Workhorse / Go7 Studio.
- [x] Root `LICENSE` uses MIT as the starting public-readiness license from the handoff.
- [x] CODEOWNERS exists with Steve and Liam as default owners.
- [ ] Review tracked generated artifacts (`dist/`, `dist-electron/`, `release/`) before making the repo public.
- [ ] Run a final secret scan before public visibility changes.
- [ ] Upgrade Electron or otherwise clear the current dev audit findings before public release builds.

## Operator Actions Before Public Launch

- [ ] Create or confirm the destination GitHub organization: `go7-workhorse`, `Go7-Workhorse`, controlled `go7studio`, or fallback `workhorse-ai`.
- [ ] Decide the destination repository name and owner.
- [ ] Transfer `Spikey222/Go7-Workhorse` to the Go7 Studio organization when ready.
- [ ] Update `package.json` repository URL after transfer.
- [ ] Replace `.github/CODEOWNERS` with the final Go7 Studio org team or maintainer handle after transfer.
- [ ] Decide whether the repository should remain private for more polish or become public under MIT.
- [ ] If public or open source, confirm GitHub settings: default branch protection, Actions permissions, release permissions, issue/discussion visibility, security advisories, Dependabot alerts, and secret scanning.
- [ ] Decide the public domain or docs URL, buy or assign the domain, and update README/package metadata only after the domain is controlled.
- [ ] Complete trademark clearance for "Go7 Workhorse", "Workhorse", app icons, installer names, and release artwork before broad public launch.
- [ ] Confirm app signing, release certificate ownership, and notarization/signing plan before distributing public installers.

## External Actions Not Performed In This Prep Pass

- No GitHub organization was created.
- No domain was purchased or configured.
- No repository transfer was attempted.
- No repository visibility or GitHub settings were changed.
- No public release or external publication was created.

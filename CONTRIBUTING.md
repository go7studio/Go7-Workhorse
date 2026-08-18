# Contributing

## What belongs in this repository

Production code, the tests that hold it up, and documentation a user or a
contributor reads. Nothing else.

Working papers do not belong here — slice plans, implementer briefs, handoffs,
findings written for whoever was building that week, scratch files, and material
specific to one company's own projects. They read as product documentation to
anyone who clones this, and they age badly. Keep them where the work happens.

Top level is a closed list. Adding a new folder to it is a decision, not a side
effect, so the shape check has to be updated in the same change.

| Path | Holds |
| --- | --- |
| `src/` | Renderer: types, store, UI |
| `electron/` | Main process: adapters, hosts, privileged work |
| `test/` | The suite |
| `eval/` | Eval kit contracts, fixtures and schemas |
| `scripts/` | Build, probe and release scripts referenced by `package.json` |
| `docs/` | Public-facing docs a stranger may read, including `FEATURES.md` |
| `skills/` | Skills that ship with the desk |
| `assets/`, `build/` | Icons and packaging inputs |

`docs/FEATURES.md` lists every ability the desk has. **Add to it in the same
commit as the feature.** A feature nobody documented is a feature nobody finds.
Operator product law does not live in this public repository.

## Versioning

[Semantic versioning](https://semver.org), held at major `0` until the product
boundary is stable. While Workhorse is pre-1.0, ordinary fixes and features
advance one patch at a time; only a breaking product-boundary change advances
the minor version. You never edit the version and you never tag anything —
your commit type decides both. See Releases below.

## Commits

Start the subject with a type, then say what changed and why it needed
changing. If the reason is a bug, describe the failure, not the symptom.

```
fix: Claude launches from a packaged build
feat: a chat can run in a managed git worktree
```

The type sets the next version, so it is not decoration:

| Type | Version | Use it for |
| --- | --- | --- |
| `fix:` | patch — `0.6.0` → `0.6.1` | a defect |
| `feat:` | patch before 1.0 — `0.6.0` → `0.6.1` | a new ability |
| `feat!:`, or a `BREAKING CHANGE:` footer | minor before 1.0 — `0.6.0` → `0.7.0` | a change that breaks how something worked |
| `docs:` `ci:` `build:` `test:` `refactor:` `chore:` | none | everything else |

Only `fix:` and `feat:` reach the changelog. Work of any other type still
ships with the next release; it just does not cut one on its own.

## Releases

1. Push to main as usual. Nothing publishes.
2. release-please opens a pull request called `chore(main): release <version>`
   holding the bump and the changelog entry, and rewrites it as more commits
   land.
3. Merge it when you want that version to exist. The tag, the release and both
   installers follow.

Merging is the only way to cut a version, so one cannot be skipped, reused, or
spent by accident. Under the old scheme any push touching `package.json`
published: `0.1.3` went missing, and `0.1.2` was built twice.

Both installers are built before either is published, so a release is whole or
it does not exist. `0.1.6` shipped a dmg with no exe and `0.1.8` an exe with no
dmg, each marked latest, each broken for half the people who downloaded it.

Run the Release workflow by hand to get installers to test. They attach to the
run, so testing costs no version number and publishes nothing.

## Try and ship

**Try** is how you see a change in a live window without cutting a version.
`npm run try:dry` prints the dest. `npm run try` packs this tree as a
development app and opens **Go7 Workhorse Dev**. It does not replace
`/Applications/Go7 Workhorse.app`. Production userData stays untouched.

**Ship** is how the production app moves. Pull latest `main`, merge the open
`chore(main): release …` pull request if it exists, wait for both signed
installers, and install that build. That install is everything on `main`
since the last tag — including work other agents already merged. Do not
cherry-pick. `scripts/install-mac.sh` is ship only.

A test must not hang. Typing must not journal the whole desk on each key.

## Before you push

```bash
npm run verify
```

That runs the build and the whole suite. It works the same in PowerShell, cmd
and a shell — Windows PowerShell 5.1 does not understand `&&`, so chaining the
two by hand fails there and nowhere else.

CI runs the same on Linux, Windows and macOS, plus a secret scan, a repo-shape
check, and a check that at least one commit in your pull request carries a type.
That last one fails when release-please would not see your work at all.

Tests must not read the machine they run on: inject `existsSync`/`readdir`, or
assert against `ROOT`. Never a home directory, and never a bare absolute path —
those pass on one laptop and fail on every other machine. Build paths with
`path.join` rather than writing separators, or the test passes here and fails on
Windows.

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
| `docs/` | Documentation people read, including `FEATURES.md` |
| `skills/` | Skills that ship with the desk |
| `assets/`, `build/` | Icons and packaging inputs |

`docs/FEATURES.md` lists every ability the desk has. **Add to it in the same
commit as the feature.** A feature nobody documented is a feature nobody finds.

## Versioning

[Semantic versioning](https://semver.org). While the major is `0`:

- **PATCH** (`0.1.8` → `0.1.9`) — a fix. Nothing new to learn.
- **MINOR** (`0.1.8` → `0.2.0`) — a new ability, or a change that alters how
  something already worked.
- **MAJOR** — held at `0` until the product boundary is stable.

Rules that come from getting this wrong:

- **One version per release, and never reuse one.** If a release published a
  bad or partial artifact, cut the next number. Rebuilding a published version
  leaves two different binaries wearing the same name.
- **Never skip a number.** `v0.1.3` does not exist, and now nobody can say why.
- **Bump only in a release commit**, and put the `CHANGELOG.md` entry in that
  same commit. The bump is what triggers the release workflow, so a stray bump
  ships.
- **The tag follows the build, not the other way round.** CI reads the version
  from `package.json` and publishes `v<version>`.

A release is only cut from a commit where CI is green on Linux, Windows and
macOS. The release job runs the whole suite on both packaging machines before
it builds anything, so a red suite publishes nothing rather than half of it.

## Commits

Say what changed and why it needed changing. The subject is a sentence, not a
label. If the reason is a bug, describe the failure, not the symptom.

## Before you push

```bash
npm run build && npm test
```

CI runs the same on three platforms, plus a secret scan and a repo-shape check.
Tests must not read the machine they run on: inject `existsSync`/`readdir`, or
assert against `ROOT`. Never a home directory, and never a bare absolute path —
those pass on one laptop and fail on every other machine.

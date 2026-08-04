---
name: release
description: Cut a new release of the Babu app by bumping the version in app.json and package.json, committing to main, and triggering the Build APK GitHub Actions workflow. Use whenever the user asks to release, cut a release, publish a new version, bump the version, or build a new production APK, for example cut a patch release or slash release minor. Optional argument is major, minor, patch, or an explicit version number, and asks which to use if none was given.
---

# Release

Cut a new release of the Babu app: bump the version, commit it to `main`, and
trigger the **Build APK** workflow (`.github/workflows/build-apk.yml`), which
builds the release APK and publishes it as a GitHub Release. This skill does
not build anything itself — everything after the version bump happens on the
Actions runner.

## 1. Pre-flight

- `git status` — the working tree must be clean. If it isn't, stop and ask the
  user to commit or stash first; this skill does not touch unrelated changes.
- Confirm the current branch is `main` and it is up to date with
  `origin/main` (`git fetch origin main && git status`). Releases build off
  `main`, since that's the ref `workflow_dispatch` runs. If not on `main`, ask
  before switching.

## 2. Determine the new version

The version lives in two places that must stay in sync: `app/app.json`
(`expo.version`) and `app/package.json` (`version`). Read the current value
from `app/app.json`.

**If a bump type or explicit version was given:**
- `major`, `minor`, or `patch` — bump that part of the current version
  (`X.Y.Z` → `(X+1).0.0` / `X.(Y+1).0` / `X.Y.(Z+1)`).
- A literal semver (`X.Y.Z`) — use it verbatim.
- Anything else — stop and ask instead of guessing.

**If none was given**, use `AskUserQuestion` to ask which part to bump.
Compute all three candidates first and show the resulting version in each
option's label so the user is picking a version, not an abstract category:
- patch → `X.Y.(Z+1)` — bug fixes
- minor → `X.(Y+1).0` — new features
- major → `(X+1).0.0` — breaking changes
- custom — let them type an exact version

Reject a chosen version that is not a strict increase over the current one.

## 3. Guard against repeats

- `git tag -l v{VERSION}` — abort if the tag already exists.
- Abort if `app/app.json` already has this version (i.e. nothing to bump).

## 4. Bump version files

Set the version to `VERSION` in:
- `app/app.json` — `expo.version`
- `app/package.json` — `version`
- `app/package-lock.json` — both the top-level `version` and the
  `packages[""].version` field (they must match `package.json` or `npm ci`
  fails on the runner)

## 5. Commit and push

Commit exactly those three files with message `Bump version to vVERSION` and
push to `main` (`git push -u origin main`, retrying per the standard
network-failure policy). Pushing straight to `main` is the point of this
skill — running it is the user's confirmation — but if the push is
rejected (e.g. `main` moved), stop and report rather than force-pushing.

## 6. Trigger the release build

Trigger the `Build APK` workflow on `main`:
`mcp__github__actions_run_trigger` with `method: run_workflow`,
`workflow_id: build-apk.yml`, `ref: main`. It takes no inputs — the workflow
reads the version straight from `app/app.json`, which the commit above just
updated.

If the GitHub MCP tools aren't available in this session, tell the user to
run it manually from the repo's Actions tab (`Build APK` → `Run workflow` on
`main`) instead of skipping this step silently.

## 7. Report

Look up the run that was just triggered (`mcp__github__actions_list` with
`method: list_workflow_runs`, `resource_id: build-apk.yml`, filtered to
`branch: main`) and report:

```
Version:  vVERSION (bumped from OLD_VERSION)
Commit:   <sha> on main
Workflow: <run URL> — building the APK and GitHub Release
```

The APK and GitHub Release are produced by the workflow itself once it
finishes; this skill's job ends once the run is confirmed started.

# Releasing tlive

Maintainer runbook. Releases are automated by
[release-please](https://github.com/googleapis/release-please) +
`.github/workflows/release-please.yml`. Nothing is published by hand.

Stable releases are the default path. The npm `beta` dist-tag is available but
opt-in — see [Cutting a beta](#cutting-a-beta).

## How the pipeline works

```
push to main  ──►  release-please job  ──►  opens/updates a release PR
                                            (version bump + CHANGELOG)
                                            nothing is published

merge the release PR  ──►  tag + GitHub Release  ──►  publish-npm  ──►  npm
```

**Merging the release PR is the release button.** Day-to-day merges into `main`
only make that PR fatter; it can sit open for weeks. The `publish-npm` job is
gated on `releases_created == 'true'`, so it stays skipped until then.

The dist-tag is derived from the version: anything with a prerelease suffix
goes to that suffix's tag (`2.0.0-beta.1` → `beta`), a plain version goes to
`latest`. `prepublishOnly` runs `npm run ci` (typecheck + tests + build) inside
the publish job as the last safety net.

## Version anchoring

The v2 rewrite landed as an orphan root commit, so every `v0.x` tag is
unreachable from `main`. release-please's release lookup therefore finds
nothing — and it does **not** read `package.json`.
`.release-please-manifest.json` supplies the anchor: it holds the current
version, and release-please bumps from it. Keep it in step with `package.json`.

Without it, release-please proposes a **downgrade** to its default initial
version. If a release PR ever shows a version lower than the manifest, that's
the symptom — don't merge it.

Once `v2.0.0` is tagged, the tag itself is reachable from `main` and becomes
the anchor; the manifest is then just belt and braces.

## Normal release

Land Conventional Commits on `main` and merge the release PR when you want a
release. release-please derives the bump from the commit types (`feat` → minor,
`fix` → patch, `!`/`BREAKING CHANGE` → major). Nothing else to configure.

Until `2.0.0` is out, npm `latest` resolves to `0.8.0` — the pre-v1
architecture — so a plain `npm i -g tlive` installs software that matches none
of the current docs. The first stable v2 release closes that gap.

## Cutting a beta

Optional. Add to `release-please-config.json` under `packages["."]`:

```json
"prerelease": true,
"prerelease-type": "beta"
```

That keeps the line tracking (`2.1.0-beta.0` → `2.1.0-beta.1`), and the publish
job routes any prerelease suffix to its own dist-tag, so `latest` is untouched.
Testers install with `npm i -g tlive@beta`. Remove both keys to return to
stable releases.

## `Release-As:`

The escape hatch any time the computed version is wrong — put it in the footer
of any commit going into `main`:

```
chore: cut 2.0.0

Release-As: 2.0.0
```

The repo's merge settings preserve commit bodies on squash, so the footer
survives any merge method. Prefer it over hand-editing `package.json`, which
release-please ignores.

## Pre-publish checklist

CI gates this on every PR, but before merging a release PR:

```bash
npm run ci                       # typecheck + tests + build (must be green)
npm pack --dry-run               # confirm the tarball contents (see below)
```

- The tarball **must** contain both `dist/src/` (CLI + daemon) and `dist/web/`
  (dashboard + terminal assets). The daemon serves `dist/web` at runtime, so a
  tarball missing it installs a broken web feature. This is why `package.json`
  `files` includes `dist/` (not just `dist/src/`).
- If anything under `plugins/**` changed, both bundled `plugin.json` versions
  must be bumped in lockstep and the lock refreshed
  (`node scripts/plugin-lock.mjs --update`) — enforced by
  `plugin-consistency.test.ts`.

## Notes

- Don't hand-edit the `release-please--branches--main` branch — it's
  bot-managed and gets recreated if deleted.
- `CHANGELOG.md` is generated. Hand-written history lives in
  [changelog-archive.md](changelog-archive.md).
- Publishing needs the `NPM_TOKEN` repo secret to be an **automation** or
  granular token; npm's 2FA enforcement rejects tokens that can't bypass the
  OTP prompt.
- `preuninstall` stops the daemon and removes the vendor plugins on
  `npm uninstall -g tlive`; see [uninstall.md](uninstall.md).
- The GitHub install path (`claude plugin marketplace add y49/tlive`) pulls the
  plugin straight from the repo's root `marketplace.json` and needs no npm
  publish — handy for testers who prefer not to use the beta tag.

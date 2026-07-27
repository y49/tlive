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

## Version numbers

Two independent version lines. Nothing links them, and that is deliberate.

**Line 1 — tlive itself.** Fully automated; never hand-edit any of it.

| Where | Written by |
| --- | --- |
| `package.json` `version` | release-please, in the release PR |
| `.release-please-manifest.json` | release-please, in the release PR |
| git tag `vX.Y.Z` + GitHub Release | release-please, on merging the release PR |
| npm dist-tag | the publish job, derived from the version |

The bump comes from the Conventional Commit types since the last release. To
override it, use a [`Release-As:`](#release-as) footer — not a manual edit,
which release-please ignores.

**Line 2 — the bundled plugin.** Manual, and three files must agree:
`plugins/{claude,codex}/plugins/tlive/…/plugin.json` and
`plugins/.content-lock.json` (version + a hash over all of `plugins/**`).

```bash
node scripts/plugin-lock.mjs --bump patch     # or minor / major / 2.6.0
```

That rewrites all three in one step, so they cannot drift.
`plugin-consistency.test.ts` fails the build if `plugins/**` changed without a
bump — a user's plugin cache only refreshes on a new version, so shipping
changed content under an unchanged version strands everyone on the old copy.
(`--update` still exists for the rare case of refreshing the lock without a
version change.)

**Why they aren't synced.** The plugin line is at 2.5.x while tlive is at 2.0.x,
so syncing would move the plugin *backwards* — and vendor update detection
compares versions, which is the same failure the content lock exists to
prevent. The two also change at different rates: the plugin is a hooks file, a
skill, and three commands, and it stays still across most tlive releases;
syncing would bump it on releases where its content is byte-identical. If one
number is ever wanted, the clean moment is when tlive's own version passes
2.5.x, so it's a bump rather than a downgrade.

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

## When the release lands but the publish does not

The pipeline is two jobs: release-please tags and cuts the GitHub Release,
then npm publishes. A credential or registry failure in the second leaves a
tagged, released version that never reached npm. Nothing needs rolling back —
the version is not taken until the registry accepts it.

**Re-running the failed run does not help.** A workflow run replays the
workflow file from the commit that triggered it, so a fix to
`release-please.yml` can never be applied that way. Use the manual trigger
instead:

```bash
gh workflow run release-please.yml
```

`publish-npm` bypasses the `releases_created` gate on `workflow_dispatch` and
publishes whatever version `package.json` holds on `main`. Republishing a
version that is already on the registry fails at the registry, which is the
safe direction.

Reading the failure: npm answers **404** — not 403 — for an unauthorized
`PUT`, so a `404 Not Found - PUT https://registry.npmjs.org/tlive` means *not
authorized*, never *package missing*. If pnpm also logged `Skipped OIDC: …`,
the trusted publisher is not configured on npmjs.com:

    npmjs.com -> tlive -> Settings -> Trusted Publisher -> GitHub Actions
    repository: y49/tlive   workflow: .github/workflows/release-please.yml

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
- If anything under `plugins/**` changed, bump the plugin line
  (`node scripts/plugin-lock.mjs --bump patch`) — see
  [Version numbers](#version-numbers). Enforced by
  `plugin-consistency.test.ts`, so CI catches a forgotten bump.

## Notes

- Don't hand-edit the `release-please--branches--main` branch — it's
  bot-managed and gets recreated if deleted.
- `CHANGELOG.md` is generated. Hand-written history lives in
  [changelog-archive.md](changelog-archive.md).
- Publishing carries **no npm credential**. It goes through npm trusted
  publishing: pnpm exchanges the workflow's GitHub OIDC id-token for a
  short-lived npm token, which is why `id-token: write` is in the workflow's
  permissions. Nothing to rotate, nothing to expire — the `NPM_TOKEN` secret it
  replaced aged out unnoticed and turned the 2.0.0 release into a registry 404.
- `preuninstall` stops the daemon and removes the vendor plugins on
  `npm uninstall -g tlive`; see [uninstall.md](uninstall.md).
- The GitHub install path (`claude plugin marketplace add y49/tlive`) pulls the
  plugin straight from the repo's root `marketplace.json` and needs no npm
  publish — handy for testers who prefer not to use the beta tag.

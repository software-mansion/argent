# Releasing Argent

This document describes how to publish a new version of `@software-mansion-labs/argent` to GitHub Packages.

---

## How it works

Two GitHub Actions workflows chain together to automate publishing:

```
git tag + push
      │
      ▼
┌─────────────────────────────┐
│  release.yml                │  triggered by: push to v* tag
│  → creates GitHub Release   │  generates changelog from merged PRs
│  → auto-generates changelog │
└────────────┬────────────────┘
             │ release created event
             ▼
┌─────────────────────────────┐
│  publish.yml                │  triggered by: release created
│  → npm ci                   │
│  → npm publish              │  pushes to https://npm.pkg.github.com
└─────────────────────────────┘
```

You push a version tag. `release.yml` creates a GitHub Release with an auto-generated changelog. That release event immediately triggers `publish.yml`, which builds and publishes the npm package.

---

## Releasing a new version

### 1. Bump the version

Update `version` in `packages/mcp/package.json`:

```bash
# manually edit the file, or use npm:
npm version patch --workspace packages/mcp --no-git-tag-version
npm version minor --workspace packages/mcp --no-git-tag-version
npm version major --workspace packages/mcp --no-git-tag-version
```

Commit the change:

```bash
git add packages/mcp/package.json
git commit -m "chore: bump argent to v1.1.0"
git push
```

### 2. Push a version tag

The tag name must match the version in `package.json` (prefixed with `v`):

```bash
git tag v1.1.0
git push origin v1.1.0
```

That's it. The two workflows take over from here.

### 3. Verify

- **Release** — go to the repo on GitHub → Releases. A new release should appear within ~30 seconds, with a changelog auto-populated from merged PR titles since the last tag.
- **Package** — go to the repo on GitHub → Packages (right sidebar). The new version of `@software-mansion-labs/argent` should appear after the publish job completes (~1–2 minutes total).

---

## Changelog quality

The auto-generated changelog is built from merged pull request titles since the previous tag. To get clean, readable release notes:

- Write descriptive PR titles
- Use a consistent prefix convention if you like (e.g. `feat:`, `fix:`, `chore:`) — GitHub groups them automatically

---

## What to do if publishing fails

1. Go to the repo → **Actions** tab.
2. Find the failed run under `Publish to GitHub Packages`.
3. Read the logs — the most common causes are:
   - **Version already exists** — you cannot republish the same version to GitHub Packages. Bump the version and re-tag.
   - **Permission error** — ensure the workflow has `packages: write` permission (already set in `publish.yml`).
   - **Access conflict** — `publishConfig` enforces `"access": "restricted"` (private). If GitHub rejects the publish due to an org-level policy conflict, contact an org admin.
4. To re-trigger publishing after fixing the issue, delete and re-push the tag:

```bash
git tag -d v1.1.0                  # delete local tag
git push origin --delete v1.1.0    # delete remote tag
git tag v1.1.0                     # re-create
git push origin v1.1.0             # push again
```

---

## Quick reference

| Task | Command |
|---|---|
| Patch release (e.g. 1.0.0 → 1.0.1) | `npm version patch -w packages/mcp --no-git-tag-version` → commit → `git tag v1.0.1 && git push origin v1.0.1` |
| Minor release (e.g. 1.0.0 → 1.1.0) | `npm version minor -w packages/mcp --no-git-tag-version` → commit → `git tag v1.1.0 && git push origin v1.1.0` |
| Major release (e.g. 1.0.0 → 2.0.0) | `npm version major -w packages/mcp --no-git-tag-version` → commit → `git tag v2.0.0 && git push origin v2.0.0` |
| Check published versions | GitHub repo → Packages |
| Check workflow runs | GitHub repo → Actions |

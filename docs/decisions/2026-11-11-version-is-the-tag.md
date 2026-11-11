## 2026-11-11 — The release tag is the version; releases are cut on GitHub

**Decision:** A release is a `vX.Y.Z` tag on `main`, made from GitHub's
release page (Draft a new release, new tag on `main`, Generate release notes,
Publish). Nothing in the tree is edited to cut one. The build reads the
version with `git describe --tags --match 'v[0-9]*'` (`0.2.2`, or
`0.2.2-3-g248d26f` past a tag) and writes it into `SOURCE.txt`; a GitHub
source zip has no `.git`, so `scripts/build/VERSION` carries the same
description through `export-subst`; a build that sees neither says
`unversioned`. `package.json`'s version is `0.0.0` and is not maintained.
GitHub Releases are the changelog; `CHANGELOG.md` is frozen at 0.2.1. Several
merged PRs may share one release. Supersedes 2026-11-03-versioning.md.

**Why:** Cutting 0.2.2 needed a bump PR whose only content was a number and
notes nobody had written, and the tag still had to be made by hand after the
squash-merge. With the tag as the version, a release is one GitHub action
with no commit, its notes are the merged PR titles, and the deploy's "HEAD is
a release" check needs no file to agree with.

## 2026-11-03 — Releases are SemVer tags with a hand-written changelog

**Decision:** `package.json` holds the one version string. A release bumps it
and adds its `CHANGELOG.md` section in a PR; after the squash-merge the merge
commit on `main` is tagged `vX.Y.Z` and a GitHub Release carries that section.
`v0.1.0` is `5f41359`, the first public build deployed. The build writes the
version into `SOURCE.txt`, and vect-hack-www's deploy refuses a commit that is
not the tag of its own version.

**Why:** `npm version` commits and tags on the branch, and a squash-merge
discards that commit, so the tag must come after the merge. Before this the
version never changed and nothing on the live site said which release it was.

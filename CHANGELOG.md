# Changelog

Each release is a `vX.Y.Z` tag on `main`, and the tag is the version.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions
follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The live
build names its version and commit in `/play/licenses/SOURCE.txt`.

**Frozen at 0.2.1.** Since then the release tag is the version and each
release's notes are its GitHub Release
(https://github.com/emulvihill/vect-hack/releases;
`docs/decisions/2026-11-11-version-is-the-tag.md`).

## [0.2.1] - 2026-11-06

### Changed

- The site moved to https://vecthack.net: the page's `og:image` and the
  release checklist point there (#9).
- The release checklist's deploy step describes the gated deploy: upload
  with no traffic, check the Access-gated Version URL, then promote.

## [0.2.0] - 2026-11-03

### Added

- Per-game licenses pages: each game's Saves panel links
  `licenses/<game>.html`, carrying VectHack's terms and that game's own and
  nothing of another game's (#4).
- `CREDITS`: a dedication to Ethan Sicotte and the authors of each game (#6).
- `SOURCE.txt` names the release version beside the built commit.

### Removed

- The Larn bot's LLM learning apparatus: the knowledge base, the reflect
  loop and the KB A/B tooling. The bot's knobs are code constants
  (`DEFAULT_TUNING`); its behaviour is unchanged (#5).

### Fixed

- Override `minimatch` to `^11.0.4` for a dev-only glob denial of service
  (Dependabot alert #1) (#2).

### Changed

- Trimmed `AGENTS.md` and `LICENSING.md` (#3); the licenses link is pinned
  through `main.ts` for every game (#7).

## [0.1.0] - 2026-11-02

First public release: NetHack 5.0, Angband 4.2.6, BSD Larn 12.0 and Umoria
5.7.15 in the browser, deployed to vecthack.com.

[0.2.1]: https://github.com/emulvihill/vect-hack/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/emulvihill/vect-hack/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/emulvihill/vect-hack/releases/tag/v0.1.0

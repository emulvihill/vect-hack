## 2026-11-13 — The Moria seed is staged inside build-moria-wasm.sh

**Decision:** `stage-moria-seed.sh` is folded into `build-moria-wasm.sh`. What
it did that matters stays: the two templates are filled from `version.h` and
the CHANGELOG release date, the literal 12-file allow-list is copied and
checked as an exact set, and the tree is staged in a sibling and swapped into
`build/moria/seed`. Its argument validation is gone: the absolute-path,
exact-destination, overlap and symlink checks, and the contract tests that
drove them.

**Why:** The stager had one caller, which always passed the fixed
`build/moria/seed`, so the guards defended a destination nobody could choose.
The seed bytes are unchanged; the build fingerprint still covers the
generation logic, now through the build script's own hash.

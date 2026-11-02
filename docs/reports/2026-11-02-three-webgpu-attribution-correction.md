# Correction to `2026-11-02-three-webgpu-attribution.md`, finding 4

Bead: `vect-hack-8gd7.1`.

Finding 4 says `check:payload`'s "transferred" column is uncompressed bytes
from `vite preview`. It is not. `vite preview` (vite 8.3.5) gzips responses:
`assets/Look-*.js` is 809,669 bytes on disk and arrives as 222,724 bytes with
`Content-Encoding: gzip`. So "transferred" was already gzip. It never showed
the three chunk at 840 kB. What it does miss is every request a worker makes,
because those land on the worker's performance timeline. The worker chunk and
the engine glue are fetched there.

The finding's numbers stand: the 840 kB is the raw chunk size the attribution
pass records (`chunks[].bytes`), and on the wire the chunk is 221 kB gzip or
180 kB brotli. Measured on this day's build, for every request a GPU load made:

| Module | transferred | gzip | brotli |
|---|---:|---:|---:|
| nethack | 258,048 | 280,596 | 231,358 |
| angband | 249,420 | 270,510 | 222,023 |
| larn | 248,400 | 267,961 | 219,904 |
| moria | 243,716 | 275,110 | 226,110 |

`check:payload` now reports `gzip` and `brotli` beside "transferred",
compressed with `node:zlib` at default levels from the built file behind every
recorded request (`docs/GATES.md`).

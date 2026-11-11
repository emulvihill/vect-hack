## 2026-11-11 — Phosphor trail gets a linear drain

**Decision:** The WebGPU trail subtracts a flat `persistence_drain_per_s`
(0.10/s) from the residue each frame before the exponential decay
(`src/render/effects/persistence.ts` `drain`, `Trail.ts`). The 0.30s
half-life is unchanged.

**Why:** On a phone the `?bot` demo smeared the whole screen for about 5s
after each move. The exponential alone never reaches black. Once the output is
sRGB-encoded, a full-scale stamp stays visible for about 3.5s, and an
overbright one (overlapping additive beams) for 4.4s. The camera follows the
hero, so every move ghosts the whole scene. The drain ends the tail at about
1.4–2.3s and leaves the first half-life nearly unchanged. Compared on an
Android phone against the current trail and a 0.10s half-life; the drain was
chosen. A frame-time clamp fix was ruled out: the phone ran at 60fps.

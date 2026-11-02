// Phosphor persistence (vector-CRT model §3.4): how far to paint out the
// trail buffer this frame. A fading sharp stamp of the prior frame, not motion
// blur — and half-life in seconds, so the residual halves at the same wall-clock
// rate whatever the frame rate.

/** Alpha of the black quad over the trail: residual = 2^(-dt/half-life). */
export function fadeAlpha(dtS: number, halfLifeS: number): number {
  return 1 - 2 ** (-dtS / halfLifeS);
}

/** The other side of the same coin: the fraction of the prior frame that
 *  survives this one, `2^(-dt/half-life)` == `1 - fadeAlpha(dt, hl)`. The
 *  ping-pong trail scales by this directly instead of painting its complement. */
export function residual(dtS: number, halfLifeS: number): number {
  return 2 ** (-dtS / halfLifeS);
}

// The degrade policy every Module's view choice follows, in one place: a
// `?view=debug` page and a browser with no GPU both keep the tty-style view
// that proved that Module's bridge, and both lose the canvas; everything else
// gets the vector view. Only the policy is shared — main.ts still names each
// game's views, session, and chrome literally.
//
// The two views arrive as LOADERS, not as classes, and only the winner's is
// called (vect-hack-po4). A browser with no GPU is shown a character grid, and
// it used to download the whole WebGPU renderer to draw it: the caller had to
// resolve both `import()`s before it could ask this function anything, so the
// loser's chunk — three/webgpu plus src/render, 810 kB of it — crossed the wire
// on a page that never built a canvas. Deciding first and fetching second costs
// the common case one probe's latency in front of the renderer's download and
// buys it no bytes at all; it is the tty arms that stop paying.
import { GPU_UNAVAILABLE_NOTICE, browserGpuProbe, gpuAvailable } from "./gpuSupport";

/**
 * Which arm ran, and the view it built. A discriminant rather than an
 * `instanceof` at the call site, because the call site no longer HAS the vector
 * class as a value — holding one would re-import the module this exists to keep
 * off a tty page. It gives up nothing: `view` is typed as that arm's own view,
 * so a renamed field on the vector view is still a type error in main.ts rather
 * than a HUD that silently never asks anything.
 */
export type ChosenView<V, T> =
  | { readonly kind: "vector"; readonly view: V }
  | { readonly kind: "tty"; readonly view: T };

/** `?view=debug` picks the tty view; `?gl` pins the vector view to WebGL. */
export async function chooseView<V, T extends { onNotice(text: string): void }>(views: {
  vector: () => Promise<new (canvas: HTMLCanvasElement, opts: { forceWebGL: boolean }) => V>;
  tty: () => Promise<new () => T>;
}): Promise<ChosenView<V, T>> {
  const canvas = document.getElementById("view") as HTMLCanvasElement;
  const flags = new URLSearchParams(location.search);
  const forceWebGL = flags.has("gl");
  if (flags.get("view") === "debug") {
    canvas.remove();
    const Tty = await views.tty();
    return { kind: "tty", view: new Tty() };
  }
  // A browser with no GPU is not a failure to report — it is a browser that
  // gets the text view. Asked before the renderer, which cannot decline politely.
  if (!await gpuAvailable(browserGpuProbe(), { forceWebGL })) {
    canvas.remove();
    const Tty = await views.tty();
    const view = new Tty();
    view.onNotice(GPU_UNAVAILABLE_NOTICE);
    return { kind: "tty", view };
  }
  const Vector = await views.vector();
  return { kind: "vector", view: new Vector(canvas, { forceWebGL }) };
}

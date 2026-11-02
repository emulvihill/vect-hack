// Whether this browser can give the page a GPU at all. Asked before the vector
// view is built, because three's WebGL fallback does not fail cleanly when the
// context is null — it walks into getSupportedExtensions() on it and throws a
// TypeError that reads like a bug here.
//
// navigator.gpu is not the question: VS Code's Simple Browser exposes it,
// refuses every adapter, and has no WebGL 2 underneath. Only an adapter that
// actually arrives counts, which is why the probe is async.

export interface GpuProbe {
  /** Did a WebGPU adapter actually come back? */
  webgpuAdapter: () => Promise<boolean>;
  /** Can a WebGL 2 context actually be created? */
  webgl2: () => boolean;
}

export const GPU_UNAVAILABLE_NOTICE =
  "This browser gives the page neither WebGPU nor WebGL, so the vector view has "
  + "nothing to draw on — running in the text view instead. Open the same URL in "
  + "Chrome or Firefox for the 3D dungeon.";

/** True if some backend three can use exists. `?gl` pins WebGL, so only it counts. */
export async function gpuAvailable(
  probe: GpuProbe,
  opts: { forceWebGL?: boolean } = {},
): Promise<boolean> {
  if (!opts.forceWebGL && await settles(probe.webgpuAdapter)) return true;
  return settles(probe.webgl2);
}

/** A probe that throws or rejects is a probe that said no. */
async function settles(probe: () => boolean | Promise<boolean>): Promise<boolean> {
  try {
    return await probe();
  } catch {
    return false;
  }
}

export function browserGpuProbe(): GpuProbe {
  return {
    webgpuAdapter: async () =>
      typeof navigator !== "undefined" && navigator.gpu != null
      && await navigator.gpu.requestAdapter() != null,
    // A throwaway canvas: a canvas keeps the first context it is given, and the
    // real one still has to go to three.
    webgl2: () => document.createElement("canvas").getContext("webgl2") != null,
  };
}

// A browser that hands the page no GPU at all — VS Code's built-in browser is
// the one people hit — used to reach the renderer and die inside three with a
// TypeError, which reads like a bug in this project. The decision to fall back
// to the text view is made here, off a probe, so it can be tested without one.
//
// The probe has to request an adapter rather than trust navigator.gpu: the
// embedded browser exposes navigator.gpu, refuses every adapter, and offers no
// WebGL 2 underneath — three then falls back to WebGL and throws on the null
// context. Presence of the API is not evidence of a GPU.
import { describe, expect, it } from "vitest";
import { GPU_UNAVAILABLE_NOTICE, gpuAvailable, type GpuProbe } from "../../src/ui/gpuSupport";

const probe = (webgpuAdapter: () => Promise<boolean>, webgl2: () => boolean): GpuProbe =>
  ({ webgpuAdapter, webgl2 });
const yes = async () => true, no = async () => false;

describe("gpuAvailable", () => {
  it("accepts a WebGPU adapter even where WebGL 2 is missing", async () => {
    expect(await gpuAvailable(probe(yes, () => false))).toBe(true);
  });

  it("accepts WebGL 2 alone", async () => {
    expect(await gpuAvailable(probe(no, () => true))).toBe(true);
  });

  it("rejects a browser offering neither", async () => {
    expect(await gpuAvailable(probe(no, () => false))).toBe(false);
  });

  it("does not take navigator.gpu's word for it: no adapter, no WebGPU", async () => {
    // VS Code's Simple Browser exactly: the API is there, the adapter is not.
    expect(await gpuAvailable(probe(no, () => false))).toBe(false);
  });

  it("treats a throwing getContext as no WebGL 2", async () => {
    expect(await gpuAvailable(probe(no, () => { throw new Error("blocked"); }))).toBe(false);
  });

  it("treats a rejected adapter request as no WebGPU", async () => {
    const rejects = () => Promise.reject(new Error("no adapter"));
    expect(await gpuAvailable(probe(rejects, () => false))).toBe(false);
    expect(await gpuAvailable(probe(rejects, () => true))).toBe(true);
  });

  it("ignores WebGPU when ?gl pins the WebGL backend", async () => {
    expect(await gpuAvailable(probe(yes, () => false), { forceWebGL: true })).toBe(false);
    expect(await gpuAvailable(probe(yes, () => true), { forceWebGL: true })).toBe(true);
  });
});

describe("GPU_UNAVAILABLE_NOTICE", () => {
  it("explains the fallback without reading as a crash", () => {
    expect(GPU_UNAVAILABLE_NOTICE).not.toMatch(/error|failed|TypeError/i);
    expect(GPU_UNAVAILABLE_NOTICE).toMatch(/WebGL/);
    expect(GPU_UNAVAILABLE_NOTICE).toMatch(/text view/i);
  });
});

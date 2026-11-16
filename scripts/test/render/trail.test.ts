// Phosphor persistence, driven through the real Trail. Trail's own decisions —
// which buffer is bound, which material is drawn, the scalars the drain and the
// composite carry, the stale frame after a rebuild, the autoClear it borrows —
// all reach the renderer as calls, so the renderer here is a one-pixel GPU: a
// target is one float, and a quad blends into it by its material's equation.
// What that GPU shows on the canvas is what the player would see.
import { describe, expect, it } from "vitest";
import {
  CustomBlending, MaxEquation, NormalBlending, PerspectiveCamera,
  ReverseSubtractEquation, Scene,
  type Camera, type Material, type RenderTarget, type Texture, type Vector2, type WebGPURenderer,
} from "three/webgpu";
import { Trail } from "../../../src/render/effects/Trail";
import { TOKENS } from "../../../src/render/palette";

const HL = TOKENS.glow.persistence_half_life_s;
const DRAIN = TOKENS.glow.persistence_drain_per_s;

type QuadMaterial = Material & { map: Texture | null; color: { r: number } };

class OnePixelGpu {
  /** This GPU where Trail asks for a renderer. */
  get renderer(): WebGPURenderer { return this as unknown as WebGPURenderer; }
  autoClear = true;
  /** What the scene draws into whichever target is bound. */
  stamp = 0;
  canvas = 0;
  drawingBuffer = { x: 640, y: 360 };
  bound: RenderTarget | null = null;
  readonly pixels = new Map<RenderTarget, number>();
  readonly owners = new Map<Texture, RenderTarget>();
  /** Every target ever bound, in order, and every quad material drawn. */
  readonly targets: RenderTarget[] = [];
  readonly materials: QuadMaterial[] = [];
  quads = 0;

  setRenderTarget(target: RenderTarget | null): void {
    this.bound = target;
    if (target) {
      this.owners.set(target.texture, target);
      if (!this.targets.includes(target)) this.targets.push(target);
    }
  }

  getDrawingBufferSize(out: Vector2): Vector2 {
    return out.set(this.drawingBuffer.x, this.drawingBuffer.y);
  }

  render(object: { isQuadMesh?: boolean; material?: QuadMaterial }, _camera: Camera): void {
    let dst = this.autoClear ? 0 : this.read(this.bound);
    if (!object.isQuadMesh) {
      dst = Math.max(dst, this.stamp);
    } else {
      const m = object.material!;
      this.quads++;
      if (!this.materials.includes(m)) this.materials.push(m);
      let src = m.color.r;
      if (m.map) {
        const from = this.owners.get(m.map) ?? null;
        // Sampling the target being written is a feedback loop: WebGPU refuses it.
        if (from === this.bound) throw new Error("sampled the bound render target");
        src *= this.read(from);
      }
      if (m.blending === NormalBlending) dst = src;
      else if (m.blending !== CustomBlending) throw new Error(`blending ${m.blending}`);
      else if (m.blendEquation === MaxEquation) dst = Math.max(dst, src);
      else if (m.blendEquation === ReverseSubtractEquation) dst -= src; // half float: no clamp
      else throw new Error(`equation ${m.blendEquation}`);
    }
    if (this.bound) this.pixels.set(this.bound, dst);
    else this.canvas = dst;
  }

  private read(target: RenderTarget | null): number {
    return target ? this.pixels.get(target) ?? 0 : this.canvas;
  }
}

const scene = new Scene();
const camera = new PerspectiveCamera();

function frame(trail: Trail, gpu: OnePixelGpu, stamp: number, dt: number): number {
  gpu.stamp = stamp;
  trail.render(gpu.renderer, scene, camera, dt);
  return gpu.canvas;
}

/** One stamp's residue on the canvas after `t` seconds at `fps`. */
function residue(peak: number, t: number, fps: number, perS = DRAIN): number {
  const trail = new Trail(HL, perS), gpu = new OnePixelGpu();
  const dt = 1 / fps;
  frame(trail, gpu, peak, dt);
  let shown = peak;
  for (let s = 0; s < Math.round(t * fps); s++) shown = frame(trail, gpu, 0, dt);
  return shown;
}

describe("phosphor persistence", () => {
  it("halves once per half-life without the drain", () => {
    expect(residue(1, HL, 60, 0)).toBeCloseTo(0.5, 6);
  });

  it("without the drain, a full-scale stamp is still above zero after 3s", () => {
    expect(residue(1, 3, 60, 0)).toBeGreaterThan(0);
  });

  it("the drain takes a full-scale stamp to true black by 1.5s", () => {
    expect(residue(1, 1.5, 60)).toBe(0);
    expect(residue(1, 1.5, 10)).toBe(0);
  });

  it("the drain takes an overbright stamp to true black by 2.5s", () => {
    expect(residue(8, 2.5, 60)).toBe(0);
  });

  it("the drain barely touches the first half-life", () => {
    expect(residue(1, HL, 60)).toBeGreaterThan(0.47);
  });
});

describe("Trail", () => {
  it("holds a static scene at its own brightness: the composite is a max, not a sum", () => {
    const trail = new Trail(), gpu = new OnePixelGpu();
    for (let i = 0; i < 300; i++) frame(trail, gpu, 1, 1 / 60);
    expect(gpu.canvas).toBe(1);
  });

  it("shows the first frame clean, then trails it from the second", () => {
    const trail = new Trail(HL, 0), gpu = new OnePixelGpu();
    expect(frame(trail, gpu, 1, 1 / 60)).toBe(1);
    expect(frame(trail, gpu, 0, HL)).toBeCloseTo(0.5, 6);
  });

  it("drains before the composite only while a drain is set", () => {
    const drained = new OnePixelGpu(), plain = new OnePixelGpu();
    const withDrain = new Trail(HL, DRAIN), noDrain = new Trail(HL, 0);
    for (let i = 0; i < 3; i++) {
      frame(withDrain, drained, 1, 1 / 60);
      frame(noDrain, plain, 1, 1 / 60);
    }
    // First frame: scene + blit. Each one after: scene + composite + blit, plus the drain.
    expect(plain.quads).toBe(1 + 2 * 2);
    expect(drained.quads).toBe(1 + 2 * 3);
  });

  it("puts the canvas back and gives back the caller's autoClear", () => {
    for (const autoClear of [true, false]) {
      const trail = new Trail(), gpu = new OnePixelGpu();
      gpu.autoClear = autoClear;
      frame(trail, gpu, 1, 1 / 60);
      frame(trail, gpu, 1, 1 / 60);
      expect(gpu.bound).toBeNull();
      expect(gpu.autoClear).toBe(autoClear);
    }
  });

  it("fits its buffers to the drawing buffer and drops the residue on a resize", () => {
    const trail = new Trail(HL, 0), gpu = new OnePixelGpu();
    trail.fit(gpu.renderer);
    frame(trail, gpu, 1, 1 / 60);
    // The same size is not a rebuild: the residue survives it.
    trail.fit(gpu.renderer);
    expect(frame(trail, gpu, 0, HL)).toBeCloseTo(0.5, 6);
    expect(gpu.targets.map((t) => [t.width, t.height])).toEqual([[640, 360], [640, 360]]);

    let disposed = 0;
    for (const t of gpu.targets) t.addEventListener("dispose", () => disposed++);
    trail.fit(gpu.renderer);
    expect(disposed).toBe(0);

    gpu.drawingBuffer = { x: 800, y: 600 };
    trail.fit(gpu.renderer);
    expect(disposed).toBe(2);
    // A fresh pair holds nothing worth trailing: the frame after a resize is clean.
    expect(frame(trail, gpu, 0, 1 / 60)).toBe(0);
    expect(gpu.targets.slice(2).map((t) => [t.width, t.height])).toEqual([[800, 600]]);
  });

  it("disposes both buffers and the drain material", () => {
    const trail = new Trail(HL, DRAIN), gpu = new OnePixelGpu();
    trail.setSize(8, 8);
    for (let i = 0; i < 3; i++) frame(trail, gpu, 1, 1 / 60);
    expect(gpu.targets).toHaveLength(2);
    const disposed = new Set<object>();
    for (const t of gpu.targets) t.addEventListener("dispose", () => disposed.add(t));
    const drain = gpu.materials.find((m) => m.blendEquation === ReverseSubtractEquation)!;
    drain.addEventListener("dispose", () => disposed.add(drain));
    trail.dispose();
    expect([...disposed]).toEqual(expect.arrayContaining([...gpu.targets, drain]));
    expect(disposed.size).toBe(3);
  });
});

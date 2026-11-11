// Phosphor persistence on the GPU (vector-CRT model §3.4): each frame is
// drawn fresh, then the previous frame's decayed residue is composited back over
// it with a MAX blend, and the result is blitted to the canvas. What survives is
// a fading sharp stamp of the prior frames — not motion blur — and it halves
// every half-life of wall-clock time whatever the frame rate.
//
// This is the ping-pong `max(new, prev·decay)` tier the model's §3.4 records
// as the deferred upgrade over the shipped single-FBO fade. vect-hack needs the
// upgrade rather than the default: the single-FBO form paints a black quad at
// `fadeAlpha` over the accumulation and re-draws the scene *additively* into
// it, which is bounded only for transients. A dungeon redraws the same static
// geometry every frame, so it reaches a steady state of draw/(1 - residual) —
// at the token's 0.30s half-life and 60fps that is ~26x the intended
// brightness, and every beam saturates flat white. Taking the max instead makes
// a static scene a fixed point: it trails motion and builds up nothing.
//
// The hazard the spec records still applies, with the roles moved: the composite
// quad *is* the fade now, and it must not be additive. Adding the residue back
// is exactly the accumulation described above; MAX is what keeps it bounded.
import {
  CustomBlending, HalfFloatType, MaxEquation, MeshBasicNodeMaterial, OneFactor,
  QuadMesh, RenderTarget, ReverseSubtractEquation, Vector2,
  type Camera, type Scene, type WebGPURenderer,
} from "three/webgpu";
import { TOKENS } from "../palette";
import { residual } from "./persistence";

/** An 8-bit residual quantizes: the last counts never reach zero and stick as
 *  permanent ghosts, so the trail has to hold float. */
const TRAIL_TYPE = HalfFloatType;
/** The trail is the only place the scene is rasterized, so it carries the MSAA. */
const TRAIL_SAMPLES = 4;

const size = new Vector2();

/** One side of the ping-pong: a buffer plus the two ways it gets sampled. */
class TrailBuffer {
  readonly target: RenderTarget;
  // Both materials sample this buffer through the material's `map` rather than a
  // TSL `texture()` node: importing `three/tsl` drags in a type graph tsc 7
  // cannot check in bounded memory, and `map` builds the same texture node
  // anyway. `MeshBasicNodeMaterial` multiplies `map` by `color`, which is how
  // the composite scales the residue without a shader of its own.
  readonly composite: MeshBasicNodeMaterial;
  readonly blit: MeshBasicNodeMaterial;

  constructor(width: number, height: number) {
    this.target = new RenderTarget(width, height, {
      type: TRAIL_TYPE, samples: TRAIL_SAMPLES, depthBuffer: true,
    });
    this.composite = new MeshBasicNodeMaterial({
      map: this.target.texture, depthTest: false, depthWrite: false,
      blending: CustomBlending, blendEquation: MaxEquation,
      blendSrc: OneFactor, blendDst: OneFactor,
    });
    this.blit = new MeshBasicNodeMaterial({
      map: this.target.texture, depthTest: false, depthWrite: false,
    });
  }

  dispose(): void {
    this.target.dispose();
    this.composite.dispose();
    this.blit.dispose();
  }
}

export class Trail {
  /** Ping-pong pair: `buffers[live]` is written this frame, the other one holds
   *  the frame before it. Sampling a buffer that is currently bound as the
   *  render target is illegal, which is why there are two. */
  private buffers = [new TrailBuffer(1, 1), new TrailBuffer(1, 1)];
  private readonly quad = new QuadMesh();
  private live = 0;
  /** A resized or brand-new buffer holds nothing worth trailing. */
  private stale = true;
  /** Subtracts a flat amount from the residue (dst - src), clamped by the MAX
   *  composite: anything driven below zero loses to the fresh draw's black. */
  private readonly drainMat = new MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false,
    blending: CustomBlending, blendEquation: ReverseSubtractEquation,
    blendSrc: OneFactor, blendDst: OneFactor,
  });

  constructor(
    public halfLifeSeconds = TOKENS.glow.persistence_half_life_s,
    public drainPerSecond = TOKENS.glow.persistence_drain_per_s,
  ) {}

  /** Draw one frame through the trail. `dt` is the frame's wall-clock seconds. */
  render(renderer: WebGPURenderer, scene: Scene, camera: Camera, dt: number): void {
    const cur = this.buffers[this.live]!;
    const prev = this.buffers[this.live ^ 1]!;
    const autoClear = renderer.autoClear;

    // The live scene, drawn clean: the accumulation is rebuilt every frame from
    // the fresh draw, so this one clears colour and depth like any normal render.
    renderer.setRenderTarget(cur.target);
    renderer.render(scene, camera);

    // ...then max the previous frame's residue in on top, in the same target.
    renderer.autoClear = false; // the scene above is what we are compositing into
    if (this.stale) {
      this.stale = false; // one frame of nothing to trail; `cur` is valid for the next
    } else {
      if (this.drainPerSecond > 0) {
        // Linear drain on top of the exponential: an exponential alone never
        // reaches black, and its dim tail stays visible for seconds once the
        // output is sRGB-encoded. Applied to `prev` before it is composited.
        renderer.setRenderTarget(prev.target);
        this.drainMat.color.setScalar(this.drainPerSecond * dt);
        this.quad.material = this.drainMat;
        this.quad.render(renderer);
        renderer.setRenderTarget(cur.target);
      }
      prev.composite.color.setScalar(residual(dt, this.halfLifeSeconds));
      this.quad.material = prev.composite;
      this.quad.render(renderer);
    }

    renderer.setRenderTarget(null);
    renderer.autoClear = autoClear;
    this.quad.material = cur.blit;
    this.quad.render(renderer);

    this.live ^= 1;
  }

  /**
   * Size in drawing-buffer pixels; the trail is sampled 1:1 by the blit.
   *
   * The pair is rebuilt rather than resized. three leaves the old GPU texture
   * behind a RenderTarget it has resized, and Line2NodeMaterial's transparent
   * path copies the framebuffer mid-pass at the *new* size — so every frame
   * after a resize fails WebGPU validation and the view never comes back. A
   * fresh target has no stale texture to leave behind, and resizes are rare.
   */
  setSize(width: number, height: number): void {
    if (this.buffers[0]!.target.width === width && this.buffers[0]!.target.height === height) return;
    for (const b of this.buffers) b.dispose();
    this.buffers = [new TrailBuffer(width, height), new TrailBuffer(width, height)];
    this.stale = true;
  }

  /** Fit the trail to a renderer's current drawing buffer. */
  fit(renderer: WebGPURenderer): void {
    renderer.getDrawingBufferSize(size);
    this.setSize(size.x, size.y);
  }

  dispose(): void {
    for (const b of this.buffers) b.dispose();
    this.drainMat.dispose();
  }
}

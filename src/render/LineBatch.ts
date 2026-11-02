// A pool of triangulated fat-line segments with the vector-CRT beam-bloom
// layer stack (model §3.2): one geometry, `beam_layers` meshes drawn from
// widest/dimmest halo to thinnest/brightest core, composited additively.
// Triangulated strokes, never GL_LINES — hardware lines are 1px with no joins.
import { AdditiveBlending, Color, Group } from "three/webgpu";
import { Line2NodeMaterial } from "three/webgpu";
import { LineSegments2 } from "three/addons/lines/webgpu/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { TOKENS } from "./palette";

export interface BeamLayer {
  widthMul: number;
  alpha: number;
}

/** The halo/core endpoints the spec fixes; the ramp between them is derived. */
const HALO_WIDTH_MUL = 4, CORE_WIDTH_MUL = 1;
const HALO_ALPHA = 0.1, CORE_ALPHA = 1;

/** Vector-CRT model §3.2: width 4->1, alpha 0.10->1.0 eased by t^2. Index 0 is halo.
 *  External caller: src/ui/hud/Radar.ts draws the HUD with the same stack. */
export function beamLayers(n: number): BeamLayer[] {
  if (n <= 1) return [{ widthMul: CORE_WIDTH_MUL, alpha: CORE_ALPHA }];
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return {
      widthMul: HALO_WIDTH_MUL + (CORE_WIDTH_MUL - HALO_WIDTH_MUL) * t,
      alpha: HALO_ALPHA + (CORE_ALPHA - HALO_ALPHA) * t * t,
    };
  });
}

/**
 * Split each layer's alpha between the normal depth-tested pass (main) and a
 * depthTest:false ghost pass. Additive blending makes the split exact: an
 * unoccluded stroke sums to the full alpha, an occluded one shows at `ghost`.
 * `ghost` is the fraction visible through walls — 1 minus the wall opacity.
 */
export function ghostSplit(
  layers: BeamLayer[], ghost: number,
): { main: number[]; ghost: number[] } {
  return {
    main: layers.map((l) => l.alpha * (1 - ghost)),
    ghost: layers.map((l) => l.alpha * ghost),
  };
}

const DEFAULT_WIDTH = 2;

export interface LineBatchOptions {
  /** Core stroke width in pixels (the halo layers scale up from this). */
  width?: number;
  /** Layer count; defaults to the token file's `glow.beam_layers`. */
  layers?: number;
  /**
   * Fraction of stroke brightness that shows through depth occluders (walls).
   * Strictly between 0 and 1: at the endpoints there is nothing to split —
   * opacity 1 is plain depth-tested lines, opacity 0 means no occluders exist.
   */
  ghost?: number;
}

export class LineBatch {
  readonly object = new Group();

  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly geometry = new LineSegmentsGeometry();
  /** Constructed width of each layer; setWidthScale() is measured from these. */
  private readonly baseWidths: number[] = [];
  /** Layers per pass; setBloomEnabled() needs this to find each pass's core. */
  private readonly layerCount: number;
  private n = 0;
  private overflowed = false;

  constructor(readonly capacity: number, opts: LineBatchOptions = {}) {
    this.positions = new Float32Array(capacity * 6);
    this.colors = new Float32Array(capacity * 6);
    this.geometry.setPositions(this.positions);
    this.geometry.setColors(this.colors);
    this.geometry.instanceCount = 0;

    const width = opts.width ?? DEFAULT_WIDTH;
    const layers = beamLayers(opts.layers ?? TOKENS.glow.beam_layers);
    this.layerCount = layers.length;

    if (opts.ghost === undefined) {
      // Today's behaviour, bit-identical: one depth-tested pass.
      this.addPass(layers, width, layers.map((l) => l.alpha), true);
    } else {
      const split = ghostSplit(layers, opts.ghost);
      this.addPass(layers, width, split.main, true);
      this.addPass(layers, width, split.ghost, false);
    }
  }

  /** Build one set of layer meshes sharing the batch's geometry. */
  private addPass(layers: BeamLayer[], width: number, alphas: number[], depthTest: boolean): void {
    layers.forEach((layer, i) => {
      const material = new Line2NodeMaterial({
        vertexColors: true,
        linewidth: width * layer.widthMul,
        transparent: true,
        opacity: alphas[i]!,
        depthWrite: false,
      });
      material.depthTest = depthTest;
      material.blending = AdditiveBlending;
      const mesh = new LineSegments2(this.geometry, material);
      mesh.frustumCulled = false; // the geometry is rewritten in place
      this.object.add(mesh);
      this.baseWidths.push(material.linewidth);
    });
  }

  /**
   * Thicken or thin the whole bloom stack, keeping the layers' ratios — and so
   * the halo-to-core ramp — exactly as the spec fixed them. Absolute, not
   * cumulative: the scale is always measured from the constructed widths, so
   * setting it twice is the same as setting it once, and 1 is the way back.
   * Strokes are screen-space pixels, so a camera that stands much closer to the
   * geometry than the widths were tuned for needs one of these.
   */
  setWidthScale(scale: number): void {
    this.object.children.forEach((mesh, i) => {
      (mesh as LineSegments2).material.linewidth = this.baseWidths[i]! * scale;
    });
  }

  /**
   * Hide the halo layers, leaving the bare core stroke, or put them back.
   * Diagnostics only (DungeonRenderer.setBloomEnabled): the cores alone are the
   * baseline a "does it actually glow" measurement has to be read against.
   */
  setBloomEnabled(enabled: boolean): void {
    // beamLayers(): halo first, core last, per pass — layerCount picks it out
    // whether there's one depth-tested pass or a main+ghost pair of them.
    this.object.children.forEach((mesh, i) => {
      mesh.visible = enabled || i % this.layerCount === this.layerCount - 1;
    });
  }

  /** Start a rebuild. Segments added before the next commit() replace the old. */
  begin(): void {
    this.n = 0;
  }

  /** Append one segment. `gain` scales brightness (additive: colour is alpha). */
  add(
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    color: Color, gain = 1,
  ): void {
    if (this.n >= this.capacity) {
      if (!this.overflowed) {
        this.overflowed = true;
        console.warn(`LineBatch overflow: more than ${this.capacity} segments; frame is clipped`);
      }
      return;
    }
    const p = this.n * 6;
    this.positions[p] = ax; this.positions[p + 1] = ay; this.positions[p + 2] = az;
    this.positions[p + 3] = bx; this.positions[p + 4] = by; this.positions[p + 5] = bz;
    const r = color.r * gain, g = color.g * gain, b = color.b * gain;
    this.colors[p] = r; this.colors[p + 1] = g; this.colors[p + 2] = b;
    this.colors[p + 3] = r; this.colors[p + 4] = g; this.colors[p + 5] = b;
    this.n++;
  }

  /** Publish the pending segments to the GPU. */
  commit(): void {
    const start = this.geometry.getAttribute("instanceStart");
    const colorStart = this.geometry.getAttribute("instanceColorStart");
    // Both start/end attributes view one interleaved buffer, so one flag each.
    ("data" in start ? start.data : start).needsUpdate = true;
    ("data" in colorStart ? colorStart.data : colorStart).needsUpdate = true;
    this.geometry.instanceCount = this.n;
  }

  get count(): number {
    return this.n;
  }

  dispose(): void {
    this.geometry.dispose();
    for (const mesh of this.object.children) (mesh as LineSegments2).material.dispose();
  }
}

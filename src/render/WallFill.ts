// The depth mask that makes walls opaque: fill quads for every exposed wall
// face plus a top cap, rendered with colorWrite off. It draws nothing — it
// writes depth in the opaque pass, so the additive line strokes behind a wall
// fail their depth test and clip. Against the black background the silhouette
// reads as solid black wall. Rebuilt whenever the terrain batch is.
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial } from "three/webgpu";
import type { FillSink } from "./TerrainBuilder";

export class WallFill implements FillSink {
  readonly mesh: Mesh;
  private readonly positions: Float32Array;
  private readonly geometry = new BufferGeometry();
  private n = 0;
  private overflowed = false;

  constructor(readonly capacity: number) {
    this.positions = new Float32Array(capacity * 12); // 4 corners x xyz
    const index = new Uint32Array(capacity * 6);
    for (let q = 0; q < capacity; q++) {
      const v = q * 4, i = q * 6;
      index[i] = v; index[i + 1] = v + 1; index[i + 2] = v + 2;
      index[i + 3] = v; index[i + 4] = v + 2; index[i + 5] = v + 3;
    }
    this.geometry.setAttribute("position", new BufferAttribute(this.positions, 3));
    this.geometry.setIndex(new BufferAttribute(index, 1));
    this.geometry.setDrawRange(0, 0);
    // DoubleSide: a grazing ray into a wall's interior must hit the far face
    // from behind and still write depth.
    const material = new MeshBasicMaterial({ colorWrite: false, side: DoubleSide });
    this.mesh = new Mesh(this.geometry, material);
    this.mesh.frustumCulled = false; // rewritten in place, same as LineBatch
    // A zero-index draw is a no-op on WebGL but WebGPU's validator logs it as
    // unusual; hide the mesh until the first commit has something to draw.
    this.mesh.visible = false;
  }

  begin(): void {
    this.n = 0;
  }

  quad(
    x1: number, y1: number, z1: number, x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number, x4: number, y4: number, z4: number,
  ): void {
    if (this.n >= this.capacity) {
      if (!this.overflowed) {
        this.overflowed = true;
        console.warn(`WallFill overflow: more than ${this.capacity} quads; mask is clipped`);
      }
      return;
    }
    this.positions.set([x1, y1, z1, x2, y2, z2, x3, y3, z3, x4, y4, z4], this.n * 12);
    this.n++;
  }

  commit(): void {
    this.geometry.getAttribute("position").needsUpdate = true;
    this.geometry.setDrawRange(0, this.n * 6);
    this.mesh.visible = this.n > 0;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as MeshBasicMaterial).dispose();
  }
}

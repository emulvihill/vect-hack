// Emits a stroke-font character into a LineBatch, optionally extruded into a
// genuine 3D wireframe letter: front and back copies joined by struts at each
// stroke's endpoints (endpoints only — full struts turn a letter into a mesh).
import { Matrix4, Vector3, type Color } from "three/webgpu";
import type { LineBatch } from "./LineBatch";
import { glyphStrokes } from "./vectorFont";

/** Struts read as structure, not stroke, so they burn dimmer than the faces. */
const STRUT_GAIN = 0.7;

const a = new Vector3();
const b = new Vector3();

/**
 * @param transform glyph space (x right, y up, z toward viewer) -> world
 * @param depth half-thickness of the extrusion; 0 draws a flat letter
 */
export function emitLetter(
  batch: LineBatch,
  ch: string,
  color: Color,
  gain: number,
  transform: Matrix4,
  depth = 0,
): void {
  const faces = depth > 0 ? [depth, -depth] : [0];
  for (const stroke of glyphStrokes(ch)) {
    for (const z of faces) {
      for (let i = 0; i + 3 < stroke.length; i += 2) {
        a.set(stroke[i]!, stroke[i + 1]!, z).applyMatrix4(transform);
        b.set(stroke[i + 2]!, stroke[i + 3]!, z).applyMatrix4(transform);
        batch.add(a.x, a.y, a.z, b.x, b.y, b.z, color, gain);
      }
    }
    if (depth > 0) {
      const last = stroke.length - 2;
      for (const i of last > 0 ? [0, last] : [0]) {
        a.set(stroke[i]!, stroke[i + 1]!, depth).applyMatrix4(transform);
        b.set(stroke[i]!, stroke[i + 1]!, -depth).applyMatrix4(transform);
        batch.add(a.x, a.y, a.z, b.x, b.y, b.z, color, gain * STRUT_GAIN);
      }
    }
  }
}

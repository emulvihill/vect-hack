// Offline scene preview: the frozen scenes in scene-fixtures.ts through a
// software rasterizer, written as PPMs. It is the only way to see what the
// renderer produces without a GPU, so renderer changes can be checked from a
// terminal. Colour and stroke width are approximate — the beam-bloom stack and
// additive compositing only exist on the GPU. It asserts nothing
// (scene-preview.test.ts pins the same scenes), so it runs under its own config
// and never under `npm test`.
//
// The NetHack/Angband PPMs are converted to PNGs by `npm run preview`; Larn and
// Moria keep their PPMs and directly write their PNG pairs too.
//
//   npm run preview            # writes NetHack/Angband PPM+PNG pairs; Larn/Moria PPM+direct PNG pairs
//   PREVIEW_RADIUS=7 npm run preview
import { it } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { dirname } from "node:path";
import type { PerspectiveCamera } from "three/webgpu";
import {
  HEIGHT, WIDTH, angbandScene, larnScene, moriaScene, nethackScene, projector,
  type Scene, type Seg,
} from "./scene-fixtures";

const OUT = process.env.PREVIEW_OUT ?? ".preview/nethack-scene.ppm";
const OUT_FP = process.env.PREVIEW_FP_OUT ?? ".preview/nethack-scene-fp.ppm";
const OUT_ANGBAND = process.env.PREVIEW_ANGBAND_OUT ?? ".preview/angband-scene.ppm";
const OUT_ANGBAND_FP =
  process.env.PREVIEW_ANGBAND_FP_OUT ?? ".preview/angband-scene-fp.ppm";
const OUT_LARN = process.env.PREVIEW_LARN_OUT ?? ".preview/larn-scene.ppm";
const OUT_LARN_FP = process.env.PREVIEW_LARN_FP_OUT ?? ".preview/larn-scene-fp.ppm";
const OUT_LARN_PNG = process.env.PREVIEW_LARN_PNG_OUT ?? ".preview/larn-scene.png";
const OUT_LARN_FP_PNG =
  process.env.PREVIEW_LARN_FP_PNG_OUT ?? ".preview/larn-scene-fp.png";
const OUT_MORIA = process.env.PREVIEW_MORIA_OUT ?? ".preview/moria-scene.ppm";
const OUT_MORIA_FP = process.env.PREVIEW_MORIA_FP_OUT ?? ".preview/moria-scene-fp.ppm";
const OUT_MORIA_PNG = process.env.PREVIEW_MORIA_PNG_OUT ?? ".preview/moria-scene.png";
const OUT_MORIA_FP_PNG =
  process.env.PREVIEW_MORIA_FP_PNG_OUT ?? ".preview/moria-scene-fp.png";
const BRIGHTNESS = 190; // maps a 0..1 colour channel to 0..255

/** Draw every segment additively, one pixel wide with a half-bright smear
 *  down and right for a hint of the GPU's bloom, and write the PPM. */
function rasterize(segments: readonly Seg[], camera: PerspectiveCamera, out: string): void {
  const project = projector(camera);
  const pixels = Buffer.alloc(WIDTH * HEIGHT * 3, 0);
  const plot = (x: number, y: number, r: number, g: number, b: number) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
    const o = (y * WIDTH + x) * 3;
    pixels[o] = Math.min(255, pixels[o]! + r);
    pixels[o + 1] = Math.min(255, pixels[o + 1]! + g);
    pixels[o + 2] = Math.min(255, pixels[o + 2]! + b);
  };
  for (const s of segments) {
    const A = project(s.a), B = project(s.b);
    if (A.z > 1 || B.z > 1) continue; // behind the near plane
    const r = Math.min(255, s.r * BRIGHTNESS);
    const g = Math.min(255, s.g * BRIGHTNESS);
    const b = Math.min(255, s.b2 * BRIGHTNESS);
    const steps = Math.max(1, Math.ceil(Math.hypot(B.x - A.x, B.y - A.y)));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps, x = A.x + (B.x - A.x) * t, y = A.y + (B.y - A.y) * t;
      plot(x, y, r, g, b);
      plot(x + 1, y, r / 2, g / 2, b / 2);
      plot(x, y + 1, r / 2, g / 2, b / 2);
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${WIDTH} ${HEIGHT}\n255\n`), pixels]));
}

/** `npm run preview` converts the NetHack/Angband PPMs after Vitest returns.
 * Larn's and Moria's pairs are encoded here too, preserving the software-
 * rasterizer source image beside the PNG. This stays in-process: Vitest's
 * worker sandbox cannot spawn ImageMagick. */
function png(ppm: string, out: string): void {
  const p6 = readFileSync(ppm);
  const header = Buffer.from(`P6\n${WIDTH} ${HEIGHT}\n255\n`);
  const rgb = p6.subarray(header.length);
  const scanlines = Buffer.alloc(HEIGHT * (1 + WIDTH * 4));
  for (let y = 0; y < HEIGHT; y++) {
    const dst = y * (1 + WIDTH * 4);
    const src = y * WIDTH * 3;
    for (let x = 0; x < WIDTH; x++) {
      const i = src + x * 3, o = dst + 1 + x * 4;
      scanlines[o] = rgb[i]!;
      scanlines[o + 1] = rgb[i + 1]!;
      scanlines[o + 2] = rgb[i + 2]!;
      scanlines[o + 3] = 255;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(WIDTH);
  ihdr.writeUInt32BE(HEIGHT, 4);
  ihdr[8] = 8; // RGBA8
  ihdr[9] = 6;
  writeFileSync(out, Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(scanlines)), chunk("IEND", Buffer.alloc(0)),
  ]));
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** The orbital frame to `out`, the first-person one to `outFp`. */
function writePair(scene: Scene, out: string, outFp: string): void {
  rasterize([...scene.terrain, ...scene.entities], scene.orbit.camera, out);
  rasterize([...scene.terrain, ...scene.inside], scene.fp.camera, outFp);
}

it("writes the scene previews", () => {
  writePair(nethackScene(), OUT, OUT_FP);
  writePair(angbandScene(), OUT_ANGBAND, OUT_ANGBAND_FP);
  writePair(larnScene(), OUT_LARN, OUT_LARN_FP);
  png(OUT_LARN, OUT_LARN_PNG);
  png(OUT_LARN_FP, OUT_LARN_FP_PNG);
  writePair(moriaScene(), OUT_MORIA, OUT_MORIA_FP);
  png(OUT_MORIA, OUT_MORIA_PNG);
  png(OUT_MORIA_FP, OUT_MORIA_FP_PNG);
});

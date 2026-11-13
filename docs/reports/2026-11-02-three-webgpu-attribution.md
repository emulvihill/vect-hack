# The 840 kB every visitor pays: where it goes, and why it stays

Bead: `vect-hack-po4`, direction 2. Closes the bead. Direction 1 (the no-GPU
page never fetches the renderer) landed 2026-08-29 and is guarded by
`check:payload`'s `--disable-3d-apis` arm (`docs/GATES.md`).

## Question

`check:payload` attributes 839.6 kB of every Module's cold-cache download to
one chunk: `three/webgpu` plus `src/render`. The bead asked which of
`Line2NodeMaterial`, `LineSegments2`, `WebGPURenderer` and the node system
dominate, whether the `?gl` path shares them, and whether any of it can be
trimmed without touching the visual style.

## Method

three 0.185.1. Each arm is a one-line entry importing exactly the names
`src/render` imports, bundled with rolldown (the bundler under this vite),
`format: esm`, `minify: true`, with `three`, `three/webgpu` and `three/tsl`
aliased to `node_modules/three/src/*` so attribution lands on source
directories rather than on the two prebuilt files (`three.webgpu.js`,
`three.core.js`) the package's exports map resolves to. Byte attribution is
rolldown's `renderedLength` per module, pre-minify. Compressed sizes are
`zlib` gzip at default level and brotli at default quality.

Import surface measured (`grep -rhoE "from ['\"]three[^'\"]*['\"]" src`):
16 files import from `three/webgpu`, one each from
`three/addons/lines/webgpu/LineSegments2.js` and
`three/addons/lines/LineSegmentsGeometry.js`. Named imports used:
`AdditiveBlending Box3 BufferAttribute BufferGeometry Color DoubleSide Group
Line2NodeMaterial Matrix4 Mesh MeshBasicMaterial PerspectiveCamera Plane
Raycaster Scene Vector2 Vector3 WebGPURenderer`.

## Results

| Arm | minified | gzip |
|---|---:|---:|
| A. current: `three/webgpu` renderer + `Line2NodeMaterial` + `LineSegments2` | 772 kB | 207 kB |
| B. `WebGPURenderer` alone (Scene, Camera, MeshBasicMaterial; no line stack) | 757 kB | 203 kB |
| C. `Line2NodeMaterial` alone | 225 kB | 62 kB |
| D. classic `three` `WebGLRenderer` + addons `LineMaterial` + `LineSegments2` | 548 kB | 139 kB |
| E. core only (Scene, PerspectiveCamera, Vector3, Color, Raycaster) | 65 kB | 19 kB |

The shipped chunk on this day's `vite build` (`dist/assets/Look-*.js`, three
plus `src/render`): 809,669 bytes raw, 220,962 gzip, 179,723 brotli.

Arm A by source directory, rendered bytes before minification (top of the
list; the whole arm is 2.49 MB pre-minify):

| bytes | directory |
|---:|---|
| 127,403 | `renderers/webgpu/utils` |
| 92,830 | `renderers/common/Renderer.js` |
| 91,196 | `renderers/webgl-fallback/utils` |
| 76,778 | `renderers/webgpu/nodes` |
| 72,149 | `renderers/webgpu/WebGPUBackend.js` |
| 69,938 | `nodes/core/NodeBuilder.js` |
| 64,759 | `renderers/webgl-fallback/WebGLBackend.js` |
| 44,732 | `renderers/common/XRManager.js` |
| 44,001 | `renderers/common/nodes` |
| 43,463 | `renderers/webgl-fallback/nodes` |
| 39,983 | `materials/Material.js` |
| 37,015 | `core/Object3D.js` |
| 31,686 | `math/Matrix4.js` |
| 30,600 | `core/BufferGeometry.js` |
| 28,122 | `nodes/math/MathNode.js` |
| 28,106 | `materials/nodes/NodeMaterial.js` |

## Findings

1. **The renderer is the cost.** `WebGPURenderer` alone (B) is 757 of A's
   772 kB. The line stack the bead named as suspects — `Line2NodeMaterial`
   and `LineSegments2` — adds ~15 kB minified, ~5 kB gzip, on top of it,
   because the node system it needs is already there for the renderer. C's
   225 kB standing alone is the node system, not the line material.
2. **`?gl` shares everything.** `WebGPURenderer` statically imports both
   `WebGPUBackend` and the `webgl-fallback` backend (~300 kB and ~200 kB
   pre-minify respectively, with their utils and nodes); `forceWebGL` and
   the automatic fallback choose between them at run time. Neither backend
   is tree-shakeable without patching three, and `XRManager` (45 kB) rides
   along the same way.
3. **The only lever that moves the number is leaving `three/webgpu`.** Arm D,
   the classic `WebGLRenderer` with the addons `LineMaterial`, saves 68 kB
   gzip (33%) and removes WebGPU from the product. Declined: the project is
   "WebGPU, WebGL fallback" (`AGENTS.md`), and 68 kB gzip does not buy that.
4. **The visitor pays ~180 kB, not 840.** The bead's figure, and
   `check:payload`'s "transferred" column, are uncompressed bytes from
   `vite preview`. The live site serves gzip and brotli: the same chunk
   arrives as 221 kB gzip or 180 kB brotli. Filed as `vect-hack-8gd7.1`: the gate should report
   a compressed column so its numbers match what is served.
5. **Cache stability is the open question, not size.** The three chunk and
   `src/render` are one file, so every render fix changes the hash and a
   returning visitor re-downloads 180 kB of unchanged library to get a few
   kB of change. A `manualChunks` vendor split would make the three chunk
   stable across deploys at the price of one extra request on a first visit.
   Not filed; Eric decides.

## Decision

`vect-hack-po4` closes: measured, and the headline cannot be trimmed without
changing what the product is. `check:payload`'s direction-1 guard stays as the
regression floor. The physics tokens were not touched and were never in
question.

## Reproduce

```js
// node measure.mjs, from the repo root
import { rolldown } from "rolldown";
import { gzipSync } from "node:zlib";
import { resolve } from "node:path";
const T = resolve("node_modules/three/src");
const alias = { "three/webgpu": `${T}/Three.WebGPU.js`, "three/tsl": `${T}/Three.TSL.js`, three: `${T}/Three.js` };
const code = `import {WebGPURenderer,Line2NodeMaterial,Scene,PerspectiveCamera,Raycaster,MeshBasicMaterial} from "three/webgpu";
import {LineSegments2} from "three/addons/lines/webgpu/LineSegments2.js";
console.log(WebGPURenderer,Line2NodeMaterial,Scene,PerspectiveCamera,Raycaster,MeshBasicMaterial,LineSegments2)`;
const b = await rolldown({ input: "virtual:entry", resolve: { alias }, plugins: [{ name: "v",
  resolveId: id => id === "virtual:entry" ? id : null, load: id => id === "virtual:entry" ? code : null }] });
const { output: [c] } = await b.generate({ format: "esm", minify: true });
console.log(Buffer.byteLength(c.code), "gz", gzipSync(c.code).length);
const agg = {};
for (const [id, m] of Object.entries(c.modules)) {
  const k = id.replace(/.*node_modules\/three\//, "").replace(/^src\//, "").split("/").slice(0, 3).join("/");
  agg[k] = (agg[k] || 0) + m.renderedLength;
}
Object.entries(agg).sort((a, b) => b[1] - a[1]).slice(0, 16).forEach(([k, v]) => console.log(v, k));
```

Swap the entry's imports for arms B–E.

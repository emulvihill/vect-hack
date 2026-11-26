// How a drawn frame reaches the canvas: through the phosphor trail
// (effects/Trail.ts) or straight there.
import type { Camera, Scene, WebGPURenderer } from "three/webgpu";

export interface FramePresenter {
  render(renderer: WebGPURenderer, scene: Scene, camera: Camera, dt: number): void;
  fit(renderer: WebGPURenderer): void;
  dispose(): void;
}

/** Straight to the canvas. */
export const DIRECT: FramePresenter = {
  render: (renderer, scene, camera) => renderer.render(scene, camera),
  fit: () => {},
  dispose: () => {},
};

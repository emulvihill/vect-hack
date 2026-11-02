// The narrow surface scripts/dev/browser-check.mjs drives. That check needs a
// GPU and so is not part of npm test, which is exactly why the seams it reads
// belong here: an assertion aimed at something that has quietly moved reports
// the app as broken, and one aimed at something that is always true reports it
// as healthy whatever the renderer does.
import { describe, expect, it } from "vitest";
import type { DungeonCamera } from "../../src/render/DungeonCamera";
import { FirstPersonCam } from "../../src/render/FirstPersonCam";
import { LineBatch } from "../../src/render/LineBatch";
import { OrbitCam } from "../../src/render/OrbitCam";
import { TOKENS } from "../../src/render/palette";

/** The cameras only bind pointer events here; nothing fires any of them. */
const stubDom = () => ({ addEventListener() {}, removeEventListener() {} }) as unknown as HTMLElement;

describe("camera drift", () => {
  const cameras = (): DungeonCamera[] => [new OrbitCam(stubDom()), new FirstPersonCam(stubDom())];

  it("measures how far the view still is from the hero, either camera", () => {
    for (const cam of cameras()) {
      cam.follow(10, 10);
      cam.snap();
      expect(cam.drift).toBeCloseTo(0, 9);
      cam.follow(16, 10); // the hero walked six cells east
      expect(cam.drift).toBeCloseTo(6, 9);
      for (let i = 0; i < 200; i++) cam.update(1 / 60);
      expect(cam.drift).toBeLessThan(0.01); // the follow caught up
      cam.dispose();
    }
  });
});

describe("bloom toggle", () => {
  const visible = (batch: LineBatch) => batch.object.children.map((m) => m.visible);

  it("draws the bare core alone, and puts the halo layers back", () => {
    const batch = new LineBatch(8);
    const layers = TOKENS.glow.beam_layers;
    expect(visible(batch)).toEqual(Array(layers).fill(true));

    batch.setBloomEnabled(false);
    expect(visible(batch)).toEqual([...Array(layers - 1).fill(false), true]);
    // The survivor is the core, not whichever mesh happens to be last: only the
    // core layer carries full alpha (vector-CRT model §3.2, beamLayers()).
    const [survivor] = batch.object.children.filter((m) => m.visible);
    expect((survivor as unknown as { material: { opacity: number } }).material.opacity).toBe(1);

    batch.setBloomEnabled(true);
    expect(visible(batch)).toEqual(Array(layers).fill(true));
    batch.dispose();
  });
});

describe("camera heading", () => {
  it("is the bearing movement resolves against, on either camera", () => {
    const orbit = new OrbitCam(stubDom());
    expect(orbit.heading).toBeCloseTo(orbit.azimuth, 9);
    // turnBy is optional on the interface; OrbitCam's own type doesn't declare
    // it at all, so the check against DungeonCamera is what "does not
    // keyboard-turn" actually means.
    expect((orbit as DungeonCamera).turnBy).toBeUndefined();

    const fp = new FirstPersonCam(stubDom());
    fp.turnBy!(Math.PI / 4);
    expect(fp.heading).toBeCloseTo(Math.PI / 4, 9);
    expect(fp.azimuth).toBeCloseTo(0, 9); // heading leads; azimuth is what is drawn
    orbit.dispose();
    fp.dispose();
  });
});

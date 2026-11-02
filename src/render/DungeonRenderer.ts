// Owns the WebGPU (WebGL-fallback) renderer, the scene, and the frame loop.
// Two batches: terrain, rebuilt when the level's terrain changes or the hero
// carries the light to another cell, and entities, rebuilt every frame because
// each glyph carries its own transform. Both go through the phosphor trail on
// WebGPU; the WebGL fallback draws them straight to the canvas (see frame()).
import { Color, Plane, Raycaster, Scene, Vector2, Vector3, WebGPURenderer } from "three/webgpu";
import type { CameraMode, DungeonCamera } from "./DungeonCamera";
import { FirstPersonCam } from "./FirstPersonCam";
import { LineBatch } from "./LineBatch";
import { OrbitCam, type OrbitFraming } from "./OrbitCam";
import { buildTerrain } from "./TerrainBuilder";
import { WallFill } from "./WallFill";
import { ENTITY_CAPACITY, buildEntities } from "./EntityLayer";
import { pickEntityCell } from "./pick";
import { MapFx } from "./effects/mapFx";
import { Trail } from "./effects/Trail";
import type { Cell, CellGrid } from "../backplane/cell";
import { activeSkin } from "../skins";

const MAX_EDGES_PER_CELL = 16;
/**
 * Stroke widths (see SKIN.strokes below) are pixels, tuned at orbit distance.
 * First person stands within a cell or two of the geometry, where the same
 * pixels read thin against a wall that now fills the frame — so the whole
 * bloom stack is scaled, keeping the halo/core ramp intact. Modest on purpose:
 * bigger and the near wall smears.
 */
const FP_WIDTH_SCALE = 1.3;
/** Retina is worth it; beyond 2x costs fill rate for no visible gain. */
const MAX_PIXEL_RATIO = 2;
/** Clamp dt so a backgrounded tab does not jump every animation forward. */
const MAX_FRAME_SECONDS = 0.1;

const SKIN = activeSkin();
/** Ghost fraction: what shows through a wall. Endpoints mean no split at all. */
const ghost = 1 - SKIN.walls.opacity;
const GHOST = ghost > 0 && ghost < 1 ? ghost : undefined;

export interface DungeonRendererOptions {
  /** Take the WebGL 2 backend even where WebGPU works (the `?gl` dev flag). */
  forceWebGL?: boolean;
}

export class DungeonRenderer {
  /**
   * Runs at the end of every frame with the camera bearing. HUD overlays that
   * have to stay oriented to the camera ride this rather than a second rAF
   * loop of their own.
   */
  onFrame: ((facing: number) => void) | null = null;

  private readonly scene = new Scene();
  private cam: DungeonCamera;
  private currentMode: CameraMode = "orbital";
  /** The orbital camera's drag pitch and zoom, held across a swap: the
   *  replacement is a fresh OrbitCam, and only the bearing rides makeCam. It
   *  carries whose radius that is too, so a framing the viewport chose stays
   *  the viewport's to revise (OrbitCam.framing). */
  private orbitFraming: OrbitFraming | null = null;
  private readonly renderer: WebGPURenderer;
  private readonly terrain: LineBatch;
  private readonly entities: LineBatch;
  private readonly wallFill: WallFill | null;
  private readonly fx: MapFx;
  private readonly trail = new Trail();
  private readonly raycaster = new Raycaster();
  /** The map lives at y=0 (see EntityLayer's place()); pickCell() never needs
   *  the entities' own hover height, since a cell owns whatever is on it. */
  private readonly floorPlane = new Plane(new Vector3(0, 1, 0), 0);

  private builtRevision = -1;
  /** Hero cell the terrain light was baked for; the light moves with them. */
  private builtHero: { x: number; y: number } | null = null;
  /** The cell the Look HUD is naming, ringed by the entity pass. */
  private highlight: { x: number; y: number } | null = null;
  private last = 0;
  private elapsed = 0;
  private initialized = false;
  private running = false;
  private rendered = 0;
  private rebuilds = 0;
  private effectsDrawn = 0;

  /** Hoisted so every frame hands the builder the same provider, not a new one. */
  private readonly facing = (x: number, y: number) => this.cam.facingAt(x, y);

  constructor(
    private readonly canvas: HTMLCanvasElement,
    /** The Module's view constructs and owns the grid; the renderer only
     *  reads it. `map` keeps its name — browser-check.mjs and the AGENTS.md
     *  page helpers read renderer.map. */
    readonly map: CellGrid,
    opts: DungeonRendererOptions = {},
  ) {
    // Wall cells are the worst case: four faces of rails and posts, plus a floor.
    const terrainCapacity = map.cols * map.rows * MAX_EDGES_PER_CELL;
    // Worst case: every cell a wall cell, four side faces and a cap.
    const fillCapacity = map.cols * map.rows * 5;
    this.terrain = new LineBatch(terrainCapacity,
      { width: SKIN.strokes.terrainWidth, ghost: GHOST });
    this.entities = new LineBatch(ENTITY_CAPACITY,
      { width: SKIN.strokes.entityWidth, ghost: GHOST });
    this.wallFill = SKIN.walls.opacity > 0 ? new WallFill(fillCapacity) : null;
    this.fx = new MapFx(map.cols, map.rows);
    this.cam = this.makeCam("orbital", 0);
    this.scene.add(this.terrain.object, this.entities.object);
    if (this.wallFill) this.scene.add(this.wallFill.mesh);
    this.renderer = new WebGPURenderer({ canvas, antialias: true, forceWebGL: opts.forceWebGL });
    this.renderer.setClearColor(new Color(SKIN.background), 1);
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  /**
   * Which backend three settled on; null until start() resolves. The flag is
   * load-bearing: three fills its own `backend` field in the constructor and
   * only replaces it on the fallback path, so read any earlier it reports the
   * backend that was asked for rather than the one that came up.
   */
  get backend(): "webgpu" | "webgl" | null {
    if (!this.initialized) return null;
    const b = this.renderer.backend as { isWebGPUBackend?: boolean; isWebGLBackend?: boolean };
    return b?.isWebGPUBackend ? "webgpu" : b?.isWebGLBackend ? "webgl" : null;
  }

  /** Resolves once the backend is up (WebGPU, or WebGL if unavailable). */
  async start(): Promise<void> {
    await this.renderer.init();
    this.initialized = true;
    this.resize();
    this.running = true;
    this.renderer.setAnimationLoop((time: number) => this.frame(time));
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  // ---- diagnostics for scripts/dev/browser-check.mjs, with backend above ----

  /** Frames drawn since start(). Frame rate is this over wall time. */
  get frames(): number {
    return this.rendered;
  }

  /** How far the camera still is from the hero it is following, in cells. */
  get cameraDrift(): number {
    return this.cam.drift;
  }

  /**
   * Static level geometry rebuilds since start(). Terrain is rebuilt when the
   * map's terrain changed *or* the hero moved (lighting is baked into the
   * geometry), so under fast autonomous play this tracks the hero, and its rate
   * is what scripts/dev/angband-borg-check.mjs watches: it is the frame cost
   * that grows with level size rather than with what changed.
   */
  get terrainRebuilds(): number {
    return this.rebuilds;
  }

  /**
   * Effect glyphs the last frame actually DREW, for
   * scripts/dev/fp-controls-check.mjs — the grid's own effect Cells plus the
   * residue of the ones the engine has already erased. Counting effect Cells
   * on the grid instead answers a different question, and at Angband's
   * `delay_factor` 0 it answers zero for a blast the player can see
   * (vect-hack-auo): the set and the repaint arrive in one batch, and the grid
   * a frame samples never holds it.
   */
  get drawnEffects(): number {
    return this.effectsDrawn;
  }

  /**
   * The cell the look ring is on, for scripts/dev/browser-check.mjs. A public
   * accessor rather than a reach into the private: an assertion that cannot
   * fail is worse than no assertion (docs/DECISIONS.md, vect-hack-azf).
   */
  get highlightedCell(): { x: number; y: number } | null {
    return this.highlight;
  }

  /**
   * Drop the bloom stack to its bare cores, or put it back — the baseline a
   * "does it actually glow" measurement is read against.
   */
  setBloomEnabled(enabled: boolean): void {
    this.terrain.setBloomEnabled(enabled);
    this.entities.setBloomEnabled(enabled);
  }

  /**
   * Stop the frame loop and draw one still straight to the canvas, past the
   * phosphor trail. Two of these bracket setBloomEnabled(): the animation is
   * frozen, so the pair differs by the bloom stack and nothing else, and the
   * trail is out of the way — it ghosts anything that moves, which is a halo
   * the beam stack did not put there and would drown out the one it did.
   */
  renderStill(): void {
    this.stop();
    this.renderer.render(this.scene, this.cam.camera);
  }

  /** The engine finished a map update; recentre on the hero. */
  syncHero(): void {
    const h = this.map.hero;
    if (h) this.cam.follow(h.x, h.y);
  }

  /** A Module inferred a hit at a map cell: pulse it red (spec 2026-08-06). */
  hitFlash(x: number, y: number): void {
    this.fx.hit(x, y);
  }

  /**
   * A Module's engine fired an effect at a cell (vect-hack-auo). The Cell is
   * the Module's own — the same one it hands the grid — and the grid stays
   * engine truth; this only gives the blast a minimum on-screen lifetime, so
   * an engine that sets and erases it between two frames cannot make it
   * invisible. See MapFx.effect().
   */
  effectFired(x: number, y: number, cell: Cell): void {
    this.fx.effect(x, y, cell);
  }

  /** Ring the cell the pointer is naming, or clear it (spec 2026-08-18). The
   *  copy is deliberate: the caller's cell object is one it keeps mutating. */
  setHighlight(cell: { x: number; y: number } | null): void {
    this.highlight = cell && { x: cell.x, y: cell.y };
  }

  /** New level: drop the eased follow so the camera doesn't fly across the map,
   *  and drop the old level's beams and blasts with it. The view mode survives;
   *  a staircase is no reason to put the player back in the other camera. */
  recentre(): void {
    this.fx.clear();
    this.syncHero();
    this.cam.snap();
  }

  /** The bearing the key mapper resolves movement against. See DungeonCamera. */
  get heading(): number {
    return this.cam.heading;
  }

  /** Swing the view. A no-op on a camera that does not turn from the keyboard,
   *  which is what keeps the caller free of a mode check. */
  turn(delta: number): void {
    this.cam.turnBy?.(delta);
  }

  /** Face north-up. A no-op on a camera with no facing to reset, which is
   *  what keeps the caller free of a mode check (see turn()). */
  resetFacing(): void {
    this.cam.resetFacing?.();
  }

  /**
   * The map cell under a pointer position (client coordinates, straight off a
   * PointerEvent), or null off the canvas, off the map, or looking above the
   * horizon where the ray never reaches the floor. The renderer owns the
   * camera and scene graph, so this is where a screen point becomes a cell —
   * src/modules/nethack/ui/pointerActions.ts is the only consumer, the same
   * raycast be3.2's declined click-to-move would also have needed. Entities
   * have no collision geometry of their own; a cell's occupant comes from the
   * injected grid, not from what the ray happens to hit — the letterforms get
   * stand-in volumes (src/render/pick.ts) tested before the plane, because a glyph
   * stands up from the floor and a click aimed at what the player sees would
   * otherwise land on the floor cell behind it (vect-hack-hqo).
   */
  pickCell(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndc = new Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.cam.camera);
    // First person stands inside the hero's own volume; a distance-0 self-hit
    // would win every click (the same reason EntityLayer's hideHero exists).
    const glyph = pickEntityCell(this.raycaster.ray, this.map, {
      skipHero: this.currentMode === "first",
    });
    if (glyph) return glyph;
    const hit = new Vector3();
    if (!this.raycaster.ray.intersectPlane(this.floorPlane, hit)) return null;
    const x = Math.round(hit.x), y = Math.round(hit.z);
    return x >= 0 && x < this.map.cols && y >= 0 && y < this.map.rows ? { x, y } : null;
  }

  /** Which camera is running. */
  get mode(): CameraMode {
    return this.currentMode;
  }

  /**
   * Swap cameras. The replacement opens on the outgoing one's bearing (and its
   * framing, orbit to orbit) and cuts straight to the hero — no flight across
   * the map — and takes the stroke width its viewing distance needs with it.
   */
  setMode(mode: CameraMode): CameraMode {
    if (mode !== this.currentMode) {
      // The committed bearing, not the eased one: toggling F2 mid-turn should
      // land where the player aimed, not where the swing happened to be.
      const facing = this.cam.heading;
      if (this.cam instanceof OrbitCam) this.orbitFraming = this.cam.framing;
      this.cam.dispose(); // before the next binds: two cameras must not both look
      this.currentMode = mode;
      this.cam = this.makeCam(mode, facing);
      const scale = mode === "first" ? FP_WIDTH_SCALE : 1;
      this.terrain.setWidthScale(scale);
      this.entities.setWidthScale(scale);
      this.syncHero();
      this.cam.snap();
      this.resize(); // the new camera has no aspect ratio yet
    }
    return this.currentMode;
  }

  /** @returns the mode now running. */
  toggleMode(): CameraMode {
    return this.setMode(this.currentMode === "orbital" ? "first" : "orbital");
  }

  private makeCam(mode: CameraMode, facing: number): DungeonCamera {
    if (mode === "first") return new FirstPersonCam(this.canvas, { yaw: facing });
    const orbit = new OrbitCam(this.canvas);
    orbit.azimuth = facing;
    if (this.orbitFraming) orbit.restoreFraming(this.orbitFraming);
    return orbit;
  }

  private frame(time: number): void {
    if (!this.running) return;
    const dt = this.last ? Math.min((time - this.last) / 1000, MAX_FRAME_SECONDS) : 0;
    this.last = time;
    this.elapsed += dt;

    this.fx.observe(this.map);
    this.fx.step(dt);
    this.fx.reseed(this.elapsed);

    const hero = this.map.hero;
    if (this.map.terrainRevision !== this.builtRevision
      || hero?.x !== this.builtHero?.x || hero?.y !== this.builtHero?.y) {
      this.builtRevision = this.map.terrainRevision;
      this.builtHero = hero && { x: hero.x, y: hero.y };
      this.rebuilds++;
      buildTerrain(this.map, this.terrain, (x, y) => this.fx.lightAt(x, y), this.wallFill ?? undefined);
    }
    // The camera moves first: in first person the glyphs turn toward wherever
    // the eye ended up this frame, so building against last frame's eye would
    // leave every letterform a frame behind the walk.
    this.cam.update(dt);
    this.effectsDrawn = buildEntities(this.map, this.entities, this.elapsed, this.facing, this.fx,
      { hideHero: this.currentMode === "first", highlight: this.highlight ?? undefined });
    // Phosphor persistence is a WebGPU-only tier. The trail composites the prior
    // frame with a MAX blend, and three's WebGL fallback backend has no MAX in
    // its blend-equation table — it rejects the call and draws under whatever
    // equation was last bound, which is not a max at all. So WebGL renders
    // straight to the canvas and loses the spatial trail, the same degradation
    // the vector-CRT model's css-approx tier takes for this effect (§4, where
    // persistence is a "loses form" row: afterglow or nothing, never a trail).
    if (this.backend === "webgpu") this.trail.render(this.renderer, this.scene, this.cam.camera, dt);
    else this.renderer.render(this.scene, this.cam.camera);
    this.rendered++;
    this.onFrame?.(this.cam.azimuth);
  }

  private resize(): void {
    const w = this.canvas.clientWidth || 1;
    const h = this.canvas.clientHeight || 1;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, MAX_PIXEL_RATIO));
    this.renderer.setSize(w, h, false);
    this.trail.fit(this.renderer);
    this.cam.resize(w, h);
  }

  dispose(): void {
    this.stop();
    this.cam.dispose();
    this.terrain.dispose();
    this.entities.dispose();
    this.wallFill?.dispose();
    this.trail.dispose();
    this.renderer.dispose();
  }
}

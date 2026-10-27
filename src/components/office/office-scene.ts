import * as THREE from "three";
import {
  DISCUSSION_CENTER,
  DISCUSSION_SPOTS,
  OFFICE_VISITS,
  PROPS,
  ROOMS,
  STUDIO_COLORS,
  VIDEO_WALL,
  WALLS,
  WORLD,
} from "./office-layout";
import { createVoxelCharacter } from "./voxel-character";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { VOXEL_MODELS, OFFICE_PALETTE_BASE64 } from "./office-voxel-models";
import {
  TEAM,
  damp,
  facingOf,
  type Activity,
  type AgentId,
  type SceneCrew,
} from "./office-motion";
import {
  advanceOfficeRoutine,
  createOfficeRoutine,
  endErrand,
  sendOnErrand,
  setRoutineReducedMotion,
  setRoutineWorking,
} from "./office-routine";

export interface OfficeScene {
  setActivity(activity: Activity): void;
  /** Per-member state for the side panel; replaces single-activity bubbles. */
  setCrew(crew: SceneCrew): void;
  setSelected(id: AgentId | null): void;
  /** Walk `id` over to `to`'s post, stay `dwell` s, then return. */
  visit(
    id: AgentId,
    to: AgentId,
    options?: { dwell?: number; say?: string; reply?: string },
  ): boolean;
  /** Trigger an interactive emote or trip ("wave" | "cheer" | "coffee" | "server"). */
  emote?(
    id: AgentId,
    kind?: "wave" | "cheer" | "coffee" | "server",
    text?: string,
  ): void;
  /** Gather idle crew members around the Lounge communal table for a team huddle. */
  huddle?(): void;
  /** Dispatch two pairs of idle colleagues to visit each other's workstations simultaneously. */
  pairSync?(): void;
  /** Send `id` back to their post now. */
  recall(id: AgentId): void;
  /** Glide the camera to follow a member, or back to the whole floor. */
  focusOn(id: AgentId | null, zoom?: number): void;
  /** Glide the camera to a floor point (and zoom), ending any follow. */
  glideTo(x: number, z: number, zoom?: number): void;
  /** Drag the floor by a screen offset in CSS pixels, ending any follow. */
  panBy(dx: number, dy: number): void;
  /** Scale the zoom (>1 closer), within limits around the home framing. */
  zoomBy(factor: number): void;
  /** Orbit the camera around the current focus point by `deltaYaw` radians. */
  rotateBy(deltaYaw: number): void;
  /** Reset camera focus, zoom, and orbit angle to the default overview. */
  resetView(): void;
  /** Pick an agent or workstation at canvas-relative CSS pixel coordinates `(x, y)`. */
  pickAt(x: number, y: number): AgentId | null;
  /** Highlight an agent when hovering at canvas-relative CSS pixel coordinates `(x, y)`. */
  hoverAt(x: number, y: number): AgentId | null;
  /** Scene graph access for overlays drawn on top of the office. */
  stage(): {
    scene: THREE.Scene;
    camera: THREE.Camera;
    /** Live floor position of a member (follows walks). */
    positionOf(id: AgentId): THREE.Vector3;
    /** A member's desk position (where they sit). */
    homeOf(id: AgentId): THREE.Vector3;
    /** Video-wall panel behind each helper's console. */
    wallScreens: Partial<Record<AgentId, THREE.Mesh>>;
    /** Panoramic 3D subscription quota & token telemetry displays in the Hub and Ops room. */
    quotaScreens?: THREE.Mesh[];
    /** Called after each drawn frame, before rendering. */
    onFrame(callback: ((elapsed: number, dt: number) => void) | null): void;
  };
  setWorking(working: boolean): void;
  setTheme(dark: boolean): void;
  setReducedMotion(reduced: boolean): void;
  setVisible(visible: boolean): void;
  resize(): void;
  dispose(): void;
}

/** A self-contained scene: no remote assets and no per-frame React updates. */
export function createOfficeScene(
  canvas: HTMLCanvasElement,
  labels: HTMLElement,
  options: {
    onSelect?: (id: AgentId) => void;
    /** >1 frames tighter, for small viewports such as the side panel. */
    zoom?: number;
    /** Floor point to centre on (defaults to the whole studio). */
    focus?: { x: number; z: number };
    /** Enable continuous multi-agent collaborations and studio personality immediately. */
    liveStudio?: boolean;
  } = {},
): OfficeScene {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: false,
    powerPreference: "high-performance",
  });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  // Seated actors keep cached shadows; a moving visitor uses a cheap contact shadow.
  renderer.shadowMap.autoUpdate = false;
  renderer.shadowMap.needsUpdate = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const C = STUDIO_COLORS;
  scene.background = new THREE.Color(C.night);
  const camera = new THREE.OrthographicCamera(-15, 15, 9, -9, 0.1, 90);
  const room = new THREE.Group();
  scene.add(room);
  const geometry = {
    box: new THREE.BoxGeometry(1, 1, 1),
    round: new THREE.BoxGeometry(1, 1, 1),
    ball: new THREE.BoxGeometry(2, 2, 2),
    cylinder: new THREE.CylinderGeometry(0.65, 1, 1, 8),
    leaf: new THREE.BoxGeometry(2, 2, 2),
  };
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  function material(color: string, glow = 0) {
    const key = `${color}:${glow}`;
    let result = materials.get(key);
    if (!result) {
      result = new THREE.MeshStandardMaterial({
        color,
        roughness: 1,
        metalness: 0,
        flatShading: true,
        emissive: glow ? color : "#000000",
        emissiveIntensity: glow,
      });
      materials.set(key, result);
    }
    return result;
  }
  function shape(
    parent: THREE.Object3D,
    kind: keyof typeof geometry,
    color: string,
    size: number[],
    at: number[],
    glow = 0,
  ) {
    const mesh = new THREE.Mesh(geometry[kind], material(color, glow));
    mesh.scale.set(size[0], size[1], size[2]);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.castShadow = !glow;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }
  const box = (
    parent: THREE.Object3D,
    color: string,
    size: number[],
    at: number[],
    rounded = false,
    glow = 0,
  ) => shape(parent, rounded ? "round" : "box", color, size, at, glow);

  // Shared palette texture for all 3D Voxel Office models.
  const paletteImage = new Image();
  paletteImage.src = `data:image/png;base64,${OFFICE_PALETTE_BASE64}`;
  const paletteTexture = new THREE.Texture(paletteImage);
  paletteImage.onload = () => {
    if (disposed) return;
    paletteTexture.needsUpdate = true;
    draw(0);
  };
  paletteTexture.magFilter = THREE.NearestFilter;
  paletteTexture.minFilter = THREE.NearestFilter;
  paletteTexture.colorSpace = THREE.SRGBColorSpace;
  const voxelMaterial = new THREE.MeshStandardMaterial({
    map: paletteTexture,
    roughness: 0.85,
    metalness: 0.1,
  });

  const parsedGeometries = new Map<string, THREE.BufferGeometry>();
  function getVoxelGeometry(name: string): THREE.BufferGeometry {
    let geo = parsedGeometries.get(name);
    if (!geo) {
      const raw = VOXEL_MODELS[name];
      if (!raw) throw new Error(`Voxel model not found: ${name}`);
      geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(raw.pos, 3));
      if (raw.norm) {
        geo.setAttribute("normal", new THREE.BufferAttribute(raw.norm, 3));
      }
      geo.setAttribute("uv", new THREE.BufferAttribute(raw.uv, 2));
      geo.setIndex(new THREE.BufferAttribute(raw.idx, 1));
      if (!raw.norm) geo.computeVertexNormals();
      parsedGeometries.set(name, geo);
    }
    return geo;
  }

  function voxelModel(
    parent: THREE.Object3D,
    name: string,
    at: [number, number, number],
    rotY = 0,
    scale: number | [number, number, number] = 1,
  ) {
    const geo = getVoxelGeometry(name);
    const mesh = new THREE.Mesh(geo, voxelMaterial);
    mesh.position.set(at[0], at[1], at[2]);
    mesh.rotation.y = rotY;
    if (typeof scale === "number") {
      mesh.scale.setScalar(scale);
    } else {
      mesh.scale.set(scale[0], scale[1], scale[2]);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  // Kern HQ: a whole floor of rooms built from office-layout. Everything here
  // is static and gets baked into a few material batches below.
  const W = WORLD;
  const glassGroup = new THREE.Group();
  scene.add(glassGroup);
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: C.glass,
    transparent: true,
    opacity: 0.12,
    roughness: 0.2,
    metalness: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  function glass(size: [number, number, number], at: [number, number, number]) {
    const pane = new THREE.Mesh(geometry.box, glassMaterial);
    pane.scale.set(...size);
    pane.position.set(...at);
    glassGroup.add(pane);
  }

  // Corridor floor: one dark parquet plane under the whole building.
  const floorPixels = new Uint8Array(128 * 128 * 4);
  const floorColors = C.woodFloor.map((value) =>
    new THREE.Color(value).multiplyScalar(0.72).convertLinearToSRGB(),
  );
  const seamColor = new THREE.Color(C.woodDark).convertLinearToSRGB();
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) {
      const row = Math.floor(y / 64);
      const offsetX = (x + row * 16) % 128;
      const color =
        offsetX % 32 === 0 || y % 64 === 0
          ? seamColor
          : floorColors[(Math.floor(offsetX / 32) + row * 3) % 4];
      const at = (y * 128 + x) * 4;
      floorPixels[at] = Math.round(color.r * 255);
      floorPixels[at + 1] = Math.round(color.g * 255);
      floorPixels[at + 2] = Math.round(color.b * 255);
      floorPixels[at + 3] = 255;
    }
  const floorTexture = new THREE.DataTexture(floorPixels, 128, 128);
  floorTexture.colorSpace = THREE.SRGBColorSpace;
  floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping;
  const floorW = W.maxX - W.minX,
    floorD = W.maxZ - W.minZ;
  floorTexture.repeat.set(floorW / 2, floorD / 3.2);
  floorTexture.magFilter = THREE.LinearFilter;
  floorTexture.minFilter = THREE.LinearMipmapLinearFilter;
  floorTexture.generateMipmaps = true;
  floorTexture.needsUpdate = true;
  const continuousFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(floorW, floorD),
    new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 1 }),
  );
  continuousFloor.rotation.x = -Math.PI / 2;
  continuousFloor.position.set((W.minX + W.maxX) / 2, -0.025, (W.minZ + W.maxZ) / 2);
  room.add(continuousFloor);
  // Multi-tiered architectural podium slab edge
  box(room, C.woodEdge, [floorW + 0.5, 0.24, floorD + 0.5], [(W.minX + W.maxX) / 2, -0.15, (W.minZ + W.maxZ) / 2]);
  box(room, C.trim, [floorW + 1.8, 0.36, floorD + 1.8], [(W.minX + W.maxX) / 2, -0.36, (W.minZ + W.maxZ) / 2]);
  box(room, C.brass, [floorW + 0.7, 0.04, floorD + 0.7], [(W.minX + W.maxX) / 2, -0.02, (W.minZ + W.maxZ) / 2], false, 0.85);

  // ---- Full-Vista Surrounding Campus Plaza & Landscaped Grounds (fills the background void) ----
  {
    const cx = (W.minX + W.maxX) / 2;
    const cz = (W.minZ + W.maxZ) / 2;
    // Large architectural plaza base + subtle grid lines extending across the camera frustum
    box(room, C.edge, [136, 0.2, 116], [cx, -0.58, cz]);
    box(room, C.serverFloor[0], [82, 0.08, 68], [cx, -0.46, cz]);
    for (let gx = -38; gx <= 38; gx += 4) {
      box(room, C.trim, [0.06, 0.02, 68], [gx, -0.41, cz]);
    }
    for (let gz = -32; gz <= 32; gz += 4) {
      box(room, C.trim, [82, 0.02, 0.06], [cx, -0.41, gz]);
    }
    // Glowing perimeter plaza avenues around the building
    box(room, C.brass, [54, 0.025, 0.12], [cx, -0.4, W.maxZ + 2.4], false, 1.1);
    box(room, C.cyan, [54, 0.025, 0.08], [cx, -0.4, W.maxZ + 2.8], false, 0.9);
    box(room, C.brass, [0.12, 0.025, 40], [W.maxX + 2.4, -0.4, cz], false, 1.1);
    box(room, C.brass, [0.12, 0.025, 40], [W.minX - 2.4, -0.4, cz], false, 1.1);

    // Helper to build a lush architectural campus tree with planter & uplight
    const campusTree = (tx: number, tz: number, scale = 1, blossom = false) => {
      const y0 = -0.42;
      box(room, C.woodDark, [1.5 * scale, 0.32, 1.5 * scale], [tx, y0 + 0.16, tz]);
      box(room, C.tiles[0], [1.65 * scale, 0.08, 1.65 * scale], [tx, y0 + 0.34, tz]);
      box(room, C.foliage, [1.3 * scale, 0.12, 1.3 * scale], [tx, y0 + 0.36, tz]);
      box(room, C.woodEdge, [0.32 * scale, 1.65 * scale, 0.32 * scale], [tx, y0 + 1.15 * scale, tz]);
      const c1 = blossom ? "#e38aae" : C.foliage;
      const c2 = blossom ? "#f4b0ca" : C.foliageLight;
      box(room, c1, [1.85 * scale, 0.95 * scale, 1.85 * scale], [tx, y0 + 2.1 * scale, tz]);
      box(room, c2, [1.4 * scale, 0.85 * scale, 1.4 * scale], [tx + 0.08, y0 + 2.75 * scale, tz - 0.06]);
      box(room, c2, [0.95 * scale, 0.55 * scale, 0.95 * scale], [tx - 0.06, y0 + 3.25 * scale, tz + 0.05]);
      box(room, C.lamp, [0.22, 0.04, 0.22], [tx + 0.35 * scale, y0 + 0.43, tz + 0.35 * scale], false, 1.4);
    };

    // Helper for glowing campus pathway bollard lamps
    const bollard = (bx: number, bz: number) => {
      box(room, C.metal, [0.18, 0.65, 0.18], [bx, -0.09, bz]);
      box(room, C.lamp, [0.2, 0.22, 0.2], [bx, 0.32, bz], false, 1.5);
      box(room, C.trim, [0.24, 0.05, 0.24], [bx, 0.45, bz]);
    };

    // East, South, and West Campus Tree Groves & Courtyards
    const treeSpots: [number, number, number, boolean][] = [
      [26.5, -12, 1.15, false],
      [26.5, -4, 0.95, true],
      [26.5, 4, 1.1, false],
      [26.5, 12, 1.05, true],
      [25.5, 19.5, 1.2, false],
      [16, 20.5, 1.0, true],
      [6, 20.5, 1.15, false],
      [-6, 20.5, 1.05, true],
      [-16, 20.5, 1.1, false],
      [-25.5, 19.5, 1.2, true],
      [-26.5, 11, 1.0, false],
      [-26.5, 2, 1.15, true],
      [-26.5, -7, 1.05, false],
      [-26.5, -14, 1.2, false],
      [32, -8, 1.3, false],
      [32, 6, 1.25, true],
      [-12, 25.5, 1.25, false],
      [12, 25.5, 1.3, true],
    ];
    for (const [tx, tz, sc, bl] of treeSpots) campusTree(tx, tz, sc, bl);

    for (const bx of [-20, -10, 0, 10, 20]) bollard(bx, W.maxZ + 1.8);
    for (const bz of [-10, -2, 6, 14]) {
      bollard(W.maxX + 1.8, bz);
      bollard(W.minX - 1.8, bz);
    }

    // North-East & North-West Architectural Skyline Podiums outside the studio
    for (let i = 0; i < 6; i++) {
      const bx = -20 + i * 8;
      const bh = 3.8 + (i % 3) * 1.4;
      box(room, C.city[i % 3], [5.4, bh, 3.6], [bx, -0.4 + bh / 2, -20.5]);
      box(room, C.brass, [5.5, 0.08, 3.7], [bx, -0.4 + bh + 0.04, -20.5], false, 0.8);
      for (let wy = 0.8; wy < bh - 0.6; wy += 0.75) {
        box(room, i % 2 === 0 ? C.windowWarm : C.windowCool, [4.2, 0.22, 0.06], [bx, -0.4 + wy, -18.68], false, 0.75);
      }
    }
  }

  // ---- South-West Wing (-21..-8.5, 8.6..14.6): Biophilic Amphitheater & Bonsai Lounge ----
  {
    const wx = -15.0,
      wz = 11.6;
    box(room, C.tiles[0], [11.6, 0.04, 5.6], [wx, 0.015, wz]);
    box(room, C.brass, [11.6, 0.03, 0.08], [wx, 0.035, wz - 2.75], false, 1.0);
    box(room, C.brass, [11.6, 0.03, 0.08], [wx, 0.035, wz + 2.75], false, 1.0);
    // Stepped timber amphitheater seating tiers on the west side
    box(room, C.woodDark, [3.6, 0.34, 4.4], [-18.6, 0.17, wz]);
    box(room, C.woodLight, [3.6, 0.06, 4.4], [-18.6, 0.36, wz]);
    box(room, C.woodDark, [2.2, 0.68, 4.4], [-19.3, 0.34, wz]);
    box(room, C.woodLight, [2.2, 0.06, 4.4], [-19.3, 0.7, wz]);
    // Cushions on amphitheater steps
    for (const cz of [wz - 1.3, wz, wz + 1.3]) {
      box(room, C.terracotta, [0.7, 0.08, 0.85], [-17.4, 0.42, cz]);
      box(room, C.cyan, [0.7, 0.08, 0.85], [-18.8, 0.76, cz], false, 0.4);
    }
    // Central sculptural Sakura/Bonsai planter island in the SW Wing
    box(room, C.woodDark, [2.4, 0.42, 2.4], [-13.8, 0.21, wz]);
    box(room, C.brass, [2.48, 0.04, 2.48], [-13.8, 0.43, wz], false, 0.7);
    box(room, C.foliage, [2.1, 0.08, 2.1], [-13.8, 0.44, wz]);
    box(room, C.woodEdge, [0.28, 1.35, 0.28], [-13.8, 1.1, wz]);
    box(room, "#e892b4", [1.9, 0.65, 1.9], [-13.8, 1.85, wz], false, 0.35);
    box(room, "#f6b8d0", [1.35, 0.55, 1.35], [-13.6, 2.3, wz - 0.1], false, 0.45);
    // Overhead architectural pergola beams spanning the SW Wing
    for (let pz = wz - 2.2; pz <= wz + 2.2; pz += 1.1) {
      box(room, C.wood, [11.2, 0.12, 0.14], [wx, 2.85, pz]);
    }
    box(room, C.lamp, [9.6, 0.04, 0.08], [wx, 2.78, wz], false, 1.4);
  }

  // ---- South-East Wing (8.5..21, 8.6..14.6): Reflecting Koi Pool & Innovation Pavilion ----
  {
    const ex = 15.0,
      ez = 11.6;
    // Limestone pool border + glowing turquoise water basin
    box(room, C.tiles[1], [11.6, 0.12, 5.6], [ex, 0.06, ez]);
    box(room, C.skyNight, [10.6, 0.08, 4.6], [ex, 0.09, ez]);
    box(room, C.glass, [10.4, 0.04, 4.4], [ex, 0.13, ez], false, 0.75);
    // Glowing underwater LED strips + lotus pads
    box(room, C.cyan, [9.6, 0.02, 0.08], [ex, 0.14, ez - 1.6], false, 1.4);
    box(room, C.cyan, [9.6, 0.02, 0.08], [ex, 0.14, ez + 1.6], false, 1.4);
    for (const [lx, lz] of [
      [11.5, 10.4],
      [12.3, 12.6],
      [17.8, 10.5],
      [18.4, 12.8],
    ] as const) {
      box(room, C.foliageLight, [0.55, 0.03, 0.55], [lx, 0.16, lz]);
      box(room, "#f49ac0", [0.18, 0.12, 0.18], [lx, 0.22, lz], false, 0.8);
    }
    // Arched Honey-Oak Timber Footbridge & Glass Innovation Island in center of pool
    box(room, C.woodLight, [3.8, 0.14, 5.8], [ex, 0.22, ez]);
    box(room, C.brass, [3.86, 0.04, 5.86], [ex, 0.28, ez], false, 0.8);
    // Glass balustrades along the bridge
    glass([0.05, 0.65, 5.4], [ex - 1.8, 0.6, ez]);
    glass([0.05, 0.65, 5.4], [ex + 1.8, 0.6, ez]);
    // Holographic architectural model pedestal on the bridge island
    box(room, C.woodDark, [1.2, 0.72, 1.2], [ex, 0.64, ez]);
    box(room, C.brass, [1.32, 0.05, 1.32], [ex, 1.02, ez], false, 0.9);
    box(room, C.cyan, [0.55, 0.55, 0.55], [ex, 1.42, ez], false, 1.6);
  }

  function roomFloor(r: (typeof ROOMS)[number]) {
    const w = r.maxX - r.minX,
      d = r.maxZ - r.minZ;
    const cx = (r.minX + r.maxX) / 2,
      cz = (r.minZ + r.maxZ) / 2;
    if (r.floor === "carpet") {
      box(room, C.carpetBase, [w, 0.03, d], [cx, 0.005, cz]);
      box(room, C.carpetInner, [w - 1.4, 0.035, d - 1.4], [cx, 0.01, cz]);
      box(room, r.accent, [w - 1.32, 0.032, d - 1.32], [cx, 0.008, cz]);
      return;
    }
    if (r.floor === "wood") {
      for (let x = 0; x < Math.round(w / 0.5); x++)
        for (let z = 0; z < Math.round(d / 1.6); z++)
          box(
            room,
            C.woodFloor[(x + z * 3) % 4],
            [0.495, 0.035, 1.57],
            [r.minX + 0.25 + x * 0.5, 0, r.minZ + 0.8 + z * 1.6],
          );
      return;
    }
    const palette = r.floor === "slate" ? C.serverFloor : C.tiles;
    const cols = Math.round(w / 0.92),
      rows = Math.round(d / 0.92);
    const step = w / cols,
      stepZ = d / rows;
    for (let col = 0; col < cols; col++)
      for (let row = 0; row < rows; row++)
        box(
          room,
          palette[(col + row) % palette.length],
          [step - 0.03, 0.025, stepZ - 0.03],
          [r.minX + step / 2 + col * step, 0.012, r.minZ + stepZ / 2 + row * stepZ],
        );
  }
  ROOMS.forEach(roomFloor);

  // Walls. Exterior north/west walls are tall with windows and warm wood-slat
  // acoustic panels; interior ones are a low wainscot under glass so rooms stay open.
  const isExterior = (w: (typeof WALLS)[number]) =>
    (w.z1 === w.z2 && w.z1 === -15) || (w.x1 === w.x2 && w.x1 === -21);
  function skyline(centerX: number, z: number, width: number) {
    const pane = box(room, C.skyNight, [width, 1.7, 0.06], [centerX, 2.15, z + 0.12], false, 0.32);
    pane.castShadow = false;
    const n = Math.floor(width / 0.46);
    for (let building = 0; building < n; building++) {
      const h = 0.5 + ((building * 7 + Math.round(centerX * 3)) % 7) * 0.13;
      const bx = centerX - width / 2 + 0.25 + building * 0.46;
      box(room, C.city[building % 3], [0.4, h, 0.035], [bx, 1.32 + h / 2, z + 0.16]);
      for (let row = 0; row < Math.floor(h / 0.2) - 1; row++)
        for (let col = 0; col < 3; col++)
          if ((row * 3 + col + building) % 4 !== 0)
            box(
              room,
              (row + building) % 4 === 0 ? C.windowWarm : C.windowCool,
              [0.055, 0.045, 0.018],
              [bx - 0.12 + col * 0.12, 1.45 + row * 0.2, z + 0.185],
              false,
              0.65,
            );
    }
    // Warm string-light bulbs along the top of the studio window
    for (let bulb = 0; bulb < 5; bulb++) {
      const bx = centerX - width * 0.38 + (bulb * width * 0.76) / 4;
      box(room, C.lamp, [0.055, 0.055, 0.055], [bx, 2.92 - (bulb % 2) * 0.04, z + 0.22], false, 1.1);
    }
    for (const y of [1.3, 3.02]) box(room, C.woodDark, [width + 0.12, 0.09, 0.22], [centerX, y, z + 0.18]);
    // Warm wooden windowsill
    box(room, C.wood, [width + 0.22, 0.09, 0.38], [centerX, 1.26, z + 0.28]);
  }
  function woodSlatPanel(centerX: number, y: number, z: number, width: number, height: number, alongZ = false) {
    const count = Math.max(3, Math.floor(width / 0.16));
    for (let i = 0; i < count; i++) {
      const offset = -width / 2 + 0.08 + i * (width / count);
      const slatColor = i % 2 === 0 ? C.slat : C.slatDark;
      if (alongZ) {
        box(room, slatColor, [0.04, height, 0.08], [z + 0.13, y, centerX + offset]);
      } else {
        box(room, slatColor, [0.08, height, 0.04], [centerX + offset, y, z + 0.13]);
      }
    }
  }
  const skyMaterial = material(C.skyNight, 0.32);
  for (const w of WALLS) {
    const horizontal = w.z1 === w.z2;
    const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    const cx = (w.x1 + w.x2) / 2,
      cz = (w.z1 + w.z2) / 2;
    const exterior = isExterior(w);
    const tall = w.height > 1;
    const h = exterior ? 3.4 : tall ? 1.05 : w.height;
    const size: [number, number, number] = horizontal ? [len + 0.22, h, 0.22] : [0.22, h, len + 0.22];
    box(room, exterior ? C.wall : C.wallInner, size, [cx, h / 2, cz]);
    // Warm wood top cap on low interior curbs, dark trim on tall exterior walls
    box(
      room,
      exterior ? C.woodDark : C.wood,
      horizontal ? [len + 0.26, 0.08, 0.3] : [0.3, 0.08, len + 0.26],
      [cx, h + 0.04, cz],
    );
    // Warm wooden baseboard along tall walls
    if (tall) {
      box(
        room,
        C.woodDark,
        horizontal ? [len + 0.24, 0.12, 0.26] : [0.26, 0.12, len + 0.24],
        [cx, 0.06, cz],
      );
    }
    if (!exterior && tall) {
      glass(horizontal ? [len, 1.35, 0.03] : [0.03, 1.35, len], [cx, h + 0.75, cz]);
      box(room, C.woodDark, horizontal ? [len + 0.1, 0.07, 0.09] : [0.09, 0.07, len + 0.1], [cx, h + 1.45, cz]);
      for (let i = 0; i <= Math.floor(len / 2); i++) {
        const t = len < 0.5 ? 0.5 : i / Math.max(1, Math.floor(len / 2));
        const px = w.x1 + (w.x2 - w.x1) * t,
          pz = w.z1 + (w.z2 - w.z1) * t;
        box(room, C.woodDark, [0.07, 1.45, 0.07], [px, h + 0.72, pz]);
      }
    }
    if (exterior && horizontal) {
      // Windows on the north façade, with cozy acoustic wood-slat panels between them.
      for (let x = Math.min(w.x1, w.x2) + 2; x + 2 <= Math.max(w.x1, w.x2); x += 4) {
        skyline(x + 1, cz, 3.2);
      }
    }
    if (exterior && !horizontal) {
      // Acoustic wood-slat panels and framed art along the west studio wall
      woodSlatPanel(cz - 1.8, 2.0, cx, 2.4, 1.8, true);
      woodSlatPanel(cz + 1.8, 2.0, cx, 2.4, 1.8, true);
      box(room, C.wood, [0.06, 1.15, 1.5], [cx + 0.14, 2.05, cz]);
      box(room, C.artCanvas, [0.07, 0.96, 1.3], [cx + 0.15, 2.05, cz]);
      box(room, C.terracotta, [0.08, 0.42, 0.55], [cx + 0.16, 2.0, cz - 0.2]);
      box(room, C.amber, [0.08, 0.32, 0.38], [cx + 0.16, 2.15, cz + 0.25], false, 0.35);
    }
  }
  // Warm accent cove strip above each room's tall walls + Lumen perimeter floor border in the owner's colour.
  for (const r of ROOMS) {
    const rw = r.maxX - r.minX;
    const rd = r.maxZ - r.minZ;
    const rcx = (r.minX + r.maxX) / 2;
    const rcz = (r.minZ + r.maxZ) / 2;
    if (r.walls) {
      box(
        room,
        r.accent,
        [rw, 0.055, 0.045],
        [rcx, r.minZ === -15 ? 3.25 : 0.98, r.minZ + 0.13],
        false,
        1.5,
      );
    }
    // Glowing architectural floor perimeter frame inside each room
    box(room, r.accent, [rw - 0.5, 0.02, 0.06], [rcx, 0.032, r.minZ + 0.35], false, 0.95);
    box(room, r.accent, [rw - 0.5, 0.02, 0.06], [rcx, 0.032, r.maxZ - 0.35], false, 0.95);
    box(room, r.accent, [0.06, 0.02, rd - 0.5], [r.minX + 0.35, 0.032, rcz], false, 0.95);
    box(room, r.accent, [0.06, 0.02, rd - 0.5], [r.maxX - 0.35, 0.032, rcz], false, 0.95);
  }
  // Lumen central corridor telemetry rails connecting East-West and North-South avenues
  box(room, C.brass, [40, 0.018, 0.08], [0, 0.028, -4.0], false, 1.1);
  box(room, C.cyan, [40, 0.018, 0.05], [0, 0.028, -3.75], false, 0.9);
  box(room, C.brass, [0.08, 0.018, 22], [-8.0, 0.028, -3.5], false, 1.1);
  box(room, C.brass, [0.08, 0.018, 22], [8.0, 0.028, -3.5], false, 1.1);

  // Floor signs, drawn on canvas: they keep their texture, so they are not baked.
  for (const r of ROOMS) {
    const canvas2 = document.createElement("canvas");
    canvas2.width = 512;
    canvas2.height = 96;
    const g = canvas2.getContext("2d");
    if (!g) continue;
    g.font = "600 50px ui-monospace, Menlo, monospace";
    g.fillStyle = r.accent;
    g.globalAlpha = 0.88;
    g.fillText(r.name.toUpperCase(), 12, 64);
    const tex = new THREE.CanvasTexture(canvas2);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 0.75),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }),
    );
    sign.rotation.x = -Math.PI / 2;
    sign.position.set(r.minX + 2.4, 0.06, r.maxZ - 0.75);
    sign.renderOrder = 1;
    scene.add(sign);
  }

  // Reusable cozy studio furniture & prop builders
  function warmDeskLamp(
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    accent: string = C.amber,
  ) {
    // Weighted wooden/brass base
    box(parent, C.woodDark, [0.24, 0.035, 0.24], [x, y + 0.018, z]);
    box(parent, C.brass, [0.14, 0.025, 0.14], [x, y + 0.04, z]);
    // Articulated brass stem
    box(parent, C.brass, [0.04, 0.36, 0.04], [x, y + 0.22, z]);
    // Warm glowing linen shade
    shape(parent, "cylinder", C.lamp, [0.19, 0.22, 0.19], [x, y + 0.44, z], 0.92);
    // Subtle accent ring on top of shade
    box(parent, accent, [0.1, 0.02, 0.1], [x, y + 0.56, z], false, 0.65);
  }

  function floorLamp(parent: THREE.Object3D) {
    box(parent, C.wood, [0.42, 0.045, 0.42], [0, 0.025, 0]);
    box(parent, C.brass, [0.05, 1.65, 0.05], [0, 0.85, 0]);
    shape(parent, "cylinder", C.lamp, [0.34, 0.42, 0.34], [0, 1.78, 0], 0.9);
    box(parent, C.woodDark, [0.2, 0.03, 0.2], [0, 2.0, 0]);
  }

  function planterTrough(parent: THREE.Object3D, sx: number, sy: number, sz: number) {
    box(parent, C.wood, [sx, sy, sz], [0, sy / 2, 0]);
    box(parent, C.woodDark, [sx - 0.08, 0.05, sz - 0.08], [0, sy - 0.01, 0]);
    const bushes = Math.max(2, Math.floor(sx / 0.38));
    for (let i = 0; i < bushes; i++) {
      const bx = -sx / 2 + 0.22 + i * ((sx - 0.44) / Math.max(1, bushes - 1));
      const h = 0.28 + ((i * 3) % 3) * 0.08;
      box(parent, i % 2 === 0 ? C.foliage : C.foliageLight, [0.28, h, 0.28], [bx, sy + h / 2 - 0.02, 0]);
      box(parent, C.foliageLight, [0.18, 0.16, 0.18], [bx + 0.04, sy + h + 0.03, 0.03]);
    }
  }

  function serverRack(parent: THREE.Object3D) {
    box(parent, C.serverBody, [1.24, 2.4, 0.85], [0, 1.2, 0]);
    // Warm walnut side trim on server rack for the cozy studio aesthetic
    box(parent, C.woodDark, [1.28, 0.08, 0.88], [0, 2.42, 0]);
    box(parent, C.trim, [1.08, 2.2, 0.03], [0, 1.2, 0.44]);
    for (let slot = 0; slot < 7; slot++) {
      box(parent, C.metal, [0.96, 0.18, 0.045], [0, 0.38 + slot * 0.29, 0.47]);
      for (let led = 0; led < 5; led++)
        box(
          parent,
          led % 3 ? C.serverGreen : C.amber,
          [0.045, 0.038, 0.018],
          [-0.36 + led * 0.12, 0.38 + slot * 0.29, 0.5],
          false,
          1.3,
        );
    }
  }
  for (const p of PROPS) {
    const group = new THREE.Group();
    group.position.set(p.at[0], 0, p.at[1]);
    group.rotation.y = p.rot ?? 0;
    room.add(group);
    if (p.model) {
      voxelModel(group, p.model, [0, 0, 0], 0, p.scale ?? 1);
      continue;
    }
    const [sx, sy, sz] = p.size ?? [1, 1, 1];
    switch (p.kind) {
      case "shelf": {
        box(group, C.woodDark, [sx, sy, sz], [0, sy / 2, -0.05]);
        for (let shelf = 0; shelf < 4; shelf++) {
          const y = 0.25 + shelf * 0.55;
          box(group, C.wood, [sx - 0.1, 0.06, sz + 0.04], [0, y, 0.02]);
          // Warm under-shelf LED strip
          box(group, C.lamp, [sx - 0.24, 0.018, 0.03], [0, y + 0.48, 0.12], false, 0.55);
          for (let book = 0; book < Math.floor(sx / 0.19); book++)
            if ((book * 7 + shelf * 3) % 9 !== 0)
              box(
                group,
                C.books[(book + shelf) % C.books.length],
                [0.14, 0.3 + ((book + shelf) % 3) * 0.06, 0.32],
                [-sx / 2 + 0.15 + book * 0.19, y + 0.2, 0.06],
              );
        }
        break;
      }
      case "rack":
        serverRack(group);
        break;
      case "bench": {
        // Warm wooden butcher-block top on the test bench
        box(group, C.wood, [sx, 0.09, sz], [0, 0.95, 0]);
        box(group, C.woodEdge, [sx + 0.02, 0.035, sz + 0.02], [0, 0.9, 0]);
        box(group, C.trim, [sx - 0.2, 0.85, sz - 0.2], [0, 0.45, 0]);
        // device grid under test
        for (let i = 0; i < 4; i++) {
          box(group, C.trim, [0.42, 0.62, 0.05], [-sx / 2 + 0.5 + i * 0.66, 1.3, -0.2]);
          const pane = box(
            group,
            i % 2 ? C.serverGreen : C.screen,
            [0.34, 0.52, 0.01],
            [-sx / 2 + 0.5 + i * 0.66, 1.3, -0.17],
            false,
            0.65,
          );
          pane.castShadow = false;
        }
        warmDeskLamp(group, sx / 2 - 0.28, 0.99, 0.15, C.amber);
        break;
      }
      case "counter": {
        box(group, C.woodDark, [sx, sy, sz], [0, sy / 2, 0]);
        box(group, C.woodLight, [sx + 0.12, 0.09, sz + 0.12], [0, sy + 0.04, 0]);
        for (let door = 0; door < Math.floor(sx / 0.96); door++)
          box(group, C.wood, [0.86, 0.8, 0.04], [-sx / 2 + 0.5 + door * 0.96, 0.5, -sz / 2 - 0.01]);
        for (const x of [-1.4, -0.9, -0.45]) voxelModel(group, "office_mug", [x, sy + 0.06, 0], 0.3, 0.72);
        // Warm brass pendant lamps over the espresso bar
        for (const px of [-1.1, 0.9]) {
          box(group, C.brass, [0.025, 0.8, 0.025], [px, sy + 1.45, 0]);
          shape(group, "cylinder", C.lamp, [0.22, 0.18, 0.22], [px, sy + 1.0, 0], 0.95);
        }
        break;
      }
      case "desk": {
        voxelModel(group, "office_table_desk", [0, 0, 0], 0, 0.85);
        voxelModel(group, "office_pc", [0, 0.88, -0.1], 0, 0.6);
        voxelModel(group, "office_mug", [0.55, 0.88, 0.1], 0.4, 0.6);
        break;
      }
      case "rug":
        box(group, C.rugWarm, [sx, 0.02, sz], [0, 0.028, 0]);
        box(group, C.carpetInner, [sx - 0.36, 0.022, sz - 0.36], [0, 0.032, 0]);
        box(group, C.rugBorder, [sx - 0.24, 0.024, 0.055], [0, 0.035, -sz / 2 + 0.18], false, 0.45);
        box(group, C.rugBorder, [sx - 0.24, 0.024, 0.055], [0, 0.035, sz / 2 - 0.18], false, 0.45);
        break;
      case "floorLamp":
        floorLamp(group);
        break;
      case "planter":
        planterTrough(group, sx, sy, sz);
        break;
    }
  }

  const screens: THREE.MeshStandardMaterial[] = [];
  function monitor(
    parent: THREE.Object3D,
    x: number,
    z: number,
    accent: string,
    yBase = 1.0,
    yaw = 0,
    scale = 1,
  ) {
    const mon = new THREE.Group();
    mon.position.set(x, yBase, z);
    mon.rotation.y = yaw;
    mon.scale.setScalar(scale);
    parent.add(mon);
    box(mon, C.trim, [0.76, 0.5, 0.065], [0, 0.49, 0]);
    // Warm wooden chin strip under monitor bezel
    box(mon, C.wood, [0.76, 0.028, 0.07], [0, 0.25, 0.005]);
    const screen = box(
      mon,
      C.screen,
      [0.67, 0.405, 0.01],
      [0, 0.49, 0.04],
      false,
      0.38,
    );
    // Each screen has its own material: activity brightness belongs to one agent.
    screen.material = screen.material.clone();
    box(mon, C.metal, [0.055, 0.2, 0.055], [0, 0.16, 0]);
    box(mon, C.woodDark, [0.32, 0.032, 0.22], [0, 0.075, 0.05]);
    for (let line = 0; line < 7; line++)
      box(
        mon,
        line % 3 ? C.code : accent,
        [0.18 + (line % 4) * 0.09, 0.013, 0.008],
        [-0.12 + (line % 2) * 0.05, 0.62 - line * 0.043, 0.05],
        false,
        0.55,
      );
    return screen.material;
  }
  function officeChair(
    parent: THREE.Object3D,
    x: number,
    z: number,
    angle = 0,
    scale = 1,
    accent: string = C.wood,
  ) {
    const chair = new THREE.Group();
    chair.position.set(x, 0, z);
    chair.rotation.y = angle;
    chair.scale.setScalar(scale);
    parent.add(chair);
    // Warm bentwood outer shell + plush upholstered cushion
    box(chair, C.woodDark, [0.68, 0.08, 0.6], [0, 0.44, 0.04]);
    box(chair, C.chairCushion, [0.64, 0.11, 0.55], [0, 0.5, 0.04]);
    box(chair, C.wood, [0.7, 0.66, 0.11], [0, 0.9, 0.38]);
    box(chair, C.chairCushion, [0.62, 0.58, 0.07], [0, 0.92, 0.31]);
    // Subtle accent piping along top of chair backrest
    box(chair, accent, [0.52, 0.035, 0.08], [0, 1.22, 0.35], false, 0.45);
    box(chair, C.metal, [0.08, 0.3, 0.08], [0, 0.25, 0.04]);
    for (const side of [-1, 1]) {
      box(chair, C.metal, [0.055, 0.25, 0.055], [side * 0.36, 0.58, 0.1]);
      box(chair, C.wood, [0.09, 0.055, 0.38], [side * 0.36, 0.72, 0.06]);
    }
    for (let spoke = 0; spoke < 5; spoke++) {
      const spokeAngle = (spoke * Math.PI * 2) / 5;
      const arm = box(
        chair,
        C.metal,
        [0.055, 0.045, 0.36],
        [Math.sin(spokeAngle) * 0.16, 0.12, 0.04 + Math.cos(spokeAngle) * 0.16],
      );
      arm.rotation.y = spokeAngle;
      box(
        chair,
        C.trim,
        [0.09, 0.09, 0.11],
        [Math.sin(spokeAngle) * 0.32, 0.06, 0.04 + Math.cos(spokeAngle) * 0.32],
      );
    }
  }
  function keyboardAndMouse(
    parent: THREE.Object3D,
    x: number,
    y: number,
    z: number,
    accent: string,
  ) {
    // Cozy desk mat
    box(parent, C.mousePad, [1.18, 0.012, 0.36], [x + 0.14, y + 0.006, z]);
    // Mechanical keyboard with warm wood wrist rest
    box(parent, C.trim, [0.76, 0.045, 0.24], [x - 0.08, y + 0.028, z - 0.02]);
    box(parent, C.wood, [0.76, 0.028, 0.07], [x - 0.08, y + 0.018, z + 0.13]);
    for (let row = 0; row < 4; row++)
      for (let key = 0; key < 11; key++)
        box(
          parent,
          key === 0 && row === 0 ? accent : C.key,
          [0.048, 0.012, 0.038],
          [x - 0.38 + key * 0.06, y + 0.056, z - 0.095 + row * 0.05],
        );
    // Ergonomic wireless mouse
    box(parent, C.metal, [0.12, 0.045, 0.18], [x + 0.52, y + 0.028, z]);
  }

  // Every crew member sits at a cozy wooden studio workstation tailored to their role.
  // Each post is built facing −z in local space, then turned to its facing.
  for (const member of TEAM) {
    const station = new THREE.Group();
    station.position.set(member.home.x, 0, member.home.z);
    station.rotation.y = facingOf(member) - Math.PI;
    room.add(station);
    const x = 0;
    // Cozy woven rug under every agent's workstation
    box(station, C.rugWarm, [2.5, 0.018, 2.1], [x, 0.018, -0.38]);
    box(station, member.color, [2.36, 0.02, 0.045], [x, 0.022, -1.36], false, 0.45);
    box(station, member.color, [2.36, 0.02, 0.045], [x, 0.022, 0.6], false, 0.45);

    if (member.post === "lead") {
      const deskZ = -0.95;
      box(station, C.wood, [2.7, 0.11, 1.15], [x, 1.0, deskZ]);
      box(station, C.woodEdge, [2.74, 0.045, 1.18], [x, 0.93, deskZ]);
      // Modesty panel with warm glowing accent bar
      box(station, C.woodDark, [2.3, 0.48, 0.05], [x, 0.66, deskZ - 0.48]);
      box(station, member.color, [1.8, 0.035, 0.03], [x, 0.86, deskZ - 0.51], false, 0.95);
      for (const dx of [-1.2, 1.2])
        for (const dz of [-0.44, 0.44])
          box(
            station,
            C.woodDark,
            [0.1, 0.92, 0.1],
            [x + dx, 0.46, deskZ + dz],
          );
      screens.push(monitor(station, x - 0.46, deskZ - 0.22, member.color, 1.0, 0.14));
      screens.push(monitor(station, x + 0.42, deskZ - 0.22, member.color, 1.0, -0.14));
      keyboardAndMouse(station, x, 1.055, deskZ + 0.22, member.color);
      box(station, C.serverBody, [0.38, 0.7, 0.7], [x + 0.98, 0.36, deskZ]);
      box(
        station,
        member.color,
        [0.025, 0.36, 0.025],
        [x + 0.85, 0.4, deskZ + 0.36],
        false,
        0.85,
      );
      voxelModel(
        station,
        "office_mug",
        [x - 1.05, 1.06, deskZ + 0.15],
        0.5,
        0.65,
      );
      voxelModel(
        station,
        "office_plant",
        [x - 1.08, 1.06, deskZ - 0.28],
        0.2,
        0.55,
      );
      warmDeskLamp(station, x + 1.06, 1.055, deskZ - 0.12, member.color);
      officeChair(station, x, 0.1, 0, 1, member.color);
    } else {
      // Specialist seated wooden workstation: low-profile oak desk with angled
      // dual monitors on the wings so the seated character's face stays unobstructed.
      const deskZ = -0.64;
      const deskY = 0.82;
      box(station, C.wood, [1.62, 0.085, 0.62], [x, deskY, deskZ]);
      box(station, C.woodEdge, [1.65, 0.038, 0.65], [x, deskY - 0.05, deskZ]);
      // Front modesty panel with glowing specialist color strip
      box(station, C.woodDark, [1.44, 0.42, 0.045], [x, deskY - 0.26, deskZ - 0.26]);
      box(
        station,
        member.color,
        [1.26, 0.035, 0.03],
        [x, deskY - 0.08, deskZ - 0.29],
        false,
        0.95,
      );
      for (const dx of [-0.72, 0.72])
        for (const dz of [-0.24, 0.24])
          box(
            station,
            C.woodDark,
            [0.08, deskY - 0.04, 0.08],
            [x + dx, (deskY - 0.04) / 2, deskZ + dz],
          );
      // Angled dual studio monitors positioned to the sides for a clear sightline
      screens.push(
        monitor(station, x - 0.48, deskZ - 0.12, member.color, deskY - 0.02, 0.28, 0.78),
      );
      screens.push(
        monitor(station, x + 0.48, deskZ - 0.12, member.color, deskY - 0.02, -0.28, 0.78),
      );
      keyboardAndMouse(station, x - 0.04, deskY + 0.042, deskZ + 0.1, member.color);
      warmDeskLamp(station, x - 0.68, deskY + 0.04, deskZ + 0.12, member.color);
      voxelModel(station, "office_mug", [x + 0.66, deskY + 0.045, deskZ + 0.14], -0.4, 0.55);
      if (member.id === "ada" || member.id === "alan") {
        voxelModel(station, "office_papers", [x - 0.58, deskY + 0.045, deskZ + 0.18], 0.2, 0.55);
      } else {
        voxelModel(station, "office_plant", [x + 0.68, deskY + 0.045, deskZ - 0.16], 0, 0.48);
      }
      officeChair(station, x, 0.08, 0, 0.96, member.color);
    }
  }

  // Video wall at the north edge of the hub: one live panel per helper, framed in warm walnut & brass.
  const wallZ = VIDEO_WALL.z;
  const helpers = TEAM.filter((member) => member.post === "console");
  const panelStep = 1.95;
  const wallWidth = helpers.length * panelStep;
  const wallCenter = 0;
  const panelX = (index: number) =>
    wallCenter - wallWidth / 2 + panelStep / 2 + index * panelStep;
  box(room, C.woodDark, [wallWidth + 0.44, 1.88, 0.24], [wallCenter, 2.25, wallZ]);
  box(room, C.trim, [wallWidth + 0.28, 1.72, 0.26], [wallCenter, 2.25, wallZ + 0.01]);
  for (const y of [1.34, 3.16])
    box(room, C.wood, [wallWidth + 0.48, 0.09, 0.32], [wallCenter, y, wallZ + 0.04]);
  for (const x of [wallCenter - wallWidth / 2 - 0.14, wallCenter + wallWidth / 2 + 0.14])
    box(room, C.woodDark, [0.16, 3.5, 0.18], [x, 1.75, wallZ - 0.05]);
  box(room, C.amber, [wallWidth + 0.3, 0.04, 0.04], [wallCenter, 3.23, wallZ + 0.15], false, 1.6);
  const wallScreens = {} as Record<AgentId, THREE.Mesh>;
  helpers.forEach((member, index) => {
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.72, 1.5),
      new THREE.MeshBasicMaterial({ color: "#141920", toneMapped: false }),
    );
    panel.position.set(panelX(index), 2.25, wallZ + 0.145);
    panel.name = `wall-${member.id}`;
    scene.add(panel);
    wallScreens[member.id] = panel;
  });

  // Panoramic 3D Subscription Quota & Token Telemetry Marquee mounted above the Central Hub Video Wall
  // plus a secondary live telemetry display on the Ops Room north wall.
  const quotaScreens: THREE.Mesh[] = [];
  {
    const qWidth = 7.8;
    const qHeight = 1.42;
    const qY = 4.18;
    // Brushed brass support stanchions rising from the Hub Video Wall crown
    for (const sx of [-2.8, 0, 2.8]) {
      box(room, C.brass, [0.1, 0.42, 0.1], [sx, 3.36, wallZ + 0.02]);
    }
    box(room, C.woodDark, [qWidth + 0.36, qHeight + 0.24, 0.22], [wallCenter, qY, wallZ + 0.02]);
    box(room, C.trim, [qWidth + 0.18, qHeight + 0.1, 0.24], [wallCenter, qY, wallZ + 0.03]);
    box(room, C.brass, [qWidth + 0.4, 0.06, 0.28], [wallCenter, qY + qHeight / 2 + 0.12, wallZ + 0.04]);
    box(room, C.cyan, [qWidth, 0.035, 0.04], [wallCenter, qY + qHeight / 2 + 0.08, wallZ + 0.16], false, 1.6);

    const hubQuotaScreen = new THREE.Mesh(
      new THREE.PlaneGeometry(qWidth, qHeight),
      new THREE.MeshBasicMaterial({ color: "#11161f", toneMapped: false }),
    );
    hubQuotaScreen.position.set(wallCenter, qY, wallZ + 0.155);
    hubQuotaScreen.name = "quota-wall-hub";
    scene.add(hubQuotaScreen);
    quotaScreens.push(hubQuotaScreen);

    // Secondary 3D Quota Telemetry Board in Grace's Ops Room
    const opsX = -11.4,
      opsY = 2.48,
      opsZ = -1.72;
    box(room, C.woodDark, [4.1, 0.92, 0.18], [opsX, opsY, opsZ]);
    box(room, C.brass, [4.14, 0.05, 0.22], [opsX, opsY + 0.46, opsZ + 0.02]);
    const opsQuotaScreen = new THREE.Mesh(
      new THREE.PlaneGeometry(3.9, 0.74),
      new THREE.MeshBasicMaterial({ color: "#11161f", toneMapped: false }),
    );
    opsQuotaScreen.position.set(opsX, opsY, opsZ + 0.1);
    opsQuotaScreen.name = "quota-wall-ops";
    scene.add(opsQuotaScreen);
    quotaScreens.push(opsQuotaScreen);
  }

  // Lumen Night Foundry apparatus tables in the Command Hub: precision brass
  // filament chamber (west) & rotating holographic gyroscope table (east).
  const holoGyro = new THREE.Group();
  {
    const ax = -3.9,
      az = 1.6;
    box(room, C.rugWarm, [2.2, 0.018, 2.2], [ax, 0.02, az]);
    box(room, C.woodDark, [1.36, 0.78, 1.36], [ax, 0.39, az]);
    box(room, C.wood, [1.52, 0.08, 1.52], [ax, 0.81, az]);
    box(room, C.brass, [1.56, 0.03, 1.56], [ax, 0.85, az]);
    shape(room, "cylinder", C.amber, [0.06, 0.86, 0.06], [ax, 1.3, az], 2.2);
    for (const ry of [1.02, 1.24, 1.46, 1.68]) {
      shape(room, "cylinder", C.brass, [0.42, 0.022, 0.42], [ax, ry, az]);
    }
    TEAM.forEach((m, idx) => {
      const ang = (idx / TEAM.length) * Math.PI * 2;
      const nx = ax + Math.cos(ang) * 0.48;
      const nz = az + Math.sin(ang) * 0.48;
      const nh = 0.18 + (idx % 3) * 0.08;
      box(room, m.color, [0.1, nh, 0.1], [nx, 0.86 + nh / 2, nz], false, 1.4);
    });

    // East Command Hub Holographic Map & Gyroscope Table
    const gx = 3.9,
      gz = 1.6;
    box(room, C.rugWarm, [2.2, 0.018, 2.2], [gx, 0.02, gz]);
    box(room, C.woodDark, [1.46, 0.78, 1.46], [gx, 0.39, gz]);
    box(room, C.wood, [1.62, 0.08, 1.62], [gx, 0.81, gz]);
    box(room, C.cyan, [1.44, 0.03, 1.44], [gx, 0.86, gz], false, 1.2);
    holoGyro.position.set(gx, 1.38, gz);
    const ring1 = new THREE.Mesh(
      new THREE.TorusGeometry(0.42, 0.022, 8, 24),
      material(C.cyan, 1.6),
    );
    const ring2 = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.02, 8, 24),
      material(C.brass, 1.4),
    );
    ring2.rotation.x = Math.PI / 2;
    const core = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.16, 0),
      material(C.amber, 2.0),
    );
    holoGyro.add(ring1, ring2, core);
    scene.add(holoGyro);
  }

  // A warm wooden communal break table with a woven rug and hanging pendant lamp furnishes the lounge.
  const { x: tableX, z: tableZ } = DISCUSSION_CENTER;
  box(room, C.rugWarm, [3.8, 0.018, 3.4], [tableX, 0.02, tableZ]);
  box(room, C.rugBorder, [3.6, 0.022, 0.05], [tableX, 0.024, tableZ - 1.55], false, 0.5);
  box(room, C.rugBorder, [3.6, 0.022, 0.05], [tableX, 0.024, tableZ + 1.55], false, 0.5);
  box(room, C.wood, [2.15, 0.1, 1.6], [tableX, 0.88, tableZ]);
  box(room, C.woodEdge, [2.19, 0.04, 1.64], [tableX, 0.82, tableZ]);
  for (const dx of [-0.86, 0.86])
    for (const dz of [-0.59, 0.59])
      box(room, C.woodDark, [0.1, 0.84, 0.1], [tableX + dx, 0.42, tableZ + dz]);
  for (const dz of [-1.3, 1.3])
    for (const dx of [-0.6, 0.6])
      officeChair(room, tableX + dx, tableZ + dz, dz < 0 ? Math.PI : 0, 0.8, C.amber);
  voxelModel(room, "office_mug", [tableX - 0.55, 0.94, tableZ - 0.18], 0.2, 0.65);
  voxelModel(room, "office_mug", [tableX + 0.48, 0.94, tableZ + 0.22], -0.5, 0.62);
  voxelModel(room, "office_plant", [tableX, 0.94, tableZ], 0, 0.58);
  // Warm pendant chandelier suspended over the break table
  box(room, C.brass, [0.03, 0.95, 0.03], [tableX, 2.75, tableZ]);
  shape(room, "cylinder", C.lamp, [0.38, 0.22, 0.38], [tableX, 2.22, tableZ], 0.95);

  // Warm desk lamp pools and a cozy wash on the video wall carry the studio lighting.
  {
    const lead = TEAM.find((member) => member.post === "lead")!;
    const lamp = new THREE.PointLight(C.amber, 11, 5.5, 2);
    const f = facingOf(lead) - Math.PI;
    lamp.position.set(
      lead.home.x + Math.cos(f) * 1.06 + Math.sin(f) * -0.95,
      1.75,
      lead.home.z - Math.sin(f) * 1.06 + Math.cos(f) * -0.95,
    );
    scene.add(lamp);
    const wash = new THREE.PointLight(C.amber, 10, 7.5, 2);
    wash.position.set(wallCenter, 3.2, wallZ + 1.6);
    scene.add(wash);
  }
  const ambient = new THREE.HemisphereLight(C.ambient, C.woodDark, 1.25);
  scene.add(ambient);
  const sunlight = new THREE.DirectionalLight(C.moon, 1.85);
  sunlight.position.set(6, 22, 9);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(2048, 2048);
  Object.assign(sunlight.shadow.camera, {
    left: -28,
    right: 28,
    top: 24,
    bottom: -24,
    near: 0.5,
    far: 70,
  });
  sunlight.shadow.bias = 0.001;
  sunlight.shadow.normalBias = 0.05;
  scene.add(sunlight);
  const fill = new THREE.DirectionalLight(C.amber, 0.65);
  fill.position.set(-5, 6, -5);
  scene.add(fill);
  // One warm-tinted practical per room keeps each space readable and inviting.
  for (const r of ROOMS) {
    const light = new THREE.PointLight(r.accent, 20, 12, 2);
    light.position.set((r.minX + r.maxX) / 2, 2.8, (r.minZ + r.maxZ) / 2);
    scene.add(light);
  }

  // Bake static transforms into material batches: the room stays inexpensive to draw.
  room.updateMatrixWorld(true);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const staticColors = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    flatShading: true,
  });
  room.traverse((object) => {
    if (
      !(object instanceof THREE.Mesh) ||
      !(object.material instanceof THREE.MeshStandardMaterial)
    )
      return;
    const transformed = (
      object.geometry.index
        ? object.geometry.toNonIndexed()
        : object.geometry.clone()
    ).applyMatrix4(object.matrixWorld);
    let mat = object.material;
    // Batch opaque colours together; emissive screens and palette textures stay mutable.
    if (!mat.map && mat.emissiveIntensity === 0) {
      const colors = new Float32Array(
        transformed.getAttribute("position").count * 3,
      );
      for (let i = 0; i < colors.length; i += 3) {
        colors[i] = mat.color.r;
        colors[i + 1] = mat.color.g;
        colors[i + 2] = mat.color.b;
      }
      transformed.setAttribute("color", new THREE.BufferAttribute(colors, 3));
      mat = staticColors;
    }
    const batch = batches.get(mat) ?? [];
    batch.push(transformed);
    batches.set(mat, batch);
  });
  room.clear();
  continuousFloor.geometry.dispose();
  const baked: THREE.BufferGeometry[] = [];
  batches.forEach((parts, mat) => {
    const combined = mergeGeometries(parts);
    parts.forEach((part) => part.dispose());
    if (!combined) return;
    baked.push(combined);
    const mesh = new THREE.Mesh(combined, mat);
    // The baked room is static. Let characters cast shadows onto it, but avoid
    // self-shadowing the large floor/wall batches, which causes acne and flicker.
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    room.add(mesh);
  });

  const routine = createOfficeRoutine();
  const contactGeometry = new THREE.CircleGeometry(0.57, 16);
  const contactMaterial = new THREE.MeshBasicMaterial({
    color: "#090b10",
    transparent: true,
    opacity: 0.24,
    depthWrite: false,
  });
  function character(member: (typeof TEAM)[number], index: number) {
    const { root, body, head, arms, legs, knees } = createVoxelCharacter(
      member.id,
      () =>
        queueMicrotask(() => {
          if (!disposed) {
            const actor = characters.find((other) => other.root === root);
            if (actor) actor.shadowAnchored = null;
            renderer.shadowMap.needsUpdate = true;
            draw(0);
          }
        }),
    );
    // Proportion scale: 0.76 aligns the character height (~1.48m) with the voxel furniture
    // (chair seat 0.45m, desk 0.9m) so the character doesn't look oversized.
    root.scale.setScalar(0.76);
    scene.add(root);
    const ringMaterial = new THREE.MeshBasicMaterial({
      color: member.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.56, 0.68, 28),
      ringMaterial,
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.085;
    root.add(ring);
    const contactShadow = new THREE.Mesh(contactGeometry, contactMaterial);
    contactShadow.name = "visitor-shadow";
    contactShadow.rotation.x = -Math.PI / 2;
    contactShadow.scale.y = 0.7;
    contactShadow.position.y = 0.075;
    contactShadow.visible = false;
    root.add(contactShadow);
    const mug = voxelModel(body, "office_mug", [0.45, 1.15, 0.28], 0, 0.45);
    mug.name = "coffee-mug";
    mug.visible = false;
    mug.castShadow = false;
    const label = document.createElement("div");
    label.className = "office-agent-label";
    label.style.setProperty("--agent-color", member.color);
    const name = document.createElement("span");
    name.className = "office-agent-name";
    name.textContent = member.name;
    const bubble = document.createElement("span");
    bubble.className = "office-agent-activity";
    label.append(name, bubble);
    if (options.onSelect) {
      label.classList.add("is-interactive");
      label.tabIndex = 0;
      label.setAttribute("role", "button");
      label.setAttribute("aria-label", `${member.name}: show work`);
      const select = () => options.onSelect?.(member.id);
      label.addEventListener("click", select);
      label.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          select();
        }
      });
    }
    labels.append(label);
    root.position.set(member.home.x, 0, member.home.z);
    root.rotation.y = facingOf(member);
    return {
      member,
      root,
      body,
      head,
      arms,
      legs,
      knees,
      ring,
      ringMaterial,
      contactShadow,
      mug,
      label,
      bubble,
      walker: routine.walkers[index],
      // All six crew members sit at their cozy studio workstations when at their post.
      sit: 1,
      shadowAnchored: true as boolean | null,
      projectedAt: { x: NaN, z: NaN, y: NaN },
      focused: false,
      hovered: false,
      bubbleUntil: 0,
      activityText: "",
      activityError: false,
      status: "idle" as SceneCrew["members"][number]["status"],
      cheerFrom: -Infinity,
      shakeFrom: -Infinity,
      waveFrom: -Infinity,
      errandKind: "peer" as "peer" | "coffee" | "server",
      visitTarget: null as AgentId | null,
      visitReply: "",
      selected: false,
    };
  }
  const characters = TEAM.map(character);
  const GREETINGS: Record<AgentId, string> = {
    kern: "Command Hub online — ready to coordinate!",
    ada: "Checking references in the Archive!",
    alan: "Sketching out the next architecture!",
    linus: "Workbench warmed up and ready to build!",
    bob: "Test benches calibrated and green!",
    grace: "Ops telemetry nominal across all nodes!",
  };
  const PEER_CHATS: readonly {
    from: AgentId;
    to: AgentId;
    say: string;
    reply: string;
  }[] = [
    {
      from: "ada",
      to: "alan",
      say: "Found prior art for this spec, Alan!",
      reply: "Nice find, Ada! Updating the diagram.",
    },
    {
      from: "linus",
      to: "bob",
      say: "New build is ready — can we run the suite?",
      reply: "On it, Linus! Spinning up the runners.",
    },
    {
      from: "grace",
      to: "kern",
      say: "All studio pipelines are healthy, Kern.",
      reply: "Awesome work, Grace — keep it steady!",
    },
    {
      from: "alan",
      to: "linus",
      say: "Here's the simplified state flow, Linus.",
      reply: "Super clean! I'll wire that up now.",
    },
    {
      from: "bob",
      to: "ada",
      say: "Logged the edge-case notes for the docs.",
      reply: "Got them, Bob — archiving right now!",
    },
    {
      from: "kern",
      to: "alan",
      say: "How's the research prototype looking?",
      reply: "Benchmarks look promising, Kern!",
    },
  ];
  const isLiveStudio = Boolean(options.liveStudio);
  let peerChatIndex = 0;
  let nextPeerChatAt = isLiveStudio ? 0.4 : 11;
  let reduced = false,
    visible = true,
    disposed = false,
    dark = true,
    working = false;
  let bubbleTimeout: ReturnType<typeof setTimeout> | undefined;
  let elapsed = 0,
    previous = 0,
    width = 1,
    height = 1;
  const projected = new THREE.Vector3();
  const baseCamera = new THREE.Vector3();
  const homeFocus = options.focus ?? { x: 0.8, z: 0.7 };
  const homeZoom = options.zoom ?? 1;
  // Current and target framing; focusOn() and rotateBy() glide between them.
  const focus = { ...homeFocus };
  let zoom = homeZoom;
  let yaw = 0;
  const framing = {
    x: homeFocus.x,
    z: homeFocus.z,
    zoom: homeZoom,
    yaw: 0,
    followId: null as AgentId | null,
  };
  const lookAt = new THREE.Vector3(focus.x, 1.25, focus.z);
  let labelsNeedLayout = true;
  let workAmount = 0;

  // Multi-pair warm brass collaboration floor tethers connecting conversing peers
  const collabBeams = [0, 1, 2].map((i) => {
    const mat = new THREE.MeshBasicMaterial({
      color: i % 2 === 0 ? 0xf5b841 : 0x64d2e8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 1), mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.14;
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, mat };
  });

  function resize() {
    width = Math.max(1, canvas.parentElement?.clientWidth || 1);
    height = Math.max(1, canvas.parentElement?.clientHeight || 1);
    // Leave GPU headroom for the moving visitor and composited labels on Retina.
    renderer.setPixelRatio(
      Math.min(
        window.devicePixelRatio || 1,
        1.25,
        Math.sqrt(2_500_000 / (width * height)),
      ),
    );
    renderer.setSize(Math.ceil(width), Math.ceil(height), false);
    frameCamera();
    draw(0);
  }
  function frameCamera() {
    const aspect = width / height;
    const halfHeight = Math.max(6.3, 9.5 / aspect) / zoom;
    lookAt.set(focus.x, 1.25, focus.z);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    // Default isometric offset (16.2, 20.3) rotated by `yaw` around the focus point.
    const dx0 = 16.2,
      dz0 = 20.3;
    const cos = Math.cos(yaw),
      sin = Math.sin(yaw);
    baseCamera.set(
      focus.x + dx0 * cos + dz0 * sin,
      16,
      focus.z - dx0 * sin + dz0 * cos,
    );
    camera.position.copy(baseCamera);
    camera.lookAt(lookAt);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    labelsNeedLayout = true;
  }
  function setTheme(value: boolean) {
    dark = value;
    scene.background = new THREE.Color(dark ? C.night : C.day);
    ambient.intensity = dark ? 1.15 : 2.1;
    sunlight.intensity = dark ? 1.55 : 3.0;
    sunlight.color.set(dark ? C.moon : C.daylight);
    fill.intensity = dark ? 0.6 : 0.85;
    skyMaterial.color.set(dark ? C.skyNight : C.skyDay);
    skyMaterial.emissive.set(dark ? C.skyNight : C.skyDay);
    renderer.toneMappingExposure = dark ? 0.98 : 1.08;
    renderer.shadowMap.needsUpdate = true;
    draw(0);
  }
  function setWorking(value: boolean) {
    working = value;
    setRoutineWorking(routine, value);
    if (!working)
      characters.forEach((actor) => {
        actor.focused = false;
      });
    else if (!characters.some((actor) => actor.focused))
      characters.find((actor) => actor.member.id === "kern")!.focused = true;
    if (reduced || !previous) draw(0);
  }
  function setActivity(activity: Activity) {
    clearTimeout(bubbleTimeout);
    working = activity.working;
    setRoutineWorking(routine, activity.working);
    characters.forEach((actor) => {
      actor.focused = activity.working && actor.member.id === activity.id;
      if (actor.member.id === activity.id) {
        const text = activity.text.replace(/\s+/g, " ").trim();
        actor.activityText = text.length > 58 ? `${text.slice(0, 57)}…` : text;
        actor.bubbleUntil = elapsed + (activity.working ? 8 : 3.5);
        actor.activityError = !!activity.error;
      } else {
        actor.bubbleUntil = 0;
      }
    });
    if (reduced || !previous) draw(0);
    scheduleBubbleExpiry();
  }
  let crewSeen = Boolean(options.liveStudio);
  function setCrew(crew: SceneCrew) {
    clearTimeout(bubbleTimeout);
    working = crew.working;
    setRoutineWorking(routine, crew.working);
    for (const state of crew.members) {
      const actor = characters.find((item) => item.member.id === state.id);
      if (!actor) continue;
      // React to changes, not to the state found when the panel opens.
      if (crewSeen && state.status !== actor.status) {
        if (state.status === "done") actor.cheerFrom = elapsed;
        if (state.status === "error") actor.shakeFrom = elapsed;
      }
      actor.status = state.status;
      actor.focused = state.status === "working";
      const text = state.text.replace(/\s+/g, " ").trim();
      actor.activityText = text.length > 58 ? `${text.slice(0, 57)}…` : text;
      actor.activityError = state.status === "error";
      actor.bubbleUntil = state.status === "idle" || !text ? 0 : Infinity;
    }
    crewSeen = true;
    if (reduced || !previous) draw(0);
  }
  function setSelected(id: AgentId | null) {
    characters.forEach((actor) => {
      const wasSelected = actor.selected;
      actor.selected = actor.member.id === id;
      if (actor.selected && !wasSelected && !reduced) {
        actor.waveFrom = elapsed;
      }
    });
    if (reduced || !previous) draw(0);
  }
  function startPeerVisit(
    id: AgentId,
    to: AgentId,
    opts: { dwell?: number; say?: string; reply?: string } = {},
  ) {
    const index = TEAM.findIndex((m) => m.id === id);
    const host = TEAM.find((m) => m.id === to)!;
    const f = facingOf(host);
    // Stand across the host's wooden desk, facing them.
    const reach = host.post === "lead" ? 2.4 : 1.75;
    const destination = {
      x: host.home.x + Math.sin(f) * reach,
      z: host.home.z + Math.cos(f) * reach,
    };
    const ok = sendOnErrand(routine, index, {
      destination,
      lookAt: host.home,
      dwell: opts.dwell ?? 4.2,
      say: opts.say ?? `Syncing with ${host.name}`,
    });
    if (ok) {
      characters[index].errandKind = "peer";
      characters[index].visitTarget = to;
      characters[index].visitReply =
        opts.reply ?? `Sounds good, ${characters[index].member.name}!`;
    }
    return ok;
  }
  function findAgentAt(x: number, y: number): AgentId | null {
    const pick = new THREE.Vector3();
    let bestId: AgentId | null = null;
    let bestDist = Infinity;
    const hitRadius = Math.max(28, Math.min(72, 46 * Math.sqrt(zoom)));
    for (const actor of characters) {
      // Check both live character position and their home desk
      for (const [px, py, pz, weight] of [
        [actor.walker.position.x, 0.85, actor.walker.position.z, 1],
        [actor.member.home.x, 0.65, actor.member.home.z - 0.3, 1.25],
      ] as const) {
        pick.set(px, py, pz).project(camera);
        if (pick.z > 1) continue;
        const sx = (pick.x * 0.5 + 0.5) * width;
        const sy = (-pick.y * 0.5 + 0.5) * height;
        const d = Math.hypot(x - sx, y - sy) * weight;
        if (d < hitRadius && d < bestDist) {
          bestDist = d;
          bestId = actor.member.id;
        }
      }
    }
    return bestId;
  }
  // 0 → 1 → 0 over `duration` seconds after `from`.
  const envelope = (from: number, duration: number) => {
    const t = elapsed - from;
    return t < 0 || t > duration ? 0 : Math.sin((Math.PI * t) / duration);
  };
  function scheduleBubbleExpiry() {
    clearTimeout(bubbleTimeout);
    const remaining = Math.max(
      ...characters.map((actor) => actor.bubbleUntil - elapsed),
    );
    if (reduced && remaining > 0) {
      bubbleTimeout = setTimeout(() => {
        characters.forEach((actor) => {
          actor.bubbleUntil = 0;
        });
        draw(0);
      }, remaining * 1000);
    }
  }

  let frameHook: ((elapsed: number, dt: number) => void) | null = null;
  function draw(dt: number) {
    if (disposed || !visible) return;
    elapsed += dt;
    const targetWork = working && !reduced ? 1 : 0;
    workAmount = reduced ? 0 : damp(workAmount, targetWork, 8, dt);
    if (Math.abs(workAmount - targetWork) < 0.001) workAmount = targetWork;

    // In the live studio (when crewSeen is active and not working), schedule
    // spontaneous peer-to-peer desk collaborations IN PARALLEL so multiple
    // pairs of agents are actively walking and conversing across the floor.
    const activeErrandCount = routine.errands.filter(Boolean).length;
    const maxConcurrentPeers = isLiveStudio ? 2 : 1;
    if (
      crewSeen &&
      !working &&
      !reduced &&
      elapsed >= nextPeerChatAt &&
      activeErrandCount < maxConcurrentPeers
    ) {
      for (let attempt = 0; attempt < PEER_CHATS.length; attempt++) {
        const chat = PEER_CHATS[(peerChatIndex + attempt) % PEER_CHATS.length];
        const fromIdx = TEAM.findIndex((m) => m.id === chat.from);
        const toIdx = TEAM.findIndex((m) => m.id === chat.to);
        const busyWithErrand =
          Boolean(routine.errands[fromIdx]) ||
          Boolean(routine.errands[toIdx]) ||
          characters.some(
            (c) => c.visitTarget === chat.from || c.visitTarget === chat.to,
          );
        if (
          !busyWithErrand &&
          fromIdx !== routine.active &&
          toIdx !== routine.active
        ) {
          peerChatIndex = peerChatIndex + attempt + 1;
          nextPeerChatAt = elapsed + (isLiveStudio ? 3.6 : 7.5);
          startPeerVisit(chat.from, chat.to, {
            dwell: 5.2,
            say: chat.say,
            reply: chat.reply,
          });
          break;
        }
      }
    }

    characters.forEach((actor, index) => {
      if (!routine.errands[index]) {
        actor.visitTarget = null;
        actor.visitReply = "";
      }
      actor.sit = reduced
        ? 1
        : damp(
            actor.sit,
            routine.stages[index] === "desk" ? 1 : 0,
            8,
            dt,
          );
      if (actor.sit < 0.001) actor.sit = 0;
      if (actor.sit > 0.999) actor.sit = 1;
    });
    advanceOfficeRoutine(
      routine,
      dt,
      characters.map((actor) => actor.sit < 0.12),
    );
    if (framing.followId) {
      const followed = characters.find(
        (a) => a.member.id === framing.followId,
      )!;
      framing.x = followed.walker.position.x;
      framing.z = followed.walker.position.z - 0.6;
    }
    const k = reduced ? 1 : 1 - Math.exp(-3.2 * dt);
    if (
      Math.abs(focus.x - framing.x) > 0.001 ||
      Math.abs(focus.z - framing.z) > 0.001 ||
      Math.abs(zoom - framing.zoom) > 0.001 ||
      Math.abs(yaw - framing.yaw) > 0.001
    ) {
      // Long moves pull back a little mid-flight, like a crane shot.
      const far = Math.hypot(framing.x - focus.x, framing.z - focus.z);
      const travelZoom = framing.zoom / (1 + far / 16);
      focus.x += (framing.x - focus.x) * (dt ? k : 1);
      focus.z += (framing.z - focus.z) * (dt ? k : 1);
      zoom += ((dt ? travelZoom : framing.zoom) - zoom) * (dt ? Math.min(1, k * 1.4) : 1);
      yaw += (framing.yaw - yaw) * (dt ? Math.min(1, k * 1.8) : 1);
      frameCamera();
    }
    const activePeerVisitors: (typeof characters)[number][] = [];
    characters.forEach((actor, index) => {
      const { walker } = actor;
      const stage = routine.stages[index];
      const atDesk = stage === "desk";
      const errand = routine.errands[index];
      const visiting =
        stage === "visiting" && (routine.active === index || !!errand);
      const visit = OFFICE_VISITS[routine.visit];
      const walking = stage === "outbound" || stage === "returning";
      if (errand && actor.errandKind === "peer" && actor.visitTarget) {
        activePeerVisitors.push(actor);
      }
      if (atDesk || visiting) {
        const target = errand ? errand.lookAt : visit.lookAt;
        const heading = atDesk
          ? facingOf(actor.member)
          : Math.atan2(
              target.x - walker.position.x,
              target.z - walker.position.z,
            );
        const turn = Math.atan2(
          Math.sin(heading - walker.heading),
          Math.cos(heading - walker.heading),
        );
        if (Math.abs(turn) < 0.001) walker.heading = heading;
        else walker.heading += turn * (1 - Math.exp(-10 * dt));
      }
      actor.root.position.set(walker.position.x, 0, walker.position.z);
      actor.root.rotation.y = walker.heading;
      // Keep expensive caster updates to departure / return. The visitor's
      // translucent footprint follows every step without another shadow pass.
      if (actor.shadowAnchored !== atDesk) {
        actor.root.traverse((object) => {
          if (object instanceof THREE.Mesh && object !== actor.mug) {
            const mats = Array.isArray(object.material)
              ? object.material
              : [object.material];
            if (mats.some((mat) => mat instanceof THREE.MeshStandardMaterial))
              object.castShadow = atDesk;
          }
        });
        actor.shadowAnchored = atDesk;
        renderer.shadowMap.needsUpdate = true;
      }
      actor.contactShadow.visible = !atDesk;

      // Detect if a colleague is currently visiting (or approaching) this character's desk
      const visitorIdx = characters.findIndex(
        (other, j) =>
          j !== index &&
          routine.errands[j] &&
          other.visitTarget === actor.member.id &&
          (routine.stages[j] === "visiting" ||
            (routine.stages[j] === "outbound" &&
              Math.hypot(
                other.walker.position.x - walker.position.x,
                other.walker.position.z - walker.position.z,
              ) < 5.2)),
      );
      const visitorActor = visitorIdx >= 0 ? characters[visitorIdx] : null;
      const passerbyActor =
        !visitorActor && atDesk && !reduced
          ? characters.find(
              (other, j) =>
                j !== index &&
                routine.stages[j] !== "desk" &&
                Math.hypot(
                  other.walker.position.x - walker.position.x,
                  other.walker.position.z - walker.position.z,
                ) < 3.4,
            ) ?? null
          : null;

      const isPeerVisitor = visiting && !!errand && actor.errandKind === "peer";
      const isPeerHost = !!visitorActor;
      const isChatting = !reduced && (isPeerVisitor || isPeerHost);

      const phase = elapsed * (4.1 + index * 0.17) + index * 1.7;
      const breathe = reduced ? 0 : Math.sin(elapsed * 2.1 + index) * 0.018;
      // Seated at their studio workstation, all crew members type when active.
      const typing = workAmount * (atDesk ? 1 : 0);
      const pace = walking && !reduced ? Math.min(1, walker.speed / 1.25) : 0;
      const gait = walker.distance * 8.5;
      const isCoffeeVisit =
        visiting &&
        ((!errand && visit.kind === "coffee") ||
          (!!errand && actor.errandKind === "coffee"));
      const isServerVisit =
        visiting &&
        ((!errand && visit.kind === "server") ||
          (!!errand && actor.errandKind === "server"));
      const dwellProgress = errand
        ? Math.max(0, Math.min(1, 1 - errand.dwell / 4.2))
        : 1 - routine.dwelling / visit.duration;
      const sip = isCoffeeVisit ? Math.sin(Math.PI * dwellProgress) : 0;
      const inspect = isServerVisit ? Math.sin(Math.PI * dwellProgress) : 0;
      const cheer = reduced ? 0 : envelope(actor.cheerFrom, 2.2);
      const shake = reduced ? 0 : envelope(actor.shakeFrom, 1.4);
      const wave = reduced ? 0 : envelope(actor.waveFrom, 2.0);
      const hoverWave = !reduced && actor.hovered ? 1 : 0;

      // Rich idle studio personality when sitting at the workstation in the live app
      const idleAlive = crewSeen && !working && atDesk && !reduced && !isChatting ? 1 : 0;
      const idleCycle = (elapsed * 0.35 + index * 1.9) % (Math.PI * 2);
      // Periodic light typing bursts and overhead stretches while idling at the desk
      const idleTyping =
        idleAlive * Math.max(0, Math.sin(idleCycle * 2)) * 0.65;
      const idleStretch =
        idleAlive * Math.pow(Math.max(0, Math.sin(idleCycle - 1.8)), 4);

      actor.body.position.y =
        -actor.sit * 0.24 +
        (cheer
          ? Math.abs(Math.sin((elapsed - actor.cheerFrom) * 8)) * 0.14 * cheer
          : 0) +
        (wave
          ? Math.abs(Math.sin((elapsed - actor.waveFrom) * 7)) * 0.08 * wave
          : 0) +
        breathe +
        typing * Math.sin(phase) * 0.018 +
        Math.abs(Math.sin(gait)) * 0.085 * pace;
      actor.body.rotation.x =
        typing * (0.075 + Math.sin(phase) * 0.024) +
        idleTyping * 0.045 -
        idleStretch * 0.14 +
        (isChatting ? Math.sin(elapsed * 4.2 + index) * 0.05 : 0) -
        sip * 0.08 +
        inspect * 0.12;
      actor.body.rotation.z =
        typing * Math.sin(phase * 0.6) * 0.02 +
        idleAlive * Math.sin(elapsed * 1.3 + index) * 0.022 +
        Math.sin(gait) * 0.065 * pace +
        Math.sin(elapsed * 30) * 0.06 * shake;

      // Turn torso/head toward a visiting colleague, passerby, or studio center
      let socialYaw = 0;
      const socialPartner = visitorActor ?? passerbyActor;
      if (socialPartner && atDesk) {
        const worldAngle = Math.atan2(
          socialPartner.walker.position.x - walker.position.x,
          socialPartner.walker.position.z - walker.position.z,
        );
        const rel = Math.atan2(
          Math.sin(worldAngle - walker.heading),
          Math.cos(worldAngle - walker.heading),
        );
        socialYaw = Math.max(-0.85, Math.min(0.85, rel));
      } else if (crewSeen && atDesk && !reduced) {
        // Angle upper body slightly toward studio center so faces & hands read clearly
        socialYaw = actor.member.home.x < -3 ? 0.34 : actor.member.home.x > 3 ? -0.34 : 0.22;
      }

      actor.body.rotation.y = reduced
        ? 0
        : socialYaw * 0.55 +
          typing *
            Math.sin(elapsed * 0.9 + index) *
            (actor.focused ? 0.16 : 0.06) +
          idleAlive * Math.sin(elapsed * 0.75 + index * 1.4) * 0.14 +
          Math.cos(gait) * 0.12 * pace +
          inspect * Math.sin(elapsed * 1.5) * 0.22;

      actor.head.rotation.y = reduced
        ? 0
        : socialYaw * 0.65 +
          Math.sin(elapsed * (working ? 1.4 : 0.95) + index * 2) *
            (working ? 0.16 : 0.22) +
          Math.sin(elapsed * 26) * 0.38 * shake;
      actor.head.rotation.x = reduced
        ? 0
        : typing * (0.06 + Math.sin(elapsed * 3.6 + index) * 0.05) +
          idleAlive * Math.sin(elapsed * 2.2 + index) * 0.06 -
          idleStretch * 0.18 +
          (isChatting ? Math.sin(elapsed * 5.5 + index) * 0.12 : 0) -
          hoverWave * 0.14 -
          sip * 0.22;
      actor.head.rotation.z = reduced
        ? 0
        : (wave + hoverWave * 0.6) * Math.sin(elapsed * 8) * 0.12 +
          idleAlive * Math.cos(elapsed * 1.6 + index) * 0.05 +
          Math.sin(gait * 2) * 0.04 * pace;

      for (let side = 0; side < 2; side++) {
        const stride = Math.sin(gait + side * Math.PI) * pace;
        actor.legs[side].rotation.x =
          -actor.sit * 1.23 + stride * 0.72 * (1 - actor.sit);
        actor.knees[side].rotation.x =
          actor.sit * 1.38 + Math.max(0, -stride) * 0.75 * (1 - actor.sit);
        const talkGesture = isChatting
          ? (0.55 + Math.sin(elapsed * 6.5 + side * 2.2 + index) * 0.38) *
            (side === 1 ? 1 : 0.65)
          : 0;
        const passerbyWave =
          passerbyActor && side === 1
            ? 0.9 + Math.sin(elapsed * 9) * 0.25
            : 0;
        const rightWave =
          side === 1 ? (wave + hoverWave * 0.75) * 1.85 + passerbyWave : 0;
        actor.arms[side].rotation.x =
          -actor.sit * 0.8 -
          stride * 0.72 -
          (side === 1 ? sip * 1.05 : 0) -
          (side === 0 ? inspect * 0.75 : inspect * 0.45) +
          (typing + idleTyping) *
            Math.sin(elapsed * (12 + index * 0.5) + side * Math.PI + index) *
            0.22 -
          idleStretch * 1.35 -
          talkGesture -
          rightWave -
          cheer * 2.3;
        actor.arms[side].rotation.z =
          side === 1 && (wave > 0 || hoverWave > 0 || passerbyActor)
            ? Math.sin(elapsed * 11) * 0.32 * Math.max(wave, hoverWave, passerbyActor ? 0.7 : 0)
            : isChatting
              ? (side === 0 ? -1 : 1) * (0.15 + Math.sin(elapsed * 5 + side) * 0.12)
              : 0;
      }
      const hasCoffeeMug =
        ((routine.active === index && visit.kind === "coffee") ||
          (!!errand && actor.errandKind === "coffee")) &&
        (stage === "visiting" || stage === "returning");
      actor.mug.visible = hasCoffeeMug;
      actor.mug.position.set(
        0.45 - sip * 0.12,
        1.15 + sip * 0.43,
        0.28 + sip * 0.11,
      );
      actor.mug.rotation.x = -sip * 0.2;
      const targetRing = actor.selected
        ? 0.95
        : actor.hovered
          ? 0.78
          : actor.focused || isChatting
            ? 0.65
            : 0;
      actor.ringMaterial.opacity = reduced
        ? targetRing
        : damp(actor.ringMaterial.opacity, targetRing, 6, dt);
      screens[index * 2].emissiveIntensity = screens[
        index * 2 + 1
      ].emissiveIntensity = actor.focused
        ? 0.75
        : working
          ? 0.55
          : dark
            ? 0.42
            : 0.2;
      const realBubble = actor.bubbleUntil > elapsed;
      const hostReplyText =
        visitorActor && visitorActor.visitReply
          ? visitorActor.visitReply
          : "";
      const selectGreetText =
        crewSeen &&
        !working &&
        actor.selected &&
        actor.status === "idle" &&
        wave > 0.05
          ? GREETINGS[actor.member.id]
          : "";
      const ambientText = errand
        ? stage === "returning"
          ? ""
          : errand.say
        : hostReplyText
          ? hostReplyText
          : !working && routine.active === index
            ? stage === "outbound"
              ? visit.outbound
              : stage === "visiting"
                ? visit.visiting
                : "Back to my desk"
            : selectGreetText;
      // What someone says on a visit wins over their status bubble.
      const isAmbientSpeech =
        Boolean(errand && stage !== "returning") ||
        Boolean(hostReplyText) ||
        !realBubble;
      const text =
        errand && stage !== "returning"
          ? ambientText
          : hostReplyText
            ? hostReplyText
            : realBubble
              ? actor.activityText
              : ambientText;
      if (actor.bubble.textContent !== text) actor.bubble.textContent = text;
      for (const [key, value] of Object.entries({
        active: actor.focused || isChatting,
        working: working && atDesk,
        bubble: !!text,
        ambient: !!text && isAmbientSpeech,
        error: realBubble && actor.activityError,
        status: actor.status,
        selected: actor.selected,
        hovered: actor.hovered,
      })) {
        const next = String(value);
        if (actor.label.dataset[key] !== next) actor.label.dataset[key] = next;
      }
      const labelY = 1.62 - actor.sit * 0.18;
      if (
        labelsNeedLayout ||
        actor.projectedAt.x !== walker.position.x ||
        actor.projectedAt.z !== walker.position.z ||
        actor.projectedAt.y !== labelY
      ) {
        actor.projectedAt = { ...walker.position, y: labelY };
        projected
          .set(walker.position.x, labelY, walker.position.z)
          .project(camera);
        actor.label.style.transform = `translate3d(${(projected.x * 0.5 + 0.5) * width}px,${(-projected.y * 0.5 + 0.5) * height}px,0) translate(-50%,-100%)`;
        actor.label.style.visibility =
          projected.z > 1 ||
          Math.abs(projected.x) > 0.92 ||
          Math.abs(projected.y) > 0.88
            ? "hidden"
            : "visible";
      }
    });

    // Update the warm brass collaboration tethers on the floor between conversing peers
    collabBeams.forEach((beam, bIdx) => {
      const peer = !reduced ? activePeerVisitors[bIdx] : undefined;
      const hostActor = peer
        ? characters.find((item) => item.member.id === peer.visitTarget)
        : undefined;
      if (peer && hostActor) {
        const dx = hostActor.walker.position.x - peer.walker.position.x;
        const dz = hostActor.walker.position.z - peer.walker.position.z;
        const dist = Math.hypot(dx, dz);
        beam.mesh.visible = dist > 0.25;
        beam.mesh.position.set(
          (peer.walker.position.x + hostActor.walker.position.x) * 0.5,
          0.14,
          (peer.walker.position.z + hostActor.walker.position.z) * 0.5,
        );
        beam.mesh.rotation.z = -Math.atan2(dx, dz);
        beam.mesh.scale.set(1, Math.max(0.25, dist - 0.3), 1);
        beam.mat.opacity = 0.48 + Math.sin(elapsed * 5 + bIdx) * 0.15;
      } else {
        beam.mesh.visible = false;
      }
    });

    if (!reduced) {
      holoGyro.rotation.y = elapsed * 0.9;
      if (holoGyro.children[0]) holoGyro.children[0].rotation.x = elapsed * 1.3;
      if (holoGyro.children[1]) holoGyro.children[1].rotation.z = -elapsed * 1.1;
      if (holoGyro.children[2]) {
        holoGyro.children[2].position.y = Math.sin(elapsed * 2.6) * 0.06;
        holoGyro.children[2].rotation.y = -elapsed * 2.0;
      }
    }

    labelsNeedLayout = false;
    frameHook?.(elapsed, dt);
    renderer.render(scene, camera);
  }
  function frame(now: number) {
    const dt = previous ? Math.min((now - previous) / 1000, 0.05) : 0;
    previous = now;
    draw(dt);
  }
  function schedule() {
    previous = 0;
    renderer.setAnimationLoop(visible && !reduced && !disposed ? frame : null);
    draw(0);
  }
  resize();
  schedule();
  return {
    setActivity,
    setCrew,
    setSelected,
    visit(id, to, opts = {}) {
      const ok = startPeerVisit(id, to, opts);
      if (reduced || !previous) draw(0);
      return ok;
    },
    huddle() {
      const huddleLines = [
        "Syncing architecture in the Lounge",
        "Reviewing latency targets",
        "Aligning studio UI tokens",
        "All regression checks green",
      ];
      let spotIdx = 0;
      TEAM.forEach((member, idx) => {
        if (spotIdx >= DISCUSSION_SPOTS.length || idx === routine.active) return;
        const spot = DISCUSSION_SPOTS[spotIdx];
        const ok = sendOnErrand(routine, idx, {
          destination: spot,
          lookAt: DISCUSSION_CENTER,
          dwell: 6.5,
          say: huddleLines[spotIdx % huddleLines.length],
        });
        if (ok) {
          characters[idx].errandKind = "peer";
          characters[idx].visitTarget = member.id === "kern" ? "alan" : "kern";
          characters[idx].visitReply = huddleLines[spotIdx % huddleLines.length];
          spotIdx++;
        }
      });
      if (reduced || !previous) draw(0);
    },
    pairSync() {
      let launched = 0;
      for (let attempt = 0; attempt < PEER_CHATS.length && launched < 2; attempt++) {
        const chat = PEER_CHATS[(peerChatIndex + attempt) % PEER_CHATS.length];
        const fromIdx = TEAM.findIndex((m) => m.id === chat.from);
        const toIdx = TEAM.findIndex((m) => m.id === chat.to);
        if (fromIdx !== routine.active && toIdx !== routine.active) {
          if (
            startPeerVisit(chat.from, chat.to, {
              dwell: 5.8,
              say: chat.say,
              reply: chat.reply,
            })
          ) {
            launched++;
            peerChatIndex++;
          }
        }
      }
      if (reduced || !previous) draw(0);
    },
    emote(id, kind = "wave", text) {
      const index = TEAM.findIndex((m) => m.id === id);
      const actor = characters[index];
      if (!actor) return;
      if (kind === "coffee") {
        const coffeeVisit = OFFICE_VISITS[0];
        if (
          sendOnErrand(routine, index, {
            destination: coffeeVisit.destination,
            lookAt: coffeeVisit.lookAt,
            dwell: coffeeVisit.duration,
            say: text ?? "Brewing a fresh espresso in the Lounge",
          })
        ) {
          actor.errandKind = "coffee";
          actor.visitTarget = null;
        }
      } else if (kind === "server") {
        const serverVisit = OFFICE_VISITS[1];
        if (
          sendOnErrand(routine, index, {
            destination: serverVisit.destination,
            lookAt: serverVisit.lookAt,
            dwell: serverVisit.duration,
            say: text ?? "Auditing telemetry on the Ops racks",
          })
        ) {
          actor.errandKind = "server";
          actor.visitTarget = null;
        }
      } else if (kind === "cheer") {
        actor.cheerFrom = elapsed;
        actor.activityText = text ?? "Milestone verified — ready to ship!";
        actor.bubbleUntil = elapsed + 3.2;
      } else {
        actor.waveFrom = elapsed;
        actor.activityText = text ?? GREETINGS[id];
        actor.bubbleUntil = elapsed + 3.2;
      }
      if (reduced || !previous) draw(0);
    },
    recall(id) {
      endErrand(
        routine,
        TEAM.findIndex((m) => m.id === id),
      );
    },
    glideTo(x, z, zoomLevel) {
      framing.followId = null;
      framing.x = x;
      framing.z = z;
      framing.zoom = zoomLevel ?? framing.zoom;
      if (reduced || !previous) draw(0);
    },
    panBy(dx, dy) {
      // Screen pixels to world units; the screen's up axis meets the floor
      // at an angle, so its floor share is stretched back out.
      const unit = (camera.top - camera.bottom) / height;
      const e = camera.matrixWorld.elements;
      const upFloor = e[4] * e[4] + e[6] * e[6] || 1;
      framing.followId = null;
      framing.x += -e[0] * dx * unit + (e[4] * dy * unit) / upFloor;
      framing.z += -e[2] * dx * unit + (e[6] * dy * unit) / upFloor;
      // Follow the hand directly; gliding would make drags feel rubbery.
      focus.x = framing.x;
      focus.z = framing.z;
      frameCamera();
      if (reduced || !previous) draw(0);
    },
    zoomBy(factor) {
      framing.zoom = Math.min(
        homeZoom * 6,
        Math.max(homeZoom * 0.6, framing.zoom * factor),
      );
      zoom = framing.zoom;
      frameCamera();
      if (reduced || !previous) draw(0);
    },
    rotateBy(deltaYaw) {
      framing.yaw += deltaYaw;
      if (reduced) {
        yaw = framing.yaw;
        frameCamera();
      }
      if (reduced || !previous) draw(0);
    },
    resetView() {
      framing.followId = null;
      framing.x = homeFocus.x;
      framing.z = homeFocus.z;
      framing.zoom = homeZoom;
      framing.yaw = 0;
      if (reduced) {
        focus.x = homeFocus.x;
        focus.z = homeFocus.z;
        zoom = homeZoom;
        yaw = 0;
        frameCamera();
      }
      if (reduced || !previous) draw(0);
    },
    pickAt(x, y) {
      return findAgentAt(x, y);
    },
    hoverAt(x, y) {
      const hit = findAgentAt(x, y);
      let changed = false;
      for (const actor of characters) {
        const next = actor.member.id === hit;
        if (actor.hovered !== next) {
          actor.hovered = next;
          actor.label.dataset.hovered = String(next);
          changed = true;
        }
      }
      if (changed && (reduced || !previous)) draw(0);
      return hit;
    },
    focusOn(id, zoomLevel) {
      if (id) {
        framing.followId = id;
        framing.zoom = zoomLevel ?? homeZoom * 1.9;
      } else {
        framing.followId = null;
        framing.x = homeFocus.x;
        framing.z = homeFocus.z;
        framing.zoom = homeZoom;
      }
      if (reduced || !previous) draw(0);
    },
    stage: () => ({
      scene,
      camera,
      wallScreens,
      quotaScreens,
      positionOf(id) {
        const actor = characters.find((item) => item.member.id === id)!;
        return new THREE.Vector3(
          actor.walker.position.x,
          0,
          actor.walker.position.z,
        );
      },
      homeOf(id) {
        const member = TEAM.find((item) => item.id === id)!;
        return new THREE.Vector3(member.home.x, 0, member.home.z);
      },
      onFrame(callback) {
        frameHook = callback;
      },
    }),
    setWorking,
    setTheme,
    resize,
    setReducedMotion(value) {
      reduced = value;
      setRoutineReducedMotion(routine, value);
      labelsNeedLayout = true;
      if (reduced) {
        camera.position.copy(baseCamera);
        camera.lookAt(lookAt);
      }
      schedule();
      scheduleBubbleExpiry();
    },
    setVisible(value) {
      visible = value;
      schedule();
    },
    dispose() {
      disposed = true;
      clearTimeout(bubbleTimeout);
      renderer.setAnimationLoop(null);
      const allGeometry = new Set<THREE.BufferGeometry>([
        ...Object.values(geometry),
        ...baked,
      ]);
      const allMaterials = new Set<THREE.Material>(materials.values());
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          allGeometry.add(object.geometry);
          for (const mat of Array.isArray(object.material)
            ? object.material
            : [object.material])
            allMaterials.add(mat);
        }
      });
      allGeometry.forEach((item) => item.dispose());
      allMaterials.forEach((item) => item.dispose());
      paletteTexture.dispose();
      floorTexture.dispose();
      parsedGeometries.forEach((item) => item.dispose());
      sunlight.shadow.map?.dispose();
      renderer.dispose();
      labels.replaceChildren();
    },
  };
}

import * as THREE from "three";
import {
  DISCUSSION_CENTER,
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
    options?: { dwell?: number; say?: string },
  ): boolean;
  /** Send `id` back to their post now. */
  recall(id: AgentId): void;
  /** Glide the camera to follow a member, or back to the whole floor. */
  focusOn(id: AgentId | null, zoom?: number): void;
  /** Glide the camera to a floor point (and zoom), ending any follow. */
  glideTo(x: number, z: number, zoom?: number): void;
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
  // Building slab edge
  box(room, C.trim, [floorW + 0.4, 0.5, floorD + 0.4], [(W.minX + W.maxX) / 2, -0.29, (W.minZ + W.maxZ) / 2]);

  function roomFloor(r: (typeof ROOMS)[number]) {
    const w = r.maxX - r.minX,
      d = r.maxZ - r.minZ;
    if (r.floor === "carpet") {
      box(room, "#3b3446", [w, 0.03, d], [(r.minX + r.maxX) / 2, 0.005, (r.minZ + r.maxZ) / 2]);
      box(room, "#463d55", [w - 1.6, 0.035, d - 1.6], [(r.minX + r.maxX) / 2, 0.01, (r.minZ + r.maxZ) / 2]);
      return;
    }
    if (r.floor === "wood") {
      for (let x = 0; x < Math.round(w / 0.5); x++)
        for (let z = 0; z < Math.round(d / 1.6); z++)
          box(room, C.woodFloor[(x + z * 3) % 4], [0.495, 0.035, 1.57], [r.minX + 0.25 + x * 0.5, 0, r.minZ + 0.8 + z * 1.6]);
      return;
    }
    const palette = r.floor === "slate" ? C.serverFloor : C.tiles;
    const cols = Math.round(w / 0.92),
      rows = Math.round(d / 0.92);
    const step = w / cols,
      stepZ = d / rows;
    for (let col = 0; col < cols; col++)
      for (let row = 0; row < rows; row++)
        box(room, palette[(col + row) % palette.length], [step - 0.03, 0.025, stepZ - 0.03], [r.minX + step / 2 + col * step, 0.012, r.minZ + stepZ / 2 + row * stepZ]);
  }
  ROOMS.forEach(roomFloor);

  // Walls. Exterior north/west walls are tall with windows; interior ones are
  // a low wainscot under glass so neighbouring rooms stay visible.
  const isExterior = (w: (typeof WALLS)[number]) =>
    (w.z1 === w.z2 && w.z1 === -15) || (w.x1 === w.x2 && w.x1 === -21);
  function skyline(centerX: number, z: number, width: number) {
    const pane = box(room, C.skyNight, [width, 1.7, 0.06], [centerX, 2.15, z + 0.12], false, 0.3);
    pane.castShadow = false;
    const n = Math.floor(width / 0.46);
    for (let building = 0; building < n; building++) {
      const h = 0.5 + ((building * 7 + Math.round(centerX * 3)) % 7) * 0.13;
      const bx = centerX - width / 2 + 0.25 + building * 0.46;
      box(room, C.city[building % 3], [0.4, h, 0.035], [bx, 1.32 + h / 2, z + 0.16]);
      for (let row = 0; row < Math.floor(h / 0.2) - 1; row++)
        for (let col = 0; col < 3; col++)
          if ((row * 3 + col + building) % 4 !== 0)
            box(room, (row + building) % 5 === 0 ? C.windowWarm : C.windowCool, [0.055, 0.045, 0.018], [bx - 0.12 + col * 0.12, 1.45 + row * 0.2, z + 0.185], false, 0.55);
    }
    for (const y of [1.3, 3.02]) box(room, C.trim, [width + 0.1, 0.09, 0.2], [centerX, y, z + 0.18]);
    box(room, C.metal, [width + 0.2, 0.1, 0.36], [centerX, 1.26, z + 0.28]);
  }
  const skyMaterial = material(C.skyNight, 0.3);
  for (const w of WALLS) {
    const horizontal = w.z1 === w.z2;
    const len = Math.hypot(w.x2 - w.x1, w.z2 - w.z1);
    const cx = (w.x1 + w.x2) / 2,
      cz = (w.z1 + w.z2) / 2;
    const exterior = isExterior(w);
    const tall = w.height > 1;
    const h = exterior ? 3.4 : tall ? 1.05 : w.height;
    const size: [number, number, number] = horizontal ? [len + 0.22, h, 0.22] : [0.22, h, len + 0.22];
    box(room, exterior ? C.wall : "#2c2832", size, [cx, h / 2, cz]);
    box(room, C.trim, horizontal ? [len + 0.26, 0.08, 0.3] : [0.3, 0.08, len + 0.26], [cx, h + 0.04, cz]);
    if (!exterior && tall) {
      glass(horizontal ? [len, 1.35, 0.03] : [0.03, 1.35, len], [cx, h + 0.75, cz]);
      box(room, C.metal, horizontal ? [len + 0.1, 0.06, 0.08] : [0.08, 0.06, len + 0.1], [cx, h + 1.45, cz]);
      for (let i = 0; i <= Math.floor(len / 2); i++) {
        const t = len < 0.5 ? 0.5 : i / Math.max(1, Math.floor(len / 2));
        const px = w.x1 + (w.x2 - w.x1) * t,
          pz = w.z1 + (w.z2 - w.z1) * t;
        box(room, C.metal, [0.07, 1.45, 0.07], [px, h + 0.72, pz]);
      }
    }
    if (exterior && horizontal) {
      // Windows on the north façade, between pillars.
      for (let x = Math.min(w.x1, w.x2) + 2; x + 2 <= Math.max(w.x1, w.x2); x += 4) skyline(x + 1, cz, 3.2);
    }
  }
  // Accent strip above each room's tall walls, in the owner's colour.
  for (const r of ROOMS)
    if (r.walls) {
      box(room, r.accent, [r.maxX - r.minX, 0.05, 0.04], [(r.minX + r.maxX) / 2, r.minZ === -15 ? 3.25 : 0.98, r.minZ + 0.13], false, 1.6);
    }

  // Floor signs, drawn on canvas: they keep their texture, so they are not baked.
  for (const r of ROOMS) {
    const canvas2 = document.createElement("canvas");
    canvas2.width = 512;
    canvas2.height = 96;
    const g = canvas2.getContext("2d");
    if (!g) continue;
    g.font = "600 54px ui-monospace, Menlo, monospace";
    g.fillStyle = r.accent;
    g.globalAlpha = 0.85;
    g.fillText(r.name.toUpperCase(), 12, 66);
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

  // Box-built furniture kinds plus the voxel models.
  function serverRack(parent: THREE.Object3D) {
    box(parent, C.serverBody, [1.24, 2.4, 0.85], [0, 1.2, 0]);
    box(parent, C.trim, [1.08, 2.2, 0.03], [0, 1.2, 0.44]);
    for (let slot = 0; slot < 7; slot++) {
      box(parent, C.metal, [0.96, 0.18, 0.045], [0, 0.38 + slot * 0.29, 0.47]);
      for (let led = 0; led < 5; led++)
        box(parent, led % 3 ? C.serverGreen : C.cyan, [0.045, 0.038, 0.018], [-0.36 + led * 0.12, 0.38 + slot * 0.29, 0.5], false, 1.3);
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
          for (let book = 0; book < Math.floor(sx / 0.19); book++)
            if ((book * 7 + shelf * 3) % 9 !== 0)
              box(group, C.books[(book + shelf) % 4], [0.14, 0.3 + ((book + shelf) % 3) * 0.06, 0.32], [-sx / 2 + 0.15 + book * 0.19, y + 0.2, 0.06]);
        }
        break;
      }
      case "rack":
        serverRack(group);
        break;
      case "bench": {
        box(group, C.metal, [sx, 0.08, sz], [0, 0.95, 0]);
        box(group, C.trim, [sx - 0.2, 0.85, sz - 0.2], [0, 0.45, 0]);
        // device grid under test
        for (let i = 0; i < 4; i++) {
          box(group, C.trim, [0.42, 0.62, 0.05], [-sx / 2 + 0.5 + i * 0.66, 1.3, -0.2]);
          const pane = box(group, i % 2 ? C.serverGreen : C.screen, [0.34, 0.52, 0.01], [-sx / 2 + 0.5 + i * 0.66, 1.3, -0.17], false, 0.6);
          pane.castShadow = false;
        }
        break;
      }
      case "counter": {
        box(group, C.woodDark, [sx, sy, sz], [0, sy / 2, 0]);
        box(group, C.wood, [sx + 0.1, 0.08, sz + 0.1], [0, sy + 0.04, 0]);
        for (let door = 0; door < Math.floor(sx / 0.96); door++)
          box(group, C.wood, [0.86, 0.8, 0.04], [-sx / 2 + 0.5 + door * 0.96, 0.5, -sz / 2 - 0.01]);
        for (const x of [-1.4, -0.9]) voxelModel(group, "office_mug", [x, sy + 0.06, 0], 0, 0.75);
        break;
      }
      case "desk": {
        voxelModel(group, "office_table_desk", [0, 0, 0], 0, 0.85);
        voxelModel(group, "office_pc", [0, 0.88, -0.1], 0, 0.6);
        break;
      }
      case "rug":
        box(group, "#22303a", [sx, 0.02, sz], [0, 0.03, 0]);
        box(group, C.cyan, [sx - 0.3, 0.022, 0.05], [0, 0.035, -sz / 2 + 0.2], false, 0.6);
        box(group, C.cyan, [sx - 0.3, 0.022, 0.05], [0, 0.035, sz / 2 - 0.2], false, 0.6);
        break;
    }
  }

  const screens: THREE.MeshStandardMaterial[] = [];
  function monitor(
    parent: THREE.Object3D,
    x: number,
    z: number,
    accent: string,
  ) {
    box(parent, C.trim, [0.76, 0.5, 0.065], [x, 1.49, z]);
    const screen = box(
      parent,
      C.screen,
      [0.67, 0.405, 0.01],
      [x, 1.49, z + 0.04],
      false,
      0.35,
    );
    // Each screen has its own material: activity brightness belongs to one agent.
    screen.material = screen.material.clone();
    box(parent, C.metal, [0.055, 0.2, 0.055], [x, 1.16, z]);
    box(parent, C.trim, [0.34, 0.035, 0.23], [x, 1.075, z + 0.05]);
    for (let line = 0; line < 7; line++)
      box(
        parent,
        line % 3 ? C.code : accent,
        [0.18 + (line % 4) * 0.09, 0.013, 0.008],
        [x - 0.12 + (line % 2) * 0.05, 1.62 - line * 0.043, z + 0.05],
        false,
        0.5,
      );
    return screen.material;
  }
  function officeChair(
    parent: THREE.Object3D,
    x: number,
    z: number,
    angle = 0,
    scale = 1,
  ) {
    const chair = new THREE.Group();
    chair.position.set(x, 0, z);
    chair.rotation.y = angle;
    chair.scale.setScalar(scale);
    parent.add(chair);
    box(chair, C.chair, [0.66, 0.13, 0.58], [0, 0.48, 0.04]);
    box(chair, C.trim, [0.7, 0.66, 0.13], [0, 0.9, 0.37]);
    box(chair, C.chair, [0.62, 0.58, 0.06], [0, 0.92, 0.285]);
    box(chair, C.metal, [0.08, 0.3, 0.08], [0, 0.25, 0.04]);
    for (const side of [-1, 1]) {
      box(chair, C.trim, [0.06, 0.25, 0.06], [side * 0.36, 0.58, 0.1]);
      box(chair, C.chair, [0.09, 0.065, 0.4], [side * 0.36, 0.72, 0.06]);
    }
    for (let spoke = 0; spoke < 5; spoke++) {
      const angle = (spoke * Math.PI * 2) / 5;
      const arm = box(
        chair,
        C.trim,
        [0.055, 0.045, 0.36],
        [Math.sin(angle) * 0.16, 0.12, 0.04 + Math.cos(angle) * 0.16],
      );
      arm.rotation.y = angle;
      box(
        chair,
        C.trim,
        [0.09, 0.09, 0.11],
        [Math.sin(angle) * 0.32, 0.06, 0.04 + Math.cos(angle) * 0.32],
      );
    }
  }
  // Each post is built facing −z in local space, then turned to its facing.
  for (const member of TEAM) {
    const station = new THREE.Group();
    station.position.set(member.home.x, 0, member.home.z);
    station.rotation.y = facingOf(member) - Math.PI;
    room.add(station);
    const x = 0;
    if (member.post === "lead") {
      const deskZ = -0.95;
      box(station, C.wood, [2.7, 0.12, 1.15], [x, 1.0, deskZ]);
      box(station, C.woodEdge, [2.7, 0.045, 1.15], [x, 0.92, deskZ]);
      for (const dx of [-1.2, 1.2])
        for (const dz of [-0.44, 0.44])
          box(
            station,
            C.woodDark,
            [0.1, 0.92, 0.1],
            [x + dx, 0.46, deskZ + dz],
          );
      screens.push(monitor(station, x - 0.46, deskZ - 0.23, member.color));
      screens.push(monitor(station, x + 0.36, deskZ - 0.23, member.color));
      box(station, C.trim, [0.9, 0.06, 0.32], [x, 1.1, deskZ + 0.22]);
      for (let row = 0; row < 4; row++)
        for (let key = 0; key < 12; key++)
          box(
            station,
            C.key,
            [0.052, 0.012, 0.045],
            [x - 0.39 + key * 0.069, 1.138, deskZ + 0.12 + row * 0.065],
          );
      box(
        station,
        C.mousePad,
        [0.42, 0.014, 0.37],
        [x + 0.79, 1.065, deskZ + 0.22],
      );
      box(station, C.metal, [0.14, 0.06, 0.2], [x + 0.79, 1.1, deskZ + 0.21]);
      box(station, C.serverBody, [0.38, 0.7, 0.7], [x + 0.98, 0.36, deskZ]);
      box(
        station,
        member.color,
        [0.025, 0.36, 0.025],
        [x + 0.85, 0.4, deskZ + 0.36],
        false,
        0.75,
      );
      voxelModel(
        station,
        "office_mug",
        [x - 1.05, 1.06, deskZ + 0.15],
        0.5,
        0.65,
      );
      // desk lamp
      box(station, C.woodDark, [0.28, 0.035, 0.28], [x + 1.06, 1.08, deskZ]);
      box(station, C.amber, [0.045, 0.4, 0.045], [x + 1.06, 1.29, deskZ]);
      shape(
        station,
        "cylinder",
        C.lamp,
        [0.2, 0.27, 0.2],
        [x + 1.06, 1.56, deskZ],
        0.8,
      );
      officeChair(station, x, 0.1);
    } else {
      // Standing console: low enough that the operator stays visible behind it.
      const consoleZ = -0.62;
      box(station, C.serverBody, [1.2, 0.6, 0.32], [x, 0.3, consoleZ]);
      const top = box(station, C.metal, [1.3, 0.06, 0.5], [x, 0.66, consoleZ]);
      top.rotation.x = 0.22;
      box(
        station,
        member.color,
        [1.2, 0.035, 0.03],
        [x, 0.52, consoleZ - 0.175],
        false,
        0.9,
      );
      // two small tilted panes on the console top, lit by activity
      for (const dx of [-0.31, 0.31]) {
        const pane = box(
          station,
          C.screen,
          [0.5, 0.02, 0.3],
          [x + dx, 0.705, consoleZ + 0.02],
          false,
          0.35,
        );
        pane.rotation.x = 0.22;
        pane.material = (pane.material as THREE.MeshStandardMaterial).clone();
        screens.push(pane.material as THREE.MeshStandardMaterial);
      }
      box(station, C.trim, [1.26, 0.05, 0.05], [x, 0.05, consoleZ - 0.16]);
    }
  }

  // Video wall at the north edge of the hub: one live panel per helper.
  const wallZ = VIDEO_WALL.z;
  const helpers = TEAM.filter((member) => member.post === "console");
  const panelStep = 1.95;
  const wallWidth = helpers.length * panelStep;
  const wallCenter = 0;
  const panelX = (index: number) =>
    wallCenter - wallWidth / 2 + panelStep / 2 + index * panelStep;
  box(room, C.trim, [wallWidth + 0.3, 1.75, 0.22], [wallCenter, 2.25, wallZ]);
  for (const y of [1.34, 3.16])
    box(room, C.metal, [wallWidth + 0.3, 0.08, 0.3], [wallCenter, y, wallZ + 0.04]);
  for (const x of [wallCenter - wallWidth / 2 - 0.1, wallCenter + wallWidth / 2 + 0.1])
    box(room, C.metal, [0.14, 3.5, 0.14], [x, 1.75, wallZ - 0.05]);
  box(room, C.cyan, [wallWidth + 0.3, 0.04, 0.04], [wallCenter, 3.22, wallZ + 0.14], false, 1.8);
  const wallScreens = {} as Record<AgentId, THREE.Mesh>;
  helpers.forEach((member, index) => {
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.72, 1.5),
      new THREE.MeshBasicMaterial({ color: "#0d1c24", toneMapped: false }),
    );
    panel.position.set(panelX(index), 2.25, wallZ + 0.115);
    panel.name = `wall-${member.id}`;
    scene.add(panel);
    wallScreens[member.id] = panel;
  });

  // A small wooden break table furnishes the pantry corner.
  const { x: tableX, z: tableZ } = DISCUSSION_CENTER;
  box(room, C.wood, [2.05, 0.1, 1.55], [tableX, 0.88, tableZ]);
  for (const dx of [-0.86, 0.86])
    for (const dz of [-0.59, 0.59])
      box(room, C.woodDark, [0.1, 0.84, 0.1], [tableX + dx, 0.42, tableZ + dz]);
  for (const dz of [-1.3, 1.3])
    for (const dx of [-0.6, 0.6])
      officeChair(room, tableX + dx, tableZ + dz, dz < 0 ? Math.PI : 0, 0.8);
  voxelModel(room, "office_mug", [tableX - 0.55, 0.94, tableZ], 0, 0.65);

  // The lead desk lamp and a cool wash on the video wall carry the amber / cyan balance.
  {
    const lead = TEAM.find((member) => member.post === "lead")!;
    const lamp = new THREE.PointLight(C.amber, 9, 4, 2);
    const f = facingOf(lead) - Math.PI;
    lamp.position.set(
      lead.home.x + Math.cos(f) * 1.06 + Math.sin(f) * -0.95,
      1.7,
      lead.home.z - Math.sin(f) * 1.06 + Math.cos(f) * -0.95,
    );
    scene.add(lamp);
    const wash = new THREE.PointLight(C.cyan, 10, 7, 2);
    wash.position.set(wallCenter, 3.2, wallZ + 1.6);
    scene.add(wash);
  }
  const ambient = new THREE.HemisphereLight(C.ambient, C.woodDark, 1.15);
  scene.add(ambient);
  const sunlight = new THREE.DirectionalLight(C.moon, 1.8);
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
  const fill = new THREE.DirectionalLight(C.cyan, 0.6);
  fill.position.set(-5, 5, -5);
  scene.add(fill);
  // One coloured practical per room keeps each space readable from afar.
  for (const r of ROOMS) {
    const light = new THREE.PointLight(r.accent, 22, 11, 2);
    light.position.set((r.minX + r.maxX) / 2, 2.8, (r.minZ + r.maxZ) / 2);
    scene.add(light);
  }

  // Bake static transforms into material batches: the room stays inexpensive to draw.
  room.updateMatrixWorld(true);
  const batches = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const staticColors = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 1,
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
      new THREE.RingGeometry(0.5, 0.55, 4),
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
      sit: 1,
      shadowAnchored: true as boolean | null,
      projectedAt: { x: NaN, z: NaN, y: NaN },
      focused: false,
      bubbleUntil: 0,
      activityText: "",
      activityError: false,
      status: "idle" as SceneCrew["members"][number]["status"],
      cheerFrom: -Infinity,
      shakeFrom: -Infinity,
      selected: false,
    };
  }
  const characters = TEAM.map(character);
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
  // Current and target framing; focusOn() glides between them.
  const focus = { ...homeFocus };
  let zoom = homeZoom;
  const framing = {
    x: homeFocus.x,
    z: homeFocus.z,
    zoom: homeZoom,
    followId: null as AgentId | null,
  };
  const lookAt = new THREE.Vector3(focus.x, 1.25, focus.z);
  let labelsNeedLayout = true;
  let workAmount = 0;

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
    // Same view direction; shifted with the focus point.
    baseCamera.set(17 + focus.x - 0.8, 16, 21 + focus.z - 0.7);
    camera.position.copy(baseCamera);
    camera.lookAt(lookAt);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    labelsNeedLayout = true;
  }
  function setTheme(value: boolean) {
    dark = value;
    scene.background = new THREE.Color(dark ? C.night : C.day);
    ambient.intensity = dark ? 1.05 : 2.0;
    sunlight.intensity = dark ? 1.5 : 3.1;
    sunlight.color.set(dark ? C.moon : C.daylight);
    fill.intensity = dark ? 0.55 : 0.8;
    skyMaterial.color.set(dark ? C.skyNight : C.skyDay);
    skyMaterial.emissive.set(dark ? C.skyNight : C.skyDay);
    renderer.toneMappingExposure = dark ? 0.95 : 1.1;
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
  let crewSeen = false;
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
      actor.selected = actor.member.id === id;
    });
    if (reduced || !previous) draw(0);
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
    characters.forEach((actor, index) => {
      actor.sit = reduced
        ? actor.member.post === "lead"
          ? 1
          : 0
        : damp(
            actor.sit,
            routine.stages[index] === "desk" && actor.member.post === "lead"
              ? 1
              : 0,
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
      Math.abs(zoom - framing.zoom) > 0.001
    ) {
      // Long moves pull back a little mid-flight, like a crane shot.
      const far = Math.hypot(framing.x - focus.x, framing.z - focus.z);
      const travelZoom = framing.zoom / (1 + far / 16);
      focus.x += (framing.x - focus.x) * (dt ? k : 1);
      focus.z += (framing.z - focus.z) * (dt ? k : 1);
      zoom += ((dt ? travelZoom : framing.zoom) - zoom) * (dt ? Math.min(1, k * 1.4) : 1);
      frameCamera();
    }
    characters.forEach((actor, index) => {
      const { walker } = actor;
      const stage = routine.stages[index];
      const atDesk = stage === "desk";
      const errand = routine.errands[index];
      const visiting =
        stage === "visiting" && (routine.active === index || !!errand);
      const visit = OFFICE_VISITS[routine.visit];
      const walking = stage === "outbound" || stage === "returning";
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
      // Animate rigid GLBs as well as fallback limbs; their arms are not rigged.
      const phase = elapsed * (4.1 + index * 0.17) + index * 1.7;
      const breathe = reduced ? 0 : Math.sin(elapsed * 1.8 + index) * 0.009;
      // Seated at the lead desk or standing at a console, both type at their post.
      const typing = workAmount * (atDesk ? 1 : 0);
      const pace = walking && !reduced ? Math.min(1, walker.speed / 1.25) : 0;
      const gait = walker.distance * 8.5;
      const sip =
        visiting && !errand && visit.kind === "coffee"
          ? Math.sin(Math.PI * (1 - routine.dwelling / visit.duration))
          : 0;
      const inspect =
        visiting && !errand && visit.kind === "server"
          ? Math.sin(Math.PI * (1 - routine.dwelling / visit.duration))
          : 0;
      const cheer = reduced ? 0 : envelope(actor.cheerFrom, 2.2);
      const shake = reduced ? 0 : envelope(actor.shakeFrom, 1.4);
      actor.body.position.y =
        -actor.sit * 0.24 +
        (cheer
          ? Math.abs(Math.sin((elapsed - actor.cheerFrom) * 8)) * 0.11 * cheer
          : 0) +
        breathe +
        typing * Math.sin(phase) * 0.008 +
        Math.abs(Math.sin(gait)) * 0.035 * pace;
      actor.body.rotation.x =
        typing * (0.035 + Math.sin(phase) * 0.012) -
        sip * 0.045 +
        inspect * 0.08;
      actor.body.rotation.z =
        typing * Math.sin(phase * 0.6) * 0.008 +
        Math.sin(gait) * 0.03 * pace +
        Math.sin(elapsed * 30) * 0.05 * shake;
      actor.body.rotation.y = reduced
        ? 0
        : typing *
            Math.sin(elapsed * 0.65 + index) *
            (actor.focused ? 0.12 : 0.035) +
          inspect * Math.sin(elapsed * 1.2) * 0.16;
      actor.head.rotation.y = reduced
        ? 0
        : Math.sin(elapsed * 0.65 + index * 2) * (working ? 0.025 : 0.09) +
          Math.sin(elapsed * 26) * 0.38 * shake;
      for (let side = 0; side < 2; side++) {
        const stride = Math.sin(gait + side * Math.PI) * pace;
        actor.legs[side].rotation.x =
          -actor.sit * 1.23 + stride * 0.55 * (1 - actor.sit);
        actor.knees[side].rotation.x =
          actor.sit * 1.38 + Math.max(0, -stride) * 0.65 * (1 - actor.sit);
        actor.arms[side].rotation.x =
          -actor.sit * 0.8 -
          stride * 0.42 -
          (side === 1 ? sip * 0.8 : 0) +
          typing *
            Math.sin(elapsed * (9 + index * 0.4) + side * 1.8 + index) *
            0.07 -
          cheer * 2.3;
      }
      actor.mug.visible =
        routine.active === index &&
        visit.kind === "coffee" &&
        (stage === "visiting" || stage === "returning");
      actor.mug.position.set(
        0.45 - sip * 0.12,
        1.15 + sip * 0.43,
        0.28 + sip * 0.11,
      );
      actor.mug.rotation.x = -sip * 0.2;
      actor.ringMaterial.opacity = reduced
        ? actor.selected
          ? 0.95
          : actor.focused
            ? 0.65
            : 0
        : damp(
            actor.ringMaterial.opacity,
            actor.selected ? 0.95 : actor.focused ? 0.65 : 0,
            6,
            dt,
          );
      screens[index * 2].emissiveIntensity = screens[
        index * 2 + 1
      ].emissiveIntensity = actor.focused
        ? 0.7
        : working
          ? 0.55
          : dark
            ? 0.4
            : 0.18;
      const realBubble = actor.bubbleUntil > elapsed;
      const ambientText = errand
        ? stage === "returning"
          ? ""
          : errand.say
        : !working && routine.active === index
          ? stage === "outbound"
            ? visit.outbound
            : stage === "visiting"
              ? visit.visiting
              : "Back to my desk"
          : "";
      // What someone says on a visit wins over their status bubble.
      const text =
        errand && stage !== "returning"
          ? ambientText
          : realBubble
            ? actor.activityText
            : ambientText;
      if (actor.bubble.textContent !== text) actor.bubble.textContent = text;
      for (const [key, value] of Object.entries({
        active: actor.focused,
        working: working && atDesk,
        bubble: !!text,
        error: realBubble && actor.activityError,
        status: actor.status,
        selected: actor.selected,
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
          projected.z > 1 || Math.abs(projected.x) > 0.98
            ? "hidden"
            : "visible";
      }
    });
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
      const index = TEAM.findIndex((m) => m.id === id);
      const host = TEAM.find((m) => m.id === to)!;
      const f = facingOf(host);
      // Stand across the host's desk/console, facing them.
      const reach = host.post === "lead" ? 2.4 : 1.65;
      const destination = {
        x: host.home.x + Math.sin(f) * reach,
        z: host.home.z + Math.cos(f) * reach,
      };
      const ok = sendOnErrand(routine, index, {
        destination,
        lookAt: host.home,
        dwell: opts.dwell ?? 3,
        say: opts.say ?? `Checking with ${host.name}`,
      });
      if (reduced || !previous) draw(0);
      return ok;
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

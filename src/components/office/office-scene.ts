import * as THREE from "three";
import {
  DISCUSSION_CENTER,
  OFFICE_VISITS,
  STUDIO_COLORS,
} from "./office-layout";
import { createVoxelCharacter } from "./voxel-character";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { VOXEL_MODELS, OFFICE_PALETTE_BASE64 } from "./office-voxel-models";
import { TEAM, damp, type Activity } from "./office-motion";
import {
  advanceOfficeRoutine,
  createOfficeRoutine,
  setRoutineReducedMotion,
  setRoutineWorking,
} from "./office-routine";

export interface OfficeScene {
  setActivity(activity: Activity): void;
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

  // Hallmark · component: night studio · reference: user screenshot
  // pre-emit critique: P4 H4 E4 S5 R4 V4
  // Continue the parquet beyond the desks so the studio fills the viewport.
  // One tiled plane avoids thousands of extra floor meshes on wide screens.
  const floorPixels = new Uint8Array(128 * 128 * 4);
  const floorColors = C.woodFloor.map((value) =>
    new THREE.Color(value).convertLinearToSRGB(),
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
      // DataTexture with SRGBColorSpace expects sRGB byte values.
      floorPixels[at] = Math.round(color.r * 255);
      floorPixels[at + 1] = Math.round(color.g * 255);
      floorPixels[at + 2] = Math.round(color.b * 255);
      floorPixels[at + 3] = 255;
    }
  const floorTexture = new THREE.DataTexture(floorPixels, 128, 128);
  floorTexture.colorSpace = THREE.SRGBColorSpace;
  floorTexture.wrapS = floorTexture.wrapT = THREE.RepeatWrapping;
  floorTexture.repeat.set(48, 30);
  floorTexture.magFilter = THREE.LinearFilter;
  floorTexture.minFilter = THREE.LinearMipmapLinearFilter;
  floorTexture.generateMipmaps = true;
  floorTexture.needsUpdate = true;
  const continuousFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(96, 96),
    new THREE.MeshStandardMaterial({ map: floorTexture, roughness: 1 }),
  );
  continuousFloor.rotation.x = -Math.PI / 2;
  continuousFloor.position.set(38.85, -0.025, 41.75);
  room.add(continuousFloor);
  for (let x = 0; x < 36; x++) {
    for (let z = 0; z < 8; z++) {
      box(
        room,
        C.woodFloor[(x + z * 3) % 4],
        [0.495, 0.035, 1.57],
        [-8.75 + x * 0.5, 0, -5.6 + z * 1.6],
      );
    }
  }
  function tileZone(x: number, z: number, columns: number, rows: number) {
    for (let col = 0; col < columns; col++)
      for (let row = 0; row < rows; row++)
        box(
          room,
          C.tiles[(col + row) % 3],
          [0.89, 0.025, 0.89],
          [x + col * 0.92, 0.025, z + row * 0.92],
        );
  }
  tileZone(-8.55, -0.7, 5, 8);
  tileZone(-2.0, -2.9, 12, 3);
  tileZone(-2.0, 2.0, 12, 4);

  // Two low cutaway walls, coloured charcoal-plum against the midnight city.
  box(room, C.wall, [48, 8, 0.22], [14.8, 4, -6.25]);
  box(room, C.wall, [0.22, 8, 48], [-9.15, 4, 17.7]);
  box(room, C.trim, [48, 0.16, 0.16], [14.8, 0.15, -6.08]);
  box(room, C.trim, [0.16, 0.16, 48], [-9.0, 0.15, 17.7]);
  box(room, C.trim, [48, 0.18, 0.3], [14.8, 5.52, -6.22]);
  box(room, C.trim, [0.3, 0.18, 48], [-9.15, 5.52, 17.7]);
  box(room, C.cyan, [0.04, 0.055, 48], [-9.0, 5.15, 17.7], false, 2.5);
  box(room, C.amber, [48, 0.055, 0.04], [14.8, 5.15, -6.1], false, 2.5);

  // Window panels: separate buildings and lit windows keep the skyline legible.
  const skyMaterial = material(C.skyNight, 0.3);
  for (const centerX of [0.0, 3.5, 7.0]) {
    const pane = box(
      room,
      C.skyNight,
      [2.85, 3.35, 0.06],
      [centerX, 3.1, -6.09],
      false,
      0.3,
    );
    pane.castShadow = false;
    for (let building = 0; building < 6; building++) {
      const h = 1.1 + ((building * 7 + Math.round(centerX * 2)) % 9) * 0.19;
      const bx = centerX - 1.17 + building * 0.46;
      box(
        room,
        C.city[building % 3],
        [0.4, h, 0.035],
        [bx, 1.46 + h / 2, -6.035],
      );
      for (let row = 0; row < Math.floor(h / 0.21) - 1; row++)
        for (let col = 0; col < 3; col++)
          if ((row * 3 + col + building) % 4 !== 0)
            box(
              room,
              (row + building) % 5 === 0 ? C.windowWarm : C.windowCool,
              [0.055, 0.045, 0.018],
              [bx - 0.12 + col * 0.12, 1.62 + row * 0.21, -6.009],
              false,
              0.55,
            );
    }
    for (const dx of [-1.48, 1.48])
      box(room, C.trim, [0.09, 3.55, 0.18], [centerX + dx, 3.1, -5.96]);
    for (const y of [1.34, 4.86])
      box(room, C.trim, [3.04, 0.09, 0.18], [centerX, y, -5.96]);
    box(room, C.metal, [3.15, 0.1, 0.38], [centerX, 1.3, -5.87]);
  }

  // Glass server room occupies the rear-left corner. Glass is kept out of opaque batches.
  const glassGroup = new THREE.Group();
  scene.add(glassGroup);
  const glassMaterial = new THREE.MeshStandardMaterial({
    color: C.glass,
    transparent: true,
    opacity: 0.13,
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
  for (let col = 0; col < 7; col++)
    for (let row = 0; row < 3; row++)
      box(
        room,
        C.serverFloor[(col + row) % 2],
        [0.88, 0.04, 0.98],
        [-7.85 + col * 0.9, 0.035, -5.5 + row],
      );
  for (const x of [-7.75, -6.2, -4.65, -3.1]) {
    box(room, C.serverBody, [1.24, 3.9, 0.85], [x, 2, -5.35]);
    box(room, C.trim, [1.08, 3.64, 0.03], [x, 2.0, -4.9]);
    for (let slot = 0; slot < 12; slot++) {
      box(room, C.metal, [0.96, 0.18, 0.045], [x, 0.38 + slot * 0.28, -4.86]);
      for (let led = 0; led < 5; led++)
        box(
          room,
          led % 3 ? C.serverGreen : C.cyan,
          [0.045, 0.038, 0.018],
          [x - 0.36 + led * 0.12, 0.38 + slot * 0.28, -4.83],
          false,
          1.3,
        );
      box(
        room,
        C.serverBody,
        [0.21, 0.038, 0.02],
        [x + 0.32, 0.38 + slot * 0.28, -4.825],
      );
    }
  }
  // Sliding glass doorway on the left; the aisle in front stays open.
  for (const x of [-8.35, -6.7, -5.05, -3.4, -1.75])
    box(room, C.metal, [0.065, 4.7, 0.12], [x, 2.35, -2.75]);
  for (const y of [0.09, 4.68])
    box(room, C.metal, [6.7, 0.08, 0.14], [-5.05, y, -2.75]);
  for (const x of [-7.525, -5.875, -4.225, -2.575]) {
    glass([1.55, 4.5, 0.025], [x, 2.35, -2.75]);
    box(
      room,
      C.glassEdge,
      [0.025, 4.4, 0.025],
      [x + 0.7, 2.35, -2.7],
      false,
      0.45,
    );
  }
  glass([0.025, 4.5, 3.2], [-1.75, 2.35, -4.4]);
  box(room, C.metal, [0.08, 0.08, 3.4], [-1.75, 4.68, -4.4]);
  box(room, C.metal, [0.045, 0.55, 0.08], [-7.0, 2.0, -2.65]);
  box(room, C.cyan, [6.3, 0.04, 0.04], [-5.1, 4.5, -5.96], false, 1.8);

  // Pantry on the left wall: cupboards, sink, warm coffee machine and open shelves.
  const pantry = new THREE.Group();
  pantry.position.set(-8.45, 0, 2.0);
  pantry.rotation.y = Math.PI / 2;
  room.add(pantry);
  box(pantry, C.woodDark, [5.8, 1.0, 0.85], [0, 0.5, 0]);
  box(pantry, C.wood, [6.0, 0.1, 1.05], [0, 1.05, 0]);
  for (let door = 0; door < 6; door++) {
    box(pantry, C.wood, [0.88, 0.79, 0.04], [-2.4 + door * 0.96, 0.5, 0.45]);
    box(pantry, C.metal, [0.045, 0.21, 0.05], [-2.1 + door * 0.96, 0.67, 0.49]);
  }
  box(pantry, C.metal, [1.12, 0.05, 0.72], [1.85, 1.12, 0]);
  box(pantry, C.serverBody, [0.8, 0.055, 0.47], [1.85, 1.13, 0]);
  box(pantry, C.silver, [0.07, 0.44, 0.07], [1.85, 1.34, -0.3]);
  box(pantry, C.silver, [0.07, 0.07, 0.28], [1.85, 1.53, -0.19]);
  voxelModel(pantry, "office_coffee_machine", [-0.95, 1.1, 0], 0, 1.0);
  box(pantry, C.amber, [0.42, 0.25, 0.035], [-0.95, 1.46, 0.32], false, 1.2);
  for (const x of [-2.3, 0.2, 0.65, 2.65])
    voxelModel(pantry, "office_mug", [x, 1.11, 0.13], 0, 0.75);
  for (const y of [2.0, 2.95]) {
    box(pantry, C.wood, [4.8, 0.1, 0.5], [0.0, y, -0.16]);
    for (let book = 0; book < 6; book++)
      box(
        pantry,
        C.books[book % 4],
        [0.14, 0.3 + (book % 3) * 0.06, 0.23],
        [-1.65 + book * 0.19, y + 0.2, -0.16],
      );
    voxelModel(pantry, "office_plant_big", [1.6, y + 0.05, -0.16], 0, 0.65);
  }
  voxelModel(room, "office_plant_tall", [-7.2, 0, -1.6], 0, 1.15);
  voxelModel(room, "office_plant_big", [8.3, 0, 5.65], 0.8, 1.0);

  // Framed studio art is geometric, with no generated UI or fake window chrome.
  for (const z of [-0.8, 4.7]) {
    box(room, C.trim, [0.1, 1.18, 0.86], [-8.98, 3.85, z]);
    box(room, C.art, [0.12, 0.99, 0.67], [-8.96, 3.85, z]);
    for (let line = 0; line < 5; line++)
      box(
        room,
        C.books[line % 4],
        [0.025, 0.055, 0.25 + (line % 3) * 0.1],
        [-8.88, 3.56 + line * 0.14, z],
        false,
        0.15,
      );
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
  for (const member of TEAM) {
    const { x, z } = member.home;
    const deskZ = z - 0.95;
    const station = new THREE.Group();
    room.add(station);
    box(station, C.wood, [2.7, 0.12, 1.15], [x, 1.0, deskZ]);
    box(station, C.woodEdge, [2.7, 0.045, 1.15], [x, 0.92, deskZ]);
    for (const dx of [-1.2, 1.2])
      for (const dz of [-0.44, 0.44])
        box(station, C.woodDark, [0.1, 0.92, 0.1], [x + dx, 0.46, deskZ + dz]);
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
    officeChair(station, x, z + 0.1);
  }

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

  // Practical desk lamps and architectural strips carry the amber / cyan balance.
  for (const z of [-2.55, 1.95]) {
    const x = 2.4;
    box(room, C.woodDark, [0.28, 0.035, 0.28], [x + 1.06, 1.08, z]);
    box(room, C.amber, [0.045, 0.4, 0.045], [x + 1.06, 1.29, z]);
    shape(room, "cylinder", C.lamp, [0.2, 0.27, 0.2], [x + 1.06, 1.56, z], 0.8);
    const lamp = new THREE.PointLight(C.amber, 9, 4, 2);
    lamp.position.set(x + 1.06, 1.7, z);
    scene.add(lamp);
  }
  const ambient = new THREE.HemisphereLight(C.ambient, C.woodDark, 1.1);
  scene.add(ambient);
  const sunlight = new THREE.DirectionalLight(C.moon, 1.8);
  sunlight.position.set(3, 10, 4);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(1024, 1024);
  Object.assign(sunlight.shadow.camera, {
    left: -14,
    right: 14,
    top: 12,
    bottom: -12,
    near: 0.5,
    far: 40,
  });
  sunlight.shadow.bias = 0.001;
  sunlight.shadow.normalBias = 0.05;
  scene.add(sunlight);
  const fill = new THREE.DirectionalLight(C.cyan, 0.6);
  fill.position.set(-5, 5, -5);
  scene.add(fill);
  const warm = new THREE.PointLight(C.amber, 28, 10, 2);
  warm.position.set(-7.5, 2.4, 1.8);
  scene.add(warm);
  const serverLight = new THREE.PointLight(C.cyan, 18, 8, 2);
  serverLight.position.set(-5, 3.5, -3.7);
  scene.add(serverLight);

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
    labels.append(label);
    root.position.set(member.home.x, 0, member.home.z);
    root.rotation.y = Math.PI;
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
  const lookAt = new THREE.Vector3(0.8, 1.25, 0.7);
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
    const aspect = width / height;
    const halfHeight = Math.max(6.3, 9.5 / aspect);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    baseCamera.set(17, 16, 21);
    camera.position.copy(baseCamera);
    camera.lookAt(lookAt);
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    labelsNeedLayout = true;
    draw(0);
  }
  function setTheme(value: boolean) {
    dark = value;
    scene.background = new THREE.Color(dark ? C.night : C.day);
    ambient.intensity = dark ? 1.05 : 2.0;
    sunlight.intensity = dark ? 1.5 : 3.1;
    sunlight.color.set(dark ? C.moon : C.daylight);
    fill.intensity = dark ? 0.55 : 0.8;
    warm.intensity = dark ? 28 : 10;
    serverLight.intensity = dark ? 18 : 8;
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

  function draw(dt: number) {
    if (disposed || !visible) return;
    elapsed += dt;
    const targetWork = working && !reduced ? 1 : 0;
    workAmount = reduced ? 0 : damp(workAmount, targetWork, 8, dt);
    if (Math.abs(workAmount - targetWork) < 0.001) workAmount = targetWork;
    characters.forEach((actor, index) => {
      actor.sit = reduced
        ? 1
        : damp(actor.sit, routine.stages[index] === "desk" ? 1 : 0, 8, dt);
      if (actor.sit < 0.001) actor.sit = 0;
      if (actor.sit > 0.999) actor.sit = 1;
    });
    advanceOfficeRoutine(
      routine,
      dt,
      characters.map((actor) => actor.sit < 0.12),
    );
    characters.forEach((actor, index) => {
      const { walker } = actor;
      const stage = routine.stages[index];
      const atDesk = stage === "desk";
      const visiting = routine.active === index && stage === "visiting";
      const visit = OFFICE_VISITS[routine.visit];
      const walking = stage === "outbound" || stage === "returning";
      if (atDesk || visiting) {
        const heading = atDesk
          ? Math.PI
          : Math.atan2(
              visit.lookAt.x - walker.position.x,
              visit.lookAt.z - walker.position.z,
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
      const typing = workAmount * actor.sit;
      const pace = walking && !reduced ? Math.min(1, walker.speed / 1.25) : 0;
      const gait = walker.distance * 8.5;
      const sip =
        visiting && visit.kind === "coffee"
          ? Math.sin(Math.PI * (1 - routine.dwelling / visit.duration))
          : 0;
      const inspect =
        visiting && visit.kind === "server"
          ? Math.sin(Math.PI * (1 - routine.dwelling / visit.duration))
          : 0;
      actor.body.position.y =
        -actor.sit * 0.24 +
        breathe +
        typing * Math.sin(phase) * 0.008 +
        Math.abs(Math.sin(gait)) * 0.035 * pace;
      actor.body.rotation.x =
        typing * (0.035 + Math.sin(phase) * 0.012) -
        sip * 0.045 +
        inspect * 0.08;
      actor.body.rotation.z =
        typing * Math.sin(phase * 0.6) * 0.008 + Math.sin(gait) * 0.03 * pace;
      actor.body.rotation.y = reduced
        ? 0
        : typing *
            Math.sin(elapsed * 0.65 + index) *
            (actor.focused ? 0.12 : 0.035) +
          inspect * Math.sin(elapsed * 1.2) * 0.16;
      actor.head.rotation.y = reduced
        ? 0
        : Math.sin(elapsed * 0.65 + index * 2) * (working ? 0.025 : 0.09);
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
            0.07;
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
        ? actor.focused
          ? 0.65
          : 0
        : damp(actor.ringMaterial.opacity, actor.focused ? 0.65 : 0, 6, dt);
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
      const ambientText =
        !working && routine.active === index
          ? stage === "outbound"
            ? visit.outbound
            : stage === "visiting"
              ? visit.visiting
              : "Back to my desk"
          : "";
      const text = realBubble ? actor.activityText : ambientText;
      if (actor.bubble.textContent !== text) actor.bubble.textContent = text;
      for (const [key, value] of Object.entries({
        active: actor.focused,
        working: working && atDesk,
        bubble: !!text,
        error: realBubble && actor.activityError,
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

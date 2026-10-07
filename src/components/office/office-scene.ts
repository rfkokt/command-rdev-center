import * as THREE from "three";
import {
  DISCUSSION_SPOTS,
  DISCUSSION_CENTER,
  STUDIO_COLORS,
} from "./office-layout";
import { createVoxelCharacter } from "./voxel-character";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { VOXEL_MODELS, OFFICE_PALETTE_BASE64 } from "./office-voxel-models";
import {
  TEAM,
  advanceWalkers,
  routeWalkersTo,
  aisleRoute,
  createWalker,
  damp,
  type Activity,
} from "./office-motion";

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
  renderer.setPixelRatio(
    Math.min(1.5, Math.max(1, window.devicePixelRatio || 1)),
  );
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
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
  // A finite cutaway floor, with timber circulation and tiled work / pantry zones.
  box(room, C.edge, [18.4, 0.3, 12.8], [0, -0.18, 0]);
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
  box(room, C.wall, [18.4, 5.5, 0.22], [0, 2.75, -6.25]);
  box(room, C.wall, [0.22, 5.5, 12.8], [-9.15, 2.75, 0]);
  box(room, C.trim, [18.25, 0.16, 0.16], [0, 0.15, -6.08]);
  box(room, C.trim, [0.16, 0.16, 12.5], [-9.0, 0.15, 0]);
  box(room, C.trim, [18.4, 0.18, 0.3], [0, 5.52, -6.22]);
  box(room, C.trim, [0.3, 0.18, 12.8], [-9.15, 5.52, 0]);
  box(room, C.cyan, [0.04, 0.055, 12.2], [-9.0, 5.15, 0], false, 2.5);
  box(room, C.amber, [17.9, 0.055, 0.04], [0, 5.15, -6.1], false, 2.5);

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

  // A small wooden break table provides the prompt discussion destination.
  const discussionSpots = DISCUSSION_SPOTS;
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
  room.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const transformed = (
      object.geometry.index
        ? object.geometry.toNonIndexed()
        : object.geometry.clone()
    ).applyMatrix4(object.matrixWorld);
    const batch = batches.get(object.material) ?? [];
    batch.push(transformed);
    batches.set(object.material, batch);
  });
  room.clear();
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
    room.add(mesh);
  });

  function character(member: (typeof TEAM)[number]) {
    const { root, body, head, arms, legs, knees } = createVoxelCharacter(
      member.id,
      () =>
        queueMicrotask(() => {
          if (!disposed) draw(0);
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
    ring.position.y = 0.045;
    root.add(ring);
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
    const walker = createWalker(member.home);
    root.position.set(member.home.x, 0, member.home.z);
    root.rotation.y = Math.PI;
    walker.heading = root.rotation.y;
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
      label,
      bubble,
      walker,
      focused: false,
      sit: 1,
      idle: 14 + TEAM.indexOf(member) * 9,
      bubbleUntil: 0,
      excursion: false,
    };
  }
  const characters = TEAM.map(character);
  let reduced = false,
    visible = true,
    disposed = false,
    dark = true,
    working = false,
    discussionActive = false;
  let bubbleTimeout: ReturnType<typeof setTimeout> | undefined;
  const discussionTimeouts: ReturnType<typeof setTimeout>[] = [];
  let elapsed = 0,
    previous = 0,
    width = 1,
    height = 1;
  const cameraOffset = 0;
  const projected = new THREE.Vector3();
  const pointer = new THREE.Vector2();
  const baseCamera = new THREE.Vector3();
  const lookAt = new THREE.Vector3(cameraOffset, 1.3, 0);

  function resize() {
    width = Math.max(1, canvas.parentElement?.clientWidth || 1);
    height = Math.max(1, canvas.parentElement?.clientHeight || 1);
    // Keep the voxel geometry crisp while rendering at a stable native canvas
    // size. Half-resolution rasterization made the floor shimmer during resize
    // and pointer parallax.
    renderer.setSize(Math.ceil(width), Math.ceil(height), false);
    const aspect = width / height;
    const halfHeight = Math.max(8.1, 12.3 / aspect);
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    baseCamera.set(17, 16, 21);
    camera.position.copy(baseCamera);
    camera.lookAt(lookAt);
    camera.updateProjectionMatrix();
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
    draw(0);
  }
  function setWorking(value: boolean) {
    working = value;
    if (working && !discussionActive) startDiscussion();
    if (!working) endDiscussion();
    if (!working)
      characters.forEach((actor) => {
        actor.focused = false;
      });
    else if (!characters.some((actor) => actor.focused))
      characters.find((actor) => actor.member.id === "kern")!.focused = true;
    if (reduced || !previous) draw(0);
  }
  function routeHome(actor: (typeof characters)[number]) {
    actor.walker.route = aisleRoute(actor.walker.position, actor.member.home);
    actor.excursion = false;
  }
  function startDiscussion() {
    discussionActive = true;
    routeWalkersTo(
      characters.map((actor) => actor.walker),
      discussionSpots,
    );
    characters.forEach((actor) => {
      actor.excursion = false;
    });
  }
  function endDiscussion() {
    if (!discussionActive) return;
    discussionActive = false;
    characters.forEach(routeHome);
  }
  function setActivity(activity: Activity) {
    clearTimeout(bubbleTimeout);
    if (activity.discussion && activity.working) {
      discussionTimeouts.splice(0).forEach((timeout) => clearTimeout(timeout));
      startDiscussion();
    } else if (activity.working) {
      // Thinking and tool events are still part of the same live briefing.
      // Drop only the scripted fallback bubbles; real agent events now drive
      // the active speaker while the team remains gathered.
      discussionTimeouts.splice(0).forEach((timeout) => clearTimeout(timeout));
      if (!discussionActive) startDiscussion();
    } else {
      discussionTimeouts.splice(0).forEach((timeout) => clearTimeout(timeout));
      endDiscussion();
    }
    working = activity.working;
    characters.forEach((actor) => {
      actor.focused = activity.working && actor.member.id === activity.id;
      if (actor.member.id === activity.id) {
        const text = activity.text.replace(/\s+/g, " ").trim();
        actor.bubble.textContent =
          text.length > 58 ? `${text.slice(0, 57)}…` : text;
        actor.bubbleUntil = elapsed + (activity.working ? 8 : 3.5);
        actor.label.dataset.error = String(!!activity.error);
      } else {
        actor.bubbleUntil = 0;
      }
    });
    if (reduced || !previous) draw(0);
    scheduleBubbleExpiry();
    if (activity.discussion && activity.working) scheduleDiscussion();
  }

  function scheduleDiscussion() {
    // This is a visual choreography layered on top of existing agent events.
    // Tool routing still comes from activityFor(), so the app's behavior stays unchanged.
    const steps: Array<{
      delay: number;
      id: (typeof TEAM)[number]["id"];
      text: string;
    }> = [
      { delay: 520, id: "ada", text: "I’ll shape the interface." },
      { delay: 1120, id: "alan", text: "I’ll trace the code path." },
      { delay: 1720, id: "linus", text: "I’m checking the implementation." },
      { delay: 2320, id: "kern", text: "Team aligned. Executing." },
    ];
    steps.forEach(({ delay, id, text }) => {
      const timeout = setTimeout(
        () => {
          if (disposed || !working) return;
          characters.forEach((actor) => {
            actor.focused = actor.member.id === id;
            actor.bubbleUntil =
              actor.member.id === id ? elapsed + 6 : actor.bubbleUntil;
            if (actor.member.id === id) actor.bubble.textContent = text;
          });
          draw(0);
        },
        reduced ? 0 : delay,
      );
      discussionTimeouts.push(timeout);
    });
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
    if (!reduced && dt) {
      camera.position.x = damp(
        camera.position.x,
        baseCamera.x + pointer.x * 0.25,
        2,
        dt,
      );
      camera.position.y = damp(
        camera.position.y,
        baseCamera.y - pointer.y * 0.12,
        2,
        dt,
      );
      camera.lookAt(lookAt);
    }
    camera.updateMatrixWorld();
    if (!reduced)
      characters.forEach((actor, index) => {
        const { walker, member } = actor;

        // One visitor at a time, routed through the aisle; tasks recall them to work.
        if (!working && !walker.route.length) {
          actor.idle -= dt;
          if (
            actor.idle <= 0 &&
            !characters.some((other) => other.walker.route.length)
          ) {
            const destination = actor.excursion
              ? member.home
              : {
                  x: member.home.x + (member.home.x > 0 ? -1.25 : 1.25),
                  z: member.home.z + 1.25,
                };
            walker.route = aisleRoute(walker.position, destination);
            actor.excursion = !actor.excursion;
            actor.idle = actor.excursion ? 4 : 24 + index * 5;
          }
        }
        const atHome =
          Math.hypot(
            walker.position.x - member.home.x,
            walker.position.z - member.home.z,
          ) < 0.06 && !walker.route.length;
        actor.sit = damp(actor.sit, atHome ? 1 : 0, 7, dt);
      });
    if (!reduced)
      advanceWalkers(
        characters.map((actor) => actor.walker),
        dt,
        characters.map(
          (actor) => actor.sit < 0.12 || !actor.walker.route.length,
        ),
      );
    characters.forEach((actor, index) => {
      const { walker, member } = actor;
      if (!reduced) {
        const atHome =
          Math.hypot(
            walker.position.x - member.home.x,
            walker.position.z - member.home.z,
          ) < 0.06 && !walker.route.length;
        if (atHome || (discussionActive && !walker.route.length)) {
          const target = discussionActive
            ? DISCUSSION_CENTER
            : {
                x: member.home.x,
                z: member.home.z - 1,
              };
          const targetHeading = discussionActive
            ? Math.atan2(
                target.x - walker.position.x,
                target.z - walker.position.z,
              )
            : Math.PI;
          const turn = Math.atan2(
            Math.sin(targetHeading - walker.heading),
            Math.cos(targetHeading - walker.heading),
          );
          walker.heading += turn * (1 - Math.exp(-5 * dt));
        }
      }
      actor.root.position.set(walker.position.x, 0, walker.position.z);
      actor.root.rotation.y = walker.heading;
      const pace = reduced ? 0 : Math.min(1, walker.speed / 1.25);
      const gait = walker.distance * 8.5;
      const breathe = reduced ? 0 : Math.sin(elapsed * 1.8 + index) * 0.009;
      actor.body.position.y =
        -actor.sit * 0.24 + Math.abs(Math.sin(gait)) * 0.033 * pace + breathe;
      actor.body.rotation.z = reduced ? 0 : Math.sin(gait) * 0.025 * pace;
      actor.head.rotation.y = reduced
        ? 0
        : Math.sin(elapsed * 0.65 + index * 2) * 0.09 * (1 - pace);
      for (let side = 0; side < 2; side++) {
        const stride = Math.sin(gait + side * Math.PI) * pace;
        actor.legs[side].rotation.x =
          -actor.sit * 1.23 + stride * 0.55 * (1 - actor.sit);
        actor.knees[side].rotation.x =
          actor.sit * 1.38 + Math.max(0, -stride) * 0.65 * (1 - actor.sit);
        const typing =
          !reduced && actor.focused
            ? Math.sin(elapsed * 9 + side * 1.8) * 0.07
            : 0;
        actor.arms[side].rotation.x = -actor.sit * 0.8 - stride * 0.42 + typing;
      }
      actor.ringMaterial.opacity = reduced
        ? actor.focused
          ? 0.65
          : 0
        : damp(actor.ringMaterial.opacity, actor.focused ? 0.65 : 0, 6, dt);
      screens[index * 2].emissiveIntensity = screens[
        index * 2 + 1
      ].emissiveIntensity = actor.focused ? 0.7 : dark ? 0.4 : 0.18;
      actor.label.dataset.active = String(actor.focused);
      actor.label.dataset.bubble = String(actor.bubbleUntil > elapsed);
      projected
        .set(walker.position.x, 1.62 - actor.sit * 0.18, walker.position.z)
        .project(camera);
      actor.label.style.transform = `translate3d(${(projected.x * 0.5 + 0.5) * width}px,${(-projected.y * 0.5 + 0.5) * height}px,0) translate(-50%,-100%)`;
      actor.label.style.visibility =
        projected.z > 1 || Math.abs(projected.x) > 0.98 ? "hidden" : "visible";
    });
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
  const move = (event: PointerEvent) => {
    if (reduced || event.pointerType === "touch") return;
    const bounds = canvas.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    pointer.set(
      THREE.MathUtils.clamp(
        (event.clientX - bounds.left) / bounds.width - 0.5,
        -0.5,
        0.5,
      ),
      THREE.MathUtils.clamp(
        (event.clientY - bounds.top) / bounds.height - 0.5,
        -0.5,
        0.5,
      ),
    );
  };
  window.addEventListener("pointermove", move, { passive: true });
  resize();
  schedule();
  return {
    setActivity,
    setWorking,
    setTheme,
    resize,
    setReducedMotion(value) {
      reduced = value;
      if (reduced) {
        camera.position.copy(baseCamera);
        camera.lookAt(lookAt);
        characters.forEach((actor) => {
          actor.walker.route = [];
          actor.walker.position = { ...actor.member.home };
          actor.walker.speed = 0;
          actor.walker.heading = Math.PI;
          actor.sit = 1;
          actor.excursion = false;
        });
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
      discussionTimeouts.splice(0).forEach((timeout) => clearTimeout(timeout));
      renderer.setAnimationLoop(null);
      window.removeEventListener("pointermove", move);
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
      parsedGeometries.forEach((item) => item.dispose());
      sunlight.shadow.map?.dispose();
      renderer.dispose();
      labels.replaceChildren();
    },
  };
}

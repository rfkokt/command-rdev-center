import * as THREE from "three";
import { createVoxelCharacter } from "./voxel-character";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  VOXEL_MODELS,
  OFFICE_PALETTE_BASE64,
} from "./office-voxel-models";
import {
  TEAM,
  advanceWalker,
  aisleRoute,
  createWalker,
  damp,
  type Activity,
  type Point,
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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#18252c");
  const camera = new THREE.PerspectiveCamera(43, 1, 0.1, 90);
  const room = new THREE.Group();
  scene.add(room);
  const geometry = {
    box: new THREE.BoxGeometry(1, 1, 1),
    round: new THREE.BoxGeometry(1, 1, 1),
    ball: new THREE.BoxGeometry(2, 2, 2),
    cylinder: new THREE.BoxGeometry(2, 1, 2),
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
    paletteTexture.needsUpdate = true;
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

  // Continuous architecture, wood boards, skirting and a recessed acoustic wall.
  box(room, "#81715c", [60, 0.3, 60], [20.8, -0.17, 23.8]);
  for (let i = 0; i < 66; i++) {
    for (let j = 0; j < 10; j++) {
      box(
        room,
        ["#aa8964", "#b2936e", "#a78b6b", "#b79a76"][(i + j * 3) % 4],
        [0.576, 0.028, 3.08],
        [-8.85 + i * 0.59, 0, -4.66 + j * 3.1],
      );
    }
  }
  box(room, "#d3c9b7", [60, 30, 0.24], [20.8, 14.9, -6.2]);
  box(room, "#315354", [0.25, 30, 60], [-9.2, 14.9, 23.8]);
  box(room, "#444c44", [60, 0.14, 0.12], [20.8, 0.14, -6.02]);
  box(room, "#263e3c", [0.12, 0.14, 60], [-9.02, 0.14, 23.8]);
  box(room, "#294c4d", [5.4, 3.65, 0.16], [-5.95, 2.2, -6.01]);
  for (let i = 0; i < 24; i++)
    box(room, "#446663", [0.055, 3.65, 0.1], [-8.5 + i * 0.22, 2.2, -5.89]);

  // Large glazed windows with actual recesses, mullions and a quiet skyline.
  const skyMaterial = material("#8cb8c9", 0.4);
  const sky = box(
    room,
    "#8cb8c9",
    [10.7, 3.55, 0.08],
    [2.4, 3.1, -6.04],
    false,
    0.4,
  );
  sky.castShadow = false;
  for (let i = 0; i < 18; i++) {
    const h = 0.35 + ((i * 7) % 11) * 0.095;
    box(
      room,
      i % 2 ? "#78959c" : "#698990",
      [0.46, h, 0.03],
      [-2.45 + i * 0.57, 1.38 + h / 2, -5.97],
    );
  }
  for (let i = 0; i < 5; i++)
    box(room, "#303d3f", [0.07, 3.7, 0.2], [-3.0 + i * 2.68, 3.1, -5.87]);
  for (const y of [1.25, 3.55, 4.94])
    box(room, "#303d3f", [10.85, 0.075, 0.2], [2.36, y, -5.87]);
  box(room, "#e0d4bf", [11.1, 0.12, 0.48], [2.35, 1.21, -5.8]);

  // A warm studio lounge on the left with voxel couch and coffee table.
  box(room, "#53635e", [3.2, 0.045, 4.0], [-6.75, 0.04, 0.95], true);
  voxelModel(room, "office_couch", [-7.4, 0, 0.95], Math.PI / 2, 1.1);
  voxelModel(room, "office_coffee_table", [-6.1, 0, 0.95], Math.PI / 2, 1.0);
  voxelModel(room, "office_mug", [-6.1, 0.5, 0.8], 0.4, 0.9);
  voxelModel(room, "office_papers", [-6.1, 0.5, 1.2], -0.2, 0.9);

  // Shelving and decor on the back wall.
  box(room, "#b08356", [2.1, 0.12, 0.48], [-6.0, 3.25, -5.62]);
  for (let i = 0; i < 8; i++)
    box(
      room,
      ["#bb755f", "#789894", "#d2bc8d"][i % 3],
      [0.14, 0.32 + (i % 3) * 0.07, 0.25],
      [-6.8 + i * 0.17, 3.52, -5.62],
    );

  // Voxel potted plants in corners and along perimeter.
  voxelModel(room, "office_plant_tall", [-8.2, 0, -4.95], 0, 1.15);
  voxelModel(room, "office_plant_big", [8.0, 0, -5.1], 0.8, 1.3);
  voxelModel(room, "office_plant_tall", [8.2, 0, 4.8], 1.5, 1.1);
  voxelModel(room, "office_plant_big", [-8.3, 0, 4.8], 2.2, 1.25);

  // Office storage, server rack, printer, and coffee station.
  voxelModel(room, "office_cabinet", [5.8, 0, -5.45], 0, 1.1);
  voxelModel(room, "office_printer", [4.6, 0, -5.45], 0, 1.0);
  voxelModel(room, "office_trashcan", [7.0, 0, -5.45], 0, 1.1);
  voxelModel(room, "office_corkboard", [-6.0, 1.8, -5.9], 0, 1.1);

  // Server rack on the left wall with active LED indicators.
  box(room, "#253c41", [1.25, 2.45, 0.8], [-8.2, 1.23, -2.8], true);
  for (let i = 0; i < 7; i++) {
    box(room, "#40575b", [1.02, 0.22, 0.04], [-8.2, 0.4 + i * 0.29, -2.37]);
    box(
      room,
      "#7cc9aa",
      [0.06, 0.035, 0.045],
      [-7.79, 0.4 + i * 0.29, -2.33],
      false,
      1.2,
    );
  }
  // Coffee machine nook next to server rack.
  box(room, "#4b5d59", [0.9, 0.9, 0.7], [-8.2, 0.45, -1.7], true);
  voxelModel(room, "office_coffee_machine", [-8.2, 0.9, -1.7], Math.PI / 2, 0.85);

  // Whiteboard along the back corridor.
  voxelModel(room, "office_whiteboard", [-1.5, 0, -5.85], 0, 1.25);

  const screens: THREE.MeshStandardMaterial[] = [];
  for (const member of TEAM) {
    const { x, z } = member.home;
    const station = new THREE.Group();
    room.add(station);
    if (z > 0) {
      station.position.set(2 * x, 0, 2 * z);
      station.rotation.y = Math.PI;
    }
    const deskZ = z - 0.9;
    // 3D Voxel desk from pack (scale 0.83 gives width ~2.65m matching layout).
    voxelModel(station, "office_table_desk", [x, 0, deskZ], 0, 0.83);

    // Voxel PC setup (tower, monitor, keyboard) on desk.
    voxelModel(station, "office_pc", [x, 0.91, deskZ], 0, 0.9);

    // Dedicated emissive screen mesh for specialist color glow and editor activity.
    const screen = box(
      station,
      member.color,
      [0.64, 0.38, 0.015],
      [x, 1.44, deskZ - 0.16],
      false,
      0.32,
    );
    screens.push(screen.material);

    // Code/editor lines on screen.
    for (let line = 0; line < 5; line++) {
      box(
        station,
        line % 3 ? "#c5e0d4" : "#f3d1a4",
        [0.22 + (line % 3) * 0.09, 0.016, 0.005],
        [x - 0.08 + (line % 2) * 0.06, 1.54 - line * 0.052, deskZ - 0.15],
        false,
        0.35,
      );
    }

    // Desk accessories: mug and documents.
    voxelModel(station, "office_mug", [x + 0.9, 0.91, deskZ + 0.15], 0.5, 0.85);
    voxelModel(station, "office_papers", [x - 0.85, 0.91, deskZ + 0.15], -0.2, 0.85);

    // Voxel ergonomic office chair positioned at specialist station.
    voxelModel(station, "office_chair", [x, 0, z + 0.1], 0, 0.82);
  }

  // A shared briefing spot in the open right wing gives the team a visible place
  // to gather and discuss without being covered by the central chat messages UI.
  const discussionSpots = [
    { x: 4.8, z: -0.9 },
    { x: 6.8, z: -0.9 },
    { x: 7.8, z: 0.6 },
    { x: 3.8, z: 0.6 },
    { x: 4.8, z: 2.1 },
    { x: 6.8, z: 2.1 },
  ] as const;
  // Central corridor runner keeps the middle grounded now that the briefing table moved right.
  box(room, "#3e4d4d", [2.6, 0.02, 4.2], [0, 0.02, 0.1], true);

  // Briefing area rug, voxel meeting table, and briefing chairs.
  box(room, "#4a5960", [4.8, 0.06, 3.6], [5.8, 0.035, 0.6], true);
  voxelModel(room, "office_meeting_table", [5.8, 0, 0.6], 0, 0.72);
  voxelModel(room, "office_papers", [5.4, 0.79, 0.6], 0.3, 0.9);
  voxelModel(room, "office_mug", [6.2, 0.79, 0.6], -0.8, 0.9);

  // Meeting chairs arranged around the briefing table facing inward.
  discussionSpots.forEach((spot) => {
    const angle = Math.atan2(5.8 - spot.x, 0.6 - spot.z);
    voxelModel(room, "office_chair_white", [spot.x, 0, spot.z], angle + Math.PI, 0.68);
  });
  // Pendant fixtures, balanced daylight and warm practical illumination.
  for (const x of [-4.9, 0.6, 5.8]) {
    box(room, "#334342", [0.025, 0.75, 0.025], [x, 5.05, -0.4]);
    box(room, "#344744", [3.0, 0.12, 0.32], [x, 4.64, -0.4], true);
    box(room, "#ffe1a7", [2.8, 0.025, 0.25], [x, 4.56, -0.4], false, 1.8);
  }
  const ambient = new THREE.HemisphereLight("#d7e9ee", "#897054", 2.1);
  scene.add(ambient);
  const sunlight = new THREE.DirectionalLight("#ffe5bc", 3.4);
  sunlight.position.set(3, 10, 4);
  sunlight.castShadow = true;
  sunlight.shadow.mapSize.set(1024, 1024);
  Object.assign(sunlight.shadow.camera, {
    left: -12,
    right: 12,
    top: 10,
    bottom: -10,
    near: 0.5,
    far: 35,
  });
  sunlight.shadow.bias = 0.001;
  sunlight.shadow.normalBias = 0.05;
  scene.add(sunlight);
  const fill = new THREE.DirectionalLight("#a2c4d6", 1.2);
  fill.position.set(-5, 5, -5);
  scene.add(fill);
  const warm = new THREE.PointLight("#ffc477", 38, 14, 2);
  warm.position.set(5.8, 4, 0.6);
  scene.add(warm);

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
    root.rotation.y = member.home.z < 0 ? Math.PI : 0;
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
  const cameraOffset = -1.6;
  const projected = new THREE.Vector3();
  const pointer = new THREE.Vector2();
  const baseCamera = new THREE.Vector3();
  const lookAt = new THREE.Vector3(cameraOffset, 1.25, -0.5);

  function resize() {
    width = Math.max(1, canvas.parentElement?.clientWidth || 1);
    height = Math.max(1, canvas.parentElement?.clientHeight || 1);
    // Keep the voxel geometry crisp while rendering at a stable native canvas
    // size. Half-resolution rasterization made the floor shimmer during resize
    // and pointer parallax.
    renderer.setSize(Math.ceil(width), Math.ceil(height), false);
    camera.aspect = width / height;
    // Narrow panes pull back instead of cropping specialists out of the room.
    const distance = Math.max(1, 1.55 / camera.aspect);
    baseCamera.set(
      (9.8 + cameraOffset) * distance,
      7.7 * distance,
      13.5 * distance,
    );
    camera.position.copy(baseCamera);
    camera.lookAt(lookAt);
    camera.updateProjectionMatrix();
    draw(0);
  }
  function setTheme(value: boolean) {
    dark = value;
    scene.background = new THREE.Color(dark ? "#18252c" : "#cbd4cc");
    ambient.intensity = dark ? 1.15 : 2.1;
    sunlight.intensity = dark ? 1.65 : 3.4;
    sunlight.color.set(dark ? "#b6cce8" : "#ffe5bc");
    fill.intensity = dark ? 0.65 : 1.2;
    warm.intensity = dark ? 55 : 25;
    skyMaterial.color.set(dark ? "#355c78" : "#8cb8c9");
    skyMaterial.emissive.set(dark ? "#355c78" : "#8cb8c9");
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
  function routeLength(route: Point[], start: Point): number {
    let dist = 0;
    let prev = start;
    for (const pt of route) {
      dist += Math.hypot(pt.x - prev.x, pt.z - prev.z);
      prev = pt;
    }
    return dist;
  }
  function startDiscussion() {
    discussionActive = true;
    const remainingActors = [...characters];
    const availableSpots = [...discussionSpots];
    while (remainingActors.length > 0 && availableSpots.length > 0) {
      let bestA = 0;
      let bestS = 0;
      let minDistance = Infinity;
      for (let a = 0; a < remainingActors.length; a++) {
        const pos = remainingActors[a].walker.position;
        for (let s = 0; s < availableSpots.length; s++) {
          const r = aisleRoute(pos, availableSpots[s]);
          const d = routeLength(r, pos);
          if (d < minDistance) {
            minDistance = d;
            bestA = a;
            bestS = s;
          }
        }
      }
      const [actor] = remainingActors.splice(bestA, 1);
      const [spot] = availableSpots.splice(bestS, 1);
      actor.walker.route = aisleRoute(actor.walker.position, spot);
      actor.excursion = false;
    }
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
    characters.forEach((actor, index) => {
      const { walker, member } = actor;
      if (!reduced) {
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
                  z: member.home.z < 0 ? -1.15 : 1.35,
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

        if (actor.sit < 0.12 || !walker.route.length) {
          advanceWalker(walker, dt);
        }

        // Mutual collision repulsion: if two characters are too close while en-route, gently push them apart laterally
        // so they don't clip. Repulsion is disabled near the destination so characters can arrive cleanly at their spots.
        if (walker.route.length > 0) {
          const finalTarget = walker.route[walker.route.length - 1];
          const distToFinal = Math.hypot(
            walker.position.x - finalTarget.x,
            walker.position.z - finalTarget.z,
          );
          // Only push apart while en-route, not when settling into designated spots
          if (distToFinal > 0.45) {
            const MIN_DIST = 0.85;
            for (let o = 0; o < characters.length; o++) {
              if (o === index) continue;
              const other = characters[o];
              const dx = walker.position.x - other.walker.position.x;
              const dz = walker.position.z - other.walker.position.z;
              const dist = Math.hypot(dx, dz);
              if (dist > 0.001 && dist < MIN_DIST) {
                const overlap = MIN_DIST - dist;
                const pushFactor = other.walker.route.length === 0 ? 0.5 : 0.35;
                walker.position.x += (dx / dist) * overlap * pushFactor * Math.min(1, dt * 8);
                walker.position.z += (dz / dist) * overlap * pushFactor * Math.min(1, dt * 8);
              }
            }
          }
        }

        if (atHome || (discussionActive && !walker.route.length)) {
          const target = discussionActive
            ? { x: 5.8, z: 0.6 }
            : {
                x: member.home.x,
                z: member.home.z < 0 ? member.home.z - 1 : member.home.z + 1,
              };
          const targetHeading = discussionActive
            ? Math.atan2(
                target.x - walker.position.x,
                target.z - walker.position.z,
              )
            : member.home.z < 0
              ? Math.PI
              : 0;
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
      screens[index].emissiveIntensity = actor.focused
        ? 0.7
        : dark
          ? 0.4
          : 0.18;
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
          actor.walker.heading = actor.member.home.z < 0 ? Math.PI : 0;
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
      sunlight.shadow.map?.dispose();
      renderer.dispose();
      labels.replaceChildren();
    },
  };
}

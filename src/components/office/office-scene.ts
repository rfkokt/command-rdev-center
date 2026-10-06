import * as THREE from "three";
import { createVoxelCharacter } from "./voxel-character";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  TEAM,
  advanceWalker,
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

  // A warm studio lounge on the left and shelving on the back wall.
  box(room, "#53635e", [3.0, 0.045, 3.8], [-6.75, 0.04, 0.9], true);
  box(room, "#b77952", [1.1, 0.48, 2.8], [-7.8, 0.49, 0.95], true);
  box(room, "#b77952", [0.35, 0.92, 2.8], [-8.23, 0.92, 0.95], true);
  for (const z of [-0.35, 2.25])
    box(room, "#c18660", [1.15, 0.65, 0.22], [-7.8, 0.83, z], true);
  for (const z of [0.25, 1.55])
    box(room, "#d3b38c", [0.38, 0.48, 0.75], [-7.89, 0.9, z], true);
  shape(room, "cylinder", "#cfb895", [0.62, 0.12, 0.62], [-6.2, 0.67, 0.95]);
  shape(room, "cylinder", "#333d3b", [0.12, 0.62, 0.12], [-6.2, 0.31, 0.95]);
  box(room, "#b08356", [2.1, 0.12, 0.48], [-6.0, 3.25, -5.62]);
  for (let i = 0; i < 8; i++)
    box(
      room,
      ["#bb755f", "#789894", "#d2bc8d"][i % 3],
      [0.14, 0.32 + (i % 3) * 0.07, 0.25],
      [-6.8 + i * 0.17, 3.52, -5.62],
    );

  function plant(x: number, z: number, scale = 1) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.scale.setScalar(scale);
    room.add(group);
    shape(group, "cylinder", "#c6bda7", [0.3, 0.55, 0.3], [0, 0.28, 0]);
    shape(group, "cylinder", "#53493b", [0.26, 0.035, 0.26], [0, 0.56, 0]);
    box(group, "#547b58", [0.08, 0.8, 0.08], [0, 0.94, 0]);
    for (let i = 0; i < 12; i++) {
      const tier = Math.floor(i / 4);
      const x = [0.24, -0.24, 0, 0][i % 4] * (1 - tier * 0.18);
      const z = [0, 0, 0.24, -0.24][i % 4] * (1 - tier * 0.18);
      box(
        group,
        i % 2 ? "#547b58" : "#729269",
        [0.24, 0.24, 0.24],
        [x, 0.85 + tier * 0.24, z],
      );
    }
  }

  plant(-8.2, -4.95, 1.3);
  plant(8.0, -5.1, 1.25);
  plant(8.2, 4.8);
  plant(-8.3, 4.8, 1.15);
  // Storage cabinet and server rack.
  box(room, "#647571", [2.1, 1.05, 0.9], [5.8, 0.53, -5.45], true);
  for (const x of [5.3, 6.3])
    box(room, "#c1b398", [0.45, 0.035, 0.04], [x, 0.8, -4.98]);
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
    box(station, "#c0a17b", [2.65, 0.13, 1.25], [x, 1.02, deskZ], true);
    for (const side of [-1, 1]) {
      box(
        station,
        "#334743",
        [0.08, 0.95, 1.0],
        [x + side * 1.12, 0.49, deskZ],
      );
    }
    box(station, "#26383d", [1.16, 0.7, 0.095], [x, 1.63, deskZ - 0.25], true);
    const screen = box(
      station,
      member.color,
      [1.04, 0.57, 0.018],
      [x, 1.64, deskZ - 0.193],
      false,
      0.32,
    );
    screens.push(screen.material);
    // Code/editor lines on screen are geometry, crisp at every display density.
    for (let line = 0; line < 6; line++) {
      box(
        station,
        line % 3 ? "#c5e0d4" : "#f3d1a4",
        [0.28 + (line % 3) * 0.14, 0.019, 0.006],
        [x - 0.15 + (line % 2) * 0.1, 1.84 - line * 0.076, deskZ - 0.18],
        false,
        0.35,
      );
    }
    box(station, "#35444a", [0.065, 0.32, 0.065], [x, 1.22, deskZ - 0.25]);
    box(station, "#35444a", [0.43, 0.035, 0.3], [x, 1.11, deskZ - 0.25], true);
    box(station, "#4f6060", [0.72, 0.045, 0.24], [x, 1.12, deskZ + 0.35], true);
    shape(
      station,
      "cylinder",
      member.color,
      [0.095, 0.17, 0.095],
      [x + 0.9, 1.17, deskZ + 0.2],
    );
    box(
      station,
      "#ddd0ad",
      [0.3, 0.035, 0.36],
      [x - 0.92, 1.11, deskZ + 0.15],
      true,
    );
    // Empty chairs remain physical objects when a specialist walks away.
    box(station, "#3c5155", [0.69, 0.13, 0.65], [x, 0.49, z + 0.13], true);
    box(station, "#3c5155", [0.69, 0.64, 0.13], [x, 0.9, z + 0.42], true);
    shape(
      station,
      "cylinder",
      "#354044",
      [0.07, 0.43, 0.07],
      [x, 0.24, z + 0.1],
    );
    box(station, "#354044", [0.72, 0.065, 0.09], [x, 0.1, z + 0.1]);
    box(station, "#354044", [0.09, 0.065, 0.72], [x, 0.1, z + 0.1]);
  }
  // A shared briefing spot gives the team a visible place to discuss a prompt.
  // The ring of positions leaves a clear aisle around the low pixel table.
  const discussionSpots = [
    { x: -1.65, z: -1.25 },
    { x: 0, z: -1.25 },
    { x: 1.65, z: -1.25 },
    { x: -1.65, z: 1.45 },
    { x: 0, z: 1.45 },
    { x: 1.65, z: 1.45 },
  ] as const;
  box(room, "#4a5960", [4.2, 0.06, 2.55], [0, 0.035, 0.1], true);
  box(room, "#6d513e", [3.2, 0.12, 1.05], [0, 0.76, 0.1], true);
  for (const x of [-1.25, 1.25])
    box(room, "#3e4b4b", [0.12, 0.72, 0.82], [x, 0.38, 0.1]);
  // Pendant fixtures, balanced daylight and a warm practical light.
  for (const x of [-4.9, 2.8]) {
    box(room, "#334342", [0.025, 0.75, 0.025], [x, 5.05, -0.4]);
    box(room, "#344744", [3.2, 0.12, 0.32], [x, 4.64, -0.4], true);
    box(room, "#ffe1a7", [2.95, 0.025, 0.25], [x, 4.56, -0.4], false, 1.8);
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
  warm.position.set(-4.9, 4, -0.4);
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
  const projected = new THREE.Vector3();
  const pointer = new THREE.Vector2();
  const baseCamera = new THREE.Vector3();
  const lookAt = new THREE.Vector3(0, 1.25, -0.5);

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
    baseCamera.set(9.8 * distance, 7.7 * distance, 13.5 * distance);
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
    characters.forEach((actor, index) => {
      const spot = discussionSpots[index % discussionSpots.length];
      actor.walker.route = aisleRoute(actor.walker.position, spot);
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
    discussionTimeouts.splice(0).forEach((timeout) => clearTimeout(timeout));
    if (activity.discussion && activity.working) startDiscussion();
    else endDiscussion();
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
        // Stand before taking the first step to avoid sliding out of the chair.
        if (actor.sit < 0.12 || !walker.route.length) advanceWalker(walker, dt);
        if (atHome || (discussionActive && !walker.route.length)) {
          const target = discussionActive
            ? { x: 0, z: 0.1 }
            : { x: member.home.x, z: member.home.z < 0 ? member.home.z - 1 : member.home.z + 1 };
          const targetHeading = discussionActive
            ? Math.atan2(target.z - walker.position.z, target.x - walker.position.x)
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
        .set(walker.position.x, 2.04 - actor.sit * 0.24, walker.position.z)
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

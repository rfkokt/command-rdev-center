import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { AGENT_PROFILES } from "../Mascot";
import type { AgentId } from "./office-motion";

export const CHIBI_MODELS: Record<AgentId, string> = {
  ada: "/models/chibi-1.glb",
  linus: "/models/chibi-2.glb",
  alan: "/models/chibi-3.glb",
  bob: "/models/chibi-4.glb",
  grace: "/models/chibi-5.glb",
  kern: "/models/chibi-6.glb",
};

const glbCache = new Map<string, THREE.Group>();
let gltfLoader: GLTFLoader | null = null;

function getLoader() {
  if (!gltfLoader && typeof window !== "undefined") {
    gltfLoader = new GLTFLoader();
  }
  return gltfLoader;
}

function attachChibiModel(
  parent: THREE.Group,
  glbModel: THREE.Group,
  voxelGroup?: THREE.Object3D,
) {
  if (voxelGroup) {
    voxelGroup.visible = false;
  }
  const cloned = glbModel.clone(true);
  cloned.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.castShadow = true;
      obj.receiveShadow = true;
      if (Array.isArray(obj.material)) {
        obj.material = obj.material.map((m) => m.clone());
      } else if (obj.material) {
        obj.material = obj.material.clone();
      }
    }
  });
  parent.add(cloned);
}

/** Loads 3D chibi model (chibi-1.glb to chibi-6.glb) with voxel fallback. */
export function createVoxelCharacter(id: AgentId, onLoaded?: () => void) {
  const profile = AGENT_PROFILES[id];
  const cube = new THREE.BoxGeometry(1, 1, 1);
  const materials = new Map<string, THREE.MeshStandardMaterial>();
  const root = new THREE.Group();
  root.name = `character-${id}`;
  const body = new THREE.Group();
  root.add(body);

  const voxelGroup = new THREE.Group();
  body.add(voxelGroup);

  type XYZ = [number, number, number];
  function block(
    parent: THREE.Object3D,
    color: string,
    size: XYZ,
    position: XYZ,
  ) {
    let material = materials.get(color);
    if (!material) {
      material = new THREE.MeshStandardMaterial({
        color,
        roughness: 1,
        metalness: 0,
        flatShading: true,
      });
      materials.set(color, material);
    }
    const mesh = new THREE.Mesh(cube, material);
    mesh.scale.set(...size);
    mesh.position.set(...position);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  const skin = "#fed7aa";
  const ink = "#0f172a";
  block(voxelGroup, profile.shirt, [0.64, 0.4, 0.4], [0, 1.04, 0]);
  block(voxelGroup, profile.accent, [0.16, 0.32, 0.025], [0, 1.08, 0.21]);
  block(voxelGroup, skin, [0.24, 0.08, 0.24], [0, 1.28, 0]);
  block(voxelGroup, ink, [0.56, 0.08, 0.4], [0, 0.8, 0]);
  if (id === "linus") {
    for (const side of [-1, 1])
      block(
        voxelGroup,
        "#ffffff",
        [0.04, 0.16, 0.03],
        [side * 0.12, 1.12, 0.23],
      );
  }
  const head = new THREE.Group();
  head.position.y = 1.56;
  body.add(head);
  block(head, skin, [0.64, 0.4, 0.48], [0, -0.04, 0]);
  block(head, profile.hair, [0.8, 0.16, 0.56], [0, 0.2, 0]);
  block(head, profile.hair, [0.8, 0.4, 0.08], [0, -0.08, -0.24]);
  for (const side of [-1, 1]) {
    block(head, profile.hair, [0.08, 0.32, 0.48], [side * 0.36, 0, 0]);
    block(head, "#fda4af", [0.08, 0.08, 0.035], [side * 0.28, -0.12, 0.25]);
  }
  if (id === "kern") {
    block(head, "#ffffff", [0.32, 0.08, 0.48], [-0.08, 0.32, -0.04]);
    block(head, "#f1f5f9", [0.64, 0.08, 0.56], [0, 0.28, 0]);
    block(head, ink, [0.64, 0.16, 0.04], [0, 0.04, 0.26]);
    block(head, "#38bdf8", [0.32, 0.08, 0.045], [0, 0.08, 0.29]);
    block(head, "#ffffff", [0.16, 0.08, 0.05], [0, 0.08, 0.3]);
    for (const side of [-1, 1])
      block(head, ink, [0.035, 0.16, 0.4], [side * 0.4, 0.04, 0.04]);
  } else {
    for (const side of [-1, 1]) {
      block(head, ink, [0.16, 0.16, 0.035], [side * 0.16, 0.04, 0.26]);
      block(head, profile.accent, [0.16, 0.08, 0.04], [side * 0.16, 0, 0.28]);
      block(
        head,
        "#ffffff",
        [0.08, 0.08, 0.045],
        [side * 0.16 - 0.04, 0.08, 0.29],
      );
    }
  }
  if (id === "ada") {
    for (const side of [-1, 1]) {
      block(head, "#a855f7", [0.24, 0.24, 0.32], [side * 0.44, 0.24, -0.08]);
      block(head, "#f43f5e", [0.16, 0.08, 0.34], [side * 0.44, 0.12, -0.08]);
      block(head, "#d946ef", [0.16, 0.24, 0.24], [side * 0.4, -0.04, 0]);
    }
    block(head, "#4c1d95", [0.8, 0.08, 0.08], [0, 0.29, 0]);
  }
  if (id === "grace") {
    block(head, "#eab308", [0.24, 0.4, 0.24], [0.24, 0.28, -0.32]);
    block(head, "#f59e0b", [0.16, 0.08, 0.26], [0.24, 0.28, -0.32]);
    block(head, "#22c55e", [0.085, 0.08, 0.085], [0.36, -0.04, 0.12]);
  }
  if (id === "bob") {
    block(head, "#dc2626", [0.8, 0.24, 0.64], [0, 0.24, -0.04]);
    block(head, "#991b1b", [0.64, 0.08, 0.24], [0, 0.12, -0.4]);
    block(head, "#ffffff", [0.16, 0.08, 0.02], [0, 0.28, 0.29]);
  }
  if (id === "alan") {
    for (const side of [-1, 1]) {
      block(head, "#fdba74", [0.16, 0.16, 0.4], [side * 0.16, 0.32, -0.04]);
      block(head, "#06b6d4", [0.24, 0.16, 0.06], [side * 0.2, 0.2, 0.29]);
      block(
        head,
        "#ffffff",
        [0.08, 0.08, 0.02],
        [side * 0.2 - 0.08, 0.24, 0.33],
      );
    }
  }
  const arms: THREE.Group[] = [],
    legs: THREE.Group[] = [],
    knees: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.4, 1.2, 0);
    body.add(arm);
    arms.push(arm);
    block(arm, profile.shirt, [0.16, 0.32, 0.32], [0, -0.12, 0]);
    block(arm, skin, [0.16, 0.16, 0.24], [0, -0.36, 0]);
    const leg = new THREE.Group();
    leg.position.set(side * 0.16, 0.76, 0);
    body.add(leg);
    legs.push(leg);
    block(leg, "#334155", [0.24, 0.32, 0.32], [0, -0.16, 0]);
    const knee = new THREE.Group();
    knee.position.y = -0.32;
    leg.add(knee);
    knees.push(knee);
    block(knee, ink, [0.24, 0.32, 0.24], [0, -0.16, 0]);
    block(knee, "#cbd5e1", [0.24, 0.12, 0.4], [0, -0.36, 0.04]);
    block(knee, profile.accent, [0.245, 0.04, 0.12], [0, -0.32, 0.16]);
  }

  // Load chibi GLB model
  const chibiUrl = CHIBI_MODELS[id];
  const cached = glbCache.get(chibiUrl);
  if (cached) {
    attachChibiModel(body, cached, voxelGroup);
    head.visible = false;
    arms.forEach((a) => (a.visible = false));
    legs.forEach((l) => (l.visible = false));
    if (onLoaded) onLoaded();
  } else {
    const l = getLoader();
    if (l) {
      l.load(
        chibiUrl,
        (gltf) => {
          const model = gltf.scene;
          model.traverse((object) => {
            if (object instanceof THREE.Mesh) {
              object.castShadow = true;
              object.receiveShadow = true;
              if (object.material) {
                const mats = Array.isArray(object.material)
                  ? object.material
                  : [object.material];
                mats.forEach((m) => {
                  m.roughness = 1.0;
                  m.metalness = 0;
                  m.flatShading = true;
                });
              }
            }
          });
          const bounds = new THREE.Box3().setFromObject(model);
          const size = bounds.getSize(new THREE.Vector3());
          const targetHeight = 1.95;
          const scale = targetHeight / (size.y || 2.3);
          model.scale.setScalar(scale);
          model.position.set(0, 0, 0);
          glbCache.set(chibiUrl, model);
          attachChibiModel(body, model, voxelGroup);
          head.visible = false;
          arms.forEach((a) => (a.visible = false));
          legs.forEach((l) => (l.visible = false));
          if (onLoaded) onLoaded();
        },
        undefined,
        (err) => {
          console.warn(`Fallback to voxel character for ${id}:`, err);
        },
      );
    }
  }

  return { root, body, head, arms, legs, knees };
}

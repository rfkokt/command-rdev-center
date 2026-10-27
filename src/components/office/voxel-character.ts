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

function splitGeometryByPart(
  geo: THREE.BufferGeometry,
  matrix: THREE.Matrix4,
): Record<
  "head" | "torso" | "lArm" | "rArm" | "lLeg" | "rLeg",
  THREE.BufferGeometry
> {
  const worldGeo = geo.clone().applyMatrix4(matrix);
  const nonIndexed = worldGeo.index ? worldGeo.toNonIndexed() : worldGeo;
  const pos = nonIndexed.getAttribute("position");
  const norm = nonIndexed.getAttribute("normal");
  const uv = nonIndexed.getAttribute("uv");

  const buckets: Record<
    "head" | "torso" | "lArm" | "rArm" | "lLeg" | "rLeg",
    {
      pos: number[];
      norm: number[];
      uv: number[];
      pivot: [number, number, number];
    }
  > = {
    head: { pos: [], norm: [], uv: [], pivot: [0, 0.74, 0] },
    torso: { pos: [], norm: [], uv: [], pivot: [0, 0, 0] },
    lArm: { pos: [], norm: [], uv: [], pivot: [-0.26, 0.68, 0] },
    rArm: { pos: [], norm: [], uv: [], pivot: [0.26, 0.68, 0] },
    lLeg: { pos: [], norm: [], uv: [], pivot: [-0.12, 0.3, 0] },
    rLeg: { pos: [], norm: [], uv: [], pivot: [0.12, 0.3, 0] },
  };

  for (let i = 0; i < pos.count; i += 3) {
    const x0 = pos.getX(i),
      y0 = pos.getY(i),
      z0 = pos.getZ(i);
    const x1 = pos.getX(i + 1),
      y1 = pos.getY(i + 1),
      z1 = pos.getZ(i + 1);
    const x2 = pos.getX(i + 2),
      y2 = pos.getY(i + 2),
      z2 = pos.getZ(i + 2);
    const cx = (x0 + x1 + x2) / 3;
    const cy = (y0 + y1 + y2) / 3;
    const key =
      cy >= 0.74
        ? "head"
        : cy < 0.3
          ? cx < 0
            ? "lLeg"
            : "rLeg"
          : cx < -0.24
            ? "lArm"
            : cx > 0.24
              ? "rArm"
              : "torso";
    const b = buckets[key];
    const [px, py, pz] = b.pivot;
    b.pos.push(
      x0 - px,
      y0 - py,
      z0 - pz,
      x1 - px,
      y1 - py,
      z1 - pz,
      x2 - px,
      y2 - py,
      z2 - pz,
    );
    if (norm) {
      b.norm.push(
        norm.getX(i),
        norm.getY(i),
        norm.getZ(i),
        norm.getX(i + 1),
        norm.getY(i + 1),
        norm.getZ(i + 1),
        norm.getX(i + 2),
        norm.getY(i + 2),
        norm.getZ(i + 2),
      );
    }
    if (uv) {
      b.uv.push(
        uv.getX(i),
        uv.getY(i),
        uv.getX(i + 1),
        uv.getY(i + 1),
        uv.getX(i + 2),
        uv.getY(i + 2),
      );
    }
  }

  const out = {} as Record<
    "head" | "torso" | "lArm" | "rArm" | "lLeg" | "rLeg",
    THREE.BufferGeometry
  >;
  (Object.keys(buckets) as (keyof typeof buckets)[]).forEach((k) => {
    const b = buckets[k];
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(b.pos, 3));
    if (b.norm.length)
      g.setAttribute("normal", new THREE.Float32BufferAttribute(b.norm, 3));
    if (b.uv.length)
      g.setAttribute("uv", new THREE.Float32BufferAttribute(b.uv, 2));
    out[k] = g;
  });
  return out;
}

function attachChibiModel(
  rig: {
    body: THREE.Group;
    voxelGroup: THREE.Object3D;
    head: THREE.Group;
    arms: THREE.Group[];
    legs: THREE.Group[];
  },
  glbModel: THREE.Group,
) {
  rig.voxelGroup.visible = false;
  // Hide fallback block meshes inside head/arms/legs so we can attach articulated GLB parts
  rig.head.children.forEach((c) => (c.visible = false));
  rig.arms.forEach((a) => a.children.forEach((c) => (c.visible = false)));
  rig.legs.forEach((l) => l.children.forEach((c) => (c.visible = false)));

  let sourceMesh: THREE.Mesh | null = null;
  glbModel.updateMatrixWorld(true);
  glbModel.traverse((obj) => {
    if (obj instanceof THREE.Mesh && !sourceMesh) sourceMesh = obj;
  });

  if (!sourceMesh) return;
  const mesh = sourceMesh as THREE.Mesh;
  const mat = Array.isArray(mesh.material)
    ? mesh.material.map((m) => m.clone())
    : mesh.material.clone();
  const matrix = new THREE.Matrix4().compose(
    glbModel.position,
    glbModel.quaternion,
    glbModel.scale,
  );
  const parts = splitGeometryByPart(mesh.geometry, matrix);
  const makePart = (geo: THREE.BufferGeometry) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  rig.body.add(makePart(parts.torso));
  rig.head.position.set(0, 0.74, 0);
  rig.head.add(makePart(parts.head));
  rig.arms[0].position.set(-0.26, 0.68, 0);
  rig.arms[0].add(makePart(parts.lArm));
  rig.arms[1].position.set(0.26, 0.68, 0);
  rig.arms[1].add(makePart(parts.rArm));
  rig.legs[0].position.set(-0.12, 0.3, 0);
  rig.legs[0].add(makePart(parts.lLeg));
  rig.legs[1].position.set(0.12, 0.3, 0);
  rig.legs[1].add(makePart(parts.rLeg));
}

/** GLTFLoader can resolve a model even when CSP blocked its embedded palette. */
export function prepareChibiModel(model: THREE.Group): boolean {
  const meshes: THREE.Mesh[] = [];
  model.traverse((object) => {
    if (object instanceof THREE.Mesh) meshes.push(object);
  });
  if (
    !meshes.length ||
    meshes.some((mesh) =>
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some(
        (mat) =>
          !(mat instanceof THREE.MeshStandardMaterial) || !mat.map?.image,
      ),
    )
  )
    return false;

  for (const mesh of meshes) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (!mesh.geometry.getAttribute("normal"))
      mesh.geometry.computeVertexNormals();
    for (const mat of Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material]) {
      const material = mat as THREE.MeshStandardMaterial;
      material.roughness = 1;
      material.metalness = 0;
      material.flatShading = true;
      const texture = material.map!;
      texture.magFilter = THREE.NearestFilter;
      texture.minFilter = THREE.NearestFilter;
      texture.generateMipmaps = false;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      material.needsUpdate = true;
    }
  }
  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const scale = 1.95 / (size.y || 2.3);
  model.scale.multiplyScalar(scale);
  model.position.x -= center.x * scale;
  model.position.y -= bounds.min.y * scale;
  model.position.z -= center.z * scale;
  return true;
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
  const rig = { body, voxelGroup, head, arms, legs };
  if (cached) {
    attachChibiModel(rig, cached);
    if (onLoaded) onLoaded();
  } else {
    const l = getLoader();
    if (l) {
      l.load(
        chibiUrl,
        (gltf) => {
          const model = gltf.scene;
          if (!prepareChibiModel(model)) {
            console.warn(
              `Missing chibi palette for ${id}; keeping the colored voxel character.`,
            );
            return;
          }
          glbCache.set(chibiUrl, model);
          attachChibiModel(rig, model);
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

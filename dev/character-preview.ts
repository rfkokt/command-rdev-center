import * as THREE from "three";
import { createVoxelCharacter } from "../src/components/office/voxel-character";
import { TEAM, type AgentId } from "../src/components/office/office-motion";
import "./office-preview.css";

const container = document.getElementById("root")!;
const canvas = document.createElement("canvas");
canvas.style.cssText =
  "position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated";
container.append(canvas);
const header = document.createElement("header");
header.innerHTML =
  '<div><strong>Kern · voxel character</strong><span>The same mascot, in three dimensions</span></div><a href="/dev/office.html">Back to office</a>';
container.append(header);
const footer = document.createElement("footer");
footer.innerHTML =
  '<p>Character & view</p><nav aria-label="Character preview"></nav>';
container.append(footer);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color("#18252c");
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 30);
camera.position.set(0, 1.65, 5.5);
camera.lookAt(0, 1.1, 0);
scene.add(new THREE.HemisphereLight("#e5f1ff", "#8a9caa", 2.3));
const key = new THREE.DirectionalLight("#ffffff", 2.8);
key.position.set(-3, 5, 4);
scene.add(key);
let rig = createVoxelCharacter("kern");
scene.add(rig.root);
let angle = 0;
const draw = () => renderer.render(scene, camera);
function disposeRig() {
  const geometry = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>();
  rig.root.traverse((object) => {
    if (object instanceof THREE.Mesh) {
      geometry.add(object.geometry);
      materials.add(object.material);
    }
  });
  geometry.forEach((item) => item.dispose());
  materials.forEach((item) => item.dispose());
  scene.remove(rig.root);
}
function choose(id: AgentId) {
  disposeRig();
  rig = createVoxelCharacter(id);
  scene.add(rig.root);
  rig.root.rotation.y = angle;
  header.querySelector("strong")!.textContent =
    `${TEAM.find((member) => member.id === id)!.name} · voxel character`;
  draw();
}
for (const member of [...TEAM].sort((a) => (a.id === "kern" ? -1 : 0))) {
  const button = document.createElement("button");
  button.textContent = member.name;
  button.onclick = () => choose(member.id);
  footer.querySelector("nav")!.append(button);
}
for (const [name, value] of [
  ["Front", 0],
  ["Three-quarter", -Math.PI / 4],
  ["Side", -Math.PI / 2],
  ["Back", Math.PI],
] as const) {
  const button = document.createElement("button");
  button.textContent = name;
  button.onclick = () => {
    angle = value;
    rig.root.rotation.y = angle;
    draw();
  };
  footer.querySelector("nav")!.append(button);
}
function resize() {
  const w = container.clientWidth,
    h = container.clientHeight;
  renderer.setSize(Math.ceil(w / 2), Math.ceil(h / 2), false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  draw();
}
window.addEventListener("resize", resize);
resize();
window.addEventListener(
  "pagehide",
  () => {
    disposeRig();
    renderer.dispose();
    window.removeEventListener("resize", resize);
  },
  { once: true },
);

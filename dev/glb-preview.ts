import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import "./office-preview.css";

const root = document.getElementById("root")!;
const canvas = document.createElement("canvas");
canvas.style.cssText =
  "position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated";
root.append(canvas);
const header = document.createElement("header");
header.innerHTML =
  '<div><strong>ikan-kantoran.glb</strong><span>Imported model preview</span></div><a href="/dev/office.html">Back to office</a>';
root.append(header);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.background = new THREE.Color("#18252c");
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 100);
scene.add(new THREE.HemisphereLight("#f4ead8", "#5d463a", 2.6));
const key = new THREE.DirectionalLight("#fff1d2", 3.5);
key.position.set(-3, 6, 5);
scene.add(key);
const loader = new GLTFLoader();
loader.load(
  "/models/ikan-kantoran.glb",
  ({ scene: model }) => {
    model.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.material = Array.isArray(object.material)
          ? object.material.map((material) => material.clone())
          : object.material.clone();
        for (const material of Array.isArray(object.material)
          ? object.material
          : [object.material]) {
          material.vertexColors = true;
          material.side = THREE.DoubleSide;
          material.transparent = false;
          material.opacity = 1;
          material.needsUpdate = true;
        }
        object.castShadow = true;
        object.receiveShadow = true;
      }
    });
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    model.position.sub(center);
    const scale = 3.2 / Math.max(size.x, size.y, size.z);
    model.scale.setScalar(scale);
    model.position.y = (size.y * scale) / 2;
    scene.add(model);
    model.updateMatrixWorld(true);
    const finalBounds = new THREE.Box3().setFromObject(model);
    const scaledHeight = size.y * scale;
    camera.position.set(
      0,
      scaledHeight * 0.62,
      Math.max(size.x, size.y, size.z) * scale * 2.9,
    );
    camera.lookAt(0, scaledHeight * 0.46, 0);
    header.querySelector("span")!.textContent =
      `Loaded · world ${finalBounds.min
        .toArray()
        .map((value) => value.toFixed(1))
        .join(",")} → ${finalBounds.max
        .toArray()
        .map((value) => value.toFixed(1))
        .join(",")} · ${model.children.length} mesh`;
    draw();
  },
  undefined,
  (error) => console.error("Unable to load ikan-kantoran.glb", error),
);
function resize() {
  const width = root.clientWidth;
  const height = root.clientHeight;
  renderer.setSize(Math.ceil(width / 2), Math.ceil(height / 2), false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  draw();
}
function draw() {
  renderer.render(scene, camera);
}
window.addEventListener("resize", resize);
resize();

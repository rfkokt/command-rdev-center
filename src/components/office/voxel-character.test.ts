import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { prepareChibiModel } from "./voxel-character";
import tauriConfig from "../../../src-tauri/tauri.conf.json";

describe("chibi palette loading", () => {
  it("allows the embedded GLB palette fetch in the packaged application CSP", () => {
    const connect = tauriConfig.app.security.csp
      .split(";")
      .find((directive) => directive.trim().startsWith("connect-src "));
    expect(connect?.split(/\s+/)).toContain("blob:");
  });
  it("rejects a GLB whose embedded texture failed instead of showing a white character", () => {
    const model = new THREE.Group();
    model.add(
      new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial()),
    );
    expect(prepareChibiModel(model)).toBe(false);
  });
  it("rejects incomplete multi-material models", () => {
    const model = new THREE.Group();
    const texture = new THREE.Texture({
      width: 256,
      height: 1,
    } as TexImageSource);
    model.add(
      new THREE.Mesh(new THREE.BoxGeometry(), [
        new THREE.MeshStandardMaterial({ map: texture }),
        new THREE.MeshStandardMaterial(),
      ]),
    );
    expect(prepareChibiModel(model)).toBe(false);
  });
  it("keeps the loaded palette crisp and normalizes an off-center model onto the floor", () => {
    const model = new THREE.Group();
    const texture = new THREE.Texture({
      width: 256,
      height: 1,
    } as TexImageSource);
    const geometry = new THREE.BoxGeometry(2, 4, 1);
    geometry.deleteAttribute("normal");
    geometry.translate(3, 5, -2);
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ map: texture }),
    );
    model.add(mesh);
    expect(prepareChibiModel(model)).toBe(true);
    expect(texture.magFilter).toBe(THREE.NearestFilter);
    expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
    expect(geometry.getAttribute("normal")).toBeDefined();
    const bounds = new THREE.Box3().setFromObject(model);
    expect(bounds.min.y).toBeCloseTo(0);
    expect(bounds.max.y).toBeCloseTo(1.95);
    expect(bounds.getCenter(new THREE.Vector3()).x).toBeCloseTo(0);
    expect(bounds.getCenter(new THREE.Vector3()).z).toBeCloseTo(0);
  });
});

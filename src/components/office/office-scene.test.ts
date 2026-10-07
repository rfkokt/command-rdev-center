// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createOfficeScene, type OfficeScene } from "./office-scene";
import { TEAM, activityFor } from "./office-motion";

const renderer = vi.hoisted(() => ({
  render: vi.fn(),
  setAnimationLoop: vi.fn(),
  dispose: vi.fn(),
  setPixelRatio: vi.fn(),
  setSize: vi.fn(),
}));
vi.mock("three", async (original) => {
  const three = await original<typeof import("three")>();
  return {
    ...three,
    WebGLRenderer: class {
      shadowMap = {};
      setPixelRatio = renderer.setPixelRatio;
      setSize = renderer.setSize;
      render = renderer.render;
      setAnimationLoop = renderer.setAnimationLoop;
      dispose = renderer.dispose;
    },
  };
});
vi.mock("./voxel-character", () => ({
  createVoxelCharacter(id: string) {
    const root = new THREE.Group();
    root.userData.agentId = id;
    const body = new THREE.Group();
    const head = new THREE.Group();
    const arms = [new THREE.Group(), new THREE.Group()];
    const legs = [new THREE.Group(), new THREE.Group()];
    const knees = [new THREE.Group(), new THREE.Group()];
    root.add(body);
    body.add(head, ...arms, ...legs);
    legs.forEach((leg, i) => leg.add(knees[i]));
    return { root, body, head, arms, legs, knees };
  },
}));

let office: OfficeScene;
let labels: HTMLDivElement;
let roots: THREE.Group[];
let now: number;
let viewport: { width: number; height: number };
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  now = 0;
  viewport = { width: 1600, height: 1000 };
  vi.stubGlobal("devicePixelRatio", 2);
  const host = document.createElement("div");
  Object.defineProperties(host, {
    clientWidth: { get: () => viewport.width },
    clientHeight: { get: () => viewport.height },
  });
  const canvas = document.createElement("canvas");
  labels = document.createElement("div");
  host.append(canvas, labels);
  document.body.append(host);
  office = createOfficeScene(canvas, labels);
  const scene = renderer.render.mock.lastCall![0] as THREE.Scene;
  roots = TEAM.map(
    (member) =>
      scene.children.find(
        (child) => child.userData.agentId === member.id,
      ) as THREE.Group,
  );
});
afterEach(() => {
  office.dispose();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function advance(seconds: number) {
  const frame = renderer.setAnimationLoop.mock.lastCall![0] as
    | ((now: number) => void)
    | null;
  for (let i = 0; i < seconds * 60; i++) {
    now += 1000 / 60;
    frame?.(now);
  }
  vi.advanceTimersByTime(seconds * 1000);
}
function expectAtDesks() {
  roots.forEach((root, i) => {
    expect(root.position.toArray()).toEqual([
      TEAM[i].home.x,
      0,
      TEAM[i].home.z,
    ]);
    expect(root.rotation.y).toBe(Math.PI);
  });
}

it("keeps everyone at their desks through prompts, tool activity, completion and idle", () => {
  advance(30);
  expectAtDesks();
  office.setActivity(activityFor("crc-agent-prompt", { text: "Build it" })!);
  advance(10);
  expectAtDesks();
  expect(labels.querySelectorAll('[data-working="true"]')).toHaveLength(6);
  expect(
    labels.querySelector('[data-active="true"] .office-agent-name')
      ?.textContent,
  ).toBe("Kern");
  office.setActivity(
    activityFor("crc-agent-activity", {
      type: "tool",
      toolName: "bash",
      args: { command: "pnpm test" },
    })!,
  );
  advance(20);
  expectAtDesks();
  expect(
    labels.querySelector('[data-active="true"] .office-agent-name')
      ?.textContent,
  ).toBe("Bob");
  office.setActivity(activityFor("crc-agent-prompt", { text: "Continue" })!);
  advance(10);
  expectAtDesks();
  office.setActivity(
    activityFor("crc-agent-activity", { type: "agent_settled" })!,
  );
  advance(90);
  expectAtDesks();
  expect(
    labels.querySelectorAll('[data-working="true"], [data-active="true"]'),
  ).toHaveLength(0);
});

it("animates every rigid chibi body and fallback arm while working, then stops typing", () => {
  office.setWorking(true);
  advance(1);
  const poses = roots.map((root) => {
    const body = root.children[0];
    expect(body.rotation.x).toBeGreaterThan(0);
    expect(body.children[1].rotation.x).not.toBe(-0.8);
    return body.rotation.x;
  });
  advance(1);
  roots.forEach((root, i) =>
    expect(root.children[0].rotation.x).not.toBe(poses[i]),
  );
  office.setWorking(false);
  advance(1);
  roots.forEach((root) => {
    const body = root.children[0];
    expect(body.rotation.x).toBe(0);
    expect(body.rotation.z).toBeCloseTo(0);
    expect(body.children[1].rotation.x).toBe(-0.8);
  });
});

it("bounds Retina render cost across window sizes and keeps the workstation framing closer", () => {
  for (const [width, height] of [
    [2194, 1450],
    [3440, 1440],
    [1440, 900],
    [375, 812],
  ]) {
    viewport = { width, height };
    office.resize();
    const ratio = renderer.setPixelRatio.mock.lastCall![0] as number;
    expect(width * height * ratio * ratio).toBeLessThanOrEqual(3_000_001);
    expect(ratio).toBeLessThanOrEqual(1.25);
    expect(renderer.setSize).toHaveBeenLastCalledWith(width, height, false);
  }
  viewport = { width: 2194, height: 1450 };
  office.resize();
  const camera = renderer.render.mock.lastCall![1] as THREE.OrthographicCamera;
  expect(camera.right - camera.left).toBeCloseTo(19.065103448);
});

it("reuses anchored shadows and avoids DOM writes during stationary animation frames", () => {
  const gpu = renderer.render.mock.contexts[
    renderer.render.mock.contexts.length - 1
  ] as {
    shadowMap: { autoUpdate: boolean; needsUpdate: boolean };
  };
  expect(gpu.shadowMap.autoUpdate).toBe(false);
  gpu.shadowMap.needsUpdate = false;
  office.setWorking(true);
  const observer = new MutationObserver(() => {});
  observer.observe(labels, { attributes: true, subtree: true });
  advance(1);
  expect(observer.takeRecords()).toHaveLength(0);
  expect(gpu.shadowMap.needsUpdate).toBe(false);
  observer.disconnect();
  office.setTheme(false);
  expect(gpu.shadowMap.needsUpdate).toBe(true);
});

it("keeps reduced motion still while work indicators and real activity remain live", () => {
  office.setReducedMotion(true);
  office.setActivity(activityFor("crc-agent-prompt", { text: "Build it" })!);
  expect(renderer.setAnimationLoop).toHaveBeenLastCalledWith(null);
  roots.forEach((root) => {
    expect(root.children[0].position.y).toBe(-0.24);
    expect(root.children[0].rotation.x).toBe(0);
  });
  expectAtDesks();
  expect(labels.querySelectorAll('[data-working="true"]')).toHaveLength(6);
  expect(
    labels.querySelector('[data-bubble="true"] .office-agent-activity')
      ?.textContent,
  ).toBe("Planning the next steps…");
  vi.advanceTimersByTime(3000);
  expect(
    labels.querySelector('[data-active="true"] .office-agent-name')
      ?.textContent,
  ).toBe("Kern");
  office.setWorking(false);
  expect(labels.querySelectorAll('[data-working="true"]')).toHaveLength(0);
});

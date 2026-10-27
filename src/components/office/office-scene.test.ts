// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as THREE from "three";
import { createOfficeScene, type OfficeScene } from "./office-scene";
import { TEAM, activityFor, facingOf } from "./office-motion";
import { OFFICE_VISITS } from "./office-layout";
import { createOfficeLive, type LiveMember } from "./office-live";

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
    const model = new THREE.Mesh(
      new THREE.BoxGeometry(),
      new THREE.MeshStandardMaterial(),
    );
    model.name = "loaded-chibi";
    model.castShadow = true;
    body.add(model);
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
// All crew members sit in ergonomic chairs at their wooden workstations.
const restY = (_i: number) => -0.24;
const restArm = (_i: number) => -0.8;
function expectAtDesks() {
  roots.forEach((root, i) => {
    expect(root.position.toArray()).toEqual([
      TEAM[i].home.x,
      0,
      TEAM[i].home.z,
    ]);
    expect(root.rotation.y).toBe(facingOf(TEAM[i]));
  });
}

it("keeps everyone at their desks through prompts, tool activity and completion", () => {
  advance(1);
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
  advance(2);
  expectAtDesks();
  expect(
    labels.querySelectorAll('[data-working="true"], [data-active="true"]'),
  ).toHaveLength(0);
});

it("shows a coffee break and recalls the visitor to work on a prompt", () => {
  advance(9);
  const away = roots.filter(
    (root, index) =>
      root.position.x !== TEAM[index].home.x ||
      root.position.z !== TEAM[index].home.z,
  );
  expect(away).toHaveLength(1);
  expect(away[0]).toBe(roots[1]);
  expect(
    labels.querySelector('[data-bubble="true"] .office-agent-activity')
      ?.textContent,
  ).toBe("Coffee break");
  office.setActivity(activityFor("crc-agent-prompt", { text: "Build it" })!);
  advance(45);
  expectAtDesks();
  expect(labels.querySelectorAll('[data-working="true"]')).toHaveLength(6);
});

it("lifts a visible mug at the pantry and leaves motion still when reduced motion is enabled", () => {
  const visitor = roots[1];
  const mug = visitor.getObjectByName("coffee-mug")!;
  for (let second = 0; second < 50 && !mug.visible; second++) advance(1);
  expect(mug.visible).toBe(true);
  expect(visitor.position.x).toBe(OFFICE_VISITS[0].destination.x);
  expect(visitor.position.z).toBe(OFFICE_VISITS[0].destination.z);
  advance(0.5);
  expect(mug.position.y).toBeGreaterThan(1.15);
  office.setReducedMotion(true);
  expectAtDesks();
  expect(mug.visible).toBe(false);
  expect(visitor.children[0].position.y).toBeCloseTo(restY(1));
});

it("moves the visitor's contact shadow without recalculating GPU shadows on each step", () => {
  const visitor = roots[1];
  const model = visitor.getObjectByName("loaded-chibi") as THREE.Mesh;
  const shadow = visitor.getObjectByName("visitor-shadow")!;
  const gpu = renderer.render.mock.contexts[
    renderer.render.mock.contexts.length - 1
  ] as { shadowMap: { needsUpdate: boolean } };
  advance(8);
  expect(model.castShadow).toBe(false);
  expect(shadow.visible).toBe(true);
  gpu.shadowMap.needsUpdate = false;
  advance(1);
  expect(gpu.shadowMap.needsUpdate).toBe(false);
  office.setActivity(activityFor("crc-agent-prompt", { text: "Build it" })!);
  advance(45);
  expect(model.castShadow).toBe(true);
  expect(shadow.visible).toBe(false);
  expect(gpu.shadowMap.needsUpdate).toBe(true);
});

it("animates every rigid chibi body and fallback arm while working, then stops typing", () => {
  office.setWorking(true);
  advance(1);
  const poses = roots.map((root, i) => {
    const body = root.children[0];
    expect(body.rotation.x).toBeGreaterThan(0);
    expect(body.children[1].rotation.x).not.toBeCloseTo(restArm(i), 6);
    return body.rotation.x;
  });
  advance(1);
  roots.forEach((root, i) =>
    expect(root.children[0].rotation.x).not.toBe(poses[i]),
  );
  office.setWorking(false);
  advance(1);
  roots.forEach((root, i) => {
    const body = root.children[0];
    expect(body.rotation.x).toBe(0);
    expect(body.rotation.z).toBeCloseTo(0);
    expect(body.children[1].rotation.x).toBeCloseTo(restArm(i));
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
    expect(width * height * ratio * ratio).toBeLessThanOrEqual(2_500_001);
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
  roots.forEach((root, i) => {
    expect(root.children[0].position.y).toBeCloseTo(restY(i));
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

it("shows each crew member's own work, reactions and selection", () => {
  const label = (id: string) =>
    labels.children[TEAM.findIndex((m) => m.id === id)] as HTMLElement;
  const crew = (
    bob: "idle" | "working" | "done" | "error",
    text = "Running tests",
  ) => ({
    working: true,
    members: [
      { id: "ada" as const, status: "working" as const, text: "Reading a.ts" },
      { id: "bob" as const, status: bob, text },
    ],
  });
  office.setCrew(crew("working"));
  advance(0.2);
  // Two members work at once; their bubbles do not time out.
  expect(label("ada").dataset.active).toBe("true");
  expect(label("bob").dataset.active).toBe("true");
  advance(10);
  expect(label("ada").textContent).toContain("Reading a.ts");

  const bob = roots[TEAM.findIndex((m) => m.id === "bob")];
  const restingHead = bob.children[0].children[0].rotation.y;
  office.setCrew(crew("error", "Failed 1 of 12 tests"));
  advance(0.3);
  expect(label("bob").dataset.status).toBe("error");
  expect(label("bob").dataset.error).toBe("true");
  expect(bob.children[0].children[0].rotation.y).not.toBe(restingHead);

  office.setCrew(crew("done", "Passed 12 of 12 tests"));
  advance(0.5);
  expect(label("bob").dataset.status).toBe("done");
  expect(bob.children[0].position.y).toBeGreaterThan(-0.24);

  office.setSelected("bob");
  advance(0.1);
  expect(label("bob").dataset.selected).toBe("true");
  expect(label("ada").dataset.selected).toBe("false");
});

it("lets labels select a member when a handler is given", () => {
  office.dispose();
  const canvas = document.createElement("canvas");
  const host = document.createElement("div");
  labels = document.createElement("div");
  host.append(canvas, labels);
  document.body.append(host);
  const onSelect = vi.fn();
  office = createOfficeScene(canvas, labels, { onSelect });
  const linus = labels.children[
    TEAM.findIndex((m) => m.id === "linus")
  ] as HTMLElement;
  linus.click();
  linus.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
  expect(onSelect.mock.calls).toEqual([["linus"], ["linus"]]);
});

it("sends tasks down the tubes, walks Kern to a failure and lets the camera follow a pick", () => {
  const live = createOfficeLive(office);
  const scene = renderer.render.mock.lastCall![0] as THREE.Scene;
  const layer = scene.getObjectByName("office-live")!;
  const crew = (status: Record<string, LiveMember["status"]>) => ({
    working: true,
    members: TEAM.map((m) => ({
      id: m.id,
      status: status[m.id] ?? "idle",
      text: status[m.id] ? `${m.name} task` : "",
    })),
  });
  const moving = () =>
    layer.children.filter((child) => child.userData.moving).length;
  office.setWorking(true);
  live.update(crew({ bob: "working" }));
  expect(moving()).toBe(1); // a capsule on its way to the test lab
  advance(4);
  expect(moving()).toBe(1); // landed as a card on Bob's console
  live.update(crew({ bob: "error" }));
  advance(1);
  const kern = roots[TEAM.findIndex((m) => m.id === "kern")];
  const home = TEAM.find((m) => m.id === "kern")!.home;
  expect(Math.hypot(kern.position.x - home.x, kern.position.z - home.z)).toBeGreaterThan(0.5);

  const camera = renderer.render.mock.lastCall![1] as THREE.OrthographicCamera;
  const overviewWidth = camera.right - camera.left;
  live.setCamera("ada");
  advance(4);
  const followed = renderer.render.mock.lastCall![1] as THREE.OrthographicCamera;
  const followWidth = followed.right - followed.left;
  expect(followWidth).toBeLessThan(overviewWidth * 0.8);
  live.setCamera("overview");
  advance(6);
  const back = renderer.render.mock.lastCall![1] as THREE.OrthographicCamera;
  // The floor-plan view is far wider than following one member.
  expect(back.right - back.left).toBeGreaterThan(followWidth * 3);
  live.dispose();
  expect(scene.getObjectByName("office-live")).toBeUndefined();
});

it("orbits the camera, resets the view, and picks/hovers characters in 3D", () => {
  const camera0 = renderer.render.mock.lastCall![1] as THREE.OrthographicCamera;
  const startX = camera0.position.x;
  const startZ = camera0.position.z;

  office.rotateBy(Math.PI / 2);
  advance(0.1);
  const rotated = renderer.render.mock.lastCall![1] as THREE.OrthographicCamera;
  expect(rotated.position.x).not.toBeCloseTo(startX, 1);

  office.resetView();
  advance(4);
  const reset = renderer.render.mock.lastCall![1] as THREE.OrthographicCamera;
  expect(reset.position.x).toBeCloseTo(startX, 1);
  expect(reset.position.z).toBeCloseTo(startZ, 1);

  // Project Kern's world position to screen pixels and verify hoverAt / pickAt.
  const kernIndex = TEAM.findIndex((m) => m.id === "kern");
  const kernPos = new THREE.Vector3(
    TEAM[kernIndex].home.x,
    1.1,
    TEAM[kernIndex].home.z,
  ).project(reset);
  const px = (kernPos.x * 0.5 + 0.5) * viewport.width;
  const py = (-kernPos.y * 0.5 + 0.5) * viewport.height;
  expect(office.hoverAt(px, py)).toBe("kern");
  const kernLabel = labels.children[kernIndex] as HTMLElement;
  expect(kernLabel.dataset.hovered).toBe("true");
  expect(office.pickAt(px, py)).toBe("kern");
  expect(office.hoverAt(-999, -999)).toBeNull();
  expect(kernLabel.dataset.hovered).toBe("false");
});

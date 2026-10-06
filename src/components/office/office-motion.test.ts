import { describe, expect, it } from "vitest";
import {
  activityFor,
  advanceWalker,
  aisleRoute,
  belongsToTab,
  createWalker,
  TEAM,
} from "./office-motion";

describe("office motion", () => {
  it("travels almost the same distance at 30, 60 and 144 Hz", () => {
    const distances = [30, 60, 144].map((fps) => {
      const walker = createWalker({ x: 0, z: 0 });
      walker.route = [{ x: 20, z: 0 }];
      for (let frame = 0; frame < fps * 3; frame++)
        advanceWalker(walker, 1 / fps);
      return walker.distance;
    });
    expect(Math.max(...distances) - Math.min(...distances)).toBeLessThan(0.025);
  });
  it("arrives exactly without overshooting and keeps gait continuous across a turn", () => {
    const walker = createWalker({ x: 0, z: 0 });
    walker.route = [
      { x: 2, z: 0 },
      { x: 2, z: 2 },
    ];
    let lastDistance = 0;
    for (let i = 0; i < 900; i++) {
      advanceWalker(walker, 1 / 60);
      expect(walker.position.x).toBeLessThanOrEqual(2);
      expect(walker.position.z).toBeLessThanOrEqual(2);
      expect(walker.distance).toBeGreaterThanOrEqual(lastDistance);
      lastDistance = walker.distance;
    }
    expect(walker.position).toEqual({ x: 2, z: 2 });
    expect(walker.route).toEqual([]);
    expect(walker.speed).toBeLessThan(0.001);
  });
  it("clamps a long frame after resume instead of teleporting", () => {
    const walker = createWalker({ x: 0, z: 0 });
    walker.route = [{ x: 20, z: 0 }];
    advanceWalker(walker, 60);
    expect(walker.distance).toBeLessThan(0.063);
  });
  it("takes the short turn across the +/- pi boundary", () => {
    const walker = createWalker({ x: 0, z: 0 });
    walker.heading = Math.PI - 0.05;
    walker.route = [{ x: -0.1, z: -2 }];
    advanceWalker(walker, 1 / 60);
    expect(Math.abs(walker.heading - (Math.PI - 0.05))).toBeLessThan(0.03);
  });
  it("keeps every route clear of desks and chair backrests", () => {
    for (const member of TEAM) {
      const destination = {
        x: member.home.x + 1.25,
        z: member.home.z < 0 ? -1.15 : 1.35,
      };
      for (const [from, to] of [
        [member.home, destination],
        [destination, member.home],
      ]) {
        const route = [from, ...aisleRoute(from, to)];
        for (let i = 1; i < route.length; i++) {
          for (let step = 0; step <= 20; step++) {
            const t = step / 20;
            const x = route[i - 1].x * (1 - t) + route[i].x * t;
            const z = route[i - 1].z * (1 - t) + route[i].z * t;
            for (const station of TEAM) {
              const facing = station.home.z < 0 ? -1 : 1;
              const deskZ = station.home.z + facing * 0.9;
              const backrestZ = station.home.z - facing * 0.42;
              expect(
                Math.abs(x - station.home.x) < 1.4 && Math.abs(z - deskZ) < 0.7,
              ).toBe(false);
              expect(
                Math.abs(x - station.home.x) < 0.5 &&
                  Math.abs(z - backrestZ) < 0.18,
              ).toBe(false);
            }
          }
        }
        expect(route[route.length - 1]).toEqual(to);
      }
    }
  });
});

describe("agent activity", () => {
  it.each([
    ["bash", { command: "pnpm test" }, "bob"],
    ["exec_command", { cmd: "pnpm build" }, "grace"],
    ["run_command", { CommandLine: "git status" }, "linus"],
    ["functions.read_file", {}, "ada"],
    ["apply_patch", {}, "linus"],
    ["search_graph", {}, "alan"],
    ["web_fetch", {}, "alan"],
  ])("maps %s to the responsible specialist", (toolName, args, id) => {
    expect(
      activityFor("crc-agent-activity", { type: "tool", toolName, args })?.id,
    ).toBe(id);
  });
  it("does not reroute tools on end packets without args", () => {
    expect(
      activityFor("crc-agent-activity", {
        type: "tool",
        toolName: "bash",
        phase: "end",
      }),
    ).toBeNull();
  });
  it("rejects activity from other tabs", () => {
    expect(belongsToTab({ tabId: "other" }, "current")).toBe(false);
    expect(belongsToTab({ tabId: "other" }, undefined)).toBe(false);
    expect(belongsToTab({ tabId: "current" }, "current")).toBe(true);
    expect(belongsToTab({}, "current")).toBe(true);
  });
  it("clears work on settle and preserves the error state", () => {
    expect(
      activityFor("crc-agent-activity", {
        type: "agent_settled",
        isError: true,
      }),
    ).toMatchObject({ working: false, error: true });
  });
  it("marks a user prompt as the start of the visual team briefing", () => {
    expect(
      activityFor("crc-agent-prompt", { text: "Build the interface" }),
    ).toMatchObject({ id: "kern", working: true, discussion: true });
  });
  it("maps session history loading to Kern without changing the session flow", () => {
    expect(
      activityFor("crc-session-loading", { loading: true }),
    ).toMatchObject({
      id: "kern",
      text: "Restoring chat history…",
      working: true,
    });
    expect(activityFor("crc-session-loading", { loading: false })).toMatchObject({
      id: "kern",
      text: "Ready",
      working: false,
    });
  });
});

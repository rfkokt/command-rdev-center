import { describe, expect, it } from "vitest";
import {
  activityFor,
  advanceWalker,
  aisleRoute,
  belongsToTab,
  createWalker,
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
  it("routes between desk rows through the outer aisle", () => {
    expect(aisleRoute({ x: -5.4, z: -2.5 }, { x: 1.8, z: 2.9 })).toEqual([
      { x: -5.4, z: -1.15 },
      { x: 7.35, z: -1.15 },
      { x: 7.35, z: 4.3 },
      { x: 1.8, z: 4.3 },
      { x: 1.8, z: 2.9 },
    ]);
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
});

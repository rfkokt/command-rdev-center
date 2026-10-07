import { describe, expect, it } from "vitest";
import { DISCUSSION_SPOTS, FIXED_OBSTACLES } from "./office-layout";
import {
  activityFor,
  advanceWalker,
  advanceWalkers,
  routeWalkersTo,
  CHARACTER_CLEARANCE,
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
        z: member.home.z + 1.25,
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
              const facing = -1;
              const backrestZ = station.home.z - facing * 0.45;
              expect(
                Math.abs(x - station.home.x) < 1.35 &&
                  Math.abs(z - (station.home.z - 0.95)) < 0.575,
              ).toBe(false);
              expect(
                Math.abs(x - station.home.x) < 0.5 &&
                  Math.abs(z - backrestZ) < 0.1,
              ).toBe(false);
            }
          }
        }
        expect(route[route.length - 1]).toEqual(to);
      }
    }
  });
  it("keeps routes to the pantry discussion spots clear of desks and chair backrests", () => {
    const spots = DISCUSSION_SPOTS;
    for (const member of TEAM) {
      for (const spot of spots) {
        for (const [from, to] of [
          [member.home, spot],
          [spot, member.home],
        ]) {
          const waypoints = aisleRoute(from, to);
          expect(waypoints.length).toBeGreaterThan(0);
          const route = [from, ...waypoints];
          for (let i = 1; i < route.length; i++) {
            for (let step = 0; step <= 20; step++) {
              const t = step / 20;
              const x = route[i - 1].x * (1 - t) + route[i].x * t;
              const z = route[i - 1].z * (1 - t) + route[i].z * t;
              for (const obstacle of FIXED_OBSTACLES) {
                expect(
                  x > obstacle.minX &&
                    x < obstacle.maxX &&
                    z > obstacle.minZ &&
                    z < obstacle.maxZ,
                ).toBe(false);
              }
              for (const station of TEAM) {
                const facing = -1;
                const backrestZ = station.home.z - facing * 0.45;
                expect(
                  Math.abs(x - station.home.x) < 1.35 &&
                    Math.abs(z - (station.home.z - 0.95)) < 0.575,
                ).toBe(false);
                expect(
                  Math.abs(x - station.home.x) < 0.5 &&
                    Math.abs(z - backrestZ) < 0.1,
                ).toBe(false);
              }
            }
          }
          expect(route[route.length - 1]).toEqual(to);
        }
      }
    }
  });
});

describe("office crowd collisions", () => {
  const separation = (walkers: ReturnType<typeof createWalker>[]) => {
    let minimum = Infinity;
    for (let i = 0; i < walkers.length; i++)
      for (let j = i + 1; j < walkers.length; j++)
        minimum = Math.min(
          minimum,
          Math.hypot(
            walkers[i].position.x - walkers[j].position.x,
            walkers[i].position.z - walkers[j].position.z,
          ),
        );
    return minimum;
  };
  it("keeps room for the widest model at every gathering destination", () => {
    expect(separation(DISCUSSION_SPOTS.map(createWalker))).toBeGreaterThan(
      CHARACTER_CLEARANCE + 0.2,
    );
  });
  it("never steps through a stationary character, even immediately before arrival", () => {
    const mover = createWalker({ x: 0, z: 0 });
    const resting = createWalker({ x: 1.6, z: 0 });
    mover.route = [{ x: 1.55, z: 0 }];
    for (let frame = 0; frame < 180; frame++) {
      advanceWalkers([mover, resting], 1 / 60);
      expect(separation([mover, resting])).toBeGreaterThanOrEqual(
        CHARACTER_CLEARANCE,
      );
    }
    expect(resting.position).toEqual({ x: 1.6, z: 0 });
    expect(mover.route.length).toBeGreaterThan(0);
  });
  it.each([30, 60, 144])(
    "gathers all six agents and returns them home without collisions at %i Hz",
    (fps) => {
      const walkers = TEAM.map((member) => createWalker(member.home));
      routeWalkersTo(walkers, DISCUSSION_SPOTS);
      for (const phase of ["gather", "return"] as const) {
        if (phase === "return")
          walkers.forEach((walker, index) => {
            walker.route = aisleRoute(walker.position, TEAM[index].home);
          });
        for (
          let frame = 0;
          frame < fps * 90 && walkers.some((walker) => walker.route.length);
          frame++
        ) {
          advanceWalkers(walkers, 1 / fps);
          if (separation(walkers) < CHARACTER_CLEARANCE - 1e-8)
            throw new Error(`Overlap during ${phase}, frame ${frame}`);
        }
        expect(
          walkers.map((walker) => walker.route.length),
          `${phase}: ${JSON.stringify(walkers.map((walker) => ({ position: walker.position, route: walker.route })))}`,
        ).toEqual([0, 0, 0, 0, 0, 0]);
        if (phase === "gather")
          for (const spot of DISCUSSION_SPOTS)
            expect(
              walkers.some(
                (walker) =>
                  Math.hypot(
                    walker.position.x - spot.x,
                    walker.position.z - spot.z,
                  ) < 0.025,
              ),
            ).toBe(true);
        else
          walkers.forEach((walker, index) =>
            expect(walker.position).toEqual(TEAM[index].home),
          );
      }
    },
    15000,
  );
  it("handles a new prompt and a return-home interruption while paths are crossing", () => {
    const walkers = TEAM.map((member) => createWalker(member.home));
    routeWalkersTo(walkers, DISCUSSION_SPOTS);
    for (let frame = 0; frame < 600; frame++) {
      if (frame === 240) routeWalkersTo(walkers, DISCUSSION_SPOTS);
      advanceWalkers(walkers, 1 / 60);
      expect(separation(walkers)).toBeGreaterThanOrEqual(CHARACTER_CLEARANCE);
    }
    walkers.forEach((walker, index) => {
      walker.route = aisleRoute(walker.position, TEAM[index].home);
    });
    for (
      let frame = 0;
      frame < 5400 && walkers.some((walker) => walker.route.length);
      frame++
    ) {
      advanceWalkers(walkers, 1 / 60);
      expect(separation(walkers)).toBeGreaterThanOrEqual(CHARACTER_CLEARANCE);
    }
    expect(walkers.map((walker) => walker.route.length)).toEqual([
      0, 0, 0, 0, 0, 0,
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
  it("marks a user prompt as work at the desks", () => {
    expect(
      activityFor("crc-agent-prompt", { text: "Build the interface" }),
    ).toMatchObject({ id: "kern", working: true });
  });
  it("maps session history loading to Kern without changing the session flow", () => {
    expect(activityFor("crc-session-loading", { loading: true })).toMatchObject(
      {
        id: "kern",
        text: "Restoring chat history…",
        working: true,
      },
    );
    expect(
      activityFor("crc-session-loading", { loading: false }),
    ).toMatchObject({
      id: "kern",
      text: "Ready",
      working: false,
    });
  });
});

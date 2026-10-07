import { expect, it } from "vitest";
import { OFFICE_VISITS } from "./office-layout";
import { CHARACTER_CLEARANCE, TEAM, isWalkableSegment } from "./office-motion";
import {
  advanceOfficeRoutine,
  createOfficeRoutine,
  setRoutineReducedMotion,
  setRoutineWorking,
  type OfficeRoutine,
} from "./office-routine";

function checkFloor(routine: OfficeRoutine) {
  if (routine.stages.filter((stage) => stage !== "desk").length > 1)
    throw new Error("More than one visitor left their workstation");
  routine.walkers.forEach((walker, index) => {
    if (
      routine.stages[index] === "desk" &&
      (walker.position.x !== TEAM[index].home.x ||
        walker.position.z !== TEAM[index].home.z)
    )
      throw new Error("An idle or working desk occupant moved");
    if (!isWalkableSegment(walker.position, walker.position))
      throw new Error("Visitor entered furniture");
    routine.walkers.slice(index + 1).forEach((other) => {
      if (
        Math.hypot(
          walker.position.x - other.position.x,
          walker.position.z - other.position.z,
        ) <
        CHARACTER_CLEARANCE - 1e-8
      )
        throw new Error("Characters overlap");
    });
  });
}
function step(routine: OfficeRoutine, seconds: number, fps = 60) {
  for (let frame = 0; frame < seconds * fps; frame++) {
    advanceOfficeRoutine(routine, 1 / fps);
    checkFloor(routine);
  }
}

it.each([30, 60, 144])(
  "gives all six agents a purposeful, collision-free round trip at %i Hz",
  (fps) => {
    const routine = createOfficeRoutine();
    const visited = new Set<number>();
    const returned = new Set<number>();
    for (
      let frame = 0;
      frame < fps * 420 && returned.size < TEAM.length;
      frame++
    ) {
      const before = routine.active;
      advanceOfficeRoutine(routine, 1 / fps);
      checkFloor(routine);
      if (
        routine.active !== null &&
        routine.stages[routine.active] === "visiting"
      ) {
        visited.add(routine.active);
        expect(routine.walkers[routine.active].position).toEqual(
          OFFICE_VISITS[routine.visit].destination,
        );
      }
      if (before !== null && routine.active === null) returned.add(before);
    }
    expect([...visited].sort()).toEqual([0, 1, 2, 3, 4, 5]);
    expect([...returned].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  },
  15000,
);

it.each(["outbound", "visiting", "returning"] as const)(
  "recalls a %s visitor on a prompt and keeps everyone at work",
  (stage) => {
    const routine = createOfficeRoutine();
    for (let frame = 0; frame < 60 * 90; frame++) {
      advanceOfficeRoutine(routine, 1 / 60);
      if (routine.active !== null && routine.stages[routine.active] === stage)
        break;
    }
    expect(routine.active).not.toBeNull();
    expect(routine.stages[routine.active!]).toBe(stage);
    setRoutineWorking(routine, true);
    expect(routine.stages[routine.active!]).toBe("returning");
    const route = routine.walkers[routine.active!].route;
    setRoutineWorking(routine, true); // Tool packets must not restart the return trip.
    expect(routine.walkers[routine.active!].route).toBe(route);
    step(routine, 90);
    expect(routine.active).toBeNull();
    expect(routine.stages).toEqual(TEAM.map(() => "desk"));
    routine.walkers.forEach((walker, i) =>
      expect(walker.position).toEqual(TEAM[i].home),
    );
  },
);

it("lets the visitor stand before walking and respects reduced motion", () => {
  const routine = createOfficeRoutine();
  step(routine, 4.1);
  const visitor = routine.active!;
  expect(visitor).not.toBeNull();
  const position = { ...routine.walkers[visitor].position };
  for (let frame = 0; frame < 60; frame++)
    advanceOfficeRoutine(
      routine,
      1 / 60,
      TEAM.map(() => false),
    );
  expect(routine.walkers[visitor].position).toEqual(position);
  step(routine, 2);
  setRoutineReducedMotion(routine, true);
  step(routine, 90);
  expect(routine.active).toBeNull();
  routine.walkers.forEach((walker, i) =>
    expect(walker.position).toEqual(TEAM[i].home),
  );
  setRoutineWorking(routine, true);
  setRoutineReducedMotion(routine, false);
  step(routine, 30);
  expect(routine.active).toBeNull();
});

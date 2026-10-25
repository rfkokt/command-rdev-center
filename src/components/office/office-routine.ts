import { OFFICE_VISITS } from "./office-layout";
import {
  TEAM,
  advanceWalkers,
  aisleRoute,
  createWalker,
  facingOf,
  type Point,
} from "./office-motion";

export type RoutineStage = "desk" | "outbound" | "visiting" | "returning";
/** A purposeful trip to a colleague: walk over, stay a while, walk back. */
export type Errand = {
  destination: Point;
  lookAt: Point;
  /** Seconds to stay once there. */
  dwell: number;
  say: string;
};
export type OfficeRoutine = ReturnType<typeof createOfficeRoutine>;
// Rotate through the whole team, with Linus taking the first coffee break.
const VISIT_ORDER = [1, 2, 4, 0, 3, 5];
type Trip = { outward: Point[]; homeward: Point[] };
let trips: Trip[][] | undefined;
function plannedTrips() {
  // Others always stay at their desks. Plan once, outside the animation loop.
  if (!trips)
    trips = TEAM.map((member) =>
      OFFICE_VISITS.map((visit) => {
        const occupied = TEAM.filter((other) => other !== member).map(
          (other) => other.home,
        );
        const outward = aisleRoute(member.home, visit.destination, occupied);
        return {
          outward,
          homeward: outward.length
            ? [...outward.slice(0, -1).reverse(), member.home]
            : [],
        };
      }),
    );
  return trips;
}

export function createOfficeRoutine() {
  plannedTrips();
  return {
    walkers: TEAM.map((member) => createWalker(member.home, facingOf(member))),
    stages: TEAM.map(() => "desk" as RoutineStage),
    active: null as number | null,
    visit: 0,
    next: 0,
    waiting: 4,
    dwelling: 0,
    working: false,
    reduced: false,
    errands: TEAM.map(() => null as Errand | null),
  };
}

const others = (routine: OfficeRoutine, index: number) =>
  routine.walkers.filter((_, i) => i !== index).map((other) => other.position);

/** Send a member to a colleague (cancels their coffee/server visit). */
export function sendOnErrand(
  routine: OfficeRoutine,
  index: number,
  errand: Errand,
) {
  if (routine.reduced) return false;
  if (routine.active === index) {
    routine.active = null;
    routine.waiting = 6;
  }
  const walker = routine.walkers[index];
  const route = aisleRoute(
    walker.position,
    errand.destination,
    others(routine, index),
  );
  if (!route.length) return false;
  walker.route = route;
  walker.blockedFor = 0;
  // Errands cross the floor: hurry there, stroll back.
  walker.pace = 2.6;
  routine.errands[index] = { ...errand };
  routine.stages[index] = "outbound";
  return true;
}

/** Cut an errand short: head back to the desk now. */
export function endErrand(routine: OfficeRoutine, index: number) {
  const errand = routine.errands[index];
  if (!errand || routine.stages[index] === "returning") return;
  errand.dwell = 0;
  if (routine.stages[index] === "visiting") goHome(routine, index);
}

function goHome(routine: OfficeRoutine, index: number) {
  const walker = routine.walkers[index];
  walker.route = aisleRoute(
    walker.position,
    TEAM[index].home,
    others(routine, index),
  );
  if (!walker.route.length) walker.route = [{ ...TEAM[index].home }];
  walker.blockedFor = 0;
  if (routine.errands[index]) walker.pace = 1.9;
  routine.stages[index] = "returning";
}

function advanceErrands(routine: OfficeRoutine, dt: number) {
  routine.errands.forEach((errand, index) => {
    if (!errand) return;
    const walker = routine.walkers[index];
    const stage = routine.stages[index];
    if (stage === "outbound" && !walker.route.length) {
      routine.stages[index] = "visiting";
    } else if (stage === "visiting") {
      errand.dwell -= dt;
      if (errand.dwell <= 0) goHome(routine, index);
    } else if (stage === "returning" && !walker.route.length) {
      walker.pace = undefined;
      routine.stages[index] = "desk";
      routine.errands[index] = null;
    }
  });
}

function returnToDesk(routine: OfficeRoutine) {
  if (routine.active === null || routine.stages[routine.active] === "returning")
    return;
  const index = routine.active;
  const walker = routine.walkers[index];
  const route =
    routine.stages[index] === "visiting"
      ? plannedTrips()[index][routine.visit].homeward
      : aisleRoute(
          walker.position,
          TEAM[index].home,
          routine.walkers
            .filter((_, i) => i !== index)
            .map((other) => other.position),
        );
  walker.route = route.map((point) => ({ ...point }));
  walker.blockedFor = 0;
  routine.stages[index] = "returning";
  routine.dwelling = 0;
}

export function setRoutineWorking(routine: OfficeRoutine, working: boolean) {
  if (routine.working === working) return;
  routine.working = working;
  routine.waiting = 8;
  if (working) returnToDesk(routine);
}

export function setRoutineReducedMotion(
  routine: OfficeRoutine,
  reduced: boolean,
) {
  routine.reduced = reduced;
  if (!reduced) return;
  routine.active = null;
  routine.dwelling = 0;
  routine.waiting = 8;
  routine.errands.fill(null);
  routine.walkers.forEach((walker, index) => {
    walker.position = { ...TEAM[index].home };
    walker.route = [];
    walker.speed = 0;
    walker.heading = facingOf(TEAM[index]);
    walker.blockedFor = 0;
    routine.stages[index] = "desk";
  });
}

/** One purposeful visitor at a time; a prompt recalls that visitor to work. */
export function advanceOfficeRoutine(
  routine: OfficeRoutine,
  delta: number,
  ready?: readonly boolean[],
) {
  if (routine.reduced) return;
  const dt = Math.min(Math.max(delta, 0), 0.05);
  const errands = routine.errands.some(Boolean);
  if (errands) {
    advanceWalkers(routine.walkers, dt, ready);
    advanceErrands(routine, dt);
  }
  if (routine.active === null) {
    if (routine.working || errands) return;
    routine.waiting -= dt;
    if (routine.waiting > 0) return;
    for (let attempt = 0; attempt < TEAM.length; attempt++) {
      const index = VISIT_ORDER[routine.next % VISIT_ORDER.length];
      const visit = routine.next % OFFICE_VISITS.length;
      routine.next++;
      const route = plannedTrips()[index][visit].outward;
      if (!route.length) continue;
      routine.active = index;
      routine.visit = visit;
      routine.stages[index] = "outbound";
      routine.walkers[index].route = route.map((point) => ({ ...point }));
      return;
    }
    routine.waiting = 8;
    return;
  }
  const index = routine.active;
  const walker = routine.walkers[index];
  const stage = routine.stages[index];
  if (stage === "visiting") {
    routine.dwelling -= dt;
    if (routine.dwelling <= 0) returnToDesk(routine);
    return;
  }
  if (!errands) advanceWalkers(routine.walkers, dt, ready);
  if (walker.route.length) return;
  if (stage === "outbound") {
    routine.stages[index] = "visiting";
    routine.dwelling = OFFICE_VISITS[routine.visit].duration;
  } else {
    routine.stages[index] = "desk";
    routine.active = null;
    routine.waiting = 6;
  }
}

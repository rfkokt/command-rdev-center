import { OFFICE_VISITS } from "./office-layout";
import {
  TEAM,
  advanceWalkers,
  aisleRoute,
  createWalker,
  type Point,
} from "./office-motion";

export type RoutineStage = "desk" | "outbound" | "visiting" | "returning";
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
    walkers: TEAM.map((member) => createWalker(member.home)),
    stages: TEAM.map(() => "desk" as RoutineStage),
    active: null as number | null,
    visit: 0,
    next: 0,
    waiting: 4,
    dwelling: 0,
    working: false,
    reduced: false,
  };
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
  routine.walkers.forEach((walker, index) => {
    walker.position = { ...TEAM[index].home };
    walker.route = [];
    walker.speed = 0;
    walker.heading = Math.PI;
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
  if (routine.active === null) {
    if (routine.working) return;
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
  advanceWalkers(routine.walkers, dt, ready);
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

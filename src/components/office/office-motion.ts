import { FIXED_OBSTACLES, type FloorObstacle } from "./office-layout";

/** World coordinates are metres on the office floor (x/z). */
export type AgentId = "kern" | "ada" | "linus" | "alan" | "bob" | "grace";
export type Point = { x: number; z: number };
export const TEAM = [
  {
    id: "ada",
    name: "Ada",
    color: "#b499dc",
    skin: "#b97e5b",
    hair: "#342526",
    home: { x: -1.2, z: -1.5 },
  },
  {
    id: "linus",
    name: "Linus",
    color: "#73a98e",
    skin: "#e2b28c",
    hair: "#593d2b",
    home: { x: 2.4, z: -1.5 },
  },
  {
    id: "alan",
    name: "Alan",
    color: "#71b6c5",
    skin: "#996747",
    hair: "#25252d",
    home: { x: 6.0, z: -1.5 },
  },
  {
    id: "bob",
    name: "Bob",
    color: "#db929b",
    skin: "#edbd98",
    hair: "#9b6036",
    home: { x: 6.0, z: 3.0 },
  },
  {
    id: "grace",
    name: "Grace",
    color: "#d5ad69",
    skin: "#b77d59",
    hair: "#332e38",
    home: { x: -1.2, z: 3.0 },
  },
  {
    id: "kern",
    name: "Kern",
    color: "#6faecb",
    skin: "#d9a382",
    hair: "#313440",
    home: { x: 2.4, z: 3.0 },
  },
] as const;

export type AgentEvent = {
  tabId?: string;
  type?: string;
  phase?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  active?: boolean;
  running?: boolean;
  agentName?: string;
  title?: string;
  detail?: string;
  text?: string;
  loading?: boolean;
};
export type Activity = {
  id: AgentId;
  text: string;
  working: boolean;
  error?: boolean;
  discussion?: boolean;
};

export function belongsToTab(event: AgentEvent, activeTabId?: string) {
  return !event.tabId || event.tabId === activeTabId;
}

export function activityFor(
  eventName: string,
  event: AgentEvent,
): Activity | null {
  if (eventName === "crc-agent-running") {
    return {
      id: "kern",
      text: event.running ? "Working…" : "Ready",
      working: !!event.running,
    };
  }
  if (eventName === "crc-session-loading") {
    return {
      id: "kern",
      text: event.loading ? "Restoring chat history…" : "Ready",
      working: !!event.loading,
    };
  }
  if (eventName === "crc-agent-prompt") {
    return {
      id: "kern",
      text: "Planning the next steps…",
      working: true,
      discussion: true,
    };
  }
  if (eventName === "crc-agent-activity-sync") {
    const agent = TEAM.find(
      (member) => member.id === event.agentName?.toLowerCase(),
    );
    return {
      id: agent?.id ?? "kern",
      text: event.active ? event.detail || event.title || "Working…" : "Ready",
      working: !!event.active,
    };
  }
  if (event.type === "agent_settled") {
    return {
      id: "kern",
      text: event.isError ? "Finished with a notice" : "Done",
      working: false,
      error: event.isError,
    };
  }
  if (
    event.type === "agent_start" ||
    event.type === "thinking" ||
    event.type === "streaming_text"
  ) {
    return {
      id: "kern",
      text:
        event.type === "streaming_text"
          ? "Writing response…"
          : "Thinking through the task…",
      working: true,
    };
  }
  if (event.type !== "tool" || !event.toolName) return null;
  // End packets often omit args: do not accidentally assign the tool to another agent.
  if (event.phase === "end") return null;
  const name = event.toolName.replace(/^functions\./, "").toLowerCase();
  const command = String(
    event.args?.CommandLine || event.args?.command || event.args?.cmd || "",
  )
    .trim()
    .toLowerCase();
  let id: AgentId = "kern";
  let text = "Working on the task…";
  if (/(bash|run_command|exec_command|terminal)/.test(name)) {
    if (/\b(test|vitest|jest|pytest)\b/.test(command)) {
      id = "bob";
      text = "Running tests…";
    } else if (/\bgit\b/.test(command)) {
      id = "linus";
      text = "Updating the repository…";
    } else {
      id = "grace";
      text = /\b(build|compile)\b/.test(command)
        ? "Building the project…"
        : "Running a command…";
    }
  } else if (/(search|grep|graph|web|fetch)/.test(name)) {
    id = "alan";
    text = "Researching the code…";
  } else if (/(write|edit|replace|patch)/.test(name)) {
    id = "linus";
    text = "Making changes…";
  } else if (/(view|read)/.test(name)) {
    id = "ada";
    text = "Reading the details…";
  }
  return {
    id,
    text: event.isError ? "Checking a tool error…" : text,
    working: true,
    error: event.isError,
  };
}

export type Walker = {
  position: Point;
  route: Point[];
  heading: number;
  speed: number;
  distance: number;
  blockedFor: number;
};
export function createWalker(home: Point): Walker {
  return {
    position: { ...home },
    route: [],
    heading: Math.PI,
    speed: 0,
    distance: 0,
    blockedFor: 0,
  };
}
export const damp = (value: number, target: number, rate: number, dt: number) =>
  target + (value - target) * Math.exp(-rate * dt);

// Inflate physical furniture by the character radius; routes can use clear aisle corners.
const WALKER_RADIUS = 0.24;
const obstacles: FloorObstacle[] = [
  ...FIXED_OBSTACLES,
  ...TEAM.flatMap(({ home }) => [
    {
      minX: home.x - 1.35,
      maxX: home.x + 1.35,
      minZ: home.z - 1.525,
      maxZ: home.z - 0.375,
    },
    {
      minX: home.x - 0.43,
      maxX: home.x + 0.43,
      minZ: home.z + 0.33,
      maxZ: home.z + 0.56,
    },
  ]),
].map(({ minX, maxX, minZ, maxZ }) => ({
  minX: minX - WALKER_RADIUS,
  maxX: maxX + WALKER_RADIUS,
  minZ: minZ - WALKER_RADIUS,
  maxZ: maxZ + WALKER_RADIUS,
}));

/** Segment/rectangle clipping; boundaries are blocked too, avoiding furniture clipping. */
export function isWalkableSegment(a: Point, b: Point) {
  return obstacles.every((obstacle) => {
    let enter = 0,
      leave = 1;
    for (const [start, delta, low, high] of [
      [a.x, b.x - a.x, obstacle.minX, obstacle.maxX],
      [a.z, b.z - a.z, obstacle.minZ, obstacle.maxZ],
    ]) {
      if (Math.abs(delta) < 1e-8) {
        if (start < low || start > high) return true;
      } else {
        const t1 = (low - start) / delta,
          t2 = (high - start) / delta;
        enter = Math.max(enter, Math.min(t1, t2));
        leave = Math.min(leave, Math.max(t1, t2));
        if (enter > leave) return true;
      }
    }
    return false;
  });
}
const corners = obstacles
  .flatMap(({ minX, maxX, minZ, maxZ }) => [
    { x: minX - 0.02, z: minZ - 0.02 },
    { x: minX - 0.02, z: maxZ + 0.02 },
    { x: maxX + 0.02, z: minZ - 0.02 },
    { x: maxX + 0.02, z: maxZ + 0.02 },
  ])
  .filter(
    (point) =>
      point.x > -8.8 &&
      point.x < 8.8 &&
      point.z > -5.9 &&
      point.z < 6.1 &&
      isWalkableSegment(point, point),
  );
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.z - b.z);
// Static visibility links are computed once, never in the render loop.
const cornerLinks = corners.map((point, index) =>
  corners.flatMap((other, next) =>
    next !== index && isWalkableSegment(point, other)
      ? [{ next, cost: distance(point, other) }]
      : [],
  ),
);

// Covers the horizontal bounding circle of the widest loaded chibi at scene scale.
export const CHARACTER_CLEARANCE = 1.4;
function distanceToSegment(point: Point, from: Point, to: Point) {
  const dx = to.x - from.x,
    dz = to.z - from.z;
  const lengthSquared = dx * dx + dz * dz;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point.x - from.x) * dx + (point.z - from.z) * dz) / lengthSquared,
          ),
        );
  return Math.hypot(point.x - from.x - t * dx, point.z - from.z - t * dz);
}

/** Shortest clear path, optionally keeping away from other characters. */
export function aisleRoute(
  from: Point,
  to: Point,
  occupied: readonly Point[] = [],
): Point[] {
  const clearance = CHARACTER_CLEARANCE;
  const clear = (a: Point, b: Point) =>
    isWalkableSegment(a, b) &&
    occupied.every((point) => distanceToSegment(point, a, b) >= clearance);
  if (distance(from, to) < 0.02) return [];
  if (clear(from, to)) return [{ ...to }];
  // A circumscribed octagon supplies safe detours around each occupied position.
  const radius = (clearance + 0.025) / Math.cos(Math.PI / 8);
  const detours = occupied.length
    ? [
        ...corners,
        ...occupied.flatMap((point) =>
          Array.from({ length: 8 }, (_, index) => ({
            x: point.x + Math.cos((index * Math.PI) / 4) * radius,
            z: point.z + Math.sin((index * Math.PI) / 4) * radius,
          })),
        ),
      ].filter(
        (point) =>
          point.x > -8.8 &&
          point.x < 8.8 &&
          point.z > -5.9 &&
          point.z < 6.1 &&
          clear(point, point),
      )
    : corners;
  const points = [from, to, ...detours];
  const costs = points.map(() => Infinity),
    previous = points.map(() => -1);
  const visited = new Set<number>();
  costs[0] = 0;
  while (visited.size < points.length) {
    let current = -1;
    for (let index = 0; index < points.length; index++)
      if (!visited.has(index) && (current < 0 || costs[index] < costs[current]))
        current = index;
    if (current < 0 || !Number.isFinite(costs[current])) return [];
    if (current === 1) break;
    visited.add(current);
    const links =
      current >= 2 && !occupied.length
        ? cornerLinks[current - 2].map(({ next, cost }) => ({
            next: next + 2,
            cost,
          }))
        : detours.flatMap((point, index) =>
            current !== index + 2 && clear(points[current], point)
              ? [{ next: index + 2, cost: distance(points[current], point) }]
              : [],
          );
    if (clear(points[current], to))
      links.push({ next: 1, cost: distance(points[current], to) });
    for (const { next, cost } of links) {
      if (costs[current] + cost < costs[next]) {
        costs[next] = costs[current] + cost;
        previous[next] = current;
      }
    }
  }
  const path: Point[] = [];
  for (let index = 1; index > 0; index = previous[index])
    path.unshift({ ...points[index] });
  return path;
}

/** Assign distinct destinations by reachable route length, including repeated prompts. */
export function routeWalkersTo(
  walkers: readonly Walker[],
  destinations: readonly Point[],
) {
  const remaining = [...walkers],
    spots = [...destinations];
  while (remaining.length && spots.length) {
    let bestWalker = -1,
      bestSpot = -1,
      bestLength = Infinity;
    let bestRoute: Point[] = [];
    for (let w = 0; w < remaining.length; w++) {
      for (let s = 0; s < spots.length; s++) {
        const from = remaining[w].position,
          route = aisleRoute(from, spots[s]);
        if (!route.length && distance(from, spots[s]) >= 0.02) continue;
        let length = 0,
          previous = from;
        for (const point of route) {
          length += distance(previous, point);
          previous = point;
        }
        if (length < bestLength) {
          bestLength = length;
          bestWalker = w;
          bestSpot = s;
          bestRoute = route;
        }
      }
    }
    if (bestWalker < 0) break;
    const [walker] = remaining.splice(bestWalker, 1);
    spots.splice(bestSpot, 1);
    walker.route = bestRoute;
    walker.blockedFor = 0;
  }
}

/** Advance as a group: reject overlapping steps before committing position or gait. */
export function advanceWalkers(
  walkers: readonly Walker[],
  delta: number,
  ready: readonly boolean[] = walkers.map(() => true),
) {
  const dt = Math.min(Math.max(delta, 0), 0.05);
  walkers.forEach((walker, index) => {
    if (!ready[index]) return;
    const before = {
      position: { ...walker.position },
      route: [...walker.route],
      distance: walker.distance,
      speed: walker.speed,
    };
    advanceWalker(walker, dt);
    const occupied = walkers
      .filter((other) => other !== walker)
      .map((other) => other.position);
    if (
      occupied.every(
        (point) =>
          distanceToSegment(point, before.position, walker.position) >=
          CHARACTER_CLEARANCE,
      )
    ) {
      walker.blockedFor = 0;
      return;
    }
    walker.position = before.position;
    walker.route = before.route;
    walker.distance = before.distance;
    walker.speed = damp(before.speed, 0, 10, dt);
    walker.blockedFor += dt;
    if (walker.blockedFor >= 0.35 && walker.route.length) {
      const target = walker.route[walker.route.length - 1];
      const detour = aisleRoute(walker.position, target, occupied);
      if (detour.length) walker.route = detour;
      walker.blockedFor = 0;
    }
  });
}

/** Delta-based acceleration, shortest-angle turning and distance-based gait. */
export function advanceWalker(walker: Walker, delta: number) {
  const dt = Math.min(Math.max(delta, 0), 0.05);
  const target = walker.route[0];
  if (!target) {
    walker.speed = damp(walker.speed, 0, 10, dt);
    return;
  }
  const dx = target.x - walker.position.x;
  const dz = target.z - walker.position.z;
  const distance = Math.hypot(dx, dz);
  if (distance < 0.025) {
    walker.position.x = target.x;
    walker.position.z = target.z;
    walker.route.shift();
    return;
  }
  const speed = walker.route.length === 1 ? Math.min(1.25, distance * 3) : 1.25;
  walker.speed = damp(walker.speed, speed, 7, dt);
  const step = Math.min(distance, walker.speed * dt);
  walker.position.x += (dx / distance) * step;
  walker.position.z += (dz / distance) * step;
  walker.distance += step;
  const angle = Math.atan2(dx, dz);
  const turn = Math.atan2(
    Math.sin(angle - walker.heading),
    Math.cos(angle - walker.heading),
  );
  walker.heading += turn * (1 - Math.exp(-10 * dt));
}

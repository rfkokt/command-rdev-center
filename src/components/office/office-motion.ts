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
    home: { x: -5.4, z: -2.5 },
  },
  {
    id: "linus",
    name: "Linus",
    color: "#73a98e",
    skin: "#e2b28c",
    hair: "#593d2b",
    home: { x: -1.8, z: -2.5 },
  },
  {
    id: "alan",
    name: "Alan",
    color: "#71b6c5",
    skin: "#996747",
    hair: "#25252d",
    home: { x: 1.8, z: -2.5 },
  },
  {
    id: "bob",
    name: "Bob",
    color: "#db929b",
    skin: "#edbd98",
    hair: "#9b6036",
    home: { x: 5.4, z: -2.5 },
  },
  {
    id: "grace",
    name: "Grace",
    color: "#d5ad69",
    skin: "#b77d59",
    hair: "#332e38",
    home: { x: -5.4, z: 2.9 },
  },
  {
    id: "kern",
    name: "Kern",
    color: "#6faecb",
    skin: "#d9a382",
    hair: "#313440",
    home: { x: 1.8, z: 2.9 },
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
};
export type Activity = {
  id: AgentId;
  text: string;
  working: boolean;
  error?: boolean;
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
  if (eventName === "crc-agent-prompt") {
    return { id: "kern", text: "Planning the next steps…", working: true };
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
};
export function createWalker(home: Point): Walker {
  return {
    position: { ...home },
    route: [],
    heading: Math.PI,
    speed: 0,
    distance: 0,
  };
}
export const damp = (value: number, target: number, rate: number, dt: number) =>
  target + (value - target) * Math.exp(-rate * dt);

/** Waypoints stay in the clear aisle in front of each row, never through a desk. */
export function aisleRoute(from: Point, to: Point): Point[] {
  const aisle = (point: Point) => (point.z < 0 ? -1.15 : 1.35);
  const fromAisle = aisle(from);
  const toAisle = aisle(to);
  const atStation = (point: Point) =>
    TEAM.some(
      (member) =>
        Math.hypot(point.x - member.home.x, point.z - member.home.z) < 0.08,
    );
  const exitX = from.x + (atStation(from) ? 0.72 : 0);
  const entryX = to.x + (atStation(to) ? 0.72 : 0);
  // Step beside the chair before entering the aisle; never walk through its backrest.
  const path: Point[] = [
    { x: exitX, z: from.z },
    { x: exitX, z: fromAisle },
  ];
  if (fromAisle !== toAisle) {
    path.push({ x: 7.35, z: fromAisle }, { x: 7.35, z: toAisle });
  }
  path.push({ x: entryX, z: toAisle }, { x: entryX, z: to.z }, { ...to });
  return path;
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

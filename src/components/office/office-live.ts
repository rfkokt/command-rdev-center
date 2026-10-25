import * as THREE from "three";
import { ROOMS, type RoomId } from "./office-layout";
import { TEAM, type AgentId } from "./office-motion";
import type { OfficeScene } from "./office-scene";

/*
 * The live layer of Kern HQ, on top of the office scene:
 * - the hub video wall shows each helper's current task,
 * - pneumatic tubes carry tasks from Kern's desk to each room as capsules,
 *   which land on the console as a card and come back to Kern's inbox,
 * - Kern walks over to whoever failed,
 * - ✓ / ✕ pop over a member when a task ends,
 * - the camera shows the floor, follows one member, or (Auto) the work.
 * Everything is driven by update(): it diffs statuses, so callers just pass
 * the current crew.
 */

export type LiveStatus = "idle" | "working" | "done" | "error";
export type LiveMember = {
  id: AgentId;
  status: LiveStatus;
  text: string;
  /** Short footer line for the video wall (latest step, tool output…). */
  detail?: string;
};
export type LiveCrew = { working: boolean; members: readonly LiveMember[] };
/** "free": the user moved the camera by hand; nothing steers it. */
export type CameraMode = "overview" | "auto" | "free" | AgentId;

export const OVERVIEW = { x: -0.5, z: -1.2, zoom: 0.4 } as const;
export const FOLLOW_ZOOM = 1.45;
/** Auto keeps each shot at least this long, so the view doesn't keep jumping. */
const SHOT_HOLD = 5;

const ROOM_OF: Record<AgentId, RoomId> = {
  kern: "hub",
  ada: "library",
  alan: "lab",
  linus: "workshop",
  bob: "testlab",
  grace: "ops",
};
const NAME = Object.fromEntries(TEAM.map((m) => [m.id, m.name])) as Record<
  AgentId,
  string
>;
const COLOR = Object.fromEntries(TEAM.map((m) => [m.id, m.color])) as Record<
  AgentId,
  string
>;
const ORDER: AgentId[] = ["kern", "alan", "ada", "linus", "bob", "grace"];

export interface OfficeLive {
  update(crew: LiveCrew): void;
  setCamera(mode: CameraMode): void;
  setReducedMotion(reduced: boolean): void;
  dispose(): void;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function clip(ctx: CanvasRenderingContext2D, text: string, max: number) {
  if (ctx.measureText(text).width <= max) return text;
  while (text.length && ctx.measureText(text + "…").width > max)
    text = text.slice(0, -1);
  return text + "…";
}

export function createOfficeLive(
  office: OfficeScene,
  options: { reducedMotion?: boolean } = {},
): OfficeLive {
  const { scene, homeOf, positionOf, onFrame, wallScreens } = office.stage();
  let reducedMotion = Boolean(options.reducedMotion);
  const reduced = () => reducedMotion;
  const layer = new THREE.Group();
  layer.name = "office-live";
  scene.add(layer);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(value: T) => (
    disposables.push(value), value
  );

  let crew = new Map<AgentId, LiveMember>(
    TEAM.map((m) => [m.id, { id: m.id, status: "idle", text: "" }]),
  );
  let working = false;
  let sceneTime = 0;

  // ---------------------------------------------------------------- wall
  const screens = new Map<AgentId, { draw(): void; key: string }>();
  TEAM.forEach((m) => {
    const panel = wallScreens[m.id];
    if (!panel) return;
    const c2d = document.createElement("canvas");
    c2d.width = 512;
    c2d.height = 446;
    const ctx = c2d.getContext("2d");
    if (!ctx) return;
    const texture = keep(new THREE.CanvasTexture(c2d));
    texture.colorSpace = THREE.SRGBColorSpace;
    (panel.material as THREE.Material).dispose();
    panel.material = keep(
      new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }),
    );
    const screen = {
      key: "",
      draw() {
        const c = crew.get(m.id)!;
        const key = `${c.status}|${c.text}|${c.detail ?? ""}`;
        if (key === screen.key) return;
        screen.key = key;
        const col =
          c.status === "error"
            ? "#e5484d"
            : c.status === "done"
              ? "#5fbf7f"
              : m.color;
        const W = 512,
          H = c2d.height;
        ctx.clearRect(0, 0, W, H);
        ctx.fillStyle = "#0a1219";
        roundRect(ctx, 0, 0, W, H, 18);
        ctx.fill();
        ctx.fillStyle = col;
        ctx.globalAlpha = c.status === "idle" ? 0.35 : 1;
        roundRect(ctx, 0, 0, W, 84, 18);
        ctx.fill();
        ctx.fillRect(0, 60, W, 24);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#0b0e14";
        ctx.font = "700 46px Instrument Sans, IBM Plex Sans, sans-serif";
        ctx.fillText(m.name.toUpperCase(), 24, 60);
        ctx.textAlign = "right";
        ctx.fillText(
          c.status === "working"
            ? "▶"
            : c.status === "done"
              ? "✓"
              : c.status === "error"
                ? "✕"
                : "·",
          W - 24,
          60,
        );
        ctx.textAlign = "left";
        ctx.fillStyle =
          c.status === "idle"
            ? "#4f5768"
            : c.status === "error"
              ? "#ff9ea1"
              : "#e8ecf3";
        ctx.font = "600 38px IBM Plex Sans, sans-serif";
        const lines: string[] = [];
        let line = "";
        for (const word of (c.status === "idle" ? "Standing by" : c.text).split(
          " ",
        )) {
          const next = line ? `${line} ${word}` : word;
          if (ctx.measureText(next).width > W - 48 && line) {
            lines.push(line);
            line = word;
          } else line = next;
        }
        if (line) lines.push(line);
        lines
          .slice(0, 3)
          .forEach((text, n) =>
            ctx.fillText(clip(ctx, text, W - 48), 24, 146 + n * 48),
          );
        if (c.detail && c.status !== "idle") {
          ctx.fillStyle = "#121c26";
          ctx.fillRect(0, H - 74, W, 74);
          ctx.font = "26px JetBrains Mono, monospace";
          ctx.fillStyle = /✕|fail/i.test(c.detail)
            ? "#ff8a8d"
            : /✓|pass/i.test(c.detail)
              ? "#8fd9a6"
              : "#9aa3b5";
          ctx.fillText(clip(ctx, c.detail, W - 48), 24, H - 28);
        }
        texture.needsUpdate = true;
      },
    };
    screens.set(m.id, screen);
    screen.draw();
  });

  // ---------------------------------------------------------------- tubes
  const kernHome = homeOf("kern");
  const TUBE_Y = 3.6;
  const POLE = new THREE.Vector3(kernHome.x - 1.75, 0, kernHome.z - 0.95);
  const INBOX = new THREE.Vector3(kernHome.x - 1.1, 1.08, kernHome.z - 1.25);
  const consoleTop = (id: AgentId) => {
    const h = homeOf(id);
    return new THREE.Vector3(h.x, 0.8, h.z + 0.62);
  };
  const tubeMat = keep(
    new THREE.MeshStandardMaterial({
      color: "#9fd7e6",
      transparent: true,
      opacity: 0.22,
      roughness: 0.15,
      depthWrite: false,
    }),
  );
  const ringMat = keep(
    new THREE.MeshStandardMaterial({
      color: "#a4b2ba",
      roughness: 0.5,
      metalness: 0.4,
    }),
  );
  const tubeGeo = keep(new THREE.CylinderGeometry(0.075, 0.075, 1, 10, 1, true));
  const ringGeo = keep(new THREE.CylinderGeometry(0.11, 0.11, 0.12, 10));
  const up = new THREE.Vector3(0, 1, 0);
  const drawn = new Set<string>();
  function pipe(a: THREE.Vector3, b: THREE.Vector3) {
    const key = [a, b]
      .map((v) => `${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)}`)
      .sort()
      .join("|");
    if (drawn.has(key)) return;
    drawn.add(key);
    const len = a.distanceTo(b);
    const mesh = new THREE.Mesh(tubeGeo, tubeMat);
    mesh.scale.set(1, len, 1);
    mesh.position.copy(a).lerp(b, 0.5);
    mesh.quaternion.setFromUnitVectors(up, b.clone().sub(a).normalize());
    mesh.renderOrder = 2;
    layer.add(mesh);
    const n = Math.max(1, Math.round(len / 3));
    for (let i = 0; i <= n; i++) {
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(a).lerp(b, i / n);
      ring.quaternion.copy(mesh.quaternion);
      layer.add(ring);
    }
  }
  const paths = {} as Record<AgentId, THREE.Vector3[]>;
  const hopperGeo = keep(new THREE.CylinderGeometry(0.16, 0.1, 0.18, 10));
  TEAM.filter((m) => m.id !== "kern").forEach((m) => {
    const h = homeOf(m.id);
    const dx = h.x + 0.95,
      dz = h.z + 0.62;
    // Top-row rooms via the north corridor; side rooms straight across.
    const corridorZ = h.z < -4 ? -4 : 0.6;
    const path = [
      new THREE.Vector3(POLE.x, 1.15, POLE.z),
      new THREE.Vector3(POLE.x, TUBE_Y, POLE.z),
      new THREE.Vector3(POLE.x, TUBE_Y, corridorZ),
      new THREE.Vector3(dx, TUBE_Y, corridorZ),
      new THREE.Vector3(dx, TUBE_Y, dz),
      new THREE.Vector3(dx, 1.0, dz),
    ];
    paths[m.id] = path;
    for (let i = 0; i < path.length - 1; i++) pipe(path[i], path[i + 1]);
    const hopper = new THREE.Mesh(
      hopperGeo,
      keep(
        new THREE.MeshStandardMaterial({
          color: m.color,
          emissive: m.color,
          emissiveIntensity: 0.35,
        }),
      ),
    );
    hopper.position.copy(path[path.length - 1]).add(new THREE.Vector3(0, -0.06, 0));
    layer.add(hopper);
  });
  {
    const base = new THREE.Mesh(
      keep(new THREE.CylinderGeometry(0.22, 0.26, 0.2, 12)),
      keep(
        new THREE.MeshStandardMaterial({
          color: COLOR.kern,
          emissive: COLOR.kern,
          emissiveIntensity: 0.35,
        }),
      ),
    );
    base.position.set(POLE.x, 1.05, POLE.z);
    layer.add(base);
    const stand = new THREE.Mesh(
      keep(new THREE.CylinderGeometry(0.06, 0.08, 1, 8)),
      ringMat,
    );
    stand.position.set(POLE.x, 0.5, POLE.z);
    layer.add(stand);
  }

  const capsuleGeo = keep(new THREE.CapsuleGeometry(0.06, 0.2, 4, 8));
  const glowTexture = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const g = c.getContext("2d");
    if (g) {
      const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(0.35, "rgba(255,255,255,.45)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
    return keep(new THREE.CanvasTexture(c));
  })();
  const capsuleMats = new Map<string, [THREE.Material, THREE.SpriteMaterial]>();
  function capsule(color: string) {
    let mats = capsuleMats.get(color);
    if (!mats) {
      mats = [
        keep(
          new THREE.MeshStandardMaterial({
            color,
            emissive: color,
            emissiveIntensity: 1.2,
          }),
        ),
        keep(
          new THREE.SpriteMaterial({
            map: glowTexture,
            color,
            transparent: true,
            depthWrite: false,
            toneMapped: false,
          }),
        ),
      ];
      capsuleMats.set(color, mats);
    }
    const g = new THREE.Group();
    g.add(new THREE.Mesh(capsuleGeo, mats[0]));
    const glow = new THREE.Sprite(mats[1]);
    glow.scale.set(0.9, 0.9, 1);
    g.add(glow);
    g.userData.moving = true;
    layer.add(g);
    return g;
  }
  type Ride = {
    group: THREE.Object3D;
    path: THREE.Vector3[];
    lengths: number[];
    total: number;
    s: number;
    speed: number;
    done?: () => void;
  };
  const rides: Ride[] = [];
  function ride(group: THREE.Object3D, path: THREE.Vector3[], done?: () => void) {
    const lengths = path.slice(1).map((p, i) => p.distanceTo(path[i]));
    const total = lengths.reduce((a, b) => a + b, 0);
    rides.push({
      group,
      path,
      lengths,
      total,
      s: 0,
      speed: reduced() ? 1e6 : Math.max(12, total / 2.4),
      done,
    });
  }

  const cardGeo = keep(new THREE.BoxGeometry(0.42, 0.025, 0.3));
  const stripeGeo = keep(new THREE.BoxGeometry(0.42, 0.03, 0.07));
  const paperMat = keep(
    new THREE.MeshStandardMaterial({ color: "#eef1f5", roughness: 0.9 }),
  );
  const stripeMats = new Map<string, THREE.Material>();
  function card(color: string) {
    let stripeMat = stripeMats.get(color);
    if (!stripeMat) {
      stripeMat = keep(
        new THREE.MeshStandardMaterial({
          color,
          emissive: color,
          emissiveIntensity: 0.4,
        }),
      );
      stripeMats.set(color, stripeMat);
    }
    const g = new THREE.Group();
    g.add(new THREE.Mesh(cardGeo, paperMat));
    const stripe = new THREE.Mesh(stripeGeo, stripeMat);
    stripe.position.z = -0.1;
    g.add(stripe);
    g.userData.moving = true;
    layer.add(g);
    return g;
  }
  type Hop = {
    group: THREE.Group;
    from: THREE.Vector3;
    to: THREE.Vector3;
    t: number;
    duration: number;
    done?: () => void;
  };
  const hops: Hop[] = [];
  function hop(
    group: THREE.Group,
    from: THREE.Vector3,
    to: THREE.Vector3,
    duration: number,
    done?: () => void,
  ) {
    group.position.copy(from);
    hops.push({
      group,
      from: from.clone(),
      to: to.clone(),
      t: 0,
      duration: reduced() ? 0.001 : duration,
      done,
    });
  }
  const onConsole = new Map<AgentId, THREE.Group>();
  const inboxSheets: THREE.Group[] = [];
  function dispatch(id: AgentId) {
    const old = onConsole.get(id);
    if (old) layer.remove(old);
    onConsole.delete(id);
    const path = paths[id];
    const cap = capsule(COLOR[id]);
    ride(cap, path, () => {
      layer.remove(cap);
      const g = card(COLOR[id]);
      onConsole.set(id, g);
      hop(
        g,
        path[path.length - 1].clone().add(new THREE.Vector3(0, -0.15, 0)),
        consoleTop(id),
        0.45,
      );
    });
  }
  function report(id: AgentId, failed: boolean) {
    const g = onConsole.get(id);
    onConsole.delete(id);
    const path = [...paths[id]].reverse();
    const send = () => {
      const cap = capsule(failed ? "#e5484d" : COLOR[id]);
      ride(cap, path, () => {
        layer.remove(cap);
        const sheet = card(failed ? "#e5484d" : COLOR[id]);
        // The inbox is a short stack; old sheets leave from the bottom.
        if (inboxSheets.length >= 12) layer.remove(inboxSheets.shift()!);
        inboxSheets.forEach((s, n) => (s.position.y = INBOX.y + n * 0.03));
        const target = INBOX.clone().add(
          new THREE.Vector3(0, inboxSheets.length * 0.03, 0),
        );
        inboxSheets.push(sheet);
        hop(sheet, path[path.length - 1].clone(), target, 0.5, () =>
          sheet.rotation.set(0, (inboxSheets.length % 3) * 0.12 - 0.12, 0),
        );
      });
    };
    if (g)
      hop(g, g.position.clone(), paths[id][paths[id].length - 1].clone(), 0.35, () => {
        layer.remove(g);
        send();
      });
    else send();
  }

  // ---------------------------------------------------------------- badges
  function badge(ch: string, color: string) {
    const c2d = document.createElement("canvas");
    c2d.width = c2d.height = 128;
    const ctx = c2d.getContext("2d");
    if (ctx) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(64, 64, 56, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0b0e14";
      ctx.font = "700 76px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(ch, 64, 70);
    }
    const texture = keep(new THREE.CanvasTexture(c2d));
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(
      keep(
        new THREE.SpriteMaterial({
          map: texture,
          transparent: true,
          depthTest: false,
          toneMapped: false,
        }),
      ),
    );
    sprite.scale.set(0.7, 0.7, 1);
    sprite.renderOrder = 11;
    sprite.visible = false;
    layer.add(sprite);
    return sprite;
  }
  const badges = new Map(
    TEAM.map((m) => [
      m.id,
      {
        ok: badge("✓", "#5fbf7f"),
        bad: badge("✕", "#e5484d"),
        okAt: -99,
        badAt: -99,
      },
    ]),
  );

  // ---------------------------------------------------------------- camera
  let mode: CameraMode = "overview";
  let shot = "";
  let shotSince = -99;
  // Kern's walk-over: followed out and while he looks; the walk back is not.
  let errand: "off" | "set" | "out" | "there" | "back" = "off";
  let errandHost: AgentId = "bob";
  let thereSince = 0;
  const roomById = Object.fromEntries(ROOMS.map((r) => [r.id, r])) as Record<
    RoomId,
    (typeof ROOMS)[number]
  >;
  function follow(id: AgentId, zoom = FOLLOW_ZOOM) {
    const key = `follow:${id}:${zoom}`;
    if (shot === key) return;
    shot = key;
    shotSince = sceneTime;
    office.focusOn(id, zoom);
  }
  function frameRooms(ids: AgentId[]) {
    const rooms = [...new Set(ids.map((id) => roomById[ROOM_OF[id]]))];
    const key = `rooms:${rooms.map((r) => r.id).join(",")}`;
    if (shot === key) return;
    shot = key;
    shotSince = sceneTime;
    const minX = Math.min(...rooms.map((r) => r.minX)),
      maxX = Math.max(...rooms.map((r) => r.maxX)),
      minZ = Math.min(...rooms.map((r) => r.minZ)),
      maxZ = Math.max(...rooms.map((r) => r.maxZ));
    const span = Math.max(maxX - minX, (maxZ - minZ) * 1.15);
    office.glideTo(
      (minX + maxX) / 2,
      (minZ + maxZ) / 2 + 0.5,
      Math.min(1, 7.1 / (span * 0.52 + 3)),
    );
  }
  function overview() {
    if (shot === "overview") return;
    shot = "overview";
    shotSince = sceneTime;
    office.glideTo(OVERVIEW.x, OVERVIEW.z, OVERVIEW.zoom);
  }
  function direct() {
    const kernPos = positionOf("kern");
    const away = Math.hypot(kernPos.x - kernHome.x, kernPos.z - kernHome.z) > 0.6;
    if (errand === "set" && away) errand = "out";
    if (errand === "out") {
      const host = homeOf(errandHost);
      if (Math.hypot(kernPos.x - host.x, kernPos.z - host.z) < 2.2) {
        errand = "there";
        thereSince = sceneTime;
      }
    }
    if (errand === "there" && sceneTime - thereSince > 3.6) errand = "back";
    if (errand !== "off" && errand !== "set" && !away) errand = "off";
    if (mode !== "auto") return;
    if (errand === "set" || errand === "out" || errand === "there")
      return follow("kern", 1.15);
    if (sceneTime - shotSince < SHOT_HOLD) return;
    const busy = ORDER.filter(
      (id) => id !== "kern" && crew.get(id)!.status === "working",
    );
    if (busy.length > 1) frameRooms(busy);
    else if (busy.length === 1) follow(busy[0]);
    else if (working) follow("kern", 1);
    else overview();
  }

  // ---------------------------------------------------------------- frame
  const tmp = new THREE.Vector3();
  const lift = new THREE.Vector3();
  onFrame((elapsed, frameDt) => {
    sceneTime = elapsed;
    // Without an animation loop (reduced motion) every move lands at once.
    const dt = reduced() ? 1e3 : frameDt;
    direct();
    badges.forEach((b, id) => {
      const at = positionOf(id);
      for (const [sprite, t0] of [
        [b.ok, b.okAt],
        [b.bad, b.badAt],
      ] as const) {
        const life = elapsed - t0;
        sprite.visible = !reduced() && life >= 0 && life < 1.8;
        if (sprite.visible) {
          sprite.position.set(at.x, 2.5 + life * 0.7, at.z);
          sprite.material.opacity = 1 - life / 1.8;
        }
      }
    });
    for (let n = rides.length - 1; n >= 0; n--) {
      const r = rides[n];
      r.s = Math.min(r.total, r.s + r.speed * dt);
      let left = r.s,
        i = 0;
      while (i < r.lengths.length - 1 && left > r.lengths[i]) left -= r.lengths[i++];
      const a = r.path[i],
        b = r.path[i + 1];
      r.group.position.lerpVectors(
        a,
        b,
        r.lengths[i] ? Math.min(1, left / r.lengths[i]) : 1,
      );
      r.group.children[0].quaternion.setFromUnitVectors(
        up,
        tmp.copy(b).sub(a).normalize(),
      );
      if (r.s >= r.total) {
        rides.splice(n, 1);
        r.done?.();
      }
    }
    for (let n = hops.length - 1; n >= 0; n--) {
      const f = hops[n];
      f.t = Math.min(1, f.t + dt / f.duration);
      const u = f.t;
      f.group.position
        .lerpVectors(f.from, f.to, u)
        .add(lift.set(0, Math.sin(Math.PI * u) * 0.35, 0));
      f.group.rotation.set(Math.sin(u * Math.PI) * 0.4, u * Math.PI, 0);
      if (u >= 1) {
        f.group.rotation.set(0, 0, 0);
        hops.splice(n, 1);
        f.done?.();
      }
    }
  });

  return {
    update(next) {
      const before = crew;
      crew = new Map(next.members.map((m) => [m.id, { ...m }]));
      TEAM.forEach((m) => {
        if (!crew.has(m.id))
          crew.set(m.id, { id: m.id, status: "idle", text: "" });
      });
      const wasWorking = working;
      working = next.working;
      if (working && !wasWorking) {
        // A new turn: clear the inbox.
        inboxSheets.splice(0).forEach((s) => layer.remove(s));
      }
      crew.forEach((now, id) => {
        const prev = before.get(id)?.status ?? "idle";
        const b = badges.get(id)!;
        if (now.status === prev) return;
        if (now.status === "done") b.okAt = sceneTime;
        if (now.status === "error") b.badAt = sceneTime;
        if (id === "kern") return;
        if (now.status === "working") dispatch(id);
        else if (prev === "working" && (now.status === "done" || now.status === "error"))
          report(id, now.status === "error");
        if (now.status === "error" && working) {
          // Kern gets up and walks over to look at the failure with them.
          if (
            office.visit("kern", id, {
              dwell: 3.4,
              say: `Let's look at this, ${NAME[id]}`,
            })
          ) {
            errand = "set";
            errandHost = id;
          }
        }
      });
      screens.forEach((screen) => screen.draw());
    },
    setCamera(next) {
      mode = next;
      shot = "";
      shotSince = -99;
      if (next === "overview") overview();
      else if (next !== "auto" && next !== "free") {
        shot = `follow:${next}`;
        office.focusOn(next, FOLLOW_ZOOM);
      }
    },
    setReducedMotion(value) {
      reducedMotion = value;
    },
    dispose() {
      onFrame(null);
      scene.remove(layer);
      disposables.forEach((item) => item.dispose());
    },
  };
}

import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import type { ToolCall } from "../lib/rpc";
import { STUDIO_COLORS } from "./office/office-layout";
import type { AgentId, SceneCrew } from "./office/office-motion";
import type { OfficeScene } from "./office/office-scene";
import type { CameraMode, LiveCrew, OfficeLive } from "./office/office-live";
import {
  buildCrew,
  DONE_HOLD_MS,
  ERROR_HOLD_MS,
  type CrewMember,
  type CrewStatus,
} from "./office/office-crew";
import { StepIcon, fmtStep } from "./AgentRunCard";
import "./office/office-scene.css";
import "./office/office-panel.css";

/*
 * The office as a live view of the agent run: each crew member acts out the
 * tools assigned to it, sub-agents work in parallel at other desks, and the
 * list below says who is doing what. Rendering stops while hidden.
 */

const STATUS_TEXT: Record<CrewStatus, string> = {
  idle: "Idle",
  working: "Working",
  done: "Done",
  error: "Error",
};

function useCrewClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

/**
 * Speech bubbles only for who is working, who failed, and the selected
 * member: six "done" bubbles at once overlap in a panel-sized scene. Done
 * members still get a check next to their name (via data-status).
 */
function sceneCrew(
  crew: ReturnType<typeof buildCrew>,
  selected: AgentId | null,
): SceneCrew {
  return {
    working: crew.working,
    members: crew.members.map((member) => ({
      id: member.id,
      status: member.status,
      text:
        member.status === "working" ||
        member.status === "error" ||
        member.id === selected
          ? member.text
          : "",
    })),
  };
}

/** What the live layer (video wall, tubes, camera) needs from the crew. */
function liveCrew(crew: ReturnType<typeof buildCrew>): LiveCrew {
  return {
    working: crew.working,
    members: crew.members.map((member) => {
      const done = member.steps.filter((step) => step.done).length;
      return {
        id: member.id,
        status: member.status,
        text: member.text,
        detail: member.steps.length
          ? `${done}/${member.steps.length} steps done`
          : undefined,
      };
    }),
  };
}

/**
 * Where the office is drawn: the side panel, full size in the chat area with
 * the chat floating over it, or a small floating window over the chat.
 */
export type OfficeView = "panel" | "full" | "pip";

const VIEWS: { id: OfficeView; label: string; title: string }[] = [
  { id: "panel", label: "Panel", title: "Office in this side panel" },
  { id: "pip", label: "Mini", title: "Small floating office over the chat" },
  { id: "full", label: "Full", title: "Office fills the chat; chat floats" },
];

function ViewSwitch({
  view,
  onView,
}: {
  view: OfficeView;
  onView: (view: OfficeView) => void;
}) {
  return (
    <div className="office-view-switch" role="group" aria-label="Office view">
      {VIEWS.map((option) => (
        <button
          key={option.id}
          type="button"
          className={view === option.id ? "is-on" : ""}
          aria-pressed={view === option.id}
          title={option.title}
          onClick={() => onView(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const CAMERA_ORDER: AgentId[] = [
  "kern",
  "alan",
  "ada",
  "linus",
  "bob",
  "grace",
];

function CameraBar({
  crew,
  camera,
  onSelect,
  onCamera,
}: {
  crew: ReturnType<typeof buildCrew>;
  camera: CameraMode;
  onSelect: (id: AgentId) => void;
  onCamera: (mode: CameraMode) => void;
}) {
  return (
    <div className="office-camera" role="toolbar" aria-label="Camera">
      {(["overview", "auto"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          className={camera === mode ? "is-on" : ""}
          aria-pressed={camera === mode}
          title={
            mode === "auto"
              ? "Camera moves to whoever is working"
              : "Show the whole floor"
          }
          onClick={() => onCamera(mode)}
        >
          {mode === "auto" ? "Auto" : "Overview"}
        </button>
      ))}
      <span className="office-camera-sep" aria-hidden="true" />
      {CAMERA_ORDER.map((id) => {
        const member = crew.members.find((m) => m.id === id)!;
        return (
          <button
            key={id}
            type="button"
            className={camera === id ? "is-on" : ""}
            aria-pressed={camera === id}
            title={`Follow ${member.name}`}
            data-status={member.status}
            style={{ "--member-color": member.color } as CSSProperties}
            onClick={() => onSelect(id)}
          >
            <i aria-hidden="true" />
            {member.name}
          </button>
        );
      })}
    </div>
  );
}

function OfficeStage({
  crew,
  selected,
  camera,
  visible,
  view,
  onSelect,
  onCamera,
  onView,
}: {
  crew: ReturnType<typeof buildCrew>;
  selected: AgentId | null;
  camera: CameraMode;
  visible: boolean;
  view: OfficeView;
  onSelect: (id: AgentId) => void;
  onCamera: (mode: CameraMode) => void;
  onView: (view: OfficeView) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const liveRef = useRef<OfficeLive | null>(null);
  const latest = useRef({ crew, selected, camera, visible, onSelect });
  latest.current = { crew, selected, camera, visible, onSelect };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const labels = labelsRef.current;
    if (!canvas || !labels) return;
    let cancelled = false;
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const updateTheme = () => {
      const theme = document.documentElement.dataset.theme;
      sceneRef.current?.setTheme(
        theme === "dark" || (theme !== "light" && (scheme?.matches ?? true)),
      );
    };
    const updateMotion = () => {
      sceneRef.current?.setReducedMotion(motion?.matches ?? false);
      liveRef.current?.setReducedMotion(motion?.matches ?? false);
    };
    const updateVisibility = () =>
      sceneRef.current?.setVisible(latest.current.visible && !document.hidden);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => sceneRef.current?.resize());
    resizeObserver?.observe(canvas.parentElement!);
    const themeObserver = new MutationObserver(updateTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    scheme?.addEventListener("change", updateTheme);
    motion?.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);

    if (typeof window.WebGL2RenderingContext === "undefined") setFailed(true);
    else
      void Promise.all([
        import("./office/office-scene"),
        import("./office/office-live"),
      ])
        .then(([{ createOfficeScene }, { createOfficeLive, OVERVIEW }]) => {
          if (cancelled) return;
          const scene = createOfficeScene(canvas, labels, {
            onSelect: (id) => latest.current.onSelect(id),
            // Start on the whole floor; the camera bar moves it from there.
            zoom: OVERVIEW.zoom,
            focus: { x: OVERVIEW.x, z: OVERVIEW.z },
          });
          sceneRef.current = scene;
          const live = createOfficeLive(scene, {
            reducedMotion: motion?.matches ?? false,
          });
          liveRef.current = live;
          updateTheme();
          updateMotion();
          scene.setCrew(
            sceneCrew(latest.current.crew, latest.current.selected),
          );
          live.update(liveCrew(latest.current.crew));
          scene.setSelected(latest.current.selected);
          live.setCamera(latest.current.camera);
          updateVisibility();
          setReady(true);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          console.warn("Office 3D unavailable.", error);
          setFailed(true);
        });
    return () => {
      cancelled = true;
      liveRef.current?.dispose();
      liveRef.current = null;
      sceneRef.current?.dispose();
      sceneRef.current = null;
      resizeObserver?.disconnect();
      themeObserver.disconnect();
      scheme?.removeEventListener("change", updateTheme);
      motion?.removeEventListener("change", updateMotion);
      document.removeEventListener("visibilitychange", updateVisibility);
    };
  }, []);

  // Only push to the scene when something it shows actually changed.
  const crewKey = crew.members
    .map((m) => `${m.id}:${m.status}:${m.text}`)
    .join("|");
  useEffect(() => {
    sceneRef.current?.setCrew(sceneCrew(latest.current.crew, selected));
  }, [crewKey, crew.working, selected]);
  const stepsKey = crew.members
    .map((m) => `${m.steps.filter((s) => s.done).length}/${m.steps.length}`)
    .join("|");
  useEffect(() => {
    liveRef.current?.update(liveCrew(latest.current.crew));
  }, [crewKey, crew.working, stepsKey]);
  useEffect(() => {
    liveRef.current?.setCamera(camera);
  }, [camera]);
  useEffect(() => {
    sceneRef.current?.setSelected(selected);
  }, [selected]);
  useEffect(() => {
    sceneRef.current?.setVisible(visible && !document.hidden);
    if (visible) sceneRef.current?.resize();
  }, [visible]);

  // Scroll zooms, dragging pans (as in Claw3D). A drag hands the camera to
  // the user ("free") so Auto/follow stop steering it.
  const onCameraRef = useRef(onCamera);
  onCameraRef.current = onCamera;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      sceneRef.current?.zoomBy(Math.exp(-delta * 0.0015));
    };
    let drag: { id: number; x: number; y: number; moved: boolean } | null =
      null;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      canvas.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) {
        drag.moved = true;
        canvas.classList.add("is-dragging");
        onCameraRef.current("free");
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      sceneRef.current?.panBy(dx, dy);
    };
    const onUp = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      drag = null;
      canvas.classList.remove("is-dragging");
      if (canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
    };
    const onContext = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("contextmenu", onContext);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("contextmenu", onContext);
    };
  }, [ready]);

  return (
    <div
      className={`office-panel-stage office-scene is-${view}`}
      data-renderer={ready ? "webgl" : "fallback"}
      style={
        {
          "--office-night": STUDIO_COLORS.night,
          "--office-day": STUDIO_COLORS.day,
        } as CSSProperties
      }
    >
      <canvas ref={canvasRef} hidden={!ready} />
      <div ref={labelsRef} className="office-scene-labels" hidden={!ready} />
      {ready && <ViewSwitch view={view} onView={onView} />}
      {ready && (
        <CameraBar
          crew={crew}
          camera={camera}
          onSelect={onSelect}
          onCamera={onCamera}
        />
      )}
      {(failed || !ready) && (
        <p className="office-panel-fallback">
          {failed
            ? "3D view unavailable on this device."
            : "Opening the office…"}
        </p>
      )}
    </div>
  );
}

function MemberRow({
  member,
  selected,
  onSelect,
}: {
  member: CrewMember;
  selected: boolean;
  onSelect: (id: AgentId) => void;
}) {
  return (
    <li>
      <button
        type="button"
        className={`office-member is-${member.status}${selected ? " is-selected" : ""}`}
        style={{ "--member-color": member.color } as CSSProperties}
        onClick={() => onSelect(member.id)}
        aria-pressed={selected}
      >
        <span className="office-member-dot" aria-hidden="true" />
        <span className="office-member-main">
          <span className="office-member-name">
            <strong>{member.name}</strong>
            <small>{member.role}</small>
          </span>
          <span className="office-member-text" title={member.text}>
            {member.text || (member.steps.length ? "Waiting" : "No work yet")}
          </span>
        </span>
        <span className="office-member-status">
          {STATUS_TEXT[member.status]}
          {member.steps.length > 0 && <em>{member.steps.length}</em>}
        </span>
      </button>
    </li>
  );
}

function MemberDetail({ member }: { member: CrewMember }) {
  const now = useCrewClock(member.steps.some((step) => !step.done));
  return (
    <section className="office-detail" aria-label={`${member.name}'s work`}>
      <header>
        <strong>{member.name}</strong>
        <small>{member.role}</small>
      </header>
      {member.steps.length === 0 ? (
        <p className="office-detail-empty">Nothing assigned this turn.</p>
      ) : (
        <ol>
          {member.steps.map((step) => {
            const duration = step.done
              ? step.durationMs
              : step.startedAt !== undefined
                ? now - step.startedAt
                : undefined;
            return (
              <li
                key={step.id}
                className={
                  step.failed
                    ? "is-failed"
                    : step.done
                      ? "is-done"
                      : "is-active"
                }
              >
                <StepIcon kind={step.kind} />
                <span title={step.label}>
                  {step.via && <b>{step.via}</b>}
                  {step.label}
                </span>
                <time>{duration !== undefined ? fmtStep(duration) : ""}</time>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

/** Compact crew list for the floating chat window (full view). */
function CrewRoster({
  crew,
  selected,
  onSelect,
}: {
  crew: ReturnType<typeof buildCrew>;
  selected: AgentId | null;
  onSelect: (id: AgentId) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const busy = crew.members.filter((m) => m.status === "working").length;
  return (
    <div className={`office-roster${collapsed ? " is-collapsed" : ""}`}>
      <header>
        {!collapsed && <strong>Crew</strong>}
        <span>{busy ? `${busy} busy` : crew.members.length}</span>
        <button
          type="button"
          onClick={() => setCollapsed((value) => !value)}
          title={collapsed ? "Show the crew" : "Hide the crew"}
          aria-label={collapsed ? "Expand crew list" : "Collapse crew list"}
          aria-expanded={!collapsed}
        >
          {collapsed ? "›" : "‹"}
        </button>
      </header>
      <ul>
        {crew.members.map((member) => (
          <li key={member.id}>
            <button
              type="button"
              className={`is-${member.status}${member.id === selected ? " is-selected" : ""}`}
              style={{ "--member-color": member.color } as CSSProperties}
              title={`${member.name} · ${member.role}${member.text ? ` — ${member.text}` : ""}`}
              aria-pressed={member.id === selected}
              onClick={() => onSelect(member.id)}
            >
              <i aria-hidden="true" />
              {collapsed ? (
                <b>{member.name.slice(0, 1)}</b>
              ) : (
                <>
                  <span>
                    <b>{member.name}</b>
                    <small>{member.text || member.role}</small>
                  </span>
                  <em>{STATUS_TEXT[member.status]}</em>
                </>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default memo(function OfficePanel({
  tools,
  running,
  writing,
  visible,
  view = "panel",
  layer = null,
  roster = null,
  onViewChange,
}: {
  tools: readonly ToolCall[];
  running: boolean;
  writing: boolean;
  /** The 3D stage is on screen (in the panel or over the chat). */
  visible: boolean;
  view?: OfficeView;
  /** Chat-area node the stage moves into for the full and mini views. */
  layer?: HTMLElement | null;
  /** Node in the floating chat (full view) that shows the crew roster. */
  roster?: HTMLElement | null;
  onViewChange?: (view: OfficeView) => void;
}) {
  const [camera, setCamera] = useState<CameraMode>("overview");
  // Following a member is the same as selecting them.
  const selected: AgentId | null =
    camera === "overview" || camera === "auto" || camera === "free"
      ? null
      : camera;
  const outside = view !== "panel" && layer !== null;
  // The stage lives in its own node that moves between the panel slot and the
  // chat area, so the WebGL scene survives the switch instead of rebuilding.
  const [stageHost] = useState(() => {
    const host = document.createElement("div");
    host.className = "office-stage-host";
    return host;
  });
  const slotRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    (outside ? layer : slotRef.current)?.appendChild(stageHost);
  }, [outside, layer, stageHost]);
  useEffect(() => () => stageHost.remove(), [stageHost]);
  // Tick while something can still change by time alone (done/error fades).
  const lastEnd = useRef(0);
  const now = useCrewClock(
    visible &&
      (running ||
        Date.now() - lastEnd.current < Math.max(DONE_HOLD_MS, ERROR_HOLD_MS)),
  );
  useEffect(() => {
    if (!running) lastEnd.current = Date.now();
  }, [running]);
  const crew = useMemo(
    () => buildCrew(tools, { running, writing, now }),
    [tools, running, writing, now],
  );
  const toggle = (id: AgentId) =>
    setCamera((current) => (current === id ? "overview" : id));
  const busy = crew.members.filter((m) => m.status === "working").length;
  const chosen = crew.members.find((m) => m.id === selected) ?? null;

  return (
    <div className="office-panel">
      {createPortal(
        <OfficeStage
          crew={crew}
          selected={selected}
          camera={camera}
          visible={visible}
          view={outside ? view : "panel"}
          onSelect={toggle}
          onCamera={setCamera}
          onView={(next) => onViewChange?.(next)}
        />,
        stageHost,
      )}
      {roster &&
        view === "full" &&
        createPortal(
          <CrewRoster crew={crew} selected={selected} onSelect={toggle} />,
          roster,
        )}
      <div ref={slotRef} className="office-stage-slot" />
      {outside && (
        <div className="office-away-card">
          <p>
            <strong>
              {view === "full"
                ? "Office fills the chat"
                : "Office is in a mini window"}
            </strong>
            <span>Scroll to zoom, drag to move the camera.</span>
          </p>
          <ViewSwitch view={view} onView={(next) => onViewChange?.(next)} />
        </div>
      )}
      <div className="office-panel-summary" role="status" aria-live="polite">
        {running
          ? busy > 1
            ? `${busy} working in parallel`
            : busy === 1
              ? `${crew.members.find((m) => m.status === "working")!.name} is working`
              : "Starting…"
          : tools.length
            ? "Turn finished"
            : "Waiting for a prompt"}
      </div>
      <ul className="office-members">
        {crew.members.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            selected={member.id === selected}
            onSelect={toggle}
          />
        ))}
      </ul>
      {chosen && <MemberDetail member={chosen} />}
    </div>
  );
});

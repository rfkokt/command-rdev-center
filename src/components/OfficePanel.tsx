/* @refresh reset */
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
import { FOCUS_QUOTA_EVENT, takeQuotaFocus } from "../lib/quota";
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
 * list below says who is doing what. Between turns the crew can be sent on
 * small routines (huddle, pair sync, emotes). Rendering stops while hidden.
 */

const STATUS_TEXT: Record<CrewStatus, string> = {
  idle: "Idle",
  working: "Working",
  done: "Done",
  error: "Error",
};

const AGENT_ROOM: Record<AgentId, string> = {
  kern: "HUB",
  ada: "ARCHIVE",
  alan: "LAB",
  linus: "WORKSHOP",
  bob: "TEST LAB",
  grace: "OPS",
};

type LightingMode = "auto" | "night" | "day";

function useCrewClock(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

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
  onGlide,
}: {
  crew: ReturnType<typeof buildCrew>;
  camera: CameraMode;
  onSelect: (id: AgentId) => void;
  onCamera: (mode: CameraMode) => void;
  onGlide: (x: number, z: number, zoom?: number) => void;
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
              ? "Camera follows whoever is working; when idle the crew runs short studio routines"
              : "Show the whole floor"
          }
          onClick={() => onCamera(mode)}
        >
          {mode === "auto" && (
            <span className="office-auto-dot" aria-hidden="true" />
          )}
          {mode === "auto" ? "Auto" : "Floor"}
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
            title={`Follow ${member.name} (${AGENT_ROOM[id]})`}
            data-status={member.status}
            style={{ "--member-color": member.color } as CSSProperties}
            onClick={() => onSelect(id)}
          >
            <i aria-hidden="true" />
            {member.name}
          </button>
        );
      })}
      <span className="office-camera-sep" aria-hidden="true" />
      <button
        type="button"
        onClick={() => onGlide(0, -1.2, 0.92)}
        title="Focus camera on 3D Live Subscription Quota Telemetry Wall in the Hub"
      >
        Quota 3D
      </button>
    </div>
  );
}

function StageHud({
  lighting,
  onLighting,
  onRotate,
  onZoom,
  onReset,
}: {
  lighting: LightingMode;
  onLighting: () => void;
  onRotate: (delta: number) => void;
  onZoom: (factor: number) => void;
  onReset: () => void;
}) {
  const lightingLabel =
    lighting === "auto" ? "Auto" : lighting === "night" ? "Night" : "Day";
  return (
    <div className="office-stage-hud" role="toolbar" aria-label="3D controls">
      <button
        type="button"
        onClick={() => onRotate(-Math.PI / 6)}
        title="Orbit camera counter-clockwise (or Shift+drag)"
        aria-label="Rotate camera left"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path
            d="M4.5 5.5H2v-2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M2.5 5.5a6 6 0 1 1 1.2 6.2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => onRotate(Math.PI / 6)}
        title="Orbit camera clockwise (or Shift+drag)"
        aria-label="Rotate camera right"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path
            d="M11.5 5.5H14v-2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M13.5 5.5a6 6 0 1 0-1.2 6.2" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => onZoom(1.22)}
        title="Zoom in"
        aria-label="Zoom in"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M8 3.5v9M3.5 8h9" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        onClick={() => onZoom(1 / 1.22)}
        title="Zoom out"
        aria-label="Zoom out"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M3.5 8h9" strokeLinecap="round" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onReset}
        title="Reset camera angle & overview (or double-click canvas)"
        aria-label="Reset camera view"
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
          <circle cx="8" cy="8" r="1.8" fill="currentColor" />
        </svg>
      </button>
      <span className="office-stage-hud-sep" aria-hidden="true" />
      <button
        type="button"
        className={`office-stage-hud-mode${lighting !== "auto" ? " is-on" : ""}`}
        onClick={onLighting}
        title="Toggle studio lighting (Auto / Lumen Night / Warm Day)"
        aria-label={`Studio lighting: ${lightingLabel}`}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="4.2" />
          <path
            d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8"
            strokeLinecap="round"
          />
        </svg>
        <span>{lightingLabel}</span>
      </button>
    </div>
  );
}

function OfficeStage({
  crew,
  selected,
  camera,
  visible,
  view,
  sceneRef,
  onSelect,
  onCamera,
  onView,
  onHuddle,
  onPairSync,
}: {
  crew: ReturnType<typeof buildCrew>;
  selected: AgentId | null;
  camera: CameraMode;
  visible: boolean;
  view: OfficeView;
  sceneRef: React.MutableRefObject<OfficeScene | null>;
  onSelect: (id: AgentId) => void;
  onCamera: (mode: CameraMode) => void;
  onView: (view: OfficeView) => void;
  onHuddle: () => void;
  onPairSync: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<OfficeLive | null>(null);
  const [lighting, setLighting] = useState<LightingMode>("auto");
  const lightingRef = useRef<LightingMode>(lighting);
  lightingRef.current = lighting;
  const latest = useRef({ crew, selected, camera, visible, onSelect });
  latest.current = { crew, selected, camera, visible, onSelect };
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  const applyTheme = () => {
    const mode = lightingRef.current;
    if (mode === "night") {
      sceneRef.current?.setTheme(true);
      return;
    }
    if (mode === "day") {
      sceneRef.current?.setTheme(false);
      return;
    }
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    const theme = document.documentElement.dataset.theme;
    sceneRef.current?.setTheme(
      theme === "dark" || (theme !== "light" && (scheme?.matches ?? true)),
    );
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    const labels = labelsRef.current;
    if (!canvas || !labels) return;
    let cancelled = false;
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const updateTheme = () => applyTheme();
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
            zoom: OVERVIEW.zoom,
            focus: { x: OVERVIEW.x, z: OVERVIEW.z },
            liveStudio: true,
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

  useEffect(() => {
    applyTheme();
  }, [lighting]);

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

  const onCameraRef = useRef(onCamera);
  onCameraRef.current = onCamera;
  // A focus request can arrive before the scene is ready (the HUD opens the
  // panel and asks in the same tick), so it is kept pending until then.
  useEffect(() => {
    if (!ready) return;
    const onFocusQuota = () => {
      if (!takeQuotaFocus()) return;
      onCameraRef.current("free");
      sceneRef.current?.glideTo(0, -1.2, 0.92);
    };
    onFocusQuota();
    window.addEventListener(FOCUS_QUOTA_EVENT, onFocusQuota);
    return () => window.removeEventListener(FOCUS_QUOTA_EVENT, onFocusQuota);
  }, [ready]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    const localCoords = (event: { clientX: number; clientY: number }) => {
      const rect = canvas.getBoundingClientRect();
      return {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
    };
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      sceneRef.current?.zoomBy(Math.exp(-delta * 0.0015));
    };
    let drag: {
      id: number;
      button: number;
      orbit: boolean;
      x: number;
      y: number;
      moved: boolean;
    } | null = null;
    const onDown = (event: PointerEvent) => {
      if (event.button !== 0 && event.button !== 2) return;
      drag = {
        id: event.pointerId,
        button: event.button,
        orbit: event.button === 2 || event.shiftKey,
        x: event.clientX,
        y: event.clientY,
        moved: false,
      };
      canvas.setPointerCapture(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) {
        const pt = localCoords(event);
        const hovered = sceneRef.current?.hoverAt(pt.x, pt.y) ?? null;
        canvas.classList.toggle("is-hovering-agent", hovered !== null);
        return;
      }
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) {
        drag.moved = true;
        canvas.classList.add("is-dragging");
        if (!drag.orbit) onCameraRef.current("free");
      }
      drag.x = event.clientX;
      drag.y = event.clientY;
      if (drag.orbit || event.shiftKey) {
        sceneRef.current?.rotateBy(-dx * 0.0085);
      } else {
        sceneRef.current?.panBy(dx, dy);
      }
    };
    const onUp = (event: PointerEvent) => {
      if (!drag || drag.id !== event.pointerId) return;
      const wasMoved = drag.moved;
      const button = drag.button;
      drag = null;
      canvas.classList.remove("is-dragging");
      if (canvas.hasPointerCapture(event.pointerId))
        canvas.releasePointerCapture(event.pointerId);
      if (!wasMoved && button === 0) {
        const pt = localCoords(event);
        const picked = sceneRef.current?.pickAt(pt.x, pt.y) ?? null;
        if (picked) latest.current.onSelect(picked);
      }
    };
    const onLeave = () => {
      sceneRef.current?.hoverAt(-9999, -9999);
      canvas.classList.remove("is-hovering-agent");
    };
    const onDblClick = () => {
      sceneRef.current?.resetView();
      onCameraRef.current("overview");
    };
    const onContext = (event: MouseEvent) => event.preventDefault();
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("dblclick", onDblClick);
    canvas.addEventListener("contextmenu", onContext);
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("dblclick", onDblClick);
      canvas.removeEventListener("contextmenu", onContext);
    };
  }, [ready]);

  const cycleLighting = () =>
    setLighting((prev) =>
      prev === "auto" ? "night" : prev === "night" ? "day" : "auto",
    );
  const handleResetView = () => {
    sceneRef.current?.resetView();
    onCamera("overview");
  };

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

      {ready && (
        <div className="office-stage-topbar">
          <StageHud
            lighting={lighting}
            onLighting={cycleLighting}
            onRotate={(delta) => sceneRef.current?.rotateBy(delta)}
            onZoom={(factor) => sceneRef.current?.zoomBy(factor)}
            onReset={handleResetView}
          />
          <div
            className="office-stage-choreo"
            role="toolbar"
            aria-label="Studio choreography"
          >
            <button
              type="button"
              className="office-choreo-btn is-primary"
              onClick={onHuddle}
              title="Gather crew in the Lounge for a live architecture huddle"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <circle cx="8" cy="4.5" r="2" />
                <circle cx="4" cy="11" r="1.8" />
                <circle cx="12" cy="11" r="1.8" />
                <path
                  d="M6.4 6 4.8 9M9.6 6 11.2 9M6 11h4"
                  strokeLinecap="round"
                />
              </svg>
              <span>Huddle All</span>
            </button>
            <button
              type="button"
              className="office-choreo-btn"
              onClick={onPairSync}
              title="Dispatch two pairs of colleagues to collaborate desk-to-desk"
            >
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <path
                  d="M3 5h10M10 2.5 13 5l-3 2.5M13 11H3M6 8.5 3 11l3 2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span>Pair Sync</span>
            </button>
          </div>
          {/* In the side panel the telemetry bar already carries the switch. */}
          {view !== "panel" && <ViewSwitch view={view} onView={onView} />}
        </div>
      )}

      {ready && (
        <CameraBar
          crew={crew}
          camera={camera}
          onSelect={onSelect}
          onCamera={onCamera}
          onGlide={(x, z, zoomLevel) => {
            onCamera("free");
            sceneRef.current?.glideTo(x, z, zoomLevel);
          }}
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
  const doneCount = member.steps.filter((s) => s.done).length;
  const totalCount = member.steps.length;
  return (
    <li>
      <button
        type="button"
        className={`office-member is-${member.status}${selected ? " is-selected" : ""}`}
        style={{ "--member-color": member.color } as CSSProperties}
        onClick={() => onSelect(member.id)}
        aria-pressed={selected}
      >
        <span className="office-member-head">
          <span className="office-member-dot" aria-hidden="true" />
          <span className="office-member-name">
            <strong>{member.name}</strong>
            <small>{member.role}</small>
          </span>
          <span className="office-member-room">{AGENT_ROOM[member.id]}</span>
        </span>
        <span className="office-member-text" title={member.text}>
          {member.text || (totalCount ? "Waiting" : "No work yet")}
        </span>
        <span className="office-member-foot">
          <span className="office-member-status">
            {STATUS_TEXT[member.status]}
            {totalCount > 0 && (
              <em title={`${doneCount} of ${totalCount} steps complete`}>
                {doneCount}/{totalCount}
              </em>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

function MemberDetail({
  member,
  peers,
  onEmote,
  onVisit,
}: {
  member: CrewMember;
  peers: readonly CrewMember[];
  onEmote: (kind: "wave" | "cheer" | "coffee" | "server") => void;
  onVisit: (to: AgentId) => void;
}) {
  const now = useCrewClock(member.steps.some((step) => !step.done));
  const doneCount = member.steps.filter((s) => s.done).length;
  const totalCount = member.steps.length;
  return (
    <section
      className="office-detail"
      aria-label={`${member.name}'s work`}
      style={{ "--member-color": member.color } as CSSProperties}
    >
      <header>
        <span className="office-detail-dot" aria-hidden="true" />
        <strong>{member.name}</strong>
        <small>{member.role}</small>
        <span className="office-detail-room">{AGENT_ROOM[member.id]}</span>
        {totalCount > 0 && (
          <span className="office-detail-progress">
            {doneCount}/{totalCount}
          </span>
        )}
      </header>
      <div
        className="office-detail-actions"
        role="group"
        aria-label="Character actions"
      >
        <button
          type="button"
          onClick={() => onEmote("wave")}
          title="Wave hello"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path
              d="M5.5 8.5V3.5a1 1 0 0 1 2 0v4M7.5 7.5V2.8a1 1 0 0 1 2 0v4.7M9.5 7.5V3.8a1 1 0 0 1 2 0v5.7a4 4 0 0 1-8 0V6.5a1 1 0 0 1 2 0v2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Wave
        </button>
        <button
          type="button"
          onClick={() => onEmote("cheer")}
          title="Celebrate milestone"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path
              d="M8 2v3M8 11v3M2 8h3M11 8h3M4.2 4.2l2 2M9.8 9.8l2 2M11.8 4.2l-2 2M6.2 9.8l-2 2"
              strokeLinecap="round"
            />
          </svg>
          Cheer
        </button>
        <button
          type="button"
          onClick={() => onEmote("coffee")}
          title="Walk to the Lounge for an espresso break"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <path d="M3 6h7.5v4.2a3.3 3.3 0 0 1-3.3 3.3H6.3A3.3 3.3 0 0 1 3 10.2V6Z" />
            <path
              d="M10.5 7h1.2a1.8 1.8 0 0 1 0 3.6h-1.2M5 2.5v1.8M8.5 2.5v1.8"
              strokeLinecap="round"
            />
          </svg>
          Coffee
        </button>
        <button
          type="button"
          onClick={() => onEmote("server")}
          title="Walk to the Ops Room to audit server racks"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <rect x="2.5" y="2.8" width="11" height="4.2" rx="1" />
            <rect x="2.5" y="9" width="11" height="4.2" rx="1" />
            <circle cx="5" cy="4.9" r="0.7" fill="currentColor" />
            <circle cx="5" cy="11.1" r="0.7" fill="currentColor" />
          </svg>
          Racks
        </button>
      </div>
      <div
        className="office-detail-peers"
        role="group"
        aria-label="Collaborate with teammate"
      >
        <span className="office-detail-peers-label">Sync //</span>
        {peers
          .filter((p) => p.id !== member.id)
          .map((peer) => (
            <button
              key={peer.id}
              type="button"
              style={{ "--peer-color": peer.color } as CSSProperties}
              onClick={() => onVisit(peer.id)}
              title={`Send ${member.name} to collaborate with ${peer.name}`}
            >
              <i aria-hidden="true" />
              {peer.name}
            </button>
          ))}
      </div>
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
  const [inspectedId, setInspectedId] = useState<AgentId>("kern");
  const sceneRef = useRef<OfficeScene | null>(null);
  // Following a member is the same as selecting them.
  const selected: AgentId | null =
    camera === "overview" || camera === "auto" || camera === "free"
      ? null
      : camera;
  const outside = view !== "panel" && layer !== null;
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
  const toggle = (id: AgentId) => {
    setInspectedId(id);
    setCamera((current) => (current === id ? "overview" : id));
  };
  const busy = crew.members.filter((m) => m.status === "working").length;
  const activeMember =
    crew.members.find((m) => m.id === (selected ?? inspectedId)) ??
    crew.members[0];

  const handleHuddle = () => {
    if (camera !== "auto") setCamera("overview");
    sceneRef.current?.huddle?.();
    sceneRef.current?.glideTo(0.2, 9.4, 0.62);
  };

  const handlePairSync = () => {
    if (camera !== "auto") setCamera("overview");
    sceneRef.current?.pairSync?.();
    sceneRef.current?.glideTo(-0.5, -1.2, 0.48);
  };

  const handleEmote = (
    id: AgentId,
    kind: "wave" | "cheer" | "coffee" | "server",
  ) => {
    sceneRef.current?.emote?.(id, kind);
  };

  const handleVisit = (from: AgentId, to: AgentId) => {
    const peer = crew.members.find((m) => m.id === to);
    const sender = crew.members.find((m) => m.id === from);
    sceneRef.current?.visit(from, to, {
      dwell: 5.0,
      say: `Hey ${peer?.name ?? to}, let's sync on this!`,
      reply: `Sounds good, ${sender?.name ?? from} — wired up and ready.`,
    });
  };

  return (
    <div className="office-panel">
      <div className="office-telemetry">
        <div className="office-telemetry-brand">
          <span
            className={`office-telemetry-led${running ? " is-working" : ""}`}
            aria-hidden="true"
          />
          <span className="office-telemetry-title">KERN HQ</span>
          <span className="office-telemetry-sub">// 06 AGENTS</span>
          <span className="office-telemetry-meta">
            {running ? `${busy || 1} WORKING` : "IDLE"}
          </span>
        </div>
        <div className="office-telemetry-controls">
          {/* Away from the panel the away card below carries the switch. */}
          {!outside && (
            <ViewSwitch view={view} onView={(next) => onViewChange?.(next)} />
          )}
        </div>
      </div>

      {createPortal(
        <OfficeStage
          crew={crew}
          selected={selected}
          camera={camera}
          visible={visible}
          view={outside ? view : "panel"}
          sceneRef={sceneRef}
          onSelect={toggle}
          onCamera={setCamera}
          onView={(next) => onViewChange?.(next)}
          onHuddle={handleHuddle}
          onPairSync={handlePairSync}
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
        <span>
          {running
            ? busy > 1
              ? `${busy} working in parallel`
              : busy === 1
                ? `${crew.members.find((m) => m.status === "working")!.name} is working`
                : "Starting…"
            : tools.length
              ? "Turn finished"
              : "Waiting for a prompt"}
        </span>
      </div>
      <ul className="office-members">
        {crew.members.map((member) => (
          <MemberRow
            key={member.id}
            member={member}
            selected={member.id === (selected ?? inspectedId)}
            onSelect={toggle}
          />
        ))}
      </ul>
      {activeMember && (
        <MemberDetail
          member={activeMember}
          peers={crew.members}
          onEmote={(kind) => handleEmote(activeMember.id, kind)}
          onVisit={(to) => handleVisit(activeMember.id, to)}
        />
      )}
    </div>
  );
});

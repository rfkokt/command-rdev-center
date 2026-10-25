import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type { ToolCall } from "../lib/rpc";
import { STUDIO_COLORS } from "./office/office-layout";
import type { AgentId, SceneCrew } from "./office/office-motion";
import type { OfficeScene } from "./office/office-scene";
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

function OfficeStage({
  crew,
  selected,
  visible,
  onSelect,
}: {
  crew: ReturnType<typeof buildCrew>;
  selected: AgentId | null;
  visible: boolean;
  onSelect: (id: AgentId) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const latest = useRef({ crew, selected, visible, onSelect });
  latest.current = { crew, selected, visible, onSelect };
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
    const updateMotion = () =>
      sceneRef.current?.setReducedMotion(motion?.matches ?? false);
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
      void import("./office/office-scene")
        .then(({ createOfficeScene }) => {
          if (cancelled) return;
          const scene = createOfficeScene(canvas, labels, {
            onSelect: (id) => latest.current.onSelect(id),
            // Frame the six desks; the panel is far smaller than the window.
            zoom: 1.55,
            focus: { x: 2.4, z: 0.9 },
          });
          sceneRef.current = scene;
          updateTheme();
          updateMotion();
          scene.setCrew(
            sceneCrew(latest.current.crew, latest.current.selected),
          );
          scene.setSelected(latest.current.selected);
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
  useEffect(() => {
    sceneRef.current?.setSelected(selected);
  }, [selected]);
  useEffect(() => {
    sceneRef.current?.setVisible(visible && !document.hidden);
    if (visible) sceneRef.current?.resize();
  }, [visible]);

  return (
    <div
      className="office-panel-stage office-scene"
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

export default memo(function OfficePanel({
  tools,
  running,
  writing,
  visible,
}: {
  tools: readonly ToolCall[];
  running: boolean;
  writing: boolean;
  visible: boolean;
}) {
  const [selected, setSelected] = useState<AgentId | null>(null);
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
    setSelected((current) => (current === id ? null : id));
  const busy = crew.members.filter((m) => m.status === "working").length;
  const chosen = crew.members.find((m) => m.id === selected) ?? null;

  return (
    <div className="office-panel">
      <OfficeStage
        crew={crew}
        selected={selected}
        visible={visible}
        onSelect={toggle}
      />
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

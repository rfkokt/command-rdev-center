/* @refresh reset */
import { useEffect, useRef, useState } from "react";
import {
  activityFor,
  belongsToTab,
  type Activity,
  type AgentEvent,
} from "./office/office-motion";
import type { OfficeScene } from "./office/office-scene";
import "./office/office-scene.css";

const ACTIVITY_EVENTS = [
  "crc-agent-activity-sync",
  "crc-agent-activity",
  "crc-agent-prompt",
  "crc-agent-running",
] as const;

export default function BackgroundMotion({
  isWorking = false,
  isBlurred = false,
  activeTabId,
}: {
  isWorking?: boolean;
  isBlurred?: boolean;
  activeTabId?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<OfficeScene | null>(null);
  const latest = useRef({ isWorking, activeTabId });
  latest.current = { isWorking, activeTabId };
  const activityRef = useRef<Activity | null>(null);
  const [blurred, setBlurred] = useState(isBlurred);
  const [ready, setReady] = useState(false);

  useEffect(() => setBlurred(isBlurred), [isBlurred]);
  useEffect(() => {
    const onBlur = (event: Event) => {
      const value = (event as CustomEvent<{ blurred?: boolean }>).detail
        ?.blurred;
      if (typeof value === "boolean") setBlurred(value);
    };
    window.addEventListener("crc-bg-blur-changed", onBlur);
    return () => window.removeEventListener("crc-bg-blur-changed", onBlur);
  }, []);

  useEffect(() => {
    const activity = {
      id: "kern",
      working: latest.current.isWorking,
      text: latest.current.isWorking ? "Working…" : "Ready",
    } satisfies Activity;
    activityRef.current = activity;
    sceneRef.current?.setActivity(activity);
  }, [activeTabId]);
  useEffect(() => {
    if (activityRef.current)
      activityRef.current = { ...activityRef.current, working: isWorking };
    sceneRef.current?.setWorking(isWorking);
  }, [isWorking]);

  useEffect(() => {
    let cancelled = false;
    let contextAvailable = true;
    const canvas = canvasRef.current;
    const labels = labelsRef.current;
    if (!canvas || !labels) return;
    const motion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const scheme = window.matchMedia?.("(prefers-color-scheme: dark)");
    const updateTheme = () => {
      const theme = document.documentElement.dataset.theme;
      sceneRef.current?.setTheme(
        theme === "dark" || (theme !== "light" && (scheme?.matches ?? true)),
      );
    };
    const updateMotion = () =>
      sceneRef.current?.setReducedMotion(motion?.matches ?? false);
    const updateVisibility = () =>
      sceneRef.current?.setVisible(!document.hidden && contextAvailable);
    const resize = () => sceneRef.current?.resize();
    const handleActivity = (event: Event) => {
      const detail = (event as CustomEvent<AgentEvent>).detail;
      if (!detail || !belongsToTab(detail, latest.current.activeTabId)) return;
      const activity = activityFor(event.type, detail);
      if (!activity) return;
      activityRef.current = activity;
      sceneRef.current?.setActivity(activity);
    };
    ACTIVITY_EVENTS.forEach((name) =>
      window.addEventListener(name, handleActivity),
    );
    const observer = new MutationObserver(updateTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    resizeObserver?.observe(canvas.parentElement!);
    motion?.addEventListener("change", updateMotion);
    scheme?.addEventListener("change", updateTheme);
    window.addEventListener("resize", resize);
    document.addEventListener("visibilitychange", updateVisibility);
    const contextLost = (event: Event) => {
      event.preventDefault();
      contextAvailable = false;
      sceneRef.current?.setVisible(false);
      setReady(false);
    };
    const contextRestored = () => {
      // Three restores its own GPU resources in the same event dispatch.
      queueMicrotask(() => {
        if (cancelled || !sceneRef.current) return;
        contextAvailable = true;
        updateTheme();
        resize();
        updateVisibility();
        setReady(true);
      });
    };
    canvas.addEventListener("webglcontextlost", contextLost);
    canvas.addEventListener("webglcontextrestored", contextRestored);

    // Keep Three.js off the initial application bundle; collect activity during loading.
    if (typeof window.WebGL2RenderingContext !== "undefined") {
      void import("./office/office-scene")
        .then(({ createOfficeScene }) => {
          if (cancelled) return;
          sceneRef.current = createOfficeScene(canvas, labels);
          updateTheme();
          updateMotion();
          updateVisibility();
          sceneRef.current.setWorking(latest.current.isWorking);
          if (activityRef.current)
            sceneRef.current.setActivity(activityRef.current);
          setReady(true);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          sceneRef.current?.dispose();
          sceneRef.current = null;
          console.warn(
            "Office 3D unavailable; using the static office background.",
            error,
          );
          setReady(false);
        });
    }
    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
      observer.disconnect();
      resizeObserver?.disconnect();
      motion?.removeEventListener("change", updateMotion);
      scheme?.removeEventListener("change", updateTheme);
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", updateVisibility);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      ACTIVITY_EVENTS.forEach((name) =>
        window.removeEventListener(name, handleActivity),
      );
    };
  }, []);

  return (
    <div
      className={`background-motion-container office-scene${blurred ? " is-blurred" : ""}`}
      aria-hidden="true"
      data-renderer={ready ? "webgl" : "fallback"}
    >
      <div
        className={`office-scene-fallback background-motion-canvas${blurred ? " is-blurred" : ""}`}
        hidden={ready}
      />
      <canvas
        ref={canvasRef}
        className={`background-motion-canvas${blurred ? " is-blurred" : ""}`}
        style={{ opacity: ready ? undefined : 0 }}
      />
      <div
        ref={labelsRef}
        className="office-scene-labels"
        hidden={!ready || blurred}
      />
      <div className="background-motion-vignette" />
    </div>
  );
}

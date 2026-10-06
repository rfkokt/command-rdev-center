/* @refresh reset */
import { useEffect, useRef, useState } from "react";

interface SpecialistConfig {
  id: string;
  name: string;
  role: string;
  color: string;
  icon: string;
  // Normalized patch rectangle in the 2752x1536 artwork:
  rect: { x: number; y: number; w: number; h: number };
  // Normalized speech bubble anchor point above head:
  head: { x: number; y: number };
  // Home foot position on the floor plane:
  homeFoot: { x: number; y: number };
  // Walk sprite dimensions and foot anchor:
  walkW: number;
  walkH: number;
  footAnchorX: number;
  footAnchorY: number;
}

const SPECIALISTS: SpecialistConfig[] = [
  {
    id: "ada",
    name: "Ada",
    role: "Frontend Dev",
    color: "#c084fc",
    icon: "🎨",
    rect: {
      x: 1040 / 2752,
      y: 740 / 1536,
      w: 180 / 2752,
      h: 440 / 1536,
    },
    head: { x: 1130 / 2752, y: 730 / 1536 },
    homeFoot: { x: 0.428, y: 0.768 },
    walkW: 221 / 2752,
    walkH: 459 / 1536,
    footAnchorX: 0.484,
    footAnchorY: 0.937,
  },
  {
    id: "kern",
    name: "Kern",
    role: "Lead Agent",
    color: "#38bdf8",
    icon: "🧠",
    rect: {
      x: 1730 / 2752,
      y: 1050 / 1536,
      w: 220 / 2752,
      h: 260 / 1536,
    },
    head: { x: 1840 / 2752, y: 1040 / 1536 },
    homeFoot: { x: 0.648, y: 0.81 },
    walkW: 277 / 2752,
    walkH: 462 / 1536,
    footAnchorX: 0.487,
    footAnchorY: 0.937,
  },
  {
    id: "linus",
    name: "Linus",
    role: "Backend Dev",
    color: "#22c55e",
    icon: "⚙️",
    rect: {
      x: 230 / 2752,
      y: 460 / 1536,
      w: 300 / 2752,
      h: 400 / 1536,
    },
    head: { x: 420 / 2752, y: 500 / 1536 },
    homeFoot: { x: 0.17, y: 0.56 },
    walkW: 244 / 2752,
    walkH: 459 / 1536,
    footAnchorX: 0.484,
    footAnchorY: 0.937,
  },
  {
    id: "alan",
    name: "Alan",
    role: "AST & Search",
    color: "#06b6d4",
    icon: "🔍",
    rect: {
      x: 1550 / 2752,
      y: 350 / 1536,
      w: 300 / 2752,
      h: 300 / 1536,
    },
    head: { x: 1700 / 2752, y: 340 / 1536 },
    homeFoot: { x: 0.618, y: 0.42 },
    walkW: 262 / 2752,
    walkH: 462 / 1536,
    footAnchorX: 0.492,
    footAnchorY: 0.931,
  },
  {
    id: "bob",
    name: "Bob",
    role: "QA Tester",
    color: "#ec4899",
    icon: "🧪",
    rect: {
      x: 1140 / 2752,
      y: 300 / 1536,
      w: 240 / 2752,
      h: 300 / 1536,
    },
    head: { x: 1260 / 2752, y: 290 / 1536 },
    homeFoot: { x: 0.458, y: 0.38 },
    walkW: 235 / 2752,
    walkH: 454 / 1536,
    footAnchorX: 0.483,
    footAnchorY: 0.936,
  },
  {
    id: "grace",
    name: "Grace",
    role: "DevOps & Server",
    color: "#f59e0b",
    icon: "🛡️",
    rect: {
      x: 580 / 2752,
      y: 760 / 1536,
      w: 280 / 2752,
      h: 280 / 1536,
    },
    head: { x: 720 / 2752, y: 760 / 1536 },
    homeFoot: { x: 0.262, y: 0.66 },
    walkW: 245 / 2752,
    walkH: 458 / 1536,
    footAnchorX: 0.492,
    footAnchorY: 0.937,
  },
];

interface SpecialistState {
  bubbleText: string | null;
  bubbleTimer: number;
  isFocused: boolean;
}

interface Waypoint {
  x: number;
  y: number;
}

interface PatrolRoute {
  name: string;
  waypoints: Waypoint[];
  pauseSeconds: number;
}

const SPECIALIST_ROUTES: Record<string, PatrolRoute[]> = {
  ada: [
    {
      name: "coffee",
      waypoints: [
        { x: 0.428, y: 0.768 },
        { x: 0.335, y: 0.67 },
        { x: 0.24, y: 0.62 },
      ],
      pauseSeconds: 4.5,
    },
    {
      name: "kern",
      waypoints: [
        { x: 0.428, y: 0.768 },
        { x: 0.54, y: 0.768 },
      ],
      pauseSeconds: 4.0,
    },
    {
      name: "alan",
      waypoints: [
        { x: 0.428, y: 0.768 },
        { x: 0.485, y: 0.6 },
      ],
      pauseSeconds: 3.5,
    },
  ],
  linus: [
    {
      name: "deliver_kern",
      waypoints: [
        { x: 0.17, y: 0.56 },
        { x: 0.24, y: 0.62 },
        { x: 0.335, y: 0.67 },
        { x: 0.54, y: 0.768 },
      ],
      pauseSeconds: 4.0,
    },
    {
      name: "deliver_grace",
      waypoints: [
        { x: 0.17, y: 0.56 },
        { x: 0.24, y: 0.62 },
        { x: 0.285, y: 0.66 },
      ],
      pauseSeconds: 3.5,
    },
  ],
  kern: [
    {
      name: "coffee_break",
      waypoints: [
        { x: 0.648, y: 0.81 },
        { x: 0.54, y: 0.768 },
        { x: 0.335, y: 0.67 },
        { x: 0.24, y: 0.62 },
      ],
      pauseSeconds: 5.0,
    },
    {
      name: "check_alan",
      waypoints: [
        { x: 0.648, y: 0.81 },
        { x: 0.54, y: 0.768 },
        { x: 0.485, y: 0.6 },
      ],
      pauseSeconds: 4.0,
    },
  ],
  alan: [
    {
      name: "coffee_break",
      waypoints: [
        { x: 0.618, y: 0.42 },
        { x: 0.485, y: 0.6 },
        { x: 0.335, y: 0.67 },
        { x: 0.24, y: 0.62 },
      ],
      pauseSeconds: 4.5,
    },
  ],
  bob: [
    {
      name: "coffee_break",
      waypoints: [
        { x: 0.458, y: 0.38 },
        { x: 0.37, y: 0.45 },
        { x: 0.28, y: 0.53 },
        { x: 0.24, y: 0.62 },
      ],
      pauseSeconds: 4.0,
    },
  ],
  grace: [
    {
      name: "coffee_refill",
      waypoints: [
        { x: 0.262, y: 0.66 },
        { x: 0.24, y: 0.62 },
      ],
      pauseSeconds: 3.5,
    },
    {
      name: "sync_alan",
      waypoints: [
        { x: 0.262, y: 0.66 },
        { x: 0.335, y: 0.67 },
        { x: 0.485, y: 0.6 },
      ],
      pauseSeconds: 4.0,
    },
  ],
};

interface WalkerState {
  isWalking: boolean;
  curX: number;
  curY: number;
  facing: "left" | "right";
  routeIdx: number;
  wpIdx: number;
  isReturning: boolean;
  pauseTimer: number;
  idleTimer: number;
  traveledDist: number;
}

export default function BackgroundMotion({
  isWorking = false,
  isBlurred = false,
}: {
  isWorking?: boolean;
  isBlurred?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isWorkingRef = useRef(isWorking);
  isWorkingRef.current = isWorking;
  const [blurred, setBlurred] = useState(isBlurred);

  useEffect(() => {
    setBlurred(isBlurred);
  }, [isBlurred]);

  useEffect(() => {
    const handler = (e: Event) => {
      const custom = e as CustomEvent<{ blurred: boolean }>;
      if (typeof custom.detail?.blurred === "boolean") {
        setBlurred(custom.detail.blurred);
      }
    };
    window.addEventListener("crc-bg-blur-changed", handler);
    return () => window.removeEventListener("crc-bg-blur-changed", handler);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    const prefersReducedMotion =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
        : false;

    let animId = 0;
    let width = 0;
    let height = 0;

    const getIsDark = () => {
      if (typeof document === "undefined") return true;
      const theme = document.documentElement.getAttribute("data-theme");
      if (theme === "light") return false;
      if (theme === "dark") return true;
      return (
        window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true
      );
    };
    let isDark = getIsDark();

    // 1. High-resolution 2752x1536 base pixel art artworks
    const nightImg = typeof Image !== "undefined" ? new Image() : null;
    if (nightImg) nightImg.src = "/pixel_office_active_night.jpg";
    const dayImg = typeof Image !== "undefined" ? new Image() : null;
    if (dayImg) dayImg.src = "/pixel_office_active_day.jpg";

    // 2. Preload station micro-animations (night & day)
    const specialistFrames: Record<
      string,
      { night: HTMLImageElement[]; day: HTMLImageElement[] }
    > = {};

    // 3. Preload 4-frame walk cycles for all 6 specialists
    const specialistWalkFrames: Record<string, HTMLImageElement[]> = {};

    // 4. Preload empty station patches (night & day)
    const emptyStationPatches: Record<
      string,
      { night: HTMLImageElement; day: HTMLImageElement }
    > = {};

    SPECIALISTS.forEach((sp) => {
      specialistFrames[sp.id] = { night: [], day: [] };
      specialistWalkFrames[sp.id] = [];

      for (let i = 0; i < 4; i++) {
        const nImg = new Image();
        nImg.src = `/sprites/${sp.id}_frame_${i}.png`;
        specialistFrames[sp.id].night.push(nImg);

        const dImg = new Image();
        dImg.src = `/sprites/${sp.id}_day_frame_${i}.png`;
        specialistFrames[sp.id].day.push(dImg);

        const wImg = new Image();
        wImg.src = `/sprites/${sp.id}_walk_frame_${i}.png`;
        specialistWalkFrames[sp.id].push(wImg);
      }

      const emptyN = new Image();
      emptyN.src = `/sprites/${sp.id}_empty_night.png`;
      const emptyD = new Image();
      emptyD.src = `/sprites/${sp.id}_empty_day.png`;
      emptyStationPatches[sp.id] = { night: emptyN, day: emptyD };
    });

    const states: Record<string, SpecialistState> = {};
    const walkers: Record<string, WalkerState> = {};

    // Staggered initial walk start times so they don't all move at once
    const initialDelays: Record<string, number> = {
      ada: 5,
      linus: 14,
      kern: 26,
      alan: 38,
      bob: 20,
      grace: 32,
    };

    SPECIALISTS.forEach((sp) => {
      states[sp.id] = {
        bubbleText: null,
        bubbleTimer: 0,
        isFocused: false,
      };

      walkers[sp.id] = {
        isWalking: false,
        curX: sp.homeFoot.x,
        curY: sp.homeFoot.y,
        facing: "right",
        routeIdx: 0,
        wpIdx: 0,
        isReturning: false,
        pauseTimer: 0,
        idleTimer: initialDelays[sp.id] || 10,
        traveledDist: 0,
      };
    });

    let isWorkingLive = isWorking;

    const triggerWalker = (charId: string) => {
      const w = walkers[charId];
      const routes = SPECIALIST_ROUTES[charId];
      if (!w || !routes || routes.length === 0 || w.isWalking) return;
      w.isWalking = true;
      w.routeIdx = Math.floor(Math.random() * routes.length);
      w.wpIdx = 1;
      w.isReturning = false;
      w.pauseTimer = 0;
      w.traveledDist = 0;
    };

    // Synchronized listener from ChatView & Agent runs
    const handleActivitySync = (e: Event) => {
      const custom = e as CustomEvent<{
        active?: boolean;
        agentName?: string;
        title?: string;
        detail?: string;
      }>;
      const { active, agentName, title, detail } = custom.detail || {};

      if (active) {
        isWorkingLive = true;
        const targetName = (agentName || "Kern").toLowerCase();
        const matched =
          SPECIALISTS.find((s) => s.name.toLowerCase() === targetName) ||
          SPECIALISTS[0];

        SPECIALISTS.forEach((s) => {
          const st = states[s.id];
          if (s.id === matched.id) {
            st.isFocused = true;
            const clean = (detail || title || "Working…")
              .replace(/\s+/g, " ")
              .trim();
            const short = clean.length > 38 ? `${clean.slice(0, 38)}…` : clean;
            st.bubbleText = `${s.icon} ${short}`;
            st.bubbleTimer = 9;
          } else {
            st.isFocused = false;
            if (st.bubbleTimer <= 2) st.bubbleText = null;
          }
        });

        // Trigger specialist to roam or sync
        if (matched.id !== "kern") {
          triggerWalker("ada");
        }
      } else {
        isWorkingLive = false;
        SPECIALISTS.forEach((s) => {
          const st = states[s.id];
          if (st.isFocused) {
            st.bubbleText = "✅ Ready";
            st.bubbleTimer = 3;
          }
          st.isFocused = false;
        });
      }
    };

    const handleAgentPrompt = (e: Event) => {
      const custom = e as CustomEvent<{ text?: string }>;
      const text = (custom.detail?.text || "").replace(/\s+/g, " ").trim();
      if (text) {
        isWorkingLive = true;
        const short = text.length > 32 ? `${text.slice(0, 32)}…` : text;
        states["kern"].bubbleText = `🧠 Prompt: "${short}"`;
        states["kern"].bubbleTimer = 8;
        states["kern"].isFocused = true;

        SPECIALISTS.forEach((s) => {
          if (s.id !== "kern") {
            states[s.id].isFocused = false;
            states[s.id].bubbleText = null;
          }
        });

        triggerWalker("ada");
      }
    };

    const handleAgentRunning = (e: Event) => {
      const custom = e as CustomEvent<{ running?: boolean }>;
      isWorkingLive = Boolean(custom.detail?.running);
      if (!isWorkingLive) {
        SPECIALISTS.forEach((s) => {
          states[s.id].isFocused = false;
        });
      }
    };

    window.addEventListener("crc-agent-activity-sync", handleActivitySync);
    window.addEventListener("crc-agent-prompt", handleAgentPrompt);
    window.addEventListener("crc-agent-running", handleAgentRunning);

    const themeObserver =
      typeof MutationObserver !== "undefined"
        ? new MutationObserver(() => {
            isDark = getIsDark();
          })
        : null;
    if (
      themeObserver &&
      typeof document !== "undefined" &&
      document.documentElement
    ) {
      themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "style", "class"],
      });
    }

    const resize = () => {
      if (!canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const measuredW =
        canvas.parentElement?.clientWidth ||
        canvas.clientWidth ||
        window.innerWidth;
      const measuredH =
        canvas.parentElement?.clientHeight ||
        canvas.clientHeight ||
        window.innerHeight;
      width = measuredW;
      height = measuredH;
      const targetW = Math.round(width * dpr);
      const targetH = Math.round(height * dpr);
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW;
        canvas.height = targetH;
      }
      ctx.resetTransform();
      ctx.scale(dpr, dpr);
    };

    resize();
    const resizeObserver =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(canvas);
    window.addEventListener("resize", resize);

    let lastTime = performance.now();

    function render(now: number) {
      if (!ctx) return;
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      ctx.clearRect(0, 0, width, height);

      const isWorkingNow = isWorkingRef.current || isWorkingLive;
      const currentBaseImg = isDark ? nightImg : dayImg;

      // 1. Render Base Background with High-Quality Smoothing
      let dw = width;
      let dh = height;
      let dx = 0;
      let dy = 0;

      if (
        currentBaseImg &&
        currentBaseImg.complete &&
        currentBaseImg.naturalWidth > 0
      ) {
        const imgRatio =
          currentBaseImg.naturalWidth / currentBaseImg.naturalHeight;
        const canvasRatio = width / height;

        if (canvasRatio > imgRatio) {
          dw = width;
          dh = width / imgRatio;
          dy = (height - dh) / 2;
        } else {
          dh = height;
          dw = height * imgRatio;
          dx = (width - dw) / 2;
        }

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(currentBaseImg, dx, dy, dw, dh);
      } else {
        ctx.fillStyle = isDark ? "#0c0d14" : "#f1f5f9";
        ctx.fillRect(0, 0, width, height);
      }

      const pixelScale = dw / 1376;

      // 2. Update Roaming State Machine for ALL Specialists
      SPECIALISTS.forEach((sp) => {
        const w = walkers[sp.id];
        const routes = SPECIALIST_ROUTES[sp.id];
        if (!w || !routes || routes.length === 0) return;

        if (!w.isWalking) {
          w.idleTimer -= dt;
          if (w.idleTimer <= 0) {
            w.routeIdx = (w.routeIdx + 1) % routes.length;
            w.isWalking = true;
            w.wpIdx = 1;
            w.isReturning = false;
            w.pauseTimer = 0;
            w.traveledDist = 0;
          }
        } else {
          const curRoute = routes[w.routeIdx];
          const targetWp = curRoute?.waypoints[w.wpIdx];

          if (w.pauseTimer > 0) {
            w.pauseTimer -= dt;
            if (w.pauseTimer <= 0) {
              w.isReturning = true;
              w.wpIdx = curRoute.waypoints.length - 2;
            }
          } else if (targetWp) {
            const targetPxX = dx + targetWp.x * dw;
            const targetPxY = dy + targetWp.y * dh;
            const curPxX = dx + w.curX * dw;
            const curPxY = dy + w.curY * dh;

            const distPxX = targetPxX - curPxX;
            const distPxY = targetPxY - curPxY;
            const distTotal = Math.hypot(distPxX, distPxY);
            const walkSpeedPx = 46 * (dw / 1376);

            if (distTotal > 2.5) {
              const stepPx = Math.min(distTotal, walkSpeedPx * dt);
              w.curX += (distPxX / distTotal) * (stepPx / dw);
              w.curY += (distPxY / distTotal) * (stepPx / dh);
              w.traveledDist += stepPx;
              // Forward direction: sprite naturally faces RIGHT.
              // When moving left (distPxX < 0), flip horizontally.
              w.facing = distPxX < -0.4 ? "left" : "right";
            } else {
              w.curX = targetWp.x;
              w.curY = targetWp.y;

              if (!w.isReturning) {
                if (w.wpIdx < curRoute.waypoints.length - 1) {
                  w.wpIdx++;
                } else {
                  w.pauseTimer = curRoute.pauseSeconds;
                }
              } else {
                if (w.wpIdx > 0) {
                  w.wpIdx--;
                } else {
                  // Returned home!
                  w.isWalking = false;
                  w.curX = sp.homeFoot.x;
                  w.curY = sp.homeFoot.y;
                  w.facing = "right";
                  w.idleTimer = 18 + Math.random() * 16; // 18-34s at home station
                }
              }
            }
          }
        }
      });

      // 3. For any specialist walking away from home, mask their station with empty patch
      SPECIALISTS.forEach((sp) => {
        const w = walkers[sp.id];
        if (!w || !w.isWalking) return;

        const emptyPatch = emptyStationPatches[sp.id];
        const emptyImg = isDark ? emptyPatch?.night : emptyPatch?.day;

        if (emptyImg && emptyImg.complete && emptyImg.naturalWidth > 0) {
          const destX = Math.round(dx + sp.rect.x * dw);
          const destY = Math.round(dy + sp.rect.y * dh);
          const destW = Math.round(sp.rect.w * dw);
          const destH = Math.round(sp.rect.h * dh);
          ctx.drawImage(emptyImg, destX, destY, destW, destH);
        }
      });

      // 4. Render Station Specialists (when sitting/working at home)
      SPECIALISTS.forEach((sp) => {
        const w = walkers[sp.id];
        if (w && w.isWalking) return; // Rendered dynamically in walking step below

        const frameSet = specialistFrames[sp.id];
        if (!frameSet) return;
        const frames = isDark ? frameSet.night : frameSet.day;
        if (!frames || frames.length === 0) return;

        let frameIdx = 0;

        if (sp.id === "kern") {
          if (isWorkingNow || states["kern"].isFocused) {
            frameIdx = Math.floor(now / 110) % 4;
          } else {
            const burstTime = (now / 1000) % 7.5;
            frameIdx = burstTime < 3.2 ? Math.floor(now / 180) % 4 : 0;
          }
        } else if (sp.id === "linus") {
          const sipCycle = (now / 1000) % 8.2;
          if (sipCycle < 2.4) {
            const step = Math.floor((sipCycle / 2.4) * 6);
            frameIdx = [0, 1, 2, 3, 2, 1][step] || 0;
          } else {
            frameIdx = 0;
          }
        } else if (sp.id === "alan") {
          frameIdx = Math.floor(now / 220) % 4;
        } else if (sp.id === "bob") {
          const bobCycle = (now / 1000) % 5.5;
          frameIdx = bobCycle < 3 ? Math.floor(now / 340) % 4 : 0;
        } else if (sp.id === "grace") {
          frameIdx = Math.floor(now / 200) % 4;
        } else if (sp.id === "ada") {
          frameIdx = Math.floor(now / 280) % 4;
        }

        const frameImg = frames[frameIdx];
        if (frameImg && frameImg.complete && frameImg.naturalWidth > 0) {
          const destX = Math.round(dx + sp.rect.x * dw);
          const destY = Math.round(dy + sp.rect.y * dh);
          const destW = Math.round(sp.rect.w * dw);
          const destH = Math.round(sp.rect.h * dh);

          ctx.drawImage(frameImg, destX, destY, destW, destH);
        }
      });

      // 5. Render Walking Specialists (Sorted by Y for correct isometric depth)
      const activeWalkers = SPECIALISTS.filter(
        (sp) => walkers[sp.id]?.isWalking,
      ).sort((a, b) => walkers[a.id].curY - walkers[b.id].curY);

      activeWalkers.forEach((sp) => {
        const w = walkers[sp.id];
        const walkFrames = specialistWalkFrames[sp.id];
        if (!w || !walkFrames || walkFrames.length === 0) return;

        const footPxX = dx + w.curX * dw;
        const footPxY = dy + w.curY * dh;

        // Soft floor contact shadow
        ctx.save();
        ctx.fillStyle = "rgba(0, 0, 0, 0.28)";
        ctx.beginPath();
        ctx.ellipse(
          footPxX,
          footPxY - 2 * pixelScale,
          13 * pixelScale,
          6 * pixelScale,
          0,
          0,
          Math.PI * 2,
        );
        ctx.fill();
        ctx.restore();

        // 4-frame walk cycle synced with ground displacement
        const walkFrameIdx =
          w.pauseTimer > 0 ? 0 : Math.floor(w.traveledDist / 16) % 4;
        const walkImg = walkFrames[walkFrameIdx];

        if (walkImg && walkImg.complete && walkImg.naturalWidth > 0) {
          const spriteW = sp.walkW * dw;
          const spriteH = sp.walkH * dh;
          const footOffsetX = sp.footAnchorX * spriteW;
          const footOffsetY = sp.footAnchorY * spriteH;

          ctx.save();
          ctx.translate(footPxX, footPxY);
          // Sprite naturally faces RIGHT. If moving left, flip horizontally:
          if (w.facing === "left") {
            ctx.scale(-1, 1);
          }
          ctx.drawImage(walkImg, -footOffsetX, -footOffsetY, spriteW, spriteH);
          ctx.restore();
        }
      });

      // 6. Subtle Organic Ambiance (Blended lighting, no flat stickers)
      ctx.save();
      // Server room rack LEDs (soft twinkling through glass)
      if (isDark) {
        const rackX = dx + 0.435 * dw;
        const rackY = dy + 0.23 * dh;
        const ledW = Math.max(1.5, 2 * (dw / 2752));
        const ledH = Math.max(1.5, 2 * (dh / 1536));
        ctx.globalAlpha = 0.45;
        for (let i = 0; i < 4; i++) {
          const blink = Math.sin(now * 0.004 + i * 2.1) > 0.1;
          if (blink) {
            ctx.fillStyle = i % 2 === 0 ? "#22c55e" : "#06b6d4";
            ctx.fillRect(
              rackX + i * 8 * (dw / 2752),
              rackY + i * 5 * (dh / 1536),
              ledW,
              ledH,
            );
          }
        }
      }

      // Espresso machine warm glow pulsing gently
      const coffeeX = dx + 0.138 * dw;
      const coffeeY = dy + 0.418 * dh;
      const coffeePulse = 0.14 + Math.sin(now * 0.0025) * 0.04;
      const coffeeGrad = ctx.createRadialGradient(
        coffeeX,
        coffeeY,
        1,
        coffeeX,
        coffeeY,
        22 * (dw / 1376),
      );
      coffeeGrad.addColorStop(0, `rgba(249, 115, 22, ${coffeePulse})`);
      coffeeGrad.addColorStop(1, "rgba(249, 115, 22, 0)");
      ctx.fillStyle = coffeeGrad;
      ctx.beginPath();
      ctx.arc(coffeeX, coffeeY, 22 * (dw / 1376), 0, Math.PI * 2);
      ctx.fill();

      // Distant city window twinkling at night
      if (isDark) {
        const winX = dx + 0.93 * dw;
        const winY = dy + 0.28 * dh;
        const glintAlpha = 0.25 + Math.sin(now * 0.003) * 0.15;
        ctx.fillStyle = `rgba(253, 224, 71, ${glintAlpha})`;
        ctx.fillRect(winX, winY, 2, 2);
      }
      ctx.restore();

      // 7. Floating Speech Bubbles (Only when active, sleek HUD style)
      SPECIALISTS.forEach((sp) => {
        const st = states[sp.id];
        if (!st.bubbleText || st.bubbleTimer <= 0) return;

        st.bubbleTimer -= dt;
        const text = st.bubbleText;
        const fontSize = Math.max(10, Math.floor(10.5 * pixelScale));

        ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
        const textW = ctx.measureText(text).width;
        const bw = textW + 16 * pixelScale;
        const bh = 22 * pixelScale;

        // If specialist is walking, anchor bubble above their moving head
        const w = walkers[sp.id];
        let hx = dx + sp.head.x * dw;
        let hy = dy + sp.head.y * dh;
        if (w && w.isWalking) {
          hx = dx + w.curX * dw;
          hy = dy + w.curY * dh - 65 * pixelScale;
        }

        const bx = Math.max(10, Math.min(width - bw - 10, hx - bw / 2));
        const by = Math.max(10, hy - bh - 8 * pixelScale);

        ctx.save();
        // Drop shadow
        ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
        ctx.beginPath();
        ctx.roundRect(bx + 2, by + 2, bw, bh, 6);
        ctx.fill();

        // Bubble pill body
        ctx.fillStyle = isDark
          ? "rgba(15, 20, 32, 0.94)"
          : "rgba(255, 255, 255, 0.96)";
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 6);
        ctx.fill();

        // Accent border
        ctx.strokeStyle = sp.color;
        ctx.lineWidth = 1.4;
        ctx.stroke();

        // Text
        ctx.fillStyle = isDark ? "#f8fafc" : "#0f172a";
        ctx.fillText(text, bx + 8 * pixelScale, by + bh * 0.68);
        ctx.restore();
      });

      if (!prefersReducedMotion) {
        animId = requestAnimationFrame(render);
      }
    }

    animId = requestAnimationFrame(render);

    const handleVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(animId);
      } else if (!prefersReducedMotion) {
        lastTime = performance.now();
        animId = requestAnimationFrame(render);
      }
    };

    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      cancelAnimationFrame(animId);
      resizeObserver?.disconnect();
      themeObserver?.disconnect();
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", resize);
        window.removeEventListener(
          "crc-agent-activity-sync",
          handleActivitySync,
        );
        window.removeEventListener("crc-agent-prompt", handleAgentPrompt);
        window.removeEventListener("crc-agent-running", handleAgentRunning);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, []);

  return (
    <div
      className={`background-motion-container${blurred ? " is-blurred" : ""}`}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        width: "100%",
        height: "100%",
        overflow: "hidden",
        pointerEvents: "none",
        userSelect: "none",
        touchAction: "none",
        zIndex: 0,
      }}
      aria-hidden="true"
    >
      <canvas
        ref={canvasRef}
        className={`background-motion-canvas${blurred ? " is-blurred" : ""}`}
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          width: "100%",
          height: "100%",
          maxWidth: "100%",
          maxHeight: "100%",
          display: "block",
          pointerEvents: "none",
          filter: blurred ? "blur(14px) saturate(0.65)" : "none",
          opacity: blurred ? 0.38 : 1,
          transform: blurred ? "scale(1.04)" : "scale(1)",
          transition:
            "filter 0.35s ease, opacity 0.35s ease, transform 0.35s ease",
        }}
      />
      <div
        className="background-motion-vignette"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

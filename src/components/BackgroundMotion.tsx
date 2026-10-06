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
}

const SPECIALISTS: SpecialistConfig[] = [
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
  },
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

const ADA_HOME_FOOT = { x: 0.428, y: 0.768 };

const PATROL_ROUTES: PatrolRoute[] = [
  {
    name: "coffee",
    waypoints: [
      ADA_HOME_FOOT,
      { x: 0.335, y: 0.67 }, // Walkway next to table
      { x: 0.24, y: 0.62 }, // Coffee station near Linus
    ],
    pauseSeconds: 4.5,
  },
  {
    name: "kern",
    waypoints: [
      ADA_HOME_FOOT,
      { x: 0.54, y: 0.768 }, // Beside Kern's desk
    ],
    pauseSeconds: 4.0,
  },
  {
    name: "alan",
    waypoints: [
      ADA_HOME_FOOT,
      { x: 0.485, y: 0.6 }, // Between desks near Alan
    ],
    pauseSeconds: 3.5,
  },
];

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

    // 2. Preload animation frames for all 6 specialists (night & day)
    const specialistFrames: Record<
      string,
      { night: HTMLImageElement[]; day: HTMLImageElement[] }
    > = {};

    SPECIALISTS.forEach((sp) => {
      specialistFrames[sp.id] = { night: [], day: [] };
      for (let i = 0; i < 4; i++) {
        const nImg = new Image();
        nImg.src = `/sprites/${sp.id}_frame_${i}.png`;
        specialistFrames[sp.id].night.push(nImg);

        const dImg = new Image();
        dImg.src = `/sprites/${sp.id}_day_frame_${i}.png`;
        specialistFrames[sp.id].day.push(dImg);
      }
    });

    // 3. Preload Ada walking cycle frames and empty floor patch
    const adaWalkFrames: HTMLImageElement[] = [];
    for (let i = 0; i < 4; i++) {
      const wImg = new Image();
      wImg.src = `/sprites/ada_walk_frame_${i}.png`;
      adaWalkFrames.push(wImg);
    }

    const adaEmptyNight = new Image();
    adaEmptyNight.src = "/sprites/ada_empty_night.png";
    const adaEmptyDay = new Image();
    adaEmptyDay.src = "/sprites/ada_empty_day.png";

    const states: Record<string, SpecialistState> = {};
    SPECIALISTS.forEach((sp) => {
      states[sp.id] = {
        bubbleText: null,
        bubbleTimer: 0,
        isFocused: false,
      };
    });

    // Ada roaming state
    let adaWalking = false;
    let adaCurX = ADA_HOME_FOOT.x;
    let adaCurY = ADA_HOME_FOOT.y;
    let adaFacing: "left" | "right" = "left";
    let adaRouteIdx = 0;
    let adaWpIdx = 0;
    let adaIsReturning = false;
    let adaPauseTimer = 0;
    let adaIdleTimer = 8 + Math.random() * 6; // starts roaming within 8-14s
    let adaTraveledDist = 0;

    let isWorkingLive = isWorking;

    // Trigger roaming walk towards active agent
    const triggerAdaPatrol = (routeIndex = 0) => {
      if (adaWalking) return;
      adaWalking = true;
      adaRouteIdx = routeIndex % PATROL_ROUTES.length;
      adaWpIdx = 1;
      adaIsReturning = false;
      adaPauseTimer = 0;
      adaTraveledDist = 0;
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

        // Ada roams towards the active specialist
        if (matched.id === "linus")
          triggerAdaPatrol(0); // Coffee
        else if (matched.id === "kern")
          triggerAdaPatrol(1); // Kern
        else if (matched.id === "alan") triggerAdaPatrol(2); // Alan
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

        // Trigger Ada to walk to Kern when prompt is received
        triggerAdaPatrol(1);
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

      // 2. Ada Walking & Roaming State Machine
      const curRoute = PATROL_ROUTES[adaRouteIdx];

      if (!adaWalking) {
        adaIdleTimer -= dt;
        if (adaIdleTimer <= 0) {
          adaRouteIdx = (adaRouteIdx + 1) % PATROL_ROUTES.length;
          adaWalking = true;
          adaWpIdx = 1;
          adaIsReturning = false;
          adaPauseTimer = 0;
          adaTraveledDist = 0;
        }
      } else {
        const targetWp = curRoute.waypoints[adaWpIdx];

        if (adaPauseTimer > 0) {
          adaPauseTimer -= dt;
          if (adaPauseTimer <= 0) {
            adaIsReturning = true;
            adaWpIdx = curRoute.waypoints.length - 2;
          }
        } else if (targetWp) {
          const targetPxX = dx + targetWp.x * dw;
          const targetPxY = dy + targetWp.y * dh;
          const curPxX = dx + adaCurX * dw;
          const curPxY = dy + adaCurY * dh;

          const distPxX = targetPxX - curPxX;
          const distPxY = targetPxY - curPxY;
          const distTotal = Math.hypot(distPxX, distPxY);
          const walkSpeedPx = 48 * (dw / 1376);

          if (distTotal > 2.5) {
            const stepPx = Math.min(distTotal, walkSpeedPx * dt);
            adaCurX += (distPxX / distTotal) * (stepPx / dw);
            adaCurY += (distPxY / distTotal) * (stepPx / dh);
            adaTraveledDist += stepPx;
            adaFacing = distPxX < -0.5 ? "left" : "right";
          } else {
            adaCurX = targetWp.x;
            adaCurY = targetWp.y;

            if (!adaIsReturning) {
              if (adaWpIdx < curRoute.waypoints.length - 1) {
                adaWpIdx++;
              } else {
                // Reached destination, pause for a moment
                adaPauseTimer = curRoute.pauseSeconds;
              }
            } else {
              if (adaWpIdx > 0) {
                adaWpIdx--;
              } else {
                // Returned home!
                adaWalking = false;
                adaCurX = ADA_HOME_FOOT.x;
                adaCurY = ADA_HOME_FOOT.y;
                adaFacing = "left";
                adaIdleTimer = 16 + Math.random() * 8; // 16-24s idle at desk
              }
            }
          }
        }
      }

      // If Ada is walking away from home, mask her original home position with empty floor
      if (adaWalking) {
        const emptyFloorImg = isDark ? adaEmptyNight : adaEmptyDay;
        if (
          emptyFloorImg &&
          emptyFloorImg.complete &&
          emptyFloorImg.naturalWidth > 0
        ) {
          const spAda = SPECIALISTS.find((s) => s.id === "ada")!;
          const homeX = Math.round(dx + spAda.rect.x * dw);
          const homeY = Math.round(dy + spAda.rect.y * dh);
          const homeW = Math.round(spAda.rect.w * dw);
          const homeH = Math.round(spAda.rect.h * dh);
          ctx.drawImage(emptyFloorImg, homeX, homeY, homeW, homeH);
        }
      }

      // 3. Render Station Specialists (Kern, Linus, Alan, Bob, Grace, and Ada when at home)
      SPECIALISTS.forEach((sp) => {
        // When Ada is roaming, her walking sprite is rendered dynamically below
        if (sp.id === "ada" && adaWalking) return;

        const frameSet = specialistFrames[sp.id];
        if (!frameSet) return;
        const frames = isDark ? frameSet.night : frameSet.day;
        if (!frames || frames.length === 0) return;

        let frameIdx = 0;

        if (sp.id === "kern") {
          // Kern: rapid typing when working, natural typing bursts when idle
          if (isWorkingNow || states["kern"].isFocused) {
            frameIdx = Math.floor(now / 110) % 4;
          } else {
            const burstTime = (now / 1000) % 7.5;
            frameIdx = burstTime < 3.2 ? Math.floor(now / 180) % 4 : 0;
          }
        } else if (sp.id === "linus") {
          // Linus: sips coffee smoothly every ~8 seconds
          const sipCycle = (now / 1000) % 8.2;
          if (sipCycle < 2.4) {
            const step = Math.floor((sipCycle / 2.4) * 6);
            frameIdx = [0, 1, 2, 3, 2, 1][step] || 0;
          } else {
            frameIdx = 0;
          }
        } else if (sp.id === "alan") {
          // Alan: typing & reviewing dual monitors
          frameIdx = Math.floor(now / 220) % 4;
        } else if (sp.id === "bob") {
          // Bob: checking server cables in server room
          const bobCycle = (now / 1000) % 5.5;
          frameIdx = bobCycle < 3 ? Math.floor(now / 340) % 4 : 0;
        } else if (sp.id === "grace") {
          // Grace: typing on laptop
          frameIdx = Math.floor(now / 200) % 4;
        } else if (sp.id === "ada") {
          // Ada: tablet review and UI checking at home spot
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

      // 4. Render Ada Walking Sprite (when roaming)
      if (adaWalking) {
        const footPxX = dx + adaCurX * dw;
        const footPxY = dy + adaCurY * dh;
        const pixelScale = dw / 1376;

        // Soft floor contact shadow directly beneath feet
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

        // 4-frame walk cycle synced with ground displacement (zero sliding)
        const walkFrameIdx =
          adaPauseTimer > 0 ? 0 : Math.floor(adaTraveledDist / 16) % 4;
        const walkImg = adaWalkFrames[walkFrameIdx];

        if (walkImg && walkImg.complete && walkImg.naturalWidth > 0) {
          const spriteW = (221 / 2752) * dw;
          const spriteH = (459 / 1536) * dh;
          const footOffsetX = (116 / 221) * spriteW;
          const footOffsetY = (424 / 459) * spriteH;

          ctx.save();
          ctx.translate(footPxX, footPxY);
          if (adaFacing === "right") {
            ctx.scale(-1, 1);
          }
          ctx.drawImage(walkImg, -footOffsetX, -footOffsetY, spriteW, spriteH);
          ctx.restore();
        }
      }

      // 5. Subtle Organic Ambiance (Blended lighting, no flat stickers)
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

      // 6. Floating Speech Bubbles (Only when active, sleek HUD style)
      SPECIALISTS.forEach((sp) => {
        const st = states[sp.id];
        if (!st.bubbleText || st.bubbleTimer <= 0) return;

        st.bubbleTimer -= dt;
        const text = st.bubbleText;
        const pixelScale = dw / 1376;
        const fontSize = Math.max(10, Math.floor(10.5 * pixelScale));

        ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`;
        const textW = ctx.measureText(text).width;
        const bw = textW + 16 * pixelScale;
        const bh = 22 * pixelScale;

        // If Ada is walking, anchor bubble above her moving head
        let hx = dx + sp.head.x * dw;
        let hy = dy + sp.head.y * dh;
        if (sp.id === "ada" && adaWalking) {
          hx = dx + adaCurX * dw;
          hy = dy + adaCurY * dh - 65 * pixelScale;
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

        // Subtle accent border
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

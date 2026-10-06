/* @refresh reset */
import { useEffect, useRef, useState } from "react";

interface OfficeSpecialist {
  id: string;
  name: string;
  role: string;
  color: string;
  icon: string;
  // Normalized coordinates in the 2752x1536 artwork:
  x: number;
  y: number;
  state: "typing" | "coffee" | "server" | "mobile" | "idle";
  bubbleText: string | null;
  bubbleTimer: number;
  isCurrentFocus: boolean;
}

const SPECIALISTS_BASE: OfficeSpecialist[] = [
  {
    id: "kern",
    name: "Kern",
    role: "Lead Agent",
    color: "#38bdf8",
    icon: "🧠",
    x: 0.642,
    y: 0.723,
    state: "typing",
    bubbleText: null,
    bubbleTimer: 0,
    isCurrentFocus: false,
  },
  {
    id: "ada",
    name: "Ada",
    role: "Frontend Dev",
    color: "#c084fc",
    icon: "🎨",
    x: 0.406,
    y: 0.574,
    state: "mobile",
    bubbleText: null,
    bubbleTimer: 0,
    isCurrentFocus: false,
  },
  {
    id: "linus",
    name: "Linus",
    role: "Backend Dev",
    color: "#22c55e",
    icon: "⚙️",
    x: 0.157,
    y: 0.446,
    state: "coffee",
    bubbleText: null,
    bubbleTimer: 0,
    isCurrentFocus: false,
  },
  {
    id: "alan",
    name: "Alan",
    role: "AST & Search",
    color: "#06b6d4",
    icon: "🔍",
    x: 0.565,
    y: 0.546,
    state: "typing",
    bubbleText: null,
    bubbleTimer: 0,
    isCurrentFocus: false,
  },
  {
    id: "bob",
    name: "Bob",
    role: "QA Tester",
    color: "#ec4899",
    icon: "🧪",
    x: 0.436,
    y: 0.28,
    state: "server",
    bubbleText: null,
    bubbleTimer: 0,
    isCurrentFocus: false,
  },
  {
    id: "grace",
    name: "Grace",
    role: "DevOps & Server",
    color: "#f59e0b",
    icon: "🛡️",
    x: 0.26,
    y: 0.569,
    state: "typing",
    bubbleText: null,
    bubbleTimer: 0,
    isCurrentFocus: false,
  },
];

interface FlyingEnvelope {
  startX: number;
  startY: number;
  targetX: number;
  targetY: number;
  progress: number;
  speed: number;
  color: string;
}

interface SteamParticle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  alpha: number;
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

    // High resolution 2752x1536 unified pixel art backgrounds
    const nightImg = typeof Image !== "undefined" ? new Image() : null;
    if (nightImg) nightImg.src = "/pixel_office_active_night.jpg";
    const dayImg = typeof Image !== "undefined" ? new Image() : null;
    if (dayImg) dayImg.src = "/pixel_office_active_day.jpg";

    const specialists: OfficeSpecialist[] = SPECIALISTS_BASE.map((s) => ({
      ...s,
    }));
    const envelopes: FlyingEnvelope[] = [];
    const steamParticles: SteamParticle[] = [];
    let isWorkingLive = isWorking;

    // Synchronized listener from ChatView
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
          specialists.find((s) => s.name.toLowerCase() === targetName) ||
          specialists[0];

        // Send a flying origami task envelope from Kern to specialist
        if (matched.id !== "kern") {
          envelopes.push({
            startX: specialists[0].x,
            startY: specialists[0].y,
            targetX: matched.x,
            targetY: matched.y,
            progress: 0,
            speed: 0.038,
            color: matched.color,
          });
        }

        specialists.forEach((s) => {
          if (s.id === matched.id) {
            s.isCurrentFocus = true;
            const clean = (detail || title || "Working…")
              .replace(/\s+/g, " ")
              .trim();
            const short = clean.length > 36 ? `${clean.slice(0, 36)}…` : clean;
            s.bubbleText = `${s.icon} ${short}`;
            s.bubbleTimer = 10;
          } else {
            s.isCurrentFocus = false;
            if (s.bubbleTimer <= 2) s.bubbleText = null;
          }
        });
      } else {
        isWorkingLive = false;
        specialists.forEach((s) => {
          if (s.isCurrentFocus) {
            s.bubbleText = "✅ Done";
            s.bubbleTimer = 3.5;
          }
          s.isCurrentFocus = false;
        });
      }
    };

    const handleAgentPrompt = (e: Event) => {
      const custom = e as CustomEvent<{ text?: string }>;
      const text = (custom.detail?.text || "").replace(/\s+/g, " ").trim();
      if (text) {
        isWorkingLive = true;
        const short = text.length > 30 ? `${text.slice(0, 30)}…` : text;
        specialists[0].bubbleText = `🧠 Prompt: "${short}"`;
        specialists[0].bubbleTimer = 9;
        specialists[0].isCurrentFocus = true;

        for (let i = 1; i < specialists.length; i++) {
          specialists[i].isCurrentFocus = false;
          specialists[i].bubbleText = null;
        }
      }
    };

    const handleAgentRunning = (e: Event) => {
      const custom = e as CustomEvent<{ running?: boolean }>;
      isWorkingLive = Boolean(custom.detail?.running);
      if (!isWorkingLive) {
        specialists.forEach((s) => {
          s.isCurrentFocus = false;
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
    let tick = 0;

    function render(now: number) {
      if (!ctx) return;
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      tick++;

      ctx.clearRect(0, 0, width, height);

      const isWorkingNow = isWorkingRef.current || isWorkingLive;
      const currentImg = isDark ? nightImg : dayImg;

      // 1. Draw High-Resolution Background with High-Quality Smoothing (eliminates pecah-pecah)
      let dw = width;
      let dh = height;
      let dx = 0;
      let dy = 0;

      if (currentImg && currentImg.complete && currentImg.naturalWidth > 0) {
        const imgRatio = currentImg.naturalWidth / currentImg.naturalHeight;
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

        // Enable high-quality smoothing for crystal-clear Retina rendering
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(currentImg, dx, dy, dw, dh);
      } else {
        ctx.fillStyle = isDark ? "#0c0d14" : "#f1f5f9";
        ctx.fillRect(0, 0, width, height);
      }

      const pixelScale = dw / 1376;

      // 2. Live Animated Code Lines on Kern's Monitors (x: ~0.642, y: ~0.723)
      const kernMonX = dx + 0.62 * dw;
      const kernMonY = dy + 0.665 * dh;
      const monW = 55 * pixelScale;
      const monH = 34 * pixelScale;

      ctx.save();
      // Monitor screen ambient glow
      const monGlow = 0.25 + Math.sin(tick * 0.1) * 0.08;
      ctx.fillStyle = `rgba(56, 189, 248, ${monGlow * 0.2})`;
      ctx.fillRect(kernMonX - 4, kernMonY - 4, monW + 8, monH + 8);

      // Scrolling code lines
      for (let line = 0; line < 5; line++) {
        const lineY = kernMonY + ((line * 6 + tick * 0.8) % monH);
        const lineW = (18 + ((line * 17) % 24)) * pixelScale;
        ctx.fillStyle =
          line % 2 === 0
            ? "rgba(56, 189, 248, 0.65)"
            : "rgba(168, 85, 247, 0.55)";
        ctx.fillRect(kernMonX + 6 * pixelScale, lineY, lineW, 1.6 * pixelScale);
      }

      // Kern's typing hands micro-animation
      const typingBob = Math.sin(tick * 0.35) * 1.2 * pixelScale;
      ctx.fillStyle = isDark
        ? "rgba(254, 215, 170, 0.85)"
        : "rgba(217, 119, 6, 0.85)";
      ctx.fillRect(
        dx + 0.64 * dw + typingBob,
        dy + 0.732 * dh,
        4 * pixelScale,
        2 * pixelScale,
      );
      ctx.fillRect(
        dx + 0.648 * dw - typingBob,
        dy + 0.73 * dh,
        4 * pixelScale,
        2 * pixelScale,
      );
      ctx.restore();

      // 3. Live Animated Code Lines on Alan's Monitors (x: ~0.565, y: ~0.546)
      ctx.save();
      const alanMonX = dx + 0.552 * dw;
      const alanMonY = dy + 0.5 * dh;
      for (let line = 0; line < 4; line++) {
        const lineY = alanMonY + ((line * 5 + tick * 0.6) % (24 * pixelScale));
        const lineW = (14 + ((line * 11) % 18)) * pixelScale;
        ctx.fillStyle = "rgba(34, 197, 94, 0.6)";
        ctx.fillRect(alanMonX, lineY, lineW, 1.4 * pixelScale);
      }
      ctx.restore();

      // 4. Grace's Laptop Screen Glow (x: ~0.260, y: ~0.569)
      ctx.save();
      const graceLapX = dx + 0.248 * dw;
      const graceLapY = dy + 0.572 * dh;
      const lapGlow = 0.35 + Math.sin(tick * 0.15) * 0.1;
      ctx.fillStyle = `rgba(56, 189, 248, ${lapGlow * 0.4})`;
      ctx.fillRect(graceLapX, graceLapY, 14 * pixelScale, 10 * pixelScale);
      ctx.fillStyle = "#38bdf8";
      ctx.fillRect(
        graceLapX + 2,
        graceLapY + 3 + ((tick * 0.4) % 6),
        8 * pixelScale,
        1.2 * pixelScale,
      );
      ctx.restore();

      // 5. Ada's Tablet Screen Glow & Subtle Posture Breathing (x: ~0.406, y: ~0.574)
      ctx.save();
      const adaTabX = dx + 0.412 * dw;
      const adaTabY = dy + 0.565 * dh;
      const tabPulse = 0.4 + Math.sin(tick * 0.2) * 0.2;
      ctx.fillStyle = `rgba(192, 132, 252, ${tabPulse * 0.6})`;
      ctx.fillRect(adaTabX, adaTabY, 12 * pixelScale, 9 * pixelScale);
      ctx.restore();

      // 6. Server Room Blinking Status LEDs (Bob's area inside glass room)
      if (isDark) {
        const ledPositions = [
          [0.42, 0.25],
          [0.435, 0.23],
          [0.45, 0.21],
          [0.465, 0.19],
          [0.48, 0.22],
          [0.495, 0.24],
        ];
        ledPositions.forEach(([lx, ly], idx) => {
          const pulse = Math.sin(tick * 0.18 + idx * 1.5);
          if (pulse > 0.1) {
            const sx = dx + lx * dw;
            const sy = dy + ly * dh;
            ctx.fillStyle =
              idx % 3 === 0 ? "#38bdf8" : idx % 3 === 1 ? "#22c55e" : "#f59e0b";
            ctx.shadowColor = ctx.fillStyle;
            ctx.shadowBlur = 5 * pixelScale;
            ctx.fillRect(sx, sy, 2.5 * pixelScale, 2.5 * pixelScale);
            ctx.shadowBlur = 0;
          }
        });
      }

      // 7. Coffee Machine Steam Wisps & Linus's Coffee Sipping
      if (Math.random() < 0.24) {
        steamParticles.push({
          x: dx + 0.14 * dw + (Math.random() - 0.5) * 6 * pixelScale,
          y: dy + 0.415 * dh,
          vx: (Math.random() - 0.5) * 0.25,
          vy: -0.6 - Math.random() * 0.4,
          alpha: 0.5,
        });
      }
      for (let s = steamParticles.length - 1; s >= 0; s--) {
        const sp = steamParticles[s];
        sp.x += sp.vx;
        sp.y += sp.vy;
        sp.alpha -= 0.016;
        if (sp.alpha <= 0) {
          steamParticles.splice(s, 1);
          continue;
        }
        ctx.fillStyle = `rgba(255, 255, 255, ${sp.alpha * 0.35})`;
        ctx.fillRect(sp.x, sp.y, 2.5 * pixelScale, 2.5 * pixelScale);
      }

      // Linus's mug lift sip animation (every ~8 seconds)
      const sipCycle = (tick * 0.03) % (Math.PI * 2);
      if (sipCycle > Math.PI * 1.6) {
        // Arm lifting mug to mouth
        const liftY =
          Math.sin((sipCycle - Math.PI * 1.6) * 2.5) * 4 * pixelScale;
        ctx.save();
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(
          dx + 0.162 * dw,
          dy + 0.435 * dh - liftY,
          4 * pixelScale,
          5 * pixelScale,
        );
        ctx.restore();
      }

      // 8. Flying Origami Task Envelopes between Specialists
      for (let i = envelopes.length - 1; i >= 0; i--) {
        const env = envelopes[i];
        env.progress += env.speed;
        if (env.progress >= 1) {
          envelopes.splice(i, 1);
          continue;
        }

        const p0x = dx + env.startX * dw;
        const p0y = dy + env.startY * dh;
        const p2x = dx + env.targetX * dw;
        const p2y = dy + env.targetY * dh;
        const p1x = (p0x + p2x) / 2;
        const p1y = Math.min(p0y, p2y) - 45 * pixelScale;

        const t = env.progress;
        const curX =
          (1 - t) * (1 - t) * p0x + 2 * (1 - t) * t * p1x + t * t * p2x;
        const curY =
          (1 - t) * (1 - t) * p0y + 2 * (1 - t) * t * p1y + t * t * p2y;

        const envSz = 9 * pixelScale;
        ctx.save();
        ctx.fillStyle = "#ffffff";
        ctx.shadowColor = env.color;
        ctx.shadowBlur = 8;
        ctx.fillRect(curX - envSz / 2, curY - envSz / 3, envSz, envSz * 0.7);

        ctx.strokeStyle = env.color;
        ctx.lineWidth = 1.2;
        ctx.strokeRect(curX - envSz / 2, curY - envSz / 3, envSz, envSz * 0.7);

        ctx.beginPath();
        ctx.moveTo(curX - envSz / 2, curY - envSz / 3);
        ctx.lineTo(curX, curY + 1);
        ctx.lineTo(curX + envSz / 2, curY - envSz / 3);
        ctx.stroke();
        ctx.restore();
      }

      // 9. Specialists Active Spotlights & Floating Speech Bubbles
      specialists.forEach((sp) => {
        const sx = dx + sp.x * dw;
        const sy = dy + sp.y * dh;

        // Active Spotlight Halo on floor when focused or working
        if (sp.isCurrentFocus || (isWorkingNow && sp.id === "kern")) {
          const haloPulse = 1 + Math.sin(tick * 0.2) * 0.12;
          const haloRadius = 26 * pixelScale * haloPulse;

          const grad = ctx.createRadialGradient(sx, sy, 2, sx, sy, haloRadius);
          grad.addColorStop(0, `${sp.color}55`);
          grad.addColorStop(0.7, `${sp.color}15`);
          grad.addColorStop(1, "rgba(0, 0, 0, 0)");
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.ellipse(
            sx,
            sy,
            haloRadius * 1.3,
            haloRadius * 0.65,
            0,
            0,
            Math.PI * 2,
          );
          ctx.fill();

          ctx.strokeStyle = sp.color;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Floating Speech Bubble anchored right above specialist's head
        if (sp.bubbleText && sp.bubbleTimer > 0) {
          sp.bubbleTimer -= dt;
          const text = sp.bubbleText;
          ctx.font = `bold ${Math.max(10, Math.floor(10.5 * pixelScale))}px monospace, sans-serif`;
          const textW = ctx.measureText(text).width;
          const bw = textW + 16 * pixelScale;
          const bh = 22 * pixelScale;

          const bx = Math.max(12, Math.min(width - bw - 12, sx - bw / 2));
          const by = Math.max(12, sy - 64 * pixelScale);

          // Drop shadow
          ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
          ctx.fillRect(bx + 2, by + 2, bw, bh);

          // Bubble background
          ctx.fillStyle = isDark ? "#111422" : "#ffffff";
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeStyle = sp.color;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(bx, by, bw, bh);

          // Bubble pointer
          ctx.beginPath();
          ctx.moveTo(sx - 3, by + bh);
          ctx.lineTo(sx + 3, by + bh);
          ctx.lineTo(sx, by + bh + 4 * pixelScale);
          ctx.closePath();
          ctx.fillStyle = isDark ? "#111422" : "#ffffff";
          ctx.fill();
          ctx.strokeStyle = sp.color;
          ctx.stroke();

          // Bubble text
          ctx.fillStyle = isDark ? "#f8fafc" : "#0f172a";
          ctx.fillText(text, bx + 8 * pixelScale, by + bh * 0.68);
        }
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

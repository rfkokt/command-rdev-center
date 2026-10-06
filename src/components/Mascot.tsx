export const characters = [
  "blue",
  "mint",
  "orange",
  "purple",
  "yellow",
  "red",
] as const;

export type CharacterName = (typeof characters)[number];

interface AgentProfile {
  name: string;
  role: string;
  hair: string;
  shirt: string;
  accent: string;
}

export const AGENT_PROFILES: Record<string, AgentProfile> = {
  blue: {
    name: "Kern",
    role: "Lead Agent",
    hair: "#cbd5e1",
    shirt: "#334155",
    accent: "#38bdf8",
  },
  kern: {
    name: "Kern",
    role: "Lead Agent",
    hair: "#cbd5e1",
    shirt: "#334155",
    accent: "#38bdf8",
  },
  purple: {
    name: "Ada",
    role: "Frontend Dev",
    hair: "#c084fc",
    shirt: "#7c3aed",
    accent: "#a855f7",
  },
  ada: {
    name: "Ada",
    role: "Frontend Dev",
    hair: "#c084fc",
    shirt: "#7c3aed",
    accent: "#a855f7",
  },
  mint: {
    name: "Linus",
    role: "Backend Dev",
    hair: "#22c55e",
    shirt: "#15803d",
    accent: "#22c55e",
  },
  linus: {
    name: "Linus",
    role: "Backend Dev",
    hair: "#22c55e",
    shirt: "#15803d",
    accent: "#22c55e",
  },
  orange: {
    name: "Alan",
    role: "AST & Search",
    hair: "#f97316",
    shirt: "#0284c7",
    accent: "#06b6d4",
  },
  alan: {
    name: "Alan",
    role: "AST & Search",
    hair: "#f97316",
    shirt: "#0284c7",
    accent: "#06b6d4",
  },
  yellow: {
    name: "Grace",
    role: "DevOps & Server",
    hair: "#facc15",
    shirt: "#d97706",
    accent: "#f59e0b",
  },
  grace: {
    name: "Grace",
    role: "DevOps & Server",
    hair: "#facc15",
    shirt: "#d97706",
    accent: "#f59e0b",
  },
  red: {
    name: "Bob",
    role: "QA Tester",
    hair: "#ef4444",
    shirt: "#b91c1c",
    accent: "#ec4899",
  },
  bob: {
    name: "Bob",
    role: "QA Tester",
    hair: "#ef4444",
    shirt: "#b91c1c",
    accent: "#ec4899",
  },
};

/** Stable identity keeps each specialist recognizable across views and reloads. */
export function characterFor(identity?: string): CharacterName {
  if (!identity) return characters[0];
  const lower = identity.toLowerCase();
  if (lower === "kern" || lower.includes("lead")) return "blue";
  if (lower === "ada" || lower.includes("frontend") || lower.includes("ui"))
    return "purple";
  if (lower === "linus" || lower.includes("backend")) return "mint";
  if (lower === "alan" || lower.includes("search") || lower.includes("graph"))
    return "orange";
  if (lower === "grace" || lower.includes("devops") || lower.includes("infra"))
    return "yellow";
  if (lower === "bob" || lower.includes("qa") || lower.includes("test"))
    return "red";

  if ((characters as readonly string[]).includes(identity))
    return identity as CharacterName;
  let hash = 0;
  for (const character of identity)
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return characters[hash % characters.length];
}

export function PixelAgentSprite({
  character,
  isWorking,
}: {
  character: string;
  isWorking: boolean;
}) {
  const profile = AGENT_PROFILES[character] || AGENT_PROFILES.blue;
  const isKern = character === "blue" || character === "kern";
  const isAda = character === "purple" || character === "ada";
  const isLinus = character === "mint" || character === "linus";
  const isAlan = character === "orange" || character === "alan";
  const isGrace = character === "yellow" || character === "grace";
  const isBob = character === "red" || character === "bob";

  return (
    <svg
      className="pixel-agent-sprite"
      viewBox="0 0 16 16"
      width="100%"
      height="100%"
      style={{
        shapeRendering: "crispEdges",
        imageRendering: "pixelated",
        display: "block",
      }}
      aria-hidden="true"
    >
      {/* Chair Backrest */}
      <rect x="3" y="3" width="10" height="9" fill="#1e293b" />
      <rect x="2" y="4" width="1" height="7" fill="#0f172a" />
      <rect x="13" y="4" width="1" height="7" fill="#0f172a" />

      {/* Hair Top & Base */}
      <rect x="4" y="2" width="8" height="3" fill={profile.hair} />
      <rect x="3" y="3" width="2" height="4" fill={profile.hair} />
      <rect x="11" y="3" width="2" height="4" fill={profile.hair} />

      {/* Specialist Distinctive Hair Accessories / Silhouettes */}
      {isAda && (
        <>
          {/* Twin Buns & Ribbons */}
          <rect x="1" y="1" width="3" height="3" fill="#a855f7" />
          <rect x="12" y="1" width="3" height="3" fill="#a855f7" />
          <rect x="2" y="3" width="2" height="1" fill="#f43f5e" />
          <rect x="12" y="3" width="2" height="1" fill="#f43f5e" />
          {/* Glowing Headphones */}
          <rect x="2" y="5" width="2" height="3" fill="#d946ef" />
          <rect x="12" y="5" width="2" height="3" fill="#d946ef" />
          <rect x="3" y="2" width="10" height="1" fill="#4c1d95" />
        </>
      )}

      {isGrace && (
        <>
          {/* High Ponytail & Ribbon */}
          <rect x="11" y="0" width="3" height="4" fill="#eab308" />
          <rect x="10" y="2" width="2" height="1" fill="#f59e0b" />
          {/* Ear-comm */}
          <rect x="11" y="6" width="1" height="1" fill="#22c55e" />
        </>
      )}

      {isBob && (
        <>
          {/* Backwards Red Baseball Cap */}
          <rect x="3" y="1" width="10" height="3" fill="#dc2626" />
          <rect x="2" y="3" width="2" height="1" fill="#991b1b" />
          <rect x="7" y="2" width="2" height="1" fill="#ffffff" />
        </>
      )}

      {isAlan && (
        <>
          {/* Orange Anime Spikes */}
          <rect x="5" y="0" width="2" height="2" fill="#fdba74" />
          <rect x="9" y="0" width="2" height="2" fill="#fdba74" />
          {/* Forehead Tech Goggles */}
          <rect x="4" y="3" width="3" height="2" fill="#06b6d4" />
          <rect x="9" y="3" width="3" height="2" fill="#06b6d4" />
          <rect x="4" y="3" width="1" height="1" fill="#ffffff" />
          <rect x="9" y="3" width="1" height="1" fill="#ffffff" />
        </>
      )}

      {isKern && (
        <>
          {/* Silver Swept Highlight */}
          <rect x="5" y="1" width="4" height="1" fill="#ffffff" />
        </>
      )}

      {/* Face Skin */}
      <rect x="5" y="4" width="6" height="5" fill="#fed7aa" />

      {/* Eyes / Visor */}
      {isKern ? (
        <>
          {/* Cyber Visor with scanning cyan streak */}
          <rect x="4" y="5" width="8" height="2" fill="#0f172a" />
          <rect x="6" y="5" width="4" height="1" fill="#38bdf8" />
          <rect x="7" y="5" width="2" height="1" fill="#ffffff" />
        </>
      ) : (
        <>
          {/* Big Expressive Eyes */}
          <rect x="5" y="5" width="2" height="2" fill="#0f172a" />
          <rect x="9" y="5" width="2" height="2" fill="#0f172a" />
          {/* Eye Iris */}
          <rect x="5" y="6" width="2" height="1" fill={profile.accent} />
          <rect x="9" y="6" width="2" height="1" fill={profile.accent} />
          {/* Catchlight */}
          <rect x="5" y="5" width="1" height="1" fill="#ffffff" />
          <rect x="9" y="5" width="1" height="1" fill="#ffffff" />
        </>
      )}

      {/* Cheeks / Blush */}
      <rect x="4" y="7" width="1" height="1" fill="#fda4af" />
      <rect x="11" y="7" width="1" height="1" fill="#fda4af" />

      {/* Body / Shirt */}
      <rect x="4" y="9" width="8" height="4" fill={profile.shirt} />
      {/* Accent Detail */}
      <rect x="7" y="9" width="2" height="3" fill={profile.accent} />

      {isLinus && (
        <>
          {/* White Hoodie Drawstrings */}
          <rect x="6" y="10" width="1" height="2" fill="#ffffff" />
          <rect x="9" y="10" width="1" height="2" fill="#ffffff" />
        </>
      )}

      {/* Desk Surface */}
      <rect x="1" y="13" width="14" height="2" fill="#0f172a" />

      {/* Keyboard */}
      <rect x="4" y="12" width="8" height="2" fill="#334155" />

      {/* Hands / Typing Animation or Resting Coffee */}
      {isWorking ? (
        <>
          <rect x="4" y="11" width="2" height="2" fill="#fed7aa" />
          <rect x="10" y="12" width="2" height="2" fill="#fed7aa" />
          {/* Sparkle from keyboard typing */}
          <rect x="7" y="11" width="1" height="1" fill={profile.accent} />
          <rect x="6" y="11" width="1" height="1" fill="#ffffff" />
        </>
      ) : (
        <>
          <rect x="4" y="12" width="2" height="2" fill="#fed7aa" />
          <rect x="10" y="12" width="2" height="2" fill="#fed7aa" />
          {/* Break coffee mug */}
          <rect x="13" y="11" width="2" height="2" fill="#ffffff" />
          <rect x="13" y="11" width="1" height="1" fill="#78350f" />
        </>
      )}
    </svg>
  );
}

export function Mascot({
  state = "idle",
  small = false,
  identity,
  name = "Dot",
  decorative = false,
  className = "",
}: {
  state?: "idle" | "working" | "complete" | "needs-input" | "paused" | string;
  small?: boolean;
  identity?: string;
  name?: string;
  decorative?: boolean;
  className?: string;
}) {
  const character = characterFor(identity);
  const isWorking = state === "working";

  return (
    <span
      className={`mascot pixel-mascot ${state} ${small ? "small" : ""} ${className}`}
      data-character={character}
      title={decorative ? undefined : `${name} is ${state}`}
    >
      <PixelAgentSprite character={character} isWorking={isWorking} />
    </span>
  );
}

export default Mascot;

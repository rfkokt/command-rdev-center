import type { Point } from "./office-motion";

/** Palette and physical layout shared by the cutaway studio and its walkers. */
export const STUDIO_COLORS = {
  night: "#080e1d",
  day: "#a5b2c1",
  edge: "#24232d",
  wall: "#38313b",
  chair: "#303646",
  trim: "#171b28",
  metal: "#394654",
  silver: "#a4b2ba",
  wood: "#985b3d",
  woodEdge: "#6f412f",
  woodDark: "#3a2927",
  woodFloor: ["#49332f", "#503832", "#583d34", "#47312e"],
  tiles: ["#807570", "#91827a", "#776e6b"],
  cyan: "#5bd9ef",
  amber: "#ffae61",
  lamp: "#ffd08a",
  skyNight: "#12283e",
  skyDay: "#759aaf",
  city: ["#172d42", "#20384b", "#243d50"],
  windowCool: "#6aa4b6",
  windowWarm: "#cfb586",
  glass: "#75b9d1",
  glassEdge: "#7acee2",
  serverBody: "#1d2b3c",
  serverFloor: ["#4a6577", "#526e7f"],
  serverGreen: "#7bbf9c",
  books: ["#ba7257", "#759c9e", "#c6b18a", "#787592"],
  art: "#283447",
  screen: "#18363f",
  code: "#9db7af",
  key: "#5d6e80",
  mousePad: "#29323e",
  ambient: "#bac9e6",
  moon: "#a5bedf",
  daylight: "#ffe2bf",
} as const;

export const DISCUSSION_CENTER: Point = { x: -5.3, z: 2.6 };
export const OFFICE_VISITS = [
  {
    kind: "coffee",
    destination: { x: -7.1, z: 3.3 },
    lookAt: { x: -8.45, z: 2.95 },
    duration: 4.6,
    outbound: "Coffee break",
    visiting: "Taking a sip…",
  },
  {
    kind: "server",
    destination: { x: -4.35, z: -1.65 },
    lookAt: { x: -4.35, z: -4.5 },
    duration: 5.2,
    outbound: "Checking the servers",
    visiting: "Inspecting the server room…",
  },
] as const;
// Leave enough room for the widest chibi and clear approaches around the table.
export const DISCUSSION_SPOTS: readonly Point[] = [
  { x: -6.7, z: 0.4 },
  { x: -4.9, z: -0.6 },
  { x: -3.2, z: -0.1 },
  { x: -3.2, z: 2.0 },
  { x: -6.3, z: 5.3 },
  { x: -2.4, z: 5.3 },
];

export type FloorObstacle = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};
export const FIXED_OBSTACLES: readonly FloorObstacle[] = [
  { minX: -8.4, maxX: -1.7, minZ: -6.1, maxZ: -2.75 }, // server glass
  { minX: -9, maxX: -7.85, minZ: -1.05, maxZ: 5.05 }, // pantry
  { minX: -6.325, maxX: -4.275, minZ: 1.825, maxZ: 3.375 }, // break table
  { minX: -7.6, maxX: -6.8, minZ: -2, maxZ: -1.2 }, // plant
  ...[-0.6, 0.6].flatMap((dx) =>
    [-1.3, 1.3].map((dz) => ({
      minX: DISCUSSION_CENTER.x + dx - 0.34,
      maxX: DISCUSSION_CENTER.x + dx + 0.34,
      minZ: DISCUSSION_CENTER.z + dz - 0.4,
      maxZ: DISCUSSION_CENTER.z + dz + 0.4,
    })),
  ), // break chairs
];

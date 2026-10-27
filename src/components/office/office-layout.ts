import type { Point } from "./office-motion";

/** Palette and physical layout shared by the cutaway studio and its walkers. */
export const STUDIO_COLORS = {
  night: "#0e1520",
  day: "#cbd5dc",
  edge: "#2d3540",
  wall: "#525b66",
  wallInner: "#66707c",
  slat: "#b57c4e",
  slatDark: "#8a5a36",
  chair: "#2e3644",
  chairCushion: "#49566b",
  trim: "#232a34",
  metal: "#4b5666",
  brass: "#dfb060",
  silver: "#c6c2ba",
  wood: "#c68652",
  woodLight: "#dfa06c",
  woodEdge: "#945d34",
  woodDark: "#5c3d28",
  woodFloor: ["#8c6244", "#986c4c", "#a37554", "#7f583c"],
  tiles: ["#b4aca2", "#c2bab0", "#a69e94"],
  carpetBase: "#46435e",
  carpetInner: "#565372",
  rugWarm: "#664940",
  rugBorder: "#e0a463",
  foliage: "#4aa36c",
  foliageLight: "#6dc48c",
  terracotta: "#cb7654",
  cyan: "#5ad8f0",
  amber: "#ffbe64",
  lamp: "#ffe8b3",
  lampShade: "#f0c482",
  skyNight: "#152840",
  skyDay: "#8cb4cc",
  city: ["#1d3248", "#263f58", "#304d68"],
  windowCool: "#84c4da",
  windowWarm: "#f8d494",
  glass: "#94d4ea",
  glassEdge: "#a8e4f8",
  serverBody: "#202d3c",
  serverFloor: ["#607282", "#6b7e8f"],
  serverGreen: "#6ce09a",
  books: ["#d47858", "#6fb0b2", "#e0c492", "#9286b0", "#6eb084"],
  art: "#323e50",
  artCanvas: "#e6d4b8",
  screen: "#163440",
  code: "#b0d8cc",
  key: "#6d7c8e",
  mousePad: "#2c3440",
  ambient: "#e8dac8",
  moon: "#c6daf4",
  daylight: "#fff0d4",
} as const;

/*
 * Kern HQ: one floor with a room per agent around the command hub.
 * x runs east, z runs south; the studio camera looks from the south-east, so
 * north and west walls are full height and south/east walls are low cutaway
 * curbs with doorways (rooms stay readable from the camera).
 */
export const WORLD = { minX: -22, maxX: 22, minZ: -16, maxZ: 15 } as const;

export type RoomId = "library" | "lab" | "workshop" | "ops" | "hub" | "testlab" | "lounge";
export type Room = {
  id: RoomId;
  name: string;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  floor: "wood" | "tiles" | "slate" | "carpet";
  accent: string;
  /** Full-height walls on the far (north, west) sides; low curbs elsewhere. */
  walls: boolean;
};
export const ROOMS: readonly Room[] = [
  { id: "library", name: "Archive", minX: -21, maxX: -9, minZ: -15, maxZ: -5, floor: "carpet", accent: "#b499dc", walls: true },
  { id: "lab", name: "Research lab", minX: -7, maxX: 7, minZ: -15, maxZ: -5, floor: "tiles", accent: "#71b6c5", walls: true },
  { id: "workshop", name: "Workshop", minX: 9, maxX: 21, minZ: -15, maxZ: -5, floor: "wood", accent: "#73a98e", walls: true },
  { id: "ops", name: "Ops room", minX: -21, maxX: -9, minZ: -3, maxZ: 8, floor: "slate", accent: "#d5ad69", walls: true },
  { id: "hub", name: "Command hub", minX: -7, maxX: 7, minZ: -3, maxZ: 6, floor: "tiles", accent: "#6faecb", walls: false },
  { id: "testlab", name: "Test lab", minX: 9, maxX: 21, minZ: -3, maxZ: 8, floor: "slate", accent: "#db929b", walls: true },
  { id: "lounge", name: "Lounge", minX: -7, maxX: 7, minZ: 8, maxZ: 14, floor: "wood", accent: "#ffae61", walls: false },
];
export const roomOf = (id: RoomId) => ROOMS.find((room) => room.id === id)!;

/**
 * Wall segments (thin boxes). Exterior walls (the building's north and west
 * façade) are solid; every other side has a doorway in the middle.
 */
export type Wall = { x1: number; z1: number; x2: number; z2: number; height: number };
const DOOR = 2.4;
function side(x1: number, z1: number, x2: number, z2: number, height: number, door: boolean): Wall[] {
  if (!door) return [{ x1, z1, x2, z2, height }];
  const mx = (x1 + x2) / 2,
    mz = (z1 + z2) / 2;
  const ux = x2 === x1 ? 0 : DOOR / 2,
    uz = z2 === z1 ? 0 : DOOR / 2;
  return [
    { x1, z1, x2: mx - ux, z2: mz - uz, height },
    { x1: mx + ux, z1: mz + uz, x2, z2, height },
  ];
}
export const WALLS: readonly Wall[] = ROOMS.filter((room) => room.walls).flatMap((room) => {
  const tall = 2.6;
  const low = 0.45;
  const { minX, maxX, minZ, maxZ } = room;
  return [
    ...side(minX, minZ, maxX, minZ, tall, minZ > WORLD.minZ + 1.5), // north
    ...side(minX, minZ, minX, maxZ, tall, minX > WORLD.minX + 1.5), // west
    ...side(minX, maxZ, maxX, maxZ, low, true), // south curb
    ...side(maxX, minZ, maxX, maxZ, low, true), // east curb
  ];
});

/**
 * Furniture. `model` is a voxel asset; `kind` a box-built piece. `solid` is
 * its floor footprint for walking routes (width along x, depth along z).
 */
export type Prop = {
  model?: string;
  kind?:
    | "shelf"
    | "rack"
    | "bench"
    | "counter"
    | "table"
    | "desk"
    | "rug"
    | "floorLamp"
    | "planter";
  room: RoomId;
  at: [number, number];
  rot?: number;
  scale?: number;
  size?: [number, number, number];
  solid?: [number, number];
};
export const PROPS: readonly Prop[] = [
  // Archive (Ada): warm bookshelves, reading nook, floor lamp, lush plants
  { kind: "shelf", room: "library", at: [-17.5, -14.5], size: [6, 2.4, 0.6], solid: [6, 0.6] },
  { kind: "shelf", room: "library", at: [-11.8, -14.5], size: [4.4, 2.4, 0.6], solid: [4.4, 0.6] },
  { model: "office_cabinet", room: "library", at: [-20.3, -11], rot: Math.PI / 2, solid: [0.8, 1.2] },
  { model: "office_cabinet", room: "library", at: [-20.3, -9.6], rot: Math.PI / 2, solid: [0.8, 1.2] },
  { model: "office_meeting_table", room: "library", at: [-12, -7], scale: 0.7, solid: [3.4, 0.9] },
  { model: "office_papers", room: "library", at: [-12.6, -7], scale: 0.9 },
  { model: "office_plant", room: "library", at: [-11.2, -7], scale: 0.75 },
  { model: "office_plant_tall", room: "library", at: [-20.2, -14.2], solid: [0.8, 0.8] },
  { model: "office_couch", room: "library", at: [-18.6, -6.2], rot: 0, scale: 0.9, solid: [2.4, 1.3] },
  { kind: "floorLamp", room: "library", at: [-20.2, -6.2] },
  { kind: "planter", room: "library", at: [-9.8, -14.2], size: [1.4, 0.45, 0.45] },
  // Research lab (Alan): whiteboards, corkboard, collaboration table, plants
  { model: "office_whiteboard", room: "lab", at: [-3.5, -14.3], scale: 1.3 },
  { model: "office_whiteboard", room: "lab", at: [3.5, -14.3], scale: 1.3 },
  { model: "office_corkboard", room: "lab", at: [-6.3, -10], rot: Math.PI / 2, scale: 1.4 },
  { model: "office_meeting_table", room: "lab", at: [3.6, -7.2], scale: 0.75, solid: [3.6, 1] },
  { model: "office_chair_white", room: "lab", at: [2.4, -6.3], rot: Math.PI, scale: 0.8 },
  { model: "office_chair_white", room: "lab", at: [4.8, -6.3], rot: Math.PI, scale: 0.8 },
  { model: "office_papers", room: "lab", at: [3.2, -7.2], scale: 0.9 },
  { model: "office_plant", room: "lab", at: [4.3, -7.2], scale: 0.7 },
  { model: "office_plant_big", room: "lab", at: [-6.3, -14.3], solid: [0.8, 0.8] },
  { model: "office_plant_tall", room: "lab", at: [6.2, -14.2] },
  { kind: "floorLamp", room: "lab", at: [-6.2, -6.2] },
  // Workshop (Linus): wooden workbench desks, printer, corkboard, greenery
  { kind: "desk", room: "workshop", at: [12, -13.6], solid: [2.7, 1.2] },
  { kind: "desk", room: "workshop", at: [18, -13.6], solid: [2.7, 1.2] },
  { model: "office_printer", room: "workshop", at: [20.3, -9.5], rot: -Math.PI / 2, solid: [1.2, 1.2] },
  { model: "office_trashcan", room: "workshop", at: [20.3, -8], scale: 0.9 },
  { model: "office_corkboard", room: "workshop", at: [15, -14.4], scale: 1.4 },
  { model: "office_plant_tall", room: "workshop", at: [9.8, -14.2], solid: [0.8, 0.8] },
  { model: "office_plant_big", room: "workshop", at: [20.2, -14.2] },
  { model: "office_chair", room: "workshop", at: [12, -12.6], rot: Math.PI },
  { model: "office_chair", room: "workshop", at: [18, -12.6], rot: Math.PI },
  { kind: "floorLamp", room: "workshop", at: [9.8, -6.2] },
  // Ops room (Grace): warm-accented server racks + plants
  { kind: "rack", room: "ops", at: [-19.9, -2.4], rot: Math.PI / 2, solid: [0.9, 1.3] },
  { kind: "rack", room: "ops", at: [-19.9, -0.9], rot: Math.PI / 2, solid: [0.9, 1.3] },
  { kind: "rack", room: "ops", at: [-17.6, -2.4], solid: [1.3, 0.9] },
  { kind: "rack", room: "ops", at: [-16.1, -2.4], solid: [1.3, 0.9] },
  { kind: "rack", room: "ops", at: [-12.9, -2.4], solid: [1.3, 0.9] },
  { kind: "rack", room: "ops", at: [-11.4, -2.4], solid: [1.3, 0.9] },
  { model: "office_pc", room: "ops", at: [-11, 6.8], solid: [1.2, 1] },
  { model: "office_plant_big", room: "ops", at: [-20.3, 7.3] },
  { kind: "planter", room: "ops", at: [-18.5, 7.3], size: [1.5, 0.45, 0.45] },
  { kind: "floorLamp", room: "ops", at: [-9.8, -2.2] },
  // Test lab (Bob): wooden device benches, rack, test matrix, plants
  { kind: "bench", room: "testlab", at: [12, -2.2], size: [3, 1, 0.9], solid: [3, 0.9] },
  { kind: "bench", room: "testlab", at: [18, -2.2], size: [3, 1, 0.9], solid: [3, 0.9] },
  { kind: "rack", room: "testlab", at: [20.2, 3.5], rot: -Math.PI / 2, solid: [0.9, 1.3] },
  { model: "office_whiteboard", room: "testlab", at: [15, -2.2], scale: 1.2 },
  { model: "office_printer", room: "testlab", at: [10, 7.2], solid: [1.2, 1.2] },
  { model: "office_plant_tall", room: "testlab", at: [20.3, 7.3], solid: [0.8, 0.8] },
  { kind: "floorLamp", room: "testlab", at: [9.8, -2.2] },
  // Command hub: woven rug, corner planters, floor lamps (desk + video wall are built with the posts)
  { kind: "rug", room: "hub", at: [0, 3.2], size: [6.4, 0.02, 4.4] },
  { model: "office_plant_tall", room: "hub", at: [-6.4, -2.4], solid: [0.8, 0.8] },
  { model: "office_plant_tall", room: "hub", at: [6.4, -2.4], solid: [0.8, 0.8] },
  { kind: "planter", room: "hub", at: [-6.2, 5.2], size: [1.2, 0.45, 0.45] },
  { kind: "planter", room: "hub", at: [6.2, 5.2], size: [1.2, 0.45, 0.45] },
  // Lounge: cozy sofa corner, espresso bar, break table, warm lamps & plants
  { kind: "rug", room: "lounge", at: [-4.6, 12.2], size: [4.2, 0.02, 3.2] },
  { model: "office_couch", room: "lounge", at: [-4.6, 13.2], rot: Math.PI, solid: [2.7, 1.4] },
  { model: "office_coffee_table", room: "lounge", at: [-4.6, 11.6], scale: 0.8, solid: [2.1, 1] },
  { kind: "counter", room: "lounge", at: [4.8, 13.4], size: [4, 1, 0.9], solid: [4, 0.9] },
  { model: "office_coffee_machine", room: "lounge", at: [5.6, 13.4], rot: Math.PI, scale: 0.9 },
  { model: "office_plant_big", room: "lounge", at: [6.5, 9] },
  { model: "office_plant_big", room: "lounge", at: [-6.5, 9] },
  { kind: "floorLamp", room: "lounge", at: [-6.4, 13.2] },
];

/** Live video wall along the north edge of the command hub. */
export const VIDEO_WALL = { z: -2.6, halfWidth: 5.2 } as const;

export const DISCUSSION_CENTER: Point = { x: 0.6, z: 11.2 };
export const OFFICE_VISITS = [
  {
    kind: "coffee",
    destination: { x: 5.2, z: 12.1 },
    lookAt: { x: 5.6, z: 13.4 },
    duration: 4.6,
    outbound: "Coffee break",
    visiting: "Taking a sip…",
  },
  {
    kind: "server",
    destination: { x: -14.5, z: -0.6 },
    lookAt: { x: -14.5, z: -2.4 },
    duration: 5.2,
    outbound: "Checking the servers",
    visiting: "Inspecting the server room…",
  },
] as const;
// Seats around the lounge break table.
export const DISCUSSION_SPOTS: readonly Point[] = [
  { x: -1.2, z: 9.6 },
  { x: 2.4, z: 9.6 },
  { x: -1.2, z: 12.8 },
  { x: 2.4, z: 12.8 },
  { x: -2.6, z: 11.2 },
  { x: 3.8, z: 11.2 },
];

export type FloorObstacle = {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
};
const wallObstacles: FloorObstacle[] = WALLS.map((w) => ({
  minX: Math.min(w.x1, w.x2) - 0.1,
  maxX: Math.max(w.x1, w.x2) + 0.1,
  minZ: Math.min(w.z1, w.z2) - 0.1,
  maxZ: Math.max(w.z1, w.z2) + 0.1,
}));
const propObstacles: FloorObstacle[] = PROPS.filter((p) => p.solid).map((p) => {
  const [w, d] = p.solid!;
  return { minX: p.at[0] - w / 2, maxX: p.at[0] + w / 2, minZ: p.at[1] - d / 2, maxZ: p.at[1] + d / 2 };
});
export const FIXED_OBSTACLES: readonly FloorObstacle[] = [
  ...wallObstacles,
  ...propObstacles,
  { minX: -VIDEO_WALL.halfWidth, maxX: VIDEO_WALL.halfWidth, minZ: VIDEO_WALL.z - 0.2, maxZ: VIDEO_WALL.z + 0.2 },
  // lounge break table
  { minX: DISCUSSION_CENTER.x - 1.05, maxX: DISCUSSION_CENTER.x + 1.05, minZ: DISCUSSION_CENTER.z - 0.8, maxZ: DISCUSSION_CENTER.z + 0.8 },
];

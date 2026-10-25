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
  kind?: "shelf" | "rack" | "bench" | "counter" | "table" | "desk" | "rug";
  room: RoomId;
  at: [number, number];
  rot?: number;
  scale?: number;
  size?: [number, number, number];
  solid?: [number, number];
};
export const PROPS: readonly Prop[] = [
  // Archive (Ada): shelves on the far walls, cabinets, a reading table
  { kind: "shelf", room: "library", at: [-17.5, -14.5], size: [6, 2.4, 0.6], solid: [6, 0.6] },
  { kind: "shelf", room: "library", at: [-11.8, -14.5], size: [4.4, 2.4, 0.6], solid: [4.4, 0.6] },
  { model: "office_cabinet", room: "library", at: [-20.3, -11], rot: Math.PI / 2, solid: [0.8, 1.2] },
  { model: "office_cabinet", room: "library", at: [-20.3, -9.6], rot: Math.PI / 2, solid: [0.8, 1.2] },
  { model: "office_meeting_table", room: "library", at: [-12, -7], scale: 0.7, solid: [3.4, 0.9] },
  { model: "office_papers", room: "library", at: [-12.6, -7], scale: 0.9 },
  { model: "office_plant_tall", room: "library", at: [-20.2, -14.2], solid: [0.8, 0.8] },
  { model: "office_couch", room: "library", at: [-18.6, -6.2], rot: 0, scale: 0.9, solid: [2.4, 1.3] },
  // Research lab (Alan): whiteboards, corkboard, meeting table
  { model: "office_whiteboard", room: "lab", at: [-3.5, -14.3], scale: 1.3 },
  { model: "office_whiteboard", room: "lab", at: [3.5, -14.3], scale: 1.3 },
  { model: "office_corkboard", room: "lab", at: [-6.3, -10], rot: Math.PI / 2, scale: 1.4 },
  { model: "office_meeting_table", room: "lab", at: [3.6, -7.2], scale: 0.75, solid: [3.6, 1] },
  { model: "office_chair_white", room: "lab", at: [2.4, -6.3], rot: Math.PI, scale: 0.8 },
  { model: "office_chair_white", room: "lab", at: [4.8, -6.3], rot: Math.PI, scale: 0.8 },
  { model: "office_papers", room: "lab", at: [3.2, -7.2], scale: 0.9 },
  { model: "office_plant_big", room: "lab", at: [-6.3, -14.3], solid: [0.8, 0.8] },
  // Workshop (Linus): workbench desks, printer, corkboard
  { kind: "desk", room: "workshop", at: [12, -13.6], solid: [2.7, 1.2] },
  { kind: "desk", room: "workshop", at: [18, -13.6], solid: [2.7, 1.2] },
  { model: "office_printer", room: "workshop", at: [20.3, -9.5], rot: -Math.PI / 2, solid: [1.2, 1.2] },
  { model: "office_trashcan", room: "workshop", at: [20.3, -8], scale: 0.9 },
  { model: "office_corkboard", room: "workshop", at: [15, -14.4], scale: 1.4 },
  { model: "office_plant_tall", room: "workshop", at: [9.8, -14.2], solid: [0.8, 0.8] },
  { model: "office_chair", room: "workshop", at: [12, -12.6], rot: Math.PI },
  { model: "office_chair", room: "workshop", at: [18, -12.6], rot: Math.PI },
  // Ops room (Grace): server racks
  { kind: "rack", room: "ops", at: [-19.9, -2.4], rot: Math.PI / 2, solid: [0.9, 1.3] },
  { kind: "rack", room: "ops", at: [-19.9, -0.9], rot: Math.PI / 2, solid: [0.9, 1.3] },
  { kind: "rack", room: "ops", at: [-17.6, -2.4], solid: [1.3, 0.9] },
  { kind: "rack", room: "ops", at: [-16.1, -2.4], solid: [1.3, 0.9] },
  { kind: "rack", room: "ops", at: [-12.9, -2.4], solid: [1.3, 0.9] },
  { kind: "rack", room: "ops", at: [-11.4, -2.4], solid: [1.3, 0.9] },
  { model: "office_pc", room: "ops", at: [-11, 6.8], solid: [1.2, 1] },
  { model: "office_plant_big", room: "ops", at: [-20.3, 7.3] },
  // Test lab (Bob): benches with devices, a rack, the test matrix
  { kind: "bench", room: "testlab", at: [12, -2.2], size: [3, 1, 0.9], solid: [3, 0.9] },
  { kind: "bench", room: "testlab", at: [18, -2.2], size: [3, 1, 0.9], solid: [3, 0.9] },
  { kind: "rack", room: "testlab", at: [20.2, 3.5], rot: -Math.PI / 2, solid: [0.9, 1.3] },
  { model: "office_whiteboard", room: "testlab", at: [15, -2.2], scale: 1.2 },
  { model: "office_printer", room: "testlab", at: [10, 7.2], solid: [1.2, 1.2] },
  { model: "office_plant_tall", room: "testlab", at: [20.3, 7.3], solid: [0.8, 0.8] },
  // Command hub: rug and corner plants (desk + video wall are built with the posts)
  { kind: "rug", room: "hub", at: [0, 3.2], size: [6, 0.02, 4.2] },
  { model: "office_plant_tall", room: "hub", at: [-6.4, -2.4], solid: [0.8, 0.8] },
  { model: "office_plant_tall", room: "hub", at: [6.4, -2.4], solid: [0.8, 0.8] },
  // Lounge: sofa corner, coffee bar, break table
  { model: "office_couch", room: "lounge", at: [-4.6, 13.2], rot: Math.PI, solid: [2.7, 1.4] },
  { model: "office_coffee_table", room: "lounge", at: [-4.6, 11.6], scale: 0.8, solid: [2.1, 1] },
  { kind: "counter", room: "lounge", at: [4.8, 13.4], size: [4, 1, 0.9], solid: [4, 0.9] },
  { model: "office_coffee_machine", room: "lounge", at: [5.6, 13.4], rot: Math.PI, scale: 0.9 },
  { model: "office_plant_big", room: "lounge", at: [6.5, 9] },
  { model: "office_plant_big", room: "lounge", at: [-6.5, 9] },
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

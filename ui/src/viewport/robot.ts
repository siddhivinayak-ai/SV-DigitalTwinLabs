// Pure kinematics for the procedural 6-axis transfer robot (no three.js imports, unit-testable).
// Robot-local frame: origin at the base centre on the floor, Y up, the arm points along +X at yaw 0.
// Yaw follows three.js: a positive rotation about +Y turns +X towards -Z.

export const ROBOT = {
  baseH: 0.62,       // floor → J1 (turret) plane
  shoulderR: 0.18,   // J1 axis → J2 axis, radial
  shoulderH: 0.94,   // floor → J2 axis
  upper: 0.95,       // J2 → J3
  fore: 1.0,         // J3 → wrist centre (J5)
  tool: 0.28,        // wrist centre → grip point (tool points straight down)
  lift: 0.38,        // clearance lift between pick and place
  retract: 1.15,     // radial distance while swinging
} as const;

/** Cylindrical tool pose in robot-local space. */
export interface ToolPose { yaw: number; r: number; h: number }
/** Joint angles in radians: J1 yaw, J2 shoulder, J3 elbow, J4 forearm roll, J5 wrist pitch, J6 flange roll. */
export interface Joints { j1: number; j2: number; j3: number; j4: number; j5: number; j6: number }

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const smooth = (t: number) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixPose = (a: ToolPose, b: ToolPose, t: number): ToolPose => ({ yaw: lerp(a.yaw, b.yaw, t), r: lerp(a.r, b.r, t), h: lerp(a.h, b.h, t) });

/**
 * Pick-and-place path as a function of cycle progress (0..1):
 * grip at pick → lift & retract → swing → extend & lower → release at place.
 */
export function robotPose(progress: number, pick: ToolPose, place: ToolPose): ToolPose {
  const p = clamp(progress, 0, 1);
  const pickUp: ToolPose = { yaw: pick.yaw, r: Math.min(pick.r, ROBOT.retract), h: pick.h + ROBOT.lift };
  const placeUp: ToolPose = { yaw: place.yaw, r: Math.min(place.r, ROBOT.retract), h: place.h + ROBOT.lift };
  if (p < 0.08) return { ...pick };
  if (p < 0.22) return mixPose(pick, pickUp, smooth((p - 0.08) / 0.14));
  if (p < 0.62) return mixPose(pickUp, placeUp, smooth((p - 0.22) / 0.4));
  if (p < 0.8) return mixPose(placeUp, place, smooth((p - 0.62) / 0.18));
  return { ...place };
}

/** Waiting pose (Starved/Idle): hover above the pick point, ready. */
export function robotReadyPose(pick: ToolPose): ToolPose {
  return { yaw: pick.yaw, r: Math.min(pick.r, ROBOT.retract), h: pick.h + ROBOT.lift };
}

/** Planar 2-link IK (elbow up) with the tool held vertical. Unreachable targets are clamped to the workspace. */
export function solveArm(pose: ToolPose): Joints {
  const dx = Math.max(0.05, pose.r - ROBOT.shoulderR);
  const dy = pose.h + ROBOT.tool - ROBOT.shoulderH;
  const L1 = ROBOT.upper, L2 = ROBOT.fore;
  const d = clamp(Math.hypot(dx, dy), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
  const base = Math.atan2(dy, dx);
  const a = base + Math.acos(clamp((L1 * L1 + d * d - L2 * L2) / (2 * L1 * d), -1, 1)); // upper-arm angle from horizontal
  const ex = L1 * Math.cos(a), ey = L1 * Math.sin(a);
  const wx = d * Math.cos(base), wy = d * Math.sin(base);
  const b = Math.atan2(wy - ey, wx - ex);                                                // forearm angle from horizontal
  return { j1: pose.yaw, j2: a - Math.PI / 2, j3: b - a + Math.PI / 2, j4: 0, j5: -Math.PI / 2 - b, j6: 0 };
}

/** Forward kinematics of the grip point for a set of joints (robot-local), mirrors the mesh hierarchy. */
export function toolPoint(j: Joints): { x: number; y: number; z: number } {
  const a = j.j2 + Math.PI / 2;           // upper-arm angle from horizontal
  const b = a - Math.PI / 2 + j.j3;       // forearm angle
  const t = b + j.j5;                     // tool angle (−π/2 = straight down)
  const r = ROBOT.shoulderR + ROBOT.upper * Math.cos(a) + ROBOT.fore * Math.cos(b) + ROBOT.tool * Math.cos(t);
  const y = ROBOT.shoulderH + ROBOT.upper * Math.sin(a) + ROBOT.fore * Math.sin(b) + ROBOT.tool * Math.sin(t);
  return { x: r * Math.cos(j.j1), y, z: -r * Math.sin(j.j1) };
}

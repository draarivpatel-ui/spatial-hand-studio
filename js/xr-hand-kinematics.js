/* =============================================================
   xr-hand-kinematics.js - 25-joint WebXR XRHand hierarchy,
   1-Euro smoothing, hysteresis pinch FSM, posture moments.

   Coordinate convention: hand-local metres, +Y up, +Z toward the
   fingertips, wrist at z = -0.06. WebXR joint poses stay in their
   native reference space; only the desktop mirror applies a
   separate, documented transform.
   ============================================================= */

/* ---------- 25-Joint WebXR XRHand Specification ---------- */
const XR_JOINT_ORDER = [
  "wrist",
  "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip",
  "index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip",
  "middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip",
  "ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip",
  "pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip"
];

const XR_JOINT_PARENTS = {
  "wrist": null,
  "thumb-metacarpal": "wrist", "thumb-phalanx-proximal": "thumb-metacarpal", "thumb-phalanx-distal": "thumb-phalanx-proximal", "thumb-tip": "thumb-phalanx-distal",
  "index-finger-metacarpal": "wrist", "index-finger-phalanx-proximal": "index-finger-metacarpal", "index-finger-phalanx-intermediate": "index-finger-phalanx-proximal", "index-finger-phalanx-distal": "index-finger-phalanx-intermediate", "index-finger-tip": "index-finger-phalanx-distal",
  "middle-finger-metacarpal": "wrist", "middle-finger-phalanx-proximal": "middle-finger-metacarpal", "middle-finger-phalanx-intermediate": "middle-finger-phalanx-proximal", "middle-finger-phalanx-distal": "middle-finger-phalanx-intermediate", "middle-finger-tip": "middle-finger-phalanx-distal",
  "ring-finger-metacarpal": "wrist", "ring-finger-phalanx-proximal": "ring-finger-metacarpal", "ring-finger-phalanx-intermediate": "ring-finger-phalanx-proximal", "ring-finger-phalanx-distal": "ring-finger-phalanx-intermediate", "ring-finger-tip": "ring-finger-phalanx-distal",
  "pinky-finger-metacarpal": "wrist", "pinky-finger-phalanx-proximal": "pinky-finger-metacarpal", "pinky-finger-phalanx-intermediate": "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-distal": "pinky-finger-phalanx-intermediate", "pinky-finger-tip": "pinky-finger-phalanx-distal"
};

const FINGER_GROUPS = {
  thumb: ["thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  index: ["index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip"],
  middle: ["middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip"],
  ring: ["ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip"],
  pinky: ["pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip"]
};

/* Two postures used by the illustrative quasi-static comparison. */
const RESTED_POSTURE_DEG = Object.freeze({ armAbductionDeg: 14, elbowFlexDeg: 20.4 });
const ELEVATED_POSTURE_DEG = Object.freeze({ armAbductionDeg: 58, elbowFlexDeg: 62 });

function isFiniteNumber(v) { return typeof v === "number" && Number.isFinite(v); }
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/* Base open-palm joint positions in hand-local space (metres). These are
   illustrative rig coordinates, not measured anatomy. */
function buildBaseHandJoints(handedness) {
  const sign = handedness === "left" ? -1 : 1;
  const joints = {};
  joints.wrist = { x: 0, y: 0, z: -0.06 };
  const anchors = { thumb: -0.055, index: -0.028, middle: 0, ring: 0.022, pinky: 0.042 };
  const thumbZ = [0.01, 0.035, 0.055, 0.072];
  const fingerZ = [0.038, 0.065, 0.085, 0.098, 0.11];

  for (const [finger, group] of Object.entries(FINGER_GROUPS)) {
    const ax = anchors[finger] * sign;
    if (finger === "thumb") {
      const txOffsets = [0, 0.008, 0.012, 0.016];
      group.forEach((name, i) => {
        joints[name] = { x: ax + txOffsets[i] * sign, y: -0.015 - i * 0.002, z: thumbZ[i] };
      });
    } else {
      group.forEach((name, i) => {
        joints[name] = { x: ax, y: 0, z: fingerZ[i] };
      });
    }
  }
  return joints;
}

/* Verify the declared hierarchy is consistent and acyclic. */
function validateJointHierarchy() {
  const seen = new Set();
  const roots = [];
  const depth = new Map();
  let longestChain = 0;
  for (const name of XR_JOINT_ORDER) {
    const parent = XR_JOINT_PARENTS[name];
    if (parent === undefined) return { valid: false, reason: "missing parent entry for " + name };
    if (parent === null) { roots.push(name); depth.set(name, 1); }
    else {
      if (!seen.has(parent)) return { valid: false, reason: "parent precedes child for " + name };
      depth.set(name, depth.get(parent) + 1);
    }
    longestChain = Math.max(longestChain, depth.get(name));
    seen.add(name);
  }
  return { valid: seen.size === 25, jointCount: seen.size, roots, longestChain };
}

/* ---------- 1-Euro Filter (Casiez et al.) ----------
   Timestamps are DOMHighResTimeStamp values in milliseconds. The
   derivative is taken from consecutive RAW samples; using the filtered
   previous value there would understate velocity and bias the adaptive
   cutoff. dt is measured per sample so variable frame rates are handled.
   `freq` is the nominal sampling rate kept for caller configuration. */
class OneEuroFilter {
  constructor({ freq = 60, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0 } = {}) {
    if (![freq, minCutoff, dCutoff].every(v => isFiniteNumber(v) && v > 0) ||
        !isFiniteNumber(beta) || beta < 0) throw new RangeError("Invalid filter parameters");
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }
  alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value, timestamp) {
    if (!isFiniteNumber(value) || !isFiniteNumber(timestamp)) return this.xPrev === null ? NaN : this.xPrev;
    if (this.tPrev !== null && timestamp <= this.tPrev) return this.xPrev;
    if (this.tPrev === null) {
      this.tPrev = timestamp;
      this.rawPrev = value;
      this.xPrev = value;
      return value;
    }
    const dt = Math.max(0.001, (timestamp - this.tPrev) / 1000);
    const dx = (value - this.rawPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * value + (1 - a) * this.xPrev;
    this.tPrev = timestamp;
    this.rawPrev = value;
    this.dxPrev = dxHat;
    this.xPrev = xHat;
    return xHat;
  }
  reset() {
    this.xPrev = null;
    this.rawPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
}

/* One independent filter per named signal and axis. */
class FilterBank {
  constructor(opts) {
    this.opts = { ...opts };
    this.filters = new Map();
  }
  _get(key) {
    if (!this.filters.has(key)) this.filters.set(key, new OneEuroFilter(this.opts));
    return this.filters.get(key);
  }
  apply(signal, axis, value, t) {
    return this._get(signal + ":" + axis).filter(value, t);
  }
  updateCutoff(cutoff) {
    if (!isFiniteNumber(cutoff) || cutoff <= 0) throw new RangeError("cutoff must be positive");
    this.opts.minCutoff = cutoff;
    for (const f of this.filters.values()) f.minCutoff = cutoff;
  }
  resetSignal(signal) {
    const prefix = signal + ":";
    for (const [key, filter] of this.filters) {
      if (!key.startsWith(prefix)) continue;
      filter.reset();
      this.filters.delete(key);
    }
  }
  reset() {
    for (const f of this.filters.values()) f.reset();
    this.filters.clear();
  }
}

/* ---------- Hysteresis Pinch State Machine ---------- */
const PinchState = Object.freeze({
  IDLE: "IDLE", HOVER: "HOVER", PINCH_START: "PINCH_START",
  DRAGGING: "DRAGGING", RELEASE: "RELEASE"
});

class PinchFSM {
  constructor({ enterThresholdMm = 20, exitThresholdMm = 28, hoverBandMm = 8, releaseBandMm = 10 } = {}) {
    if (![hoverBandMm, releaseBandMm].every(v => isFiniteNumber(v) && v >= 0)) {
      throw new RangeError("hysteresis bands must be finite and non-negative");
    }
    this.hoverBandMm = hoverBandMm;
    this.releaseBandMm = releaseBandMm;
    this.state = PinchState.IDLE;
    this.listeners = [];
    this.setThresholds(enterThresholdMm, exitThresholdMm);
  }
  setThresholds(enter, exit) {
    if (!isFiniteNumber(enter) || !isFiniteNumber(exit) || enter <= 0 || exit <= enter) {
      throw new RangeError("Pinch exit threshold must exceed a positive enter threshold");
    }
    this.enterMm = enter;
    this.exitMm = exit;
  }
  reset() {
    const previous = this.state;
    this.state = PinchState.IDLE;
    if (previous !== this.state) this._emit(previous, this.state);
    return this.state;
  }
  onTransition(cb) {
    if (typeof cb !== "function") throw new TypeError("transition listener must be a function");
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }
  _emit(from, to) { for (const cb of this.listeners.slice()) cb(from, to); }

  /** distanceMm = thumb-tip to index-tip distance in millimetres. */
  update(distanceMm) {
    if (!isFiniteNumber(distanceMm) || distanceMm < 0) return this.reset();
    const prev = this.state;
    const hoverExit = this.exitMm + this.releaseBandMm;
    switch (this.state) {
      case PinchState.IDLE:
        if (distanceMm < this.enterMm + this.hoverBandMm) this.state = PinchState.HOVER;
        break;
      case PinchState.HOVER:
        if (distanceMm < this.enterMm) this.state = PinchState.PINCH_START;
        else if (distanceMm > hoverExit) this.state = PinchState.IDLE;
        break;
      case PinchState.PINCH_START:
        /* A pinch canceled in this single-frame confirmation state goes to
           RELEASE and never becomes a drag. */
        this.state = distanceMm > this.exitMm ? PinchState.RELEASE : PinchState.DRAGGING;
        break;
      case PinchState.DRAGGING:
        if (distanceMm > this.exitMm) this.state = PinchState.RELEASE;
        break;
      case PinchState.RELEASE:
        if (distanceMm > hoverExit) this.state = PinchState.IDLE;
        else if (distanceMm < this.enterMm) this.state = PinchState.PINCH_START;
        else this.state = PinchState.HOVER;
        break;
    }
    if (prev !== this.state) this._emit(prev, this.state);
    return this.state;
  }
  isPinching() { return this.state === PinchState.PINCH_START || this.state === PinchState.DRAGGING; }
  isHovering() { return this.state === PinchState.HOVER; }
}

/* ---------- Illustrative two-segment shoulder moment ----------
   M = g * ( mUA*rUA*sin(a) + mFA*(LUA*sin(a) + rFA*sin(b)) )
   Fixed segment mass fractions and COM ratios define this illustrative
   75 kg reference model. This is a quasi-static posture comparison,
   not measured deltoid activation or a human-subject result. */
function shoulderTorqueNm({ bodyMassKg = 75, upperArmLenM = 0.32, forearmLenM = 0.27,
                            armAbductionDeg = RESTED_POSTURE_DEG.armAbductionDeg,
                            elbowFlexDeg = RESTED_POSTURE_DEG.elbowFlexDeg,
                            rested = false } = {}) {
  if (![bodyMassKg, upperArmLenM, forearmLenM, armAbductionDeg, elbowFlexDeg].every(isFiniteNumber)) {
    throw new RangeError("posture parameters must be finite numbers");
  }
  if (bodyMassKg <= 0 || upperArmLenM <= 0 || forearmLenM <= 0) {
    throw new RangeError("mass and segment lengths must be positive");
  }
  if (armAbductionDeg < 0 || armAbductionDeg > 90 || elbowFlexDeg < 0 || elbowFlexDeg > 90) {
    throw new RangeError("posture angles must be between 0 and 90 degrees");
  }
  const posture = rested ? RESTED_POSTURE_DEG : { armAbductionDeg, elbowFlexDeg };
  const g = 9.81;
  const sin = d => Math.sin(d * Math.PI / 180);
  const mUA = 0.028 * bodyMassKg;
  const mFA = 0.022 * bodyMassKg;
  const rUA = 0.436 * upperArmLenM;
  const rFA = 0.682 * forearmLenM;
  const torque = g * (mUA * rUA * sin(posture.armAbductionDeg) +
                      mFA * (upperArmLenM * sin(posture.armAbductionDeg) + rFA * sin(posture.elbowFlexDeg)));
  return +torque.toFixed(2);
}

function fatigueMetrics(restedTorque, elevatedTorque) {
  if (!isFiniteNumber(restedTorque) || !isFiniteNumber(elevatedTorque)) {
    throw new RangeError("torque values must be finite");
  }
  const reduction = elevatedTorque > 0 ? ((elevatedTorque - restedTorque) / elevatedTorque * 100) : 0;
  return {
    restedNm: restedTorque,
    elevatedNm: elevatedTorque,
    reductionPct: +reduction.toFixed(1),
    label: reduction > 50 ? "Lower modelled moment for the rested posture" : "Small modelled difference",
    note: "Illustrative quasi-static posture comparison only. No measured fatigue, clinical outcome or human-subject result."
  };
}

function postureMoments() {
  const restedNm = shoulderTorqueNm({ ...RESTED_POSTURE_DEG });
  const elevatedNm = shoulderTorqueNm({ ...ELEVATED_POSTURE_DEG });
  return { restedNm, elevatedNm, metrics: fatigueMetrics(restedNm, elevatedNm),
           restedPostureDeg: { ...RESTED_POSTURE_DEG }, elevatedPostureDeg: { ...ELEVATED_POSTURE_DEG } };
}

/* ---------- Hand basis and gesture classification ---------- */
function distMm(a, b) {
  if (!a || !b || ![a.x, a.y, a.z, b.x, b.y, b.z].every(isFiniteNumber)) return NaN;
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * 1000;
}

function sub(a, b) { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function cross(a, b) {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function norm(v) {
  const l = Math.hypot(v.x, v.y, v.z);
  return l < 1e-12 ? null : { x: v.x / l, y: v.y / l, z: v.z / l };
}

/* Palm frame derived from four joints. `normal` points out of the palm,
   `forward` toward the fingertips. The index-to-pinky span is reversed
   for left hands so both hands use the same palm-normal convention. */
function handBasis(joints, handedness = "right") {
  if (!joints) return null;
  const wrist = joints.wrist;
  const indexMcp = joints["index-finger-metacarpal"];
  const middleMcp = joints["middle-finger-metacarpal"];
  const pinkyMcp = joints["pinky-finger-metacarpal"];
  if (!wrist || !indexMcp || !middleMcp || !pinkyMcp) return null;
  if (![wrist, indexMcp, middleMcp, pinkyMcp].every(p => [p.x, p.y, p.z].every(isFiniteNumber))) return null;
  const forward = norm(sub(middleMcp, wrist));
  if (!forward) return null;
  const span = sub(pinkyMcp, indexMcp);
  if (handedness === "left") { span.x *= -1; span.y *= -1; span.z *= -1; }
  const projection = span.x * forward.x + span.y * forward.y + span.z * forward.z;
  const across = norm({ x: span.x - projection * forward.x, y: span.y - projection * forward.y, z: span.z - projection * forward.z });
  if (!across) return null;
  const normal = norm(cross(forward, across));
  if (!normal) return null;
  return { forward, across, normal };
}

function wristOrientationDeg(joints, handedness = "right") {
  const basis = handBasis(joints, handedness);
  if (!basis) return null;
  return {
    pitchDeg: Math.atan2(basis.normal.z, basis.normal.y) * 180 / Math.PI,
    rollDeg: Math.atan2(basis.across.y, Math.hypot(basis.across.x, basis.across.z)) * 180 / Math.PI
  };
}

const EXTENSION_M = 0.055;

function classifyGesture(joints, handedness = "right") {
  if (!joints) return { gesture: "unknown", confidence: 0 };
  const thumbTip = joints["thumb-tip"];
  const indexTip = joints["index-finger-tip"];
  if (!thumbTip || !indexTip) return { gesture: "unknown", confidence: 0 };
  const pinchDist = distMm(thumbTip, indexTip);
  if (!isFiniteNumber(pinchDist)) return { gesture: "unknown", confidence: 0 };
  const basis = handBasis(joints, handedness);
  if (!basis) return { gesture: "unknown", confidence: 0 };
  const pitchDeg = Math.atan2(basis.normal.z, basis.normal.y) * 180 / Math.PI;

  const extension = f => {
    const group = FINGER_GROUPS[f];
    const tip = joints[group[group.length - 1]];
    const mcp = joints[group[0]];
    if (!tip || !mcp || ![tip.x, tip.y, tip.z, mcp.x, mcp.y, mcp.z].every(isFiniteNumber)) return NaN;
    const delta = sub(tip, mcp);
    return delta.x * basis.forward.x + delta.y * basis.forward.y + delta.z * basis.forward.z;
  };
  const fingersExtended = ["index", "middle", "ring", "pinky"]
    .every(f => extension(f) > 0.04);
  const fingersCurled = ["index", "middle", "ring", "pinky"]
    .every(f => extension(f) < EXTENSION_M);

  /* A closed fist also brings the thumb near the index tip. Checking
     finger curl first keeps it from being misreported as a pinch. */
  if (fingersCurled && pinchDist < 30) {
    return { gesture: "fist", confidence: 0.9, pinchDistMm: pinchDist, pitchDeg };
  }
  if (pinchDist < 22) return { gesture: "pinch", confidence: 0.95, pinchDistMm: pinchDist, pitchDeg };
  if (pitchDeg > 25 && fingersExtended) return { gesture: "palm-up", confidence: 0.88, pitchDeg, pinchDistMm: pinchDist };
  const othersCurled = ["middle", "ring", "pinky"].every(f => extension(f) < EXTENSION_M);
  if (extension("index") > 0.05 && othersCurled && pinchDist > 40) {
    return { gesture: "poke", confidence: 0.82, pinchDistMm: pinchDist, pitchDeg };
  }
  return { gesture: "open-palm", confidence: 0.75, pinchDistMm: pinchDist, pitchDeg };
}

/* ---------- Pose presets ---------- */
const POSE_PRESETS = Object.freeze({
  open:   { pinch: 55, curl: 0, thumbCurl: 0 },
  pinch:  { pinch: 12, curl: 0.1, thumbCurl: 0.3 },
  "palm-up": { pinch: 50, curl: 0, thumbCurl: 0, wristPitch: 35 },
  poke:   { pinch: 60, curl: 0.85, thumbCurl: 0.5, indexCurl: 0 },
  fist:   { pinch: 20, curl: 0.95, thumbCurl: 0.9 }
});

const WRIST_PIVOT_Z = -0.06;

function applyPosePreset(baseJoints, presetName, handedness) {
  const preset = POSE_PRESETS[presetName] || POSE_PRESETS.open;
  const joints = {};
  for (const [k, v] of Object.entries(baseJoints || {})) joints[k] = { ...v };
  const sign = handedness === "left" ? -1 : 1;

  for (const [finger, group] of Object.entries(FINGER_GROUPS)) {
    let curl = preset.curl ?? 0;
    if (finger === "thumb") curl = preset.thumbCurl ?? curl;
    if (finger === "index" && preset.indexCurl !== undefined) curl = preset.indexCurl;
    if (curl === 0) continue;
    group.forEach((name, i) => {
      const j = joints[name];
      if (!j) return;
      const k = i / group.length;
      j.z -= curl * 0.04 * k;
      j.y += curl * 0.015 * k;
    });
  }

  if (preset.pinch !== undefined) {
    const tTip = joints["thumb-tip"], iTip = joints["index-finger-tip"];
    if (tTip && iTip) {
      const center = { x: (tTip.x + iTip.x) / 2, y: (tTip.y + iTip.y) / 2, z: (tTip.z + iTip.z) / 2 };
      const curDist = distMm(tTip, iTip);
      if (Number.isFinite(curDist) && curDist > preset.pinch) {
        const factor = preset.pinch / curDist;
        for (const nm of ["thumb-tip", "index-finger-tip", "thumb-phalanx-distal", "index-finger-phalanx-distal"]) {
          const j = joints[nm];
          if (!j) continue;
          j.x = center.x + (j.x - center.x) * factor;
          j.y = center.y + (j.y - center.y) * factor;
          j.z = center.z + (j.z - center.z) * factor;
        }
      }
    }
  }

  if (preset.wristPitch) {
    const rad = preset.wristPitch * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    for (const j of Object.values(joints)) {
      const y0 = j.y, zRel = j.z - WRIST_PIVOT_Z;
      /* Rigid rotation about the wrist pivot. Reading y0 before writing
         avoids a shear that would change the palm-out normal. */
      j.y = y0 * c - zRel * s;
      j.z = y0 * s + zRel * c + WRIST_PIVOT_Z;
    }
  }
  void sign;
  return joints;
}

/* Browser scripts share these lexical globals. Node tests can require
   the same source without a bundler. */
if (typeof module === "object" && module.exports) {
  module.exports = {
    XR_JOINT_ORDER, XR_JOINT_PARENTS, FINGER_GROUPS,
    RESTED_POSTURE_DEG, ELEVATED_POSTURE_DEG, POSE_PRESETS, PinchState,
    OneEuroFilter, FilterBank, PinchFSM,
    shoulderTorqueNm, fatigueMetrics, postureMoments,
    distMm, handBasis, wristOrientationDeg, classifyGesture,
    buildBaseHandJoints, applyPosePreset, validateJointHierarchy
  };
}

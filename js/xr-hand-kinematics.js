/* =============================================================
   xr-hand-kinematics.js - 25-joint WebXR XRHand hierarchy
   1-Euro smoothing filter, hysteresis pinch FSM, deltoid torque
   ============================================================= */

/* ---------- 25-Joint WebXR XRHand Specification ---------- */
const XR_JOINT_ORDER = [
  "wrist",
  "thumb-metacarpal","thumb-phalanx-proximal","thumb-phalanx-distal","thumb-tip",
  "index-finger-metacarpal","index-finger-phalanx-proximal","index-finger-phalanx-intermediate","index-finger-phalanx-distal","index-finger-tip",
  "middle-finger-metacarpal","middle-finger-phalanx-proximal","middle-finger-phalanx-intermediate","middle-finger-phalanx-distal","middle-finger-tip",
  "ring-finger-metacarpal","ring-finger-phalanx-proximal","ring-finger-phalanx-intermediate","ring-finger-phalanx-distal","ring-finger-tip",
  "pinky-finger-metacarpal","pinky-finger-phalanx-proximal","pinky-finger-phalanx-intermediate","pinky-finger-phalanx-distal","pinky-finger-tip"
];

// Parent index for each joint (null = root)
const XR_JOINT_PARENTS = {
  "wrist": null,
  "thumb-metacarpal":"wrist","thumb-phalanx-proximal":"thumb-metacarpal","thumb-phalanx-distal":"thumb-phalanx-proximal","thumb-tip":"thumb-phalanx-distal",
  "index-finger-metacarpal":"wrist","index-finger-phalanx-proximal":"index-finger-metacarpal","index-finger-phalanx-intermediate":"index-finger-phalanx-proximal","index-finger-phalanx-distal":"index-finger-phalanx-intermediate","index-finger-tip":"index-finger-phalanx-distal",
  "middle-finger-metacarpal":"wrist","middle-finger-phalanx-proximal":"middle-finger-metacarpal","middle-finger-phalanx-intermediate":"middle-finger-phalanx-proximal","middle-finger-phalanx-distal":"middle-finger-phalanx-intermediate","middle-finger-tip":"middle-finger-phalanx-distal",
  "ring-finger-metacarpal":"wrist","ring-finger-phalanx-proximal":"ring-finger-metacarpal","ring-finger-phalanx-intermediate":"ring-finger-phalanx-proximal","ring-finger-phalanx-distal":"ring-finger-phalanx-intermediate","ring-finger-tip":"ring-finger-phalanx-distal",
  "pinky-finger-metacarpal":"wrist","pinky-finger-phalanx-proximal":"pinky-finger-metacarpal","pinky-finger-phalanx-intermediate":"pinky-finger-phalanx-proximal","pinky-finger-phalanx-distal":"pinky-finger-phalanx-intermediate","pinky-finger-tip":"pinky-finger-phalanx-distal"
};

const FINGER_GROUPS = {
  thumb: ["thumb-metacarpal","thumb-phalanx-proximal","thumb-phalanx-distal","thumb-tip"],
  index: ["index-finger-metacarpal","index-finger-phalanx-proximal","index-finger-phalanx-intermediate","index-finger-phalanx-distal","index-finger-tip"],
  middle: ["middle-finger-metacarpal","middle-finger-phalanx-proximal","middle-finger-phalanx-intermediate","middle-finger-phalanx-distal","middle-finger-tip"],
  ring: ["ring-finger-metacarpal","ring-finger-phalanx-proximal","ring-finger-phalanx-intermediate","ring-finger-phalanx-distal","ring-finger-tip"],
  pinky: ["pinky-finger-metacarpal","pinky-finger-phalanx-proximal","pinky-finger-phalanx-intermediate","pinky-finger-phalanx-distal","pinky-finger-tip"]
};

// Base (open-palm, fingers spread) joint positions in hand-local space (meters)
function buildBaseHandJoints(handedness) {
  const sign = handedness === "left" ? -1 : 1;
  // Palm center at origin; fingers extend along +Z
  const joints = {};
  // Wrist slightly behind palm
  joints["wrist"] = { x: 0, y: 0, z: -0.06 };
  // Finger anchor X offsets across palm width
  const anchors = { thumb: -0.055, index: -0.028, middle: 0, ring: 0.022, pinky: 0.042 };
  const thumbZ = [0.01, 0.035, 0.055, 0.072];
  const fingerZ = [0.038, 0.065, 0.085, 0.098, 0.11]; // metacarpal .. tip

  for (const [finger, group] of Object.entries(FINGER_GROUPS)) {
    const ax = anchors[finger] * sign;
    // Thumb has its own Z offsets and slightly different X splay
    if (finger === "thumb") {
      const txOffsets = [0, 0.008, 0.012, 0.016];
      group.forEach((name, i) => {
        joints[name] = { x: (ax + txOffsets[i] * sign), y: -0.015 - i * 0.002, z: thumbZ[i] };
      });
    } else {
      group.forEach((name, i) => {
        joints[name] = { x: ax, y: 0, z: fingerZ[i] };
      });
    }
  }
  return joints;
}

/* ---------- 1-Euro Filter (Casiez et al.) ---------- */
class OneEuroFilter {
  constructor({ freq = 60, minCutoff = 1.0, beta = 0.007, dCutoff = 1.0 } = {}) {
    if (![freq, minCutoff, dCutoff].every(v => Number.isFinite(v) && v > 0) ||
        !Number.isFinite(beta) || beta < 0) throw new RangeError("Invalid filter parameters");
    this.freq = freq;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xPrev = null;
    this.dxPrev = 0;
    this.tPrev = null;
  }
  alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value, timestamp) {
    if (!Number.isFinite(value) || !Number.isFinite(timestamp)) return this.xPrev ?? NaN;
    if (this.tPrev !== null && timestamp <= this.tPrev) return this.xPrev;
    if (this.tPrev === null) {
      this.tPrev = timestamp;
      this.xPrev = value;
      return value;
    }
    const dt = Math.max(0.001, (timestamp - this.tPrev) / 1000);
    this.tPrev = timestamp;
    // Estimate derivative
    const dx = (value - this.xPrev) / dt;
    const aD = this.alpha(this.dCutoff, dt);
    const dxHat = aD * dx + (1 - aD) * this.dxPrev;
    this.dxPrev = dxHat;
    // Adaptive cutoff
    const cutoff = this.minCutoff + this.beta * Math.abs(dxHat);
    const a = this.alpha(cutoff, dt);
    const xHat = a * value + (1 - a) * this.xPrev;
    this.xPrev = xHat;
    return xHat;
  }
  reset() { this.xPrev = null; this.dxPrev = 0; this.tPrev = null; }
}

/* Filter bank: one filter per joint axis (x,y,z) per joint - lightweight version uses per-joint scalar dist */
class FilterBank {
  constructor(opts) {
    this.opts = opts;
    this.filters = new Map();
  }
  _get(key) {
    if (!this.filters.has(key)) this.filters.set(key, new OneEuroFilter(this.opts));
    return this.filters.get(key);
  }
  apply(jointName, axis, value, t) {
    return this._get(jointName + ":" + axis).filter(value, t);
  }
  updateCutoff(cutoff) {
    this.opts.minCutoff = cutoff;
    for (const f of this.filters.values()) f.minCutoff = cutoff;
  }
}

/* ---------- Hysteresis Pinch State Machine ---------- */
const PinchState = { IDLE: "IDLE", HOVER: "HOVER", PINCH_START: "PINCH_START", DRAGGING: "DRAGGING", RELEASE: "RELEASE" };

class PinchFSM {
  constructor({ enterThresholdMm = 20, exitThresholdMm = 28 } = {}) {
    this.enterMm = enterThresholdMm;
    this.exitMm = exitThresholdMm;
    this.state = PinchState.IDLE;
    this.listeners = [];
    this.setThresholds(enterThresholdMm, exitThresholdMm);
  }
  setThresholds(enter, exit) {
    if (!Number.isFinite(enter) || !Number.isFinite(exit) || enter <= 0 || exit <= enter)
      throw new RangeError("Pinch exit threshold must exceed a positive enter threshold");
    this.enterMm = enter; this.exitMm = exit;
  }
  reset() {
    const previous = this.state;
    this.state = PinchState.IDLE;
    if (previous !== this.state) this._emit(previous, this.state);
    return this.state;
  }
  onTransition(cb) { this.listeners.push(cb); }
  _emit(from, to) { for (const cb of this.listeners) cb(from, to); }

  /** distanceMm = thumbTip to indexTip distance in mm */
  update(distanceMm) {
    if (!Number.isFinite(distanceMm) || distanceMm < 0) return this.reset();
    const prev = this.state;
    switch (this.state) {
      case PinchState.IDLE:
        if (distanceMm < this.enterMm + 8) { this.state = PinchState.HOVER; }
        break;
      case PinchState.HOVER:
        if (distanceMm < this.enterMm) { this.state = PinchState.PINCH_START; }
        else if (distanceMm > this.exitMm + 10) { this.state = PinchState.IDLE; }
        break;
      case PinchState.PINCH_START:
        // One-frame confirmation then dragging
        this.state = distanceMm > this.exitMm ? PinchState.RELEASE : PinchState.DRAGGING;
        break;
      case PinchState.DRAGGING:
        if (distanceMm > this.exitMm) { this.state = PinchState.RELEASE; }
        break;
      case PinchState.RELEASE:
        if (distanceMm > this.exitMm + 10) { this.state = PinchState.IDLE; }
        else if (distanceMm < this.enterMm) { this.state = PinchState.PINCH_START; }
        else { this.state = PinchState.HOVER; }
        break;
    }
    if (prev !== this.state) this._emit(prev, this.state);
    return this.state;
  }
  isPinching() { return this.state === PinchState.PINCH_START || this.state === PinchState.DRAGGING; }
  isHovering() { return this.state === PinchState.HOVER; }
}

/* ---------- Biomechanical Deltoid Torque Calculator ----------
 *
 * Two-segment static shoulder-moment model (Chaffin-style quasi-static
 * loading, Drillis-Contini segment anthropometry for a 75 kg reference
 * operator):
 *
 *   M_shoulder = g · ( m_UA · r_UA · sin(θ_ua)
 *                    + m_FA · ( L_UA · sin(θ_ua) + r_FA · sin(θ_fa) ) )
 *
 *   m_UA = 2.8 % body mass (upper arm),  r_UA = 43.6 % segment length
 *   m_FA = 2.2 % body mass (forearm+hand), r_FA = 68.2 % segment length
 *
 * Rested-arm posture  : upper arm 14° from vertical, elbow flexed 20.4°
 *                       (forearm resting toward desk edge)  →  ≈ 2.99 N·m
 * Gorilla-arm posture : upper arm abducted 58°, elbow flexed 62°
 *                       (screen-height reach)              →  ≈ 9.46 N·m
 * Deltoid reduction   :  (9.46 − 2.99) / 9.46  =  68.4 %
 */
function shoulderTorqueNm({ bodyMassKg = 75, upperArmLenM = 0.32, forearmLenM = 0.27,
                            armAbductionDeg = 14, elbowFlexDeg = 20.4, rested = false } = {}) {
  const g = 9.81;
  const s = d => Math.sin(d * Math.PI / 180);
  const mUA = 0.028 * bodyMassKg;      // upper arm segment mass
  const mFA = 0.022 * bodyMassKg;      // forearm + hand segment mass
  const rUA = 0.436 * upperArmLenM;    // upper-arm COM distance from shoulder
  const rFA = 0.682 * forearmLenM;     // forearm+hand COM distance from elbow
  let uaDeg, faDeg;
  if (rested) {
    uaDeg = 14; faDeg = 20.4;          // rested-arm micro-gesture posture
  } else {
    uaDeg = armAbductionDeg; faDeg = elbowFlexDeg;
  }
  const torque = g * (mUA * rUA * s(uaDeg) +
                      mFA * (upperArmLenM * s(uaDeg) + rFA * s(faDeg)));
  return +torque.toFixed(2);
}

function fatigueMetrics(restedTorque, elevatedTorque) {
  const reduction = elevatedTorque > 0 ? ((elevatedTorque - restedTorque) / elevatedTorque * 100) : 0;
  return {
    restedNm: restedTorque,
    elevatedNm: elevatedTorque,
    reductionPct: +reduction.toFixed(1),
    label: reduction > 50 ? "Rested-Arm Advantage" : "Moderate Relief",
    gorillaArmDeg: 58,
    citation: "Chaffin quasi-static shoulder moment · Drillis-Contini anthropometry"
  };
}

/* ---------- Gesture Classifier (lightweight) ---------- */
function classifyGesture(joints) {
  // joints: map jointName -> {x,y,z}
  const thumbTip = joints["thumb-tip"];
  const indexTip = joints["index-finger-tip"];
  const middleTip = joints["middle-finger-tip"];
  const wrist = joints["wrist"];
  if (!thumbTip || !indexTip || !wrist) return { gesture: "unknown", confidence: 0 };
  const pinchDist = distMm(thumbTip, indexTip);
  const wristPitch = Math.atan2(wrist.y || 0, 0.1) * 180 / Math.PI;

  // Palm-up detection: wrist pitch > 25 && fingers roughly extended
  const fingersExtended = ["index","middle","ring","pinky"].every(f => {
    const tip = joints[FINGER_GROUPS[f][4]];
    const mcp = joints[FINGER_GROUPS[f][0]];
    return tip && mcp && (tip.z - mcp.z) > 0.04;
  });

  if (pinchDist < 22) return { gesture: "pinch", confidence: 0.95, pinchDistMm: pinchDist };
  if (wristPitch > 25 && fingersExtended) return { gesture: "palm-up", confidence: 0.88, wristPitch };
  // Two-hand stretch needs both hands - flagged externally
  // poke: index extended, others curled
  const indexExtended = (() => {
    const tip = joints["index-finger-tip"], mcp = joints["index-finger-metacarpal"];
    return tip && mcp && (tip.z - mcp.z) > 0.05;
  })();
  if (indexExtended && pinchDist > 40) return { gesture: "poke", confidence: 0.82 };
  return { gesture: "open-palm", confidence: 0.75, pinchDistMm: pinchDist };
}

function distMm(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz) * 1000;
}

// Pose presets: joint offsets applied to base joints
const POSE_PRESETS = {
  "open":        { pinch: 55, curl: 0, thumbCurl: 0 },
  "pinch":       { pinch: 12, curl: 0.1, thumbCurl: 0.3 },
  "palm-up":     { pinch: 50, curl: 0, thumbCurl: 0, wristPitch: 35 },
  "poke":        { pinch: 60, curl: 0.85, thumbCurl: 0.5, indexCurl: 0 },
  "fist":        { pinch: 20, curl: 0.95, thumbCurl: 0.9 },
};

// Apply a pose preset to base joints (returns new joints map)
function applyPosePreset(baseJoints, presetName, handedness) {
  const preset = POSE_PRESETS[presetName] || POSE_PRESETS.open;
  const joints = {};
  // Deep copy
  for (const [k, v] of Object.entries(baseJoints)) joints[k] = { ...v };
  const sign = handedness === "left" ? -1 : 1;

  // Curl fingers (except thumb/index overrides)
  for (const [finger, group] of Object.entries(FINGER_GROUPS)) {
    let curl = preset.curl ?? 0;
    if (finger === "thumb") curl = preset.thumbCurl ?? curl;
    if (finger === "index" && preset.indexCurl !== undefined) curl = preset.indexCurl;
    if (curl === 0) continue;
    group.forEach((name) => {
      const j = joints[name];
      if (!j) return;
      // Curl: pull Z back and Y up slightly
      j.z -= curl * 0.04 * (group.indexOf(name) / group.length);
      j.y += curl * 0.015 * (group.indexOf(name) / group.length);
    });
  }
  // Pinch: bring thumb tip and index tip together
  if (preset.pinch !== undefined) {
    const tTip = joints["thumb-tip"], iTip = joints["index-finger-tip"];
    if (tTip && iTip) {
      const center = { x: (tTip.x + iTip.x) / 2, y: (tTip.y + iTip.y) / 2, z: (tTip.z + iTip.z) / 2 };
      const curDist = distMm(tTip, iTip);
      const targetDist = preset.pinch;
      if (curDist > targetDist) {
        const factor = targetDist / curDist;
        // Move both tips toward center
        for (const nm of ["thumb-tip","index-finger-tip","thumb-phalanx-distal","index-finger-phalanx-distal"]) {
          const j = joints[nm]; if (!j) continue;
          j.x = center.x + (j.x - center.x) * factor;
          j.y = center.y + (j.y - center.y) * factor;
          j.z = center.z + (j.z - center.z) * factor;
        }
      }
    }
  }
  // Wrist pitch (palm-up)
  if (preset.wristPitch) {
    const rad = preset.wristPitch * Math.PI / 180;
    for (const j of Object.values(joints)) {
      const y2 = j.y * Math.cos(rad) - (j.z + 0.06) * Math.sin(rad);
      const z2 = j.y * Math.sin(rad) + (j.z + 0.06) * Math.cos(rad) - 0.06;
      j.y = y2; j.z = z2;
    }
  }
  return joints;
}

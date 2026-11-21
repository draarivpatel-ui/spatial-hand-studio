"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const K = require(path.join(__dirname, "..", "js", "xr-hand-kinematics.js"));
const T = require(path.join(__dirname, "..", "js", "hand-telemetry.js"));

const PRESETS = ["open", "pinch", "palm-up", "poke", "fist"];

test("XRHand joint list has 25 unique names and a valid acyclic hierarchy", () => {
  assert.equal(K.XR_JOINT_ORDER.length, 25);
  assert.equal(new Set(K.XR_JOINT_ORDER).size, 25);
  const h = K.validateJointHierarchy();
  assert.equal(h.valid, true);
  assert.equal(h.jointCount, 25);
  assert.deepEqual(h.roots, ["wrist"]);
  assert.equal(h.longestChain, 6);
  for (const name of K.XR_JOINT_ORDER) {
    const parent = K.XR_JOINT_PARENTS[name];
    assert.ok(parent === null || K.XR_JOINT_ORDER.includes(parent), name);
  }
  assert.equal(Object.values(K.FINGER_GROUPS).flat().length + 1, 25);
});

test("base rigs are finite, mirrored in X and keep the wrist at the pivot", () => {
  for (const handedness of ["left", "right"]) {
    const joints = K.buildBaseHandJoints(handedness);
    assert.equal(Object.keys(joints).length, 25);
    assert.equal(joints.wrist.z, -0.06);
    for (const [name, p] of Object.entries(joints)) {
      assert.ok([p.x, p.y, p.z].every(Number.isFinite), name);
    }
  }
  const l = K.buildBaseHandJoints("left"), r = K.buildBaseHandJoints("right");
  assert.equal(l["index-finger-tip"].x, -r["index-finger-tip"].x);
  assert.equal(l["pinky-finger-tip"].x, -r["pinky-finger-tip"].x);
  assert.equal(l["index-finger-tip"].z, r["index-finger-tip"].z);
});

test("every pose preset keeps 25 finite joints and the declared pinch distance", () => {
  for (const handedness of ["left", "right"]) {
    const base = K.buildBaseHandJoints(handedness);
    for (const preset of PRESETS) {
      const joints = K.applyPosePreset(base, preset, handedness);
      assert.equal(Object.keys(joints).length, 25, preset);
      for (const [name, p] of Object.entries(joints)) {
        assert.ok([p.x, p.y, p.z].every(Number.isFinite), preset + ":" + name);
      }
      const d = K.distMm(joints["thumb-tip"], joints["index-finger-tip"]);
      /* The pinch step only closes tips; it never opens them. Curl can
         increase separation slightly for poke and fist, so presets whose
         target exceeds the base distance keep their curled distance. */
      const baseD = K.distMm(base["thumb-tip"], base["index-finger-tip"]);
      const target = K.POSE_PRESETS[preset].pinch;
      if (target < baseD) assert.ok(Math.abs(d - target) < 1e-6, preset + " " + d);
      else assert.ok(d > 0 && Number.isFinite(d), preset + " " + d);
      assert.ok(d < 100, preset + " tip separation must stay anatomically plausible");
      assert.ok(!Object.values(base).some((p, i) => p === Object.values(joints)[i]), "input must not be mutated");
    }
  }
});

test("wrist pitch rotation is rigid and preserves all pairwise distances", () => {
  const base = K.buildBaseHandJoints("right");
  const rotated = K.applyPosePreset(base, "palm-up", "right");
  const names = K.XR_JOINT_ORDER;
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const before = K.distMm(base[names[i]], base[names[j]]);
      const after = K.distMm(rotated[names[i]], rotated[names[j]]);
      assert.ok(Math.abs(before - after) < 1e-6, names[i] + "/" + names[j]);
    }
  }
  assert.ok(Math.abs(K.wristOrientationDeg(rotated).pitchDeg - 35) < 1e-9);
  assert.equal(rotated.wrist.y, base.wrist.y);
  assert.equal(rotated.wrist.z, base.wrist.z);
});

test("hand basis is orthonormal for the open palm", () => {
  const b = K.handBasis(K.buildBaseHandJoints("right"));
  assert.ok(b);
  assert.ok(Math.abs(b.normal.y - 1) < 1e-12);
  assert.ok(Math.abs(b.normal.x) < 1e-12);
  assert.ok(Math.abs(b.normal.z) < 1e-12);
  assert.deepEqual(K.wristOrientationDeg(K.buildBaseHandJoints("right")), { pitchDeg: 0, rollDeg: 0 });
  assert.equal(K.handBasis({ wrist: { x: 0, y: 0, z: 0 } }), null);
  assert.equal(K.handBasis({ wrist: { x: NaN, y: 0, z: 0 }, "index-finger-metacarpal": { x: 0, y: 0, z: 0 }, "middle-finger-metacarpal": { x: 0, y: 0, z: 0 }, "pinky-finger-metacarpal": { x: 0, y: 0, z: 0 } }), null);
});

test("gesture classifier labels all five presets and rejects bad input", () => {
  const base = K.buildBaseHandJoints("right");
  const expected = { open: "open-palm", pinch: "pinch", "palm-up": "palm-up", poke: "poke", fist: "fist" };
  for (const preset of PRESETS) {
    assert.equal(K.classifyGesture(K.applyPosePreset(base, preset, "right")).gesture, expected[preset], preset);
  }
  assert.equal(K.classifyGesture(null).gesture, "unknown");
  assert.equal(K.classifyGesture({}).gesture, "unknown");
  assert.equal(K.classifyGesture({ "thumb-tip": { x: NaN, y: 0, z: 0 }, "index-finger-tip": { x: 0, y: 0, z: 0 } }).gesture, "unknown");
});

test("palm-relative finger extension preserves pinch, fist and poke labels under yaw", () => {
  for (const handedness of ["right", "left"]) {
    const base = K.buildBaseHandJoints(handedness);
    for (const preset of ["pinch", "fist", "poke", "open"]) {
      const joints = K.applyPosePreset(base, preset, handedness);
      const expected = preset === "open" ? "open-palm" : preset;
      for (const yaw of [-Math.PI, -Math.PI / 2, -0.8, 0, 0.8, Math.PI / 2, Math.PI]) {
        const c = Math.cos(yaw), s = Math.sin(yaw);
        const rotated = Object.fromEntries(Object.entries(joints).map(([name, p]) => [name, {
          x: 0.4 + p.x * c + p.z * s, y: 0.3 + p.y, z: -0.2 - p.x * s + p.z * c
        }]));
        const result = K.classifyGesture(rotated, handedness);
        assert.equal(result.gesture, expected, handedness + " " + preset + " yaw " + yaw);
        assert.ok(Math.abs(result.pinchDistMm - K.distMm(joints["thumb-tip"], joints["index-finger-tip"])) < 1e-9);
      }
    }
  }
});

test("mirrored left palms share the right-hand normal and pitch convention", () => {
  for (const preset of ["open", "palm-up"]) {
    const right = K.applyPosePreset(K.buildBaseHandJoints("right"), preset, "right");
    const left = K.applyPosePreset(K.buildBaseHandJoints("left"), preset, "left");
    const rb = K.handBasis(right, "right"), lb = K.handBasis(left, "left");
    for (const key of ["x", "y", "z"]) assert.ok(Math.abs(rb.normal[key] - lb.normal[key]) < 1e-12);
    const expected = preset === "open" ? 0 : 35;
    assert.ok(Math.abs(K.wristOrientationDeg(left, "left").pitchDeg - expected) < 1e-9);
    assert.equal(K.classifyGesture(left, "left").gesture, preset === "open" ? "open-palm" : "palm-up");
  }
});

test("resetSignal clears only the lost signal's filter history", () => {
  const bank = new K.FilterBank({ minCutoff: 1.2 });
  bank.apply("xr-right", "dist", 12, 1000);
  bank.apply("xr-left", "dist", 55, 1000);
  bank.resetSignal("xr-right");
  assert.equal(bank.filters.has("xr-right:dist"), false);
  assert.equal(bank.filters.get("xr-left:dist").xPrev, 55);
  assert.equal(bank.apply("xr-right", "dist", 29, 1016), 29);
});

test("distMm returns NaN for nonfinite coordinates", () => {
  assert.ok(Number.isNaN(K.distMm({ x: NaN, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })));
  assert.ok(Number.isNaN(K.distMm(null, { x: 0, y: 0, z: 0 })));
  assert.equal(K.distMm({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0.01 }), 10);
});

test("1-Euro filter rejects invalid configuration", () => {
  for (const opts of [{ minCutoff: 0 }, { beta: -1 }, { freq: NaN }, { dCutoff: 0 }, { minCutoff: Infinity }]) {
    assert.throws(() => new K.OneEuroFilter(opts), RangeError);
  }
  assert.ok(new K.OneEuroFilter({ beta: 0, minCutoff: 0.4 }));
});

test("1-Euro filter ignores nonfinite samples without poisoning state", () => {
  const f = new K.OneEuroFilter();
  assert.equal(f.filter(12, 0), 12);
  assert.equal(f.filter(NaN, 10), 12);
  assert.equal(f.filter(Infinity, 20), 12);
  assert.equal(f.filter("12", 30), 12);
  assert.ok(Number.isFinite(f.filter(20, 40)));
  assert.ok(f.filter(20, 50) > 12 && f.filter(20, 60) < 20);
});

test("1-Euro filter ignores repeated and backward timestamps", () => {
  const f = new K.OneEuroFilter();
  f.filter(12, 100);
  assert.equal(f.filter(999, 100), 12);
  assert.equal(f.filter(999, 90), 12);
  assert.equal(f.tPrev, 100);
  assert.ok(f.filter(20, 116) > 12);
});

test("1-Euro filter derivative uses raw samples and adapts cutoff with speed", () => {
  const slow = new K.OneEuroFilter({ minCutoff: 0.5, beta: 0.01, dCutoff: 1 });
  const fast = new K.OneEuroFilter({ minCutoff: 0.5, beta: 0.01, dCutoff: 1 });
  for (let t = 0; t <= 100; t += 16) {
    slow.filter(10 + t * 0.001, t);
    fast.filter(10 + t * 0.1, t);
  }
  assert.ok(Math.abs(slow.dxPrev) < Math.abs(fast.dxPrev));
  assert.ok(fast.minCutoff + fast.beta * Math.abs(fast.dxPrev) > slow.minCutoff + slow.beta * Math.abs(slow.dxPrev));
  /* A jump after an ignored bad sample still uses the last raw value. */
  const f = new K.OneEuroFilter();
  f.filter(0, 0);
  f.filter(NaN, 16);
  assert.equal(f.rawPrev, 0);
  assert.ok(f.filter(100, 32) > 0);
});

test("1-Euro filter tracks a constant signal and reset clears all state", () => {
  const f = new K.OneEuroFilter();
  for (let t = 0; t < 500; t += 16) f.filter(7, t);
  assert.ok(Math.abs(f.xPrev - 7) < 1e-9);
  f.reset();
  assert.equal(f.xPrev, null);
  assert.equal(f.rawPrev, null);
  assert.equal(f.tPrev, null);
  assert.equal(f.dxPrev, 0);
  assert.equal(f.filter(42, 1000), 42);
});

test("FilterBank keeps independent state per signal and updates cutoff", () => {
  const bank = new K.FilterBank({ minCutoff: 1, beta: 0.007 });
  assert.equal(bank.apply("pinch", "x", 10, 0), 10);
  assert.equal(bank.apply("wrist", "x", 90, 0), 90);
  bank.updateCutoff(2.5);
  assert.equal(bank.opts.minCutoff, 2.5);
  for (const f of bank.filters.values()) assert.equal(f.minCutoff, 2.5);
  assert.throws(() => bank.updateCutoff(0), RangeError);
  bank.reset();
  assert.equal(bank.filters.size, 0);
});

test("pinch hysteresis uses distinct enter and exit thresholds", () => {
  const fsm = new K.PinchFSM({ enterThresholdMm: 20, exitThresholdMm: 28 });
  assert.equal(fsm.update(24), "HOVER");
  assert.equal(fsm.update(12), "PINCH_START");
  assert.equal(fsm.update(24), "DRAGGING");
  assert.equal(fsm.update(28), "DRAGGING");
  assert.equal(fsm.update(29), "RELEASE");
  assert.equal(fsm.update(39), "IDLE");
});

test("a pinch canceled during the one-frame start state never becomes a drag", () => {
  const fsm = new K.PinchFSM();
  fsm.update(24); fsm.update(12);
  assert.equal(fsm.update(50), "RELEASE");
  assert.equal(fsm.isPinching(), false);
});

test("invalid or missing tracking resets the pinch FSM", () => {
  const fsm = new K.PinchFSM();
  const transitions = [];
  const off = fsm.onTransition((from, to) => transitions.push([from, to]));
  fsm.update(24); fsm.update(12); fsm.update(24);
  assert.equal(fsm.state, "DRAGGING");
  assert.equal(fsm.update(NaN), "IDLE");
  assert.equal(fsm.update(-1), "IDLE");
  assert.equal(fsm.isPinching(), false);
  off();
  const count = transitions.length;
  fsm.update(24); fsm.update(12);
  assert.equal(transitions.length, count);
  assert.equal(typeof fsm.reset(), "string");
});

test("invalid hysteresis thresholds and listeners are rejected", () => {
  assert.throws(() => new K.PinchFSM({ enterThresholdMm: 20, exitThresholdMm: 10 }), RangeError);
  assert.throws(() => new K.PinchFSM({ enterThresholdMm: 0, exitThresholdMm: 28 }), RangeError);
  assert.throws(() => new K.PinchFSM({ hoverBandMm: -1 }), RangeError);
  const fsm = new K.PinchFSM();
  assert.throws(() => fsm.setThresholds(0, 10), RangeError);
  assert.throws(() => fsm.onTransition(null), TypeError);
  fsm.setThresholds(14, 22);
  assert.equal(fsm.enterMm, 14);
  assert.equal(fsm.exitMm, 22);
});

test("custom hysteresis bands drive hover and release exit", () => {
  const fsm = new K.PinchFSM({ enterThresholdMm: 20, exitThresholdMm: 28, hoverBandMm: 5, releaseBandMm: 3 });
  /* Hover entry uses enter + hoverBand = 25 mm, with a strict comparison. */
  assert.equal(fsm.update(24), "HOVER");
  assert.equal(fsm.update(25), "HOVER");
  assert.equal(fsm.update(32), "IDLE");
  fsm.update(24); fsm.update(12); fsm.update(24);
  assert.equal(fsm.update(30), "RELEASE");
  assert.equal(fsm.update(32), "IDLE");
});

test("shoulder moments reproduce 2.99, 9.46 and 68.4 percent", () => {
  const m = K.postureMoments();
  assert.equal(m.restedNm, 2.99);
  assert.equal(m.elevatedNm, 9.46);
  assert.equal(m.metrics.reductionPct, 68.4);
  assert.deepEqual(m.restedPostureDeg, { armAbductionDeg: 14, elbowFlexDeg: 20.4 });
  assert.deepEqual(m.elevatedPostureDeg, { armAbductionDeg: 58, elbowFlexDeg: 62 });
  assert.match(m.metrics.note, /no measured fatigue/i);
  assert.equal(K.shoulderTorqueNm({ rested: true }), 2.99);
  assert.equal(K.shoulderTorqueNm({ ...K.ELEVATED_POSTURE_DEG }), 9.46);
});

test("shoulder moment is monotone in posture angles and rejects invalid inputs", () => {
  assert.ok(K.shoulderTorqueNm({ armAbductionDeg: 30, elbowFlexDeg: 20 }) > K.shoulderTorqueNm({ armAbductionDeg: 10, elbowFlexDeg: 20 }));
  assert.ok(K.shoulderTorqueNm({ armAbductionDeg: 10, elbowFlexDeg: 60 }) > K.shoulderTorqueNm({ armAbductionDeg: 10, elbowFlexDeg: 10 }));
  assert.equal(K.shoulderTorqueNm({ armAbductionDeg: 0, elbowFlexDeg: 0 }), 0);
  assert.throws(() => K.shoulderTorqueNm({ bodyMassKg: -1 }), RangeError);
  assert.throws(() => K.shoulderTorqueNm({ upperArmLenM: NaN }), RangeError);
  assert.throws(() => K.fatigueMetrics(NaN, 9.46), RangeError);
  assert.equal(K.fatigueMetrics(5, 0).reductionPct, 0);
});

test("posture comparison is deterministic across repeated calls", () => {
  const a = K.postureMoments();
  for (let i = 0; i < 25; i++) assert.deepEqual(K.postureMoments(), a);
  assert.equal(Object.isFrozen(K.RESTED_POSTURE_DEG), true);
  assert.equal(Object.isFrozen(K.ELEVATED_POSTURE_DEG), true);
  assert.equal(Object.isFrozen(K.POSE_PRESETS), true);
});

test("one-euro and telemetry distances agree on a known vector", () => {
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0.03, y: 0.04, z: 0 };
  assert.equal(T.distanceM(a, b), 0.05);
  assert.equal(K.distMm(a, b), 50);
});


test("palm basis has three orthogonal unit vectors for every finite preset", () => {
  for (const preset of PRESETS) {
    const b = K.handBasis(K.applyPosePreset(K.buildBaseHandJoints("right"), preset, "right"));
    const axes = [b.forward, b.across, b.normal];
    for (const a of axes) assert.ok(Math.abs(Math.hypot(a.x, a.y, a.z) - 1) < 1e-12);
    for (let i = 0; i < axes.length; i++) for (let j = i + 1; j < axes.length; j++) {
      const a = axes[i], q = axes[j];
      assert.ok(Math.abs(a.x * q.x + a.y * q.y + a.z * q.z) < 1e-12);
    }
  }
  assert.throws(() => K.shoulderTorqueNm({ armAbductionDeg: -1 }), RangeError);
  assert.throws(() => K.shoulderTorqueNm({ elbowFlexDeg: 91 }), RangeError);
});

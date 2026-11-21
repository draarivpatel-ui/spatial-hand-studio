"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHarness } = require("./helpers/dom-harness.cjs");

/* A minimal XRHand: joint name -> object with a position in local-floor. */
function fakeHand(overrides = {}) {
  const K = require("../js/xr-hand-kinematics.js");
  const map = new Map();
  for (const name of K.XR_JOINT_ORDER) map.set(name, { name });
  for (const [name, p] of Object.entries(overrides)) map.set(name, { name });
  const poses = new Map(Object.entries(overrides));
  return {
    hand: {
      get(name) { return map.get(name) || null; }
    },
    poses,
    frame: {
      getJointPose(joint, refSpace) {
        const p = poses.get(joint.name);
        if (!p || !refSpace) return null;
        return { transform: { position: p } };
      }
    }
  };
}

function xrStub({ ar = true, vr = true, request = null } = {}) {
  const calls = { isSessionSupported: [], requestSession: [], requestReferenceSpace: [], end: 0 };
  const listeners = {};
  const session = {
    inputSources: [],
    requestAnimationFrame(cb) { this._cb = cb; return 7; },
    requestReferenceSpace: async type => { calls.requestReferenceSpace.push(type); return { type }; },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    end: async () => { calls.end++; (listeners.end || []).forEach(fn => fn()); },
    _cb: null
  };
  const xr = {
    isSessionSupported: async mode => { calls.isSessionSupported.push(mode); return mode === "immersive-ar" ? ar : vr; },
    requestSession: async (mode, opts) => {
      calls.requestSession.push({ mode, opts });
      if (request) return request(mode, opts);
      return session;
    }
  };
  return { xr, session, calls, listeners };
}

/* ---------- Coordinate transform ---------- */
test("xrPoseToDesk is a proper 180 degree rotation about Y plus a desk offset", () => {
  const h = createHarness();
  h.boot();
  const f = h.app.xrPoseToDesk;
  const origin = f({ x: 0, y: 0.9, z: 0 });
  assert.equal(origin.x, 0); assert.equal(origin.y, 0); assert.equal(origin.z, 0);
  assert.equal(Object.is(origin.x, -0), false, "negative zero is normalised");
  const mapped = f({ x: 0.2, y: 1.1, z: -0.3 });
  assert.ok(Math.abs(mapped.x + 0.2) < 1e-12);
  assert.ok(Math.abs(mapped.y - 0.2) < 1e-12);
  assert.ok(Math.abs(mapped.z - 0.3) < 1e-12);
  /* Rotation preserves distance between any two points. */
  const a = { x: 0.1, y: 1.0, z: -0.2 }, b = { x: -0.4, y: 1.2, z: 0.5 };
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  assert.ok(Math.abs(dist(a, b) - dist(f(a), f(b))) < 1e-12);
  /* Determinant of the linear part is +1: rotation, not reflection. */
  const e1 = f({ x: 1, y: 0.9, z: 0 }), e2 = f({ x: 0, y: 1.9, z: 0 }), e3 = f({ x: 0, y: 0.9, z: 1 });
  const col = [e1, e2, e3];
  const det = col[0].x * (col[1].y * col[2].z - col[1].z * col[2].y)
            - col[1].x * (col[0].y * col[2].z - col[0].z * col[2].y)
            + col[2].x * (col[0].y * col[1].z - col[0].z * col[1].y);
  assert.ok(Math.abs(det - 1) < 1e-12, "determinant +1 = rotation, not reflection");
});

test("XR joint sampling keeps native coordinates for pinch distance", () => {
  const h = createHarness();
  h.boot();
  const K = require("../js/xr-hand-kinematics.js");
  const f = h.app.xrPoseToDesk;
  const tt = { x: 0.10, y: 1.2, z: -0.4 };
  const it = { x: 0.12, y: 1.2, z: -0.4 };
  assert.ok(Math.abs(K.distMm(tt, it) - 20) < 1e-9);
  assert.ok(Math.abs(K.distMm(f(tt), f(it)) - 20) < 1e-9, "rotation preserves the pinch distance");
});

/* ---------- Support detection and fallback ---------- */
test("no navigator.xr keeps the desktop simulator and updates the status badge", async () => {
  const h = createHarness();
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  assert.equal(h.app.state.xrActive, false);
  assert.equal(h.el("xr-support-status").textContent, "WebXR: unavailable (desktop simulator)");
  assert.match(h.el("toast").textContent, /Desktop simulator remains active/);
  assert.match(h.el("btn-enter-xr").querySelector(".btn-label").textContent, /WebXR unavailable/);
});

test("no immersive mode reported falls back to the desktop simulator", async () => {
  const { xr, calls } = xrStub({ ar: false, vr: false });
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  /* Boot and enterXR each probe both modes; concurrent async calls make
     the interleaved order nondeterministic, so assert the multiset. */
  const checked = calls.isSessionSupported.slice().sort();
  assert.deepEqual(checked, ["immersive-ar", "immersive-ar", "immersive-vr", "immersive-vr"]);
  assert.equal(calls.requestSession.length, 0);
  assert.equal(h.app.state.xrActive, false);
  assert.match(h.el("btn-enter-xr").querySelector(".btn-label").textContent, /no immersive mode/);
});

test("immersive-vr is selected when immersive-ar is unavailable", async () => {
  const { xr, calls } = xrStub({ ar: false, vr: true });
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  assert.equal(calls.requestSession[0].mode, "immersive-vr");
  assert.equal(h.app.xr.mode, "immersive-vr");
  assert.equal(h.app.state.xrActive, true);
  assert.deepEqual([...calls.requestSession[0].opts.requiredFeatures], ["local-floor", "hand-tracking"]);
});

test("required feature rejection retries with optional hand tracking", async () => {
  let attempt = 0;
  const { xr, session, calls } = xrStub({
    request: (mode, opts) => {
      attempt++;
      if (opts.requiredFeatures && opts.requiredFeatures.includes("hand-tracking")) {
        throw new Error("NotSupportedError: hand-tracking");
      }
      return session;
    }
  });
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  assert.equal(attempt, 2);
  assert.ok(calls.requestSession[1].opts.optionalFeatures.includes("hand-tracking"));
  assert.equal(calls.requestSession[1].opts.requiredFeatures, undefined);
  assert.equal(h.app.xr.handTrackingRequested, false);
  assert.equal(h.app.state.xrActive, true);
  assert.match(h.el("toast").textContent, /hand tracking optional/);
});

test("both requestSession attempts failing restores the desktop state", async () => {
  const { xr } = xrStub({ request: () => { throw new Error("denied"); } });
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  assert.equal(h.app.state.xrActive, false);
  assert.equal(h.app.xr.session, null);
  assert.match(h.el("toast").textContent, /WebXR request failed: denied/);
  assert.equal(h.el("btn-enter-xr").querySelector(".btn-label").textContent, "Request WebXR Hand Session");
});

test("requestReferenceSpace falls back from local-floor to local and records the type", async () => {
  const { xr, session, calls } = xrStub();
  session.requestReferenceSpace = async type => {
    calls.requestReferenceSpace.push(type);
    if (type === "local-floor") throw new Error("unsupported");
    return { type };
  };
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls.requestReferenceSpace, ["local-floor", "local"]);
  assert.equal(h.app.xr.referenceSpace, "local");
  assert.equal(h.app.state.xrActive, true);
});

test("no reference space at all ends the session attempt cleanly", async () => {
  const { xr, session, calls } = xrStub();
  session.requestReferenceSpace = async () => { throw new Error("no space"); };
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  assert.equal(h.app.state.xrActive, false);
  assert.equal(h.app.xr.session, null);
  assert.match(h.el("toast").textContent, /No XR reference space available/);
  assert.equal(calls.end, 1);
  assert.equal(h.app.xr.mode, null);
});

test("XR session end clears all joint state, resets the FSM and resumes the loop", async () => {
  const { xr, session, listeners } = xrStub();
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  h.app.xr.joints.right = { wrist: { x: 1, y: 2, z: 3 } };
  h.app.xr.wristWorld = { x: 1, y: 2, z: 3 };
  h.app.xr.lastPinchMm.right = 12;
  h.app.pinchFSM.update(24); h.app.pinchFSM.update(12);
  assert.notEqual(h.app.pinchFSM.state, "IDLE");
  (listeners.end || []).forEach(fn => fn());
  assert.equal(h.app.state.xrActive, false);
  assert.equal(h.app.xr.session, null);
  assert.equal(h.app.xr.joints.right, null);
  assert.equal(h.app.xr.wristWorld, null);
  assert.equal(h.app.xr.lastPinchMm.right, null);
  assert.equal(h.app.pinchFSM.state, "IDLE");
  assert.equal(h.app.state.lastFrameNow, null);
  assert.equal(h.el("btn-enter-xr").querySelector(".btn-label").textContent, "Request WebXR Hand Session");
});

/* ---------- XR frame sampling ---------- */
test("processXRHandFrame samples 25 finite joints, mirrors the right hand and advances the FSM", async () => {
  const { xr, session } = xrStub();
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  const K = require("../js/xr-hand-kinematics.js");
  const poses = {};
  for (let i = 0; i < K.XR_JOINT_ORDER.length; i++) {
    poses[K.XR_JOINT_ORDER[i]] = { x: i * 0.01, y: 1.0 + i * 0.001, z: -0.5 };
  }
  poses["thumb-tip"] = { x: 0, y: 1.2, z: -0.4 };
  poses["index-finger-tip"] = { x: 0.012, y: 1.2, z: -0.4 };
  const fake = fakeHand(poses);
  session.inputSources = [{ handedness: "right", hand: fake.hand, gamepad: null }];
  const src = h.app.xr;
  const frameObj = fake.frame;
  const app = h.app;

  const states = [];
  app.pinchFSM.onTransition((from, to) => states.push(to));
  src.session = session;
  src.refSpace = { type: "local-floor" };
  app.processXRHandFrame(1000, frameObj);
  assert.equal(Object.keys(app.xr.joints.right).length, 25);
  assert.equal(app.xr.lastPinchMm.right, 12);
  assert.ok(Number.isFinite(app.xr.lastFilteredPinchMm.right));
  assert.equal(app.pinchFSM.state, "HOVER");
  assert.ok(Math.abs(app.xr.wristWorld.x) < 1e-12);
  assert.ok(Math.abs(app.xr.wristWorld.y - 0.1) < 1e-9);
  assert.ok(Math.abs(app.xr.wristWorld.z - 0.5) < 1e-12);
  for (const p of Object.values(app.xr.joints.right)) {
    assert.ok([p.x, p.y, p.z].every(Number.isFinite));
  }
  assert.ok(Object.is(app.xr.joints.right.wrist.x, -poses.wrist.x) ||
            Math.abs(app.xr.joints.right.wrist.x + poses.wrist.x) < 1e-12);
  void states;
});

test("nonfinite joint poses are skipped and a missing wrist resets tracking", async () => {
  const { xr, session } = xrStub();
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  const app = h.app;
  app.xr.session = session;
  app.xr.refSpace = { type: "local-floor" };
  const fake = fakeHand({
    wrist: { x: 0, y: 1, z: -0.5 },
    "thumb-tip": { x: 0, y: 1.2, z: -0.4 },
    "index-finger-tip": { x: 0.012, y: 1.2, z: -0.4 },
    "middle-finger-tip": { x: NaN, y: 1, z: -0.4 }
  });
  session.inputSources = [{ handedness: "right", hand: fake.hand }];
  app.processXRHandFrame(1000, fake.frame);
  assert.equal(Object.keys(app.xr.joints.right).length, 3);
  assert.equal(app.xr.joints.right["middle-finger-tip"], undefined);

  /* A hand whose only joint is the thumb tip has no wrist; the frame
     must be ignored and the right-hand mirror cleared. */
  const wristless = fakeHand({ "thumb-tip": { x: 0, y: 1, z: 0 } });
  session.inputSources = [{ handedness: "right", hand: wristless.hand }];
  app.processXRHandFrame(1016, wristless.frame);
  assert.equal(app.xr.joints.right, null);
  assert.equal(app.xr.wristWorld, null);
  assert.equal(app.pinchFSM.state, "IDLE");
});

test("getJointPose throwing or returning null does not break the frame", async () => {
  const { xr, session } = xrStub();
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  const app = h.app;
  app.xr.session = session;
  app.xr.refSpace = { type: "local-floor" };
  const hand = { get: () => ({}) };
  session.inputSources = [{ handedness: "right", hand }];
  const throwingFrame = { getJointPose: () => { throw new Error("pose failed"); } };
  assert.doesNotThrow(() => app.processXRHandFrame(1000, throwingFrame));
  assert.equal(app.xr.joints.right, null);
  const nullFrame = { getJointPose: () => null };
  assert.doesNotThrow(() => app.processXRHandFrame(1016, nullFrame));
  assert.equal(app.pinchFSM.state, "IDLE");
});

test("only the right hand drives the shared pinch FSM", async () => {
  const { xr, session } = xrStub();
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  const app = h.app;
  app.xr.session = session;
  app.xr.refSpace = { type: "local-floor" };
  const poses = tipX => ({
    wrist: { x: 0, y: 1, z: -0.5 },
    "thumb-tip": { x: 0, y: 1.2, z: -0.4 },
    "index-finger-tip": { x: tipX, y: 1.2, z: -0.4 }
  });
  const leftPoses = poses(0.3), rightPoses = poses(0.012);
  /* Tag each joint object with its owning hand so one shared XRFrame
     callback can resolve both hands without ambiguity. */
  const make = (tag, p) => {
    const hand = { get: name => p[name] ? { tag, name } : null };
    return { hand, frame: { getJointPose: (j, ref) => j.tag === tag && ref ? { transform: { position: p[j.name] } } : null } };
  };
  const left = make("left", leftPoses), right = make("right", rightPoses);
  session.inputSources = [
    { handedness: "left", hand: left.hand },
    { handedness: "right", hand: right.hand }
  ];
  const frame = { getJointPose: (j, ref) => left.frame.getJointPose(j, ref) || right.frame.getJointPose(j, ref) };
  app.processXRHandFrame(1000, frame);
  assert.ok(Math.abs(app.xr.lastPinchMm.left - 300) < 1e-9);
  assert.ok(Math.abs(app.xr.lastPinchMm.right - 12) < 1e-9);
  assert.notEqual(app.pinchFSM.state, "IDLE");
});

test("haptics pulse is guarded by capability checks", async () => {
  const { xr, session } = xrStub();
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  let pulses = 0;
  h.app.pulseXRHandHaptics({ gamepad: { hapticActuators: [{ pulse: () => { pulses++; return Promise.resolve(true); } }] } });
  assert.equal(pulses, 1);
  assert.doesNotThrow(() => h.app.pulseXRHandHaptics({ gamepad: null }));
  assert.doesNotThrow(() => h.app.pulseXRHandHaptics({ gamepad: { hapticActuators: [{ pulse: () => { throw new Error("no actuator"); } }] } }));
  assert.equal(pulses, 1);
  void session;
});

test("WebXR-owned input prevents the desktop loop from advancing the FSM", async () => {
  const { xr, session } = xrStub();
  const h = createHarness({ xr });
  h.boot();
  h.el("btn-enter-xr").dispatch("click", {});
  await new Promise(r => setImmediate(r));
  const app = h.app;
  const fake = fakeHand({
    wrist: { x: 0, y: 1, z: -0.5 },
    "thumb-tip": { x: 0, y: 1.2, z: -0.4 },
    "index-finger-tip": { x: 0.012, y: 1.2, z: -0.4 }
  });
  session.inputSources = [{ handedness: "right", hand: fake.hand }];
  app.xr.refSpace = { type: "local-floor" };
  app.processXRHandFrame(1000, fake.frame);
  const before = app.pinchFSM.state;
  h.setClock(1016);
  h.flushRaf(1016);
  assert.equal(app.pinchFSM.state, before, "desktop loop must read, not update, XR state");
  assert.equal(app.telemetryFrames[app.telemetryFrames.length - 1].pinchState, before);
  assert.equal(app.telemetryFrames[app.telemetryFrames.length - 1].pinchMm, app.xr.lastFilteredPinchMm.right);
});

test("updateXRSupport reports the exact supported mode", async () => {
  const cases = [
    [{ ar: true, vr: true }, "WebXR: immersive-ar reported"],
    [{ ar: false, vr: true }, "WebXR: immersive-vr reported"],
    [{ ar: false, vr: false }, "WebXR: no immersive mode reported"]
  ];
  for (const [opts, expected] of cases) {
    const { xr } = xrStub(opts);
    const h = createHarness({ xr });
    h.boot();
    await new Promise(r => setImmediate(r));
    assert.equal(h.el("xr-support-status").textContent, expected);
  }
});


test("tracking loss keeps desktop presets from advancing a live XR state machine", async () => {
  const { xr, session } = xrStub();
  const h = createHarness({ xr }); h.boot();
  await h.app.enterXR();
  session.inputSources = [];
  h.app.processXRHandFrame(100, { getJointPose() {} });
  for (let t = 116; t <= 300; t += 16) h.app.frame(t);
  assert.equal(h.app.pinchFSM.state, "IDLE");
  assert.equal(h.app.renderer.hands.length, 0);
  assert.equal(h.app.telemetryFrames.at(-1).wrist, null);
  assert.equal(h.app.telemetryFrames.at(-1).source, "xr-hand");
  assert.match(h.el("kv-pinch").textContent, /unavailable/);
});

test("right-hand reacquisition at 29 mm starts with fresh filter history and never pinches", async () => {
  for (const loss of ["source", "wrist", "tip"]) {
    const { xr, session } = xrStub();
    const h = createHarness({ xr }); h.boot(); await h.app.enterXR();
    const app = h.app;
    const sample = mm => fakeHand({
      wrist: { x: 0, y: 1, z: 0 }, "thumb-tip": { x: 0, y: 1, z: 0 },
      "index-finger-tip": { x: mm / 1000, y: 1, z: 0 }
    });
    const closed = sample(12);
    session.inputSources = [{ handedness: "right", hand: closed.hand }];
    for (const t of [1000, 1016, 1032]) app.processXRHandFrame(t, closed.frame);
    assert.equal(app.pinchFSM.state, "DRAGGING");
    app.filterBank.apply("xr-left", "dist", 55, 1000);
    const missing = fakeHand(loss === "wrist" ? { "thumb-tip": { x: 0, y: 1, z: 0 } }
      : { wrist: { x: 0, y: 1, z: 0 }, "thumb-tip": { x: 0, y: 1, z: 0 } });
    session.inputSources = loss === "source" ? [] : [{ handedness: "right", hand: missing.hand }];
    app.processXRHandFrame(1048, missing.frame);
    assert.equal(app.pinchFSM.state, "IDLE");
    assert.equal(app.filterBank.filters.has("xr-right:dist"), false);
    assert.equal(app.filterBank.filters.get("xr-left:dist").xPrev, 55);
    const recovered = sample(29), transitions = [];
    app.pinchFSM.onTransition((from, to) => transitions.push(to));
    session.inputSources = [{ handedness: "right", hand: recovered.hand }];
    for (const t of [1064, 1080, 1096]) app.processXRHandFrame(t, recovered.frame);
    assert.equal(app.xr.lastFilteredPinchMm.right, 29);
    assert.equal(app.pinchFSM.state, "IDLE", loss);
    assert.deepEqual(transitions, []);
  }
});

test("XR telemetry records the rendered wrist without a second origin offset", async () => {
  const { xr, session } = xrStub();
  const h = createHarness({ xr }); h.boot(); await h.app.enterXR();
  const fake = fakeHand({ wrist: { x: 0.2, y: 1.2, z: -0.4 },
    "thumb-tip": { x: 0.2, y: 1.2, z: -0.3 }, "index-finger-tip": { x: 0.212, y: 1.2, z: -0.3 } });
  session.inputSources = [{ handedness: "right", hand: fake.hand }];
  h.app.processXRHandFrame(1000, fake.frame);
  h.app.frame(1016);
  const frame = h.app.telemetryFrames.at(-1), wrist = h.app.renderer.hands[0].joints.wrist;
  assert.deepEqual(JSON.parse(JSON.stringify(frame.wrist)), JSON.parse(JSON.stringify(wrist)));
  assert.ok(Math.abs(frame.wrist.x + 0.2) < 1e-12);
  assert.ok(Math.abs(frame.wrist.y - 0.3) < 1e-12);
  assert.ok(Math.abs(frame.wrist.z - 0.4) < 1e-12);
});

test("repeated and invalid XR timestamps do not confirm a pinch", async () => {
  const { xr, session } = xrStub();
  const h = createHarness({ xr }); h.boot(); await h.app.enterXR();
  const fake = fakeHand({ wrist: { x: 0, y: 1, z: 0 }, "thumb-tip": { x: 0, y: 1, z: 0 }, "index-finger-tip": { x: 0.012, y: 1, z: 0 } });
  session.inputSources = [{ hand: fake.hand, handedness: "right" }];
  h.app.processXRHandFrame(100, fake.frame);
  assert.equal(h.app.pinchFSM.state, "HOVER");
  for (const t of [100, 90, NaN]) h.app.processXRHandFrame(t, fake.frame);
  assert.equal(h.app.pinchFSM.state, "HOVER");
  h.app.processXRHandFrame(116, fake.frame);
  assert.equal(h.app.pinchFSM.state, "PINCH_START");
});

test("concurrent session requests are gated and pending sessions end after pagehide", async () => {
  let finish;
  const { xr, session, calls } = xrStub({ request: () => new Promise(resolve => { finish = resolve; }) });
  const h = createHarness({ xr }); h.boot();
  const one = h.app.enterXR(), two = h.app.enterXR();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.requestSession.length, 1);
  h.dispatchWin("pagehide");
  finish(session);
  await Promise.all([one, two]);
  assert.equal(calls.end, 1);
  assert.equal(h.app.state.xrActive, false);
  assert.equal(h.app.xr.session, null);
});

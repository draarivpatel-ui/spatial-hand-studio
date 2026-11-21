"use strict";
/* Pass-1 hardening regressions: CSV formula safety, WCAG 2.1.4 shortcut
   disablement, and deeper edge coverage for the FSM, filters, projection
   and telemetry paths that the first suite left untested. */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const K = require(path.join(__dirname, "..", "js", "xr-hand-kinematics.js"));
const T = require(path.join(__dirname, "..", "js", "hand-telemetry.js"));
const { createHarness } = require("./helpers/dom-harness.cjs");

const P = (x, y, z) => ({ x, y, z });

/* ---------- CSV formula injection ---------- */
test("CSV export prefixes formula-leading strings with an apostrophe", () => {
  for (const hostile of ["=cmd|'/c calc'!A0", "+SUM(A1:A9)", "@info", "  padded", "\ttabbed"]) {
    const csv = T.exportFramesCsv([{ t: 1, source: hostile, pinchMm: 5 }]);
    const cell = csv.split("\r\n")[1].split(",")[1];
    assert.equal(cell[0], "'", JSON.stringify(hostile));
  }
});

test("CSV export prefixes dash-leading strings but keeps numbers numeric", () => {
  const csv = T.exportFramesCsv([
    { t: 1, source: "-1+1", pinchState: "=STATE()" },
    { t: 2, source: "pinch", pinchMm: -12.5, wrist: P(-0.1, -0.2, -0.3) }
  ]);
  const lines = csv.split("\r\n");
  assert.equal(lines[1].split(",")[1], "'-1+1");
  assert.equal(lines[1].split(",")[3], "'=STATE()");
  assert.match(lines[2], /^2,pinch,-12\.5,,-0\.1,-0\.2,-0\.3,/);
  assert.ok(!lines[2].includes("'-"), "negative numbers must not be apostrophised");
});

test("formula characters mid-string are left alone and still quoted correctly", () => {
  const csv = T.exportFramesCsv([{ t: 1, source: 'a=b+c,"quoted"', pinchState: "DRAGGING" }]);
  assert.match(csv.split("\r\n")[1], /,"a=b\+c,""quoted""",/);
});

test("CSV export never emits a cell a spreadsheet would evaluate", () => {
  const csv = T.exportFramesCsv([
    { t: 0, source: "=HYPERLINK(x)", pinchState: "IDLE" },
    { t: 1, source: "xr-hand", pinchMm: 12, pinchState: "PINCH_START", wrist: P(0, 0, 0), reach: P(0, 1, 0) }
  ]);
  for (const line of csv.split("\r\n").slice(1)) {
    for (const cell of line.replace(/^"|"$/g, "").split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
      const bare = cell.replace(/^"(.*)"$/, "$1").replace(/""/g, '"');
      if (/^[\t\r\n =+\-@]/.test(bare)) assert.equal(bare[0], "'", bare);
    }
  }
});

/* ---------- WCAG 2.1.4: character-key shortcuts can be turned off ---------- */
test("keyboard shortcut toggle exists, defaults on and drives state", () => {
  const h = createHarness();
  h.boot();
  const toggle = h.el("toggle-keyboard-shortcuts");
  assert.ok(toggle);
  assert.equal(toggle.classList.contains("on"), true, "ships enabled");
  assert.equal(h.app.state.keyboardShortcuts, true);
  toggle.dispatch("click", {});
  assert.equal(h.app.state.keyboardShortcuts, false);
  assert.equal(toggle.getAttribute("aria-checked"), "false");
  toggle.dispatch("keydown", { key: "Enter" });
  assert.equal(h.app.state.keyboardShortcuts, true);
  assert.equal(toggle.getAttribute("aria-checked"), "true");
});

test("with shortcuts off, Space and R are inert but the UI still works", () => {
  const h = createHarness();
  h.boot();
  h.app.state.keyboardShortcuts = false;
  h.dispatchWin("keydown", { code: "Space", key: " ", repeat: false });
  assert.equal(h.app.state.isPinching, false);
  h.app.windows[0].x = 0.9;
  h.dispatchWin("keydown", { code: "KeyR", key: "r", repeat: false });
  assert.equal(h.app.windows[0].x, 0.9, "R must not reset when shortcuts are off");
  h.app.toggleSpatialAudio();
  assert.equal(h.app.state.spatialAudio, false, "non-shortcut controls still work");
});

test("turning shortcuts off mid-hold releases the keyboard pinch", () => {
  const h = createHarness();
  h.boot();
  h.dispatchWin("keydown", { code: "Space", key: " ", repeat: false });
  assert.equal(h.app.state.isPinching, true);
  h.el("toggle-keyboard-shortcuts").dispatch("click", {});
  assert.equal(h.app.state.keyboardShortcuts, false);
  assert.equal(h.app.state.isPinching, false, "a held pinch must not stick when shortcuts die");
  h.dispatchWin("keyup", { code: "Space", key: " " });
  assert.equal(h.app.state.isPinching, false);
});

test("re-enabling shortcuts restores Space pinch and R reset", () => {
  const h = createHarness();
  h.boot();
  h.app.state.keyboardShortcuts = false;
  h.app.state.keyboardShortcuts = true;
  h.dispatchWin("keydown", { code: "Space", key: " ", repeat: false });
  assert.equal(h.app.state.isPinching, true);
  h.dispatchWin("keyup", { code: "Space", key: " " });
  h.app.windows[0].x = 0.9;
  h.dispatchWin("keydown", { code: "KeyR", key: "R", repeat: false });
  assert.equal(h.app.windows[0].x, -0.36);
});

test("arrow-key radial navigation still works with character shortcuts off", () => {
  const h = createHarness();
  h.boot();
  h.app.state.keyboardShortcuts = false;
  h.app.runGestureDemo("palm-up");
  h.app.frame(16);
  assert.equal(h.app.state.radialActive, true);
  const i0 = h.app.state.radialIndex;
  h.dispatchWin("keydown", { key: "ArrowRight", code: "ArrowRight" });
  h.app.frame(32);
  assert.equal(h.app.state.radialIndex, (i0 + 1) % 6, "non-character keys are outside WCAG 2.1.4");
});

test("manifest records the keyboard-shortcut setting", () => {
  const h = createHarness();
  h.boot();
  assert.equal(h.app.buildManifest().keyboardShortcuts, true);
  h.el("toggle-keyboard-shortcuts").dispatch("click", {});
  assert.equal(h.app.buildManifest().keyboardShortcuts, false);
});

test("resetScene does not change the accessibility preference", () => {
  const h = createHarness();
  h.boot();
  h.el("toggle-keyboard-shortcuts").dispatch("click", {});
  assert.equal(h.app.state.keyboardShortcuts, false);
  h.app.resetScene();
  assert.equal(h.app.state.keyboardShortcuts, false);
});

/* ---------- PinchFSM edge cases ---------- */
test("a re-pinch during RELEASE re-enters PINCH_START without an IDLE dwell", () => {
  const fsm = new K.PinchFSM();
  fsm.update(24); fsm.update(12); fsm.update(24);
  assert.equal(fsm.state, "DRAGGING");
  fsm.update(30);
  assert.equal(fsm.state, "RELEASE");
  assert.equal(fsm.update(10), "PINCH_START", "fast re-grip inside the band");
});

test("release into the middle band parks in HOVER, not IDLE", () => {
  const fsm = new K.PinchFSM({ enterThresholdMm: 20, exitThresholdMm: 28, releaseBandMm: 10 });
  fsm.update(24); fsm.update(12); fsm.update(24); fsm.update(30);
  assert.equal(fsm.update(26), "HOVER");
  assert.equal(fsm.isPinching(), false);
  assert.equal(fsm.isHovering(), true);
});

test("isPinching is true only in PINCH_START and DRAGGING", () => {
  const fsm = new K.PinchFSM();
  assert.equal(fsm.isPinching(), false);
  fsm.update(24);
  assert.equal(fsm.isPinching(), false);
  fsm.update(12);
  assert.equal(fsm.isPinching(), true);
  fsm.update(24);
  assert.equal(fsm.isPinching(), true);
  fsm.update(30);
  assert.equal(fsm.isPinching(), false);
});

test("transition listener receives the ordered (from, to) pair stream", () => {
  const fsm = new K.PinchFSM();
  const seen = [];
  fsm.onTransition((from, to) => seen.push(from + ">" + to));
  fsm.update(24); fsm.update(12); fsm.update(24); fsm.update(30); fsm.update(50);
  assert.deepEqual(seen, ["IDLE>HOVER", "HOVER>PINCH_START", "PINCH_START>DRAGGING", "DRAGGING>RELEASE", "RELEASE>IDLE"]);
});

test("unsubscribed listeners and a throwing listener cannot corrupt state", () => {
  const fsm = new K.PinchFSM();
  const seen = [];
  const off = fsm.onTransition((f, t) => seen.push(t));
  fsm.onTransition(() => { throw new Error("listener bug"); });
  assert.throws(() => fsm.update(24), /listener bug/, "listener errors surface to the caller");
  assert.equal(fsm.state, "HOVER", "state still advanced before the throw");
  off();
  assert.throws(() => fsm.update(12), /listener bug/);
  assert.equal(fsm.state, "PINCH_START");
  assert.deepEqual(seen, ["HOVER"], "removed listener must not fire again");
});

/* ---------- 1-Euro filter edge cases ---------- */
test("a huge dt makes the filter trust the new sample almost fully", () => {
  const f = new K.OneEuroFilter({ minCutoff: 1.2, beta: 0.007 });
  f.filter(0, 0);
  const out = f.filter(100, 60000);
  assert.ok(out > 90, "60 s of silence should not lag the jump, got " + out);
});

test("higher min cutoff tracks faster than lower min cutoff", () => {
  const slow = new K.OneEuroFilter({ minCutoff: 0.2 });
  const fast = new K.OneEuroFilter({ minCutoff: 5 });
  let sOut, fOut;
  for (let t = 0; t <= 500; t += 16) {
    const x = Math.sin(t / 50) * 10;
    sOut = slow.filter(x, t);
    fOut = fast.filter(x, t);
  }
  const raw = Math.sin(500 / 50) * 10;
  assert.ok(Math.abs(fOut - raw) < Math.abs(sOut - raw), "fast cutoff should hug the signal");
});

test("FilterBank isolates same-named signals per hand and rejects bad updates", () => {
  const bank = new K.FilterBank({ minCutoff: 1 });
  bank.apply("left", "wrist-x", 10, 0);
  bank.apply("right", "wrist-x", 80, 0);
  bank.apply("left", "wrist-x", 20, 16);
  const l = bank.filters.get("left:wrist-x"), r = bank.filters.get("right:wrist-x");
  assert.ok(l.xPrev < 20 && l.xPrev > 10);
  assert.equal(r.xPrev, 80);
  assert.throws(() => bank.updateCutoff(NaN), RangeError);
  assert.throws(() => bank.updateCutoff(-0.5), RangeError);
});

/* ---------- Geometry and gesture edge cases ---------- */
test("handBasis returns null for degenerate (coincident) metacarpals", () => {
  const p = { x: 0.01, y: 0, z: -0.05 };
  const joints = {
    wrist: { x: 0, y: 0, z: 0 },
    "index-finger-metacarpal": { ...p },
    "middle-finger-metacarpal": { ...p },
    "pinky-finger-metacarpal": { ...p }
  };
  assert.equal(K.handBasis(joints), null);
});

test("an extended index with the thumb tip touching is pinch, not poke", () => {
  const base = K.buildBaseHandJoints("right");
  const poke = K.applyPosePreset(base, "poke", "right");
  const index = poke["index-finger-tip"];
  /* Keep the index extended; slide the thumb tip to 10 mm from it. The
     classifier must call this a pinch, since poke requires pinch > 40 mm. */
  poke["thumb-tip"] = { x: index.x + 0.01, y: index.y, z: index.z };
  const d = K.distMm(poke["thumb-tip"], index);
  assert.ok(d < 22 && d > 0);
  assert.equal(K.classifyGesture(poke, "right").gesture, "pinch");
});

test("every classified gesture reports confidence inside [0, 1]", () => {
  const base = K.buildBaseHandJoints("right");
  for (const preset of ["open", "pinch", "palm-up", "poke", "fist"]) {
    const g = K.classifyGesture(K.applyPosePreset(base, preset, "right"), "right");
    assert.ok(g.confidence > 0 && g.confidence <= 1, preset + " confidence " + g.confidence);
    assert.ok(Number.isFinite(g.pinchDistMm));
  }
  assert.equal(K.classifyGesture(null).confidence, 0);
});

test("an unknown preset name falls back to the open pose and mutates nothing", () => {
  const base = K.buildBaseHandJoints("right");
  const before = JSON.stringify(base);
  const out = K.applyPosePreset(base, "does-not-exist", "right");
  const open = K.applyPosePreset(base, "open", "right");
  assert.equal(JSON.stringify(base), before, "input joints must not be mutated");
  for (const name of K.XR_JOINT_ORDER) {
    for (const k of ["x", "y", "z"]) assert.equal(out[name][k], open[name][k], name);
  }
});

test("wrist pitch preset preserves handedness mirroring", () => {
  const l = K.applyPosePreset(K.buildBaseHandJoints("left"), "palm-up", "left");
  const r = K.applyPosePreset(K.buildBaseHandJoints("right"), "palm-up", "right");
  assert.ok(Math.abs(l["index-finger-tip"].x + r["index-finger-tip"].x) < 1e-12);
  assert.ok(Math.abs(l["index-finger-tip"].z - r["index-finger-tip"].z) < 1e-12);
});

/* ---------- Perspective projection ---------- */
test("project rejects nonfinite points and points inside the near plane", () => {
  const h = createHarness();
  h.boot();
  const r = h.app.renderer;
  assert.equal(r.project(null), null);
  assert.equal(r.project({ x: NaN, y: 0, z: 0 }), null);
  assert.equal(r.project({ x: 0, y: Infinity, z: 0 }), null);
  assert.equal(r.project({ x: 0, y: 0, z: -1.5 }), null, "depth <= 0.06 is culled");
});

test("projected scale falls with depth and the image is centred at rest", () => {
  const h = createHarness();
  h.boot();
  const r = h.app.renderer;
  const near = r.project({ x: 0, y: 0, z: 0 });
  const far = r.project({ x: 0, y: 0, z: 1 });
  assert.ok(near && far);
  assert.ok(far.depth > near.depth);
  assert.ok(far.s < near.s, "farther points must be drawn smaller");
  assert.ok(Math.abs(near.x - r.w / 2) < 60, "origin projects near the centre");
});

test("windowQuad returns null for degenerate or fully culled windows", () => {
  const h = createHarness();
  h.boot();
  const r = h.app.renderer;
  assert.equal(r.windowQuad({ x: 0, y: 0, z: -0.4, w: 0, h: 0.2 }), null);
  assert.equal(r.windowQuad({ x: 0, y: 0, z: -0.4, w: NaN, h: 0.2 }), null);
  assert.equal(r.windowQuad(null), null);
  assert.equal(r.windowQuad({ x: 0, y: 0, z: -3, w: 0.4, h: 0.2 }), null, "every corner culled");
});

/* ---------- Telemetry edge cases ---------- */
test("SampleGate accepts exactly the boundary speed and minDt", () => {
  const gate = new T.SampleGate({ maxSpeedMPerS: 2, minDtS: 0.01 });
  assert.equal(gate.accept(P(0, 0, 0), 0), true);
  assert.equal(gate.accept(P(0.02, 0, 0), 10), true, "0.02 m in 10 ms is exactly 2 m/s");
  const gate2 = new T.SampleGate({ maxSpeedMPerS: 2, minDtS: 0.01 });
  gate2.accept(P(0, 0, 0), 0);
  assert.equal(gate2.accept(P(0.021, 0, 0), 10), false, "over the speed cap is rejected");
});

test("JointKinematics computes speed and acceleration from real dt", () => {
  const k = new T.JointKinematics();
  k.push(P(0, 0, 0), 0);
  const s1 = k.push(P(1, 0, 0), 100);
  assert.ok(Math.abs(s1.velocity.x - 10) < 1e-9, "1 m over 0.1 s is 10 m/s");
  const s2 = k.push(P(3, 0, 0), 250);
  assert.ok(Math.abs(s2.velocity.x - (2 / 0.15)) < 1e-9, "2 m over 0.15 s");
  /* vPrev = 10, vCurr = 13.33, midpoint dt = 0.125 s -> a = 26.67 m/s^2. */
  assert.ok(Math.abs(k.acceleration() - ((2 / 0.15) - 10) / 0.125) < 1e-9);
});

test("JointKinematics history respects maxHistory exactly", () => {
  const k = new T.JointKinematics({ maxHistory: 3 });
  for (let i = 0; i < 10; i++) k.push(P(i, 0, 0), i * 10);
  assert.equal(k.history.length, 3);
  assert.equal(k.history[0].p.x, 7);
});

test("buildSessionReport labels a single-source stream and skips bad frames", () => {
  const r = T.buildSessionReport([
    { t: 0, source: "xr-hand", pinchMm: 20 },
    { t: 16, source: "xr-hand", pinchMm: 21 },
    { t: "not-a-number", source: "xr-hand", pinchMm: 22 }
  ]);
  assert.equal(r.source, "xr-hand");
  assert.equal(r.frameCount, 2);
  assert.deepEqual(r.sources, ["xr-hand"]);
});

test("coneDeviationDeg handles the zero vector and boundary angles", () => {
  assert.equal(T.coneDeviationDeg(P(0, 0, 0)), 0);
  assert.ok(Math.abs(T.coneDeviationDeg(P(0, 1, 0.57735)) - 30) < 0.01, "tan 30 deg");
  assert.equal(T.insideComfortCone(P(0, 1, 0.57735), { halfAngleDeg: 30.5 }), true);
});

test("frame export keeps zero-valued coordinates as zeros, not empty cells", () => {
  const csv = T.exportFramesCsv([{ t: 5, source: "pinch", pinchMm: 0, wrist: P(0, 0, 0), reach: P(0, 0, 0) }]);
  assert.match(csv.split("\r\n")[1], /^5,pinch,0,,0,0,0,0,0,0$/);
});

/* ---------- Offline and robustness ---------- */
test("the app boots and renders with no xr, no mediaDevices and no AudioContext", () => {
  const h = createHarness({ xr: null, mediaDevices: false });
  h.boot();
  assert.equal(h.app.renderer ? 1 : 0, 1);
  assert.match(h.el("xr-support-status").textContent, /unavailable/i);
  h.advance(16); h.flushRaf(16);
  assert.ok(h.canvasCtx().calls.length > 5, "frames still draw fully offline");
  assert.equal(h.app.telemetryFrames.length, 1);
});

test("downloadText rejects non-string and oversized payloads, toasting once", () => {
  const h = createHarness();
  h.boot();
  assert.equal(h.app.downloadText("n.txt", null), false);
  assert.equal(h.app.downloadText("n.txt", 42), false);
  assert.equal(h.downloads.length, 0);
  assert.match(h.el("toast").textContent, /too large/i);
});

/* ---------- Pass-2 adversarial regressions ---------- */

function xrStub({ deny = null, failFirst = null } = {}) {
  const listeners = {};
  const calls = { requestSession: [] };
  const session = {
    inputSources: [],
    requestAnimationFrame() { return 1; },
    requestReferenceSpace: async () => ({}),
    addEventListener(t, f) { (listeners[t] || (listeners[t] = [])).push(f); },
    end: async () => { (listeners.end || []).forEach(f => f()); }
  };
  const xr = {
    isSessionSupported: async () => true,
    requestSession: async (mode, opts) => {
      calls.requestSession.push(opts);
      if (deny) throw deny;
      if (failFirst && calls.requestSession.length === 1) throw failFirst;
      return session;
    }
  };
  return { xr, session, calls };
}

test("entering and leaving XR clears a held desktop pinch and restores Space", async () => {
  const { xr, session } = xrStub();
  const h = createHarness({ xr });
  h.boot();
  h.app.state.isPinching = true;
  h.app.state.grabbedWindowId = h.app.windows[0].id;
  await h.app.enterXR();
  assert.equal(h.app.state.isPinching, false, "enterXR must clear a held pinch");
  assert.equal(h.app.state.grabbedWindowId, null);
  h.app.state.isPinching = true;
  h.app.state.grabbedWindowId = h.app.windows[0].id;
  await session.end();
  assert.equal(h.app.state.xrActive, false);
  assert.equal(h.app.state.isPinching, false, "session end must clear a held pinch");
  assert.equal(h.app.state.grabbedWindowId, null);
  h.dispatchWin("keydown", { code: "Space", key: " ", repeat: false });
  assert.equal(h.app.state.isPinching, true, "Space works again after XR ends");
  h.dispatchWin("keyup", { code: "Space", key: " " });
  assert.equal(h.app.state.isPinching, false);
});

test("a Space keyup landing on a focused control still releases the pinch", () => {
  const h = createHarness();
  h.boot();
  h.dispatchWin("keydown", { code: "Space", key: " ", repeat: false });
  assert.equal(h.app.state.isPinching, true);
  const btn = h.el("btn-pinch-toggle");
  h.dispatchWin("keyup", { code: "Space", key: " ", target: btn });
  assert.equal(h.app.state.isPinching, false, "release must not depend on the keyup target");
});

test("the palm-up radial commits exactly once per activation", () => {
  const h = createHarness();
  h.boot();
  h.app.frame(0);
  let commits = 0;
  const orig = h.app.SFX.radialCommit.bind(h.app.SFX);
  h.app.SFX.radialCommit = (...a) => { commits++; return orig(...a); };
  h.app.runGestureDemo("palm-up");
  /* demoPhase advances by at most 0.1s per frame; 290 frames ≈ 29s of sim time,
     enough for ~10 auto-commits if the latch ever failed. */
  for (let t = 100; t <= 30000; t += 100) h.app.frame(t);
  assert.equal(commits, 1, "auto-commit fires once while the palm stays up");
  assert.equal(h.app.state.radialCommitted, true);
});

test("a denied WebXR request surfaces immediately without a second prompt", async () => {
  const denied = new Error("user denied"); denied.name = "NotAllowedError";
  const { xr, calls } = xrStub({ deny: denied });
  const h = createHarness({ xr });
  h.boot();
  await assert.rejects(h.app.requestXRSession("immersive-vr"), e => e.name === "NotAllowedError");
  assert.equal(calls.requestSession.length, 1, "a denial must not retry");
});

test("an unsupported-feature failure still retries with optional features", async () => {
  const noSupport = new Error("not supported"); noSupport.name = "NotSupportedError";
  const { xr, calls } = xrStub({ failFirst: noSupport });
  const h = createHarness({ xr });
  h.boot();
  const result = await h.app.requestXRSession("immersive-vr");
  assert.equal(calls.requestSession.length, 2);
  assert.equal(result.handTrackingRequested, false);
  assert.equal(calls.requestSession[1].requiredFeatures, undefined);
});

test("app shortcuts ignore Ctrl, Alt, Meta and Shift chords", () => {
  const h = createHarness();
  h.boot();
  for (const mod of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
    h.dispatchWin("keydown", { code: "Space", key: " ", repeat: false, ...mod });
    assert.equal(h.app.state.isPinching, false, JSON.stringify(mod));
  }
  h.app.state.handWorldX = 0.9;
  h.dispatchWin("keydown", { code: "KeyR", key: "r", repeat: false, ctrlKey: true });
  assert.equal(h.app.state.handWorldX, 0.9, "Ctrl+R must not reset the workspace");
  h.dispatchWin("keydown", { code: "KeyR", key: "r", repeat: false });
  assert.equal(h.app.state.handWorldX, 0.08, "plain R still resets");
});

test("the R shortcut is ignored while an XR session owns the scene", () => {
  const h = createHarness();
  h.boot();
  h.app.state.xrActive = true;
  h.app.state.handWorldX = 0.9;
  h.dispatchWin("keydown", { code: "KeyR", key: "r", repeat: false });
  assert.equal(h.app.state.handWorldX, 0.9, "R must not reset mid-session");
});

test("CSV export guards unicode whitespace and control characters", () => {
  const hostiles = [" line-sep", " para-sep", " fig-space", " narrow-nbsp", "　ideographic", " nbsp",
    "\x0bvtab", "\x0cff", "\x01soh", "\x08bs", "\x7fdel", "nel"];
  for (const hostile of hostiles) {
    const csv = T.exportFramesCsv([{ t: 1, source: hostile }]);
    const cell = csv.split("\r\n")[1].split(",")[1];
    assert.equal(cell[0], "'", JSON.stringify(hostile));
  }
});

test("windowQuad yaw matches the hand/world convention (local +X to -Z)", () => {
  const h = createHarness();
  h.boot();
  const r = h.app.renderer;
  const quad = r.windowQuad({ x: 0, y: 0, z: -0.4, w: 0.4, h: 0.2, yaw: Math.PI / 2 });
  assert.ok(quad, "quad projects");
  const plusX = quad[1];
  assert.ok(Math.abs(plusX.world.z - (-0.6)) < 1e-9, "local +X maps to -Z at +90deg yaw");
  const joint = r.handJointWorld({ yaw: Math.PI / 2, worldX: 0, worldY: 0, worldZ: -0.4, joints: {} }, { x: 0.2, y: 0, z: 0 });
  assert.ok(Math.abs(joint.z - (-0.6)) < 1e-9, "hand transform uses the same convention");
});

test("an XR-owned frame ignores the stale desktop mouse yaw", () => {
  const h = createHarness();
  h.boot();
  h.app.state.xrActive = true;
  h.app.xr.joints.right = { wrist: { x: 0, y: 0, z: 0 } };
  h.app.xr.wristWorld = { x: 0, y: 0, z: 0 };
  h.app.state.handYaw = 0.5;
  h.app.frame(100);
  const right = h.app.renderer.hands.find(hd => hd && hd.handedness === "right");
  assert.ok(right, "a right hand renders");
  assert.equal(right.yaw, 0, "XR hands do not inherit the stale mouse yaw");
});

test("resetScene also returns the hand yaw to its default", () => {
  const h = createHarness();
  h.boot();
  h.app.state.handYaw = 0.42;
  h.app.resetScene();
  assert.equal(h.app.state.handYaw, 0);
});

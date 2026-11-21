"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createHarness, SCRIPTS, ROOT } = require("./helpers/dom-harness.cjs");
const { FORBIDDEN, PII } = require("./helpers/project-hygiene.cjs");
const { createBrowserHarness } = require("./helpers/browser-harness.cjs");

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const css = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

/* ---------- Static markup hygiene ---------- */
test("index.html loads the four local scripts in dependency order", () => {
  const srcs = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
  assert.deepEqual(srcs, [
    "js/hand-telemetry.js", "js/xr-hand-kinematics.js",
    "js/spatial-renderer.js", "js/app.js"
  ]);
  for (const src of srcs) assert.ok(fs.existsSync(path.join(ROOT, src)), src);
  assert.ok(!/<script[^>]+https?:/i.test(html));
  assert.ok(!/<link[^>]+href="https?:/i.test(html), "no external font or CDN dependency");
});

test("index.html contains no em dashes, en dashes, forbidden terms or PII", () => {
  assert.ok(!/[\u2013\u2014]/.test(html));
  assert.ok(!/&#8(?:211|212);|&\u006ddash;|&\u006edash;/i.test(html));
  assert.equal(FORBIDDEN.test(html), false);
  assert.equal(PII.test(html), false);
});

test("UI copy contains no small-caps eyebrow styling", () => {
  assert.ok(!/text-transform\s*:\s*uppercase/i.test(html));
  assert.ok(!/text-transform\s*:\s*uppercase/i.test(css));
  assert.ok(!/letter-spacing\s*:\s*0\.[5-9]px/i.test(css));
});

test("every JS file parses with node --check semantics", () => {
  for (const rel of SCRIPTS) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.doesNotThrow(() => new vm.Script(src, { filename: rel }), rel);
  }
});

test("IDs referenced by app.js exist in index.html", () => {
  const appSrc = fs.readFileSync(path.join(ROOT, "js/app.js"), "utf8");
  const ids = [...appSrc.matchAll(/(?:\bel\(|setText\(|getElementById\()"([a-z][a-z0-9-]+)"/g)]
    .map(m => m[1]).filter(id => !id.startsWith("manifest-box"));
  const declared = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));
  const missing = [...new Set(ids)].filter(id => !declared.has(id) && id !== "manifest-box");
  assert.deepEqual(missing, [], "missing DOM ids: " + missing.join(", "));
});

test("telemetry module is exposed as a browser global and as CommonJS", () => {
  const h = createHarness();
  assert.ok(h.context.HandTelemetry);
  assert.equal(typeof h.context.HandTelemetry.buildSessionReport, "function");
  assert.equal(typeof h.context.HandTelemetry.exportFramesCsv, "function");
  assert.equal(typeof h.context.SpatialHandApp.boot, "function");
  assert.equal(h.typeOf("SpatialRenderer"), "function");
  assert.equal(h.typeOf("OneEuroFilter"), "function");
  assert.equal(h.typeOf("PinchFSM"), "function");
  assert.equal(h.typeOf("postureMoments"), "function");
  assert.equal(h.typeOf("XR_JOINT_ORDER"), "object");
  assert.equal(h.context.HandTelemetry.CSV_COLUMNS.length, 10);
});

/* ---------- Boot, renderer and frame loop ---------- */
test("boot wires the canvas, joint tree, model summary and a render frame", () => {
  const h = createHarness();
  h.boot();
  const app = h.app;
  assert.ok(app.renderer);
  assert.equal(app.renderer.w, 800);
  assert.equal(app.renderer.h, 500);
  assert.equal(app.renderer.canvas.width, 1600, "devicePixelRatio 2");
  assert.equal(app.renderer.viewMode, "passthrough");
  assert.equal(app.renderer.comfortCone.apex.y, -0.28);
  assert.equal(app.renderer.modelSummary.reductionPct, 68.4);
  assert.match(h.el("joint-tree").innerHTML, /thumb-tip/);
  assert.equal(h.el("kv-state").textContent, "IDLE");
  assert.equal(h.el("xr-support-status").textContent, "WebXR: unavailable (desktop simulator)");

  h.advance(16);
  h.flushRaf(16);
  assert.equal(h.pendingRaf(), 1, "the loop reschedules itself");
  assert.ok(h.canvasCtx().calls.some(c => c.name === "clearRect"));
  assert.ok(h.canvasCtx().calls.some(c => c.name === "fillText"));
  assert.equal(app.telemetryFrames.length, 1);
  const frame = app.telemetryFrames[0];
  assert.ok(Number.isFinite(frame.pinchMm));
  assert.equal(typeof frame.pinchState, "string");
  assert.ok(["x", "y", "z"].every(k => Number.isFinite(frame.reach[k])));
});

test("frame loop stays finite over 120 frames with variable dt and records a report", () => {
  const h = createHarness();
  h.boot();
  let t = 0;
  for (let i = 0; i < 120; i++) {
    t += i % 7 === 0 ? 33 : 16;
    h.setClock(t);
    h.flushRaf(t);
  }
  const app = h.app;
  const r = app.buildSessionReportNow();
  assert.equal(r.frameCount, 120);
  assert.ok(r.durationMs > 0);
  assert.ok(Number.isFinite(r.pinch.meanMm));
  assert.ok(Number.isFinite(r.pinch.highPassRmsMm));
  assert.ok(r.wrist.pathEfficiency >= 0 && r.wrist.pathEfficiency <= 1);
  assert.ok(Number.isFinite(r.comfortCone.maxDeviationDeg));
  for (const id of ["kv-pinch", "kv-residual", "kv-state", "stat-reduction", "tel-mean"]) {
    assert.ok(!/NaN|Infinity|undefined/.test(h.el(id).textContent), id);
  }
  assert.equal(h.el("stat-joints").textContent, "25");
  assert.equal(h.el("stat-reduction").textContent, "68.4%");
});

test("telemetry ring buffer caps recorded frames and reset clears them", () => {
  const h = createHarness();
  h.boot();
  const app = h.app;
  for (let i = 0; i < 1900; i++) app.recordFrame({ t: i, pinchMm: 20, pinchState: "IDLE", wrist: { x: 0, y: 0, z: 0 }, reach: { x: 0, y: 1, z: 0 } });
  assert.equal(app.telemetryFrames.length, 1800);
  assert.equal(app.telemetryFrames[0].t, 100);
  app.resetTelemetry();
  assert.equal(app.telemetryFrames.length, 0);
  assert.equal(h.el("tel-frames").textContent, "0");
  assert.equal(app.buildSessionReportNow().frameCount, 0);
});

/* ---------- Sliders, toggles, chips and keyboard ---------- */
test("pinch slider updates the FSM, readout and manifest thresholds", () => {
  const h = createHarness();
  h.boot();
  const slider = h.el("pinch-threshold");
  slider.value = "26";
  slider.dispatch("input", { target: slider });
  assert.equal(h.app.state.pinchHysteresisMm, 26);
  assert.equal(h.app.pinchFSM.enterMm, 26);
  assert.equal(h.app.pinchFSM.exitMm, 34);
  assert.equal(h.el("pinch-threshold-val").textContent, "26 mm enter / 34 mm exit");
  assert.equal(h.app.buildManifest().hand.pinch.enterMm, 26);
  assert.equal(h.app.buildManifest().hand.pinch.exitMm, 34);
});

test("cutoff and radius sliders update both state and renderer", () => {
  const h = createHarness();
  h.boot();
  const cutoff = h.el("euro-cutoff");
  cutoff.value = "3.2";
  cutoff.dispatch("input", { target: cutoff });
  assert.equal(h.app.state.euroCutoff, 3.2);
  assert.equal(h.el("euro-cutoff-val").textContent, "3.2 Hz");
  assert.equal(h.el("kv-cutoff").textContent, "waiting", "HUD cutoff is set on the next frame");
  assert.equal(h.app.filterBank.opts.minCutoff, 3.2);
  assert.equal(h.app.buildManifest().hand.pinch.filterMinCutoffHz, 3.2);

  const radius = h.el("desk-radius");
  radius.value = "1.05";
  radius.dispatch("input", { target: radius });
  assert.equal(h.app.state.curvedRadius, 1.05);
  assert.equal(h.app.renderer.curvedRadius, 1.05);
  assert.equal(h.el("desk-radius-val").textContent, "1.05 m");
  assert.equal(h.app.buildManifest().curvedGuide.radiusM, 1.05);
});

test("switches are keyboard accessible and drive renderer and audio state", () => {
  const h = createHarness();
  h.boot();
  const cone = h.el("toggle-comfort-cone");
  cone.dispatch("keydown", { key: "Enter" });
  assert.equal(h.app.renderer.comfortCone.enabled, false);
  assert.equal(cone.getAttribute("aria-checked"), "false");
  cone.dispatch("keydown", { key: " " , code: "Space" });
  assert.equal(h.app.renderer.comfortCone.enabled, true);
  const audio = h.el("toggle-spatial-audio");
  audio.dispatch("click", {});
  assert.equal(h.app.state.spatialAudio, false);
  assert.equal(audio.getAttribute("aria-checked"), "false");
  assert.doesNotThrow(() => h.app.playTone({ freq: 440 }), "audio is optional");
});

test("app toggles update button label, pressed state and enabled windows", () => {
  const h = createHarness();
  h.boot();
  const btn = h.selectorLists["[data-app-toggle]"][1];
  btn.dispatch("click", {});
  assert.equal(h.app.windows[1].enabled, false);
  assert.equal(btn.textContent, "Off");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.equal(h.app.buildManifest().windows[1].enabled, false);
  btn.dispatch("click", {});
  assert.equal(h.app.windows[1].enabled, true);
  assert.equal(btn.textContent, "On");
});

test("view mode chips update aria-selected, renderer mode and toast", () => {
  const h = createHarness();
  h.boot();
  const hud = h.selectorLists["[data-view-mode]"][1];
  hud.dispatch("click", {});
  assert.equal(h.app.state.viewMode, "hud");
  assert.equal(h.app.renderer.viewMode, "hud");
  assert.equal(hud.getAttribute("aria-selected"), "true");
  assert.equal(h.selectorLists["[data-view-mode]"][0].getAttribute("aria-selected"), "false");
  assert.match(h.el("toast").textContent, /HUD overlay/);
  h.setClock(1200);
  h.flushRaf(1200);
  assert.ok(h.canvasCtx().calls.some(c => c.name === "fillText" && /HUD drawing style/.test(String(c.args[0]))));
});

test("comfort cone view renders the overlay even when the toggle is off", () => {
  const h = createHarness();
  h.boot();
  h.el("toggle-comfort-cone").dispatch("click", {});
  assert.equal(h.app.renderer.comfortCone.enabled, false);
  h.selectorLists["[data-view-mode]"][2].dispatch("click", {});
  h.setClock(1000);
  h.flushRaf(1000);
  assert.equal(h.app.renderer.comfortCone.enabled, false, "toggle restored after drawing");
  assert.ok(h.canvasCtx().calls.some(c => c.name === "fillText" && /comfort cone/.test(String(c.args[0]))));
});

test("gesture chips activate one preset, highlight joints and do not start the camera for others", () => {
  const h = createHarness();
  h.boot();
  const poke = h.selectorLists["[data-gesture]"][3];
  poke.dispatch("click", {});
  assert.equal(h.app.state.gesturePreset, "poke");
  assert.equal(poke.getAttribute("aria-pressed"), "true");
  assert.equal(h.selectorLists["[data-gesture]"][0].classList.contains("active"), false);
  assert.match(h.el("joint-tree").innerHTML, /index-finger-tip/);
  assert.equal(h.app.webcam.active, false);
  assert.match(h.el("toast").textContent, /Gesture preset/);
});

test("Space pinch toggle works on keydown and keyup, R resets the layout", () => {
  const h = createHarness();
  h.boot();
  h.dispatchWin("keydown", { code: "Space", key: " ", repeat: false });
  assert.equal(h.app.state.isPinching, true);
  assert.match(h.el("btn-pinch-toggle").textContent, /Holding pinch/);
  h.dispatchWin("keydown", { code: "Space", key: " ", repeat: true });
  assert.equal(h.app.state.isPinching, true, "key repeat is ignored");
  h.dispatchWin("keyup", { code: "Space", key: " " });
  assert.equal(h.app.state.isPinching, false);
  assert.match(h.el("btn-pinch-toggle").textContent, /Hold pinch/);
  h.app.windows[0].x = 0.9;
  h.dispatchWin("keydown", { code: "KeyR", key: "r", repeat: false });
  assert.equal(h.app.windows[0].x, -0.36);
});

test("Space is ignored while typing in a form field", () => {
  const h = createHarness();
  h.boot();
  const input = { tagName: "INPUT" };
  h.dispatchWin("keydown", { code: "Space", key: " ", repeat: false, target: input });
  assert.equal(h.app.state.isPinching, false);
});

test("real DOM bubbling keeps Space on switches and nested controls out of the global pinch handler", t => {
  const h = createBrowserHarness();
  t.after(() => h.dom.window.close());
  const { window: w, document: d, app } = h;
  const space = (target, type) => {
    const event = new w.KeyboardEvent(type, { key: " ", code: "Space", bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };
  const toggle = d.getElementById("toggle-comfort-cone");
  const wasOn = toggle.classList.contains("on");
  assert.equal(space(toggle, "keydown").defaultPrevented, true);
  assert.equal(toggle.classList.contains("on"), !wasOn);
  assert.equal(app.state.isPinching, false);
  space(toggle, "keyup");
  assert.equal(app.state.isPinching, false);

  for (const tag of ["button", "input", "select", "textarea", "a", "div"]) {
    const control = d.createElement(tag);
    if (tag === "a") control.setAttribute("href", "#controls");
    if (tag === "div") control.setAttribute("contenteditable", "true");
    d.body.appendChild(control);
    const target = tag === "input" || tag === "textarea" || tag === "select" ? control : d.createElement("span");
    if (target !== control) control.appendChild(target);
    space(target, "keydown");
    assert.equal(app.state.isPinching, false, tag);
    app.state.isPinching = true;
    space(target, "keyup");
    assert.equal(app.state.isPinching, true, tag + " keyup cannot release an unrelated pinch");
    app.state.isPinching = false;
  }
  const handled = d.createElement("div");
  handled.addEventListener("keydown", event => event.preventDefault());
  d.body.appendChild(handled);
  assert.equal(space(handled, "keydown").defaultPrevented, true);
  assert.equal(app.state.isPinching, false);
  space(handled, "keyup");
  assert.equal(app.state.isPinching, false);

  assert.equal(space(d.body, "keydown").defaultPrevented, true);
  assert.equal(app.state.isPinching, true);
  space(d.body, "keyup");
  assert.equal(app.state.isPinching, false);
  assert.deepEqual(h.errors, []);
});

test("a body Space release only clears a pinch started by that keyboard press", () => {
  const h = createHarness(); h.boot();
  h.app.state.isPinching = true;
  h.dispatchWin("keydown", { code: "Space", key: " " });
  h.dispatchWin("keyup", { code: "Space", key: " " });
  assert.equal(h.app.state.isPinching, true);
});

/* ---------- Canvas interaction ---------- */
test("hitTestWindow uses the projected quad and mouse drag moves a grabbed window", () => {
  const h = createHarness();
  h.boot();
  const canvas = h.el("spatial-canvas");
  h.app.windows.slice(1).forEach(w => { w.enabled = false; });
  const center = h.app.renderer.project({ x: h.app.windows[0].x, y: h.app.windows[0].y, z: h.app.windows[0].z });
  assert.ok(center);
  const hit = h.app.hitTestWindow({ clientX: center.x, clientY: center.y });
  assert.equal(hit.id, "code-studio");
  assert.equal(h.app.hitTestWindow({ clientX: 5, clientY: 5 }), null);

  const before = h.app.windows[0].x;
  canvas.dispatch("mousedown", { clientX: center.x, clientY: center.y, shiftKey: false });
  assert.equal(h.app.state.grabbedWindowId, "code-studio");
  assert.equal(h.app.state.isPinching, true);
  canvas.dispatch("mousemove", { clientX: center.x + 20, clientY: center.y + 4, shiftKey: false });
  assert.ok(h.app.windows[0].x > before);
  h.dispatchWin("mouseup", {});
  assert.equal(h.app.state.grabbedWindowId, null);
  assert.equal(h.app.state.isPinching, false);
});

test("Shift drag orbits the scene instead of moving the hand", () => {
  const h = createHarness();
  h.boot();
  const canvas = h.el("spatial-canvas");
  const beforeX = h.app.state.handWorldX;
  const beforeYaw = h.app.renderer.worldYaw;
  canvas.dispatch("mousedown", { clientX: 400, clientY: 250, shiftKey: true });
  canvas.dispatch("mousemove", { clientX: 450, clientY: 250, shiftKey: true });
  assert.equal(h.app.state.handWorldX, beforeX);
  assert.ok(h.app.renderer.worldYaw > beforeYaw);
  assert.equal(h.app.state.grabbedWindowId, null);
});

test("mouse position maps to a bounded hand position", () => {
  const h = createHarness();
  h.boot();
  const canvas = h.el("spatial-canvas");
  canvas.dispatch("mousemove", { clientX: 800, clientY: 500, shiftKey: false });
  assert.equal(h.app.state.handWorldX, 0.45);
  assert.equal(h.app.state.handWorldZ, -0.42);
  canvas.dispatch("mousemove", { clientX: -500, clientY: -500, shiftKey: false });
  assert.equal(h.app.state.handWorldX, -0.45);
});

test("touchend clears the grab and still plays the release cue path", () => {
  const h = createHarness();
  h.boot();
  const canvas = h.el("spatial-canvas");
  const center = h.app.renderer.project({ x: h.app.windows[1].x, y: h.app.windows[1].y, z: h.app.windows[1].z });
  canvas.dispatch("touchstart", { clientX: center.x, clientY: center.y, touches: [{ clientX: center.x, clientY: center.y }] });
  assert.equal(h.app.state.grabbedWindowId, "node-graph");
  canvas.dispatch("touchend", { touches: [] });
  assert.equal(h.app.state.grabbedWindowId, null);
  assert.equal(h.app.state.isPinching, false);
  assert.match(h.el("btn-pinch-toggle").textContent, /Hold pinch/);
});

/* ---------- Exports, benchmark, reset ---------- */
test("scene manifest is JSON serialisable and states the unverified format", () => {
  const h = createHarness();
  h.boot();
  const m = h.app.buildManifest();
  const roundTrip = JSON.parse(JSON.stringify(m));
  assert.deepEqual(roundTrip, JSON.parse(JSON.stringify(m)));
  assert.equal(JSON.stringify(roundTrip), JSON.stringify(m));
  assert.ok(m.telemetry && typeof m.telemetry === "object");
  assert.equal(m.app, "SpatialHand Studio");
  assert.equal(m.version, h.app.APP_VERSION);
  assert.equal(m.format, "spatial-hand-scene-v1");
  assert.equal(m.sdkImportVerified, false);
  assert.match(m.formatNote, /No SDK import was verified/);
  assert.equal(m.renderer.engine, "Canvas 2D");
  assert.equal(m.renderer.webgl, false);
  assert.equal(m.hand.jointCount, 25);
  assert.equal(m.hand.joints.length, 25);
  assert.deepEqual([...m.xr.requiredFeaturesWhenRequested], ["hand-tracking", "local-floor"]);
  assert.equal(m.curvedGuide.halfArcDeg, 34);
  assert.equal(m.ergonomics.restedTorqueNm, 2.99);
  assert.equal(m.ergonomics.elevatedTorqueNm, 9.46);
  assert.equal(m.ergonomics.reductionPct, 68.4);
  assert.match(m.ergonomics.note, /no measured fatigue/i);
  assert.equal(m.windows.length, 3);
  assert.ok(m.telemetry);
});

test("manifest export downloads a JSON file and shows it inline", () => {
  const h = createHarness();
  h.boot();
  h.el("btn-export-manifest").dispatch("click", {});
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].type, "application/json");
  const body = h.downloads[0].parts[0];
  assert.equal(JSON.parse(body).format, "spatial-hand-scene-v1");
  assert.equal(h.el("manifest-box") || h.el("manifest-anchor").children[0].id, "manifest-box");
  assert.equal(h.el("manifest-anchor").children[0].textContent, body);
});

test("downloadText enforces the size cap and handles a missing URL API", () => {
  const h = createHarness();
  h.boot();
  assert.equal(h.app.downloadText("x.txt", "hello", "text/plain"), true);
  assert.equal(h.downloads.length, 1);
  assert.equal(h.app.downloadText("big.txt", "x".repeat(4 * 1024 * 1024 + 1)), false);
  assert.equal(h.downloads.length, 1);
});

test("telemetry CSV export downloads a file and shows the report", () => {
  const h = createHarness();
  h.boot();
  h.advance(16); h.flushRaf(16);
  h.el("btn-export-telemetry").dispatch("click", {});
  assert.equal(h.downloads.length, 1);
  assert.equal(h.downloads[0].type, "text/csv");
  const csv = h.downloads[0].parts[0];
  assert.ok(csv.startsWith("t_ms,source,pinch_mm,pinch_state"));
  assert.equal(csv.split("\r\n").length, 2);
  assert.equal(h.el("telemetry-report").style.display, "block");
  assert.match(h.el("toast").textContent, /Frame CSV exported/);
});

test("posture comparison runs to completion by recomputing the two model values", () => {
  const h = createHarness();
  h.boot();
  h.el("btn-run-bench").dispatch("click", {});
  assert.equal(h.app.state.benchRunning, true);
  assert.match(h.el("bench-status").textContent, /6 s animation/);
  assert.equal(h.app.state.benchResult, null);
  h.setClock(6000);
  h.flushRaf(6000);
  assert.equal(h.app.state.benchRunning, false);
  assert.equal(h.app.state.benchProgress, 1);
  assert.equal(h.app.state.benchResult.reductionPct, 68.4);
  assert.equal(h.el("bench-progress-bar").style.width, "100.0%");
  assert.match(h.el("bench-result").innerHTML, /2\.99 N\.m/);
  assert.match(h.el("bench-result").innerHTML, /9\.46 N\.m/);
  assert.match(h.el("bench-status").textContent, /not a timed trial/);
});

test("resetScene restores windows, toggles, timer and pinch button", () => {
  const h = createHarness();
  h.boot();
  const app = h.app;
  app.windows[0].x = 0.8;
  app.windows[1].enabled = false;
  app.state.timerRemaining = 10;
  app.state.timerRunning = true;
  app.state.isPinching = true;
  app.renderer.worldYaw = 0.5;
  app.toggleSpatialAudio();
  h.el("btn-reset-view").dispatch("click", {});
  assert.equal(app.windows[0].x, -0.36);
  assert.equal(app.windows[1].enabled, true);
  assert.equal(app.state.timerRemaining, 1500);
  assert.equal(app.state.timerRunning, false);
  assert.equal(app.state.isPinching, false);
  assert.equal(app.renderer.worldYaw, 0);
  assert.equal(h.selectorLists["[data-app-toggle]"][1].textContent, "On");
  assert.match(h.el("btn-pinch-toggle").textContent, /Hold pinch/);
});

test("two-hand stretch clamps scale and restoreWindowSize reverts the base size", () => {
  const h = createHarness();
  h.boot();
  const app = h.app;
  const w = app.windows[1];
  const base = w.w;
  assert.equal(app.applyTwoHandStretch(NaN), null);
  assert.equal(app.applyTwoHandStretch(-1), null);
  assert.equal(app.applyTwoHandStretch(10).scale, 1.6);
  assert.equal(app.applyTwoHandStretch(0).scale, 0.6);
  assert.equal(app.applyTwoHandStretch(0.36).scale, 1);
  app.restoreWindowSize(w);
  assert.equal(w.w, base);
  assert.equal(w.baseW, undefined);
  assert.equal(w.stretchScale, undefined);
  assert.equal(app.applyTwoHandStretch(0.36).scale, 1);
});

test("stretch scale and dimension line follow the rendered pinch midpoints", () => {
  const h = createHarness(); h.boot();
  const app = h.app, r = app.renderer;
  app.runGestureDemo("stretch");
  const expectedContact = hand => {
    const c = Math.cos(hand.yaw), s = Math.sin(hand.yaw);
    const tips = ["thumb-tip", "index-finger-tip"].map(name => {
      const p = hand.joints[name];
      return { x: hand.worldX + p.x * c + p.z * s, y: hand.worldY + p.y,
        z: hand.worldZ - p.x * s + p.z * c };
    });
    return { x: (tips[0].x + tips[1].x) / 2, y: (tips[0].y + tips[1].y) / 2,
      z: (tips[0].z + tips[1].z) / 2 };
  };
  const check = () => {
    const contacts = r.hands.map(expectedContact);
    const a = contacts[0], b = contacts[1];
    const separation = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    assert.ok(Math.abs(r.stretch.separationM - separation) < 1e-12);
    assert.ok(Math.abs(r.stretch.scale - Math.max(0.6, Math.min(1.6, separation / 0.36))) < 1e-12);
    // Normalize both containers at the VM boundary, then compare coordinates.
    assert.deepEqual(JSON.parse(JSON.stringify(r.stretch.contacts)), JSON.parse(JSON.stringify(contacts)));
    const points = [], project = r.project;
    r.project = function (p) { points.push(p); return project.call(this, p); };
    try { r.drawHands(); } finally { r.project = project; }
    for (const contact of contacts) assert.ok(points.some(p => p && p.x === contact.x && p.y === contact.y && p.z === contact.z));
    return r.stretch.scale;
  };
  app.frame(1000);
  const before = check();
  h.evalIn('baseJointsLeft["thumb-tip"].x += 0.08; baseJointsLeft["index-finger-tip"].x += 0.08;');
  app.frame(1016);
  assert.ok(Math.abs(check() - before) > 0.1, "joint contact motion must change the scale");
});

test("telemetry wrist and reach use the same rotated joint that the renderer draws", () => {
  const h = createHarness(); h.boot();
  const app = h.app, r = app.renderer;
  app.runGestureDemo("mouse");
  Object.assign(app.state, { handWorldX: 0.2, handWorldY: -0.04, handWorldZ: -0.12, handYaw: 0.6 });
  const projected = [], project = r.project;
  r.project = function (p) { projected.push(p); return project.call(this, p); };
  try { app.frame(1000); } finally { r.project = project; }
  const expected = { x: 0.2 - 0.06 * Math.sin(0.6), y: -0.04, z: -0.12 - 0.06 * Math.cos(0.6) };
  const frame = app.telemetryFrames.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.wrist)), expected);
  assert.deepEqual(JSON.parse(JSON.stringify(frame.reach)), {
    x: expected.x - app.CONE_APEX.x, y: expected.y - app.CONE_APEX.y, z: expected.z - app.CONE_APEX.z
  });
  assert.ok(projected.some(p => p && p.x === expected.x && p.y === expected.y && p.z === expected.z));
  assert.ok(Math.abs(Math.hypot(frame.wrist.x - app.state.handWorldX, frame.wrist.z - app.state.handWorldZ) - 0.06) < 1e-12);
});

test("focus timer uses elapsed seconds, not frames, and stops at zero", () => {
  const h = createHarness();
  h.boot();
  const app = h.app;
  app.startFocusTimer();
  assert.equal(app.state.timerRunning, true);
  h.setClock(16); h.flushRaf(16);
  h.setClock(1000); h.flushRaf(1000);
  assert.equal(app.state.timerRemaining, 1499);
  h.setClock(11000); h.flushRaf(11000);
  assert.equal(app.state.timerRemaining, 1489, "a ten-second frame gap consumes ten seconds");
  assert.ok(app.state.timerTickAccum < 1, "missed tick cues are coalesced");
  h.setClock(11500); app.pauseFocusTimer();
  assert.equal(app.state.timerRemaining, 1488.5, "pause includes the time since the last frame");
  h.setClock(20000); h.flushRaf(20000);
  assert.equal(app.state.timerRemaining, 1488.5);
  app.startFocusTimer();
  h.setClock(30000); h.flushRaf(30000);
  assert.equal(app.state.timerRemaining, 1478.5);
  app.pauseFocusTimer();
  app.state.timerRemaining = 0.5;
  app.startFocusTimer();
  let completed = 0;
  app.SFX.timerDone = () => { completed++; };
  h.setClock(31000); h.flushRaf(31000);
  assert.equal(app.state.timerRunning, false);
  assert.equal(app.state.timerRemaining, 0);
  assert.equal(app.state.timerDeadlineMs, null);
  h.setClock(41000); h.flushRaf(41000);
  assert.equal(completed, 1);
  app.pauseFocusTimer();
  assert.equal(app.state.timerRunning, false);
  assert.match(app.windows[2].title, /00:00 \(paused\)/);
});

test("radial palette has six actions and the palm-up preset activates it", () => {
  const h = createHarness();
  h.boot();
  assert.equal(h.app.RADIAL_ACTIONS.length, 6);
  assert.equal(h.app.state.radialActive, false);
  h.selectorLists["[data-gesture]"][2].dispatch("click", {});
  h.setClock(16); h.flushRaf(16);
  assert.equal(h.app.state.radialActive, true);
  assert.ok(h.app.state.radialIndex >= 0 && h.app.state.radialIndex < 6);
  h.selectorLists["[data-gesture]"][0].dispatch("click", {});
  h.setClock(32); h.flushRaf(32);
  assert.equal(h.app.state.radialActive, false);
});

/* ---------- Camera cleanup ---------- */
test("camera failure falls back to mouse control and repeated start is gated", async () => {
  const h = createHarness();
  h.boot();
  await h.app.startWebcamHand();
  assert.equal(h.app.webcam.active, false);
  assert.match(h.app.state.webcamError, /Mouse and touch control remain available/);
  assert.equal(h.app.webcam.pending, false);
  assert.equal(h.app.state.webcamActive, false);
});

test("stopWebcamHand clears globals and pagehide stops both camera and XR", () => {
  const h = createHarness();
  h.boot();
  h.context.window.__spatialHandWebcamVideo = null;
  h.app.webcam.active = true;
  h.app.webcam.video = { srcObject: {} };
  h.app.webcam.stream = { getTracks: () => [{ stop() {} }] };
  h.app.webcam.rafId = 99;
  h.app.stopWebcamHand();
  assert.equal(h.app.webcam.active, false);
  assert.equal(h.app.webcam.video, null);
  assert.equal(h.app.webcam.stream, null);
  assert.equal(h.context.window.__spatialHandWebcamVideo, null);
  assert.equal(h.context.window.__spatialHandWebcamHand, null);
  h.dispatchWin("pagehide", {});
});

test("visibilitychange stops the camera when the page is hidden", () => {
  const h = createHarness();
  h.boot();
  h.app.webcam.active = true;
  h.doc.hidden = true;
  h.dispatchDoc("visibilitychange", {});
  assert.equal(h.app.webcam.active, false);
});


test("window hit testing follows the visible front surface when quads overlap", () => {
  const h = createHarness(); h.boot();
  const w = h.app.windows[0];
  const centre = h.app.renderer.project(w);
  assert.equal(h.app.hitTestWindow({ clientX: centre.x, clientY: centre.y }).id, "node-graph");
  const quad = h.app.renderer.windowQuad(w);
  assert.equal(quad.length, 4);
  h.app.windows.slice(1).forEach(other => { other.enabled = false; });
  for (const p of quad) assert.equal(h.app.hitTestWindow({ clientX: p.x, clientY: p.y }).id, w.id);
});

test("docking, drawing and the manifest share the exact curved guide", () => {
  const h = createHarness(); h.boot();
  h.app.RADIAL_ACTIONS[0].action();
  const m = h.app.buildManifest();
  for (const w of h.app.windows) {
    const dz = w.z - m.curvedGuide.centreZM;
    assert.ok(Math.abs(Math.hypot(w.x, dz) - m.curvedGuide.radiusM) < 1e-12);
    assert.ok(Math.abs(Math.atan2(w.x, dz)) <= 34 * Math.PI / 180 + 1e-12);
  }
});

test("world-space hand joints are not translated twice and local yaw is rigid", () => {
  const h = createHarness(); h.boot();
  const r = h.app.renderer, p = { x: 0.1, y: 0.2, z: 0.3 };
  const hand = { jointsAreWorld: true, worldX: 0.1, worldY: 0.2, worldZ: 0.3, yaw: 1 };
  assert.deepEqual(JSON.parse(JSON.stringify(r.handJointWorld(hand, p))), p);
  hand.jointsAreWorld = false; hand.worldX = 0; hand.worldY = 0; hand.worldZ = 0;
  const rotated = r.handJointWorld(hand, p);
  assert.ok(Math.abs(Math.hypot(rotated.x, rotated.y, rotated.z) - Math.hypot(p.x, p.y, p.z)) < 1e-12);
});

test("touch cancellation releases a grabbed window and boot is idempotent", () => {
  const h = createHarness(); h.boot();
  const frames = h.pendingRaf();
  h.boot();
  assert.equal(h.pendingRaf(), frames);
  h.app.state.grabbedWindowId = "code-studio";
  h.app.state.isPinching = true;
  h.el("spatial-canvas").dispatch("touchcancel", {});
  assert.equal(h.app.state.grabbedWindowId, null);
  assert.equal(h.app.state.isPinching, false);
});

test("download capacity is checked in UTF-8 bytes", () => {
  const h = createHarness(); h.boot();
  assert.equal(h.app.downloadText("large.txt", String.fromCharCode(0x754c).repeat(1500000)), false);
  assert.equal(h.downloads.length, 0);
});


test("manual pinch overrides a demonstration pose and palette actions work by keyboard", () => {
  const h = createHarness(); h.boot();
  h.app.state.spatialAudio = false;
  h.app.state.isPinching = true;
  h.app.frame(0);
  assert.ok(Math.abs(h.app.telemetryFrames.at(-1).pinchMm - 12) < 1e-9);
  h.app.state.isPinching = false;
  h.app.runGestureDemo("palm-up"); h.app.frame(16);
  const initial = h.app.state.radialIndex;
  h.dispatchWin("keydown", { key: "ArrowRight", code: "ArrowRight" });
  h.app.frame(32);
  assert.equal(h.app.state.radialIndex, (initial + 1) % 6);
  h.dispatchWin("keydown", { key: "Enter", code: "Enter" });
  assert.equal(h.app.state.spatialAudio, true);
});

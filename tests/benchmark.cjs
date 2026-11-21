"use strict";
const assert = require("node:assert/strict");
const { performance } = require("node:perf_hooks");
const { createHarness } = require("./helpers/dom-harness.cjs");

if (process.argv.slice(2).some(arg => arg !== "--check")) throw new Error("Usage: node tests/benchmark.cjs --check");
const started = performance.now();
const h = createHarness({ mediaDevices: false });
h.boot();
const app = h.app, count = 2400, intervalMs = 20;
app.state.spatialAudio = false;
let stretchFrames = 0;
const presets = ["pinch", "stretch", "poke", "mouse"];
for (let i = 1; i <= count; i++) {
  if ((i - 1) % 600 === 0) app.runGestureDemo(presets[Math.floor((i - 1) / 600)]);
  h.setClock(i * intervalMs);
  h.flushRaf(h.clock);
  assert.equal(app.renderer.hands.length, i > 600 && i <= 1200 ? 2 : 1);
  if (app.renderer.stretch) {
    const stretch = app.renderer.stretch;
    assert.ok(Number.isFinite(stretch.separationM));
    assert.equal(stretch.contacts.length, 2);
    assert.ok(stretch.scale >= 0.6 && stretch.scale <= 1.6);
    stretchFrames++;
  }
  h.canvasCtx().calls.length = 0;
}
assert.equal(stretchFrames, 600);
assert.equal(app.telemetryFrames.length, 1800);
for (const frame of app.telemetryFrames) {
  assert.ok([frame.wrist.x, frame.wrist.y, frame.wrist.z].every(Number.isFinite));
  for (const axis of ["x", "y", "z"]) assert.equal(frame.reach[axis], frame.wrist[axis] - app.CONE_APEX[axis]);
}
const report = app.buildSessionReportNow();
assert.equal(report.frameCount, 1800);
assert.equal(report.durationMs, 35980);
assert.equal(report.pinch.samples, 1800);
assert.ok(report.sources.every(source => presets.includes(source)));
assert.equal(app.buildManifest().sdkImportVerified, false);
app.runBenchmark();
h.advance(6000); h.flushRaf(h.clock);
assert.equal(app.state.benchRunning, false);
assert.equal(app.state.benchResult.restedNm, 2.99);
assert.equal(app.state.benchResult.elevatedNm, 9.46);
assert.equal(app.state.benchResult.reductionPct, 68.4);
console.log(JSON.stringify({
  ok: true, source: "synthetic desktop frames", framesProcessed: count, intervalMs,
  retainedFrames: report.frameCount, retainedDurationMs: report.durationMs, stretchFrames,
  postureComparison: app.state.benchResult,
  runtimeMs: Math.round(performance.now() - started)
}, null, 2));

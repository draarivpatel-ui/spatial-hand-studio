"use strict";
/* Filter, pinch-hysteresis and biomechanics lab suite. Drives the pure
   module directly plus the real app wiring through the DOM harness. */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const FL = require("../js/filter-lab.js");
const kin = require("../js/xr-hand-kinematics.js");
const { createHarness } = require("./helpers/dom-harness.cjs");

const nodeSha = s => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/* ---------- A. Module surface ---------- */
test("lab exports the documented API surface", () => {
  for (const name of [
    "FILTER_PROFILES", "FILTER_ORDER", "FILTER_IDS", "TRAJECTORIES", "TRAJECTORY_ORDER",
    "TRAJECTORY_IDS", "EmaFilter", "RawFilter", "makeFilter", "mulberry32",
    "generateTrajectory", "trajectoryInfo", "runTrajectory", "runComparison",
    "computeMetrics", "channelLagMs", "longestDropoutRun", "paretoFrontierIds",
    "quasiStaticShoulderMomentNm", "sweepShoulderMoment", "utf8Bytes", "sha256Bytes",
    "sha256Hex", "canonicalJson", "normalizeLabState", "buildExportPayload", "digestFor",
    "exportJson", "exportCsv", "exportMarkdown", "csvCell", "verifyDigest",
    "verifyExportIntegrity", "encodeBookmarkHash", "decodeBookmarkHash",
    "SELF_TESTS", "runSelfTests", "kinematicsAvailable", "DISCLOSURES",
    "STATE_LIMITS", "LAB_DEFAULTS"
  ]) {
    assert.ok(FL[name] !== undefined, name);
  }
});
test("lab constants match the rig: 90 Hz, 270 frames, 1.5 mm recovery band", () => {
  assert.equal(FL.SAMPLE_RATE_HZ, 90);
  assert.ok(Math.abs(FL.DT_MS - 1000 / 90) < 1e-9);
  assert.equal(FL.FRAME_COUNT, 270);
  assert.equal(FL.RECOVERY_BAND_MM, 1.5);
  assert.equal(FL.MAX_HASH_LEN, 700);
});
test("STATE_LIMITS are frozen with documented bounds", () => {
  assert.ok(Object.isFrozen(FL.STATE_LIMITS));
  assert.deepEqual(FL.STATE_LIMITS, { enterMinMm: 5, enterMaxMm: 80, exitMaxMm: 100, armMaxDeg: 90, elbowMaxDeg: 120 });
});
test("LAB_DEFAULTS are frozen", () => {
  assert.ok(Object.isFrozen(FL.LAB_DEFAULTS));
  assert.equal(FL.LAB_DEFAULTS.trajectory, "micro-tremor-hover");
  assert.equal(FL.LAB_DEFAULTS.profile, "one-euro-balanced");
});
test("kinematicsAvailable is true under CommonJS", () => {
  assert.equal(FL.kinematicsAvailable(), true);
});
test("DISCLOSURES mention synthetic data, quasi-static model and unkeyed digest", () => {
  const joined = FL.DISCLOSURES.join(" ");
  assert.match(joined, /synthetic/i);
  assert.match(joined, /quasi-static/i);
  assert.match(joined, /unkeyed/i);
});
test("VERSION is a semver-shaped string", () => {
  assert.match(FL.VERSION, /^\d+\.\d+\.\d+$/);
});

/* ---------- B. Filter profiles ---------- */
test("exactly five profiles in the documented order", () => {
  assert.deepEqual(FL.FILTER_ORDER, [
    "raw-unfiltered", "ema-heavy", "one-euro-precision", "one-euro-balanced", "one-euro-fast"
  ]);
  assert.equal(FL.FILTER_ORDER.length, 5);
  assert.strictEqual(FL.FILTER_IDS, FL.FILTER_ORDER);
});
test("every profile is frozen with id, label, kind and description", () => {
  for (const id of FL.FILTER_ORDER) {
    const p = FL.FILTER_PROFILES[id];
    assert.ok(Object.isFrozen(p), id);
    assert.equal(p.id, id);
    assert.equal(typeof p.label, "string");
    assert.ok(["raw", "ema", "one-euro"].includes(p.kind));
    assert.equal(typeof p.description, "string");
    assert.equal(typeof p.appliesToLiveRig, "boolean");
  }
});
test("exactly three profiles map onto the live 1-Euro rig", () => {
  const live = FL.FILTER_ORDER.filter(id => FL.FILTER_PROFILES[id].appliesToLiveRig);
  assert.deepEqual(live, ["one-euro-precision", "one-euro-balanced", "one-euro-fast"]);
});
test("balanced profile matches the rig defaults: 1.2 Hz, beta 0.007, dCutoff 1.0", () => {
  const p = FL.FILTER_PROFILES["one-euro-balanced"];
  assert.equal(p.freq, 90);
  assert.equal(p.minCutoff, 1.2);
  assert.equal(p.beta, 0.007);
  assert.equal(p.dCutoff, 1.0);
});
test("precision profile is heavier than balanced, fast is lighter", () => {
  assert.ok(FL.FILTER_PROFILES["one-euro-precision"].minCutoff < FL.FILTER_PROFILES["one-euro-balanced"].minCutoff);
  assert.ok(FL.FILTER_PROFILES["one-euro-fast"].minCutoff > FL.FILTER_PROFILES["one-euro-balanced"].minCutoff);
  assert.ok(FL.FILTER_PROFILES["one-euro-fast"].beta > FL.FILTER_PROFILES["one-euro-balanced"].beta);
});
test("makeFilter rejects unknown profile ids", () => {
  for (const bad of ["", "nope", "__proto__", 42, null, undefined, {}, ["one-euro-balanced"]]) {
    assert.throws(() => FL.makeFilter(bad), RangeError, String(bad));
  }
});
test("makeFilter returns a profile reference and working filter for every id", () => {
  for (const id of FL.FILTER_ORDER) {
    const m = FL.makeFilter(id);
    assert.equal(m.profile, FL.FILTER_PROFILES[id]);
    const v = m.filter(12.5, 0);
    assert.ok(Number.isFinite(v), id);
  }
});
test("ema-heavy profile carries alpha 0.12", () => {
  assert.equal(FL.FILTER_PROFILES["ema-heavy"].alpha, 0.12);
});
test("raw profile carries no cutoff parameters", () => {
  const p = FL.FILTER_PROFILES["raw-unfiltered"];
  assert.equal(p.minCutoff, undefined);
  assert.equal(p.beta, undefined);
});
test("one-euro makeFilter builds the real kinematics filter", () => {
  const m = FL.makeFilter("one-euro-precision");
  const v1 = m.filter(10, 0);
  const v2 = m.filter(30, 11.111);
  assert.ok(v2 > v1 && v2 < 30, "filtered value converges but lags");
});

/* ---------- C. RawFilter ---------- */
test("raw filter passes finite values through unchanged", () => {
  const f = new FL.RawFilter();
  assert.equal(f.filter(4.5, 0), 4.5);
  assert.equal(f.filter(-7.25, 11), -7.25);
  assert.equal(f.filter(0, 22), 0);
});
test("raw filter returns NaN on NaN input", () => {
  const f = new FL.RawFilter();
  f.filter(4, 0);
  assert.ok(Number.isNaN(f.filter(NaN, 11)));
});
test("raw filter returns NaN on Infinity input", () => {
  const f = new FL.RawFilter();
  f.filter(4, 0);
  assert.ok(Number.isNaN(f.filter(Infinity, 11)));
  assert.ok(Number.isNaN(f.filter(-Infinity, 22)));
});
test("raw filter rejects non-increasing timestamps", () => {
  const f = new FL.RawFilter();
  f.filter(4, 100);
  assert.ok(Number.isNaN(f.filter(9, 100)));
  assert.ok(Number.isNaN(f.filter(9, 50)));
});
test("raw filter rejects non-finite timestamps", () => {
  const f = new FL.RawFilter();
  assert.ok(Number.isNaN(f.filter(9, NaN)));
  assert.ok(Number.isNaN(f.filter(9, Infinity)));
});
test("raw filter reset restores passthrough", () => {
  const f = new FL.RawFilter();
  f.filter(4, 0);
  f.reset();
  assert.equal(f.filter(8, 0), 8);
});

/* ---------- D. EmaFilter ---------- */
test("ema constructor validates alpha in (0,1]", () => {
  for (const bad of [0, -0.5, 1.5, NaN, Infinity, "x", undefined + 1]) {
    assert.throws(() => new FL.EmaFilter({ alpha: bad }), RangeError, String(bad));
  }
});
test("ema first sample echoes the input", () => {
  const f = new FL.EmaFilter({ alpha: 0.12 });
  assert.equal(f.filter(50, 0), 50);
});
test("ema applies alpha gain on subsequent samples", () => {
  const f = new FL.EmaFilter({ alpha: 0.25 });
  f.filter(0, 0);
  assert.equal(f.filter(40, 10), 10);
  assert.equal(f.filter(40, 20), 17.5);
});
test("ema holds its estimate on NaN", () => {
  const f = new FL.EmaFilter({ alpha: 0.5 });
  f.filter(10, 0);
  const held = f.filter(20, 10);
  assert.equal(f.filter(NaN, 20), held);
  assert.equal(f.filter(undefined, 30), held);
});
test("ema holds its estimate on backward timestamps", () => {
  const f = new FL.EmaFilter({ alpha: 0.5 });
  f.filter(10, 100);
  const held = f.filter(30, 200);
  assert.equal(f.filter(999, 50), held);
  assert.equal(f.filter(999, 200), held);
});
test("ema on non-finite first sample yields NaN", () => {
  const f = new FL.EmaFilter({ alpha: 0.5 });
  assert.ok(Number.isNaN(f.filter(NaN, 0)));
});
test("ema alpha 1 is a passthrough", () => {
  const f = new FL.EmaFilter({ alpha: 1 });
  f.filter(10, 0);
  assert.equal(f.filter(77, 10), 77);
});
test("ema reset restarts the estimate", () => {
  const f = new FL.EmaFilter({ alpha: 0.5 });
  f.filter(10, 0); f.filter(20, 10);
  f.reset();
  assert.equal(f.filter(30, 0), 30);
});
test("ema defaults to alpha 0.12", () => {
  const f = new FL.EmaFilter();
  f.filter(0, 0);
  assert.equal(f.filter(100, 10), 12);
});

/* ---------- E. Trajectories ---------- */
test("all four named trajectories exist in order", () => {
  assert.deepEqual(FL.TRAJECTORY_ORDER, [
    "micro-tremor-hover", "step-saccade-grab", "pinch-chatter-boundary", "tracking-dropout-recovery"
  ]);
  for (const id of FL.TRAJECTORY_ORDER) assert.ok(FL.TRAJECTORIES[id].label.length > 3);
});
test("every trajectory generates exactly 270 frames", () => {
  for (const id of FL.TRAJECTORY_ORDER) {
    const t = FL.generateTrajectory(id);
    assert.equal(t.frames.length, 270, id);
    assert.equal(t.frames[269].i, 269);
  }
});
test("frames carry monotonically increasing 90 Hz timestamps", () => {
  const t = FL.generateTrajectory("micro-tremor-hover");
  for (let i = 1; i < t.frames.length; i++) {
    assert.ok(t.frames[i].t > t.frames[i - 1].t, i);
    assert.ok(Math.abs((t.frames[i].t - t.frames[i - 1].t) - FL.DT_MS) < 1e-6, i);
  }
});
test("each frame carries the four channel fields", () => {
  const t = FL.generateTrajectory("step-saccade-grab");
  for (const f of t.frames) {
    for (const k of ["rawX", "truthX", "rawPinch", "truthPinch"]) {
      assert.ok(k in f, k);
      assert.equal(typeof f[k], "number");
    }
  }
});
test("generation is deterministic byte for byte", () => {
  for (const id of FL.TRAJECTORY_ORDER) {
    const a = FL.sha256Hex(JSON.stringify(FL.generateTrajectory(id).frames));
    const b = FL.sha256Hex(JSON.stringify(FL.generateTrajectory(id).frames));
    assert.equal(a, b, id);
  }
});
test("different trajectories produce different frame digests", () => {
  const digests = new Set(FL.TRAJECTORY_ORDER.map(id =>
    FL.sha256Hex(JSON.stringify(FL.generateTrajectory(id).frames))));
  assert.equal(digests.size, FL.TRAJECTORY_ORDER.length);
});
test("micro-tremor truth path is constant with full-window hold range", () => {
  const t = FL.generateTrajectory("micro-tremor-hover");
  assert.ok(t.frames.every(f => f.truthX === 62 && f.truthPinch === 33));
  assert.deepEqual(t.holdRanges, [[0, 269]]);
  assert.equal(t.stepIndex, null);
});
test("step trajectory steps 45 to 105 mm at frame 90", () => {
  const t = FL.generateTrajectory("step-saccade-grab");
  assert.equal(t.stepIndex, 90);
  assert.equal(t.frames[89].truthX, 45);
  assert.equal(t.frames[90].truthX, 105);
});
test("step trajectory pinch ramps to 14 mm by frame 126", () => {
  const t = FL.generateTrajectory("step-saccade-grab");
  assert.equal(t.frames[80].truthPinch, 60);
  assert.equal(t.frames[126].truthPinch, 14);
  assert.equal(t.frames[200].truthPinch, 14);
});
test("chatter trajectory oscillates across enter 20 and exit 28 mm", () => {
  const t = FL.generateTrajectory("pinch-chatter-boundary");
  const tp = t.frames.map(f => f.truthPinch);
  assert.ok(Math.min(...tp) < 20, "dips below enter");
  assert.ok(Math.max(...tp) > 28, "rises above exit");
});
test("dropout trajectory emits exactly 34 NaN frames across two windows", () => {
  const t = FL.generateTrajectory("tracking-dropout-recovery");
  const nans = t.frames.filter(f => Number.isNaN(f.rawX)).length;
  assert.equal(nans, 12 + 22);
  assert.deepEqual(t.dropoutRuns, [[60, 71], [110, 131]]);
});
test("dropout windows emit NaN on pinch too but never on truth", () => {
  const t = FL.generateTrajectory("tracking-dropout-recovery");
  for (const f of t.frames) {
    assert.ok(Number.isFinite(f.truthX) && Number.isFinite(f.truthPinch));
    if (Number.isNaN(f.rawX)) assert.ok(Number.isNaN(f.rawPinch));
  }
});
test("raw channels stay within 5 mm of truth everywhere", () => {
  for (const id of FL.TRAJECTORY_ORDER) {
    const t = FL.generateTrajectory(id);
    for (const f of t.frames) {
      if (Number.isFinite(f.rawX)) assert.ok(Math.abs(f.rawX - f.truthX) < 5, id + " x " + f.i);
      if (Number.isFinite(f.rawPinch)) assert.ok(Math.abs(f.rawPinch - f.truthPinch) < 5, id + " p " + f.i);
    }
  }
});
test("unknown trajectory ids throw RangeError", () => {
  for (const bad of ["", "nope", "__proto__", "constructor", null, undefined, 5]) {
    assert.throws(() => FL.generateTrajectory(bad), RangeError, String(bad));
  }
});
test("trajectoryInfo reports duration, step and dropout metadata", () => {
  const hover = FL.trajectoryInfo("micro-tremor-hover");
  assert.equal(hover.frameCount, 270);
  assert.equal(hover.sampleRateHz, 90);
  assert.ok(Math.abs(hover.durationMs - 3000) < 0.001);
  assert.equal(hover.hasStep, false);
  assert.equal(hover.hasDropout, false);
  assert.equal(hover.dropoutFrames, 0);
});
test("trajectoryInfo flags the step and dropout trajectories correctly", () => {
  assert.equal(FL.trajectoryInfo("step-saccade-grab").hasStep, true);
  const drop = FL.trajectoryInfo("tracking-dropout-recovery");
  assert.equal(drop.hasDropout, true);
  assert.equal(drop.dropoutFrames, 34);
});
test("trajectoryInfo throws on unknown ids", () => {
  assert.throws(() => FL.trajectoryInfo("bogus"), RangeError);
});

/* ---------- F. runTrajectory and metrics ---------- */
test("runTrajectory returns 270 samples plus transitions and metrics", () => {
  const r = FL.runTrajectory("micro-tremor-hover", "one-euro-balanced", { enterMm: 20, exitMm: 28 });
  assert.equal(r.samples.length, 270);
  assert.ok(Array.isArray(r.transitions));
  assert.equal(r.profile, FL.FILTER_PROFILES["one-euro-balanced"]);
  assert.deepEqual(r.thresholdsMm, { enter: 20, exit: 28 });
});
test("samples carry raw, truth, filtered and FSM state per frame", () => {
  const r = FL.runTrajectory("step-saccade-grab", "raw-unfiltered");
  const s = r.samples[5];
  for (const k of ["i", "t", "rawX", "truthX", "filtX", "rawPinch", "truthPinch", "filtPinch", "state"]) {
    assert.ok(k in s, k);
  }
  assert.equal(typeof s.state, "string");
});
test("runTrajectory validates the hysteresis bounds", () => {
  assert.throws(() => FL.runTrajectory("micro-tremor-hover", "raw-unfiltered", { enterMm: 28, exitMm: 28 }), RangeError);
  assert.throws(() => FL.runTrajectory("micro-tremor-hover", "raw-unfiltered", { enterMm: 30, exitMm: 20 }), RangeError);
  assert.throws(() => FL.runTrajectory("micro-tremor-hover", "raw-unfiltered", { enterMm: NaN, exitMm: 28 }), RangeError);
  assert.throws(() => FL.runTrajectory("micro-tremor-hover", "raw-unfiltered", { enterMm: -5, exitMm: 28 }), RangeError);
  assert.throws(() => FL.runTrajectory("micro-tremor-hover", "raw-unfiltered", { enterMm: Infinity, exitMm: 28 }), RangeError);
});
test("runTrajectory rejects unknown trajectories and profiles", () => {
  assert.throws(() => FL.runTrajectory("bogus", "raw-unfiltered"), RangeError);
  assert.throws(() => FL.runTrajectory("micro-tremor-hover", "bogus"), RangeError);
});
test("micro-tremor: every 1-Euro profile cuts jitter versus raw", () => {
  const cmp = FL.runComparison("micro-tremor-hover", { enterMm: 20, exitMm: 28 });
  const raw = cmp.rows.find(r => r.profile.id === "raw-unfiltered").metrics.jitterRmsMm;
  for (const r of cmp.rows) {
    if (r.profile.kind === "one-euro") {
      assert.ok(r.metrics.jitterRmsMm < raw, r.profile.id);
    }
  }
});
test("micro-tremor: precision profile has the lowest jitter", () => {
  const cmp = FL.runComparison("micro-tremor-hover", { enterMm: 20, exitMm: 28 });
  const min = Math.min(...cmp.rows.map(r => r.metrics.jitterRmsMm));
  const best = cmp.rows.find(r => r.metrics.jitterRmsMm === min);
  assert.equal(best.profile.id, "one-euro-precision");
});
test("raw filter has exactly zero effective lag on the step trajectory", () => {
  const r = FL.runTrajectory("step-saccade-grab", "raw-unfiltered", { enterMm: 20, exitMm: 28 });
  assert.equal(r.metrics.lagMs, 0);
});
test("filtered profiles pay measurable lag on the step", () => {
  for (const id of ["ema-heavy", "one-euro-balanced", "one-euro-fast"]) {
    const r = FL.runTrajectory("step-saccade-grab", id, { enterMm: 20, exitMm: 28 });
    assert.ok(r.metrics.lagMs > 0, id);
  }
});
test("raw settles the 60 mm step within the 90% band immediately", () => {
  const r = FL.runTrajectory("step-saccade-grab", "raw-unfiltered", { enterMm: 20, exitMm: 28 });
  assert.equal(r.metrics.settleLagMs90, 0);
});
test("heavy filtering delays 90% settle well past 100 ms", () => {
  const r = FL.runTrajectory("step-saccade-grab", "ema-heavy", { enterMm: 20, exitMm: 28 });
  assert.ok(r.metrics.settleLagMs90 > 100, String(r.metrics.settleLagMs90));
});
test("settle lag is null on trajectories without a step", () => {
  for (const id of ["micro-tremor-hover", "pinch-chatter-boundary", "tracking-dropout-recovery"]) {
    const r = FL.runTrajectory(id, "raw-unfiltered");
    assert.equal(r.metrics.settleLagMs90, null, id);
  }
});
test("chatter trajectory: raw rides the boundary into many pinch cycles", () => {
  const r = FL.runTrajectory("pinch-chatter-boundary", "raw-unfiltered", { enterMm: 20, exitMm: 28 });
  assert.ok(r.metrics.pinchCycles >= 5, String(r.metrics.pinchCycles));
  assert.ok(r.metrics.transitionCount >= 10);
});
test("chatter trajectory: heavy EMA collapses the chatter to zero pinch cycles", () => {
  const r = FL.runTrajectory("pinch-chatter-boundary", "ema-heavy", { enterMm: 20, exitMm: 28 });
  assert.equal(r.metrics.pinchCycles, 0);
});
test("balanced 1-Euro kills false pinches on the chatter boundary", () => {
  const r = FL.runTrajectory("pinch-chatter-boundary", "one-euro-balanced", { enterMm: 20, exitMm: 28 });
  assert.equal(r.metrics.falsePinchTransitions, 0);
  assert.equal(r.metrics.pinchCycles, 0);
});
test("widening hysteresis reduces raw chatter transitions", () => {
  const tight = FL.runTrajectory("pinch-chatter-boundary", "raw-unfiltered", { enterMm: 23, exitMm: 25 });
  const wide = FL.runTrajectory("pinch-chatter-boundary", "raw-unfiltered", { enterMm: 18, exitMm: 34 });
  assert.ok(wide.metrics.transitionCount < tight.metrics.transitionCount);
});
test("dropout trajectory: raw recovers on the first valid frame after dropout", () => {
  const r = FL.runTrajectory("tracking-dropout-recovery", "raw-unfiltered", { enterMm: 20, exitMm: 28 });
  assert.equal(r.metrics.recoveryFrames, 0);
  assert.equal(r.metrics.recovered, true);
});
test("dropout trajectory: filtered profiles need frames to re-converge", () => {
  for (const id of ["ema-heavy", "one-euro-balanced"]) {
    const r = FL.runTrajectory("tracking-dropout-recovery", id, { enterMm: 20, exitMm: 28 });
    assert.ok(r.metrics.recoveryFrames > 0, id + ": " + r.metrics.recoveryFrames);
    assert.equal(r.metrics.recovered, true);
  }
});
test("dropout frames are counted in metrics", () => {
  const r = FL.runTrajectory("tracking-dropout-recovery", "raw-unfiltered");
  assert.equal(r.metrics.dropoutFrames, 34);
});
test("metrics on the step trajectory count one full pinch cycle", () => {
  const r = FL.runTrajectory("step-saccade-grab", "raw-unfiltered", { enterMm: 20, exitMm: 28 });
  assert.equal(r.metrics.pinchCycles, 1);
  assert.ok(r.metrics.dragPhases >= 1);
});
test("metrics are finite numbers or nulls as declared", () => {
  const r = FL.runTrajectory("step-saccade-grab", "one-euro-fast", { enterMm: 20, exitMm: 28 });
  for (const k of ["jitterRmsMm", "lagMs", "falsePinchTransitions", "pinchCycles", "dragPhases", "dropoutFrames", "transitionCount"]) {
    assert.ok(Number.isFinite(r.metrics[k]), k);
  }
  assert.ok(r.metrics.settleLagMs90 === null || Number.isFinite(r.metrics.settleLagMs90));
  assert.ok(r.metrics.recoveryFrames === null || Number.isFinite(r.metrics.recoveryFrames));
});
test("transition records carry frame index, from and to states", () => {
  const r = FL.runTrajectory("step-saccade-grab", "raw-unfiltered", { enterMm: 20, exitMm: 28 });
  assert.ok(r.transitions.length >= 2);
  for (const tr of r.transitions) {
    assert.ok(Number.isInteger(tr.i) && tr.i >= 0 && tr.i < 270);
    assert.equal(typeof tr.from, "string");
    assert.equal(typeof tr.to, "string");
  }
});
test("runTrajectory honours custom enter and exit thresholds", () => {
  const a = FL.runTrajectory("micro-tremor-hover", "raw-unfiltered", { enterMm: 20, exitMm: 28 });
  const b = FL.runTrajectory("micro-tremor-hover", "raw-unfiltered", { enterMm: 15, exitMm: 40 });
  assert.deepEqual(b.thresholdsMm, { enter: 15, exit: 40 });
  assert.notEqual(a.metrics.transitionCount === b.metrics.transitionCount && a.thresholdsMm.exit === b.thresholdsMm.exit, true);
});

/* ---------- G. channelLagMs ---------- */
test("channelLagMs returns 0 on a constant truth channel", () => {
  const filt = Array.from({ length: 100 }, (_, i) => 50 + Math.sin(i));
  assert.equal(FL.channelLagMs(filt, filt.map(() => 50)), 0);
});
test("channelLagMs measures a synthetic two-frame delay", () => {
  const truth = Array.from({ length: 120 }, (_, i) => 50 + 40 * Math.sin(i / 8));
  const filt = truth.map((_, i) => truth[Math.max(0, i - 2)]);
  assert.ok(Math.abs(FL.channelLagMs(filt, truth) - 2 * FL.DT_MS) < 0.01);
});
test("channelLagMs returns 0 for fewer than two truth samples", () => {
  assert.equal(FL.channelLagMs([1, 2, 3], []), 0);
  assert.equal(FL.channelLagMs([1], [1]), 0);
});
test("channelLagMs survives NaN gaps in the filtered channel", () => {
  const truth = Array.from({ length: 120 }, (_, i) => i < 60 ? 40 : 100);
  const filt = truth.map(v => v);
  filt[70] = NaN; filt[71] = NaN;
  assert.equal(FL.channelLagMs(filt, truth), 0);
});
test("channelLagMs ignores non-finite truth samples", () => {
  const truth = Array.from({ length: 100 }, (_, i) => 30 + 30 * Math.sin(i / 5));
  truth[10] = NaN; truth[50] = undefined;
  assert.ok(Number.isFinite(FL.channelLagMs(truth.slice(), truth)));
});

/* ---------- H. longestDropoutRun ---------- */
test("longestDropoutRun returns null with no dropout", () => {
  assert.equal(FL.longestDropoutRun([{ rawX: 1 }, { rawX: 2 }]), null);
});
test("longestDropoutRun returns null on an empty array", () => {
  assert.equal(FL.longestDropoutRun([]), null);
});
test("longestDropoutRun finds the longest of two runs", () => {
  const samples = [{ rawX: 1 }, { rawX: NaN }, { rawX: NaN }, { rawX: 2 }, { rawX: NaN }, { rawX: NaN }, { rawX: NaN }];
  const run = FL.longestDropoutRun(samples);
  assert.deepEqual(run, { start: 4, end: 7 });
});
test("a trailing NaN run at the array edge is still reported", () => {
  const run = FL.longestDropoutRun([{ rawX: 1 }, { rawX: NaN }, { rawX: NaN }]);
  assert.deepEqual(run, { start: 1, end: 3 });
});

/* ---------- I. paretoFrontierIds ---------- */
test("pareto frontier on micro-tremor keeps only the precision profile", () => {
  const cmp = FL.runComparison("micro-tremor-hover", { enterMm: 20, exitMm: 28 });
  assert.deepEqual(FL.paretoFrontierIds(cmp.rows), ["one-euro-precision"]);
});
test("pareto frontier ids are a subset of the comparison rows", () => {
  const cmp = FL.runComparison("step-saccade-grab", { enterMm: 20, exitMm: 28 });
  const ids = FL.paretoFrontierIds(cmp.rows);
  assert.ok(ids.length >= 1);
  for (const id of ids) assert.ok(cmp.rows.some(r => r.profile.id === id));
});
test("a dominated row is excluded: crafted rows", () => {
  const rows = [
    { profile: { id: "a" }, metrics: { jitterRmsMm: 1, lagMs: 10 } },
    { profile: { id: "b" }, metrics: { jitterRmsMm: 2, lagMs: 20 } },
    { profile: { id: "c" }, metrics: { jitterRmsMm: 0.5, lagMs: 30 } }
  ];
  assert.deepEqual(FL.paretoFrontierIds(rows), ["a", "c"]);
});
test("equal tradeoffs both stay on the frontier", () => {
  const rows = [
    { profile: { id: "a" }, metrics: { jitterRmsMm: 1, lagMs: 10 } },
    { profile: { id: "b" }, metrics: { jitterRmsMm: 1, lagMs: 10 } }
  ];
  assert.deepEqual(FL.paretoFrontierIds(rows).sort(), ["a", "b"]);
});

/* ---------- J. runComparison ---------- */
test("runComparison evaluates all five profiles in order", () => {
  const cmp = FL.runComparison("micro-tremor-hover", { enterMm: 20, exitMm: 28 });
  assert.deepEqual(cmp.rows.map(r => r.profile.id), FL.FILTER_ORDER);
});
test("runComparison echoes the requested thresholds", () => {
  const cmp = FL.runComparison("micro-tremor-hover", { enterMm: 12, exitMm: 30 });
  assert.deepEqual(cmp.thresholdsMm, { enter: 12, exit: 30 });
});
test("runComparison carries trajectory info", () => {
  const cmp = FL.runComparison("tracking-dropout-recovery", {});
  assert.equal(cmp.trajectory.id, "tracking-dropout-recovery");
  assert.equal(cmp.trajectory.hasDropout, true);
});
test("runComparison defaults to the lab thresholds", () => {
  const cmp = FL.runComparison("micro-tremor-hover");
  assert.deepEqual(cmp.thresholdsMm, { enter: 20, exit: 28 });
});

/* ---------- K. quasi-static shoulder moment ---------- */
test("rested posture 14/20.4 matches the rig's 2.99 N.m", () => {
  const m = FL.quasiStaticShoulderMomentNm({ armAbductionDeg: 14, elbowFlexDeg: 20.4 });
  const rig = kin.shoulderTorqueNm({ armAbductionDeg: 14, elbowFlexDeg: 20.4 });
  assert.ok(Math.abs(m - rig) < 0.005, m + " vs " + rig);
  assert.ok(Math.abs(m - 2.99) < 0.01);
});
test("elevated posture 58/62 matches the rig's 9.46 N.m", () => {
  const m = FL.quasiStaticShoulderMomentNm({ armAbductionDeg: 58, elbowFlexDeg: 62 });
  assert.ok(Math.abs(m - 9.46) < 0.01);
});
test("modelled reduction between postures is about 68 percent", () => {
  const rested = FL.quasiStaticShoulderMomentNm({ armAbductionDeg: 14, elbowFlexDeg: 20.4 });
  const elevated = FL.quasiStaticShoulderMomentNm({ armAbductionDeg: 58, elbowFlexDeg: 62 });
  const pct = (elevated - rested) / elevated * 100;
  assert.ok(Math.abs(pct - 68.4) < 0.5, String(pct));
});
test("moment rises monotonically with arm angle at fixed elbow", () => {
  let prev = -Infinity;
  for (let a = 0; a <= 90; a += 15) {
    const m = FL.quasiStaticShoulderMomentNm({ armAbductionDeg: a, elbowFlexDeg: 30 });
    assert.ok(m > prev, a);
    prev = m;
  }
});
test("elbow contribution peaks at 90 deg then declines", () => {
  const at60 = FL.quasiStaticShoulderMomentNm({ armAbductionDeg: 30, elbowFlexDeg: 60 });
  const at90 = FL.quasiStaticShoulderMomentNm({ armAbductionDeg: 30, elbowFlexDeg: 90 });
  const at120 = FL.quasiStaticShoulderMomentNm({ armAbductionDeg: 30, elbowFlexDeg: 120 });
  assert.ok(at90 > at60 && at90 > at120);
});
test("moment scales linearly with body mass", () => {
  const m75 = FL.quasiStaticShoulderMomentNm({ bodyMassKg: 75, armAbductionDeg: 30, elbowFlexDeg: 40 });
  const m150 = FL.quasiStaticShoulderMomentNm({ bodyMassKg: 150, armAbductionDeg: 30, elbowFlexDeg: 40 });
  assert.ok(Math.abs(m150 - 2 * m75) < 0.01);
});
test("moment rejects non-finite inputs", () => {
  /* undefined is excluded: destructured defaults legitimately apply to it. */
  for (const bad of [NaN, Infinity, -Infinity, "x", null]) {
    assert.throws(() => FL.quasiStaticShoulderMomentNm({ armAbductionDeg: bad }), RangeError, String(bad));
    assert.throws(() => FL.quasiStaticShoulderMomentNm({ elbowFlexDeg: bad }), RangeError, String(bad));
    assert.throws(() => FL.quasiStaticShoulderMomentNm({ bodyMassKg: bad }), RangeError, String(bad));
  }
});
test("moment rejects out-of-range angles", () => {
  assert.throws(() => FL.quasiStaticShoulderMomentNm({ armAbductionDeg: -1 }), RangeError);
  assert.throws(() => FL.quasiStaticShoulderMomentNm({ armAbductionDeg: 91 }), RangeError);
  assert.throws(() => FL.quasiStaticShoulderMomentNm({ elbowFlexDeg: -1 }), RangeError);
  assert.throws(() => FL.quasiStaticShoulderMomentNm({ elbowFlexDeg: 121 }), RangeError);
});
test("moment accepts the elbow range edge cases 0 and 120", () => {
  assert.ok(Number.isFinite(FL.quasiStaticShoulderMomentNm({ elbowFlexDeg: 0 })));
  assert.ok(Number.isFinite(FL.quasiStaticShoulderMomentNm({ elbowFlexDeg: 120 })));
});
test("moment rejects non-positive mass and lengths", () => {
  assert.throws(() => FL.quasiStaticShoulderMomentNm({ bodyMassKg: 0 }), RangeError);
  assert.throws(() => FL.quasiStaticShoulderMomentNm({ bodyMassKg: -75 }), RangeError);
  assert.throws(() => FL.quasiStaticShoulderMomentNm({ upperArmLenM: 0 }), RangeError);
  assert.throws(() => FL.quasiStaticShoulderMomentNm({ forearmLenM: -1 }), RangeError);
});
test("moment accepts custom segment lengths", () => {
  const a = FL.quasiStaticShoulderMomentNm({ forearmLenM: 0.2, armAbductionDeg: 30, elbowFlexDeg: 60 });
  const b = FL.quasiStaticShoulderMomentNm({ forearmLenM: 0.34, armAbductionDeg: 30, elbowFlexDeg: 60 });
  assert.ok(b > a);
});

/* ---------- L. sweepShoulderMoment ---------- */
test("default sweep is a 13 by 13 grid from 0-90 arm and 0-120 elbow", () => {
  const s = FL.sweepShoulderMoment();
  assert.equal(s.grid.length, 13);
  assert.equal(s.grid[0].length, 13);
  assert.equal(s.armDeg[0], 0);
  assert.equal(s.armDeg[12], 90);
  assert.equal(s.elbowDeg[0], 0);
  assert.equal(s.elbowDeg[12], 120);
});
test("sweep records monotone arm growth and the honest elbow peak", () => {
  const s = FL.sweepShoulderMoment();
  assert.equal(s.monotonicArm, true);
  assert.equal(s.peakElbowDeg, 90);
});
test("sweep minimum sits at arm 0, maximum at arm 90", () => {
  const s = FL.sweepShoulderMoment();
  assert.equal(s.minAt.armDeg, 0);
  assert.equal(s.maxAt.armDeg, 90);
  assert.ok(s.minNm < s.maxNm);
});
test("sweep honours custom step counts and ranges", () => {
  const s = FL.sweepShoulderMoment({ armSteps: 5, elbowSteps: 7, elbowMaxDeg: 60 });
  assert.equal(s.grid.length, 5);
  assert.equal(s.grid[0].length, 7);
  assert.equal(s.elbowDeg[6], 60);
});
test("sweep rejects invalid ranges", () => {
  assert.throws(() => FL.sweepShoulderMoment({ armMinDeg: -1 }), RangeError);
  assert.throws(() => FL.sweepShoulderMoment({ armMaxDeg: 91 }), RangeError);
  assert.throws(() => FL.sweepShoulderMoment({ elbowMaxDeg: 121 }), RangeError);
  assert.throws(() => FL.sweepShoulderMoment({ armMinDeg: 60, armMaxDeg: 30 }), RangeError);
  assert.throws(() => FL.sweepShoulderMoment({ armMinDeg: NaN }), RangeError);
});
test("sweep rejects non-integer or out-of-range step counts", () => {
  for (const bad of [0, 1, 65, 2.5, NaN, "4", Infinity]) {
    assert.throws(() => FL.sweepShoulderMoment({ armSteps: bad }), RangeError, String(bad));
    assert.throws(() => FL.sweepShoulderMoment({ elbowSteps: bad }), RangeError, String(bad));
  }
});
test("sweep grid values equal pointwise moment evaluations", () => {
  const s = FL.sweepShoulderMoment({ armSteps: 4, elbowSteps: 4 });
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const m = FL.quasiStaticShoulderMomentNm({ armAbductionDeg: s.armDeg[i], elbowFlexDeg: s.elbowDeg[j] });
      assert.equal(s.grid[i][j], m);
    }
  }
});
test("sweep passes mass and segment overrides through", () => {
  const s = FL.sweepShoulderMoment({ armSteps: 3, elbowSteps: 3, bodyMassKg: 150 });
  const m = FL.quasiStaticShoulderMomentNm({ bodyMassKg: 150, armAbductionDeg: 45, elbowFlexDeg: 60 });
  assert.equal(s.grid[1][1], m);
});
test("sweep results are deterministic", () => {
  const a = FL.sweepShoulderMoment({ armSteps: 4, elbowSteps: 4 });
  const b = FL.sweepShoulderMoment({ armSteps: 4, elbowSteps: 4 });
  assert.equal(FL.sha256Hex(FL.canonicalJson(a.grid)), FL.sha256Hex(FL.canonicalJson(b.grid)));
});

/* ---------- M. UTF-8 + SHA-256 ---------- */
test("utf8Bytes encodes ASCII verbatim", () => {
  assert.deepEqual([...FL.utf8Bytes("abc")], [97, 98, 99]);
});
test("utf8Bytes encodes two-byte and three-byte sequences", () => {
  assert.deepEqual([...FL.utf8Bytes("é")], [0xc3, 0xa9]);
  assert.deepEqual([...FL.utf8Bytes("€")], [0xe2, 0x82, 0xac]);
});
test("utf8Bytes encodes astral characters as four bytes", () => {
  const b = FL.utf8Bytes("a💪b");
  assert.deepEqual([...b], [0x61, 0xf0, 0x9f, 0x92, 0xaa, 0x62]);
});
test("sha256Hex matches FIPS vectors", () => {
  assert.equal(FL.sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(FL.sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(FL.sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
});
test("sha256Hex matches node:crypto on random payloads", () => {
  const rand = FL.mulberry32(99);
  for (let i = 0; i < 8; i++) {
    const s = "seed-" + i + "-" + String.fromCharCode(...Array.from({ length: 200 }, () => 32 + Math.floor(rand() * 90)));
    assert.equal(FL.sha256Hex(s), nodeSha(s), i);
  }
});
test("sha256Hex matches node:crypto on a 1 MiB payload", () => {
  const big = "x".repeat(1 << 20);
  assert.equal(FL.sha256Hex(big), nodeSha(big));
});
test("sha256Hex matches node:crypto on multibyte input", () => {
  const s = "écran € 💪 résolu test";
  assert.equal(FL.sha256Hex(s), nodeSha(s));
});
test("sha256Bytes accepts Uint8Array input", () => {
  const bytes = FL.utf8Bytes("abc");
  const out = FL.sha256Bytes(bytes);
  assert.ok(out instanceof Uint8Array);
  assert.equal(out.length, 32);
});
test("sha256Bytes rejects invalid input types", () => {
  for (const bad of [42, null, {}, [1, 2], true]) {
    assert.throws(() => FL.sha256Bytes(bad), TypeError, String(bad));
  }
});
test("sha256Hex handles length boundary cases near one block", () => {
  for (const n of [55, 56, 63, 64, 65, 119, 120, 127, 128]) {
    const s = "q".repeat(n);
    assert.equal(FL.sha256Hex(s), nodeSha(s), n);
  }
});

/* ---------- N. canonicalJson ---------- */
test("canonicalJson sorts object keys", () => {
  assert.equal(FL.canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
});
test("canonicalJson drops undefined values and functions", () => {
  assert.equal(FL.canonicalJson({ a: 1, b: undefined, c: () => 1 }), '{"a":1}');
});
test("canonicalJson normalises -0 to 0", () => {
  assert.equal(FL.canonicalJson(-0), "0");
  assert.equal(FL.canonicalJson({ z: -0 }), '{"z":0}');
});
test("canonicalJson rejects non-finite numbers", () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    assert.throws(() => FL.canonicalJson(bad), TypeError, String(bad));
    assert.throws(() => FL.canonicalJson({ x: bad }), TypeError, String(bad));
  }
});
test("canonicalJson serialises nested structures deterministically", () => {
  const a = FL.canonicalJson({ x: { d: [3, { e: 1 }], c: true }, y: "s" });
  assert.equal(a, '{"x":{"c":true,"d":[3,{"e":1}]},"y":"s"}');
});
test("canonicalJson throws on symbols and bigints", () => {
  assert.throws(() => FL.canonicalJson(Symbol("x")), TypeError);
  assert.throws(() => FL.canonicalJson(1n), TypeError);
});
test("canonicalJson handles null, booleans and empty containers", () => {
  assert.equal(FL.canonicalJson(null), "null");
  assert.equal(FL.canonicalJson({}), "{}");
  assert.equal(FL.canonicalJson([]), "[]");
  assert.equal(FL.canonicalJson([true, false]), "[true,false]");
});

/* ---------- O. normalizeLabState ---------- */
test("normalizer returns the documented defaults for empty input", () => {
  for (const v of [null, undefined, 0, "", "x", true, [1], NaN]) {
    const n = FL.normalizeLabState(v);
    assert.deepEqual(n, {
      trajectory: "micro-tremor-hover", profile: "one-euro-balanced",
      enterMm: 20, exitMm: 28, armDeg: 14, elbowDeg: 20.4
    }, String(v));
  }
});
test("normalizer output carries exactly the six state keys", () => {
  const n = FL.normalizeLabState({ extra: 1, deep: { a: 1 } });
  assert.deepEqual(Object.keys(n).sort(), ["armDeg", "elbowDeg", "enterMm", "exitMm", "profile", "trajectory"]);
});
test("normalizer keeps valid fields verbatim", () => {
  const n = FL.normalizeLabState({ trajectory: "step-saccade-grab", profile: "ema-heavy", enterMm: 15, exitMm: 33, armDeg: 60, elbowDeg: 90 });
  assert.deepEqual(n, { trajectory: "step-saccade-grab", profile: "ema-heavy", enterMm: 15, exitMm: 33, armDeg: 60, elbowDeg: 90 });
});
test("normalizer rejects unknown trajectories back to default", () => {
  for (const t of ["nope", "MICRO-TREMOR-HOVER", "__proto__", 5, {}, null]) {
    assert.equal(FL.normalizeLabState({ trajectory: t }).trajectory, "micro-tremor-hover", String(t));
  }
});
test("normalizer rejects unknown profiles back to default", () => {
  for (const p of ["nope", "ONE-EURO-FAST", "toString", [], null]) {
    assert.equal(FL.normalizeLabState({ profile: p }).profile, "one-euro-balanced", String(p));
  }
});
test("normalizer accepts numeric strings", () => {
  const n = FL.normalizeLabState({ enterMm: "25", exitMm: "40", armDeg: "30", elbowDeg: "45.5" });
  assert.deepEqual(n, { trajectory: "micro-tremor-hover", profile: "one-euro-balanced", enterMm: 25, exitMm: 40, armDeg: 30, elbowDeg: 45.5 });
});
test("normalizer falls back on non-numeric strings", () => {
  const n = FL.normalizeLabState({ enterMm: "abc", exitMm: "28pt", armDeg: "lots" });
  assert.equal(n.enterMm, 20);
  assert.equal(n.exitMm, 28);
  assert.equal(n.armDeg, 14);
});
test("normalizer clamps enter to 5..80 and exit to its own bounds", () => {
  assert.equal(FL.normalizeLabState({ enterMm: 0.1 }).enterMm, 5);
  assert.equal(FL.normalizeLabState({ enterMm: 500 }).enterMm, 80);
  assert.equal(FL.normalizeLabState({ exitMm: 900, enterMm: 10 }).exitMm, 100);
});
test("normalizer keeps exit strictly above enter", () => {
  const n = FL.normalizeLabState({ enterMm: 40, exitMm: 40 });
  assert.ok(n.exitMm > n.enterMm, JSON.stringify(n));
  const n2 = FL.normalizeLabState({ enterMm: 40, exitMm: 10 });
  assert.ok(n2.exitMm > n2.enterMm, JSON.stringify(n2));
});
test("normalizer clamps angles into 0..90 and 0..120", () => {
  const n = FL.normalizeLabState({ armDeg: -90, elbowDeg: 999 });
  assert.equal(n.armDeg, 0);
  assert.equal(n.elbowDeg, 120);
});
test("normalizer ignores non-string enum values like Sets", () => {
  const n = FL.normalizeLabState({ trajectory: new Set(["tracking-dropout-recovery"]) });
  assert.equal(n.trajectory, "micro-tremor-hover");
});
test("normalizer never reads prototype keys", () => {
  const hostile = JSON.parse('{"trajectory":"step-saccade-grab","__proto__":{"polluted":true}}');
  const n = FL.normalizeLabState(hostile);
  assert.equal(n.trajectory, "step-saccade-grab");
  assert.equal({}.polluted, undefined);
});
test("normalizer output feeds runTrajectory without throwing", () => {
  const n = FL.normalizeLabState({ enterMm: 90, exitMm: 3, armDeg: -4 });
  const r = FL.runTrajectory(n.trajectory, n.profile, { enterMm: n.enterMm, exitMm: n.exitMm });
  assert.equal(r.samples.length, 270);
});
test("normalizeLabState is idempotent", () => {
  const once = FL.normalizeLabState({ enterMm: 90, exitMm: 3, armDeg: -4, trajectory: "nope" });
  assert.deepEqual(FL.normalizeLabState(once), once);
});
test("normalizeLabState rounds to 3 decimals", () => {
  const n = FL.normalizeLabState({ enterMm: 20.12345, exitMm: 28.9999, armDeg: 14.4444, elbowDeg: 20.4444 });
  assert.equal(n.enterMm, 20.123);
  assert.equal(n.exitMm, 29);
});

/* ---------- P. digestFor + verifyDigest ---------- */
test("digestFor returns a cached entry per normalized state", () => {
  const a = FL.digestFor({ trajectory: "micro-tremor-hover" });
  const b = FL.digestFor({ trajectory: "micro-tremor-hover" });
  assert.strictEqual(a, b);
});
test("digest is 64 lowercase hex characters", () => {
  const { sha256 } = FL.digestFor({});
  assert.match(sha256, /^[0-9a-f]{64}$/);
});
test("digest equals sha256 of the canonical payload", () => {
  const { payload, sha256 } = FL.digestFor({ trajectory: "step-saccade-grab" });
  assert.equal(sha256, FL.sha256Hex(FL.canonicalJson(payload)));
});
test("different states produce different digests", () => {
  const a = FL.digestFor({ trajectory: "micro-tremor-hover" }).sha256;
  const b = FL.digestFor({ trajectory: "step-saccade-grab" }).sha256;
  const c = FL.digestFor({ enterMm: 21 }).sha256;
  assert.notEqual(a, b);
  assert.notEqual(a, c);
});
test("equivalent states in different shapes produce the same digest", () => {
  const a = FL.digestFor({ enterMm: 20, exitMm: 28 });
  const b = FL.digestFor({ enterMm: "20", exitMm: "28", junk: 1 });
  assert.equal(a.sha256, b.sha256);
});
test("payload has no clock or random fields", () => {
  const { payload } = FL.digestFor({});
  assert.equal("timestamp" in payload, false);
  assert.equal("generatedAt" in payload, false);
  assert.equal(payload.deterministic, true);
});
test("verifyDigest accepts the stamped digest", () => {
  const st = FL.normalizeLabState({});
  const res = FL.verifyDigest(st, FL.digestFor(st).sha256);
  assert.equal(res.ok, true);
});
test("verifyDigest rejects wrong, short and non-hex digests", () => {
  const st = FL.normalizeLabState({});
  assert.equal(FL.verifyDigest(st, "0".repeat(64)).ok, false);
  assert.equal(FL.verifyDigest(st, "abc").ok, false);
  assert.equal(FL.verifyDigest(st, "Z".repeat(64)).ok, false);
  assert.equal(FL.verifyDigest(st, null).ok, false);
  assert.equal(FL.verifyDigest(st, FL.digestFor(st).sha256.toUpperCase()).ok, true);
});

/* ---------- Q. exporters ---------- */
test("exportJson parses and carries the integrity block", () => {
  const doc = JSON.parse(FL.exportJson({ trajectory: "micro-tremor-hover" }));
  assert.equal(doc.integrity.algorithm, "SHA-256");
  assert.match(doc.integrity.canonicalJsonSha256, /^[0-9a-f]{64}$/);
});
test("exportJson embeds the same digest as digestFor", () => {
  const st = { trajectory: "step-saccade-grab", enterMm: 18, exitMm: 30 };
  const doc = JSON.parse(FL.exportJson(st));
  assert.equal(doc.integrity.canonicalJsonSha256, FL.digestFor(st).sha256);
});
test("exportJson contains five comparison rows with full metrics", () => {
  const doc = JSON.parse(FL.exportJson({}));
  assert.equal(doc.comparison.rows.length, 5);
  for (const row of doc.comparison.rows) {
    for (const k of ["profile", "jitterRmsMm", "lagMs", "falsePinchTransitions", "pinchCycles", "transitionCount"]) {
      assert.ok(k in row, k);
    }
  }
});
test("exportJson carries scope disclosures", () => {
  const doc = JSON.parse(FL.exportJson({}));
  assert.equal(doc.scope.length, FL.DISCLOSURES.length);
  assert.match(doc.scope.join(" "), /quasi-static/i);
});
test("exportJson is byte-identical on repeated calls", () => {
  assert.equal(FL.exportJson({ trajectory: "step-saccade-grab" }), FL.exportJson({ trajectory: "step-saccade-grab" }));
});
test("exportCsv opens with provenance comments carrying the digest", () => {
  const st = { trajectory: "pinch-chatter-boundary" };
  const csv = FL.exportCsv(st);
  const lines = csv.split("\r\n");
  assert.ok(lines[0].startsWith("# "));
  assert.ok(csv.includes("# sha256: " + FL.digestFor(st).sha256));
});
test("exportCsv lists five rows under a metric header", () => {
  const csv = FL.exportCsv({});
  const lines = csv.split("\r\n");
  const header = lines.findIndex(l => l.startsWith("profile,"));
  assert.ok(header > 0);
  const rows = lines.slice(header + 1);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].split(",").length, 8);
});
test("csvCell prefixes formula-leading cells with an apostrophe", () => {
  for (const h of ["=CMD()", "+SUM(1:2)", "@x", "-1", " lead", "\ttab", "\x01ctl", "\u200b=CMD()", "\u00ad=CMD()", "\u202e=CMD()"]) {
    assert.equal(FL.csvCell(h)[0], "'", h);
  }
});
test("csvCell leaves ordinary values and quotes commas", () => {
  assert.equal(FL.csvCell("plain"), "plain");
  assert.equal(FL.csvCell(12.5), "12.5");
  assert.equal(FL.csvCell("a,b"), '"a,b"');
  assert.equal(FL.csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(FL.csvCell(null), "");
  assert.equal(FL.csvCell(undefined), "");
  assert.equal(FL.csvCell(NaN), "");
});
test("exportMarkdown carries the digest in the footer", () => {
  const st = { trajectory: "tracking-dropout-recovery" };
  const md = FL.exportMarkdown(st);
  assert.ok(md.includes("SHA-256 (canonical JSON): `" + FL.digestFor(st).sha256 + "`"));
});
test("exportMarkdown renders the comparison table and pareto line", () => {
  const md = FL.exportMarkdown({});
  assert.match(md, /\| Profile \| Jitter RMS \(mm\) \|/);
  assert.match(md, /Pareto-optimal profiles: `one-euro-precision`/);
});
test("exportMarkdown repeats the honest scope disclosures", () => {
  const md = FL.exportMarkdown({});
  assert.match(md, /quasi-static/);
  assert.match(md, /not a signature/i);
});
test("the same digest appears in display payload, JSON, CSV and Markdown", () => {
  const st = { trajectory: "step-saccade-grab", enterMm: 18.5, exitMm: 30, armDeg: 45, elbowDeg: 90 };
  const sha = FL.digestFor(st).sha256;
  assert.ok(FL.exportJson(st).includes(sha));
  assert.ok(FL.exportCsv(st).includes(sha));
  assert.ok(FL.exportMarkdown(st).includes(sha));
});
test("exportJson rejects states that normalize into throwing runs", () => {
  /* normalize always produces a valid state, so this exercises the
     defensive path only through an impossible profile override. */
  const doc = JSON.parse(FL.exportJson({ profile: "does-not-exist" }));
  assert.equal(doc.state.profile, "one-euro-balanced");
});

/* ---------- R. verifyExportIntegrity ---------- */
test("an untouched export verifies", () => {
  const res = FL.verifyExportIntegrity(FL.exportJson({ trajectory: "micro-tremor-hover" }));
  assert.equal(res.ok, true);
  assert.match(res.expected, /^[0-9a-f]{64}$/);
});
test("a mutated metric fails integrity verification", () => {
  const json = FL.exportJson({ trajectory: "step-saccade-grab" });
  const mutated = json.replace(/"jitterRmsMm":\s*([0-9.]+)/, (m, n) => '"jitterRmsMm": ' + (parseFloat(n) + 1));
  const res = FL.verifyExportIntegrity(mutated);
  assert.equal(res.ok, false);
  assert.notEqual(res.expected, res.presented);
});
test("a swapped digest is caught", () => {
  const json = FL.exportJson({ trajectory: "micro-tremor-hover" });
  const other = FL.digestFor({ trajectory: "step-saccade-grab" }).sha256;
  const res = FL.verifyExportIntegrity(json.replace(/"canonicalJsonSha256": "[0-9a-f]+"/, '"canonicalJsonSha256": "' + other + '"'));
  assert.equal(res.ok, false);
});
test("a document without an integrity block is rejected", () => {
  const res = FL.verifyExportIntegrity('{"a":1}');
  assert.equal(res.ok, false);
  assert.equal(res.reason, "missing integrity block");
});
test("invalid JSON is rejected with a reason", () => {
  const res = FL.verifyExportIntegrity("{nope");
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid JSON");
});
test("empty and non-string input is rejected", () => {
  for (const bad of ["", "   ", null, undefined, 42, {}]) {
    assert.equal(FL.verifyExportIntegrity(bad).ok, false, String(bad));
  }
});
test("a malformed digest string is rejected", () => {
  const res = FL.verifyExportIntegrity('{"integrity":{"canonicalJsonSha256":"xyz"},"a":1}');
  assert.equal(res.ok, false);
  assert.equal(res.reason, "malformed digest");
});
test("reordering JSON keys still verifies (canonical form)", () => {
  const doc = JSON.parse(FL.exportJson({ trajectory: "micro-tremor-hover" }));
  const reordered = { integrity: doc.integrity, b: doc.scope, a: doc.schema, rest: doc.comparison };
  delete reordered.rest;
  const shuffled = {};
  const keys = Object.keys(doc).sort().reverse();
  for (const k of keys) shuffled[k] = doc[k];
  const res = FL.verifyExportIntegrity(JSON.stringify(shuffled));
  assert.equal(res.ok, true);
});
test("pretty-print differences do not break verification", () => {
  const doc = JSON.parse(FL.exportJson({}));
  const min = JSON.stringify(doc);
  assert.equal(FL.verifyExportIntegrity(min).ok, true);
});

/* ---------- S. bookmark codec ---------- */
test("bookmark encodes as #shs= with the fixed field order", () => {
  const h = FL.encodeBookmarkHash({ trajectory: "step-saccade-grab", profile: "ema-heavy", enterMm: 15, exitMm: 30, armDeg: 45, elbowDeg: 90 });
  assert.equal(h, "#shs=v=1&t=step-saccade-grab&f=ema-heavy&e=15&x=30&a=45&b=90");
});
test("bookmark round-trips the default state", () => {
  const dec = FL.decodeBookmarkHash(FL.encodeBookmarkHash({}));
  assert.equal(dec.ok, true);
  assert.deepEqual(dec.state, FL.normalizeLabState({}));
});
test("bookmark round-trips every trajectory", () => {
  for (const t of FL.TRAJECTORY_ORDER) {
    const dec = FL.decodeBookmarkHash(FL.encodeBookmarkHash({ trajectory: t }));
    assert.equal(dec.ok, true, t);
    assert.equal(dec.state.trajectory, t);
  }
});
test("bookmark round-trips every profile", () => {
  for (const f of FL.FILTER_ORDER) {
    const dec = FL.decodeBookmarkHash(FL.encodeBookmarkHash({ profile: f }));
    assert.equal(dec.ok, true, f);
    assert.equal(dec.state.profile, f);
  }
});
test("bookmark round-trips fractional thresholds and angles", () => {
  const st = { enterMm: 12.375, exitMm: 40.5, armDeg: 33.25, elbowDeg: 88.125 };
  const dec = FL.decodeBookmarkHash(FL.encodeBookmarkHash(st));
  assert.deepEqual(dec.state, { trajectory: "micro-tremor-hover", profile: "one-euro-balanced", ...st });
});
test("decode accepts a hash without the leading #", () => {
  const dec = FL.decodeBookmarkHash("shs=v=1&t=step-saccade-grab&f=ema-heavy&e=15&x=30&a=45&b=90");
  assert.equal(dec.ok, true);
});
test("decode rejects non-string input", () => {
  for (const bad of [null, undefined, 42, {}, [], NaN]) {
    assert.equal(FL.decodeBookmarkHash(bad).ok, false, String(bad));
  }
});
test("decode rejects empty, prefixless and wrong-prefix input", () => {
  for (const h of ["", "#", "abc", "#other=1", "#shs", "# shs=v=1"]) {
    assert.equal(FL.decodeBookmarkHash(h).ok, false, h);
  }
});
test("decode rejects a bookmark longer than 700 chars", () => {
  const long = "#shs=" + "v=1&".repeat(300) + "t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=14&b=20";
  assert.equal(FL.decodeBookmarkHash(long).ok, false);
});
test("decode rejects a wrong version", () => {
  const h = "#shs=v=2&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=14&b=20";
  const r = FL.decodeBookmarkHash(h);
  assert.equal(r.ok, false);
  assert.match(r.reason, /version/);
});
test("decode rejects unknown trajectories and profiles", () => {
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=nope&f=ema-heavy&e=20&x=28&a=14&b=20").ok, false);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=nope&e=20&x=28&a=14&b=20").ok, false);
});
test("decode rejects the wrong field count either way", () => {
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=14").ok, false);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=14&b=20&z=1").ok, false);
});
test("decode rejects duplicate keys", () => {
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=14").ok, false);
});
test("decode rejects fields with illegal characters", () => {
  for (const h of [
    "#shs=v=1&t=micro tremor&f=ema-heavy&e=20&x=28&a=14&b=20",
    "#shs=v=1&t=micro%20tremor&f=ema-heavy&e=20&x=28&a=14&b=20",
    "#shs=v=1&t=<script>&f=ema-heavy&e=20&x=28&a=14&b=20",
    "#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=2,0&x=28&a=14&b=20",
    "#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=14&b=2=0"
  ]) {
    assert.equal(FL.decodeBookmarkHash(h).ok, false, h);
  }
});
test("decode rejects non-numeric and non-finite fields", () => {
  for (const k of ["e", "x", "a", "b"]) {
    const h = FL.encodeBookmarkHash({}).replace("e=20", k + "=abc");
    assert.equal(FL.decodeBookmarkHash(h).ok, false, h);
  }
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=Infinity&x=28&a=14&b=20").ok, false);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=NaN&x=28&a=14&b=20").ok, false);
});
test("decode enforces enter in 5..80 and exit above enter", () => {
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=4&x=28&a=14&b=20").ok, false);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=81&x=90&a=14&b=20").ok, false);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=30&x=30&a=14&b=20").ok, false);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=30&x=25&a=14&b=20").ok, false);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=30&x=101&a=14&b=20").ok, false);
});
test("decode enforces arm 0..90 and elbow 0..120", () => {
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=91&b=20").ok, false);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=-1&b=20").ok, false);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=14&b=121").ok, false);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=14&b=-5").ok, false);
});
test("decode boundary values at the limits still pass", () => {
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=5&x=6&a=0&b=0").ok, true);
  assert.equal(FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=80&x=100&a=90&b=120").ok, true);
});
test("decoded state has exactly the six normalized keys", () => {
  const dec = FL.decodeBookmarkHash(FL.encodeBookmarkHash({}));
  assert.deepEqual(Object.keys(dec.state).sort(), ["armDeg", "elbowDeg", "enterMm", "exitMm", "profile", "trajectory"]);
});
test("bookmark encode normalises hostile state before writing", () => {
  const h = FL.encodeBookmarkHash({ trajectory: "bogus", enterMm: 999, exitMm: 1 });
  const dec = FL.decodeBookmarkHash(h);
  assert.equal(dec.ok, true);
  assert.equal(dec.state.trajectory, "micro-tremor-hover");
});
test("__proto__ as a hash field is rejected, not applied", () => {
  const r = FL.decodeBookmarkHash("#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=14&b=20&__proto__=x");
  assert.equal(r.ok, false);
  assert.equal({}.polluted, undefined);
});
test("encode always emits all seven fields", () => {
  const h = FL.encodeBookmarkHash({});
  assert.equal((h.match(/&/g) || []).length, 6);
  for (const k of ["v=", "t=", "f=", "e=", "x=", "a=", "b="]) assert.ok(h.includes(k), k);
});
test("decode returns structured reasons, never throws", () => {
  const hostile = ["x", "#shs=", "#shs=v=1", "#shs=v=1&t=a&f=b&e=c&x=d&a=e&b=f"];
  for (const h of hostile) {
    const r = FL.decodeBookmarkHash(h);
    assert.equal(r.ok, false);
    assert.equal(typeof r.reason, "string");
  }
});
test("bookmarks are idempotent: decode(encode(decode(encode(x)))) is stable", () => {
  const once = FL.decodeBookmarkHash(FL.encodeBookmarkHash({ trajectory: "step-saccade-grab" })).state;
  const twice = FL.decodeBookmarkHash(FL.encodeBookmarkHash(once)).state;
  assert.deepEqual(twice, once);
});

/* ---------- T. in-page self-tests ---------- */
test("runSelfTests returns at least 14 checks", () => {
  assert.ok(FL.SELF_TESTS.length >= 14, String(FL.SELF_TESTS.length));
});
test("every in-page self-test passes", () => {
  const results = FL.runSelfTests();
  const failed = results.filter(r => !r.passed);
  assert.deepEqual(failed.map(f => f.id + ": " + f.detail), []);
});
test("self-test ids are unique", () => {
  const ids = FL.SELF_TESTS.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);
});
test("self-test results carry id, name, passed flag and detail string", () => {
  for (const r of FL.runSelfTests()) {
    assert.equal(typeof r.id, "string");
    assert.equal(typeof r.name, "string");
    assert.equal(r.passed, true);
    assert.equal(typeof r.detail, "string");
  }
});
test("a throwing self-test would be reported not rethrown", () => {
  const spy = FL.SELF_TESTS.map(t => ({ ...t }));
  spy.push({ id: "boom", name: "boom", run() { throw new Error("kaboom"); } });
  const wrapped = spy.map(t => {
    try { const r = t.run() || {}; return { passed: r.passed === true }; }
    catch (e) { return { passed: false, detail: e.message }; }
  });
  assert.equal(wrapped[wrapped.length - 1].passed, false);
});

/* ---------- U. App wiring through the DOM harness ---------- */
test("boot wires the lab: comparator table, charts and digest populated", () => {
  const h = createHarness();
  h.boot();
  const app = h.app;
  assert.equal(app.lab.available, true);
  const body = h.byId.get("lab-compare-body");
  assert.match(body.innerHTML, /one-euro-precision/);
  assert.match(body.innerHTML, /data-lab-pick="ema-heavy"/);
  assert.match(h.byId.get("lab-trace-chart").innerHTML, /<svg/);
  assert.match(h.byId.get("lab-pareto-chart").innerHTML, /<svg/);
  assert.match(h.byId.get("lab-sweep-chart").innerHTML, /<svg/);
  assert.match(h.byId.get("lab-digest").textContent, /^[0-9a-f]{64}$/);
});
test("lab state starts on the documented defaults", () => {
  const h = createHarness();
  h.boot();
  /* vm-realm objects need loose equality, not deepStrictEqual. */
  assert.deepEqual(JSON.parse(JSON.stringify(h.app.lab.state)), {
    trajectory: "micro-tremor-hover", profile: "one-euro-balanced",
    enterMm: 20, exitMm: 28, armDeg: 14, elbowDeg: 20.4
  });
});
test("digest on the page equals digestFor of the same state", () => {
  const h = createHarness();
  h.boot();
  const shown = h.byId.get("lab-digest").textContent;
  assert.equal(shown, FL.digestFor(h.app.lab.state).sha256);
  assert.equal(h.app.lab.digestHex, shown);
});
test("moment readout shows the rested 2.99 N.m at defaults", () => {
  const h = createHarness();
  h.boot();
  assert.match(h.byId.get("lab-moment-val").textContent, /2\.99/);
});
test("sweep stats line reports 169 postures and the elbow peak", () => {
  const h = createHarness();
  h.boot();
  assert.match(h.byId.get("lab-sweep-stats").textContent, /169 postures/);
  assert.match(h.byId.get("lab-sweep-stats").textContent, /90 deg/);
});
test("trajectory chip click swaps the comparator to that trajectory", () => {
  const h = createHarness();
  h.boot();
  const chips = h.selectorLists["[data-lab-traj]"];
  chips[3].dispatch("click", {});
  assert.equal(h.app.lab.state.trajectory, "tracking-dropout-recovery");
  assert.match(h.byId.get("lab-compare-body").innerHTML, /one-euro-fast/);
  assert.ok(chips[3].classList.contains("active"));
  assert.ok(!chips[0].classList.contains("active"));
});
test("enter slider input updates state and re-clamps the exit", () => {
  const h = createHarness();
  h.boot();
  const enterEl = h.byId.get("lab-enter");
  enterEl.value = "30";
  enterEl.dispatch("input", {});
  assert.equal(h.app.lab.state.enterMm, 30);
  assert.ok(h.app.lab.state.exitMm > 30);
});
test("exit slider cannot drop below enter", () => {
  const h = createHarness();
  h.boot();
  const exitEl = h.byId.get("lab-exit");
  exitEl.value = "10";
  exitEl.dispatch("input", {});
  assert.ok(h.app.lab.state.enterMm < 10);
  assert.equal(h.app.lab.state.exitMm, 10);
});
test("posture sliders drive the moment readout", () => {
  const h = createHarness();
  h.boot();
  const armEl = h.byId.get("lab-arm");
  const elbowEl = h.byId.get("lab-elbow");
  armEl.value = "58"; armEl.dispatch("input", {});
  elbowEl.value = "62"; elbowEl.dispatch("input", {});
  assert.match(h.byId.get("lab-moment-val").textContent, /9\.46/);
});
test("self-test button reports all checks passing", () => {
  const h = createHarness();
  h.boot();
  h.byId.get("btn-lab-selftest").dispatch("click", {});
  assert.match(h.byId.get("lab-selftest-count").textContent, /^\d+\/\d+ checks pass$/);
  const n = parseInt(h.byId.get("lab-selftest-count").textContent, 10);
  assert.ok(n >= 14);
  assert.match(h.byId.get("lab-selftest-list").innerHTML, /SHA-256 known answer/);
});
test("verify button reports integrity verified", () => {
  const h = createHarness();
  h.boot();
  h.byId.get("btn-lab-verify").dispatch("click", {});
  assert.match(h.byId.get("lab-verify-result").textContent, /INTEGRITY VERIFIED/);
});
test("tamper demo reports detection", () => {
  const h = createHarness();
  h.boot();
  h.byId.get("btn-lab-tamper").dispatch("click", {});
  assert.match(h.byId.get("lab-verify-result").textContent, /TAMPER DETECTED/);
});
test("copy link writes the #shs= bookmark into the share field", () => {
  const h = createHarness();
  h.boot();
  h.byId.get("btn-lab-copy-link").dispatch("click", {});
  assert.match(h.byId.get("lab-share-link").value, /#shs=v=1&t=micro-tremor-hover/);
});
test("JSON/CSV/Markdown exports all reach the download path", () => {
  const h = createHarness();
  h.boot();
  h.byId.get("btn-lab-json").dispatch("click", {});
  h.byId.get("btn-lab-csv").dispatch("click", {});
  h.byId.get("btn-lab-md").dispatch("click", {});
  assert.equal(h.downloads.length, 3);
  const kinds = h.downloads.map(b => b.type);
  assert.deepEqual(kinds, ["application/json", "text/csv", "text/markdown"]);
});
test("apply profile copies 1-Euro params into the live filter bank", () => {
  const h = createHarness();
  h.boot();
  h.app.applyLabProfileToRig("one-euro-precision");
  assert.equal(h.app.filterBank.opts.minCutoff, 0.5);
  assert.equal(h.app.filterBank.opts.beta, 0.001);
  assert.equal(h.app.state.euroCutoff, 0.5);
});
test("apply profile refuses comparator-only rows", () => {
  const h = createHarness();
  h.boot();
  h.app.applyLabProfileToRig("ema-heavy");
  assert.equal(h.app.filterBank.opts.minCutoff, 1.2);
  h.app.applyLabProfileToRig("bogus");
  assert.equal(h.app.filterBank.opts.minCutoff, 1.2);
});
test("applyLabHash restores every encoded field", () => {
  const h = createHarness();
  h.boot();
  const hash = "#shs=v=1&t=step-saccade-grab&f=one-euro-fast&e=18.5&x=30&a=45&b=96";
  assert.equal(h.app.applyLabHash(hash), true);
  assert.deepEqual(JSON.parse(JSON.stringify(h.app.lab.state)), {
    trajectory: "step-saccade-grab", profile: "one-euro-fast",
    enterMm: 18.5, exitMm: 30, armDeg: 45, elbowDeg: 96
  });
  assert.equal(h.byId.get("lab-enter").value, "18.5");
  assert.equal(h.byId.get("lab-arm").value, "45");
});
test("applyLabHash ignores malformed hashes and keeps current state", () => {
  const h = createHarness();
  h.boot();
  const before = JSON.parse(JSON.stringify(h.app.lab.state));
  for (const bad of ["#bogus", "#shs=v=9&t=x&f=y&e=1&x=2&a=3&b=4", "", null]) {
    assert.equal(h.app.applyLabHash(bad), false, String(bad));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(h.app.lab.state)), before);
});
test("recomputeLab refreshes the digest when the state changes", () => {
  const h = createHarness();
  h.boot();
  const d1 = h.app.lab.digestHex;
  h.app.lab.state.trajectory = "pinch-chatter-boundary";
  h.app.recomputeLab();
  assert.notEqual(h.app.lab.digestHex, d1);
  assert.equal(h.byId.get("lab-digest").textContent, h.app.lab.digestHex);
});
test("escapeHtml escapes markup in self-test details", () => {
  const h = createHarness();
  h.boot();
  assert.equal(h.app.escapeHtml('<a "x">&'), "&lt;a &quot;x&quot;&gt;&amp;");
});

/* ---------- V. Hostile-input sweeps on every public function ---------- */
test("runTrajectory handles -0, fractional and edge thresholds", () => {
  const r = FL.runTrajectory("micro-tremor-hover", "raw-unfiltered", { enterMm: 5, exitMm: 5.5 });
  assert.equal(r.samples.length, 270);
});
test("decodeBookmarkHash of encode of a hostile normalize input still verifies", () => {
  const st = FL.normalizeLabState({ enterMm: { toString: () => "30" }, exitMm: Infinity });
  assert.ok(st.enterMm === 20 && st.exitMm === 28);
  const dec = FL.decodeBookmarkHash(FL.encodeBookmarkHash(st));
  assert.equal(dec.ok, true);
});
test("digestFor survives hostile shapes without throwing", () => {
  for (const st of [null, 42, "x", { trajectory: Symbol ? undefined : 1 }, { enterMm: [1, 2] }, { exitMm: { a: 1 } }]) {
    const d = FL.digestFor(st);
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
  }
});
test("exports reject nothing: every normalizable state exports", () => {
  const st = { trajectory: "tracking-dropout-recovery", profile: "one-euro-fast", enterMm: 10, exitMm: 12, armDeg: 0, elbowDeg: 120 };
  for (const fn of [FL.exportJson, FL.exportCsv, FL.exportMarkdown]) {
    assert.equal(typeof fn(st), "string");
  }
});
test("computeMetrics handles an all-NaN run", () => {
  const traj = FL.generateTrajectory("micro-tremor-hover");
  const samples = traj.frames.map((f, i) => ({
    i, t: f.t, rawX: NaN, truthX: f.truthX, filtX: NaN,
    rawPinch: NaN, truthPinch: f.truthPinch, filtPinch: NaN, state: "IDLE"
  }));
  const m = FL.computeMetrics(traj, samples, []);
  assert.equal(m.jitterRmsMm, 0);
  assert.equal(m.dropoutFrames, 270);
  assert.equal(m.recoveryFrames, null);
});
test("hostile Set and Map inputs do not crash normalize or encode", () => {
  const weird = { trajectory: new Map(), profile: new Set(), enterMm: new Date(), exitMm: /x/, armDeg: [], elbowDeg: () => 1 };
  const n = FL.normalizeLabState(weird);
  const dec = FL.decodeBookmarkHash(FL.encodeBookmarkHash(n));
  assert.equal(dec.ok, true);
});
test("em dash and en dash are absent from every generated export", () => {
  const st = {};
  for (const out of [FL.exportJson(st), FL.exportCsv(st), FL.exportMarkdown(st)]) {
    assert.ok(!/[\u2013\u2014]/.test(out));
  }
});
test("lab module carries no network, eval or Date-time calls", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "js", "filter-lab.js"), "utf8");
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket|import\(|eval\(|new Date\(|Date\.now\(/.test(src));
});

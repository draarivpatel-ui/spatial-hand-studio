"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const T = require(path.join(__dirname, "..", "js", "hand-telemetry.js"));

const P = (x, y, z) => ({ x, y, z });

test("distanceM is Euclidean and rejects invalid points", () => {
  assert.equal(T.distanceM(P(0, 0, 0), P(3, 4, 0)), 5);
  assert.equal(T.distanceM(P(0, 0, 0), P(0, 0, 0)), 0);
  assert.ok(Number.isNaN(T.distanceM(null, P(0, 0, 0))));
  assert.ok(Number.isNaN(T.distanceM(P(NaN, 0, 0), P(0, 0, 0))));
});

test("SampleGate validates options and rejects bad samples without mutation", () => {
  assert.throws(() => new T.SampleGate({ maxSpeedMPerS: 0 }), RangeError);
  assert.throws(() => new T.SampleGate({ minDtS: -1 }), RangeError);
  const gate = new T.SampleGate({ maxSpeedMPerS: 2, minDtS: 0.01 });
  assert.equal(gate.accept(P(0, 0, 0), 0), true);
  assert.equal(gate.last.p.x, 0);
  assert.equal(gate.accept(P(0, 0, 0), 0), false, "repeated timestamp");
  assert.equal(gate.accept(P(0, 0, 0), 5), false, "dt below minDt");
  assert.equal(gate.accept(P(10, 0, 0), 1000), false, "teleport above max speed");
  assert.equal(gate.last.p.x, 0, "rejected samples never replace last");
  assert.equal(gate.accept(P(0.1, 0, 0), 1000), true);
  assert.equal(gate.last.p.x, 0.1);
  assert.equal(gate.accepted, 2);
  assert.equal(gate.rejected, 3);
  assert.equal(gate.accept(P(NaN, 0, 0), 1100), false);
  assert.equal(gate.accept(P(0.1, 0, 0), Infinity), false);
  gate.reset();
  assert.equal(gate.last, null);
  assert.equal(gate.accepted, 2, "reset clears last sample only");
  gate.resetCounters();
  assert.equal(gate.rejected, 0);
  assert.equal(gate.accepted, 0);
});

test("JointKinematics computes SI velocity and acceleration", () => {
  assert.throws(() => new T.JointKinematics({ maxHistory: 2 }), RangeError);
  assert.throws(() => new T.JointKinematics({ maxHistory: 3.5 }), RangeError);
  const k = new T.JointKinematics({ maxHistory: 4 });
  assert.equal(k.push(P(0, 0, 0), 0), null);
  assert.equal(k.acceleration(), 0);
  assert.equal(k.push(P(0, 0, 0), NaN), null);
  const s2 = k.push(P(1, 0, 0), 100);
  assert.equal(s2.velocity.x, 10);
  assert.equal(s2.speed, 10);
  assert.equal(k.acceleration(), 0);
  const s3 = k.push(P(3, 0, 0), 200);
  assert.equal(s3.velocity.x, 20);
  assert.equal(k.acceleration(), 100);
  const s4 = k.push(P(6, 0, 0), 300);
  assert.ok(Math.abs(s4.velocity.x - 30) < 1e-9);
  assert.ok(Math.abs(k.acceleration() - 100) < 1e-9);
  assert.equal(k.history.length, 4, "history is capped");
  assert.equal(k.push(P(7, 0, 0), 300), null, "backward timestamps are ignored");
  k.reset();
  assert.equal(k.history.length, 0);
});

test("rmsHighPass is zero for a constant signal and positive for noise", () => {
  assert.throws(() => T.rmsHighPass(null), RangeError);
  assert.throws(() => T.rmsHighPass([1], { alpha: 1 }), RangeError);
  assert.throws(() => T.rmsHighPass([1], { alpha: 0 }), RangeError);
  assert.equal(T.rmsHighPass([]), 0);
  assert.equal(T.rmsHighPass([NaN, Infinity]), 0);
  const flat = new Array(50).fill(20);
  assert.equal(T.rmsHighPass(flat), 0);
  const noisy = Array.from({ length: 50 }, (_, i) => 20 + (i % 2 ? 1 : -1));
  assert.ok(T.rmsHighPass(noisy) > 0);
  assert.ok(T.rmsHighPass(noisy) < 1);
  assert.equal(T.rmsHighPass([5, NaN, 5]), 0, "nonfinite entries are dropped");
});

test("pathEfficiency is 1 for a straight path and clamps to [0,1]", () => {
  assert.equal(T.pathEfficiency([]), 1);
  assert.equal(T.pathEfficiency([P(0, 0, 0)]), 1);
  assert.equal(T.pathEfficiency([P(0, 0, 0), P(0, 0, 0)]), 1);
  assert.equal(T.pathEfficiency([P(0, 0, 0), P(1, 0, 0), P(2, 0, 0)]), 1);
  const outAndBack = [P(0, 0, 0), P(1, 0, 0), P(0, 0, 0)];
  assert.equal(T.pathEfficiency(outAndBack), 0);
  const dogleg = [P(0, 0, 0), P(1, 0, 0), P(1, 1, 0)];
  assert.ok(Math.abs(T.pathEfficiency(dogleg) - Math.SQRT1_2) < 1e-12);
  assert.throws(() => T.pathEfficiency([P(0, 0, 0), P(NaN, 0, 0)]), RangeError);
});

test("comfort cone matches dot-product geometry with a +Y axis", () => {
  assert.throws(() => T.insideComfortCone(P(0, 1, 0), { halfAngleDeg: 0 }), RangeError);
  assert.throws(() => T.insideComfortCone(P(0, 1, 0), { halfAngleDeg: 90 }), RangeError);
  assert.throws(() => T.insideComfortCone(null), RangeError);
  assert.equal(T.insideComfortCone(P(0, 0, 0)), true);
  assert.equal(T.insideComfortCone(P(0, 1, 0)), true);
  assert.equal(T.insideComfortCone(P(0, -1, 0)), false);
  assert.equal(T.insideComfortCone(P(1, 0, 0)), false);
  assert.equal(T.insideComfortCone(P(0, 1, 0.5), { halfAngleDeg: 45 }), true);
  assert.equal(T.insideComfortCone(P(0, 1, 1.001), { halfAngleDeg: 45 }), false);
  assert.equal(T.insideComfortCone(P(0, 1, 1), { halfAngleDeg: 30 }), false);
  assert.equal(T.insideComfortCone(P(0, 1, 0.5), { halfAngleDeg: 30 }), true, "26.6 deg is inside a 30 deg cone");
  assert.equal(T.insideComfortCone(P(0, 1, 0), { halfAngleDeg: 30 }), true);
  assert.equal(T.insideComfortCone(P(0, 0, 0), { halfAngleDeg: 30 }), true);
  assert.equal(T.coneDeviationDeg(P(0, 1, 0)), 0);
  assert.ok(Math.abs(T.coneDeviationDeg(P(0, 1, 1)) - 45) < 1e-9);
  assert.ok(Math.abs(T.coneDeviationDeg(P(0, -1, 0)) - 180) < 1e-9);
  assert.equal(T.coneViolationDeg(P(0, 0, 0)), 0);
  assert.equal(T.coneViolationDeg, T.coneDeviationDeg);
});

test("summarizeTransitions sorts samples and counts false starts", () => {
  assert.throws(() => T.summarizeTransitions("x"), RangeError);
  const s = T.summarizeTransitions([
    { state: "DRAGGING", t: 200 },
    { state: "PINCH_START", t: 100 },
    { state: "IDLE", t: 0 },
    { state: "BAD", t: NaN }
  ]);
  assert.equal(s.samples, 3);
  assert.equal(s.draggingSamples, 1);
  assert.equal(s.falseStarts, 0);
  assert.equal(s.dwellMs.IDLE, 100);
  assert.equal(s.dwellMs.PINCH_START, 100);
  assert.equal(T.summarizeTransitions([{ state: "PINCH_START", t: 0 }]).falseStarts, 1);
  const aborted = T.summarizeTransitions([
    { state: "PINCH_START", t: 0 },
    { state: "RELEASE", t: 16 }
  ]);
  assert.equal(aborted.falseStarts, 1);
});

test("meanAndSampleStdDev uses n-1 and ignores nonfinite values", () => {
  const r = T.meanAndSampleStdDev([2, 4, 4, 4, 5, 5, 7, 9, NaN]);
  assert.equal(r.mean, 5);
  assert.equal(r.count, 8);
  assert.equal(r.min, 2);
  assert.equal(r.max, 9);
  assert.ok(Math.abs(r.stdDev - Math.sqrt(32 / 7)) < 1e-12);
  assert.deepEqual(T.meanAndSampleStdDev([]), { mean: 0, stdDev: 0, count: 0, min: 0, max: 0 });
});

test("buildSessionReport derives every field from an unsorted frame stream", () => {
  assert.throws(() => T.buildSessionReport(null), RangeError);
  assert.throws(() => T.buildSessionReport([], { halfAngleDeg: 90 }), RangeError);
  const frames = [
    { t: 200, pinchMm: 12, pinchState: "PINCH_START", wrist: P(0, 0.1, 0), reach: P(0, 1, 0) },
    { t: 0, pinchMm: 52, pinchState: "IDLE", wrist: P(0, 0, 0), reach: P(0, 1, 0) },
    { t: 100, pinchMm: 24, pinchState: "HOVER", wrist: P(0.1, 0.05, 0), reach: P(5, 1, 0) },
    { t: 300, pinchMm: 12, pinchState: "DRAGGING", wrist: P(0, 0.15, 0), reach: P(0, -1, 0) },
    { t: NaN, pinchMm: 999 },
    null
  ];
  const r = T.buildSessionReport(frames, { source: "pinch" });
  assert.equal(r.source, "pinch");
  assert.equal(r.frameCount, 4);
  assert.equal(r.durationMs, 300);
  assert.equal(r.pinch.samples, 4);
  assert.equal(r.pinch.meanMm, 25);
  assert.equal(r.pinch.minMm, 12);
  assert.equal(r.pinch.maxMm, 52);
  assert.ok(r.pinch.stdDevMm > 0);
  assert.ok(r.pinch.highPassRmsMm > 0);
  assert.equal(r.wrist.samples, 4);
  assert.equal(r.wrist.gateAccepted, 4);
  assert.equal(r.wrist.gateRejected, 0);
  assert.ok(r.wrist.pathEfficiency >= 0 && r.wrist.pathEfficiency <= 1);
  assert.equal(r.comfortCone.halfAngleDeg, 30);
  assert.equal(r.comfortCone.violations, 2);
  assert.equal(r.comfortCone.maxDeviationDeg, 180);
  assert.equal(r.pinchState.samples, 4);
  assert.equal(r.pinchState.falseStarts, 0);
  assert.match(r.note, /supplied frame stream only/i);
});

test("buildSessionReport handles empty and partial frames without invented values", () => {
  const empty = T.buildSessionReport([]);
  assert.equal(empty.frameCount, 0);
  assert.equal(empty.durationMs, 0);
  assert.equal(empty.pinch.samples, 0);
  assert.equal(empty.pinch.meanMm, 0);
  assert.equal(empty.pinch.highPassRmsMm, 0);
  assert.equal(empty.comfortCone.violations, 0);
  assert.equal(empty.comfortCone.maxDeviationDeg, 0);
  assert.equal(empty.wrist.pathEfficiency, 1);
  const one = T.buildSessionReport([{ t: 5, pinchMm: 20, pinchState: "IDLE" }]);
  assert.equal(one.frameCount, 1);
  assert.equal(one.pinch.stdDevMm, 0);
  assert.equal(one.wrist.samples, 0);
  assert.equal(one.pinchState.dwellMs.IDLE, 0);
  const malformed = T.buildSessionReport([
    { t: 0, pinchMm: NaN, wrist: P(0, 0, 0), reach: null },
    { t: 16, pinchMm: Infinity, wrist: null, reach: P(0, 1, 0) }
  ]);
  assert.equal(malformed.frameCount, 2);
  assert.equal(malformed.pinch.samples, 0);
  assert.equal(malformed.wrist.samples, 1);
  assert.equal(malformed.comfortCone.violations, 0);
});

test("CSV export has stable columns, sorted rows, escaped quotes and no NaN", () => {
  assert.throws(() => T.exportFramesCsv(null), RangeError);
  assert.equal(T.CSV_COLUMNS.length, 10);
  assert.deepEqual(T.CSV_COLUMNS.slice(0, 3), ["t_ms", "source", "pinch_mm"]);
  const csv = T.exportFramesCsv([
    { t: 100, pinchMm: 12, pinchState: "DRAGGING", wrist: P(0.1, 0.2, 0.3), reach: P(0, 1, 0) },
    { t: 0, pinchMm: NaN, pinchState: "IDLE", wrist: null, reach: null },
    { t: NaN }
  ], { source: 'preset, "pinch"' });
  const lines = csv.split("\r\n");
  assert.equal(lines[0], T.CSV_COLUMNS.join(","));
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^0,"preset, ""pinch""",,IDLE,,,,,,$/);
  assert.match(lines[2], /^100,"preset, ""pinch""",12,DRAGGING,0\.1,0\.2,0\.3,0,1,0$/);
  assert.ok(!csv.includes("NaN"));
  assert.ok(!csv.includes("Infinity"));
  assert.ok(!csv.includes("undefined"));
});

test("CSV export is deterministic for repeated calls", () => {
  const frames = [{ t: 1, pinchMm: 20, pinchState: "HOVER", wrist: P(0, 0, 0), reach: P(0, 1, 0) }];
  assert.equal(T.exportFramesCsv(frames), T.exportFramesCsv(frames));
});


test("session reports and CSV preserve per-frame sources through preset changes", () => {
  const frames = [{ t: 0, source: "pinch", pinchMm: 12 }, { t: 20, source: "xr-hand", pinchMm: 13 }];
  const r = T.buildSessionReport(frames, { source: "mouse" });
  assert.equal(r.source, "mixed");
  assert.deepEqual(r.sources, ["pinch", "xr-hand"]);
  const csv = T.exportFramesCsv(frames, { source: "mouse" });
  assert.match(csv, /0,pinch,12/);
  assert.match(csv, /20,xr-hand,13/);
});

test("rejected teleports do not distort the gated wrist path", () => {
  const r = T.buildSessionReport([
    { t: 0, wrist: P(0, 0, 0) },
    { t: 10, wrist: P(100, 100, 0) },
    { t: 100, wrist: P(0.1, 0, 0) }
  ]);
  assert.equal(r.wrist.gateAccepted, 2);
  assert.equal(r.wrist.gateRejected, 1);
  assert.equal(r.wrist.pathEfficiency, 1);
});

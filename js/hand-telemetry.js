/* =============================================================
   hand-telemetry.js - SpatialHand Studio signal diagnostics.
   Pure, dependency-free kinematic descriptors computed from joint
   samples supplied by the caller. Every value is derived from that
   stream; no measured human performance is claimed.
   ============================================================= */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.HandTelemetry = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const EPS = 1e-9;
  const DEFAULT_HALF_ANGLE_DEG = 30;

  function finite(v) { return typeof v === "number" && Number.isFinite(v); }
  function finitePoint(p) {
    return !!p && finite(p.x) && finite(p.y) && finite(p.z);
  }
  function vec(p) {
    return finitePoint(p) ? { x: p.x, y: p.y, z: p.z } : null;
  }

  function distanceM(a, b) {
    const p = vec(a), q = vec(b);
    if (!p || !q) return NaN;
    return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
  }
  function magnitude(p) { return Math.hypot(p.x, p.y, p.z); }

  /* ---------- Robust sample gate ----------
     Rejects nonfinite positions, nonfinite or non-increasing timestamps,
     tiny dt values and implausible teleport jumps. A rejected sample
     never mutates the history. `accepted` and `rejected` are cumulative
     session counters; reset() clears only the last sample. */
  class SampleGate {
    constructor({ maxSpeedMPerS = 6, minDtS = 0.001 } = {}) {
      if (!finite(maxSpeedMPerS) || maxSpeedMPerS <= 0) throw new RangeError("maxSpeedMPerS must be positive");
      if (!finite(minDtS) || minDtS <= 0) throw new RangeError("minDtS must be positive");
      this.maxSpeed = maxSpeedMPerS;
      this.minDt = minDtS;
      this.last = null;
      this.rejected = 0;
      this.accepted = 0;
    }
    reset() { this.last = null; }
    resetCounters() { this.rejected = 0; this.accepted = 0; }
    accept(point, timestampMs) {
      if (!finitePoint(point) || !finite(timestampMs)) { this.rejected++; return false; }
      const p = vec(point);
      if (this.last !== null) {
        const dt = (timestampMs - this.last.t) / 1000;
        if (dt < this.minDt) { this.rejected++; return false; }
        if (distanceM(p, this.last.p) / dt > this.maxSpeed) { this.rejected++; return false; }
      }
      this.last = { p, t: timestampMs };
      this.accepted++;
      return true;
    }
  }

  /* ---------- Joint velocity and acceleration ----------
     Backward finite-difference velocity from consecutive samples in SI
     units (m/s). Acceleration is the change between the last two speed
     estimates divided by the midpoint interval in m/s^2. It stays at 0
     until three samples exist. */
  class JointKinematics {
    constructor({ maxHistory = 64 } = {}) {
      if (!Number.isInteger(maxHistory) || maxHistory < 3) throw new RangeError("maxHistory must be >= 3");
      this.maxHistory = maxHistory;
      this.history = [];
    }
    reset() { this.history = []; }
    push(point, timestampMs) {
      if (!finitePoint(point) || !finite(timestampMs)) return null;
      const t = timestampMs / 1000;
      if (this.history.length && t <= this.history[this.history.length - 1].t) return null;
      this.history.push({ p: vec(point), t });
      if (this.history.length > this.maxHistory) this.history.shift();
      if (this.history.length < 2) return null;
      const a = this.history[this.history.length - 2];
      const b = this.history[this.history.length - 1];
      const dt = Math.max(EPS, b.t - a.t);
      const velocity = {
        x: (b.p.x - a.p.x) / dt,
        y: (b.p.y - a.p.y) / dt,
        z: (b.p.z - a.p.z) / dt
      };
      return { t: b.t, p: b.p, velocity, speed: Math.hypot(velocity.x, velocity.y, velocity.z) };
    }
    acceleration() {
      if (this.history.length < 3) return 0;
      const n = this.history.length;
      const prevDt = Math.max(EPS, this.history[n - 2].t - this.history[n - 3].t);
      const currDt = Math.max(EPS, this.history[n - 1].t - this.history[n - 2].t);
      const vPrev = distanceM(this.history[n - 2].p, this.history[n - 3].p) / prevDt;
      const vCurr = distanceM(this.history[n - 1].p, this.history[n - 2].p) / currDt;
      return (vCurr - vPrev) / (0.5 * (prevDt + currDt));
    }
  }

  /* ---------- Tremor / jitter descriptor ----------
     RMS of the high-pass component of a scalar signal such as pinch
     distance. This is a within-signal statistic, not a clinical measure. */
  function rmsHighPass(samples, { alpha = 0.35 } = {}) {
    if (!Array.isArray(samples) || !finite(alpha) || alpha <= 0 || alpha >= 1) {
      throw new RangeError("alpha must be in (0,1) and samples must be an array");
    }
    const clean = samples.filter(finite);
    if (clean.length === 0) return 0;
    let lp = clean[0];
    let sum = 0;
    for (let i = 0; i < clean.length; i++) {
      lp += alpha * (clean[i] - lp);
      const hp = clean[i] - lp;
      sum += hp * hp;
    }
    return Math.sqrt(sum / clean.length);
  }

  /* ---------- Path efficiency ----------
     Straight-line distance divided by traveled distance, clamped to
     [0,1]. A straight path is 1. Zero-length paths return 1. */
  function pathEfficiency(points) {
    if (!Array.isArray(points) || points.length < 2) return 1;
    if (!points.every(finitePoint)) throw new RangeError("points must contain finite x, y, z values");
    let traveled = 0;
    for (let i = 1; i < points.length; i++) traveled += distanceM(points[i - 1], points[i]);
    const straight = distanceM(points[0], points[points.length - 1]);
    if (traveled < EPS) return 1;
    return Math.min(1, Math.max(0, straight / traveled));
  }

  /* ---------- Comfort cone geometry ----------
     +Y is the rested-arm axis. `reach` is a vector from the elbow
     pivot. Membership uses the dot-product form of the half-angle
     test. */
  function insideComfortCone(reach, { halfAngleDeg = DEFAULT_HALF_ANGLE_DEG } = {}) {
    if (!finite(halfAngleDeg) || halfAngleDeg <= 0 || halfAngleDeg >= 90) {
      throw new RangeError("halfAngleDeg must be in (0,90)");
    }
    if (!finitePoint(reach)) throw new RangeError("reach must be a finite x, y, z vector");
    const len = magnitude(reach);
    if (len < EPS) return true;
    return (reach.y / len) >= Math.cos(halfAngleDeg * Math.PI / 180);
  }

  function coneDeviationDeg(reach) {
    if (!finitePoint(reach)) throw new RangeError("reach must be a finite x, y, z vector");
    const len = magnitude(reach);
    if (len < EPS) return 0;
    return Math.acos(Math.max(-1, Math.min(1, reach.y / len))) * 180 / Math.PI;
  }
  const coneViolationDeg = coneDeviationDeg;

  /* ---------- Pinch FSM dwell analytics ----------
     Summarises { state, t } samples into dwell times. A PINCH_START
     that is not followed by DRAGGING counts as a false start. */
  function summarizeTransitions(transitions) {
    if (!Array.isArray(transitions)) throw new RangeError("transitions must be an array");
    const sorted = transitions
      .filter(tr => tr && typeof tr.state === "string" && finite(tr.t))
      .slice()
      .sort((a, b) => a.t - b.t);
    const dwellMs = {};
    let falseStarts = 0;
    let drags = 0;
    for (let i = 0; i < sorted.length; i++) {
      const nextT = i + 1 < sorted.length ? sorted[i + 1].t : sorted[i].t;
      const dt = Math.max(0, nextT - sorted[i].t);
      dwellMs[sorted[i].state] = (dwellMs[sorted[i].state] || 0) + dt;
      if (sorted[i].state === "PINCH_START") {
        const next = sorted[i + 1];
        if (!next || next.state !== "DRAGGING") falseStarts++;
      }
      if (sorted[i].state === "DRAGGING") drags++;
    }
    return { dwellMs, falseStarts, draggingSamples: drags, samples: sorted.length };
  }

  function meanAndSampleStdDev(values) {
    const clean = values.filter(finite);
    if (!clean.length) return { mean: 0, stdDev: 0, count: 0, min: 0, max: 0 };
    const mean = clean.reduce((a, b) => a + b, 0) / clean.length;
    const variance = clean.length > 1
      ? clean.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (clean.length - 1)
      : 0;
    return {
      mean, stdDev: Math.sqrt(variance), count: clean.length,
      min: Math.min(...clean), max: Math.max(...clean)
    };
  }

  /* ---------- Session telemetry rollup ----------
     Frames are sorted by timestamp before any derivative is computed.
     `source` is recorded verbatim so simulated presets stay labelled.
     Only finite frames and finite sub-samples contribute. */
  function buildSessionReport(frames, { source = "unlabelled", halfAngleDeg = DEFAULT_HALF_ANGLE_DEG } = {}) {
    if (!Array.isArray(frames)) throw new RangeError("frames must be an array");
    if (!Number.isFinite(halfAngleDeg) || halfAngleDeg <= 0 || halfAngleDeg >= 90) {
      throw new RangeError("halfAngleDeg must be in (0,90)");
    }
    const valid = frames
      .filter(f => f && finite(f.t))
      .slice()
      .sort((a, b) => a.t - b.t);

    const pinchStats = meanAndSampleStdDev(valid.map(f => f.pinchMm));
    const wristSamples = valid.filter(f => finitePoint(f.wrist));
    const reachSamples = valid.filter(f => finitePoint(f.reach));

    const gate = new SampleGate();
    const acceptedPoints = [];
    for (const f of wristSamples) {
      if (gate.accept(f.wrist, f.t)) acceptedPoints.push(f.wrist);
    }

    const deviations = reachSamples.map(f => coneDeviationDeg(f.reach));
    const violations = reachSamples.filter(f => !insideComfortCone(f.reach, { halfAngleDeg })).length;
    const stateSummary = summarizeTransitions(
      valid.filter(f => typeof f.pinchState === "string").map(f => ({ state: f.pinchState, t: f.t }))
    );
    const durationMs = valid.length > 1 ? valid[valid.length - 1].t - valid[0].t : 0;

    const sources = [...new Set(valid.map(f => typeof f.source === "string" ? f.source : source))];
    return {
      source: sources.length > 1 ? "mixed" : (sources[0] || source),
      sources,
      frameCount: valid.length,
      durationMs,
      pinch: {
        samples: pinchStats.count,
        meanMm: +pinchStats.mean.toFixed(3),
        stdDevMm: +pinchStats.stdDev.toFixed(3),
        minMm: +pinchStats.min.toFixed(3),
        maxMm: +pinchStats.max.toFixed(3),
        highPassRmsMm: +rmsHighPass(valid.map(f => f.pinchMm)).toFixed(3)
      },
      wrist: {
        samples: wristSamples.length,
        gateAccepted: acceptedPoints.length,
        gateRejected: gate.rejected,
        pathEfficiency: +pathEfficiency(acceptedPoints).toFixed(4)
      },
      comfortCone: {
        halfAngleDeg,
        violations,
        maxDeviationDeg: deviations.length ? +Math.max(...deviations).toFixed(2) : 0
      },
      pinchState: stateSummary,
      note: "Derived from the supplied frame stream only. Simulated presets are labelled by source."
    };
  }

  /* Deterministic CSV export of a frame stream. Quotes are escaped by
     doubling, matching RFC 4180. Empty cells stand for missing values. */
  const CSV_COLUMNS = ["t_ms", "source", "pinch_mm", "pinch_state", "wrist_x_m", "wrist_y_m", "wrist_z_m", "reach_x_m", "reach_y_m", "reach_z_m"];
  function csvCell(v) {
    if (v === undefined || v === null || (typeof v === "number" && !Number.isFinite(v))) return "";
    let s = String(v);
    /* Formula injection: spreadsheet apps interpret a leading =, +, -, @ or
       whitespace/control character as a formula or reference. A leading
       apostrophe marks the cell as literal text. Numbers stay numeric. */
    if (typeof v === "string" && /^[\s=+\-@\x00-\x1f\x7f-\x9f]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function exportFramesCsv(frames, { source = "unlabelled" } = {}) {
    if (!Array.isArray(frames)) throw new RangeError("frames must be an array");
    const rows = [CSV_COLUMNS.join(",")];
    for (const f of frames.slice().sort((a, b) => (a?.t ?? 0) - (b?.t ?? 0))) {
      if (!f || !finite(f.t)) continue;
      const w = f.wrist || {};
      const r = f.reach || {};
      rows.push([
        f.t, f.source ?? source, f.pinchMm, f.pinchState,
        w.x, w.y, w.z, r.x, r.y, r.z
      ].map(csvCell).join(","));
    }
    return rows.join("\r\n");
  }

  return {
    SampleGate, JointKinematics,
    rmsHighPass, pathEfficiency,
    insideComfortCone, coneDeviationDeg, coneViolationDeg,
    summarizeTransitions, buildSessionReport,
    meanAndSampleStdDev, exportFramesCsv, CSV_COLUMNS,
    distanceM
  };
});

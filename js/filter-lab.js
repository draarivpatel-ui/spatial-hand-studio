/* =============================================================
   filter-lab.js - deterministic filter, pinch-hysteresis and
   biomechanics lab for SpatialHand Studio.

   Pure JS, no dependencies beyond the project's own kinematics
   module: the comparator drives the real OneEuroFilter, PinchFSM
   and Drillis-Contini quasi-static shoulder-moment model from
   js/xr-hand-kinematics.js over synthetic 90 Hz trajectories.

   UMD: exports FilterLab as a browser global and as CommonJS.
   ============================================================= */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./xr-hand-kinematics.js"));
  } else {
    root.FilterLab = factory(
      typeof OneEuroFilter === "function" && typeof PinchFSM === "function" &&
      typeof shoulderTorqueNm === "function" && typeof applyPosePreset === "function"
        ? { OneEuroFilter, PinchFSM, PinchState, shoulderTorqueNm, distMm,
            applyPosePreset, buildBaseHandJoints }
        : null
    );
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (K) {
  "use strict";

  const VERSION = "1.0.0";
  const SAMPLE_RATE_HZ = 90;
  const DT_MS = 1000 / SAMPLE_RATE_HZ;
  const FRAME_COUNT = 270;                 /* 3.0 s at 90 Hz */
  const RECOVERY_BAND_MM = 1.5;
  const MAX_LAG_FRAMES = 24;
  const MAX_HASH_LEN = 700;
  const DIGEST_CACHE_MAX = 48;

  const STATE_LIMITS = Object.freeze({
    enterMinMm: 5, enterMaxMm: 80, exitMaxMm: 100,
    armMaxDeg: 90, elbowMaxDeg: 120
  });

  const LAB_DEFAULTS = Object.freeze({
    trajectory: "micro-tremor-hover",
    profile: "one-euro-balanced",
    enterMm: 20, exitMm: 28,
    armDeg: 14, elbowDeg: 20.4
  });

  function finite(v) { return typeof v === "number" && Number.isFinite(v); }
  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function round3(v) { return Math.round(v * 1000) / 1000; }
  function round2(v) { return Math.round(v * 100) / 100; }

  function kinematicsAvailable() {
    return !!K && typeof K.OneEuroFilter === "function" && typeof K.PinchFSM === "function" &&
      typeof K.shoulderTorqueNm === "function";
  }
  function requireK() {
    if (!kinematicsAvailable()) {
      throw new Error("filter lab requires js/xr-hand-kinematics.js");
    }
    return K;
  }

  /* ---------- Deterministic PRNG (mulberry32) ---------- */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Box-Muller standard normal from the seeded stream. */
  function gauss(rand) {
    const u1 = Math.max(1e-12, rand());
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /* ---------- Filter profiles ----------
     raw-unfiltered passes the signal through untouched.
     ema-heavy is a fixed-gain exponential moving average; it does not
     adapt to velocity and ignores dt (constant gain per sample).
     The three one-euro-* profiles parameterise the project's real
     OneEuroFilter class. */
  const FILTER_PROFILES = Object.freeze({
    "raw-unfiltered": Object.freeze({
      id: "raw-unfiltered", label: "Raw (no filter)", kind: "raw",
      description: "Unfiltered signal passthrough. No smoothing, no hysteresis on the value itself.",
      appliesToLiveRig: false
    }),
    "ema-heavy": Object.freeze({
      id: "ema-heavy", label: "EMA heavy", kind: "ema", alpha: 0.12,
      description: "Constant-gain exponential moving average, alpha 0.12 per sample.",
      appliesToLiveRig: false
    }),
    "one-euro-precision": Object.freeze({
      id: "one-euro-precision", label: "1-Euro precision", kind: "one-euro",
      freq: SAMPLE_RATE_HZ, minCutoff: 0.5, beta: 0.001, dCutoff: 1.0,
      description: "Low minimum cutoff, small beta: strongest smoothing, slowest response.",
      appliesToLiveRig: true
    }),
    "one-euro-balanced": Object.freeze({
      id: "one-euro-balanced", label: "1-Euro balanced", kind: "one-euro",
      freq: SAMPLE_RATE_HZ, minCutoff: 1.2, beta: 0.007, dCutoff: 1.0,
      description: "The desktop rig defaults: minCutoff 1.2 Hz, beta 0.007.",
      appliesToLiveRig: true
    }),
    "one-euro-fast": Object.freeze({
      id: "one-euro-fast", label: "1-Euro fast", kind: "one-euro",
      freq: SAMPLE_RATE_HZ, minCutoff: 2.5, beta: 0.06, dCutoff: 1.0,
      description: "High minimum cutoff, large beta: fastest response, least smoothing.",
      appliesToLiveRig: true
    })
  });
  const FILTER_ORDER = Object.freeze([
    "raw-unfiltered", "ema-heavy", "one-euro-precision", "one-euro-balanced", "one-euro-fast"
  ]);
  const FILTER_IDS = FILTER_ORDER;

  class RawFilter {
    constructor() { this.t = null; }
    reset() { this.t = null; }
    filter(value, timestamp) {
      if (!finite(value) || !finite(timestamp)) return NaN;
      if (this.t !== null && timestamp <= this.t) return NaN;
      this.t = timestamp;
      return value;
    }
  }

  class EmaFilter {
    constructor({ alpha = 0.12 } = {}) {
      if (!finite(alpha) || alpha <= 0 || alpha > 1) {
        throw new RangeError("EMA alpha must be in (0,1]");
      }
      this.alpha = alpha;
      this.reset();
    }
    reset() { this.y = null; this.t = null; }
    filter(value, timestamp) {
      if (!finite(value) || !finite(timestamp)) return this.y === null ? NaN : this.y;
      if (this.t !== null && timestamp <= this.t) return this.y;
      if (this.y === null) { this.y = value; this.t = timestamp; return value; }
      this.y = this.alpha * value + (1 - this.alpha) * this.y;
      this.t = timestamp;
      return this.y;
    }
  }

  /* Returns a fresh filter instance plus its profile descriptor. */
  function makeFilter(profileId) {
    const profile = typeof profileId === "string" && Object.hasOwn(FILTER_PROFILES, profileId)
      ? FILTER_PROFILES[profileId] : undefined;
    if (!profile) throw new RangeError("unknown filter profile: " + String(profileId));
    let impl;
    if (profile.kind === "raw") impl = new RawFilter();
    else if (profile.kind === "ema") impl = new EmaFilter({ alpha: profile.alpha });
    else {
      const kin = requireK();
      impl = new kin.OneEuroFilter({
        freq: profile.freq, minCutoff: profile.minCutoff,
        beta: profile.beta, dCutoff: profile.dCutoff
      });
    }
    return { profile, filter: (v, t) => impl.filter(v, t), reset: () => impl.reset() };
  }

  /* ---------- Synthetic 90 Hz trajectories ----------
     Each generator emits { rawX, truthX, rawPinch, truthPinch } per frame.
     truthX is the noiseless hand path in millimetres; truthPinch is the
     noiseless thumb-to-index distance in millimetres. Dropout windows
     emit NaN on the raw channels, mirroring a lost tracking frame. */
  function tremor(s, a1, f1, a2, f2) {
    return a1 * Math.sin(2 * Math.PI * f1 * s) + a2 * Math.sin(2 * Math.PI * f2 * s);
  }

  function buildFrames(seed, fn) {
    const rand = mulberry32(seed);
    const frames = [];
    for (let i = 0; i < FRAME_COUNT; i++) {
      frames.push({ i, t: i * DT_MS, ...fn(i, i * DT_MS / 1000, rand) });
    }
    return frames;
  }

  const TRAJECTORIES = Object.freeze({
    "micro-tremor-hover": Object.freeze({
      id: "micro-tremor-hover",
      label: "Micro-tremor hover",
      description: "Hand held over a target for 3 s. Position carries an 8 Hz plus 13.3 Hz tremor with measurement noise; the pinch distance floats inside the hover band.",
      stepIndex: null,
      dropoutRuns: [],
      generate() {
        const frames = buildFrames(0x5eed1, (i, s, rand) => ({
          truthX: 62,
          rawX: 62 + tremor(s, 0.7, 8, 0.4, 13.3) + 0.35 * gauss(rand),
          truthPinch: 33,
          rawPinch: 33 + 1.2 * Math.sin(2 * Math.PI * 5.5 * s) + 0.7 * gauss(rand)
        }));
        return { frames, holdRanges: [[0, FRAME_COUNT - 1]] };
      }
    }),
    "step-saccade-grab": Object.freeze({
      id: "step-saccade-grab",
      label: "Step saccade grab",
      description: "A 60 mm saccade at t = 1.0 s with a pinch ramp closing to 14 mm. Measures step settling lag against tremor rejection.",
      stepIndex: 90,
      dropoutRuns: [],
      generate() {
        const frames = buildFrames(0x5eed2, (i, s, rand) => {
          const truthX = i < 90 ? 45 : 105;
          const truthPinch = i < 81 ? 60 : i <= 126 ? 60 - 46 * ((i - 81) / 45) : 14;
          return {
            truthX,
            rawX: truthX + tremor(s, 0.55, 8, 0.35, 13.3) + 0.5 * gauss(rand),
            truthPinch,
            rawPinch: truthPinch + 0.9 * gauss(rand)
          };
        });
        return { frames, holdRanges: [[0, 89], [170, FRAME_COUNT - 1]] };
      }
    }),
    "pinch-chatter-boundary": Object.freeze({
      id: "pinch-chatter-boundary",
      label: "Pinch chatter boundary",
      description: "The pinch distance oscillates across the enter and exit thresholds at 4.2 Hz. Counts false pinch transitions caused by boundary chatter.",
      stepIndex: null,
      dropoutRuns: [],
      generate() {
        const frames = buildFrames(0x5eed3, (i, s, rand) => ({
          truthX: 70,
          rawX: 70 + tremor(s, 0.6, 8, 0.4, 13.3) + 0.5 * gauss(rand),
          truthPinch: 24 + 7.5 * Math.sin(2 * Math.PI * 4.2 * s + 0.4),
          rawPinch: 24 + 7.5 * Math.sin(2 * Math.PI * 4.2 * s + 0.4) + 0.8 * gauss(rand)
        }));
        return { frames, holdRanges: [[0, FRAME_COUNT - 1]] };
      }
    }),
    "tracking-dropout-recovery": Object.freeze({
      id: "tracking-dropout-recovery",
      label: "Tracking dropout recovery",
      description: "Two tracking dropouts of 12 and 22 frames. The hand moves 30 mm and closes a pinch while tracking is lost; counts the frames needed to re-converge.",
      stepIndex: null,
      dropoutRuns: [[60, 71], [110, 131]],
      generate() {
        const windows = [[60, 71], [110, 131]];
        const frames = buildFrames(0x5eed4, (i, s, rand) => {
          const dropped = windows.some(w => i >= w[0] && i <= w[1]);
          const truthX = i < 120 ? 55 : 85;
          const truthPinch = i < 120 ? 58 : 16;
          return {
            truthX,
            rawX: dropped ? NaN : truthX + tremor(s, 0.5, 8, 0.3, 13.3) + 0.55 * gauss(rand),
            truthPinch,
            rawPinch: dropped ? NaN : truthPinch + 0.9 * gauss(rand)
          };
        });
        return { frames, holdRanges: [[0, 58], [150, FRAME_COUNT - 1]] };
      }
    })
  });
  const TRAJECTORY_ORDER = Object.freeze([
    "micro-tremor-hover", "step-saccade-grab", "pinch-chatter-boundary", "tracking-dropout-recovery"
  ]);
  const TRAJECTORY_IDS = TRAJECTORY_ORDER;

  function generateTrajectory(presetId) {
    const def = typeof presetId === "string" && Object.hasOwn(TRAJECTORIES, presetId)
      ? TRAJECTORIES[presetId] : undefined;
    if (!def) throw new RangeError("unknown trajectory: " + String(presetId));
    const { frames, holdRanges } = def.generate();
    return { id: def.id, label: def.label, frames, holdRanges, stepIndex: def.stepIndex, dropoutRuns: def.dropoutRuns };
  }

  function trajectoryInfo(presetId) {
    const def = typeof presetId === "string" && Object.hasOwn(TRAJECTORIES, presetId)
      ? TRAJECTORIES[presetId] : undefined;
    if (!def) throw new RangeError("unknown trajectory: " + String(presetId));
    return {
      id: def.id, label: def.label, description: def.description,
      frameCount: FRAME_COUNT, sampleRateHz: SAMPLE_RATE_HZ,
      durationMs: FRAME_COUNT * DT_MS,
      hasStep: def.stepIndex !== null, hasDropout: def.dropoutRuns.length > 0,
      dropoutFrames: def.dropoutRuns.reduce((n, w) => n + w[1] - w[0] + 1, 0)
    };
  }

  /* ---------- Run metrics ----------
     jitterRmsMm: RMS deviation of the filtered X channel from the
     noiseless path during declared hold windows.
     settleLagMs90: first time the filtered output enters and stays
     inside the 10% band of a declared step, measured from the step.
     lagMs: cross-correlation delay on the X and pinch channels; the
     larger of the two (0 when the truth is constant).
     falsePinchTransitions: PINCH_START -> RELEASE transitions, a pinch
     cancelled inside its single-frame confirmation window.
     recoveryFrames: frames after the longest NaN run until the filtered
     output is back within RECOVERY_BAND_MM of the truth. */
  /* Cross-correlation delay. A constant truth channel cannot measure
     lag (every shift fits equally), so it contributes 0. Among shifts
     whose RMS error sits within 2% of the best, the smallest k wins:
     noise-level differences must not fabricate a lag. */
  function channelLagMs(filt, truth) {
    const n = Math.min(filt.length, truth.length);
    const tv = truth.filter(finite);
    if (tv.length < 2) return 0;
    const mean = tv.reduce((a, b) => a + b, 0) / tv.length;
    const tVar = tv.reduce((s, v) => s + (v - mean) * (v - mean), 0) / tv.length;
    if (tVar < 0.0025) return 0;
    const rmsAt = new Array(Math.min(MAX_LAG_FRAMES, n - 1) + 1).fill(Infinity);
    let bestRms = Infinity;
    for (let k = 0; k < rmsAt.length; k++) {
      let se = 0, c = 0;
      for (let i = k; i < n; i++) {
        if (finite(filt[i]) && finite(truth[i - k])) {
          const d = filt[i] - truth[i - k];
          se += d * d; c++;
        }
      }
      if (c > 0) { rmsAt[k] = Math.sqrt(se / c); if (rmsAt[k] < bestRms) bestRms = rmsAt[k]; }
    }
    if (!Number.isFinite(bestRms)) return 0;
    let best = 0;
    for (let k = 0; k < rmsAt.length; k++) {
      if (rmsAt[k] <= bestRms * 1.02) { best = k; break; }
    }
    return best * DT_MS;
  }

  function longestDropoutRun(samples) {
    let best = null, start = -1;
    for (let i = 0; i <= samples.length; i++) {
      const dropped = i < samples.length && !finite(samples[i].rawX);
      if (dropped && start < 0) start = i;
      if (!dropped && start >= 0) {
        if (!best || i - start > best.end - best.start) best = { start, end: i };
        start = -1;
      }
    }
    return best;
  }

  function computeMetrics(traj, samples, transitions) {
    const n = samples.length;
    let se = 0, c = 0;
    for (const [a, b] of traj.holdRanges) {
      for (let i = Math.max(0, a); i <= Math.min(b, n - 1); i++) {
        const s = samples[i];
        if (finite(s.filtX) && finite(s.truthX)) { const d = s.filtX - s.truthX; se += d * d; c++; }
      }
    }
    const jitterRmsMm = c > 0 ? Math.sqrt(se / c) : 0;

    let settleLagMs90 = null;
    const si = traj.stepIndex;
    if (si !== null && si !== undefined && si > 0 && si < n) {
      const before = traj.frames[si - 1].truthX, after = traj.frames[si].truthX;
      const amp = Math.abs(after - before);
      if (amp > 1e-9) {
        const band = 0.1 * amp;
        for (let j = si; j < n; j++) {
          const s = samples[j];
          if (!finite(s.filtX) || Math.abs(s.filtX - after) > band) continue;
          let stable = true;
          for (let k = j + 1; k < Math.min(n, j + 45); k++) {
            const sk = samples[k];
            if (finite(sk.filtX) && Math.abs(sk.filtX - after) > band) { stable = false; break; }
          }
          if (stable) { settleLagMs90 = round2(s.t - traj.frames[si].t); break; }
        }
      }
    }

    let falsePinchTransitions = 0, pinchCycles = 0, dragPhases = 0;
    for (const tr of transitions) {
      if (tr.to === "PINCH_START") pinchCycles++;
      else if (tr.to === "DRAGGING") dragPhases++;
      if (tr.from === "PINCH_START" && tr.to === "RELEASE") falsePinchTransitions++;
    }

    const dropoutFrames = samples.filter(s => !finite(s.rawX)).length;
    let recoveryFrames = null, recovered = null;
    const run = longestDropoutRun(samples);
    if (run && run.end < n) {
      recovered = false;
      for (let j = run.end; j < n; j++) {
        const s = samples[j];
        if (finite(s.filtX) && Math.abs(s.filtX - s.truthX) <= RECOVERY_BAND_MM) {
          recoveryFrames = j - run.end;
          recovered = true;
          break;
        }
      }
      if (recoveryFrames === null) recoveryFrames = n - run.end;
    }

    const lagX = channelLagMs(samples.map(s => s.filtX), traj.frames.map(f => f.truthX));
    const lagP = channelLagMs(samples.map(s => s.filtPinch), traj.frames.map(f => f.truthPinch));
    const lagMs = round2(Math.max(lagX, lagP));

    return {
      jitterRmsMm: +jitterRmsMm.toFixed(4),
      settleLagMs90, lagMs,
      falsePinchTransitions, pinchCycles, dragPhases,
      recoveryFrames, recovered, dropoutFrames,
      transitionCount: transitions.length
    };
  }

  /* Run one profile over one trajectory through the real 1-Euro /
     EMA / raw filter and the real PinchFSM. */
  function runTrajectory(presetId, profileId, { enterMm = LAB_DEFAULTS.enterMm, exitMm = LAB_DEFAULTS.exitMm } = {}) {
    const kin = requireK();
    if (!finite(enterMm) || !finite(exitMm) || enterMm <= 0 || exitMm <= enterMm) {
      throw new RangeError("pinch exit threshold must exceed a positive enter threshold");
    }
    const traj = generateTrajectory(presetId);
    const fX = makeFilter(profileId);
    const fP = makeFilter(profileId);
    const fsm = new kin.PinchFSM({ enterThresholdMm: enterMm, exitThresholdMm: exitMm });
    const samples = [];
    const transitions = [];
    fsm.onTransition((from, to) => transitions.push({ i: samples.length, from, to }));
    for (const fr of traj.frames) {
      const filtX = fX.filter(fr.rawX, fr.t);
      const filtPinch = fP.filter(fr.rawPinch, fr.t);
      const state = fsm.update(filtPinch);
      samples.push({
        i: fr.i, t: fr.t,
        rawX: fr.rawX, truthX: fr.truthX, filtX,
        rawPinch: fr.rawPinch, truthPinch: fr.truthPinch, filtPinch,
        state
      });
    }
    return {
      trajectory: { id: traj.id, label: traj.label, stepIndex: traj.stepIndex, holdRanges: traj.holdRanges, dropoutRuns: traj.dropoutRuns },
      profile: FILTER_PROFILES[profileId],
      thresholdsMm: { enter: enterMm, exit: exitMm },
      samples, transitions,
      metrics: computeMetrics(traj, samples, transitions)
    };
  }

  function runComparison(presetId, opts = {}) {
    const rows = FILTER_ORDER.map(profileId => runTrajectory(presetId, profileId, opts));
    const info = trajectoryInfo(presetId);
    return {
      trajectory: info,
      thresholdsMm: { enter: opts.enterMm ?? LAB_DEFAULTS.enterMm, exit: opts.exitMm ?? LAB_DEFAULTS.exitMm },
      rows
    };
  }

  /* ---------- Pareto frontier (minimise jitter and lag) ---------- */
  function paretoFrontierIds(rows) {
    const ids = [];
    for (const r of rows) {
      const dominated = rows.some(o => o !== r &&
        o.metrics.jitterRmsMm <= r.metrics.jitterRmsMm && o.metrics.lagMs <= r.metrics.lagMs &&
        (o.metrics.jitterRmsMm < r.metrics.jitterRmsMm || o.metrics.lagMs < r.metrics.lagMs));
      if (!dominated) ids.push(r.profile.id);
    }
    return ids;
  }

  /* ---------- Quasi-static shoulder moment ----------
     Same two-segment Drillis-Contini model as
     xr-hand-kinematics.js:shoulderTorqueNm, with the elbow domain
     widened to 120 deg for the sweep. Elbow contribution peaks at
     90 deg because sin() falls again past 90; the sweep records that
     instead of forcing monotonicity. This is a deterministic
     quasi-static model: not EMG, not clinical testing. */
  function quasiStaticShoulderMomentNm({ bodyMassKg = 75, upperArmLenM = 0.32, forearmLenM = 0.27,
                                         armAbductionDeg = 14, elbowFlexDeg = 20.4 } = {}) {
    if (![bodyMassKg, upperArmLenM, forearmLenM, armAbductionDeg, elbowFlexDeg].every(finite)) {
      throw new RangeError("posture parameters must be finite numbers");
    }
    if (bodyMassKg <= 0 || upperArmLenM <= 0 || forearmLenM <= 0) {
      throw new RangeError("mass and segment lengths must be positive");
    }
    if (armAbductionDeg < 0 || armAbductionDeg > 90 || elbowFlexDeg < 0 || elbowFlexDeg > 120) {
      throw new RangeError("posture angles must be inside arm 0-90 and elbow 0-120 degrees");
    }
    const g = 9.81;
    const sin = d => Math.sin(d * Math.PI / 180);
    const mUA = 0.028 * bodyMassKg;
    const mFA = 0.022 * bodyMassKg;
    const rUA = 0.436 * upperArmLenM;
    const rFA = 0.682 * forearmLenM;
    const torque = g * (mUA * rUA * sin(armAbductionDeg) +
                        mFA * (upperArmLenM * sin(armAbductionDeg) + rFA * sin(elbowFlexDeg)));
    return +torque.toFixed(3);
  }

  function sweepShoulderMoment({ armMinDeg = 0, armMaxDeg = 90, elbowMinDeg = 0, elbowMaxDeg = 120,
                                 armSteps = 13, elbowSteps = 13, ...rest } = {}) {
    if (![armMinDeg, armMaxDeg, elbowMinDeg, elbowMaxDeg].every(finite) ||
        armMinDeg < 0 || armMaxDeg > 90 || armMinDeg >= armMaxDeg ||
        elbowMinDeg < 0 || elbowMaxDeg > 120 || elbowMinDeg >= elbowMaxDeg) {
      throw new RangeError("invalid sweep angle range");
    }
    if (!Number.isInteger(armSteps) || !Number.isInteger(elbowSteps) ||
        armSteps < 2 || elbowSteps < 2 || armSteps > 64 || elbowSteps > 64) {
      throw new RangeError("sweep steps must be integers in [2,64]");
    }
    const armDeg = [], elbowDeg = [], grid = [];
    for (let i = 0; i < armSteps; i++) armDeg.push(round3(armMinDeg + (armMaxDeg - armMinDeg) * i / (armSteps - 1)));
    for (let j = 0; j < elbowSteps; j++) elbowDeg.push(round3(elbowMinDeg + (elbowMaxDeg - elbowMinDeg) * j / (elbowSteps - 1)));
    let minNm = Infinity, maxNm = -Infinity, minAt = null, maxAt = null;
    for (let i = 0; i < armSteps; i++) {
      const row = [];
      for (let j = 0; j < elbowSteps; j++) {
        const m = quasiStaticShoulderMomentNm({ armAbductionDeg: armDeg[i], elbowFlexDeg: elbowDeg[j], ...rest });
        row.push(m);
        if (m < minNm) { minNm = m; minAt = { armDeg: armDeg[i], elbowDeg: elbowDeg[j] }; }
        if (m > maxNm) { maxNm = m; maxAt = { armDeg: armDeg[i], elbowDeg: elbowDeg[j] }; }
      }
      grid.push(row);
    }
    /* Arm monotonicity: moment rises with abduction on [0,90] because
       both segment terms contain sin(a). Elbow monotonicity holds only
       to 90 deg; the peak elbow angle is recorded, not assumed. */
    let monotonicArm = true;
    for (let j = 0; j < elbowSteps && monotonicArm; j++) {
      for (let i = 1; i < armSteps; i++) {
        if (grid[i][j] < grid[i - 1][j] - 1e-9) { monotonicArm = false; break; }
      }
    }
    let peakElbowDeg = elbowDeg[0], peakAtArm = armDeg[armSteps - 1];
    const topRow = grid[armSteps - 1];
    let topBest = -Infinity;
    for (let j = 0; j < elbowSteps; j++) if (topRow[j] > topBest) { topBest = topRow[j]; peakElbowDeg = elbowDeg[j]; }
    void peakAtArm;
    return { armDeg, elbowDeg, grid, minNm, maxNm, minAt, maxAt, monotonicArm, peakElbowDeg,
             armSteps, elbowSteps, armMinDeg, armMaxDeg, elbowMinDeg, elbowMaxDeg };
  }

  /* ---------- UTF-8 and FIPS 180-4 SHA-256 ---------- */
  function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let cp = str.codePointAt(i);
      if (cp > 0xffff) i++;
      if (cp < 0x80) out.push(cp);
      else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
      else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
      else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    }
    return new Uint8Array(out);
  }

  const SHA256_H0 = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  function sha256Bytes(input) {
    const bytes = typeof input === "string" ? utf8Bytes(input) : input;
    if (!(bytes instanceof Uint8Array)) throw new TypeError("sha256 input must be a string or Uint8Array");
    const bitLen = bytes.length * 8;
    const withPad = bytes.length + 1 + 8;
    const total = withPad + ((64 - (withPad % 64)) % 64);
    const msg = new Uint8Array(total);
    msg.set(bytes);
    msg[bytes.length] = 0x80;
    const dv = new DataView(msg.buffer);
    dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000), false);
    dv.setUint32(total - 4, bitLen >>> 0, false);

    const H = new Uint32Array(SHA256_H0);
    const w = new Uint32Array(64);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0;
        d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const od = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) od.setUint32(i * 4, H[i], false);
    return out;
  }

  function sha256Hex(input) {
    const out = sha256Bytes(input);
    let hex = "";
    for (const b of out) hex += b.toString(16).padStart(2, "0");
    return hex;
  }

  /* ---------- Canonical JSON, lab state, digest ---------- */
  function canonicalJson(v) {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "number") {
      if (!Number.isFinite(v)) throw new TypeError("canonical JSON cannot hold a non-finite number");
      return JSON.stringify(v === 0 ? 0 : v);
    }
    if (t === "string") return JSON.stringify(v);
    if (t === "boolean") return v ? "true" : "false";
    if (t === "object") {
      if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
      const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== "function").sort();
      return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(v[k])).join(",") + "}";
    }
    throw new TypeError("canonical JSON cannot hold " + t);
  }

  /* Coercive normalizer for live UI state: unknown enums fall back to
     defaults, numbers accept numeric strings, out-of-range values
     clamp and exit is always kept above enter. Unknown input fields
     (including Sets and nested objects) are ignored, never read. */
  function normalizeLabState(input) {
    const s = input && typeof input === "object" ? input : {};
    const txt = v => typeof v === "string" ? v : undefined;
    const num = (v, d) => {
      const n = typeof v === "string" ? Number(v) : v;
      return finite(n) ? n : d;
    };
    const trajectory = TRAJECTORY_IDS.includes(txt(s.trajectory)) ? s.trajectory : LAB_DEFAULTS.trajectory;
    const profile = FILTER_IDS.includes(txt(s.profile)) ? s.profile : LAB_DEFAULTS.profile;
    const enterMm = round3(clamp(num(s.enterMm, LAB_DEFAULTS.enterMm), STATE_LIMITS.enterMinMm, STATE_LIMITS.enterMaxMm));
    let exitMm = round3(clamp(num(s.exitMm, LAB_DEFAULTS.exitMm), STATE_LIMITS.enterMinMm + 0.5, STATE_LIMITS.exitMaxMm));
    if (exitMm <= enterMm) exitMm = round3(Math.min(STATE_LIMITS.exitMaxMm, enterMm + 8));
    const armDeg = round3(clamp(num(s.armDeg, LAB_DEFAULTS.armDeg), 0, STATE_LIMITS.armMaxDeg));
    const elbowDeg = round3(clamp(num(s.elbowDeg, LAB_DEFAULTS.elbowDeg), 0, STATE_LIMITS.elbowMaxDeg));
    return { trajectory, profile, enterMm, exitMm, armDeg, elbowDeg };
  }

  const DISCLOSURES = Object.freeze([
    "Deterministic synthetic trajectories at 90 Hz; no recorded hand tracking is used.",
    "The shoulder moment is a two-segment quasi-static Drillis and Contini model at a 75 kg reference mass.",
    "No EMG, clinical, fatigue, comfort or human-subject measurement is claimed.",
    "SHA-256 is an unkeyed integrity digest for tamper detection; it is not a signature."
  ]);

  function buildExportPayload(norm) {
    const comparison = runComparison(norm.trajectory, { enterMm: norm.enterMm, exitMm: norm.exitMm });
    const momentNm = quasiStaticShoulderMomentNm({ armAbductionDeg: norm.armDeg, elbowFlexDeg: norm.elbowDeg });
    const sweep = sweepShoulderMoment({});
    return {
      schema: "spatial-hand-studio/lab-export/1",
      generator: "SpatialHand Studio filter lab",
      labVersion: VERSION,
      deterministic: true,
      sampleRateHz: SAMPLE_RATE_HZ,
      state: norm,
      comparison: {
        trajectory: norm.trajectory,
        thresholdsMm: { enter: norm.enterMm, exit: norm.exitMm },
        paretoFrontier: paretoFrontierIds(comparison.rows),
        rows: comparison.rows.map(r => ({ profile: r.profile.id, ...r.metrics }))
      },
      posture: {
        armDeg: norm.armDeg, elbowDeg: norm.elbowDeg, momentNm,
        model: "two-segment quasi-static Drillis-Contini, 75 kg reference",
        sweep: {
          armRangeDeg: [0, 90], elbowRangeDeg: [0, 120],
          steps: [sweep.armSteps, sweep.elbowSteps],
          minNm: sweep.minNm, maxNm: sweep.maxNm,
          minAt: sweep.minAt, maxAt: sweep.maxAt,
          monotonicArm: sweep.monotonicArm, peakElbowDeg: sweep.peakElbowDeg
        }
      },
      scope: DISCLOSURES.slice()
    };
  }

  /* One canonical digest-stamped payload per normalized state key.
     The on-page fingerprint, JSON export, CSV header and Markdown
     footer all read this same cached entry, so all four surfaces
     always carry the identical digest. No wall-clock field exists
     inside the payload: every run is deterministic by construction. */
  const digestCache = new Map();
  function digestFor(state) {
    const norm = normalizeLabState(state);
    const key = canonicalJson(norm);
    let entry = digestCache.get(key);
    if (!entry) {
      const payload = buildExportPayload(norm);
      entry = { key, payload, sha256: sha256Hex(canonicalJson(payload)) };
      digestCache.set(key, entry);
      if (digestCache.size > DIGEST_CACHE_MAX) digestCache.delete(digestCache.keys().next().value);
    }
    return entry;
  }

  /* ---------- Exporters ---------- */
  function exportJson(state) {
    const { payload, sha256 } = digestFor(state);
    const doc = {
      ...payload,
      integrity: {
        algorithm: "SHA-256",
        canonicalJsonSha256: sha256,
        note: "Unkeyed digest over canonicalJson(payload). Recompute to verify; not a signature."
      }
    };
    return JSON.stringify(doc, null, 2);
  }

  /* Same formula-injection rule as hand-telemetry.js: a leading
     =, +, -, @ or control character makes a spreadsheet evaluate the
     cell, so a leading apostrophe marks it as literal text. */
  function csvCell(v) {
    if (v === undefined || v === null || (typeof v === "number" && !Number.isFinite(v))) return "";
    let s = String(v);
    if (typeof v === "string" && /^[\s=+\-@\x00-\x1f\x7f-\x9f]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv(state) {
    const { payload, sha256 } = digestFor(state);
    const s = payload.state;
    const lines = [
      "# SpatialHand Studio filter lab export",
      "# schema: " + payload.schema,
      "# trajectory: " + s.trajectory + ", filter profile: " + s.profile,
      "# thresholds_mm: enter " + s.enterMm + ", exit " + s.exitMm,
      "# posture_deg: arm " + s.armDeg + ", elbow " + s.elbowDeg,
      "# sha256: " + sha256,
      "profile,kind,jitter_rms_mm,eff_lag_ms,settle_lag_90_ms,false_pinch_transitions,pinch_cycles,recovery_frames"
    ];
    for (const row of payload.comparison.rows) {
      lines.push([
        csvCell(row.profile), csvCell(FILTER_PROFILES[row.profile].kind),
        csvCell(row.jitterRmsMm), csvCell(row.lagMs),
        row.settleLagMs90 === null ? "" : csvCell(row.settleLagMs90),
        csvCell(row.falsePinchTransitions), csvCell(row.pinchCycles),
        row.recoveryFrames === null ? "" : csvCell(row.recoveryFrames)
      ].join(","));
    }
    return lines.join("\r\n");
  }

  function exportMarkdown(state) {
    const { payload, sha256 } = digestFor(state);
    const s = payload.state;
    const L = [];
    L.push("# SpatialHand Studio: filter and biomechanics lab export");
    L.push("");
    L.push("Trajectory `" + s.trajectory + "`, filter profile `" + s.profile + "`, pinch enter " +
      s.enterMm + " mm, exit " + s.exitMm + " mm, sampled at " + payload.sampleRateHz + " Hz.");
    L.push("");
    L.push("## Filter comparison");
    L.push("");
    L.push("| Profile | Jitter RMS (mm) | Effective lag (ms) | 90% settle (ms) | False pinches | Pinch cycles | Recovery frames |");
    L.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const row of payload.comparison.rows) {
      L.push("| " + FILTER_PROFILES[row.profile].label + " | " + row.jitterRmsMm + " | " + row.lagMs +
        " | " + (row.settleLagMs90 === null ? "-" : row.settleLagMs90) + " | " + row.falsePinchTransitions +
        " | " + row.pinchCycles + " | " + (row.recoveryFrames === null ? "-" : row.recoveryFrames) + " |");
    }
    L.push("");
    L.push("Pareto-optimal profiles: " + payload.comparison.paretoFrontier.map(p => "`" + p + "`").join(", "));
    L.push("");
    L.push("## Posture model");
    L.push("");
    L.push("Arm " + s.armDeg + " deg, elbow " + s.elbowDeg + " deg: modelled shoulder moment " +
      payload.posture.momentNm + " N.m (" + payload.posture.model + ").");
    L.push("Sweep over arm 0-90 deg and elbow 0-120 deg: min " + payload.posture.sweep.minNm + " N.m, max " +
      payload.posture.sweep.maxNm + " N.m, elbow contribution peaks at " + payload.posture.sweep.peakElbowDeg + " deg.");
    L.push("");
    L.push("## Scope");
    L.push("");
    for (const d of payload.scope) L.push("- " + d);
    L.push("");
    L.push("SHA-256 (canonical JSON): `" + sha256 + "`");
    return L.join("\n");
  }

  /* ---------- Integrity verification ---------- */
  function verifyDigest(state, presentedHex) {
    const expected = digestFor(state).sha256;
    const presented = typeof presentedHex === "string" ? presentedHex.trim().toLowerCase() : "";
    return { ok: /^[0-9a-f]{64}$/.test(presented) && presented === expected, expected, presented };
  }

  function verifyExportIntegrity(text) {
    if (typeof text !== "string" || !text.trim()) return { ok: false, reason: "empty input" };
    let doc;
    try { doc = JSON.parse(text); } catch (_) { return { ok: false, reason: "invalid JSON" }; }
    if (!doc || typeof doc !== "object" || !doc.integrity || typeof doc.integrity.canonicalJsonSha256 !== "string") {
      return { ok: false, reason: "missing integrity block" };
    }
    const presented = doc.integrity.canonicalJsonSha256.toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(presented)) return { ok: false, reason: "malformed digest" };
    const { integrity, ...rest } = doc;
    const expected = sha256Hex(canonicalJson(rest));
    return { ok: expected === presented, expected, presented };
  }

  /* ---------- #shs= bookmark codec ----------
     Explicit key-value fields with a fixed order and a whitelist
     character set, so nothing inside a hash can smuggle structure.
     Decoding is fail-closed: any malformed, unknown, duplicate,
     out-of-range or inconsistent field rejects the whole bookmark. */
  const BOOKMARK_PREFIX = "shs=";
  const BOOKMARK_KEYS = ["v", "t", "f", "e", "x", "a", "b"];
  const BOOKMARK_FIELD_RE = /^([a-z])=([A-Za-z0-9._-]{1,40})$/;

  function bookmarkNumber(v) {
    const t = (+v).toFixed(3);
    const trimmed = t.replace(/\.?0+$/, "");
    return trimmed === "" || trimmed === "-0" ? "0" : trimmed;
  }

  function encodeBookmarkHash(state) {
    const s = normalizeLabState(state);
    return "#" + BOOKMARK_PREFIX + [
      "v=1", "t=" + s.trajectory, "f=" + s.profile,
      "e=" + bookmarkNumber(s.enterMm), "x=" + bookmarkNumber(s.exitMm),
      "a=" + bookmarkNumber(s.armDeg), "b=" + bookmarkNumber(s.elbowDeg)
    ].join("&");
  }

  function decodeBookmarkHash(input) {
    const fail = reason => ({ ok: false, reason });
    if (typeof input !== "string") return fail("bookmark must be a string");
    let h = input.trim();
    if (h.startsWith("#")) h = h.slice(1);
    if (!h) return fail("empty bookmark");
    if (h.length > MAX_HASH_LEN) return fail("bookmark too long");
    if (!h.startsWith(BOOKMARK_PREFIX)) return fail("missing shs= prefix");
    const body = h.slice(BOOKMARK_PREFIX.length);
    if (!body) return fail("missing bookmark fields");
    const pairs = body.split("&");
    if (pairs.length !== BOOKMARK_KEYS.length) return fail("expected " + BOOKMARK_KEYS.length + " fields");
    const seen = Object.create(null);
    for (const pair of pairs) {
      const m = BOOKMARK_FIELD_RE.exec(pair);
      if (!m) return fail("malformed field " + JSON.stringify(pair.slice(0, 24)));
      if (seen[m[1]] !== undefined) return fail("duplicate field " + m[1]);
      seen[m[1]] = m[2];
    }
    for (const k of BOOKMARK_KEYS) if (seen[k] === undefined) return fail("missing field " + k);
    if (seen.v !== "1") return fail("unsupported bookmark version");
    if (!TRAJECTORY_IDS.includes(seen.t)) return fail("unknown trajectory");
    if (!FILTER_IDS.includes(seen.f)) return fail("unknown filter profile");
    const num = {};
    for (const k of ["e", "x", "a", "b"]) {
      const v = Number(seen[k]);
      if (!finite(v)) return fail("non-numeric field " + k);
      num[k] = v;
    }
    if (num.e < STATE_LIMITS.enterMinMm || num.e > STATE_LIMITS.enterMaxMm) return fail("enter threshold out of range");
    if (num.x <= num.e || num.x > STATE_LIMITS.exitMaxMm) return fail("exit must exceed enter within range");
    if (num.a < 0 || num.a > STATE_LIMITS.armMaxDeg) return fail("arm angle out of range");
    if (num.b < 0 || num.b > STATE_LIMITS.elbowMaxDeg) return fail("elbow angle out of range");
    return {
      ok: true,
      state: {
        trajectory: seen.t, profile: seen.f,
        enterMm: num.e, exitMm: num.x, armDeg: num.a, elbowDeg: num.b
      }
    };
  }

  /* ---------- In-page deterministic self-tests ---------- */
  const SELF_TESTS = [
    {
      id: "sha256-empty", name: "SHA-256 known answer: empty string",
      run() {
        const got = sha256Hex("");
        const want = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        return { passed: got === want, detail: got.slice(0, 16) + "..." };
      }
    },
    {
      id: "sha256-abc", name: "SHA-256 known answer: abc",
      run() {
        const got = sha256Hex("abc");
        const want = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        return { passed: got === want, detail: got.slice(0, 16) + "..." };
      }
    },
    {
      id: "sha256-nist", name: "SHA-256 known answer: two-block NIST message",
      run() {
        const got = sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
        const want = "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1";
        return { passed: got === want, detail: got.slice(0, 16) + "..." };
      }
    },
    {
      id: "sha256-utf8", name: "SHA-256 UTF-8 multibyte encoding",
      run() {
        const got = sha256Hex("hand rig: 25 joints, écran");
        const want = "7174e5900263c794da122cb5f77194339920b8c4f395b1fc5c5cf9f04506fa5d";
        return { passed: got === want, detail: got.slice(0, 16) + "..." };
      }
    },
    {
      id: "euro-nan-guard", name: "1-Euro NaN guard holds the previous estimate",
      run() {
        const kin = requireK();
        const f = new kin.OneEuroFilter({ freq: 90, minCutoff: 1.2, beta: 0.007, dCutoff: 1.0 });
        f.filter(10, 0);
        const prev = f.filter(11, 11.1);
        const nanOut = f.filter(NaN, 22.2);
        const infOut = f.filter(Infinity, 33.3);
        return { passed: nanOut === prev && infOut === prev && Number.isFinite(prev), detail: "held " + prev.toFixed(4) };
      }
    },
    {
      id: "euro-backward-t", name: "1-Euro rejects non-increasing timestamps",
      run() {
        const kin = requireK();
        const f = new kin.OneEuroFilter({ freq: 90, minCutoff: 1.2, beta: 0.007, dCutoff: 1.0 });
        f.filter(10, 100);
        const prev = f.filter(12, 111.1);
        const back = f.filter(999, 50);
        const same = f.filter(999, 111.1);
        return { passed: back === prev && same === prev, detail: "held " + prev.toFixed(4) };
      }
    },
    {
      id: "ema-nan-hold", name: "EMA holds its estimate on NaN and backward timestamps",
      run() {
        const f = new EmaFilter({ alpha: 0.12 });
        f.filter(50, 0); f.filter(52, 11.1);
        const prev = f.filter(54, 22.2);
        const nanOut = f.filter(NaN, 33.3);
        const back = f.filter(999, 5);
        return { passed: nanOut === prev && back === prev && Number.isFinite(prev), detail: "held " + prev.toFixed(4) };
      }
    },
    {
      id: "fsm-chatter", name: "Hysteresis band stops pinch chatter inside enter/exit",
      run() {
        const kin = requireK();
        const fsm = new kin.PinchFSM({ enterThresholdMm: 20, exitThresholdMm: 28 });
        let transitions = 0;
        fsm.onTransition(() => transitions++);
        const seq = [50, 26, 19, 21, 24, 22, 26, 23, 25, 27, 22, 24];
        for (const d of seq) fsm.update(d);
        const st = fsm.state;
        return {
          passed: st === "DRAGGING" && transitions === 3,
          detail: st + " after " + transitions + " transitions"
        };
      }
    },
    {
      id: "fsm-invalid-reset", name: "FSM resets on NaN, negative and missing input",
      run() {
        const kin = requireK();
        const fsm = new kin.PinchFSM({ enterThresholdMm: 20, exitThresholdMm: 28 });
        fsm.update(15);
        const a = fsm.update(NaN);
        fsm.update(15);
        const b = fsm.update(-3);
        fsm.update(15);
        const c = fsm.update(undefined);
        return { passed: a === "IDLE" && b === "IDLE" && c === "IDLE", detail: "all resets -> IDLE" };
      }
    },
    {
      id: "rotation-invariance", name: "Rigid wrist rotation preserves all pairwise distances",
      run() {
        const kin = requireK();
        const base = kin.buildBaseHandJoints("right");
        const posed = kin.applyPosePreset(base, "palm-up", "right");
        const names = Object.keys(base);
        let maxErr = 0;
        for (let i = 0; i < names.length; i++) {
          for (let j = i + 1; j < names.length; j++) {
            maxErr = Math.max(maxErr, Math.abs(kin.distMm(base[names[i]], base[names[j]]) - kin.distMm(posed[names[i]], posed[names[j]])));
          }
        }
        return { passed: maxErr < 1e-9, detail: "max drift " + maxErr.toExponential(2) + " mm" };
      }
    },
    {
      id: "moment-monotonic-arm", name: "Shoulder moment rises monotonically with arm angle",
      run() {
        const sweep = sweepShoulderMoment({ armSteps: 10, elbowSteps: 10 });
        return { passed: sweep.monotonicArm === true, detail: "checked " + sweep.armSteps + "x" + sweep.elbowSteps };
      }
    },
    {
      id: "moment-elbow-peak", name: "Elbow contribution peaks at 90 deg, not at the sweep edge",
      run() {
        const sweep = sweepShoulderMoment({ armSteps: 6, elbowSteps: 13 });
        return { passed: sweep.peakElbowDeg === 90, detail: "peak at " + sweep.peakElbowDeg + " deg" };
      }
    },
    {
      id: "csv-formula-escape", name: "CSV cells cannot carry a spreadsheet formula",
      run() {
        const hostile = ["=CMD()", "+SUM(A1:A9)", "@ref", "  padded", "\ttab", "-1+1"];
        const ok = hostile.every(h => csvCell(h)[0] === "'");
        const numeric = csvCell(-12.5) === "-12.5";
        return { passed: ok && numeric, detail: hostile.length + " hostile cells prefixed" };
      }
    },
    {
      id: "digest-parity", name: "One digest across JSON, CSV, Markdown and the live fingerprint",
      run() {
        const st = normalizeLabState({ trajectory: "step-saccade-grab" });
        const { sha256 } = digestFor(st);
        const jsonHas = exportJson(st).includes(sha256);
        const csvHas = exportCsv(st).includes(sha256);
        const mdHas = exportMarkdown(st).includes(sha256);
        return { passed: jsonHas && csvHas && mdHas, detail: sha256.slice(0, 16) + "..." };
      }
    },
    {
      id: "tamper-detected", name: "Tamper check catches a mutated export",
      run() {
        const st = normalizeLabState({ trajectory: "pinch-chatter-boundary" });
        const json = exportJson(st);
        const mutated = json.replace(/"jitterRmsMm":\s*([0-9.]+)/, (m, n) => '"jitterRmsMm": ' + (parseFloat(n) + 0.5));
        const res = verifyExportIntegrity(mutated);
        const intact = verifyExportIntegrity(json);
        return { passed: intact.ok === true && res.ok === false, detail: res.expected ? res.expected.slice(0, 12) + " vs " + res.presented.slice(0, 12) : "reject" };
      }
    },
    {
      id: "hash-roundtrip", name: "#shs= bookmark round-trips every field",
      run() {
        const st = { trajectory: "tracking-dropout-recovery", profile: "one-euro-fast", enterMm: 18.5, exitMm: 30.25, armDeg: 45, elbowDeg: 96 };
        const dec = decodeBookmarkHash(encodeBookmarkHash(st));
        return {
          passed: dec.ok === true && JSON.stringify(dec.state) === JSON.stringify(normalizeLabState(st)),
          detail: encodeBookmarkHash(st).slice(0, 40) + "..."
        };
      }
    },
    {
      id: "hash-fail-closed", name: "#shs= rejects malformed and hostile hashes",
      run() {
        const hostile = [
          "", "#", "shs=", "#other=1", "#shs=v=1&t=x&f=y&e=1&x=0&a=0&b=0",
          "#shs=v=2&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=10&b=40",
          "#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=10",
          "#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=30&x=20&a=10&b=40",
          "#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=10&b=40&z=1",
          "#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=10&b=400",
          "#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=10&b=40&__proto__=x",
          "#shs=" + "v=1&".repeat(200) + "t=micro-tremor-hover&f=ema-heavy&e=20&x=28&a=10&b=40",
          "#shs=v=1&t=<script>&f=ema-heavy&e=20&x=28&a=10&b=40",
          "#shs=v=1&t=micro-tremor-hover&f=ema-heavy&e=NaN&x=28&a=10&b=40"
        ];
        const allRejected = hostile.every(h => decodeBookmarkHash(h).ok === false);
        return { passed: allRejected, detail: hostile.length + " hostile hashes rejected" };
      }
    },
    {
      id: "determinism", name: "Trajectory generation and digest are byte-stable",
      run() {
        const a = generateTrajectory("step-saccade-grab");
        const b = generateTrajectory("step-saccade-grab");
        const ha = sha256Hex(canonicalJson(a.frames));
        const hb = sha256Hex(canonicalJson(b.frames));
        const d1 = digestFor({ trajectory: "micro-tremor-hover" }).sha256;
        const d2 = digestFor({ trajectory: "micro-tremor-hover" }).sha256;
        return { passed: ha === hb && d1 === d2, detail: ha.slice(0, 16) + "..." };
      }
    },
    {
      id: "comparator-coverage", name: "Comparator reports all five profiles with finite jitter",
      run() {
        const cmp = runComparison("micro-tremor-hover", { enterMm: 20, exitMm: 28 });
        const ok = cmp.rows.length === 5 && cmp.rows.every(r => finite(r.metrics.jitterRmsMm) && r.metrics.jitterRmsMm >= 0);
        return { passed: ok, detail: cmp.rows.length + " profiles" };
      }
    },
    {
      id: "normalize-shape", name: "State normalizer survives hostile caller shapes",
      run() {
        const weird = { trajectory: new Set(["x"]), profile: 123, enterMm: "25", exitMm: "abc", armDeg: -5, elbowDeg: 999, extra: { deep: true } };
        const n = normalizeLabState(weird);
        const ok = n.trajectory === LAB_DEFAULTS.trajectory && n.profile === LAB_DEFAULTS.profile &&
          n.enterMm === 25 && n.exitMm === 28 && n.armDeg === 0 && n.elbowDeg === 120;
        return { passed: ok, detail: JSON.stringify(n) };
      }
    }
  ];

  function runSelfTests() {
    return SELF_TESTS.map(t => {
      try {
        const r = t.run() || {};
        return { id: t.id, name: t.name, passed: r.passed === true, detail: String(r.detail ?? "") };
      } catch (err) {
        return { id: t.id, name: t.name, passed: false, detail: "threw: " + (err && err.message ? err.message : String(err)) };
      }
    });
  }

  return {
    VERSION, SAMPLE_RATE_HZ, DT_MS, FRAME_COUNT, RECOVERY_BAND_MM, MAX_HASH_LEN, STATE_LIMITS, LAB_DEFAULTS,
    FILTER_PROFILES, FILTER_ORDER, FILTER_IDS,
    TRAJECTORIES, TRAJECTORY_ORDER, TRAJECTORY_IDS,
    EmaFilter, RawFilter, makeFilter, mulberry32,
    generateTrajectory, trajectoryInfo,
    runTrajectory, runComparison, computeMetrics, channelLagMs, longestDropoutRun, paretoFrontierIds,
    quasiStaticShoulderMomentNm, sweepShoulderMoment,
    utf8Bytes, sha256Bytes, sha256Hex,
    canonicalJson, normalizeLabState, buildExportPayload, digestFor,
    exportJson, exportCsv, exportMarkdown, csvCell,
    verifyDigest, verifyExportIntegrity,
    encodeBookmarkHash, decodeBookmarkHash,
    SELF_TESTS, runSelfTests,
    kinematicsAvailable, requireK, DISCLOSURES
  };
});

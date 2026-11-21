/* =============================================================
   app.js - SpatialHand Studio controller.
   Web Audio cues, gesture choreography, mouse and keyboard input,
   WebXR hand input bridge, scene and telemetry exports.
   ============================================================= */

const APP_VERSION = "1.2.0";
const CONE_APEX = Object.freeze({ x: 0, y: -0.28, z: 0.18 });
const TELEMETRY_MAX_FRAMES = 1800;
const MAX_DOWNLOAD_BYTES = 4 * 1024 * 1024;

const state = {
  viewMode: "passthrough",
  gesturePreset: "pinch",
  handWorldX: 0.08, handWorldY: -0.02, handWorldZ: -0.08,
  handYaw: 0,
  isPinching: false,
  pinchHysteresisMm: 20,
  euroCutoff: 1.2,
  curvedRadius: 0.85,
  grabbedWindowId: null,
  hoverWindowId: null,
  benchRunning: false,
  benchProgress: 0,
  benchResult: null,
  xrActive: false,
  webcamActive: false,
  webcamError: null,
  radialActive: false,
  radialIndex: -1,
  radialShownAt: 0,
  radialCommitted: false,
  radialSelectionOverride: null,
  timerRunning: false,
  timerRemaining: 1500,
  timerDeadlineMs: null,
  timerTickAccum: 0,
  spatialAudio: true,
  /* WCAG 2.1.4: single character-key shortcuts must be turn-off-able. */
  keyboardShortcuts: true,
  fps: 0,
  frameCount: 0,
  lastFpsTime: typeof performance !== "undefined" ? performance.now() : 0,
  lastFrameNow: null,
  lastTelemetryAt: 0,
  model: null
};

/* Three demonstration surfaces drawn on the curved guide. The text is
   static sample content, not a code editor, node graph or task app. */
const windows = [
  {
    id: "code-studio",
    title: "Code editor surface",
    accent: "#38BDF8",
    x: -0.36, y: 0.04, z: -0.32, w: 0.42, h: 0.26, yaw: 0.42,
    lines: [
      "> js/xr-hand-kinematics.js",
      "> class OneEuroFilter {",
      ">   alpha(cutoff, dt)",
      "> class PinchFSM { update(mm) }",
      "> 25 joints, 5 finger chains",
      "> postureMoments() -> N.m",
      "> wristOrientationDeg() -> deg",
      "> validateJointHierarchy()"
    ],
    enabled: true, snapProgress: 0, scrollOffset: 0
  },
  {
    id: "node-graph",
    title: "Node graph surface",
    accent: "#A855F7",
    x: 0, y: 0.08, z: -0.48, w: 0.44, h: 0.28, yaw: 0,
    lines: [
      "[joint poses] -> [sample gate]",
      "[sample gate] -> [1-Euro bank]",
      "[1-Euro bank] -> [pinch FSM]",
      "[pinch FSM] -> [grab / release]",
      "[wrist basis] -> [pitch, roll]",
      "[XRHand] -> [25 joint names]",
      "[curved guide] -> [snap ring]",
      "[frame stream] -> [CSV report]"
    ],
    enabled: true, snapProgress: 0, scrollOffset: 0
  },
  {
    id: "sprint-kanban",
    title: "Focus timer surface",
    accent: "#10B981",
    x: 0.38, y: 0.02, z: -0.28, w: 0.40, h: 0.25, yaw: -0.38,
    lines: [
      "[ ] filter regression cases",
      "[ ] hysteresis transitions",
      "[ ] coordinate transform tests",
      "[ ] CSV export round trip",
      "[ ] DOM wiring checks",
      "[ ] node --check pass"
    ],
    enabled: true, snapProgress: 0, scrollOffset: 0
  }
];

// ---------- Audio ----------
let audioCtx = null;
let audioUnlocked = false;
function ensureAudio() {
  if (audioCtx) return audioCtx;
  // Chrome refuses an AudioContext created before a user gesture and logs a
  // console warning, so sounds requested during boot are skipped instead.
  if (!audioUnlocked) return null;
  if (typeof window === "undefined") return null;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try { audioCtx = new Ctor(); } catch (_) { return null; }
  return audioCtx;
}
function unlockAudio() { audioUnlocked = true; }
function playTone({ freq = 880, duration = 0.09, type = "sine", gain = 0.18, pan = 0, sweepTo } = {}) {
  try {
    if (!state.spatialAudio) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    if (ctx.state === "suspended" && ctx.resume) ctx.resume();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, ctx.currentTime + duration);
    g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    /* Localize the cue at the event azimuth. Prefer a PannerNode,
       then StereoPanner, then direct routing. */
    let node = osc;
    if (ctx.createPanner) {
      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 0.4;
      const az = (pan || 0) * Math.PI / 2;
      const r = 0.8;
      const px = Math.sin(az) * r, py = 0, pz = -Math.cos(az) * r;
      if (panner.positionX) {
        panner.positionX.value = px; panner.positionY.value = py; panner.positionZ.value = pz;
      } else if (panner.setPosition) {
        panner.setPosition(px, py, pz);
      }
      node.connect(panner);
      panner.connect(g);
    } else if (ctx.createStereoPanner) {
      const sp = ctx.createStereoPanner();
      sp.pan.value = pan || 0;
      node.connect(sp);
      sp.connect(g);
    } else {
      node.connect(g);
    }
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (_) { /* Audio is optional; never block interaction. */ }
}
const SFX = {
  pinchStart(pan = 0) { playTone({ freq: 660, sweepTo: 990, duration: 0.12, gain: 0.16, type: "sine", pan }); },
  pinchRelease(pan = 0) { playTone({ freq: 520, sweepTo: 360, duration: 0.14, gain: 0.13, type: "triangle", pan }); },
  hover(pan = 0) { playTone({ freq: 1200, duration: 0.06, gain: 0.07, type: "sine", pan }); },
  snap(pan = 0) { playTone({ freq: 880, duration: 0.18, gain: 0.15, type: "sine", sweepTo: 1320, pan }); },
  click(pan = 0) { playTone({ freq: 900, duration: 0.05, gain: 0.11, type: "sine", pan }); },
  radialTick(i = 0) { playTone({ freq: 780 + i * 90, duration: 0.05, gain: 0.10, type: "sine", pan: Math.sin(i / 6 * Math.PI * 2) * 0.8 }); },
  radialCommit(i = 0) { playTone({ freq: 980 + i * 120, duration: 0.16, gain: 0.15, type: "sine", sweepTo: 1400, pan: Math.sin(i / 6 * Math.PI * 2) * 0.8 }); },
  timerTick(pan = 0) { playTone({ freq: 1600, duration: 0.03, gain: 0.05, type: "sine", pan }); },
  timerDone() { playTone({ freq: 1046, duration: 0.35, gain: 0.16, type: "sine", pan: -0.5 }); },
  benchTick() { playTone({ freq: 700, duration: 0.04, gain: 0.08 }); },
  benchDone() { playTone({ freq: 640, duration: 0.22, gain: 0.16, sweepTo: 960 }); }
};

// ---------- DOM refs ----------
let renderer = null, animId = 0;
let baseJointsRight = null, baseJointsLeft = null;
let pinchFSM = null, filterBank = null;
let suppressHoverSfxUntil = 0;
let keyboardPinchHeld = false;
const telemetryFrames = [];

function el(id) {
  return typeof document !== "undefined" && document.getElementById ? document.getElementById(id) : null;
}
function setText(id, value) {
  const node = el(id);
  if (node) node.textContent = value;
}
function nowMs() {
  return typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
}
function raf(cb) {
  return typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : 0;
}
function cancelRaf(id) {
  if (typeof cancelAnimationFrame === "function" && id) cancelAnimationFrame(id);
}

function isInteractiveTarget(target) {
  const selector = 'button, input, select, textarea, [role="switch"], [contenteditable], a[href]';
  if (target && typeof target.closest === "function") return !!target.closest(selector);
  for (let node = target; node; node = node.parentElement || node.parentNode) {
    const tag = String(node.tagName || "").toLowerCase();
    if (["button", "input", "select", "textarea"].includes(tag) || node.isContentEditable) return true;
    if (typeof node.getAttribute === "function" &&
        (node.getAttribute("role") === "switch" || node.getAttribute("contenteditable") !== null ||
         (tag === "a" && node.getAttribute("href") !== null))) return true;
  }
  return false;
}

function initDOM() {
  renderJointTree("pinch");

  const pinchSlider = el("pinch-threshold");
  if (pinchSlider) {
    pinchSlider.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      state.pinchHysteresisMm = v;
      setText("pinch-threshold-val", v.toFixed(0) + " mm enter / " + (v + 8).toFixed(0) + " mm exit");
      if (pinchFSM) pinchFSM.setThresholds(v, v + 8);
    });
  }
  const cutoffSlider = el("euro-cutoff");
  if (cutoffSlider) {
    cutoffSlider.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      state.euroCutoff = v;
      setText("euro-cutoff-val", v.toFixed(1) + " Hz");
      if (filterBank) filterBank.updateCutoff(v);
    });
  }
  const radiusSlider = el("desk-radius");
  if (radiusSlider) {
    radiusSlider.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      if (!Number.isFinite(v)) return;
      state.curvedRadius = v;
      setText("desk-radius-val", v.toFixed(2) + " m");
      if (renderer) renderer.curvedRadius = v;
    });
  }

  bindToggle("toggle-comfort-cone", v => { if (renderer) renderer.comfortCone.enabled = v; });
  bindToggle("toggle-spatial-audio", v => { state.spatialAudio = v; });
  bindToggle("toggle-keyboard-shortcuts", v => {
    state.keyboardShortcuts = v;
    if (!v && keyboardPinchHeld) {
      keyboardPinchHeld = false;
      state.isPinching = false;
      updatePinchButton();
    }
  });

  document.querySelectorAll("[data-app-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.appToggle;
      const w = windows.find(x => x.id === id);
      if (!w) return;
      w.enabled = !w.enabled;
      btn.classList.toggle("on", w.enabled);
      btn.textContent = w.enabled ? "On" : "Off";
      if (btn.setAttribute) btn.setAttribute("aria-pressed", String(w.enabled));
      SFX.click();
    });
  });

  document.querySelectorAll("[data-view-mode]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-view-mode]").forEach(b => {
        b.classList.remove("active");
        if (b.setAttribute) b.setAttribute("aria-selected", "false");
      });
      btn.classList.add("active");
      if (btn.setAttribute) btn.setAttribute("aria-selected", "true");
      state.viewMode = btn.dataset.viewMode;
      if (renderer) renderer.viewMode = state.viewMode;
      SFX.click();
      toast("Drawing style: " + String(btn.textContent || state.viewMode).trim());
    });
  });

  document.querySelectorAll("[data-gesture]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-gesture]").forEach(c => {
        c.classList.remove("active");
        if (c.setAttribute) c.setAttribute("aria-pressed", "false");
      });
      chip.classList.add("active");
      if (chip.setAttribute) chip.setAttribute("aria-pressed", "true");
      const preset = chip.dataset.gesture;
      state.gesturePreset = preset;
      runGestureDemo(preset);
      /* Camera access is requested only by this explicit chip click. */
      if (preset === "mouse") startWebcamHand();
      else stopWebcamHand();
      SFX.click();
    });
  });

  const pinchBtn = el("btn-pinch-toggle");
  if (pinchBtn) pinchBtn.addEventListener("click", () => {
    state.isPinching = !state.isPinching;
    if (state.isPinching) SFX.pinchStart(); else SFX.pinchRelease();
    updatePinchButton();
  });
  const resetBtn = el("btn-reset-view");
  if (resetBtn) resetBtn.addEventListener("click", () => { resetScene(); SFX.click(); toast("Workspace reset"); });

  const exportBtn = el("btn-export-manifest");
  if (exportBtn) exportBtn.addEventListener("click", exportManifest);
  const telemetryBtn = el("btn-export-telemetry");
  if (telemetryBtn) telemetryBtn.addEventListener("click", exportTelemetryCsv);
  const resetTelemetryBtn = el("btn-reset-telemetry");
  if (resetTelemetryBtn) resetTelemetryBtn.addEventListener("click", resetTelemetry);
  const benchBtn = el("btn-run-bench");
  if (benchBtn) benchBtn.addEventListener("click", runBenchmark);
  const xrBtn = el("btn-enter-xr");
  if (xrBtn) xrBtn.addEventListener("click", enterXR);

  const canvas = el("spatial-canvas");
  if (canvas) {
    let dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener("mousedown", e => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      const hit = hitTestWindow(e);
      if (hit && !e.shiftKey) {
        state.grabbedWindowId = hit.id;
        hit.snapProgress = 0;
        state.isPinching = true;
        updatePinchButton();
        SFX.pinchStart();
      } else if (!e.shiftKey) {
        updateHandFromMouse(e);
      }
    });
    canvas.addEventListener("mousemove", e => {
      if (dragging && state.grabbedWindowId) {
        const w = windows.find(x => x.id === state.grabbedWindowId);
        if (w) {
          w.x += (e.clientX - lastX) * 0.0012;
          w.z += (e.clientY - lastY) * 0.0012;
          const centreZ = 0.02 - state.curvedRadius;
          const curR = Math.hypot(w.x, w.z - centreZ);
          const angle = Math.atan2(w.x, w.z - centreZ);
          const diff = Math.abs(curR - state.curvedRadius);
          const onArc = Math.abs(angle) <= 34 * Math.PI / 180;
          w.snapProgress = onArc && diff < 0.08 ? (1 - diff / 0.08) : 0;
          if (w.snapProgress > 0.85 && diff < 0.015) snapToCurvedGuide(w);
        }
      } else if (dragging && e.shiftKey) {
        if (renderer) renderer.worldYaw += (e.clientX - lastX) * 0.008;
      } else if (dragging) {
        updateHandFromMouse(e);
      } else {
        const hit = hitTestWindow(e);
        const prevHover = state.hoverWindowId;
        state.hoverWindowId = hit ? hit.id : null;
        if (hit && !prevHover && nowMs() > suppressHoverSfxUntil) SFX.hover();
        updateHandFromMouse(e);
      }
      lastX = e.clientX; lastY = e.clientY;
    });
    if (typeof window !== "undefined") window.addEventListener("mouseup", () => {
      if (dragging && state.grabbedWindowId) {
        const w = windows.find(x => x.id === state.grabbedWindowId);
        if (w && w.snapProgress > 0.5) SFX.snap(); else SFX.pinchRelease();
      }
      dragging = false;
      state.grabbedWindowId = null;
      state.isPinching = false;
      updatePinchButton();
    });
    canvas.addEventListener("mouseleave", () => { state.hoverWindowId = null; });

    canvas.addEventListener("touchstart", e => {
      if (e.preventDefault) e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      lastX = t.clientX; lastY = t.clientY;
      const hit = hitTestWindow(t);
      if (hit) {
        state.grabbedWindowId = hit.id;
        state.isPinching = true;
        updatePinchButton();
        SFX.pinchStart();
      }
      updateHandFromMouse(t);
    }, { passive: false });
    canvas.addEventListener("touchmove", e => {
      if (e.preventDefault) e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      if (state.grabbedWindowId) {
        const w = windows.find(x => x.id === state.grabbedWindowId);
        if (w) { w.x += (t.clientX - lastX) * 0.0012; w.z += (t.clientY - lastY) * 0.0012; }
      } else updateHandFromMouse(t);
      lastX = t.clientX; lastY = t.clientY;
    }, { passive: false });
    const releaseTouch = e => {
      if (e.preventDefault) e.preventDefault();
      const hadGrab = state.grabbedWindowId !== null;
      state.grabbedWindowId = null;
      state.isPinching = false;
      updatePinchButton();
      /* Play the release cue after clearing state, not after reading it. */
      if (hadGrab) SFX.pinchRelease();
    };
    canvas.addEventListener("touchend", releaseTouch, { passive: false });
    canvas.addEventListener("touchcancel", releaseTouch, { passive: false });
  }

  if (typeof window !== "undefined") {
    window.addEventListener("keydown", e => {
      if (e.defaultPrevented || isInteractiveTarget(e.target)) return;
      const tag = e.target && e.target.tagName ? String(e.target.tagName).toLowerCase() : "";
      const typing = tag === "input" || tag === "textarea" || tag === "select" || !!(e.target && e.target.isContentEditable);
      if (!typing && state.radialActive && ["ArrowLeft", "ArrowRight", "Enter"].includes(e.key)) {
        e.preventDefault();
        if (e.key === "Enter") {
          const action = RADIAL_ACTIONS[state.radialIndex];
          if (action) action.action();
          state.radialCommitted = true;
        } else {
          const step = e.key === "ArrowRight" ? 1 : -1;
          state.radialSelectionOverride = (state.radialIndex + step + RADIAL_ACTIONS.length) % RADIAL_ACTIONS.length;
          state.radialIndex = state.radialSelectionOverride;
        }
        return;
      }
      const chordless = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (state.keyboardShortcuts && chordless && !e.shiftKey && e.code === "Space" && !typing && !state.xrActive) {
        e.preventDefault();
        if (e.repeat) return;
        if (!state.isPinching) {
          keyboardPinchHeld = true;
          state.isPinching = true; updatePinchButton(); SFX.pinchStart();
        }
      } else if (state.keyboardShortcuts && chordless && (e.key === "r" || e.key === "R") && !typing && !e.repeat && !state.xrActive) {
        resetScene(); toast("Workspace reset (R)");
      }
    });
    window.addEventListener("keyup", e => {
      /* A held keyboard pinch must release on keyup no matter where focus moved;
         otherwise the pinch sticks until the next Space tap. */
      if (e.code !== "Space" || !keyboardPinchHeld || state.xrActive) return;
      e.preventDefault();
      keyboardPinchHeld = false;
      state.isPinching = false;
      updatePinchButton();
      SFX.pinchRelease();
      if (state.grabbedWindowId) {
        const w = windows.find(x => x.id === state.grabbedWindowId);
        if (w && w.snapProgress > 0.5) SFX.snap();
        state.grabbedWindowId = null;
      }
    });
  }
  updateXRSupport();
}

function bindToggle(id, onChange) {
  const t = el(id);
  if (!t) return;
  const toggle = () => {
    t.classList.toggle("on");
    const on = t.classList.contains("on");
    if (t.setAttribute) t.setAttribute("aria-checked", String(on));
    onChange(on);
    SFX.click();
  };
  t.addEventListener("click", toggle);
  t.addEventListener("keydown", e => {
    if (e.key === "Enter" || e.code === "Space") { if (e.preventDefault) e.preventDefault(); toggle(); }
  });
}

function updatePinchButton() {
  const btn = el("btn-pinch-toggle");
  if (!btn) return;
  btn.textContent = state.isPinching ? "Holding pinch (Space)" : "Hold pinch (Space)";
  btn.disabled = state.xrActive;
  btn.style.background = state.isPinching ? "linear-gradient(135deg,#A855F7,#38BDF8)" : "";
  btn.style.color = state.isPinching ? "#fff" : "";
}

function hitTestWindow(evt) {
  const canvas = el("spatial-canvas");
  if (!canvas || !renderer || !evt) return null;
  const rect = canvas.getBoundingClientRect();
  const mx = evt.clientX - rect.left;
  const my = evt.clientY - rect.top;
  let best = null, bestDepth = Infinity;
  for (const w of windows) {
    if (!w.enabled) continue;
    const quad = renderer.windowQuad(w);
    if (!quad) continue;
    const sides = quad.map((a, i) => {
      const b = quad[(i + 1) % quad.length];
      return (b.x - a.x) * (my - a.y) - (b.y - a.y) * (mx - a.x);
    });
    const inside = sides.every(v => v >= -1e-8) || sides.every(v => v <= 1e-8);
    const depth = renderer.project({ x: w.x, y: w.y, z: w.z }).depth;
    if (inside && depth < bestDepth) { bestDepth = depth; best = w; }
  }
  return best;
}

function updateHandFromMouse(evt) {
  const canvas = el("spatial-canvas");
  if (!canvas || !evt) return;
  const rect = canvas.getBoundingClientRect();
  const nx = Math.max(-1, Math.min(1, ((evt.clientX - rect.left) / (rect.width || 1)) * 2 - 1));
  const ny = Math.max(-1, Math.min(1, ((evt.clientY - rect.top) / (rect.height || 1)) * 2 - 1));
  state.handWorldX = nx * 0.45;
  state.handWorldZ = -ny * 0.30 - 0.12;
  state.handWorldY = -0.04 + ny * 0.04;
  state.handYaw = nx * 0.35;
}

// ---------- Renderer and kinematics loop ----------
function initRenderer() {
  const canvas = el("spatial-canvas");
  if (!canvas || typeof SpatialRenderer === "undefined") return;
  renderer = new SpatialRenderer(canvas);
  renderer.windows = windows.filter(w => w.enabled);
  renderer.curvedRadius = state.curvedRadius;
  renderer.viewMode = state.viewMode;
  renderer.comfortCone.apex = { ...CONE_APEX };

  baseJointsRight = buildBaseHandJoints("right");
  baseJointsLeft = buildBaseHandJoints("left");
  pinchFSM = new PinchFSM({ enterThresholdMm: state.pinchHysteresisMm, exitThresholdMm: state.pinchHysteresisMm + 8 });
  filterBank = new FilterBank({ freq: 60, minCutoff: state.euroCutoff, beta: 0.007, dCutoff: 1.0 });
  state.model = typeof postureMoments === "function" ? postureMoments() : null;
  if (state.model) renderer.modelSummary = { reductionPct: state.model.metrics.reductionPct };

  pinchFSM.onTransition((from, to) => {
    if (to === "PINCH_START") SFX.pinchStart();
    if (from === "DRAGGING" && to === "RELEASE") SFX.pinchRelease();
  });

  runGestureDemo("pinch");
  refreshTelemetryHUD();
  animId = raf(frame);
}

let demoPhase = 0, demoPreset = "pinch";
function runGestureDemo(preset) {
  const stretched = windows.find(w => w.baseW !== undefined);
  if (stretched && preset !== "stretch") restoreWindowSize(stretched);
  demoPreset = preset;
  demoPhase = 0;
  state.radialSelectionOverride = null;
  renderJointTree(preset);
  const names = {
    pinch: "Pinch grab", stretch: "Two-hand stretch", "palm-up": "Palm-up palette",
    poke: "Index poke scroll", mouse: "Mouse and touch"
  };
  toast("Gesture preset: " + (names[preset] || preset));
}
function restoreWindowSize(w) {
  if (w.baseW === undefined) return;
  w.w = w.baseW; w.h = w.baseH;
  delete w.baseW; delete w.baseH; delete w.stretchScale;
}

function computeHandJointsForPreset(preset, phase) {
  if (preset === "mouse") return applyPosePreset(baseJointsRight, state.isPinching ? "pinch" : "open", "right");
  if (preset === "pinch") {
    const cycle = (Math.sin(phase * 2.4) + 1) / 2;
    return applyPosePreset(baseJointsRight, cycle > 0.55 ? "pinch" : "open", "right");
  }
  if (preset === "stretch") {
    return applyPosePreset(baseJointsRight, Math.sin(phase * 1.6) > 0 ? "open" : "pinch", "right");
  }
  if (preset === "palm-up") return applyPosePreset(baseJointsRight, "palm-up", "right");
  if (preset === "poke") return applyPosePreset(baseJointsRight, "poke", "right");
  return applyPosePreset(baseJointsRight, "open", "right");
}

function snapToCurvedGuide(w) {
  const centreZ = 0.02 - state.curvedRadius;
  const halfArc = 34 * Math.PI / 180;
  const angle = Math.max(-halfArc, Math.min(halfArc, Math.atan2(w.x, w.z - centreZ)));
  w.x = Math.sin(angle) * state.curvedRadius;
  w.z = Math.cos(angle) * state.curvedRadius + centreZ;
  w.snapProgress = 1;
}

/* Radial quick actions summoned by the palm-up preset. Six entries. */
const RADIAL_ACTIONS = [
  { icon: "D", label: "Dock all", action: () => {
      windows.forEach(w => {
        if (!w.enabled) return;
        snapToCurvedGuide(w);
      });
      SFX.snap(); toast("Radial: windows docked to the curved guide");
    } },
  { icon: "S", label: "Start focus", action: () => startFocusTimer() },
  { icon: "P", label: "Pause focus", action: () => pauseFocusTimer() },
  { icon: "R", label: "Reset layout", action: () => { resetScene(); toast("Radial: layout reset"); } },
  { icon: "A", label: "Audio on or off", action: () => toggleSpatialAudio() },
  { icon: "E", label: "Export manifest", action: () => exportManifest() }
];

function applyTwoHandStretch(separationM) {
  if (!Number.isFinite(separationM) || separationM < 0) return null;
  const w = windows.find(x => x.id === "node-graph") || windows[0];
  if (!w) return null;
  const scale = Math.min(1.6, Math.max(0.6, separationM / 0.36));
  if (w.baseW === undefined) { w.baseW = w.w; w.baseH = w.h; }
  w.w = +(w.baseW * scale).toFixed(3);
  w.h = +(w.baseH * scale).toFixed(3);
  w.stretchScale = scale;
  return { w, scale };
}

function startFocusTimer() {
  if (state.timerRunning) return;
  state.timerRunning = true;
  state.timerDeadlineMs = nowMs() + state.timerRemaining * 1000;
  state.timerTickAccum = 0;
  toast("Focus countdown started");
}
function pauseFocusTimer() {
  if (!state.timerRunning) return;
  state.timerRemaining = Math.max(0, (state.timerDeadlineMs - nowMs()) / 1000);
  state.timerRunning = false;
  state.timerDeadlineMs = null;
  toast("Focus countdown paused");
}
function toggleSpatialAudio() {
  state.spatialAudio = !state.spatialAudio;
  const t = el("toggle-spatial-audio");
  if (t) {
    t.classList.toggle("on", state.spatialAudio);
    if (t.setAttribute) t.setAttribute("aria-checked", String(state.spatialAudio));
  }
  toast("Spatial audio " + (state.spatialAudio ? "on" : "off"));
}

function frame(now) {
  animId = raf(frame);
  const t = Number.isFinite(now) ? now : nowMs();
  const dt = state.lastFrameNow === null ? 0.016 : Math.min(0.1, Math.max(0, (t - state.lastFrameNow) / 1000));
  state.lastFrameNow = t;
  demoPhase += dt;

  state.frameCount++;
  if (t - state.lastFpsTime > 500) {
    state.fps = Math.round(state.frameCount * 1000 / (t - state.lastFpsTime));
    state.frameCount = 0;
    state.lastFpsTime = t;
  }

  /* A live WebXR session owns the shared pinch state machine. The desktop
     loop reads its state and the XR joint mirror, and never advances it. */
  const xrOwnsInput = state.xrActive && xr.joints.right !== null;
  const rightJoints = state.xrActive ? xr.joints.right
    : state.isPinching ? applyPosePreset(baseJointsRight, "pinch", "right")
    : computeHandJointsForPreset(demoPreset, demoPhase);

  let hx = state.handWorldX, hy = state.handWorldY, hz = state.handWorldZ, hyaw = state.handYaw;
  if (xrOwnsInput && xr.wristWorld) {
    hx = xr.wristWorld.x; hy = xr.wristWorld.y; hz = xr.wristWorld.z;
    hyaw = 0; /* XR joints are already world-space; a stale desktop yaw would tilt the mirror ray. */
  } else if (demoPreset === "mouse" && webcam.active && webcam.hand.px !== null) {
    /* Selfie cameras are unmirrored in the raw frame; mirror the centroid. */
    const px = 1 - webcam.hand.px;
    hx = (px - 0.5) * 0.9;
    hy = -0.04 + (0.5 - webcam.hand.py) * 0.30;
    hz = -0.08;
    hyaw = (px - 0.5) * 0.5;
  } else if (demoPreset === "stretch") {
    hx = 0.18 + Math.sin(demoPhase * 1.2) * 0.06;
    hz = -0.10 + Math.cos(demoPhase * 1.2) * 0.04;
  } else if (demoPreset !== "mouse" && !xrOwnsInput) {
    hx = 0.08 + Math.sin(demoPhase * 0.7) * 0.04;
    hy = -0.02 + Math.sin(demoPhase * 0.9) * 0.015;
    hz = -0.08 + Math.cos(demoPhase * 0.6) * 0.03;
    hyaw = Math.sin(demoPhase * 0.5) * 0.12;
  }

  let rawPinchMm = NaN;
  let filteredPinch = NaN;
  let pinchState;
  if (state.xrActive) {
    rawPinchMm = xr.lastPinchMm.right ?? NaN;
    filteredPinch = xr.lastFilteredPinchMm.right ?? NaN;
    pinchState = pinchFSM.state;
  } else {
    const tt = rightJoints["thumb-tip"], it = rightJoints["index-finger-tip"];
    if (tt && it) rawPinchMm = distMm(tt, it);
    filteredPinch = filterBank.apply("pinch", "dist", rawPinchMm, t);
    pinchState = pinchFSM.update(filteredPinch);
  }

  const orientation = typeof wristOrientationDeg === "function" ? wristOrientationDeg(rightJoints, "right") : null;
  const wristPitch = orientation ? orientation.pitchDeg : NaN;
  const wristRoll = orientation ? orientation.rollDeg : NaN;
  const residualMm = filteredPinch - rawPinchMm;
  const model = state.model || (typeof postureMoments === "function" ? postureMoments() : null);
  const fatigue = model ? model.metrics : null;

  /* Palm-up preset sweeps the radial selector from the derived roll angle. */
  if (demoPreset === "palm-up" && !xrOwnsInput) {
    if (!state.radialActive) { state.radialActive = true; state.radialShownAt = demoPhase; SFX.hover(); }
    const sweep = (wristRoll + 40) / 80;
    state.radialIndex = state.radialSelectionOverride ?? Math.max(0, Math.min(RADIAL_ACTIONS.length - 1,
      Math.floor(Math.min(0.999, Math.max(0, sweep)) * RADIAL_ACTIONS.length)));
    if (demoPhase - state.radialShownAt > 2.6 && !state.radialCommitted) {
      const act = RADIAL_ACTIONS[state.radialIndex];
      if (act) { SFX.radialCommit(state.radialIndex); act.action(); }
      /* One commit per activation: actions like Reset layout clear radialActive,
         which would otherwise re-arm and loop forever. */
      state.radialCommitted = true;
    }
  } else if (state.radialActive || state.radialCommitted) {
    state.radialActive = false;
    state.radialIndex = -1;
    state.radialCommitted = false;
  }

  const hands = [];
  const rightHand = rightJoints ? { handedness: "right", joints: rightJoints, jointsAreWorld: xrOwnsInput,
    worldX: hx, worldY: hy, worldZ: hz, yaw: hyaw, pinchState } : null;
  if (rightHand) hands.push(rightHand);
  if (demoPreset === "stretch" && !state.xrActive) {
    const leftJoints = applyPosePreset(baseJointsLeft, Math.sin(demoPhase * 1.2) > 0 ? "open" : "pinch", "left");
    hands.push({ handedness: "left", joints: leftJoints, worldX: -hx, worldY: hy, worldZ: hz, yaw: -hyaw, pinchState });
  }

  let stretchInfo = null;
  if (demoPreset === "stretch" && !state.xrActive && hands.length === 2) {
    const contacts = hands.map(hand => renderer.handPinchWorld(hand));
    const separationM = distMm(contacts[0], contacts[1]) / 1000;
    const sized = applyTwoHandStretch(separationM);
    if (sized) stretchInfo = { ...sized, separationM, contacts };
  }

  let pokeInfo = null;
  if (demoPreset === "poke" && !xrOwnsInput) {
    const target = windows.find(w => w.id === (state.hoverWindowId || "code-studio")) || windows[0];
    const dir = Math.sin(demoPhase * 1.4) > 0 ? 1 : -1;
    target.scrollOffset = (target.scrollOffset || 0) + dir * 30 * dt;
    const maxScroll = Math.max(0, (target.lines ? target.lines.length : 0) - 4) * 11;
    target.scrollOffset = Math.max(0, Math.min(maxScroll, target.scrollOffset));
    pokeInfo = { windowId: target.id, offset: target.scrollOffset };
  }

  if (state.timerRunning) {
    const remaining = Math.max(0, (state.timerDeadlineMs - t) / 1000);
    const elapsed = Math.max(0, state.timerRemaining - remaining);
    state.timerRemaining = Math.min(state.timerRemaining, remaining);
    state.timerTickAccum += elapsed;
    if (state.timerRemaining === 0) {
      state.timerRunning = false;
      state.timerDeadlineMs = null;
      SFX.timerDone();
      toast("Focus countdown reached zero");
    } else if (state.timerTickAccum >= 1) {
      state.timerTickAccum %= 1;
      SFX.timerTick(0.4);
    }
  }
  const timerWin = windows.find(w => w.id === "sprint-kanban");
  if (timerWin) {
    const mm = String(Math.floor(state.timerRemaining / 60)).padStart(2, "0");
    const ss = String(Math.floor(state.timerRemaining % 60)).padStart(2, "0");
    timerWin.title = "Focus timer " + mm + ":" + ss + (state.timerRunning ? " (running)" : " (paused)");
  }

  updateHUD({ filteredPinch, rawPinchMm, residualMm, wristPitch, wristRoll, fatigue, pinchState });
  const wrist = rightHand && rightHand.joints.wrist ? renderer.handJointWorld(rightHand, rightHand.joints.wrist) : null;
  recordFrame({
    t, source: state.xrActive ? "xr-hand" : demoPreset, pinchMm: filteredPinch, pinchState,
    wrist,
    reach: wrist ? { x: wrist.x - CONE_APEX.x, y: wrist.y - CONE_APEX.y, z: wrist.z - CONE_APEX.z } : null
  });
  if (t - state.lastTelemetryAt > 500) { state.lastTelemetryAt = t; refreshTelemetryHUD(); }

  renderer.hands = hands;
  renderer.windows = windows.filter(w => w.enabled);
  renderer.grabbedWindow = state.grabbedWindowId;
  renderer.hoverWindow = state.hoverWindowId;
  renderer.curvedRadius = state.curvedRadius;
  renderer.radial = state.radialActive ? { items: RADIAL_ACTIONS, index: state.radialIndex, phase: demoPhase } : null;
  renderer.stretch = stretchInfo;
  renderer.poke = pokeInfo;
  renderer.webcam = { active: webcam.active, error: state.webcamError };
  renderer.renderFrame(t);
}

function updateHUD({ filteredPinch, rawPinchMm, residualMm, wristPitch, wristRoll, fatigue, pinchState }) {
  const pinchText = Number.isFinite(filteredPinch) ? filteredPinch.toFixed(1) + " mm" : "unavailable";
  setText("kv-pinch", pinchText);
  const pitch = Number.isFinite(wristPitch) ? wristPitch.toFixed(1) : "unavailable";
  const roll = Number.isFinite(wristRoll) ? wristRoll.toFixed(1) : "unavailable";
  setText("kv-pitch-inline", pitch + " deg");
  setText("kv-roll-inline", roll + " deg");
  setText("kv-basis", "pitch " + pitch + " / roll " + roll);
  setText("kv-cutoff", state.euroCutoff.toFixed(1) + " Hz");
  setText("kv-residual", Number.isFinite(residualMm) ? residualMm.toFixed(2) + " mm" : "unavailable");
  setText("kv-fps", state.fps + " fps");
  setText("stat-fps", String(state.fps));
  setText("kv-state", pinchState);

  if (fatigue) {
    setText("kv-rested-inline", fatigue.restedNm.toFixed(2) + " N.m");
    setText("kv-elevated-inline", fatigue.elevatedNm.toFixed(2) + " N.m");
    setText("kv-reduction", fatigue.reductionPct.toFixed(1) + "%");
    setText("stat-reduction", fatigue.reductionPct.toFixed(1) + "%");
    setText("bench-reduction", fatigue.reductionPct.toFixed(1) + "% between the two modelled postures");
  }
  setText("stat-joints", String(typeof XR_JOINT_ORDER !== "undefined" ? XR_JOINT_ORDER.length : 25));
  const pinchEl = el("kv-pinch");
  if (pinchEl) {
    pinchEl.className = "kv-value " + (pinchState === "DRAGGING" || pinchState === "PINCH_START"
      ? "green" : pinchState === "HOVER" ? "amber" : "");
  }
  void rawPinchMm;
}

function renderJointTree(preset) {
  const container = el("joint-tree");
  if (!container || typeof FINGER_GROUPS === "undefined") return;
  const groups = [
    { label: "Wrist", joints: ["wrist"] },
    { label: "Thumb", joints: FINGER_GROUPS.thumb },
    { label: "Index", joints: FINGER_GROUPS.index },
    { label: "Middle", joints: FINGER_GROUPS.middle },
    { label: "Ring", joints: FINGER_GROUPS.ring },
    { label: "Pinky", joints: FINGER_GROUPS.pinky }
  ];
  const highlight = name => {
    if (name === "wrist") return true;
    if (preset === "pinch") return name === "thumb-tip" || name === "index-finger-tip";
    if (preset === "poke") return name.startsWith("index-finger-");
    if (preset === "palm-up") return name === "wrist" || name.endsWith("metacarpal");
    return name.endsWith("-tip");
  };
  container.innerHTML = groups.map(g =>
    '<div style="margin-top:6px"><b>' + g.label + '</b>: ' +
    g.joints.map(j => '<span data-joint="' + j + '"' + (highlight(j) ? ' class="j-active"' : '') + '>' + j + '</span>').join(" · ") +
    '</div>'
  ).join("");
}

// ---------- Telemetry ----------
function recordFrame(frameData) {
  telemetryFrames.push(frameData);
  if (telemetryFrames.length > TELEMETRY_MAX_FRAMES) telemetryFrames.shift();
}
function resetTelemetry() {
  telemetryFrames.length = 0;
  refreshTelemetryHUD();
  toast("Recorded frames cleared");
}
function buildSessionReportNow() {
  if (typeof HandTelemetry === "undefined") return null;
  return HandTelemetry.buildSessionReport(telemetryFrames, { source: demoPreset, halfAngleDeg: 30 });
}
function refreshTelemetryHUD() {
  const report = buildSessionReportNow();
  if (!report) return;
  setText("tel-frames", String(report.frameCount));
  setText("tel-mean", report.pinch.meanMm.toFixed(1) + " mm");
  setText("tel-std", report.pinch.stdDevMm.toFixed(1) + " mm");
  setText("tel-path", report.wrist.pathEfficiency.toFixed(4));
  setText("tel-cone", String(report.comfortCone.violations));
  setText("tel-false-starts", String(report.pinchState.falseStarts));
  const box = el("telemetry-report");
  if (box) box.textContent = JSON.stringify(report, null, 2);
}
function exportTelemetryCsv() {
  if (typeof HandTelemetry === "undefined") { toast("Telemetry module unavailable"); return; }
  const csv = HandTelemetry.exportFramesCsv(telemetryFrames, { source: demoPreset });
  downloadText("spatial-hand-studio-frames.csv", csv, "text/csv");
  const box = el("telemetry-report");
  if (box) box.style.display = "block";
  toast("Frame CSV exported: " + telemetryFrames.length + " frames");
  SFX.click();
}

// ---------- Exports and posture comparison ----------
function buildManifest() {
  const model = state.model || (typeof postureMoments === "function" ? postureMoments() : null);
  return {
    app: "SpatialHand Studio",
    version: APP_VERSION,
    format: "spatial-hand-scene-v1",
    formatNote: "Custom interchange description. No SDK import was verified.",
    sdkImportVerified: false,
    createdAt: new Date().toISOString(),
    renderer: { engine: "Canvas 2D", projection: "pinhole perspective", webgl: false },
    xr: {
      available: typeof navigator !== "undefined" && !!navigator.xr,
      sessionActive: state.xrActive,
      mode: xr.mode || null,
      referenceSpace: xr.referenceSpace || null,
      handTrackingRequested: xr.handTrackingRequested,
      requiredFeaturesWhenRequested: ["hand-tracking", "local-floor"],
      optionalFeaturesWhenRequested: ["dom-overlay"]
    },
    viewMode: state.viewMode,
    keyboardShortcuts: state.keyboardShortcuts,
    comfortCone: { halfAngleDeg: 30, apexM: { ...CONE_APEX }, enabled: renderer ? renderer.comfortCone.enabled : true },
    curvedGuide: { radiusM: state.curvedRadius, halfArcDeg: 34, centreZM: 0.02 - state.curvedRadius },
    windows: windows.map(w => ({
      id: w.id, title: w.title,
      positionM: { x: w.x, y: w.y, z: w.z },
      sizeM: { w: w.w, h: w.h },
      yawDeg: +(w.yaw * 180 / Math.PI).toFixed(1),
      enabled: w.enabled, accent: w.accent
    })),
    hand: {
      jointCount: typeof XR_JOINT_ORDER !== "undefined" ? XR_JOINT_ORDER.length : 25,
      joints: typeof XR_JOINT_ORDER !== "undefined" ? XR_JOINT_ORDER.slice() : [],
      pinch: {
        enterMm: state.pinchHysteresisMm,
        exitMm: state.pinchHysteresisMm + 8,
        filterMinCutoffHz: state.euroCutoff,
        filterBeta: 0.007,
        filterDerivativeCutoffHz: 1.0
      }
    },
    ergonomics: model ? {
      type: "illustrative quasi-static two-segment shoulder moment",
      restedPostureDeg: model.restedPostureDeg,
      elevatedPostureDeg: model.elevatedPostureDeg,
      restedTorqueNm: model.restedNm,
      elevatedTorqueNm: model.elevatedNm,
      reductionPct: model.metrics.reductionPct,
      note: model.metrics.note
    } : null,
    telemetry: buildSessionReportNow()
  };
}

function downloadText(filename, text, mime) {
  if (typeof document === "undefined" || typeof URL === "undefined" || !URL.createObjectURL || !document.createElement) return false;
  if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_DOWNLOAD_BYTES) { toast("Export too large"); return false; }
  try {
    const blob = new Blob([text], { type: mime || "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    if (a.click) a.click();
    setTimeout(() => { if (URL.revokeObjectURL) URL.revokeObjectURL(url); }, 2000);
    return true;
  } catch (_) { return false; }
}

function exportManifest() {
  SFX.click();
  const manifest = buildManifest();
  const pretty = JSON.stringify(manifest, null, 2);
  let box = el("manifest-box");
  const anchor = el("manifest-anchor");
  if (!box && anchor && typeof document !== "undefined") {
    box = document.createElement("pre");
    box.id = "manifest-box";
    box.className = "manifest-box";
    anchor.appendChild(box);
  }
  if (box) { box.textContent = pretty; box.style.display = "block"; }
  const ok = downloadText("spatial-hand-studio-manifest.json", pretty, "application/json");
  toast(ok ? "Scene manifest exported" : "Scene manifest shown inline (download unavailable)");
}

function runBenchmark() {
  if (state.benchRunning) return;
  state.benchRunning = true;
  state.benchProgress = 0;
  state.benchResult = null;
  const bar = el("bench-progress-bar");
  const status = el("bench-status");
  const resultBox = el("bench-result");
  if (resultBox) resultBox.style.display = "none";
  if (status) status.textContent = "Recomputing the two posture moments over a 6 s animation.";
  const startedAt = nowMs();
  const durationMs = 6000;
  let lastTickStep = -1;

  function tick() {
    if (typeof postureMoments === "function") state.model = postureMoments();
    const elapsed = nowMs() - startedAt;
    state.benchProgress = Math.min(1, elapsed / durationMs);
    if (bar) bar.style.width = (state.benchProgress * 100).toFixed(1) + "%";
    const step = Math.floor(state.benchProgress * 10);
    if (step !== lastTickStep && step < 10) { lastTickStep = step; SFX.benchTick(); }
    if (state.benchProgress < 1) { raf(tick); return; }

    state.benchRunning = false;
    const model = state.model || (typeof postureMoments === "function" ? postureMoments() : null);
    if (!model) { if (status) status.textContent = "Model unavailable."; return; }
    const f = model.metrics;
    state.benchResult = f;
    if (status) status.textContent = "Complete. Values are model outputs, not a timed trial.";
    if (resultBox) {
      resultBox.style.display = "block";
      resultBox.innerHTML =
        '<div class="bench-row"><span>Rested posture</span><strong>' + f.restedNm.toFixed(2) + ' N.m</strong></div>' +
        '<div class="bench-row"><span>Elevated posture</span><strong>' + f.elevatedNm.toFixed(2) + ' N.m</strong></div>' +
        '<div class="bench-row"><span>Modelled reduction</span><strong>' + f.reductionPct.toFixed(1) + '%</strong></div>' +
        '<div class="bench-row"><span>Scope</span><strong>Two fixed postures</strong></div>';
    }
    SFX.benchDone();
    toast("Posture comparison: " + f.reductionPct.toFixed(1) + "% modelled reduction");
  }
  raf(tick);
}

function resetScene() {
  const initial = [
    { x: -0.36, y: 0.04, z: -0.32, yaw: 0.42 },
    { x: 0, y: 0.08, z: -0.48, yaw: 0 },
    { x: 0.38, y: 0.02, z: -0.28, yaw: -0.38 }
  ];
  windows.forEach((w, i) => {
    w.x = initial[i].x; w.y = initial[i].y; w.z = initial[i].z; w.yaw = initial[i].yaw;
    w.enabled = true; w.snapProgress = 0; w.scrollOffset = 0;
    restoreWindowSize(w);
  });
  if (typeof document !== "undefined") document.querySelectorAll("[data-app-toggle]").forEach(b => {
    b.classList.add("on");
    b.textContent = "On";
    if (b.setAttribute) b.setAttribute("aria-pressed", "true");
  });
  state.handWorldX = 0.08; state.handWorldY = -0.02; state.handWorldZ = -0.08; state.handYaw = 0;
  state.isPinching = false; state.grabbedWindowId = null; state.hoverWindowId = null;
  keyboardPinchHeld = false;
  state.radialActive = false; state.radialIndex = -1;
  state.timerRemaining = 1500; state.timerRunning = false; state.timerTickAccum = 0; state.timerDeadlineMs = null;
  if (renderer) { renderer.worldYaw = 0; renderer.radial = null; renderer.stretch = null; renderer.poke = null; }
  updatePinchButton();
}

// ---------- Camera centroid experiment ----------
/* A fixed YCbCr threshold detector on an 80x60 downsample. This is a rough
   colour centroid, not an anatomical hand detector. Lighting and skin
   appearance change the result. Frames stay in the browser. */
const webcam = {
  video: null, stream: null, work: null,
  active: false, sampling: false, pending: false, generation: 0,
  hand: { px: null, py: null, spread: 0 },
  rafId: 0
};

async function startWebcamHand() {
  if (webcam.active || webcam.pending) return;
  if (typeof navigator === "undefined" || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    state.webcamError = "No camera API. Mouse and touch control remain available.";
    toast(state.webcamError);
    return;
  }
  webcam.pending = true;
  const generation = ++webcam.generation;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240, facingMode: "user" }, audio: false });
    if (generation !== webcam.generation || document.hidden) {
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    webcam.stream = stream;
    const video = document.createElement("video");
    video.autoplay = true; video.muted = true; video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    if (generation !== webcam.generation || document.hidden) {
      video.srcObject = null;
      stream.getTracks().forEach(t => t.stop());
      return;
    }
    webcam.video = video;
    if (typeof window !== "undefined") window.__spatialHandWebcamVideo = video;
    webcam.work = document.createElement("canvas");
    webcam.work.width = 80; webcam.work.height = 60;
    webcam.active = true;
    state.webcamActive = true;
    state.webcamError = null;
    sampleWebcam();
    toast("Camera centroid experiment active. Mouse and touch also work.");
  } catch (err) {
    if (generation !== webcam.generation) return;
    stopWebcamHand();
    state.webcamError = err && err.name === "NotAllowedError"
      ? "Camera permission denied. Mouse and touch control remain available."
      : "Camera unavailable. Mouse and touch control remain available.";
    toast(state.webcamError);
  } finally {
    if (generation === webcam.generation) webcam.pending = false;
  }
}

function stopWebcamHand() {
  webcam.generation++;
  webcam.pending = false;
  webcam.sampling = false;
  webcam.active = false;
  state.webcamActive = false;
  webcam.hand.px = null; webcam.hand.py = null;
  if (typeof window !== "undefined") {
    window.__spatialHandWebcamHand = null;
    window.__spatialHandWebcamVideo = null;
  }
  if (webcam.rafId) { cancelRaf(webcam.rafId); webcam.rafId = 0; }
  if (webcam.stream) { webcam.stream.getTracks().forEach(t => t.stop()); webcam.stream = null; }
  if (webcam.video) { webcam.video.srcObject = null; webcam.video = null; }
}

function sampleWebcam() {
  if (!webcam.active) return;
  webcam.rafId = raf(sampleWebcam);
  const video = webcam.video;
  if (!video || video.readyState < 2 || webcam.sampling) return;
  webcam.sampling = true;
  try {
    const wc = webcam.work;
    const wctx = wc.getContext("2d", { willReadFrequently: true });
    wctx.drawImage(video, 0, 0, wc.width, wc.height);
    const data = wctx.getImageData(0, 0, wc.width, wc.height).data;
    let sumX = 0, sumY = 0, n = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = 0; y < wc.height; y++) {
      for (let x = 0; x < wc.width; x++) {
        const i = (y * wc.width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
        const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
        if (cb >= 77 && cb <= 127 && cr >= 133 && cr <= 173) {
          sumX += x; sumY += y; n++;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (n > 40) {
      webcam.hand.px = sumX / n / wc.width;
      webcam.hand.py = sumY / n / wc.height;
      webcam.hand.spread = ((maxX - minX) / wc.width) * ((maxY - minY) / wc.height);
      if (typeof window !== "undefined") window.__spatialHandWebcamHand = webcam.hand;
    } else {
      webcam.hand.px = null; webcam.hand.py = null;
      if (typeof window !== "undefined") window.__spatialHandWebcamHand = null;
    }
  } catch (_) { /* Skip a transient frame read error. */ }
  webcam.sampling = false;
}

// ---------- WebXR input bridge ----------
const xr = {
  session: null, refSpace: null, rafId: 0,
  mode: null, referenceSpace: null, handTrackingRequested: false,
  lastPinchMm: { left: null, right: null },
  lastFilteredPinchMm: { left: null, right: null },
  joints: { left: null, right: null },
  wristWorld: null, pending: false, generation: 0, lastSampleTime: null
};

/* WebXR local-floor uses a right-handed frame with -Z forward. A 180 degree
   rotation about +Y maps that to the desktop rig's +Z forward without
   reflection, so all distances are preserved. The Y offset maps the floor
   origin to the desk reference height. */
function xrPoseToDesk(p) {
  /* Normalise negative zero so exported coordinates compare cleanly. */
  const x = p.x === 0 ? 0 : -p.x;
  const z = p.z === 0 ? 0 : -p.z;
  return { x, y: p.y - 0.9, z };
}

function setXRButton(text, active) {
  const btn = el("btn-enter-xr");
  if (!btn) return;
  btn.classList.toggle("is-active", !!active);
  const label = btn.querySelector ? btn.querySelector(".btn-label") : null;
  if (label) label.textContent = text;
}

async function updateXRSupport() {
  const badge = el("xr-support-status");
  if (!badge) return;
  if (typeof navigator === "undefined" || !navigator.xr) {
    badge.textContent = "WebXR: unavailable (desktop simulator)";
    return;
  }
  try {
    const arOK = await navigator.xr.isSessionSupported("immersive-ar").catch(() => false);
    const vrOK = await navigator.xr.isSessionSupported("immersive-vr").catch(() => false);
    badge.textContent = arOK ? "WebXR: immersive-ar reported"
      : vrOK ? "WebXR: immersive-vr reported"
      : "WebXR: no immersive mode reported";
  } catch (_) {
    badge.textContent = "WebXR: support check failed";
  }
}

async function requestXRSession(mode) {
  const base = { optionalFeatures: ["dom-overlay"], domOverlay: { root: typeof document !== "undefined" ? document.body : null } };
  try {
    const session = await navigator.xr.requestSession(mode, {
      ...base,
      requiredFeatures: ["local-floor", "hand-tracking"]
    });
    return { session, handTrackingRequested: true };
  } catch (requiredError) {
    /* Some runtimes reject hand-tracking as a required feature. Retry with
       both features optional so controller input still works, and record
       that hand tracking was not guaranteed. An explicit denial is not a
       feature problem, so it surfaces immediately instead of re-prompting. */
    if (requiredError && (requiredError.name === "NotAllowedError" || requiredError.name === "SecurityError")) {
      throw requiredError;
    }
    try {
      const session = await navigator.xr.requestSession(mode, {
        optionalFeatures: ["local-floor", "hand-tracking", "dom-overlay"],
        domOverlay: base.domOverlay
      });
      return { session, handTrackingRequested: false };
    } catch (fallbackError) {
      throw fallbackError;
    }
  }
}

async function enterXR() {
  if (xr.pending) return;
  if (state.xrActive && xr.session) { toast("WebXR session already active"); return; }
  if (typeof navigator === "undefined" || !navigator.xr) {
    setXRButton("Desktop simulator (WebXR unavailable)", false);
    toast("WebXR unavailable. Desktop simulator remains active.");
    return;
  }
  xr.pending = true;
  const generation = ++xr.generation;
  let mode = null;
  try {
    const arOK = await navigator.xr.isSessionSupported("immersive-ar").catch(() => false);
    const vrOK = await navigator.xr.isSessionSupported("immersive-vr").catch(() => false);
    if (arOK) mode = "immersive-ar"; else if (vrOK) mode = "immersive-vr";
  } catch (_) { mode = null; }
  if (generation !== xr.generation || document.hidden) { xr.pending = false; return; }
  if (!mode) {
    xr.pending = false;
    setXRButton("Desktop simulator (no immersive mode)", false);
    toast("No immersive mode reported. Desktop simulator remains active.");
    return;
  }
  try {
    const { session, handTrackingRequested } = await requestXRSession(mode);
    if (generation !== xr.generation || document.hidden) {
      if (typeof session.end === "function") await session.end();
      return;
    }
    xr.session = session;
    session.addEventListener("end", () => { if (xr.session === session) onXRSessionEnd(); });
    xr.mode = mode;
    xr.handTrackingRequested = handTrackingRequested;
    state.xrActive = true;
    keyboardPinchHeld = false;
    state.isPinching = false;
    state.grabbedWindowId = null;
    updatePinchButton();
    if (filterBank) filterBank.reset();
    if (pinchFSM) pinchFSM.reset();
    setXRButton("WebXR session active", true);
    toast("WebXR " + mode + " session started" + (handTrackingRequested ? "" : " (hand tracking optional)"));

    let refSpace = null;
    for (const type of ["local-floor", "local", "viewer"]) {
      try { refSpace = await session.requestReferenceSpace(type); xr.referenceSpace = type; break; }
      catch (_) { /* Try the next available reference space. */ }
    }
    if (generation !== xr.generation || document.hidden) {
      if (xr.session === session && typeof session.end === "function") await session.end();
      return;
    }
    if (!refSpace) throw new Error("No XR reference space available");
    xr.refSpace = refSpace;
    const onFrame = (time, frameObj) => {
      if (xr.session !== session || !state.xrActive) return;
      xr.rafId = session.requestAnimationFrame(onFrame);
      processXRHandFrame(time, frameObj);
    };
    xr.rafId = session.requestAnimationFrame(onFrame);
  } catch (e) {
    const failedSession = xr.session;
    if (failedSession && typeof failedSession.end === "function") {
      try { await failedSession.end(); } catch (_) {}
    }
    onXRSessionEnd();
    setXRButton("Request WebXR Hand Session", false);
    toast("WebXR request failed: " + ((e && e.message) || String(e)));
  } finally {
    xr.pending = false;
  }
}

function onXRSessionEnd() {
  const endedSession = xr.session;
  xr.generation++;
  xr.pending = false;
  xr.lastSampleTime = null;
  xr.handTrackingRequested = false;
  state.xrActive = false;
  xr.session = null;
  xr.refSpace = null;
  xr.mode = null;
  xr.referenceSpace = null;
  xr.joints.left = null;
  xr.joints.right = null;
  xr.wristWorld = null;
  xr.lastPinchMm.left = null; xr.lastPinchMm.right = null;
  xr.lastFilteredPinchMm.left = null; xr.lastFilteredPinchMm.right = null;
  if (xr.rafId) {
    if (endedSession && typeof endedSession.cancelAnimationFrame === "function") endedSession.cancelAnimationFrame(xr.rafId);
    xr.rafId = 0;
  }
  if (filterBank) filterBank.reset();
  if (pinchFSM) pinchFSM.reset();
  keyboardPinchHeld = false;
  state.isPinching = false;
  state.grabbedWindowId = null;
  updatePinchButton();
  state.lastFrameNow = null;
  setXRButton("Request WebXR Hand Session", false);
  toast("WebXR session ended. Desktop simulator resumed.");
}

/* Sample available XRHand joints, keep native reference-space coordinates
   for distance calculations, and mirror a rotated copy into the Canvas 2D
   rig. Nonfinite poses, missing wrists and missing API methods are skipped. */
function processXRHandFrame(time, frameObj) {
  if (!xr.session || !xr.refSpace || !frameObj || !Number.isFinite(time)) return;
  if (xr.lastSampleTime !== null && time <= xr.lastSampleTime) return;
  xr.lastSampleTime = time;
  const sources = (xr.session.inputSources && typeof xr.session.inputSources[Symbol.iterator] === "function")
    ? xr.session.inputSources : [];
  let rightTracked = false;

  for (const src of sources) {
    const hand = src && src.hand;
    if (!hand || typeof hand.get !== "function") continue;
    const handedness = src.handedness === "left" ? "left" : src.handedness === "right" ? "right" : null;
    if (!handedness) continue;
    const joints = {};
    let sampled = 0;
    for (const jointName of XR_JOINT_ORDER) {
      let jt;
      try { jt = hand.get(jointName); } catch (_) { continue; }
      if (!jt || typeof frameObj.getJointPose !== "function") continue;
      let pose;
      try { pose = frameObj.getJointPose(jt, xr.refSpace); } catch (_) { continue; }
      if (!pose || !pose.transform || !pose.transform.position) continue;
      const p = pose.transform.position;
      if (![p.x, p.y, p.z].every(Number.isFinite)) continue;
      joints[jointName] = { x: p.x, y: p.y, z: p.z };
      sampled++;
    }
    if (sampled === 0 || !joints.wrist) continue;
    xr.joints[handedness] = joints;

    const tt = joints["thumb-tip"], it = joints["index-finger-tip"];
    const pinchMm = tt && it ? distMm(tt, it) : NaN;
    if (!Number.isFinite(pinchMm)) continue;
    xr.lastPinchMm[handedness] = pinchMm;

    const filtered = filterBank.apply("xr-" + handedness, "dist", pinchMm, time);
    xr.lastFilteredPinchMm[handedness] = filtered;

    if (handedness === "right") {
      rightTracked = true;
      const st = pinchFSM.update(filtered);
      if (st === "PINCH_START") pulseXRHandHaptics(src);
      const desk = xrPoseToDesk(joints.wrist);
      xr.wristWorld = desk;
      /* Mirror the native joint map through the same rotation for drawing. */
      const mirrored = {};
      for (const [name, p] of Object.entries(joints)) mirrored[name] = xrPoseToDesk(p);
      xr.joints.right = mirrored;
      state.handWorldX = desk.x; state.handWorldY = desk.y; state.handWorldZ = desk.z;
    }
  }
  if (!rightTracked) {
    xr.joints.right = null;
    xr.wristWorld = null;
    xr.lastPinchMm.right = null;
    xr.lastFilteredPinchMm.right = null;
    if (filterBank) filterBank.resetSignal("xr-right");
    if (pinchFSM) pinchFSM.reset();
  }
}

function pulseXRHandHaptics(src) {
  try {
    const gamepad = src && src.gamepad;
    const actuator = gamepad && gamepad.hapticActuators && gamepad.hapticActuators[0];
    if (actuator && typeof actuator.pulse === "function") actuator.pulse(0.7, 40);
  } catch (_) { /* Haptics are optional. */ }
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg) {
  if (typeof document === "undefined") return;
  let t = el("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast"; t.className = "toast";
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
}

// ---------- Boot ----------
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  initDOM();
  initRenderer();
}

const SpatialHandApp = {
  APP_VERSION, CONE_APEX, state, windows, RADIAL_ACTIONS, webcam, xr, telemetryFrames,
  get renderer() { return renderer; },
  get pinchFSM() { return pinchFSM; },
  get filterBank() { return filterBank; },
  boot, initDOM, initRenderer, frame, updateHUD, renderJointTree,
  hitTestWindow, updateHandFromMouse, updatePinchButton, bindToggle, snapToCurvedGuide,
  applyTwoHandStretch, restoreWindowSize, startFocusTimer, pauseFocusTimer, toggleSpatialAudio,
  recordFrame, resetTelemetry, buildSessionReportNow, refreshTelemetryHUD, exportTelemetryCsv,
  buildManifest, downloadText, exportManifest, runBenchmark, resetScene,
  startWebcamHand, stopWebcamHand, sampleWebcam,
  xrPoseToDesk, updateXRSupport, requestXRSession, enterXR, onXRSessionEnd,
  processXRHandFrame, pulseXRHandHaptics, setXRButton,
  computeHandJointsForPreset, runGestureDemo, playTone, SFX, toast, ensureAudio
};
if (typeof module === "object" && module.exports) module.exports = SpatialHandApp;
if (typeof globalThis !== "undefined") globalThis.SpatialHandApp = SpatialHandApp;

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", boot);
  ["pointerdown", "keydown", "touchstart"].forEach(t => {
    if (typeof window !== "undefined" && window.addEventListener) window.addEventListener(t, unlockAudio, { once: true, passive: true });
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopWebcamHand(); });
  if (typeof window !== "undefined") window.addEventListener("pagehide", () => {
    stopWebcamHand();
    const session = xr.session;
    onXRSessionEnd();
    if (session && typeof session.end === "function") Promise.resolve(session.end()).catch(() => {});
  });
}

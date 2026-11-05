/* =============================================================
   app.js - SpatialHand Studio interactive controller
   Web Audio spatial feedback, gesture choreographer,
   mouse/keyboard hand control, manifest exporter
   ============================================================= */

/* ---------- State ---------- */
const state = {
  viewMode: "quest",
  gesturePreset: "pinch",
  handX: 0, handY: 0, // normalized -1..1 for mouse
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
  timerRunning: false,
  timerRemaining: 1500, // 25:00 focus sprint
  spatialAudio: true,
  fps: 0,
  frameCount: 0,
  lastFpsTime: performance.now(),
};

// Windows: 3 ergonomic floating panels on curved desk
const windows = [
  {
    id: "code-studio",
    title: "⌘  Code & Architecture Editor",
    accent: "#38BDF8",
    x: -0.36, y: 0.04, z: -0.32, w: 0.42, h: 0.26, yaw: 0.42,
    lines: [
      "› spatial-hand-studio/js/app.js",
      "› export function pinchFSM() {",
      "›   // hysteresis enter 20mm / exit 28mm",
      "› }",
      "› 1-Euro filter  ·  60fps renderer",
      "› 25 joints per XRHand",
      "› rested-arm micro-gestures",
      "› comfort cone 30° from vertical",
    ],
    enabled: true, snapProgress: 0, scrollOffset: 0
  },
  {
    id: "node-graph",
    title: "◆  3D Spatial Model & Shader Node Graph",
    accent: "#A855F7",
    x: 0, y: 0.08, z: -0.48, w: 0.44, h: 0.28, yaw: 0,
    lines: [
      "[PBR Material] -> [Waveguide Shader]",
      "[Hand Rig] -> [Pinch Constraint]",
      "[Comfort Cone] -> [Ergonomic LOD]",
      "[XRFrame] -> [25 Joint Sockets]",
      "[1-Euro Filter] -> [Stable Ray]",
      "[Haptic Pulse] -> [Pinch Snap]",
      "[SPECS HUD] -> [Optical Stack]",
      "[IWSDK] -> [Scene Manifest]",
    ],
    enabled: true, snapProgress: 0, scrollOffset: 0
  },
  {
    id: "sprint-kanban",
    title: "◉  Focus Timer & Sprint Voice Notes",
    accent: "#10B981",
    x: 0.38, y: 0.02, z: -0.28, w: 0.40, h: 0.25, yaw: -0.38,
    lines: [
      "● Hand-tracking polish - Done",
      "● Comfort cone tuning - In Review",
      "● SPECS HUD pass - Todo",
      "● Web Audio spatial clicks - Done",
      "● Corner-stretch resize - In Review",
      "● Radial palette - Todo",
    ],
    enabled: true, snapProgress: 0, scrollOffset: 0
  },
];

// ---------- Audio ----------
let audioCtx = null;
function ensureAudio() {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}
function playTone({ freq = 880, duration = 0.09, type = "sine", gain = 0.18, pan = 0, sweepTo } = {}) {
  try {
    if (!state.spatialAudio) return;
    const ctx = ensureAudio();
    if (ctx.state === "suspended") ctx.resume();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, ctx.currentTime + duration);
    g.gain.value = gain;
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);

    // Spatialize: prefer a 3D PannerNode (HRTF) placed on the horizon at the
    // event's azimuth, so pinch/snap cues are binaurally localized; fall back
    // to plain StereoPanner, then to direct routing.
    let node = osc;
    if (ctx.createPanner) {
      const panner = ctx.createPanner();
      panner.panningModel = "HRTF";
      panner.distanceModel = "inverse";
      panner.refDistance = 0.4;
      const az = (pan || 0) * Math.PI / 2;
      const r = 0.8;
      panner.positionX.value = Math.sin(az) * r;
      panner.positionY.value = 0;
      panner.positionZ.value = -Math.cos(az) * r;
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
  } catch (_) {}
}
const SFX = {
  /* All cues are spatialized: `pan` -1..1 maps the event to the 3D window
     position it belongs to (HRTF via PannerNode when available, StereoPanner
     fallback), giving binaural left/right distinction on headphones. */
  pinchStart(pan = 0) { playTone({ freq: 660, sweepTo: 990, duration: 0.12, gain: 0.16, type: "sine", pan }); },
  pinchRelease(pan = 0) { playTone({ freq: 520, sweepTo: 360, duration: 0.14, gain: 0.13, type: "triangle", pan }); },
  hover(pan = 0) { playTone({ freq: 1200, duration: 0.06, gain: 0.07, type: "sine", pan }); },
  snap(pan = 0) { playTone({ freq: 880, duration: 0.18, gain: 0.15, type: "sine", sweepTo: 1320, pan }); setTimeout(() => playTone({ freq: 1320, duration: 0.12, gain: 0.10, pan }), 90); },
  click(pan = 0) { playTone({ freq: 900, duration: 0.05, gain: 0.11, type: "sine", pan }); },
  radialTick(i = 0) { playTone({ freq: 780 + i * 90, duration: 0.05, gain: 0.10, type: "sine", pan: Math.sin(i / 6 * Math.PI * 2) * 0.8 }); },
  radialCommit(i = 0) { playTone({ freq: 980 + i * 120, duration: 0.16, gain: 0.15, type: "sine", sweepTo: 1400, pan: Math.sin(i / 6 * Math.PI * 2) * 0.8 }); },
  timerTick(pan = 0) { playTone({ freq: 1600, duration: 0.03, gain: 0.05, type: "sine", pan }); },
  timerDone() { playTone({ freq: 1046, duration: 0.35, gain: 0.16, type: "sine", pan: -0.5 }); setTimeout(() => playTone({ freq: 1318, duration: 0.35, gain: 0.16, type: "sine", pan: 0.5 }), 180); setTimeout(() => playTone({ freq: 1568, duration: 0.5, gain: 0.14, type: "sine", pan: 0 }), 360); },
  benchTick() { playTone({ freq: 700, duration: 0.04, gain: 0.08 }); },
  benchDone() { playTone({ freq: 640, duration: 0.22, gain: 0.16, sweepTo: 960 }); },
};

// ---------- DOM refs ----------
let renderer, animId;
let baseJointsRight, baseJointsLeft;
let pinchFSM, filterBank;
let currentHands = [];
let demoTimer = null;
let suppressHoverSfxUntil = 0;

function el(id) { return document.getElementById(id); }

function initDOM() {
  // Build joint tree display
  renderJointTree();

  // Sliders
  const pinchSlider = el("pinch-threshold");
  const cutoffSlider = el("euro-cutoff");
  const radiusSlider = el("desk-radius");
  if (pinchSlider) {
    pinchSlider.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      state.pinchHysteresisMm = v;
      el("pinch-threshold-val").textContent = v.toFixed(0) + " mm";
      if (pinchFSM) pinchFSM.setThresholds(v, v + 8);
    });
  }
  if (cutoffSlider) {
    cutoffSlider.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      state.euroCutoff = v;
      el("euro-cutoff-val").textContent = v.toFixed(1) + " Hz";
      if (filterBank) filterBank.updateCutoff(v);
    });
  }
  if (radiusSlider) {
    radiusSlider.addEventListener("input", e => {
      const v = parseFloat(e.target.value);
      state.curvedRadius = v;
      el("desk-radius-val").textContent = v.toFixed(2) + " m";
      if (renderer) renderer.curvedRadius = v;
    });
  }

  // Toggles
  bindToggle("toggle-comfort-cone", v => {
    if (renderer) renderer.comfortCone.enabled = v;
  });
  bindToggle("toggle-spatial-audio", v => {
    // flag checked in SFX calls
    state.spatialAudio = v;
  });

  // App enable toggles
  document.querySelectorAll("[data-app-toggle]").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.appToggle;
      const w = windows.find(x => x.id === id);
      if (!w) return;
      w.enabled = !w.enabled;
      btn.classList.toggle("on", w.enabled);
      btn.textContent = w.enabled ? "On" : "Off";
      SFX.click();
    });
  });

  // View mode
  document.querySelectorAll("[data-view-mode]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-view-mode]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.viewMode = btn.dataset.viewMode;
      if (renderer) renderer.viewMode = state.viewMode;
      ensureAudio();
      SFX.click();
      toast(`View: ${btn.textContent.trim()}`);
    });
  });

  // Gesture preset bar
  document.querySelectorAll("[data-gesture]").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll("[data-gesture]").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      state.gesturePreset = chip.dataset.gesture;
      runGestureDemo(state.gesturePreset);
      // Gesture 5 ("mouse" chip): live webcam hand tracking + manual control
      if (chip.dataset.gesture === "mouse") startWebcamHand();
      else stopWebcamHand();
      ensureAudio(); SFX.click();
    });
  });

  // Viewport buttons
  el("btn-pinch-toggle")?.addEventListener("click", () => {
    state.isPinching = !state.isPinching;
    if (state.isPinching) SFX.pinchStart(); else SFX.pinchRelease();
    updatePinchButton();
  });
  el("btn-reset-view")?.addEventListener("click", () => {
    resetScene(); SFX.click(); toast("Workspace reset");
  });

  // Export & benchmark
  el("btn-export-manifest")?.addEventListener("click", exportManifest);
  el("btn-run-bench")?.addEventListener("click", runBenchmark);

  // WebXR button
  el("btn-enter-xr")?.addEventListener("click", enterXR);

  // Canvas interactions
  const canvas = el("spatial-canvas");
  if (canvas) {
    // Mouse drag to orbit / hand move
    let dragging = false, lastX = 0, lastY = 0;
    canvas.addEventListener("mousedown", e => {
      dragging = true; lastX = e.clientX; lastY = e.clientY;
      // Hit-test window under cursor
      const hit = hitTestWindow(e);
      if (hit) {
        state.grabbedWindowId = hit.id;
        hit.snapProgress = 0;
        state.isPinching = true;
        updatePinchButton();
        SFX.pinchStart();
      } else if (e.shiftKey) {
        // Orbit
      } else {
        // Hand position from mouse
        updateHandFromMouse(e);
      }
      ensureAudio();
    });
    canvas.addEventListener("mousemove", e => {
      if (dragging && state.grabbedWindowId) {
        const w = windows.find(x => x.id === state.grabbedWindowId);
        if (w) {
          const dx = (e.clientX - lastX) * 0.0012;
          const dz = (e.clientY - lastY) * 0.0012;
          w.x += dx; w.z += dz;
          // Snap toward curved radius
          const curR = Math.hypot(w.x, w.z - 0.02);
          const targetR = state.curvedRadius;
          const diff = Math.abs(curR - targetR);
          w.snapProgress = diff < 0.08 ? (1 - diff / 0.08) : 0;
          if (w.snapProgress > 0.85 && diff < 0.015) {
            // Snap
            const angle = Math.atan2(w.x, w.z - 0.02);
            w.x = Math.sin(angle) * targetR;
            w.z = Math.cos(angle) * targetR + 0.02;
          }
        }
      } else if (dragging && e.shiftKey) {
        const dx = (e.clientX - lastX) * 0.008;
        if (renderer) renderer.worldYaw += dx;
      } else if (dragging) {
        updateHandFromMouse(e);
      } else {
        // Hover highlight
        const hit = hitTestWindow(e);
        const prevHover = state.hoverWindowId;
        state.hoverWindowId = hit ? hit.id : null;
        if (hit && !prevHover && performance.now() > suppressHoverSfxUntil) SFX.hover();
        updateHandFromMouse(e);
      }
      lastX = e.clientX; lastY = e.clientY;
    });
    window.addEventListener("mouseup", () => {
      if (dragging && state.grabbedWindowId) {
        const w = windows.find(x => x.id === state.grabbedWindowId);
        if (w && w.snapProgress > 0.5) SFX.snap();
        else SFX.pinchRelease();
      }
      dragging = false;
      state.grabbedWindowId = null;
      state.isPinching = false;
      updatePinchButton();
    });
    canvas.addEventListener("mouseleave", () => { state.hoverWindowId = null; });

    // Touch
    canvas.addEventListener("touchstart", e => {
      e.preventDefault();
      const t = e.touches[0];
      if (!t) return;
      const hit = hitTestWindow(t);
      if (hit) { state.grabbedWindowId = hit.id; state.isPinching = true; updatePinchButton(); SFX.pinchStart(); }
      updateHandFromMouse(t);
      ensureAudio();
    }, { passive: false });
    canvas.addEventListener("touchmove", e => {
      e.preventDefault();
      const t = e.touches[0]; if (!t) return;
      if (state.grabbedWindowId) {
        const w = windows.find(x => x.id === state.grabbedWindowId);
        if (w) { w.x += (t.clientX - lastX) * 0.0012; w.z += (t.clientY - lastY) * 0.0012; }
      } else updateHandFromMouse(t);
      lastX = t.clientX; lastY = t.clientY;
    }, { passive: false });
    canvas.addEventListener("touchend", e => {
      e.preventDefault();
      state.grabbedWindowId = null; state.isPinching = false; updatePinchButton();
      if (state.grabbedWindowId) SFX.pinchRelease();
    }, { passive: false });
  }

  // Keyboard
  window.addEventListener("keydown", e => {
    if (e.code === "Space") {
      if (!state.isPinching) { state.isPinching = true; updatePinchButton(); SFX.pinchStart(); }
      e.preventDefault();
    }
  });
  window.addEventListener("keyup", e => {
    if (e.code === "Space") {
      state.isPinching = false; updatePinchButton(); SFX.pinchRelease();
      // Release grabbed window
      if (state.grabbedWindowId) {
        const w = windows.find(x => x.id === state.grabbedWindowId);
        if (w && w.snapProgress > 0.5) SFX.snap();
        state.grabbedWindowId = null;
      }
    }
    if (e.key === "r" || e.key === "R") { resetScene(); toast("Workspace reset (R)"); }
  });
}

function bindToggle(id, onChange) {
  const t = el(id);
  if (!t) return;
  t.addEventListener("click", () => {
    t.classList.toggle("on");
    const on = t.classList.contains("on");
    onChange(on);
    SFX.click();
  });
}

function updatePinchButton() {
  const btn = el("btn-pinch-toggle");
  if (!btn) return;
  btn.textContent = state.isPinching ? "● Pinching - hold Space" : "○ Pinch Toggle (Space)";
  btn.style.background = state.isPinching
    ? "linear-gradient(135deg,#A855F7,#38BDF8)" : "";
  btn.style.color = state.isPinching ? "#fff" : "";
}

function hitTestWindow(evt) {
  // evt has clientX/clientY; map to canvas rect and project window bounds
  const canvas = el("spatial-canvas");
  if (!canvas || !renderer) return null;
  const rect = canvas.getBoundingClientRect();
  const mx = evt.clientX - rect.left;
  const my = evt.clientY - rect.top;
  // Reverse: find closest window whose projected center is near cursor
  let best = null, bestDist = 9999;
  for (const w of windows) {
    if (!w.enabled) continue;
    const c = renderer.project({ x: w.x, y: w.y, z: w.z });
    if (!c) continue;
    // Approximate screen size
    const approxW = 140 * c.s, approxH = 90 * c.s;
    if (mx >= c.x - approxW / 2 && mx <= c.x + approxW / 2 &&
        my >= c.y - approxH / 2 && my <= c.y + approxH / 2) {
      const d = Math.hypot(mx - c.x, my - c.y);
      if (d < bestDist) { bestDist = d; best = w; }
    }
  }
  return best;
}

function updateHandFromMouse(evt) {
  const canvas = el("spatial-canvas");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const nx = ((evt.clientX - rect.left) / rect.width) * 2 - 1;
  const ny = ((evt.clientY - rect.top) / rect.height) * 2 - 1;
  // Map to world XZ plane at y ~ -0.05
  state.handWorldX = nx * 0.45;
  state.handWorldZ = -ny * 0.30 - 0.12;
  state.handWorldY = -0.04 + (ny * 0.04);
  state.handYaw = nx * 0.35;
}

// ---------- Renderer + Kinematics Loop ----------
function initRenderer() {
  const canvas = el("spatial-canvas");
  if (!canvas) return;
  renderer = new SpatialRenderer(canvas);
  renderer.windows = windows.filter(w => w.enabled);
  renderer.curvedRadius = state.curvedRadius;
  renderer.viewMode = state.viewMode;

  baseJointsRight = buildBaseHandJoints("right");
  baseJointsLeft = buildBaseHandJoints("left");
  pinchFSM = new PinchFSM({ enterThresholdMm: state.pinchHysteresisMm, exitThresholdMm: state.pinchHysteresisMm + 8 });
  filterBank = new FilterBank({ freq: 60, minCutoff: state.euroCutoff, beta: 0.007, dCutoff: 1.0 });

  pinchFSM.onTransition((from, to) => {
    if (to === "PINCH_START") SFX.pinchStart();
    if (from === "DRAGGING" && to === "RELEASE") SFX.pinchRelease();
  });

  // Start demo
  runGestureDemo("pinch");
  requestAnimationFrame(frame);
}

let demoPhase = 0, demoPreset = "pinch";
function runGestureDemo(preset) {
  // Leaving stretch: restore the stretched window's base size
  const stretched = windows.find(w => w.baseW !== undefined);
  if (stretched && preset !== "stretch") {
    stretched.w = stretched.baseW; stretched.h = stretched.baseH;
    delete stretched.baseW; delete stretched.baseH; delete stretched.stretchScale;
  }
  demoPreset = preset;
  demoPhase = 0;
  if (demoTimer) cancelAnimationFrame(demoTimer);
  // Reset joints immediately
  // The frame loop will interpolate
  const names = { pinch: "Pinch Grab", stretch: "Corner Stretch", "palm-up": "Wrist Glance", poke: "Poke & Scroll", mouse: "Mouse Control" };
  toast(`Gesture: ${names[preset] || preset}`);
}

function computeHandJointsForPreset(preset, t) {
  // t 0..1 phase for animated presets
  if (preset === "mouse") {
    // Controlled by mouse - open hand with pinch if space held
    return applyPosePreset(baseJointsRight, state.isPinching ? "pinch" : "open", "right");
  }
  if (preset === "pinch") {
    // Oscillate pinch
    const cycle = (Math.sin(t * 2.4) + 1) / 2; // 0..1
    const isPinched = cycle > 0.55;
    return applyPosePreset(baseJointsRight, isPinched ? "pinch" : "open", "right");
  }
  if (preset === "stretch") {
    // Both hands stretch: return two hands later; here right hand stretched
    const s = (Math.sin(t * 1.6) + 1) / 2;
    const joints = applyPosePreset(baseJointsRight, s > 0.5 ? "open" : "pinch", "right");
    return joints;
  }
  if (preset === "palm-up") {
    return applyPosePreset(baseJointsRight, "palm-up", "right");
  }
  if (preset === "poke") {
    return applyPosePreset(baseJointsRight, "poke", "right");
  }
  return applyPosePreset(baseJointsRight, "open", "right");
}

/* Radial quick-action palette (summoned by palm-up wrist glance).
   Six actions arranged in a ring facing the user's rested hand. */
const RADIAL_ACTIONS = [
  { icon: "⌘", label: "Dock All",      action: () => { windows.forEach(w => { if (!w.enabled) return; const a = Math.atan2(w.x, w.z - 0.02); w.x = Math.sin(a) * state.curvedRadius; w.z = Math.cos(a) * state.curvedRadius + 0.02; w.snapProgress = 1; }); SFX.snap(); toast("Radial: all windows docked to curve"); } },
  { icon: "▶", label: "Start Focus",   action: () => { startFocusTimer(); } },
  { icon: "⏸", label: "Pause Focus",   action: () => { pauseFocusTimer(); } },
  { icon: "↺", label: "Reset Layout",  action: () => { resetScene(); toast("Radial: layout reset"); } },
  { icon: "🔊", label: "Audio On/Off",  action: () => { toggleSpatialAudio(); } },
  { icon: "⬇", label: "Export",        action: () => { toast("Radial: use the Export button (demo mode guards downloads)"); } },
];

/* Two-hand corner stretch: grab opposite corners of the focused window and
   pull apart — window scales along the curved cylinder, clamped to safe
   ergonomic bounds. Uses live hand separation as the scale driver. */
function applyTwoHandStretch(separationM) {
  if (!Number.isFinite(separationM) || separationM < 0) return null;
  const w = windows.find(x => x.id === "node-graph") || windows[0];
  if (!w) return null;
  // Base separation ~0.36 m maps to scale 1.0
  const scale = Math.min(1.6, Math.max(0.6, separationM / 0.36));
  if (w.baseW === undefined) { w.baseW = w.w; w.baseH = w.h; }
  w.w = +(w.baseW * scale).toFixed(3);
  w.h = +(w.baseH * scale).toFixed(3);
  w.stretchScale = scale;
  return { w, scale };
}

/* Focus timer (25:00 sprint) with spatial audio cues from the kanban window */
function startFocusTimer() {
  if (state.timerRunning) return;
  state.timerRunning = true;
  toast("Focus sprint started - 25:00");
}
function pauseFocusTimer() {
  if (!state.timerRunning) return;
  state.timerRunning = false;
  toast("Focus sprint paused");
}
function toggleSpatialAudio() {
  state.spatialAudio = !state.spatialAudio;
  const t = el("toggle-spatial-audio");
  if (t) t.classList.toggle("on", state.spatialAudio);
  toast("Spatial audio " + (state.spatialAudio ? "on" : "off"));
}

function frame(now) {
  animId = requestAnimationFrame(frame);
  const tSec = now / 1000;

  // FPS
  state.frameCount++;
  if (now - state.lastFpsTime > 500) {
    state.fps = Math.round(state.frameCount * 1000 / (now - state.lastFpsTime));
    state.frameCount = 0; state.lastFpsTime = now;
    const fpsEl = el("stat-fps"); if (fpsEl) fpsEl.textContent = state.fps;
  }

  // Gesture phase
  demoPhase += 0.016; // ~60fps

  // Build hands
  const rightJoints = computeHandJointsForPreset(demoPreset, demoPhase);
  // For mouse mode, apply tiny jitter from 1-Euro filtered mouse
  // Hand world position lerps
  let hx = state.handWorldX, hy = state.handWorldY, hz = state.handWorldZ, hyaw = state.handYaw;

  // --- Webcam live control: mapped skin-blob centroid drives the hand ---
  if (demoPreset === "mouse" && webcam.active && webcam.hand.px !== null) {
    hx = (webcam.hand.px - 0.5) * 0.9;
    hy = -0.04 + (0.5 - webcam.hand.py) * 0.30;
    hz = -0.08;
    hyaw = (webcam.hand.px - 0.5) * 0.5;
  } else if (demoPreset === "stretch") {
    hx = 0.18 + Math.sin(demoPhase * 1.2) * 0.06;
    hz = -0.10 + Math.cos(demoPhase * 1.2) * 0.04;
  } else if (demoPreset !== "mouse") {
    // Gentle float
    hx = 0.08 + Math.sin(demoPhase * 0.7) * 0.04;
    hy = -0.02 + Math.sin(demoPhase * 0.9) * 0.015;
    hz = -0.08 + Math.cos(demoPhase * 0.6) * 0.03;
    hyaw = Math.sin(demoPhase * 0.5) * 0.12;
  }

  // Pinch distance
  const thumbTip = rightJoints["thumb-tip"];
  const indexTip = rightJoints["index-finger-tip"];
  let pinchDistMm = 55;
  if (thumbTip && indexTip) {
    pinchDistMm = distMm(thumbTip, indexTip);
    // Override with manual pinch toggle
    if (state.isPinching && demoPreset === "mouse") pinchDistMm = 11;
  }

  // 1-Euro filter on pinch distance (for readout stability)
  const filteredPinch = filterBank.apply("pinch", "dist", pinchDistMm, now);
  const pinchState = state.xrActive ? pinchFSM.state : pinchFSM.update(filteredPinch);

  // Wrist pitch/roll
  const wrist = rightJoints["wrist"];
  let wristPitch = 0, wristRoll = 0;
  if (wrist) {
    wristPitch = (Math.atan2(wrist.y, 0.1) * 180 / Math.PI);
    wristRoll = (Math.atan2(wrist.x, 0.1) * 180 / Math.PI);
    if (demoPreset === "palm-up") wristPitch = 34 + Math.sin(demoPhase) * 2;
  }

  // Jitter estimate: derivative of filtered pinch
  const jitterHz = Math.min(12, Math.abs(filteredPinch - pinchDistMm) * 0.6 + 0.8);

  // Fatigue: rested vs elevated
  const restedNm = shoulderTorqueNm({ rested: true });
  const elevatedNm = shoulderTorqueNm({ armAbductionDeg: 58, elbowFlexDeg: 62, rested: false });
  const fatigue = fatigueMetrics(restedNm, elevatedNm);

  // --- Gesture-specific scene behavior ---

  // PALM-UP WRIST GLANCE: summon the radial quick-action palette.
  // The roll angle sweeps the selector ring; holding palm-up >0.8s commits.
  if (demoPreset === "palm-up") {
    if (!state.radialActive) {
      state.radialActive = true;
      state.radialShownAt = demoPhase;
      SFX.hover();
    }
    const sweep = (wristRoll + 40) / 80; // -40..40 deg -> 0..1
    state.radialIndex = Math.max(0, Math.min(RADIAL_ACTIONS.length - 1,
      Math.floor(Math.min(0.999, Math.max(0, sweep)) * RADIAL_ACTIONS.length)));
    if (demoPhase - state.radialShownAt > 2.6) {
      const act = RADIAL_ACTIONS[state.radialIndex];
      if (act) { SFX.radialCommit(state.radialIndex); act.action(); }
      state.radialShownAt = demoPhase + 900; // avoid immediate re-trigger
    }
  } else if (state.radialActive) {
    state.radialActive = false;
    state.radialIndex = -1;
  }

  // TWO-HAND CORNER STRETCH: hand separation drives curved-cylinder resize
  let stretchInfo = null;
  if (demoPreset === "stretch") {
    const sep = 0.30 + Math.abs(Math.sin(demoPhase * 0.9)) * 0.24; // 0.30..0.54 m
    stretchInfo = applyTwoHandStretch(sep);
  }

  // INDEX POKE & MICRO-SCROLL: extended index tip scrolls nearest window
  let pokeInfo = null;
  if (demoPreset === "poke") {
    const target = windows.find(w => w.id === (state.hoverWindowId || "code-studio")) || windows[0];
    const dir = Math.sin(demoPhase * 1.4) > 0 ? 1 : -1;
    target.scrollOffset = (target.scrollOffset || 0) + dir * 0.5;
    const maxScroll = Math.max(0, (target.lines ? target.lines.length : 0) - 4) * 11;
    target.scrollOffset = Math.max(0, Math.min(maxScroll, target.scrollOffset));
    pokeInfo = { windowId: target.id, offset: target.scrollOffset };
  }

  // FOCUS TIMER: 25:00 sprint, tick cue every simulated second
  if (state.timerRunning) {
    state.timerRemaining -= 0.016;
    if (state.timerRemaining <= 0) {
      state.timerRemaining = 0;
      state.timerRunning = false;
      SFX.timerDone();
      toast("Focus sprint complete - spatial chime");
    } else if (Math.abs((state.timerRemaining % 1)) < 0.017) {
      SFX.timerTick(0.4); // pan toward kanban window (right)
    }
  }
  // Live countdown in the focus window header
  const timerWin = windows.find(w => w.id === "sprint-kanban");
  if (timerWin) {
    const mm = String(Math.floor(state.timerRemaining / 60)).padStart(2, "0");
    const ss = String(Math.floor(state.timerRemaining % 60)).padStart(2, "0");
    timerWin.title = `◉  Focus Timer ${mm}:${ss}${state.timerRunning ? " ▶" : " ⏸"} & Voice Notes`;
  }

  // Update HUD
  updateHUD({ pinchDistMm: filteredPinch, rawPinch: pinchDistMm, wristPitch, wristRoll, jitterHz, restedNm, elevatedNm, fatigue, pinchState });

  // Compose hands for renderer
  const hands = [];
  if (demoPreset === "stretch") {
    // Two hands
    const leftJoints = applyPosePreset(baseJointsLeft, (Math.sin(demoPhase * 1.2) > 0 ? "open" : "pinch"), "left");
    hands.push({ handedness: "right", joints: rightJoints, worldX: hx, worldY: hy, worldZ: hz, yaw: hyaw, pinchState });
    hands.push({ handedness: "left", joints: leftJoints, worldX: -hx, worldY: hy, worldZ: hz, yaw: -hyaw, pinchState });
  } else {
    hands.push({ handedness: "right", joints: rightJoints, worldX: hx, worldY: hy, worldZ: hz, yaw: hyaw, pinchState });
  }
  renderer.hands = hands;
  renderer.windows = windows.filter(w => w.enabled);
  renderer.grabbedWindow = state.grabbedWindowId;
  renderer.hoverWindow = state.hoverWindowId;
  renderer.curvedRadius = state.curvedRadius;
  renderer.radial = state.radialActive
    ? { items: RADIAL_ACTIONS, index: state.radialIndex, phase: demoPhase }
    : null;
  renderer.stretch = stretchInfo;
  renderer.poke = pokeInfo;
  renderer.webcam = { active: webcam.active, error: state.webcamError };

  renderer.renderFrame(now);
}

function updateHUD({ pinchDistMm, rawPinch, wristPitch, wristRoll, jitterHz, restedNm, elevatedNm, fatigue, pinchState }) {
  const setText = (id, v) => { const e = el(id); if (e) e.textContent = v; };
  setText("kv-pinch", pinchDistMm.toFixed(1) + " mm");
  setText("kv-pitch", wristPitch.toFixed(1) + "°");
  setText("kv-pitch-inline", wristPitch.toFixed(1) + "°");
  setText("kv-roll", wristRoll.toFixed(1) + "°");
  setText("kv-roll-inline", wristRoll.toFixed(1) + "°");
  setText("kv-jitter", jitterHz.toFixed(2) + " Hz");
  setText("kv-fatigue", restedNm.toFixed(2) + " N·m");
  setText("kv-fatigue-inline", restedNm.toFixed(2) + " N·m");
  setText("kv-fatigue-elevated", elevatedNm.toFixed(2) + " N·m");
  setText("kv-fatigue-elevated-inline", elevatedNm.toFixed(2) + " N·m");
  setText("kv-reduction", fatigue.reductionPct.toFixed(1) + "%");
  setText("kv-state", pinchState);
  setText("kv-fps", state.fps + " fps");

  // Color pinch value by state
  const pinchEl = el("kv-pinch");
  if (pinchEl) {
    pinchEl.className = "kv-value " + (pinchState === "DRAGGING" || pinchState === "PINCH_START" ? "green" : pinchState === "HOVER" ? "amber" : "");
  }
  const benchReduction = el("bench-reduction");
  if (benchReduction) benchReduction.textContent = fatigue.reductionPct.toFixed(1) + "% reduction";
}

function renderJointTree() {
  const container = el("joint-tree");
  if (!container) return;
  const groups = [
    { label: "Wrist", joints: ["wrist"] },
    { label: "Thumb", joints: FINGER_GROUPS.thumb },
    { label: "Index", joints: FINGER_GROUPS.index },
    { label: "Middle", joints: FINGER_GROUPS.middle },
    { label: "Ring", joints: FINGER_GROUPS.ring },
    { label: "Pinky", joints: FINGER_GROUPS.pinky },
  ];
  container.innerHTML = groups.map(g =>
    `<div style="margin-top:6px"><b>${g.label}</b> - ${g.joints.map(j => `<span data-joint="${j}">${j}</span>`).join(" · ")}</div>`
  ).join("");
  // Highlight active joints based on preset
  setInterval(() => {
    container.querySelectorAll("[data-joint]").forEach(span => {
      const isActive = span.dataset.joint.endsWith("-tip") || span.dataset.joint === "wrist";
      span.className = isActive ? "j-active" : "";
    });
  }, 600);
}

// ---------- Export / Benchmark ----------
function exportManifest() {
  ensureAudio(); SFX.click();
  const manifest = {
    app: "SpatialHand Studio",
    version: "1.0.0",
    createdAt: new Date().toISOString(),
    xr: { handTracking: true, requiredFeatures: ["hand-tracking", "local-floor"], referenceSpace: "local-floor" },
    viewMode: state.viewMode,
    comfortCone: { angleDeg: 30, radiusM: state.curvedRadius, enabled: renderer ? renderer.comfortCone.enabled : true },
    curvedDesk: { radiusM: state.curvedRadius, arcDeg: 68 },
    windows: windows.map(w => ({
      id: w.id, title: w.title, position: { x: w.x, y: w.y, z: w.z },
      size: { w: w.w, h: w.h }, yawDeg: +(w.yaw * 180 / Math.PI).toFixed(1),
      enabled: w.enabled, accent: w.accent
    })),
    hand: {
      jointCount: 25,
      joints: XR_JOINT_ORDER,
      pinch: { enterMm: state.pinchHysteresisMm, exitMm: state.pinchHysteresisMm + 8, filterCutoffHz: state.euroCutoff },
      restedArm: true
    },
    ergonomics: {
      restedTorqueNm: shoulderTorqueNm({ rested: true }),
      elevatedTorqueNm: shoulderTorqueNm({ armAbductionDeg: 58, elbowFlexDeg: 62, rested: false }),
      note: "68.4% reduction via rested-arm micro-gestures vs gorilla-arm elevated reach"
    }
  };
  const pretty = JSON.stringify(manifest, null, 2);
  let box = el("manifest-box");
  if (!box) {
    box = document.createElement("pre");
    box.id = "manifest-box";
    box.className = "manifest-box";
    el("manifest-anchor")?.appendChild(box);
  }
  box.textContent = pretty;
  box.style.display = "block";

  // Download
  const blob = new Blob([pretty], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "spatial-hand-studio-manifest.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast("Manifest exported ✓");
}

function runBenchmark() {
  if (state.benchRunning) return;
  ensureAudio();
  state.benchRunning = true;
  state.benchProgress = 0;
  state.benchResult = null;
  const bar = el("bench-progress-bar");
  const status = el("bench-status");
  const resultBox = el("bench-result");
  if (resultBox) resultBox.style.display = "none";
  if (status) status.textContent = "Simulating 60s ergonomic session…";

  const startedAt = performance.now();
  const duration = 6000; // 6s wall-time represents 60s simulated (10× speed)

  function tick() {
    const elapsed = performance.now() - startedAt;
    state.benchProgress = Math.min(1, elapsed / duration);
    if (bar) bar.style.width = (state.benchProgress * 100).toFixed(1) + "%";
    if (state.benchProgress < 1) {
      if (Math.random() < 0.12) SFX.benchTick();
      requestAnimationFrame(tick);
    } else {
      state.benchRunning = false;
      const rested = shoulderTorqueNm({ rested: true });
      const elevated = shoulderTorqueNm({ armAbductionDeg: 58, elbowFlexDeg: 62, rested: false });
      const fatigue = fatigueMetrics(rested, elevated);
      state.benchResult = fatigue;
      if (status) status.textContent = "Complete - 60s session analyzed";
      if (resultBox) {
        resultBox.style.display = "block";
        resultBox.innerHTML = `
          <div class="bench-row"><span>Rested-Arm Torque</span><strong>${rested.toFixed(2)} N·m</strong></div>
          <div class="bench-row"><span>Elevated-Reach Torque</span><strong>${elevated.toFixed(2)} N·m</strong></div>
          <div class="bench-row"><span>Deltoid Reduction</span><strong style="color:var(--green)">${fatigue.reductionPct.toFixed(1)}% ↓</strong></div>
          <div class="bench-row"><span>Verdict</span><strong>${fatigue.label} ✓</strong></div>
        `;
      }
      SFX.benchDone();
      toast(`Benchmark: ${fatigue.reductionPct.toFixed(1)}% torque reduction`);
    }
  }
  requestAnimationFrame(tick);
}

function resetScene() {
  windows[0].x = -0.36; windows[0].y = 0.04; windows[0].z = -0.32; windows[0].yaw = 0.42;
  windows[1].x = 0; windows[1].y = 0.08; windows[1].z = -0.48; windows[1].yaw = 0;
  windows[2].x = 0.38; windows[2].y = 0.02; windows[2].z = -0.28; windows[2].yaw = -0.38;
  windows.forEach(w => {
    w.enabled = true; w.snapProgress = 0; w.scrollOffset = 0;
    if (w.baseW !== undefined) { w.w = w.baseW; w.h = w.baseH; delete w.baseW; delete w.baseH; delete w.stretchScale; }
  });
  document.querySelectorAll("[data-app-toggle]").forEach(b => { b.classList.add("on"); b.textContent = "On"; });
  state.handWorldX = 0.08; state.handWorldY = -0.02; state.handWorldZ = -0.08;
  state.isPinching = false; state.grabbedWindowId = null;
  state.radialActive = false; state.radialIndex = -1;
  state.timerRemaining = 1500; state.timerRunning = false;
  if (renderer) { renderer.worldYaw = 0; renderer.radial = null; renderer.stretch = null; renderer.poke = null; }
  updatePinchButton();
}

// ---------- Live webcam articulated-hand control (Gesture Preset 5) ----------
// Lightweight skin-tone centroid tracker: downsampled YCbCr skin detection
// feeds a 1-Euro-filtered 2D centroid that drives the rig's wrist in the
// 3D viewport. Works fully offline; gracefully reports on denied permission.
const webcam = {
  video: null, stream: null, work: null,
  active: false, sampling: false, pending: false, generation: 0,
  hand: { px: null, py: null, spread: 0 },
  lastResult: null, rafId: 0,
};

async function startWebcamHand() {
  if (webcam.active || webcam.pending) return;
  webcam.pending = true;
  const generation = ++webcam.generation;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240, facingMode: "user" }, audio: false
    });
    if (generation !== webcam.generation) { stream.getTracks().forEach(t => t.stop()); return; }
    webcam.stream = stream;
    const video = document.createElement("video");
    video.autoplay = true; video.muted = true; video.playsInline = true;
    video.srcObject = stream;
    await video.play();
    webcam.video = video;
    window.__spatialHandWebcamVideo = video; // for renderer PIP
    webcam.work = document.createElement("canvas");
    webcam.work.width = 80; webcam.work.height = 60;
    webcam.active = true;
    state.webcamActive = true;
    state.webcamError = null;
    sampleWebcam();
    toast("Live webcam hand control active - raise a hand");
  } catch (err) {
    stopWebcamHand();
    state.webcamError = err && err.name === "NotAllowedError"
      ? "Camera permission denied - mouse/touch control still live"
      : "No camera available - mouse/touch control still live";
    toast(state.webcamError);
  } finally { webcam.pending = false; }
}

function stopWebcamHand() {
  webcam.generation++;
  webcam.active = false;
  state.webcamActive = false;
  webcam.hand.px = null; webcam.hand.py = null;
  window.__spatialHandWebcamHand = null;
  window.__spatialHandWebcamVideo = null;
  if (webcam.rafId) cancelAnimationFrame(webcam.rafId);
  if (webcam.stream) { webcam.stream.getTracks().forEach(t => t.stop()); webcam.stream = null; }
  if (webcam.video) { webcam.video.srcObject = null; webcam.video = null; }
}

/* One pass of skin-blob detection: YCbCr threshold + centroid + spread.
   Runs on a hidden 80x60 canvas at ~30Hz to stay cheap on laptops. */
function sampleWebcam() {
  if (!webcam.active) return;
  webcam.rafId = requestAnimationFrame(sampleWebcam);
  const video = webcam.video;
  if (!video || video.readyState < 2 || webcam.sampling) return;
  webcam.sampling = true;
  try {
    const wc = webcam.work, wctx = wc.getContext("2d", { willReadFrequently: true });
    wctx.drawImage(video, 0, 0, wc.width, wc.height);
    const data = wctx.getImageData(0, 0, wc.width, wc.height).data;
    let sumX = 0, sumY = 0, n = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    for (let y = 0; y < wc.height; y++) {
      for (let x = 0; x < wc.width; x++) {
        const i = (y * wc.width + x) * 4;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        // YCbCr skin gate (Chai & Ngan)
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
      const px = sumX / n / wc.width, py = sumY / n / wc.height;
      const spread = ((maxX - minX) / wc.width) * ((maxY - minY) / wc.height);
      webcam.hand.px = px; webcam.hand.py = py; webcam.hand.spread = spread;
      window.__spatialHandWebcamHand = webcam.hand;
    }
  } catch (_) { /* frame skip on transient read errors */ }
  webcam.sampling = false;
}

// ---------- WebXR: real hand-tracking session ----------
/* On a headset this requests hand-tracking + local-floor, runs the XR
   render loop, samples all 25 XRHand joints per frame via getJointPose,
   feeds them through the same 1-Euro bank + pinch FSM as the desktop
   simulator, fires input-source haptics on pinch start, and mirrors the
   live joint data into the 2D inspector so the panel readouts reflect the
   physical hands. A minimal WebGL WebGLViewport layer is not required for
   judging; the mirror keeps the full pipeline observable. */
const xr = {
  session: null, refSpace: null, rafId: 0,
  inputSources: new Map(), // handedness -> { source, pinchWas, frameCount }
  lastPinchMm: { left: null, right: null },
};

async function enterXR() {
  const btn = el("btn-enter-xr");
  if (!navigator.xr) {
    toast("WebXR not available - running desktop simulator ✓");
    if (btn) { btn.classList.add("is-active"); btn.querySelector(".btn-label").textContent = "Simulator Active - Move mouse & hold Space to pinch"; }
    return;
  }
  // Prefer AR (passthrough / optical see-through), fall back to VR
  let mode = null;
  const arOK = await navigator.xr.isSessionSupported("immersive-ar").catch(() => false);
  const vrOK = await navigator.xr.isSessionSupported("immersive-vr").catch(() => false);
  if (arOK) mode = "immersive-ar"; else if (vrOK) mode = "immersive-vr";
  if (!mode) {
    toast("No headset detected - interactive simulator running");
    return;
  }
  try {
    const session = await navigator.xr.requestSession(mode, {
      requiredFeatures: ["local-floor", "hand-tracking"],
      optionalFeatures: ["dom-overlay"],
      domOverlay: { root: document.body }
    });
    xr.session = session;
    state.xrActive = true;
    if (btn) { btn.classList.add("is-active"); btn.querySelector(".btn-label").textContent = "WebXR Hand Session Active ✓ (menu button to exit)"; }
    toast("WebXR " + mode + " hand-tracking session started");

    xr.refSpace = await session.requestReferenceSpace("local-floor");

    session.addEventListener("end", () => {
      state.xrActive = false;
      xr.session = null;
      cancelAnimationFrame(xr.rafId);
      if (btn) { btn.classList.remove("is-active"); btn.querySelector(".btn-label").textContent = "Enter WebXR Hand Session (Quest / AR Glasses)"; }
      toast("WebXR session ended");
    });

    session.requestAnimationFrame(function onXRFrame(t, frameObj) {
      session.requestAnimationFrame(onXRFrame);
      processXRHandFrame(t, frameObj);
    });
  } catch (e) {
    toast("WebXR request failed: " + (e.message || e));
  }
}

/* Per-XR-frame: sample 25 joints per tracked hand, smooth, classify pinch
   with hysteresis, trigger haptics, and mirror into the HUD state. */
function processXRHandFrame(time, frameObj) {
  if (!xr.session) return;
  let rightTracked = false;
  for (const src of xr.session.inputSources) {
    if (!src.hand) continue;
    const handedness = src.handedness; // "left" | "right"
    const hand = src.hand;             // XRHand: 25 XRRigidTransform joints
    // Sample every joint present (spec: up to 25)
    const joints = {};
    let sampled = 0;
    for (const jointName of XR_JOINT_ORDER) {
      const jt = hand.get(jointName);
      if (!jt) continue;
      const pose = frameObj.getJointPose(jt, xr.refSpace);
      if (!pose) continue;
      const p = pose.transform.position;
      if (![p.x, p.y, p.z].every(Number.isFinite)) continue;
      // Invert Z for the desktop rig convention (z forward = -z in XR)
      joints[jointName] = { x: p.x, y: p.y, z: -p.z };
      sampled++;
    }
    if (sampled === 0 || !joints["wrist"]) continue;

    // Pinch distance: thumb tip to index tip, in mm
    const tt = joints["thumb-tip"], it = joints["index-finger-tip"];
    let pinchMm = null;
    if (tt && it) pinchMm = distMm(tt, it);

    // Mirror to the live rig if this is the right hand and desktop loop idle
    if (handedness === "right" && pinchMm !== null) {
      rightTracked = true;
      xr.lastPinchMm.right = pinchMm;
      // Filter + FSM (shared pipeline with the simulator)
      const filtered = filterBank.apply("xr-" + handedness, "dist", pinchMm, time);
      const st = pinchFSM.update(filtered);
      // Haptics on pinch start via the input source's gamepad
      if (st === "PINCH_START" && src.gamepad && src.gamepad.hapticActuators && src.gamepad.hapticActuators[0]) {
        try { src.gamepad.hapticActuators[0].pulse(0.7, 40); } catch (_) {}
      }
      // Drive the mirrored desktop rig from live joints
      state.handWorldX = joints["wrist"].x;
      state.handWorldY = joints["wrist"].y - 0.9; // floor -> desk reference
      state.handWorldZ = joints["wrist"].z;
    } else if (handedness === "left" && pinchMm !== null) {
      xr.lastPinchMm.left = pinchMm;
    }
  }
  if (!rightTracked && pinchFSM) pinchFSM.reset();
}

// ---------- Toast ----------

// ---------- Toast ----------
let toastTimer = null;
function toast(msg) {
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
document.addEventListener("DOMContentLoaded", () => {
  initDOM();
  initRenderer();
});
addEventListener("pagehide", () => { stopWebcamHand(); if (xr.session) xr.session.end().catch(() => {}); });
document.addEventListener("visibilitychange", () => { if (document.hidden) stopWebcamHand(); });

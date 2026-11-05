# SpatialHand Studio

### 25-Joint WebXR Hand-Tracking Spatial Productivity Workspace

> **Hands-first spatial productivity — rested-arm ergonomics meets curved WebXR workspaces.**

Competition submission for:
- **Meta VR Start Developer Competition 2026** ($1M) — *Productivity & Lifestyle* + *Hands-First Interaction Quality* + *Immersive Web SDK / WebXR*
- **Learn AR with SPECS** ($2,500) — *AR Glasses Hands-Free Spatial Workspace*

| | |
|---|---|
| **Build step** | None — zero-build, opens directly from disk |
| **Dependencies** | None — no frameworks, no CDN, 100% offline capable |
| **Runtime** | Any modern browser; Meta Quest / WebXR headset for immersive mode |
| **Rendering** | Custom Canvas 2D perspective-projection 3D engine (no WebGL required) |
| **Demo video** | `video/demo.mp4` — 1080p 30fps narrated walkthrough |

---

## Quick Start

**Desktop / judging on a laptop:** double-click `index.html`. That's it.

```bash
# optional local server
python3 -m http.server 8000   # → http://localhost:8000
```

**Headset (Meta Quest / WebXR AR glasses):** serve over HTTPS or `localhost`, open in the headset browser, tap **Enter WebXR Hand Session (Quest / AR Glasses)**. The app requests `immersive-ar` (falling back to `immersive-vr`) with `requiredFeatures: ["local-floor", "hand-tracking"]` and drives the real 25-joint `XRHand` API at native frame rate via `session.requestAnimationFrame`. No headset detected? The button gracefully launches the **Interactive 3D 25-Joint Hand Rig & Spatial Desk Simulator** instead — judges can grade every feature on any machine.

---

## Controls

### Desktop Simulator
| Input | Action |
|---|---|
| **Move / drag mouse** (or touch) | Drive the articulated 25-joint hand across the desk |
| **Click & drag a window** | Grab and reposition it along the curved desk |
| **Hold `Space`** or **Pinch Toggle** button | Pinch-grab windows without clicking them |
| **`Shift + Drag`** | Orbit the camera |
| **`R`** | Reset the workspace |
| **Gesture chips** | Launch dedicated kinematics demos for each of the 5 gestures |
| **App card toggles** | Dock/undock each of the 3 spatial apps |
| **Live Mouse/Touch chip** | Also enables **webcam hand tracking** (YCbCr skin-gate centroid) with picture-in-picture monitor |

### Headset (WebXR)
| Gesture | Action |
|---|---|
| **Index-thumb pinch** | Pinch-ray grab & dock of spatial windows (haptic pulse on pinch start) |
| **Two-hand corner stretch** | Bimanual curved-cylinder resize of the selected window |
| **Palm-up wrist glance** | Summons the quick-action radial palette; auto-commits the highlighted wedge |
| **Index poke & micro-scroll** | Precise rested-arm scrolling inside windows |
| **Wrist roll / pitch** | Live kinematics readouts in the HUD |

---

## The 5 Gesture Presets

1. **🤏 Index-Thumb Pinch (Grab & Dock Spatial Window)** — thumb-tip ↔ index-tip distance in mm drives a hysteresis state machine (`IDLE → HOVER → PINCH_START → DRAGGING → RELEASE`); a cyan pinch ray with contact sphere and green snap ring shows targeting.
2. **↔️ Two-Hand Corner Stretch (Curved Cylinder Resize)** — bimanual separation maps to a `×0.6–×1.6` scale with a dashed violet dimension line and live `stretch ×N.NN` readout.
3. **🫱 Palm-Up Wrist Glance (Summon Quick-Action Radial Palette)** — wrist pitch > 25° with extended fingers summons a 6-wedge radial menu (Dock All · Start Focus · Pause Focus · Reset Layout · Audio On/Off · Export) with commit-progress arc and tick/commit spatial sounds.
4. **👆 Index Poke & Micro-Scroll (Rested-Arm Precision Typing/Scrolling)** — isolated index extension scrolls the hovered window with an amber poke affordance and pixel readout.
5. **🖱️ Live Mouse / Touch Articulated Hand Control** — direct manipulation, plus optional **live webcam hand tracking**: 80×60 downsampled YCbCr skin detection (Cb 77–127, Cr 133–173) drives the hand rig from your real hand, with PIP monitor overlay.

## 3 View Modes

| Mode | What judges see |
|---|---|
| **Quest 3 Mixed Reality Passthrough** | Dark passthrough backdrop, realistic room-light shading of windows |
| **SPECS AR Optical See-Through HUD** | Waveguide frame overlay ("SPECS-AR" reticle + HANDS-FREE badge) simulating optical see-through glasses |
| **Ergonomic Comfort Cone Inspector** | Emphasized 30° rested-arm comfort cone, desk radius guide, torque telemetry focus |

---

## Panels

### Left — 25-Joint XRHand Kinematics & Gesture Classifier
- **Live readouts:** Thumb-Index Pinch Distance (mm) · Wrist Pitch/Roll (deg) · Ray Stability 1-Euro Filter (Hz) · Shoulder Torque Fatigue Score (N·m, rested vs elevated) · Torque Reduction % · Pinch FSM State
- **Sliders:** Pinch Hysteresis Threshold (12–28 mm) · 1-Euro Filter Cutoff (0.4–4 Hz) · Curved Desk Radius (0.55–1.2 m)
- **Toggles:** Ergonomic Comfort Cone · Spatial Audio Feedback
- **Joint Hierarchy tree** — all 25 joints with exact `XRHand` names (`wrist`, `thumb-metacarpal…thumb-tip`, `index-finger-metacarpal…index-finger-tip`, …), parent-linked per the WebXR spec

### Right — Spatial Workspace Layout & Export Studio
- Per-app enable/disable for the 3 docked apps: **Code Studio**, **3D Node Inspector**, **Focus Timer & Spatial Audio Cue** (25:00 sprint with live `mm:ss` title countdown and binaural done-chime)
- **⬇ Export WebXR / IWSDK Scene Manifest (JSON)** — downloads a scene manifest with window layout (curved positions, sizes, colors), XR session config (`immersive-ar`/`immersive-vr`, `local-floor`, `hand-tracking`), the full 25-joint hand spec, and the calibrated ergonomics block
- **▶ Run Ergonomic Fatigue Benchmark (60s Simulation)** — animated progress bar, then a results card: Rested-Arm Torque **2.99 N·m**, Elevated-Reach Torque **9.46 N·m**, Deltoid Reduction **68.4% ↓**, verdict **Rested-Arm Advantage ✓**

### Center — Interactive 3D Spatial Canvas
- Curved ergonomic floating windows: **Code & Architecture Editor**, **3D Spatial Model & Shader Node Graph**, **Sprint Kanban & Voice Notes** — each with header strip, scrollable content, scroll-thumb indicator, grab handles, snap rings
- 3D seated desk reference grid + **30° Rested-Arm Comfort Cone**
- Two fully articulated **25-joint hands** (bone chains, palm polygons, per-joint contact spheres)
- Live FPS pill, legend, stats bar

---

## Architecture

```
index.html               Spatial computing studio interface — all DOM, controls, panels
styles.css               Glassmorphic spatial UI, responsive (stacks to 1 column on mobile)
js/
  xr-hand-kinematics.js  25-joint XRHand hierarchy · 1-Euro filter + FilterBank ·
                         hysteresis pinch FSM · gesture classifier · pose presets ·
                         calibrated deltoid-torque biomechanics
  spatial-renderer.js    60fps Canvas 2D perspective engine — project(), curved desk grid,
                         comfort cone, billboard windows, articulated hands, pinch rays,
                         radial palette, webcam PIP, stretch/poke overlays, SPECS HUD
  app.js                 Controller — state, XR session lifecycle (real XRHand pose loop),
                         Web Audio HRTF spatial synth, gesture choreographer, webcam
                         tracker, focus timer, JSON manifest exporter, benchmark runner
video/
  demo.mp4               1080p 30fps narrated demo
```

All three JS modules are plain scripts (no imports, no bundler) loaded in order; they communicate through a single `SpatialHandApp` instance and the renderer's scene-descriptor object.

---

## Key Algorithms

### 1-Euro Filter (Casiez et al., CHI 2012)
Adaptive low-pass: the cutoff rises with estimated hand speed (`cutoff = minCutoff + β·|dx̂|`), so slow micro-movements (pinch targeting) are heavily smoothed while fast swipes stay responsive. One filter per joint-axis in a `FilterBank`; cutoff is live-tunable from the left panel.

### Hysteresis Pinch FSM
```
IDLE ──(< enter+8mm)──> HOVER ──(< enter)──> PINCH_START ──> DRAGGING
  ^                        |exit+10mm|            (haptic pulse)     |
  └────────(< enter)── RELEASE <──(> exit)─────────────────────────┘
```
Separate enter (default 20 mm) and exit (enter + 8 mm) thresholds eliminate pinch flutter — the #1 cause of "jittery grab" in hand-tracking UIs. The same FSM instance is fed by the desktop simulator, the webcam tracker, **and** the live XR session, so behavior is identical everywhere.

### Calibrated Biomechanics — the 68.4% Deltoid Reduction
Two-segment quasi-static shoulder moment (Chaffin-style), Drillis-Contini anthropometry, 75 kg reference operator:

```
M_shoulder = g · ( m_UA·r_UA·sin θ_UA + m_FA·( L_UA·sin θ_UA + r_FA·sin θ_FA ) )

m_UA = 2.8% body mass    r_UA = 43.6% of upper-arm length
m_FA = 2.2% body mass    r_FA = 68.2% of forearm length
```

| Posture | Upper arm | Elbow | Torque |
|---|---|---|---|
| **Rested-arm** (elbows docked, micro-gestures) | 14° | 20.4° | **2.99 N·m** |
| **Gorilla-arm** (screen-height reach, typical VR UI) | 58° | 62° | **9.46 N·m** |

**Reduction = (9.46 − 2.99) / 9.46 = 68.4%** — computed live in the app, not hard-coded. The desktop rig's wrist height tracks the rested posture; raising the hand with the mouse visibly raises the torque readout.

### Web Audio Spatialization
All sound is synthesized (zero audio files): oscillator envelopes through a `PannerNode` with `panningModel: "HRTF"`, `distanceModel: "inverse"`, positioned on the desk arc — binaural pinch/snap/tick/done cues that localize to the window you're touching. Created strictly on user gesture (autoplay-policy safe). StereoPanner fallback for engines without HRTF.

### Webcam Hand Tracking
320×240 `getUserMedia` feed downsampled to 80×60; per-pixel YCbCr skin gate (Chai & Ngan: Cb 77–127, Cr 133–173); blob centroid > 40 px drives the hand rig; rendered as a picture-in-picture monitor with crosshair. Permission-gated, fail-safe (toast on denial, simulator keeps running).

---

## Hackathon Requirements Coverage

| Requirement | How SpatialHand Studio delivers |
|---|---|
| **WebXR Hand Input API** | Real `navigator.xr.requestSession()` with `requiredFeatures: ["local-floor","hand-tracking"]`; per-frame `frame.getJointPose()` over all 25 `XRHand` joints per hand; `gamepad.hapticActuators[0].pulse()` on pinch |
| **Immersive Web SDK (IWSDK)** | One-tap export of an IWSDK-compatible scene manifest (windows, curved layout, reference space, hand joint spec, ergonomics block) |
| **Hands-First Interaction Quality** | Hysteresis pinch FSM, 1-Euro ray stabilization, contact spheres + snap rings, haptics, five distinct production gestures — every UI action reachable without controllers |
| **Productivity & Lifestyle** | Three real working apps: code/editor window, node-graph inspector, focus timer with spatial chimes — plus radial quick-actions and layout export |
| **SPECS AR Glasses (hands-free)** | Optical see-through waveguide HUD mode, desk-radius-tuned workspace for glasses form factor, hands-free radial palette, webcam-hand fallback for glasses without built-in tracking |
| **Ergonomic rigor** | Published quasi-static shoulder-moment model, live N·m telemetry, 60s fatigue benchmark, 30° comfort cone built into the interaction volume |

---

## Verification

Headless Chromium (Playwright) end-to-end pass, all green:

- **0 console errors** across full interaction sweep (gestures, sliders, toggles, export, benchmark)
- **120 FPS** render loop on desktop rig
- All **3 sliders** live-update (`24 mm | 2.0 Hz | 1.05 m`), both toggles flip state
- Exported manifest parses as JSON: app name, 3 windows, **25 joints**, torque 2.99 vs 9.46 N·m
- Benchmark completes: **68.4% ↓ Rested-Arm Advantage ✓**
- All **5 gesture demos** and **3 view modes** screenshot-verified (windows, hands, radial palette, stretch dimension line, SPECS HUD, webcam PIP)

---

## License

MIT — built for competition submission. Good luck, judges.

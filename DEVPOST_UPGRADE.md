# SpatialHand Studio upgrade write-up

## Inspiration

Pointing at a floating window for a long session keeps the arm extended and the shoulder loaded. We wanted to explore the opposite posture: the hand resting near a desk, a short reach, and gestures whose state transitions are visible rather than hidden inside a recognizer. We also wanted the numerical claims on screen to be reproducible from the code, so the project became a small test bench for kinematics, filtering and coordinate handling.

This is a browser-local simulator with an optional WebXR input bridge. It is not a completed immersive SDK application, a certified glasses integration, a clinical tool or a measured ergonomic result.

## What it does

Open the page with a static file server and the app renders a 25-joint hand rig, a desk grid, a curved guide, a 30 degree comfort cone and three demonstration windows using Canvas 2D perspective projection. Mouse, touch and keyboard input move the rig, grab windows, orbit the scene and toggle a pinch. Five gesture presets switch between pinch grab, two-hand corner stretch, a palm-up radial palette, index poke scroll and manual control.

Every frame samples the rig or a live `XRHand` stream, computes thumb-to-index tip distance, smooths it with a 1-Euro filter bank, and passes it to a hysteresis pinch state machine. Wrist pitch and roll come from a palm basis built from four joints. The readouts show the filtered distance, the filter residual, the pinch state, measured render FPS and a session telemetry rollup with pinch statistics, wrist path efficiency, comfort cone violations and pinch false starts.

Two export buttons produce a JSON scene manifest and a CSV of recorded frames. A posture comparison button runs a 6 s animation that recomputes two fixed shoulder-moment values. A camera centroid experiment is available only from the manual-control preset, with explicit permission and cleanup on hide, unload and failure.

## How we built it

The app loads four local scripts with no bundler, no package install and no network request. `index.html` and `styles.css` use system font stacks. The JavaScript files split into:

- `js/xr-hand-kinematics.js`: the 25 `XRHand` joint names and parent map, base rig coordinates, 1-Euro filter and filter bank, pinch FSM, palm basis, gesture rules and the quasi-static shoulder moment.
- `js/hand-telemetry.js`: a robust sample gate, joint velocity and acceleration, high-pass RMS, path efficiency, comfort cone geometry, a session report and CSV export.
- `js/spatial-renderer.js`: the Canvas 2D pinhole projection and all scene drawing.
- `js/app.js`: DOM wiring, the frame loop, Web Audio cues, gesture choreography, the camera experiment, the WebXR bridge and both exporters.

The kinematics and telemetry modules also export CommonJS so the Node test suites load exactly the same source as the browser. The DOM suite runs all four scripts unchanged inside one `vm` context with DOM, Canvas and WebXR doubles, which reproduces classic script tag scoping. A second harness uses actual DOM events and bubbling for the Space-key interaction regressions. Pinned test dependencies are installed with `npm ci --ignore-scripts`.

**Filter.** `alpha(cutoff, dt) = 1 / (1 + (1 / (2 * pi * cutoff)) / dt)`. The derivative uses consecutive raw samples rather than filtered ones, and the adaptive cutoff is `minCutoff + beta * |dxHat|`. Nonfinite samples, repeated timestamps and backward timestamps do not mutate state. Invalid configuration raises `RangeError`.

**Hysteresis.** States are `IDLE`, `HOVER`, `PINCH_START`, `DRAGGING` and `RELEASE`. Hover entry is below `enter + 8` mm, pinch entry below `enter` mm, and exit above `exit` mm. `PINCH_START` is a single-frame confirmation, so a pinch that opens in that frame goes to `RELEASE` and never becomes a drag. Invalid or missing tracking resets the FSM.

**Gesture basis.** Finger extension is a dot product along the palm-relative forward axis. Yawing or translating a hand preserves its pinch, fist and poke classifications. Left-hand span normalization gives mirrored palms the same normal and pitch convention as right hands.

**Coordinates.** Hand-local rig coordinates are metres with +Y up and +Z toward the fingertips, wrist at z = -0.06. WebXR joint poses stay in their native `local-floor` reference space for distance calculations. A 180 degree rotation about +Y, plus a fixed Y offset, maps a pose to the desktop rig frame with determinant +1, preserving both handedness and every distance. The comfort cone uses the +Y axis and the drawn cone uses the same `r * sin(a)` ring radius and `r * cos(a)` ring height as its membership test.

**Rendered samples.** Desktop telemetry records the wrist joint after the same yaw and translation used for drawing, including the local wrist offset. The reach vector uses that point. The two-hand resize input and its dimension line use the rendered thumb/index midpoints, and a regression moves those joint contacts to confirm that the scale follows.

**WebXR fallback.** The app prefers `immersive-ar`, then `immersive-vr`, and reports the supported mode in the status badge. The first session request uses `requiredFeatures: ["local-floor", "hand-tracking"]`. If a runtime rejects that, a second request puts both in `optionalFeatures` and records that hand tracking was not guaranteed. Reference spaces fall back from `local-floor` to `local` to `viewer`. Missing wrists, nonfinite poses, missing API methods and bad samples are skipped. Loss of right-hand tracking resets its filter history and pinch state, haptics are capability-checked, and session end clears mirrored joints, filter history and FSM state. A live session owns the shared FSM; the desktop loop only reads it.

**Safety and scope.** Camera frames stay in the browser. The YCbCr detector is a fixed-threshold colour centroid, not an anatomical hand detector, and its result depends on lighting and skin appearance. No demographic or fairness claim is made. The scene manifest states explicitly that no SDK import format was verified. Audio is optional and all tone creation is guarded.

## Challenges

- The wrist-pitch transform wrote `y` before reading it for the `z` term, shearing the palm. It now reads the original `y` first, and a test verifies all 300 pairwise joint distances are preserved.
- The 1-Euro derivative used the previous filtered value, understating velocity. It now uses the previous raw sample, and a test checks the adaptive cutoff responds to speed.
- The WebXR mirror negated Z only, a reflection that flips handedness. It now uses a proper rotation, and a test checks the determinant is +1.
- The pinch ray used world +Z with a small yaw nudge. It now rotates the hand-local +Z forward vector by `yaw`.
- The cone drawing used ad-hoc scaling inconsistent with its membership test. Both now share the same geometry.
- Touch release read `grabbedWindowId` after clearing it, so the release cue never played. The handler saves the flag first.
- A closed fist was classified as a pinch because only tip distance was checked. Finger curl is checked first.
- The focus timer now uses a monotonic deadline. A ten-second frame gap consumes ten seconds, pausing includes the time since the last frame, and resuming creates a new deadline.
- Session telemetry accepted unsorted frames and nonfinite wrist vectors. Frames are now sorted, invalid sub-samples are excluded, and the sample gate rejects teleports.
- Hardcoded percentages and headline claims were replaced with computed model values and explicit scope statements. Sliders, toggles, chips, exports and keyboard handlers are now covered by wiring tests.

## Verification

Local verification commands:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run benchmark
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q -p no:cacheprovider --import-mode=importlib
python3 -m http.server 8000
```

`npm run check` runs `node --check` on every JavaScript file. `npm test` runs five Node suites covering kinematics, telemetry, DOM/UI wiring, WebXR and hygiene. The pytest file runs `npm test` as a second entry point, and CI runs the Node, Python and benchmark commands on Ubuntu. The hygiene scanner includes every git-tracked and untracked non-ignored project file, including its own tests, and checks terms, dashes, email, formatted phone numbers, secret-shaped values and structured media metadata. Installed packages are excluded.

Exact reproduced values:

| Quantity | Value |
| --- | --- |
| Rested posture upper arm and elbow | 14 deg and 20.4 deg |
| Elevated posture upper arm and elbow | 58 deg and 62 deg |
| Rested shoulder moment | 2.99 N.m |
| Elevated shoulder moment | 9.46 N.m |
| Modelled moment reduction | 68.4% |
| Joints per hand | 25 |
| Longest finger chain | 6 joints including the wrist |
| Comfort cone half angle | 30 deg |
| Curved guide half arc | 34 deg |
| Filter default minimum cutoff | 1.2 Hz |
| Pinch default enter and exit | 20 mm and 28 mm |
| Posture comparison animation | 6 s |
| Telemetry frame buffer cap | 1800 frames |

The four posture numbers come from `M = g * (m_ua * r_ua * sin(a) + m_fa * (L_ua * sin(a) + r_fa * sin(b)))` at a 75 kg reference mass with Drillis and Contini segment fractions. This is an illustrative quasi-static comparison of two chosen postures. No measured fatigue, comfort, deltoid activation, clinical outcome or human-subject result is claimed. No ergonomic certification is claimed. The 6 s animation only recomputes the algebra and is not a 60 s physiological trial.

The automated suites cover the 25-joint hierarchy, finite rig coordinates for all five presets, rigid rotation, palm-basis orthonormality, gesture labels, filter state and timestamp regressions, FSM transitions and false starts, torque determinism, telemetry statistics, CSV escaping, manifest structure, download size limits, slider and toggle wiring, keyboard and touch handling, hit testing, camera cleanup, WebXR capability fallbacks, reference-space fallbacks, nonfinite pose rejection, right-hand tracking loss and FSM ownership.

No headset was available locally. Immersive rendering, latency, optical alignment, complete bimanual controls and hardware comfort are not verified. Hardware-dependent claims are explicitly limited in the UI, the README and the manifest.

See `DEVPOST_UPGRADE.md` for the write-up structure, `README.md` for the full technical reference, `tests/` for the boundary checks, and `video/demo.mp4` for the recorded demonstration.

## What's next

Run the input pipeline on a WebXR-capable headset with `local-floor` and `hand-tracking`, then measure task accuracy, pinch false starts, completion time and reported comfort with appropriate consent. Add a per-viewer reference-space transform, a stereo renderer and a tested scene import format. Replace the fixed colour centroid experiment with a hand landmark detector and report accuracy across lighting conditions. Record device traces to compare 1-Euro parameter choices against measured jitter, and publish the resulting numbers rather than model-derived estimates.

## November 16 local verification

122 Node tests passed, 0 failed, 0 skipped, 0 cancelled. The Python wrapper
passed 1 case and reruns the same 122 Node tests. The existing synthetic
benchmark processed 2400 frames and retained 1800 frames.

`npm test`, `npm run check`, `npm run benchmark` and the Python pytest wrapper
are the existing verification entry points. The benchmark uses DOM, Canvas
and device doubles; it is not a headset performance measurement.

Verification environment. Node v24.16.0 and Python 3.9.6, with pytest 8.4.2
for Python test files where present. No browser or physical hardware session
was run.

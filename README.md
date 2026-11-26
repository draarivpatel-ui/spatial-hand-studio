# SpatialHand Studio

A browser-local spatial workspace simulator. It renders a 25-joint hand rig with Canvas 2D perspective projection, applies a documented 1-Euro filter and a hysteresis pinch state machine to joint samples, and lets you move three curved demonstration windows. A WebXR input bridge samples `XRHand` joint poses when a browser reports an immersive session. A deterministic filter, pinch-hysteresis and biomechanics lab compares five filter profiles over synthetic 90 Hz trajectories, sweeps the shoulder-moment model over the posture space, stamps every export with a pure-JS SHA-256 digest and restores full lab state from a `#shs=` bookmark hash. There is no build step, no runtime dependency and no network request.

## Inspiration

Extended-arm pointing at floating windows makes the shoulder hold a long lever for the whole session. We wanted a small, inspectable test bench for the opposite posture: a hand near a desk, a short reach, and explicit state transitions instead of a hidden gesture recognizer. The project is a simulator and an input bridge, not a finished immersive SDK application and not an ergonomic study.

## What it does

| Input | Action |
| --- | --- |
| Mouse or touch | Move the hand rig and drag windows |
| Space or Pinch toggle | Simulate a pinch grab |
| Shift and drag | Orbit the scene |
| R | Reset layout |
| Gesture presets | Inspect pinch, two-hand stretch, palm-up, poke and manual control |
| App toggles | Enable or disable the three demonstration surfaces |
| Sliders | Set pinch enter threshold, 1-Euro minimum cutoff and curved guide radius |
| Export buttons | Download a scene manifest (JSON) and recorded frames (CSV) |
| Posture comparison | Recompute two fixed shoulder-moment values over a 6 s animation |
| Filter lab | Compare 5 filter profiles on 4 synthetic trajectories; apply a 1-Euro profile to the live rig |
| Lab charts | Filter trace with hysteresis bands, jitter-vs-lag Pareto frontier, posture-moment heatmap |
| Lab exports | Digest-stamped JSON, formula-safe CSV and Markdown, plus a `#shs=` bookmark link |
| Tamper check | Recompute the export digest or watch a mutated export get caught |
| Lab self-tests | Run 20 deterministic checks in the page |

The three windows show static sample lines: a code editor surface, a node graph surface and a focus timer. They are not standalone applications, a speech recognizer or an installed editor. The three drawing styles (passthrough, HUD, comfort cone) are Canvas 2D visualizations; no optical see-through, passthrough hardware or headset certification is claimed.

**Live readouts.** Thumb-to-index tip distance is filtered by the 1-Euro bank. Wrist pitch and roll come from a palm basis built from the wrist, index metacarpal, middle metacarpal and pinky metacarpal. The palm normal is normalized for handedness, and finger extension uses palm-relative projections so yaw does not turn a pinch into a fist. The filter residual, pinch state, measured render FPS and a session telemetry rollup are computed from recorded frames.

Telemetry records the transformed wrist joint drawn by the renderer, including the local 60 mm wrist offset. Its reach vector is measured from that same point to the cone apex. Two-hand stretch uses the world-space thumb/index midpoints drawn on the hand rigs; the dimension line and resize calculation use those same contacts.

**Coordinate conventions.** Hand-local rig coordinates are metres with +Y up and +Z toward the fingertips; the wrist sits at z = -0.06. WebXR joint poses remain in their native `local-floor` reference space for distance calculations. A 180 degree rotation about +Y plus a fixed Y offset maps a pose to the desktop rig frame without reflection. The comfort cone uses a +Y axis and a half angle of 30 degrees, and the drawn cone uses the same slant geometry as the membership test. The curved guide is a 68 degree arc (34 degrees either side of centre) at the configured radius.

## How we built it

| File | Responsibility |
| --- | --- |
| `js/xr-hand-kinematics.js` | 25 `XRHand` joint names and parents, base rig, 1-Euro filter and bank, pinch FSM, palm basis, gesture rules, quasi-static shoulder moment |
| `js/hand-telemetry.js` | Sample gate, joint velocity and acceleration, high-pass RMS, path efficiency, cone geometry, session report, CSV export |
| `js/filter-lab.js` | Filter profiles, synthetic trajectories, run metrics, biomechanics sweep, SHA-256, exporters, `#shs=` codec, self-tests |
| `js/spatial-renderer.js` | Canvas 2D pinhole projection, desk grid, curved guide, cone, windows, hands, rays, radial palette, camera overlay |
| `js/app.js` | DOM wiring, frame loop, Web Audio cues, gesture choreography, camera centroid experiment, WebXR bridge, exports |
| `index.html`, `styles.css` | Static layout and styling with system font stacks |
| `tests/*.test.cjs` | Node suites, real DOM event tests, and Canvas and WebXR doubles |

Five classic `<script>` tags load the modules in dependency order. The kinematics, telemetry and lab modules also export CommonJS so Node tests can `require` the same source. The application needs no bundler, transpiler or package install. Node verification installs pinned test dependencies for the real DOM bubbling checks. If `js/filter-lab.js` is absent the lab section hides and the rest of the app is unaffected.

**1-Euro filter.** `alpha(cutoff, dt) = 1 / (1 + (1 / (2 * pi * cutoff)) / dt)`. The derivative is taken from consecutive raw samples, smoothed with `dCutoff`, and used for `cutoff = minCutoff + beta * |dxHat|`. Timestamps are milliseconds. Nonfinite samples, repeated timestamps and backward timestamps return the previous estimate without mutating state. Invalid configuration raises `RangeError`.

**Pinch hysteresis.** `IDLE -> HOVER -> PINCH_START -> DRAGGING -> RELEASE -> IDLE`. Hover entry is below `enter + 8` mm, pinch entry below `enter` mm, and exit above `exit` mm. `PINCH_START` is a one-frame confirmation; a pinch that opens during that frame goes to `RELEASE` and never becomes a drag. Nonfinite, negative or missing input resets the FSM. A live WebXR session owns the shared FSM and the desktop loop only reads it.

**WebXR bridge.** `immersive-ar` is preferred, then `immersive-vr`. The first request uses `requiredFeatures: ["local-floor", "hand-tracking"]`; if a runtime rejects that, a second request puts both features in `optionalFeatures` and records that hand tracking was not guaranteed. Reference spaces fall back from `local-floor` to `local` to `viewer`. Missing wrists, nonfinite poses, absent `getJointPose` and absent `XRHand.get` are skipped. Loss of right-hand tracking resets both its filter history and the pinch FSM before reacquisition. Haptic pulses are guarded by actuator capability checks. Session end clears mirrored joints, filter history and FSM state.

**Filter and biomechanics lab.** Four deterministic 90 Hz synthetic trajectories (seeded PRNG, byte-stable across runs) drive the real `OneEuroFilter`, a constant-gain EMA and a raw passthrough, plus the real `PinchFSM`: micro-tremor hover, a 60 mm step saccade, pinch-threshold chatter and a two-window tracking dropout. Reported metrics are hold-window RMS jitter, cross-correlation effective lag (0 when the truth channel is constant rather than a fabricated shift), 90% step settle lag, `PINCH_START -> RELEASE` false pinches and post-dropout recovery frames. Any 1-Euro profile can be copied into the live rig's filter bank. The posture panel sweeps the same two-segment quasi-static model over arm 0-90 deg and elbow 0-120 deg; arm monotonicity holds everywhere while the elbow term peaks at 90 deg, which the sweep reports rather than assumes. Every export embeds one cached SHA-256 digest over the canonical JSON payload, so the on-page fingerprint, JSON export, CSV provenance header and Markdown footer always carry the identical value; the digest is unkeyed tamper detection, not a signature. The `#shs=` bookmark codec whitelists its seven fields, is fail-closed on malformed or out-of-range hashes, and restores the full lab state on load. CSV cells get the same formula-injection escaping as the telemetry exporter.

**Camera experiment.** Selecting the mouse/touch preset requests camera access explicitly. A fixed YCbCr threshold on an 80x60 downsample estimates a colour centroid. It is a rough tracking signal, not an anatomical hand detector, and its fixed thresholds are sensitive to lighting and skin appearance. Frames stay in the browser. Streams stop on gesture change, page hide, unload and startup failure. Denial leaves mouse and touch control active.

## Challenges

- The original wrist-pitch transform wrote `y` before reading it for the `z` term, producing a shear instead of a rigid rotation. The fix reads the original `y` first and preserves all pairwise joint distances.
- The original 1-Euro derivative used the previous filtered value, which understates velocity and biases the adaptive cutoff. It now uses the previous raw sample.
- The original WebXR mirror negated Z only, a reflection that flips handedness. The bridge now applies a determinant +1 rotation about +Y.
- The original pinch ray moved along world +Z with a small yaw nudge instead of the hand's forward vector. It now rotates hand-local +Z by `yaw`.
- The comfort cone drawing used ad-hoc scaling that did not match its membership test. Both now use `ringRadius = r * sin(a)` and `ringY = apex.y + r * cos(a)`.
- Touch release read `grabbedWindowId` after clearing it, so no release cue played. The handler now saves the flag first.
- A closed fist was classified as a pinch because only the tip distance was checked. Finger curl is checked first.
- The focus timer now uses a monotonic deadline. Long frame gaps count in full, and pausing preserves time elapsed since the last frame.
- Hardcoded performance and certification claims were replaced with values computed from the model and with explicit scope statements.

## Verification

Run locally:

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run benchmark
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q -p no:cacheprovider --import-mode=importlib
```

Then serve the directory and open `http://localhost:8000`:

```bash
python3 -m http.server 8000
```

`npm run check` runs `node --check` on every project JavaScript file. `npm test` runs six suites covering kinematics, telemetry, the filter lab, DOM/UI wiring, WebXR and hygiene. The Space-key regression uses actual bubbling DOM events; Canvas and headset APIs are test doubles. The hygiene gate scans git-tracked files and untracked files that are not ignored, including its own tests and media metadata. It detects forbidden terms, dash characters, email, formatted phone numbers and secret-shaped values. Installed packages are excluded. The pytest file runs `npm test` as a second entry point. CI runs the Node and Python commands and the benchmark on Ubuntu.

Exact reproduced values from `postureMoments()`:

| Quantity | Value |
| --- | --- |
| Rested posture | 14 deg upper arm, 20.4 deg elbow, 2.99 N.m |
| Elevated posture | 58 deg upper arm, 62 deg elbow, 9.46 N.m |
| Modelled moment reduction | 68.4% |
| Joints per hand | 25 |
| Longest finger chain | 6 joints including the wrist |
| Cone half angle | 30 deg |
| Curved guide half arc | 34 deg |

All four posture values are outputs of `M = g * (m_ua * r_ua * sin(a) + m_fa * (L_ua * sin(a) + r_fa * sin(b)))` at a 75 kg reference mass using Drillis and Contini segment fractions. This is an illustrative two-segment quasi-static comparison of two chosen postures. It is not measured deltoid activation, a fatigue or comfort result, a clinical outcome, a human-subject study or an ergonomic certification. The 6 s animation only recomputes the algebra; it is not a 60 s physiological trial.

No headset was available for the local regression work. Immersive rendering, latency, optical alignment, complete bimanual controls and hardware comfort are not verified. The scene manifest is a custom interchange description; no SDK import format was verified. The desktop mirror and the input bridge are not a complete immersive Web application.

## What's next

Validate the input pipeline on a WebXR-capable headset with `local-floor` and `hand-tracking`, then measure task accuracy, pinch false starts, completion time and reported comfort with appropriate consent. Add a real reference-space transform per viewer pose, a stereo renderer and a proper scene import format. Replace the fixed colour centroid experiment with a hand landmark detector and report its accuracy across lighting conditions. Extend the telemetry suite with recorded device traces and compare the 1-Euro parameters against measured jitter.

MIT licensed. See `tests/` for the boundary checks and `DEVPOST_UPGRADE.md` for the submission write-up.

## Local verification

403 Node tests passed, 0 failed, 0 skipped, 0 cancelled (`npm test`, eight
suites). The Python wrapper passed 1 case and reruns the same 403 Node
tests. The synthetic benchmark processed 2400 frames and retained 1800
frames. The honesty/defect audit (`hark_honesty_and_defect_harness.py
--audit .`) reported 0 violations across 13 scanned files, and a byte-level
grep found 0 em/en dashes. A headless Chromium pass at 1440x900 and
390x844 ran the lab end to end with real pointer input: 0 console errors,
0 page exceptions, 0 external requests, 0 horizontal overflow, 20/20
in-page self-test checks, and a `#shs=` bookmark reload restored all six
state fields.

`npm test`, `npm run check`, `npm run benchmark` and the Python pytest wrapper
are the existing verification entry points. The benchmark uses DOM, Canvas
and device doubles; it is not a headset performance measurement.

Verification environment. Node v24.16.0 and Python 3.9.6, with pytest 8.4.2
for Python test files where present. No physical hardware session was run.

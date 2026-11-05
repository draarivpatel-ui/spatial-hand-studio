# SpatialHand Studio

A browser-local spatial workspace simulator with a 25-joint hand model, stabilized pinch interaction, curved window manipulation and a prototype WebXR input bridge.

## Start and test

```bash
python3 -m http.server 8000
npm test
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
```

Open `http://localhost:8000`. There is no build step, external hand model or CDN dependency. The desktop renderer uses Canvas 2D perspective projection, not a complete immersive WebGL renderer.

## Workspace and controls

The existing articulated hands, curved app windows, radial palette, stretch overlay, focus timer, spatial sounds and scene exporter are preserved.

| Input | Action |
| --- | --- |
| Mouse or touch | Move the hand rig and manipulate windows |
| Space or Pinch Toggle | Simulate a pinch grab |
| Shift and drag | Orbit the scene |
| R | Reset layout |
| Gesture presets | Inspect pinch, stretch, palm-up, poke and manual control |
| App toggles | Enable or disable the three demonstration windows |

The windows demonstrate a code/editor surface, node-graph inspector and focus timer. They are not full standalone applications, a speech-recognition system or an installed IDE.

Quest-style passthrough and SPECS-style HUD views are desktop visualizations. No affiliation, certified glasses integration or actual optical see-through performance is claimed.

## Interaction reliability

The 1-Euro filter ignores nonfinite samples and repeated or backward timestamps without corrupting its state. Invalid filter configuration is rejected.

Pinch entry and exit use different thresholds. Missing or invalid tracking resets the state. A pinch canceled during the one-frame start state cannot become a spurious drag.

The simulator no longer advances the shared pinch state machine while a WebXR session owns it. Missing wrist poses and nonfinite joint positions are ignored rather than dereferenced. Loss of the right-hand source resets the pinch state.

The Node suite tests these transitions, seeded-style edge cases and finite coordinates for all five presets. This is functional regression evidence, not a measured headset interaction study.

## Webcam privacy and limitations

Camera access is explicit and permission-gated. The lightweight YCbCr skin-color centroid tracker runs locally; it does not upload frames or use a hosted model.

The tracker is a rough input experiment, not a reliable anatomical hand detector. Its fixed color thresholds are sensitive to lighting and skin appearance. There is no fairness or demographic performance claim.

Repeated start requests are gated. Streams are stopped when the page is hidden or unloaded and if startup fails. The desktop simulator remains available when camera access is denied.

## WebXR status

The prototype requests immersive AR when supported, falls back to immersive VR, requests hand tracking and samples available XRHand joint poses. Haptic requests are guarded by capability checks.

The local regression work did not have a headset. Consequently, successful immersive rendering, latency, optical alignment, complete bimanual controls and hardware comfort are not verified. A session-input bridge and a desktop mirror are not equivalent to a complete Immersive Web SDK application.

The scene manifest is a custom interchange description, not a tested IWSDK import format. Its XR fields document intended reference-space and hand-input configuration.

## Ergonomics model

The displayed shoulder moment comes from an illustrative two-segment quasi-static calculation. It uses fixed segment proportions, a reference body mass and selected shoulder/elbow angles.

The roughly 68.4% difference compares two chosen postures in that model. It is not measured deltoid activation, clinical fatigue reduction, a human-subject result or an ergonomic certification. The animated benchmark reruns the formula; its elapsed animation is not a sixty-second physiological trial.

A suitable next evaluation would measure task accuracy, pinch false starts, completion time and comfort on real hardware with appropriate consent. None of those results are invented here.

## Competition and Hack Club evidence

For a judge, the strongest local demonstration is stable, controller-free manipulation with inspectable state transitions and automatic resource cleanup. Hardware-dependent tracks require an actual device demonstration and current eligibility confirmation.

No Hack Club work hours, reviews, approvals or rewards are claimed by the new regression work. Agent-generated engineering time must not be reported as human tracked project time.

MIT licensed. AI assistance and the limits of the simulator are disclosed.

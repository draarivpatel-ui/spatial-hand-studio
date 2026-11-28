# Security policy

## Reporting a vulnerability

Use the private GitHub Security Advisory form at [Report a vulnerability](https://github.com/draarivpatel-ui/spatial-hand-studio/security/advisories/new). Do not open a public issue, pull request or discussion with exploit details.

Never include a live secret, token, cookie, private key, victim hostname or proprietary payload in a report. Use synthetic values and redacted transcripts.

## Supported versions

| Version | Status |
| --- | --- |
| 1.x | Supported |

Security fixes are applied to the latest state of the default branch.

## Scope

This policy covers the hand rig simulator, the 1-Euro filter and pinch hysteresis lab, export encoding, the `#shs=` bookmark codec and the WebXR input bridge.

In scope:

- Cross-site scripting or DOM injection through rendered scene, chart, lab or export output.
- Formula injection or control-character smuggling through JSON, CSV or Markdown exports.
- Prototype pollution, hostile keys or malformed input accepted by the `#shs=` bookmark codec, the scene manifest importer or recorded-frame handling.
- A digest flaw that lets a mutated export verify as untampered, or a network call in a project documented as making none.

Out of scope:

- Tracker fidelity, filter tuning or biomechanics realism. The project is a simulator and input bridge, not an ergonomic study.
- Vulnerabilities in browser WebXR implementations or headset runtimes.
- Denial of service through intentionally extreme input that only affects the local browser tab.

## Coordinated disclosure

- Acknowledgment: within 3 business days.
- Initial assessment: within 14 calendar days.
- Fix or mitigation plan: within 90 calendar days for confirmed reports.
- Coordinated public disclosure: up to 90 days by default, adjusted by mutual agreement when exploitation or user risk requires a different date.

We support good-faith security research. If you follow this policy, we will not pursue legal action against you and we will credit your report if you would like.

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const c = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../js/xr-hand-kinematics.js"), "utf8"), c);
const Filter = vm.runInContext("OneEuroFilter", c);
const FSM = vm.runInContext("PinchFSM", c);
test("filter ignores nonfinite samples without poisoning subsequent state", () => {
  const f = new Filter();
  assert.equal(f.filter(12, 0), 12);
  assert.equal(f.filter(NaN, 10), 12);
  assert.equal(f.filter(Infinity, 20), 12);
  assert.ok(Number.isFinite(f.filter(20, 30)));
});
test("filter ignores repeated and backward timestamps", () => {
  const f = new Filter();
  f.filter(12, 100);
  assert.equal(f.filter(999, 100), 12);
  assert.equal(f.filter(999, 90), 12);
});
test("invalid filter configuration is rejected", () => {
  for (const opts of [{minCutoff: 0}, {beta: -1}, {freq: NaN}]) assert.throws(() => new Filter(opts));
});
test("pinch hysteresis and tracking-loss reset", () => {
  const fsm = new FSM();
  assert.equal(fsm.update(24), "HOVER");
  assert.equal(fsm.update(12), "PINCH_START");
  assert.equal(fsm.update(24), "DRAGGING");
  assert.equal(fsm.update(NaN), "IDLE");
  assert.equal(fsm.isPinching(), false);
});
test("a canceled pinch never becomes a one-frame drag", () => {
  const fsm = new FSM();
  fsm.update(24); fsm.update(12);
  assert.equal(fsm.update(50), "RELEASE");
});
test("invalid hysteresis thresholds are rejected", () => {
  assert.throws(() => new FSM({enterThresholdMm: 20, exitThresholdMm: 10}));
  const fsm = new FSM();
  assert.throws(() => fsm.setThresholds(0, 10));
});
test("torque results are explicitly model-derived and finite", () => {
  const torque = vm.runInContext("shoulderTorqueNm", c);
  const rested = torque({rested: true});
  const elevated = torque({armAbductionDeg: 58, elbowFlexDeg: 62});
  assert.ok(rested > 0 && elevated > rested);
});
test("all pose presets retain 25 finite joints", () => {
  const generate = vm.runInContext("buildBaseHandJoints", c);
  const pose = vm.runInContext("applyPosePreset", c);
  for (const preset of ["open", "pinch", "palm-up", "poke", "fist"]) {
    const joints = pose(generate("right"), preset, "right");
    assert.equal(Object.keys(joints).length, 25);
    for (const p of Object.values(joints)) assert.ok([p.x,p.y,p.z].every(Number.isFinite));
  }
});

"use strict";
/* Minimal DOM/Canvas/WebXR doubles. The real scripts run unchanged in a
   single vm context, exactly as four classic <script> tags do in a browser:
   top-level lexical declarations are shared across scripts. */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..", "..");
const SCRIPTS = [
  "js/hand-telemetry.js",
  "js/xr-hand-kinematics.js",
  "js/filter-lab.js",
  "js/spatial-renderer.js",
  "js/app.js"
];

class ClassList {
  constructor() { this.set = new Set(); }
  add(...names) { names.forEach(n => this.set.add(n)); }
  remove(...names) { names.forEach(n => this.set.delete(n)); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : !!force;
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
  get value() { return [...this.set].join(" "); }
}

class Ctx2D {
  constructor() {
    this.calls = [];
    this.fillStyle = ""; this.strokeStyle = ""; this.lineWidth = 1;
    this.font = ""; this.globalAlpha = 1; this.textAlign = "start"; this.textBaseline = "alphabetic";
  }
  _rec(name, args) { this.calls.push({ name, args }); }
  save() { this._rec("save", []); }
  restore() { this._rec("restore", []); }
  setTransform() { this._rec("setTransform", []); }
  setLineDash(d) { this._rec("setLineDash", [d]); }
  beginPath() { this._rec("beginPath", []); }
  closePath() { this._rec("closePath", []); }
  moveTo(x, y) { this._rec("moveTo", [x, y]); }
  lineTo(x, y) { this._rec("lineTo", [x, y]); }
  stroke() { this._rec("stroke", []); }
  fill() { this._rec("fill", []); }
  arc(x, y, r, a, b) { this._rec("arc", [x, y, r, a, b]); }
  ellipse(x, y, rx, ry, rot, a, b) { this._rec("ellipse", [x, y, rx, ry, rot, a, b]); }
  rect(x, y, w, h) { this._rec("rect", [x, y, w, h]); }
  roundRect(x, y, w, h, r) { this._rec("roundRect", [x, y, w, h, r]); }
  fillRect(x, y, w, h) { this._rec("fillRect", [x, y, w, h]); }
  strokeRect(x, y, w, h) { this._rec("strokeRect", [x, y, w, h]); }
  clearRect(x, y, w, h) { this._rec("clearRect", [x, y, w, h]); }
  clip() { this._rec("clip", []); }
  fillText(t, x, y) { this._rec("fillText", [t, x, y]); }
  strokeText(t, x, y) { this._rec("strokeText", [t, x, y]); }
  drawImage() { this._rec("drawImage", []); }
  createRadialGradient() { return { addColorStop() {} }; }
  createLinearGradient() { return { addColorStop() {} }; }
  getImageData(x, y, w, h) {
    return { data: new Uint8Array(w * h * 4), width: w, height: h };
  }
}

class El {
  constructor(id, tag = "div", doc = null) {
    this.id = id || "";
    this.tagName = tag.toUpperCase();
    this.dataset = {};
    this.attrs = {};
    this.style = {};
    this.classList = new ClassList();
    this.listeners = {};
    this.children = [];
    this.textContent = "";
    this.innerHTML = "";
    this.value = "";
    this.checked = false;
    this._doc = doc;
    this._ctx = null;
    this.width = 0; this.height = 0;
    this.clientWidth = 800; this.clientHeight = 500;
    this.readyState = 0;
    this.srcObject = null;
    this.href = ""; this.download = "";
    this.clicks = 0;
  }
  addEventListener(type, fn, opts) {
    (this.listeners[type] || (this.listeners[type] = [])).push({ fn, opts });
  }
  dispatch(type, evt = {}) {
    const out = [];
    for (const l of this.listeners[type] || []) {
      out.push(l.fn({ target: this, preventDefault() {}, stopPropagation() {}, ...evt }));
    }
    return out;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  querySelector(sel) {
    if (sel === ".btn-label") return this.children.find(c => c.classList.contains("btn-label")) || null;
    return null;
  }
  querySelectorAll(sel) {
    if (!sel.startsWith("[data-")) return [];
    const key = sel.slice(1, -1);
    return this.children.filter(c => c.attrs[key] !== undefined);
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500 }; }
  getContext(kind) {
    if (kind === "2d" && !this._ctx) this._ctx = new Ctx2D();
    return this._ctx;
  }
  click() { this.clicks++; this.dispatch("click", {}); }
  play() { return Promise.resolve(); }
  focus() {}
}
El.prototype[Symbol.iterator] = undefined;

function makeButton(id, datasetKey, datasetValue, label = "") {
  const b = new El(id, "button");
  if (datasetKey) {
    b.dataset[datasetKey.replace(/^data-/, "").replace(/-(\w)/g, (_, c) => c.toUpperCase())] = datasetValue;
    b.attrs[datasetKey] = datasetValue;
  }
  b.textContent = label;
  return b;
}

function createHarness({ xr = null, mediaDevices = true } = {}) {
  const docListeners = {};
  const winListeners = {};
  const byId = new Map();
  const allNodes = [];

  const doc = {
    hidden: false,
    body: new El("body", "body"),
    addEventListener(type, fn) { (docListeners[type] || (docListeners[type] = [])).push(fn); },
    getElementById(id) { return byId.get(id) || null; },
    createElement(tag) { const e = new El("", tag); allNodes.push(e); return e; },
    querySelectorAll(sel) {
      if (sel === "[data-app-toggle]") return selectorLists["[data-app-toggle]"];
      if (sel === "[data-view-mode]") return selectorLists["[data-view-mode]"];
      if (sel === "[data-gesture]") return selectorLists["[data-gesture]"];
      if (sel === "[data-lab-traj]") return selectorLists["[data-lab-traj]"];
      return [];
    }
  };

  function register(id, tag = "div") {
    const e = new El(id, tag, doc);
    byId.set(id, e);
    allNodes.push(e);
    return e;
  }

  const ids = [
    "renderer-engine", "xr-support-status",
    "pinch-threshold", "euro-cutoff", "desk-radius",
    "pinch-threshold-val", "euro-cutoff-val", "desk-radius-val",
    "toggle-comfort-cone", "toggle-spatial-audio", "toggle-keyboard-shortcuts",
    "btn-pinch-toggle", "btn-reset-view", "btn-export-manifest",
    "btn-export-telemetry", "btn-reset-telemetry", "btn-run-bench", "btn-enter-xr",
    "spatial-canvas", "joint-tree",
    "kv-pinch", "kv-pitch-inline", "kv-roll-inline", "kv-basis", "kv-cutoff",
    "kv-residual", "kv-rested-inline", "kv-elevated-inline", "kv-reduction",
    "kv-state", "kv-fps", "stat-fps", "stat-reduction", "stat-joints", "bench-reduction",
    "tel-frames", "tel-mean", "tel-std", "tel-path", "tel-cone", "tel-false-starts",
    "telemetry-report", "manifest-anchor",
    "filter-lab-section", "lab-traj-desc", "lab-compare-body",
    "lab-enter", "lab-exit", "lab-arm", "lab-elbow",
    "lab-enter-val", "lab-exit-val", "lab-arm-val", "lab-elbow-val",
    "lab-moment-val", "lab-sweep-chart", "lab-sweep-stats",
    "lab-trace-chart", "lab-pareto-chart", "lab-digest", "lab-share-link",
    "btn-lab-apply", "btn-lab-json", "btn-lab-csv", "btn-lab-md",
    "btn-lab-copy-link", "btn-lab-verify", "btn-lab-tamper",
    "btn-lab-selftest", "lab-verify-result", "lab-selftest-count", "lab-selftest-list",
    "toast", "bench-progress-bar", "bench-status", "bench-result"
  ];
  ids.forEach(id => register(id, id === "spatial-canvas" ? "canvas" : "div"));
  /* Mirror the initial readouts in index.html so boot-time assertions
     see the same starting text as a browser would. */
  ["kv-pinch", "kv-basis", "kv-residual", "kv-rested-inline", "kv-elevated-inline",
   "kv-reduction", "kv-pitch-inline", "kv-roll-inline", "kv-cutoff", "stat-fps",
   "stat-reduction", "kv-fps"].forEach(id => { byId.get(id).textContent = "waiting"; });
  byId.get("kv-rested-inline").textContent = "waiting";
  byId.get("kv-state").textContent = "IDLE";
  byId.get("kv-fps").textContent = "Measuring";
  byId.get("stat-joints").textContent = "25";
  byId.get("spatial-canvas").width = 800;
  byId.get("spatial-canvas").height = 500;
  byId.get("toggle-comfort-cone").classList.add("on");
  byId.get("toggle-spatial-audio").classList.add("on");
  byId.get("toggle-keyboard-shortcuts").classList.add("on");

  const xrLabel = new El("", "span");
  xrLabel.classList.add("btn-label");
  xrLabel.textContent = "Request WebXR Hand Session";
  byId.get("btn-enter-xr").appendChild(xrLabel);
  byId.get("btn-enter-xr").querySelector = sel => sel === ".btn-label" ? xrLabel : null;

  const selectorLists = {
    "[data-app-toggle]": ["code-studio", "node-graph", "sprint-kanban"].map(id => {
      const b = makeButton("toggle-" + id, "data-app-toggle", id, "On");
      b.classList.add("on");
      return b;
    }),
    "[data-view-mode]": ["passthrough", "hud", "cone"].map((v, i) => {
      const b = makeButton("view-" + v, "data-view-mode", v, { 0: "Passthrough style", 1: "HUD overlay", 2: "Comfort cone" }[i]);
      if (i === 0) b.classList.add("active");
      return b;
    }),
    "[data-gesture]": ["pinch", "stretch", "palm-up", "poke", "mouse"].map((v, i) => {
      const b = makeButton("gesture-" + v, "data-gesture", v, "Preset " + (i + 1));
      if (i === 0) b.classList.add("active");
      return b;
    }),
    "[data-lab-traj]": ["micro-tremor-hover", "step-saccade-grab", "pinch-chatter-boundary", "tracking-dropout-recovery"].map((v, i) => {
      const b = makeButton("lab-traj-" + v, "data-lab-traj", v, v);
      if (i === 0) b.classList.add("active");
      return b;
    })
  };
  Object.values(selectorLists).flat().forEach(n => allNodes.push(n));

  let clock = 0;
  let rafSeq = 0;
  const rafQueue = [];
  const timeouts = [];
  const downloads = [];

  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    document: doc,
    window: {
      devicePixelRatio: 2,
      addEventListener(type, fn) { (winListeners[type] || (winListeners[type] = [])).push(fn); },
      AudioContext: undefined,
      webkitAudioContext: undefined
    },
    navigator: {
      xr,
      mediaDevices: mediaDevices ? { getUserMedia: async () => { throw new Error("no camera"); } } : undefined
    },
    performance: { now: () => clock },
    requestAnimationFrame(cb) { rafQueue.push({ id: ++rafSeq, cb }); return rafSeq; },
    cancelAnimationFrame(id) {
      const i = rafQueue.findIndex(x => x.id === id);
      if (i >= 0) rafQueue.splice(i, 1);
    },
    setTimeout(fn, ms) { timeouts.push({ fn, ms }); return timeouts.length; },
    clearTimeout() {},
    Blob: class Blob { constructor(parts, opts) { this.parts = parts; this.type = opts && opts.type; } },
    URL: {
      createObjectURL(blob) { downloads.push(blob); return "blob:" + downloads.length; },
      revokeObjectURL() {}
    },
    TextEncoder, TextDecoder, Uint8Array
  };
  sandbox.globalThis = sandbox;
  const context = vm.createContext(sandbox);

  for (const rel of SCRIPTS) {
    const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
    vm.runInContext(src, context, { filename: rel });
  }

  const Harness = {
    context,
    app: context.SpatialHandApp,
    /* Top-level class/const declarations are lexical, not properties of
       globalThis. Evaluate them inside the same context to inspect them. */
    evalIn(code) { return vm.runInContext(code, context); },
    typeOf(name) { return vm.runInContext("typeof " + name, context); },
    doc, byId, selectorLists, docListeners, winListeners, allNodes,
    downloads,
    get clock() { return clock; },
    setClock(ms) { clock = ms; },
    advance(ms) { clock += ms; },
    /* Run every callback currently queued for one animation frame. */
    flushRaf(now = clock) {
      const due = rafQueue.splice(0, rafQueue.length);
      const out = due.map(item => item.cb(now));
      /* Fire scheduled timeout callbacks (toast, URL revoke) in the same
         simulated frame so no timer leaks between tests. */
      const timers = timeouts.splice(0, timeouts.length);
      timers.forEach(t => { try { t.fn(); } catch (_) {} });
      return out;
    },
    pendingRaf() { return rafQueue.length; },
    dispatchDoc(type, evt = {}) {
      return (docListeners[type] || []).map(fn => fn({ preventDefault() {}, ...evt }));
    },
    dispatchWin(type, evt = {}) {
      return (winListeners[type] || []).map(fn => fn({ preventDefault() {}, target: doc.body, ...evt }));
    },
    el: id => byId.get(id) || null,
    boot() { Harness.dispatchDoc("DOMContentLoaded"); },
    canvasCtx() { return byId.get("spatial-canvas").getContext("2d"); }
  };
  return Harness;
}

module.exports = { createHarness, SCRIPTS, ROOT, Ctx2D };

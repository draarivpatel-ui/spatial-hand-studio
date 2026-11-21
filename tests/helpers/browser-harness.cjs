"use strict";
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM, VirtualConsole } = require("jsdom");
const { ROOT, SCRIPTS, Ctx2D } = require("./dom-harness.cjs");

function createBrowserHarness() {
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => errors.push(error.message));
  const dom = new JSDOM(fs.readFileSync(path.join(ROOT, "index.html"), "utf8"), {
    runScripts: "outside-only", pretendToBeVisual: true,
    url: "http://localhost/", virtualConsole
  });
  const w = dom.window, contexts = new WeakMap();
  w.requestAnimationFrame = () => 1;
  w.cancelAnimationFrame = () => {};
  w.HTMLCanvasElement.prototype.getContext = function (kind) {
    if (kind !== "2d") return null;
    if (!contexts.has(this)) contexts.set(this, new Ctx2D());
    return contexts.get(this);
  };
  w.HTMLCanvasElement.prototype.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 800, height: 500, right: 800, bottom: 500
  });
  w.addEventListener("error", event => errors.push(event.message));
  const context = dom.getInternalVMContext();
  for (const rel of SCRIPTS) vm.runInContext(fs.readFileSync(path.join(ROOT, rel), "utf8"), context, { filename: rel });
  w.SpatialHandApp.boot();
  return { dom, window: w, document: w.document, app: w.SpatialHandApp, errors };
}

module.exports = { createBrowserHarness };

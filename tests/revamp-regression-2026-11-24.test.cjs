"use strict";

/* Regression coverage for the 2026-11-24 local revamp. */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const FilterLab = require("../js/filter-lab.js");

test("SHA-256 UTF-8 encoding matches Node for lone surrogates", () => {
  for (const s of ["\ud800", "\udc00", "a\ud800b"]) {
    assert.equal(FilterLab.sha256Hex(s), createHash("sha256").update(s, "utf8").digest("hex"));
  }
});

test("interactive lab charts expose focusable probes instead of hiding them in an image role", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");
  const chartSvgs = src.match(/<svg viewBox=\\?"0 0 [^>]+role=\\?"img\\?"/g) || [];
  assert.equal(chartSvgs.length, 0, "generated chart containers must not use role=img");
  assert.ok(src.includes('role="group" aria-label="Pinch distance trace'));
  assert.ok(src.includes('role="group" aria-label="Jitter versus lag'));
  assert.ok(src.includes('role="group" aria-label="Shoulder moment sweep'));
});

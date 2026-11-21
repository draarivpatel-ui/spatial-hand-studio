"use strict";
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { listProjectFiles } = require("./helpers/project-hygiene.cjs");
const ROOT = path.resolve(__dirname, "..");
const targets = listProjectFiles(ROOT).filter(f => /\.(?:js|mjs|cjs)$/.test(f));
let failed = 0;
for (const relative of targets) {
  try {
    execFileSync(process.execPath, ["--check", path.join(ROOT, relative)], { stdio: "pipe", timeout: 5000 });
  } catch (error) {
    failed++;
    console.error(relative + "\n" + String(error.stderr || error.message));
  }
}
console.log("node --check: " + (targets.length - failed) + "/" + targets.length + " files passed");
process.exitCode = failed ? 1 : 0;

"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ROOT, SCRIPTS } = require("./helpers/dom-harness.cjs");
const { listProjectFiles, findings, FORBIDDEN, PII, DASHES, mp4Metadata } = require("./helpers/project-hygiene.cjs");

const TEXT_FILES = [
  "index.html", "styles.css", "README.md", "DEVPOST_UPGRADE.md",
  "package.json", "requirements-dev.txt", ".gitignore",
  "js/hand-telemetry.js", "js/xr-hand-kinematics.js", "js/spatial-renderer.js", "js/app.js",
  "tests/kinematics.test.cjs", "tests/telemetry.test.cjs", "tests/dom-ui.test.cjs",
  "tests/webxr.test.cjs", "tests/hygiene.test.cjs", "tests/hardening.test.cjs",
  "tests/helpers/dom-harness.cjs", "tests/helpers/browser-harness.cjs",
  ".github/workflows/tests.yml"
];


function read(rel) {
  const p = path.join(ROOT, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

test("all documentation and source files exist", () => {
  for (const rel of TEXT_FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), "missing " + rel);
  }
});

test("zero em dashes and en dashes across all text files", () => {
  for (const rel of TEXT_FILES) {
    const text = read(rel);
    if (text === null) continue;
    assert.ok(!/[\u2013\u2014]/.test(text), rel + " contains an em or en dash");
    assert.ok(!/&#8(?:211|212);|&#x20(?:13|14);|&\u006ddash;|&\u006edash;/i.test(text), rel + " contains a dash entity");
  }
});

test("all project files including tests pass term and contact-data checks", () => {
  const files = listProjectFiles(ROOT);
  assert.ok(files.includes("tests/hygiene.test.cjs"));
  assert.ok(files.includes("tests/dom-ui.test.cjs"));
  assert.ok(files.includes("tests/helpers/project-hygiene.cjs"));
  assert.deepEqual(findings(ROOT), []);
});

test("no small-caps eyebrow labels in markup or CSS", () => {
  const html = read("index.html"), css = read("styles.css");
  assert.ok(!/text-transform\s*:\s*uppercase/i.test(html));
  assert.ok(!/text-transform\s*:\s*uppercase/i.test(css));
  assert.ok(!/font-variant\s*:\s*small-caps/i.test(css));
  assert.ok(!/class="[^"]*(eyebrow|kicker|overline)/i.test(html));
});

test("no external CDN, font, or tracker dependency", () => {
  const html = read("index.html");
  assert.ok(!/https?:\/\//i.test(html), "index.html has no external URLs");
  assert.ok(!/<script[^>]+src="https?:/i.test(html));
  assert.ok(!/@import\s+url/i.test(read("styles.css")));
  assert.ok(!/fetch\(|XMLHttpRequest|WebSocket\(/i.test(read("js/app.js")), "no network calls");
});

test("node --check passes on every JS file in js/ and tests/", () => {
  const all = listProjectFiles(ROOT).filter(f => /\.(?:js|mjs|cjs)$/.test(f));
  assert.ok(all.length >= SCRIPTS.length);
  for (const rel of SCRIPTS) assert.ok(all.includes(rel));
  for (const rel of all) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", path.join(ROOT, rel)], { stdio: "pipe" }), rel);
  }
});

test("package.json declares the correct test and check scripts", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.name, "spatial-hand-studio");
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.test, "node --test tests/*.test.cjs");
  assert.equal(pkg.scripts.check, "node tests/syntax-check.cjs");
  assert.equal(pkg.scripts.verify, "npm run check && npm test");
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies");
  assert.deepEqual(pkg.devDependencies, { jsdom: "24.1.3" });
  assert.equal(pkg.scripts.benchmark, "node tests/benchmark.cjs --check");
});

test("CI workflow runs node and python suites", () => {
  const wf = read(".github/workflows/tests.yml");
  assert.match(wf, /npm test/);
  assert.match(wf, /pytest -q/);
  assert.match(wf, /setup-node@v4/);
  assert.match(wf, /setup-python@v5/);
});

test("README and DEVPOST_UPGRADE contain the required sections and verified values", () => {
  const readme = read("README.md");
  const devpost = read("DEVPOST_UPGRADE.md");
  for (const section of ["Inspiration", "What it does", "How we built it", "Challenges", "Verification", "What's next"]) {
    assert.match(readme, new RegExp(section, "i"), "README missing " + section);
    assert.match(devpost, new RegExp(section, "i"), "DEVPOST missing " + section);
  }
  for (const value of ["2.99", "9.46", "68.4%", "25"]) {
    assert.ok(devpost.includes(value), "DEVPOST missing verified value " + value);
  }
  assert.match(devpost, /no measured/i);
  assert.match(devpost, /Canvas 2D/);
});

test("no build directory, cache directory, or virtualenv is tracked", () => {
  const gitignore = read(".gitignore");
  assert.match(gitignore, /\.pytest_cache\//);
  assert.match(gitignore, /\.venv\//);
  assert.match(gitignore, /__pycache__\//);
  assert.equal(fs.existsSync(path.join(ROOT, ".pytest_cache")), false, ".pytest_cache must be removed");
  assert.match(gitignore, /node_modules\//);
  assert.ok(listProjectFiles(ROOT).every(f => !f.split("/").includes("node_modules")));
});

test("video directory contains only the demo asset and its URL file", () => {
  const entries = fs.readdirSync(path.join(ROOT, "video")).sort();
  assert.deepEqual(entries, ["VIDEO_URL.txt", "demo.mp4"]);
  assert.ok(fs.statSync(path.join(ROOT, "video/demo.mp4")).size > 0);
});


test("repository text and structured media metadata pass the shared gate", () => {
  assert.deepEqual(findings(ROOT), []);
});

test("the term gate detects isolated probes and permits ordinary identifiers", () => {
  for (const word of [String.fromCharCode(65, 73), String.fromCharCode(76, 76, 77), String.fromCharCode(71, 80, 84)]) {
    assert.equal(FORBIDDEN.test(word), true);
  }
  for (const word of ["AirCast", "await", "detail", "chair", "mail", "trail"]) assert.equal(FORBIDDEN.test(word), false);
  assert.equal(DASHES.test(String.fromCharCode(0x2014)), true);
  assert.equal(DASHES.test("&" + "m" + "dash;"), true);
  const box = (type, data) => {
    const header = Buffer.alloc(8); header.writeUInt32BE(data.length + 8);
    header.write(type, 4, 4, "latin1"); return Buffer.concat([header, data]);
  };
  const textProbe = Buffer.from(String.fromCharCode(65, 73));
  const handler = box("moov", box("trak", box("mdia", box("hdlr", Buffer.concat([Buffer.alloc(24), textProbe])))));
  assert.equal(FORBIDDEN.test(mp4Metadata(handler)), true);
  const entry = Buffer.alloc(78); entry[42] = textProbe.length; textProbe.copy(entry, 43);
  const sampleDescription = box("moov", box("trak", box("mdia", box("minf", box("stbl", box("stsd", Buffer.concat([
    Buffer.alloc(8), box("avc1", entry)
  ])))))));
  assert.equal(FORBIDDEN.test(mp4Metadata(sampleDescription)), true);

});


test("the gate scans its own suites and helpers while ignoring installed packages", () => {
  const files = listProjectFiles(ROOT);
  for (const name of fs.readdirSync(path.join(ROOT, "tests")).filter(name => name.endsWith(".cjs"))) {
    assert.ok(files.includes("tests/" + name), name);
  }
  assert.ok(files.includes("tests/helpers/project-hygiene.cjs"));
  assert.ok(files.every(file => !file.split("/").includes("node_modules")));
});

test("expanded term and generic contact-data probes are detected without literal fixtures", () => {
  const probes = [
    [97,114,116,105,102,105,99,105,97,108,32,105,110,116,101,108,108,105,103,101,110,99,101],
    [109,97,99,104,105,110,101,32,108,101,97,114,110,105,110,103],
    [110,101,117,114,97,108,32,110,101,116,119,111,114,107],
    [103,101,110,101,114,97,116,105,118,101],
    [111,112,101,110,97,105], [99,108,97,117,100,101], [103,101,109,105,110,105]
  ];
  for (const chars of probes) assert.equal(FORBIDDEN.test(String.fromCharCode(...chars)), true);
  const email = String.fromCharCode(102,105,120,116,117,114,101,64,101,120,97,109,112,108,101,46,105,110,118,97,108,105,100);
  const phone = String.fromCharCode(40,53,53,53,41,32,53,53,53,45,48,49,48,48);
  const secret = String.fromCharCode(115,107,45) + "x".repeat(24);
  for (const value of [email, phone, secret]) assert.equal(PII.test(value), true);
  for (const value of ["4294967296", "1000.125", "synthetic", "node --check"]) assert.equal(PII.test(value), false);
});

test("git file discovery includes tracked and untracked tests and excludes ignored vendor files", () => {
  const fixture = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "project-gate-"));
  try {
    execFileSync("git", ["init", "--quiet", fixture], { stdio: "pipe" });
    fs.writeFileSync(path.join(fixture, ".gitignore"), "node_modules/\nignored.txt\n");
    fs.writeFileSync(path.join(fixture, "tracked.txt"), "Ordinary project text");
    execFileSync("git", ["add", "tracked.txt", ".gitignore"], { cwd: fixture, stdio: "pipe" });
    fs.mkdirSync(path.join(fixture, "tests"));
    fs.mkdirSync(path.join(fixture, "node_modules"));
    const term = String.fromCharCode(65, 73);
    fs.writeFileSync(path.join(fixture, "tests/probe.test.cjs"), term);
    fs.writeFileSync(path.join(fixture, "notes.txt"), String.fromCharCode(120,64,101,120,97,109,112,108,101,46,105,110,118,97,108,105,100));
    fs.writeFileSync(path.join(fixture, "node_modules/vendor.js"), term);
    fs.writeFileSync(path.join(fixture, "ignored.txt"), term);
    assert.deepEqual(listProjectFiles(fixture), [".gitignore", "notes.txt", "tests/probe.test.cjs", "tracked.txt"]);
    assert.deepEqual(findings(fixture), [
      "notes.txt contains contact data or a secret-shaped value",
      "tests/probe.test.cjs contains a forbidden term"
    ]);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

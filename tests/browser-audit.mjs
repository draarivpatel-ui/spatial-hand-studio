#!/usr/bin/env node
// SpatialHand Studio headless-Chromium audit. Serves the repo statically,
// loads it in headless Chrome at 1440x900 and 390x844, and verifies: zero
// console errors, zero uncaught exceptions, zero external network requests,
// no horizontal overflow, lab comparator/table/charts, trajectory presets,
// comparator-row and Apply clicks, an SVG marker click, digest parity across
// the page + JSON + CSV + Markdown, verify/tamper, the in-page self-test
// runner, and #shs= bookmark reload restoration of every field.
// Zero dependencies: Node http server + native WebSocket (Node >=22).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize, resolve } from 'node:path';

const repo = resolve(process.argv[2] || '.');
if (!existsSync(join(repo, 'index.html'))) { console.error('no index.html in ' + repo); process.exit(2); }

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.ico': 'image/x-icon', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff': 'font/woff', '.woff2': 'font/woff2', '.md': 'text/plain', '.txt': 'text/plain' };

const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = normalize(join(repo, p));
  if (!f.startsWith(repo) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'Content-Type': MIME[extname(f).toLowerCase()] || 'application/octet-stream' });
  createReadStream(f).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const ORIGIN = `http://127.0.0.1:${port}`;

const ud = mkdtempSync(join(tmpdir(), 'shs-audit-'));
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--mute-audio', '--no-first-run',
  '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${ud}`, 'about:blank'], { stdio: 'ignore' });

const sleep = ms => new Promise(r => setTimeout(r, ms));
let cdpPort = 0;
for (let i = 0; i < 100; i++) {
  const f = join(ud, 'DevToolsActivePort');
  if (existsSync(f)) { cdpPort = Number(readFileSync(f, 'utf8').split('\n')[0]); if (cdpPort) break; }
  await sleep(100);
}
if (!cdpPort) { console.error('chrome CDP never came up'); chrome.kill('SIGKILL'); process.exit(2); }

const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass: !!pass, detail: String(detail).slice(0, 200) }); };
const errors = [];
const external = [];
let navMark = 0;

try {
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });

  let id = 0; const pend = new Map(); const events = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    else if (m.method) events.push(m);
  };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => {
    const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    if (res.result?.exceptionDetails) return `__EVAL_ERR__ ${JSON.stringify(res.result.exceptionDetails).slice(0, 300)}`;
    return res.result?.result?.value;
  };

  await send('Runtime.enable'); await send('Page.enable'); await send('Log.enable'); await send('Network.enable');

  function collectIssues(since) {
    for (const e of events.slice(since)) {
      if (e.method === 'Runtime.exceptionThrown') errors.push(`exception: ${JSON.stringify(e.params.exceptionDetails?.exception?.description || e.params.exceptionDetails?.text).slice(0, 300)}`);
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') errors.push(`console.error: ${(e.params.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`);
      if (e.method === 'Log.entryAdded' && e.params.entry?.level === 'error' && e.params.entry?.source !== 'network') errors.push(`log: ${String(e.params.entry.text).slice(0, 300)}`);
      if (e.method === 'Network.loadingFailed' && !/ERR_ABORTED|net::ERR_BLOCKED_BY_CLIENT/.test(e.params.errorText || '')) errors.push(`request failed: ${e.params.errorText}`);
      if (e.method === 'Network.requestWillBeSent') {
        const u = e.params.request?.url || '';
        if (!u.startsWith(ORIGIN) && !/^(data:|blob:|about:|devtools:|chrome:|chrome-untrusted:)/.test(u)) external.push(u);
      }
    }
  }

  async function nav(url) {
    const t0 = events.length;
    const lp = new Promise(r => { const h2 = setInterval(() => { if (events.slice(t0).some(e => e.method === 'Page.loadEventFired')) { clearInterval(h2); r(); } }, 50); setTimeout(() => { clearInterval(h2); r(); }, 15000); });
    await send('Page.navigate', { url });
    await lp; await sleep(1600);
    collectIssues(t0);
  }

  async function realClick(selector) {
    const box = await evalJs(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2}); })()`);
    if (!box) return false;
    const { x, y } = JSON.parse(box);
    const hit = await evalJs(`(() => { const el = document.elementFromPoint(${x},${y}); return el ? el.closest(${JSON.stringify(selector)}) !== null : false; })()`);
    if (!hit) return 'hit-miss';
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(150);
    return true;
  }

  // ---------- Desktop 1440x900 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await nav(`${ORIGIN}/`);
  navMark = events.length;

  const dMet = JSON.parse(await evalJs('JSON.stringify({sw:document.documentElement.scrollWidth,iw:window.innerWidth})') || '{}');
  check('desktop: no horizontal overflow', dMet.sw <= dMet.iw, `${dMet.sw} vs ${dMet.iw}`);

  check('app and lab booted', await evalJs('!!window.SpatialHandApp && !!window.FilterLab && window.SpatialHandApp.lab.available === true'),
    await evalJs('typeof window.FilterLab'));
  check('lab section visible', await evalJs('!document.getElementById("filter-lab-section").hidden'), '');

  check('comparator renders all 5 profile rows', await evalJs('document.querySelectorAll("#lab-compare-body tr").length'), 5);
  check('trace chart renders an svg', await evalJs('!!document.querySelector("#lab-trace-chart svg")'), '');
  check('pareto chart renders 5 focusable markers', await evalJs('document.querySelectorAll("#lab-pareto-chart [tabindex]").length'), 5);
  check('sweep heatmap renders cells', await evalJs('document.querySelectorAll("#lab-sweep-chart rect").length > 100'),
    await evalJs('document.querySelectorAll("#lab-sweep-chart rect").length'));

  // Trajectory preset via real pointer click
  const chipClick = await realClick('[data-lab-traj="step-saccade-grab"]');
  check('desktop: trajectory chip click lands', chipClick === true, chipClick);
  check('desktop: chip switched lab trajectory', await evalJs('window.SpatialHandApp.lab.state.trajectory'), 'step-saccade-grab');
  check('desktop: chip marked active', await evalJs('document.querySelector(\'[data-lab-traj="step-saccade-grab"]\').classList.contains("active")'), '');
  check('desktop: trace chart draws FSM transition markers', await evalJs('document.querySelectorAll("#lab-trace-chart .lab-marker").length >= 1'),
    await evalJs('document.querySelectorAll("#lab-trace-chart .lab-marker").length'));
  check('desktop: url hash updated to bookmark', await evalJs('location.hash.includes("t=step-saccade-grab")'), await evalJs('location.hash'));

  // Comparator row pick via real pointer click
  const pickClick = await realClick('[data-lab-pick="one-euro-fast"]');
  check('desktop: comparator row click lands', pickClick === true, pickClick);
  check('desktop: profile switched to fast', await evalJs('window.SpatialHandApp.lab.state.profile'), 'one-euro-fast');

  // Apply a 1-Euro profile to the live rig via real pointer click
  const applyClick = await realClick('[data-lab-apply="one-euro-precision"]');
  check('desktop: Apply click lands', applyClick === true, applyClick);
  check('desktop: rig filter bank took precision params', await evalJs('window.SpatialHandApp.filterBank.opts.minCutoff') === 0.5 && await evalJs('window.SpatialHandApp.filterBank.opts.beta') === 0.001,
    await evalJs('window.SpatialHandApp.filterBank.opts.minCutoff'));
  check('desktop: cutoff readout reflects applied profile', await evalJs('document.getElementById("euro-cutoff-val").textContent'), '0.5 Hz');

  // SVG marker click via real pointer
  const markerClick = await realClick('#lab-trace-chart .lab-marker');
  check('desktop: SVG transition marker click lands', markerClick === true, markerClick);
  const paretoClick = await realClick('#lab-pareto-chart [tabindex]');
  check('desktop: SVG pareto marker click lands', paretoClick === true, paretoClick);

  // Slider input via real events on the actual element
  const sliderOk = await evalJs(`(() => { const s = document.getElementById('lab-enter'); s.value = '30'; s.dispatchEvent(new Event('input', {bubbles:true})); return window.SpatialHandApp.lab.state.enterMm; })()`);
  check('desktop: enter slider drives state and re-clamps exit', sliderOk === 30 && await evalJs('window.SpatialHandApp.lab.state.exitMm > 30'), sliderOk);

  // Self-tests via real pointer click
  const stClick = await realClick('#btn-lab-selftest');
  check('desktop: self-test runner click lands', stClick === true, stClick);
  await sleep(500);
  const stCount = await evalJs('document.getElementById("lab-selftest-count").textContent');
  check('desktop: self-tests report >=14 passing', /^(\d+)\/\d+ checks pass$/.test(stCount) && Number(stCount.split('/')[0]) >= 14, stCount);
  check('desktop: self-test list renders all pass marks', await evalJs('document.querySelectorAll("#lab-selftest-list li.pass").length') === await evalJs('document.querySelectorAll("#lab-selftest-list li").length') && await evalJs('document.querySelectorAll("#lab-selftest-list li").length') >= 14,
    await evalJs('document.querySelectorAll("#lab-selftest-list li").length'));

  // Digest parity across every surface
  const parity = await evalJs(`(() => {
    const st = window.SpatialHandApp.lab.state;
    const shown = document.getElementById('lab-digest').textContent.trim();
    const doc = JSON.parse(FilterLab.exportJson(st));
    const csv = FilterLab.exportCsv(st);
    const md = FilterLab.exportMarkdown(st);
    return JSON.stringify({ shown, json: doc.integrity.canonicalJsonSha256,
      csvHas: csv.includes(shown), mdHas: md.includes(shown),
      digest: FilterLab.digestFor(st).sha256,
      intact: FilterLab.verifyExportIntegrity(JSON.stringify(doc)).ok });
  })()`);
  const pr = JSON.parse(parity || '{}');
  check('page fingerprint equals JSON export digest', pr.shown === pr.json, `${pr.shown?.slice(0,16)} vs ${pr.json?.slice(0,16)}`);
  check('CSV header and Markdown footer carry the same digest', pr.csvHas === true && pr.mdHas === true, `csv:${pr.csvHas} md:${pr.mdHas}`);
  check('stamped digest equals fresh recomputation', pr.shown === pr.digest && pr.intact === true, '');

  // Verify + tamper via real pointer clicks
  const vb = await realClick('#btn-lab-verify');
  check('desktop: verify click lands', vb === true, vb);
  check('desktop: verify reports integrity', await evalJs('/INTEGRITY VERIFIED/.test(document.getElementById("lab-verify-result").textContent)'), await evalJs('document.getElementById("lab-verify-result").textContent.slice(0,80)'));
  const tb = await realClick('#btn-lab-tamper');
  check('desktop: tamper demo click lands', tb === true, tb);
  check('desktop: tamper demo reports detection', await evalJs('/TAMPER DETECTED/.test(document.getElementById("lab-verify-result").textContent)'), await evalJs('document.getElementById("lab-verify-result").textContent.slice(0,80)'));

  // Export buttons trigger downloads (hook anchor click)
  const dlOk = await evalJs(`(() => { const fired = []; const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function(){ fired.push(this.download); };
    for (const id of ['btn-lab-json','btn-lab-csv','btn-lab-md']) document.getElementById(id).click();
    HTMLAnchorElement.prototype.click = orig; return JSON.stringify(fired); })()`);
  check('desktop: three lab exports produce downloads', dlOk && JSON.parse(dlOk).length === 3, dlOk);

  // Bookmark link via real click
  const lb = await realClick('#btn-lab-copy-link');
  check('desktop: bookmark link click lands', lb === true, lb);
  const shareHash = await evalJs('document.getElementById("lab-share-link").value.match(/#shs=[^\\s]*/)?.[0] || ""');
  check('desktop: share field carries #shs= link', shareHash.startsWith('#shs='), shareHash.slice(0, 40));

  // ---------- #shs= reload restoration ----------
  const target = '#shs=v=1&t=tracking-dropout-recovery&f=one-euro-precision&e=18.5&x=30.25&a=45&b=96';
  await nav(`${ORIGIN}/${target}`);
  const restored = JSON.parse(await evalJs('JSON.stringify(window.SpatialHandApp.lab.state)') || '{}');
  check('reload restores all six bookmarked fields',
    restored.trajectory === 'tracking-dropout-recovery' && restored.profile === 'one-euro-precision' &&
    restored.enterMm === 18.5 && restored.exitMm === 30.25 && restored.armDeg === 45 && restored.elbowDeg === 96,
    JSON.stringify(restored));
  check('reload restores slider values', await evalJs('document.getElementById("lab-enter").value') === '18.5' && await evalJs('document.getElementById("lab-elbow").value') === '96',
    await evalJs('document.getElementById("lab-enter").value'));
  check('reload restores active trajectory chip', await evalJs('document.querySelector(\'[data-lab-traj="tracking-dropout-recovery"]\').classList.contains("active")'), '');
  check('reload restores comparator selection row', await evalJs('document.querySelector(\'[data-lab-pick="one-euro-precision"]\').classList.contains("on")'), '');
  check('reload recomputes digest for restored state', await evalJs('document.getElementById("lab-digest").textContent.trim()') === await evalJs('FilterLab.digestFor(window.SpatialHandApp.lab.state).sha256'), '');

  // Malformed hash fires hashchange, not a reload: the fail-closed path
  // keeps the last valid state rather than applying garbage.
  await nav(`${ORIGIN}/#shs=v=9&t=x&f=y&e=1&x=2&a=3&b=4`);
  check('invalid hash rejected, previous valid state kept',
    await evalJs('window.SpatialHandApp.lab.available === true && window.SpatialHandApp.lab.state.trajectory === "tracking-dropout-recovery"'),
    await evalJs('window.SpatialHandApp.lab.state.trajectory'));
  check('invalid hash left digest and comparator consistent',
    await evalJs('document.getElementById("lab-digest").textContent.trim() === FilterLab.digestFor(window.SpatialHandApp.lab.state).sha256'), '');

  // ---------- Mobile 390x844 ----------
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await nav(`${ORIGIN}/`);
  const mMet = JSON.parse(await evalJs('JSON.stringify({sw:document.documentElement.scrollWidth,iw:window.innerWidth})') || '{}');
  check('mobile: no horizontal overflow', mMet.sw <= mMet.iw, `${mMet.sw} vs ${mMet.iw}`);
  check('mobile: lab section renders', await evalJs('!document.getElementById("filter-lab-section").hidden && document.querySelectorAll("#lab-compare-body tr").length === 5'), '');
  const mChip = await realClick('[data-lab-traj="pinch-chatter-boundary"]');
  check('mobile: trajectory chip click lands', mChip === true, mChip);
  check('mobile: chip switched trajectory', await evalJs('window.SpatialHandApp.lab.state.trajectory'), 'pinch-chatter-boundary');
  const mSt = await realClick('#btn-lab-selftest');
  check('mobile: self-test runner click lands', mSt === true, mSt);
  await sleep(500);
  const mStCount = await evalJs('document.getElementById("lab-selftest-count").textContent');
  check('mobile: self-tests report >=14 passing', /^(\d+)\/\d+ checks pass$/.test(mStCount) && Number(mStCount.split('/')[0]) >= 14, mStCount);
  const mVb = await realClick('#btn-lab-verify');
  check('mobile: verify click lands', mVb === true, mVb);

  collectIssues(navMark);
  check('zero console errors', errors.filter(e => e.startsWith('console.error')).length === 0, errors.filter(e => e.startsWith('console.error')).join('; '));
  check('zero uncaught exceptions', errors.filter(e => e.startsWith('exception')).length === 0, errors.filter(e => e.startsWith('exception')).join('; '));
  check('zero page-level errors', errors.filter(e => !e.startsWith('console.error') && !e.startsWith('exception')).length === 0, errors.join('; '));
  check('zero external network requests', external.length === 0, external.join('; '));

  try { ws.close(); } catch {}
} finally {
  chrome.kill('SIGKILL');
  server.close();
  try { rmSync(ud, { recursive: true, force: true }); } catch {}
}

const pass = results.every(r => r.pass);
console.log(JSON.stringify({ pass, checks: results.length, passed: results.filter(r => r.pass).length, results, errors, external }, null, 1));
process.exit(pass ? 0 : 1);

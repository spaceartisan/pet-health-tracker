#!/usr/bin/env node
// Pet Health Tracker test suite.
//
// Runs the real index.html in simulated browsers (jsdom) connected to a fake
// Firestore that behaves like the real one: live updates, offline mode,
// pending writes, rollback of refused writes, and your firestore.rules.
//
//   npm test                                   test ../index.html
//   npm test -- --previous path/to/old.html    also test old + new side by side
//   npm test -- --verbose                      list every check, not just failures
//   npm test -- --quick                        desktop layout only (about twice as fast)
//   npm test -- --only "vet summary"           run only groups whose name contains the text
//   node run-tests.js path/to/index.html       test a different copy of the app
//
// The tests use made-up data from sample-data.json. Never put real users'
// data in this folder if the repo is public.

process.env.TZ = 'America/New_York'; // tests run as if in US Eastern time

const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
let JSDOM;
try { ({ JSDOM } = require('jsdom')); }
catch (e) { console.error('Missing library. Run "npm install" in the tests folder first.'); process.exit(1); }

// ---------- options ----------
const argv = process.argv.slice(2);
const VERBOSE = argv.includes('--verbose');
const QUICK = argv.includes('--quick'); // desktop layout only, about twice as fast
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '').toLowerCase() : ''; // run only groups whose name contains this
const prevIdx = argv.indexOf('--previous');
const PREVIOUS_PATH = prevIdx >= 0 ? path.resolve(argv[prevIdx + 1]) : null;
const appArg = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--previous' && argv[i - 1] !== '--only');
const APP_PATH = path.resolve(__dirname, appArg || '../index.html');
const ROOT = path.dirname(APP_PATH);
const read = (p) => fs.readFileSync(p, 'utf8');
if (!fs.existsSync(APP_PATH)) { console.error('Could not find ' + APP_PATH); process.exit(1); }

// The app is index.html plus styles.css and app.js next to it. The simulated
// browser can't fetch those, so they're read from disk and put into the page.
// (A single-file index.html, e.g. an older copy passed to --previous, works too.)
function assemble(file) {
  const dir = path.dirname(file);
  const release = {};
  const page = read(file)
    .replace(/<link rel="stylesheet" href="styles\.css(\?v=([^"]*))?">/, (m, q, v) => { release.css = v; return '<style>' + read(path.join(dir, 'styles.css')) + '</style>'; })
    .replace(/<script src="app\.js(\?v=([^"]*))?"><\/script>/, (m, q, v) => { release.js = v; return '<script>' + read(path.join(dir, 'app.js')) + '</script>'; });
  return { page, release };
}
const APP = assemble(APP_PATH);
const html = APP.page;
const PREVIOUS_HTML = PREVIOUS_PATH ? assemble(PREVIOUS_PATH).page : null;
const SAMPLE = JSON.parse(read(path.join(__dirname, 'sample-data.json'))).vaults;
const versionOf = (h) => { const m = h.match(/var DATA_VERSION = (\d+);/); return m ? Number(m[1]) : 0; };
const DATA_VERSION = versionOf(html);

// "Now" in every test: 10:00 AM Eastern on the day after the sample data ends
const TODAY = '2026-09-24';
const NOW = Date.parse('2026-09-24T10:00:00-04:00');
const EVENING = Date.parse('2026-09-24T21:30:00-04:00');
const STORAGE_KEY = 'petHealth.responsive.v120';
const CODE = 'PEPR2345';
const OTHER_CODE = 'KATZ2345';

// ---------- firestore.rules, read from the real file ----------
function readRules() {
  const p = path.join(ROOT, 'firestore.rules');
  if (!fs.existsSync(p)) return null;
  const t = read(p);
  const list = (t.match(/hasOnly\(\[([^\]]*)\]\)/) || [])[1] || '';
  const num = (re) => { const m = t.match(re); return m ? Number(m[1]) : Infinity; };
  return {
    fields: [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]),
    minVersion: num(/function minVersion\(\)\s*\{\s*return\s+(\d+)/),
    maxPets: num(/data\.pets\.size\(\)\s*<=\s*(\d+)/),
    maxRecords: num(/data\.records\.size\(\)\s*<=\s*(\d+)/),
    stamped: /isCurrentApp/.test(t),
  };
}
const RULES = readRules();
// A JavaScript copy of the logic in firestore.rules. Fields, limits and the
// minimum version come from the real file; if you change the rules' logic
// itself, update this function to match.
function makeRules(minVersion) {
  const r = RULES;
  return (before, after) => {
    if (!r) return true;
    if (Object.keys(after).some((k) => !r.fields.includes(k))) return false;
    if (!Array.isArray(after.pets) || after.pets.length > r.maxPets) return false;
    if (!Array.isArray(after.records) || after.records.length > r.maxRecords) return false;
    if ('_email' in after && !(typeof after._email === 'string' && after._email.length <= 254)) return false;
    if ('_createdAt' in after && typeof after._createdAt !== 'string') return false;
    if (before && '_createdAt' in before && after._createdAt !== before._createdAt) return false;
    if (r.stamped) {
      const v = after._v === undefined ? 0 : after._v;
      const w = after._w === undefined ? '' : after._w;
      if (!(typeof v === 'number' && v >= minVersion && typeof w === 'string' && w !== '')) return false;
      if (before && w === (before._w === undefined ? '' : before._w)) return false;
    }
    return true;
  };
}

// ---------- fake Firestore ----------
const server = { docs: {}, rules: null, rejected: 0 };
let clients = [];
const clone = (o) => (o === undefined ? undefined : JSON.parse(JSON.stringify(o)));
const tick = () => new Promise((r) => setTimeout(r, 0));
async function settle() { for (let i = 0; i < 25; i++) await tick(); }

function resetServer(docs) {
  for (const c of clients) c.alive = false;
  clients = [];
  server.docs = clone(docs || {});
  server.rules = RULES ? makeRules(RULES.minVersion) : null;
  server.rejected = 0;
}

function makeClient(name) {
  const c = { name, online: true, pending: [], listeners: [], alive: true };
  clients.push(c);
  c.localView = (id) => {
    let d = clone(server.docs[id]);
    for (const w of c.pending) if (w.id === id) d = w.merge ? Object.assign(d || {}, clone(w.data)) : clone(w.data);
    return d;
  };
  c.emit = (id) => {
    for (const l of c.listeners) if (l.id === id) {
      const d = c.localView(id);
      l.cb({ exists: d !== undefined, data: () => clone(d), metadata: { hasPendingWrites: c.pending.some((w) => w.id === id) } });
    }
  };
  c.flush = () => {
    if (!c.online) return;
    while (c.pending.length) {
      const w = c.pending.shift();
      const before = server.docs[w.id];
      const after = w.merge ? Object.assign({}, clone(before), clone(w.data)) : clone(w.data);
      if (server.rules && !server.rules(before, after)) {
        // Like real Firestore: refuse, and roll this device's view back
        server.rejected++;
        w.reject({ code: 'permission-denied' });
        c.emit(w.id);
        continue;
      }
      server.docs[w.id] = after;
      w.resolve();
      for (const other of clients) if (other.alive) other.emit(w.id);
    }
  };
  const docApi = (id) => ({
    get() {
      if (!c.online) return Promise.reject({ code: 'unavailable' });
      const d = clone(server.docs[id]);
      return Promise.resolve({ exists: d !== undefined, data: () => clone(d) });
    },
    set(data, opts) {
      const hasUndef = (o) => o === undefined || (o && typeof o === 'object' && Object.values(o).some(hasUndef));
      if (hasUndef(data)) throw new Error('Firestore rejects documents containing undefined values');
      return new Promise((resolve, reject) => {
        c.pending.push({ id, data: clone(data), merge: !!(opts && opts.merge), resolve, reject });
        c.emit(id);
        setTimeout(() => c.flush(), 0);
      });
    },
    onSnapshot(cb) {
      const l = { id, cb };
      c.listeners.push(l);
      if (c.online) setTimeout(() => c.emit(id), 0);
      return () => { c.listeners = c.listeners.filter((x) => x !== l); };
    },
  });
  c.firebase = {
    initializeApp() {},
    firestore() { return { collection() { return { doc: docApi }; } }; },
  };
  c.rawSet = (id, data, opts) => docApi(id).set(data, opts);
  return c;
}

// ---------- simulated browser ----------
let LAYOUT_MOBILE = false;
function openApp(client, storage, opts = {}) {
  client.alive = true;
  client.listeners = [];
  const log = { toasts: [], confirms: [], errors: [] };
  const now = opts.now === undefined ? NOW : opts.now;
  const liveVersion = opts.liveVersion === undefined ? DATA_VERSION : opts.liveVersion;
  const { VirtualConsole } = require('jsdom');
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => log.errors.push(e.message));
  const dom = new JSDOM(opts.html || html, {
    url: 'https://example.test/pet-health-tracker/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(w) {
      w.firebase = client.firebase;
      w.fetch = () => liveVersion === null
        ? Promise.reject(new Error('offline'))
        : Promise.resolve({ ok: true, json: () => Promise.resolve({ version: liveVersion }) });
      const RealDate = w.Date;
      class FakeDate extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(now); }
        static now() { return now; }
      }
      w.Date = FakeDate;
      w.Chart = function (canvas, cfg) { w.__chart = cfg; return { destroy() {} }; };
      const mobile = opts.mobile === undefined ? LAYOUT_MOBILE : opts.mobile;
      w.matchMedia = () => ({ matches: mobile, addListener() {}, removeListener() {} });
      w.HTMLElement.prototype.scrollIntoView = function () {};
      w.scrollTo = () => {};
      w.HTMLCanvasElement.prototype.getContext = () => ({ clearRect() {}, fillText() {} });
      Object.defineProperty(w, 'crypto', { value: { getRandomValues: (a) => nodeCrypto.randomFillSync(a) } });
      w.confirm = (msg) => { log.confirms.push(msg); return opts.confirmAnswer !== undefined ? opts.confirmAnswer : true; };
      for (const [k, v] of Object.entries(storage)) w.localStorage.setItem(k, v);
    },
  });
  const w = dom.window;
  const d = w.document;
  new w.MutationObserver(() => {
    const t = d.getElementById('toast').textContent;
    if (t && log.toasts[log.toasts.length - 1] !== t) log.toasts.push(t);
  }).observe(d.getElementById('toast'), { childList: true, characterData: true, subtree: true });

  const app = {
    w, d, log, client,
    $: (id) => d.getElementById(id),
    storage() { const o = {}; for (let i = 0; i < w.localStorage.length; i++) { const k = w.localStorage.key(i); o[k] = w.localStorage.getItem(k); } return o; },
    state() { return JSON.parse(w.localStorage.getItem(STORAGE_KEY) || '{"pets":[],"records":[]}'); },
    close() { client.alive = false; client.listeners = []; w.close(); },
    click(id) { d.getElementById(id).click(); },
    type(el, text) { el.focus(); el.value = text; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); },
    submit() { d.getElementById('recordForm').dispatchEvent(new w.Event('submit', { cancelable: true })); },
    // Enter in a text field. Like a real browser, it submits the surrounding
    // form unless the app prevents it (jsdom doesn't do this by itself).
    pressEnter(el) {
      const ev = new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      // The rest of the keypress goes to whichever field has the cursor now
      // (the app may have redrawn the field while handling the key).
      const target = d.activeElement && d.activeElement.form ? d.activeElement : el;
      if (!ev.defaultPrevented && target.form) target.form.dispatchEvent(new w.Event('submit', { cancelable: true }));
    },
    addLog(note) { app.$('rNote').value = note; app.submit(); },
    selectPet(name) { [...d.querySelectorAll('.pet-row')].find((b) => b.textContent.includes(name)).click(); },
    openSync() { app.click('authBtn'); },
    loadCode(code) { app.openSync(); app.$('msExisting').value = code; app.click('msLoad'); },
    editLog(id) { d.querySelector('.record[data-id="' + id + '"] [data-action="edit"]').click(); },
    addFormMed(name, note) {
      app.click('addMedRow');
      const rows = d.querySelectorAll('#medRows .med-row');
      const row = rows[rows.length - 1];
      app.type(row.querySelector('.med-name'), name);
      if (note !== undefined) app.type(row.querySelector('.med-note'), note);
      return row;
    },
    routine() {
      return [...d.querySelectorAll('#todayList .routine-row')].map((el) => ({
        el,
        name: el.querySelector('b').textContent,
        done: el.classList.contains('done'),
        note: el.querySelector('[data-field="note"]'),
        weight: el.querySelector('[data-field="weight"]'),
        log: el.querySelector('[data-log]'),
        undo: el.querySelector('[data-undo]'),
        stop: el.querySelector('[data-stop]'),
        makeDefault: el.querySelector('[data-default]'),
        desc: el.querySelector('.routine-desc'),
        status: el.querySelector('.routine-main span:last-child'),
      }));
    },
    row(name) { return app.routine().find((r) => r.name === name); },
    chart(mode) { app.$('chartMode').value = mode; app.$('chartMode').dispatchEvent(new w.Event('change')); return w.__chart; },
  };
  return app;
}

// ---------- helpers ----------
// Expected weight text, worked out independently of the app
function lbOz(lb) {
  const totalOz = Math.round(Math.abs(lb) * 16 * 10) / 10;
  const whole = Math.floor(totalOz / 16);
  const oz = Math.round((totalOz - whole * 16) * 10) / 10;
  const ozText = String(Number(oz.toFixed(1)));
  return whole ? whole + ' lb' + (oz ? ' ' + ozText + ' oz' : '') : ozText + ' oz';
}
const signedLbOz = (d) => (d > 0 ? '+' : d < 0 ? '−' : '±') + lbOz(d);
const vault = (code) => clone(SAMPLE[code]);
const linked = (code, data) => ({ 'petHealth.syncCode': code, [STORAGE_KEY]: JSON.stringify({ pets: data.pets, records: data.records }) });
const unlinked = (data) => ({ [STORAGE_KEY]: JSON.stringify({ pets: data.pets, records: data.records }) });
const cloudNotes = (code = CODE) => server.docs[code].records.map((r) => r.note).filter(Boolean);
const todays = (records, petId) => records.filter((r) => r.date === TODAY && (!petId || r.petId === petId));
const medsOf = (records) => records.flatMap((r) => (r.meds || []).map((m) => Object.assign({ log: r }, m)));
const withRoutine = (data, routine) => { const v = clone(data); v.pets[0].routine = routine; return v; };
const ROUTINE = [
  { id: 'i-famo', kind: 'medication', med: 'Famotidine', note: 'Antacid 1/4 of a 10 mg pill twice a day' },
  { id: 'i-pro', kind: 'medication', med: 'Proviable-DC', note: 'Probiotic' },
];

// ---------- results ----------
const groups = [];
let current = null;
function check(name, cond, detail) { current.results.push({ name, ok: !!cond, detail }); }
async function runGroup(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY) && name !== 'Setup') return;
  current = { name, results: [] };
  groups.push(current);
  try { await fn(); }
  catch (e) { check('ran without crashing', false, (e && e.stack || String(e)).split('\n').slice(0, 3).join(' | ')); }
  finally { for (const c of clients) c.alive = false; }
}

// =====================================================================
// SETUP: the files agree with each other
// =====================================================================
async function setupChecks() {
  check('index.html has a DATA_VERSION', DATA_VERSION > 0, DATA_VERSION);
  if (APP.release.css !== undefined || APP.release.js !== undefined) {
    check('styles.css and app.js are loaded with the same ?v= release number', APP.release.css && APP.release.css === APP.release.js, APP.release);
  }
  const vp = path.join(ROOT, 'version.json');
  const live = fs.existsSync(vp) ? Number(JSON.parse(read(vp)).version) : null;
  check('version.json exists and matches DATA_VERSION', live === DATA_VERSION, { 'version.json': live, DATA_VERSION });
  check('firestore.rules exists', !!RULES);
  if (!RULES) return;
  check('rules minVersion is not above DATA_VERSION (else every save is refused)', RULES.minVersion <= DATA_VERSION, { minVersion: RULES.minVersion, DATA_VERSION });
  if (RULES.minVersion < DATA_VERSION) {
    notes.push('firestore.rules minVersion (' + RULES.minVersion + ') is below DATA_VERSION (' + DATA_VERSION + '). ' +
      'Once this version is live on GitHub Pages, raise minVersion to ' + DATA_VERSION + ' and publish the rules.');
  }
  // Every theme color the CSS uses is defined, and themes only override real ones
  const css = (html.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  const rootBlock = (css.match(/:root\s*\{([\s\S]*?)\n\}/) || [])[1] || '';
  const defined = new Set([...rootBlock.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
  const undefinedVars = [...used].filter((v) => !defined.has(v));
  check('every color the CSS uses is defined', undefinedVars.length === 0, undefinedVars);
  const themeBlocks = [...css.matchAll(/:root\[data-theme="([\w-]+)"\]\s*\{([\s\S]*?)\n\}/g)];
  const unknown = themeBlocks.flatMap(([, name, body]) => [...body.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]).filter((v) => !defined.has(v)).map((v) => name + ' ' + v));
  check('themes only override colors that exist', themeBlocks.length > 0 && unknown.length === 0, unknown);
  // Readability: key text/background pairs reach 4.5:1 in every theme
  const hexes = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  const baseColors = hexes(rootBlock);
  const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const PAIRS = [['grey text on cards', '--muted', '--card'], ['grey text on the page', '--muted', '--bg'], ['grey text on tinted boxes', '--muted', '--bg-2'],
    ['button text on green', '--on-accent', '--sage'], ['green text on cards', '--sage', '--card'], ['chart labels', '--chart-text', '--card'], ['main text', '--ink', '--bg']];
  const lowContrast = [];
  [['garden', {}]].concat(themeBlocks.map(([, name, body]) => [name, hexes(body)])).forEach(([name, over]) => {
    const c = Object.assign({}, baseColors, over);
    PAIRS.forEach(([label, fg, bg]) => { const r = contrast(c[fg], c[bg]); if (r < 4.5) lowContrast.push(name + ': ' + label + ' ' + r.toFixed(2)); });
  });
  check('text is readable in every theme (4.5:1)', lowContrast.length === 0, lowContrast);
  // Chart lines and bars stand out from the card (3:1, the guideline for graphics)
  const CHART = ['--chart-accent', '--chart-accent-bar', '--chart-accent-soft', '--chart-avg', '--chart-vomit', '--chart-diarrhea',
    '--chart-s1', '--chart-s2', '--chart-s3', '--chart-s4', '--chart-s5', '--chart-s6'];
  const faintCharts = [];
  [['garden', {}]].concat(themeBlocks.map(([, name, body]) => [name, hexes(body)])).forEach(([name, over]) => {
    const c = Object.assign({}, baseColors, over);
    CHART.forEach((k) => {
      if (!c[k]) { faintCharts.push(name + ': ' + k + ' is not a solid color'); return; }
      const r = contrast(c[k], c['--card']);
      if (r < 3) faintCharts.push(name + ': ' + k + ' ' + r.toFixed(2));
    });
  });
  check('chart lines and bars stand out in every theme (3:1)', faintCharts.length === 0, faintCharts);
  const writesStamp = /_v:\s*DATA_VERSION,\s*_w:/.test(html);
  check('rules allow the fields the app saves', !writesStamp || (RULES.fields.includes('_v') && RULES.fields.includes('_w')), RULES.fields);
}
const notes = [];

// =====================================================================
// CONVERSION: logs in the older format convert without losing anything
// =====================================================================
async function conversion() {
  resetServer({ [CODE]: vault(CODE) });
  const original = vault(CODE);
  const A = openApp(makeClient('a'), linked(CODE, original));
  await settle();
  A.addLog('trigger a save');
  await settle();
  const after = server.docs[CODE];
  const byId = Object.fromEntries(after.records.map((r) => [r.id, r]));
  const lost = [];
  for (const o of original.records) {
    const n = byId[o.id];
    if (!n) { lost.push([o.id, 'log missing']); continue; }
    for (const k of ['date', 'petId', 'weight', 'mood', 'activity', 'cost', 'food', 'note']) {
      if (String(o[k] == null ? '' : o[k]) !== String(n[k] == null ? '' : n[k])) lost.push([o.id, k, o[k], n[k]]);
    }
    if (o.med && !(n.meds || []).some((m) => m.name === o.med.trim())) lost.push([o.id, 'medicine', o.med]);
    const kinds = [...(n.tags || [])];
    if (n.weight !== '' && n.weight != null) kinds.push('weight');
    if ((n.meds || []).length) kinds.push('medication');
    if (n.food) kinds.push('meal');
    if (n.activity !== '' && n.activity != null) kinds.push('activity');
    // Version 4: Diarrhea became a Stool log labelled Diarrhea
    const expectType = o.type === 'diarrhea' ? 'stool' : o.type;
    if (expectType && !kinds.includes(expectType)) lost.push([o.id, 'type', o.type, kinds]);
    if (o.type === 'diarrhea' && !(n.stoolKinds || []).includes('Diarrhea')) lost.push([o.id, 'diarrhea label missing']);
  }
  check('every log kept', after.records.length === original.records.length + 1, [original.records.length, after.records.length]);
  check('no field, medicine or log type lost', lost.length === 0, lost.slice(0, 5));
  check('converted logs record the current format version', after.records.every((r) => r.v === DATA_VERSION));
  check('save accepted by the rules', server.rejected === 0 && !A.log.toasts.some((t) => /failed|full/i.test(t)), A.log.toasts);
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();
}

// =====================================================================
// SYNC: devices sharing a vault
// =====================================================================
async function sync() {
  // 1. A device that's been open a while doesn't erase another device's logs
  resetServer({ [CODE]: vault(CODE) });
  let A = openApp(makeClient('phone'), linked(CODE, vault(CODE)));
  let B = openApp(makeClient('laptop'), linked(CODE, vault(CODE)));
  await settle();
  B.addLog('from laptop'); await settle();
  A.addLog('from phone'); await settle();
  check('both devices\' logs survive', cloudNotes().includes('from laptop') && cloudNotes().includes('from phone'));
  check('phone shows the laptop\'s log without reloading', A.state().records.some((r) => r.note === 'from laptop'));
  A.close(); B.close();

  // 1b. Saving the instant the app opens, before the cloud copy has arrived
  const newer = vault(CODE);
  newer.records.push({ id: 'newer', petId: 'p-pepper', date: '2026-09-23', type: 'symptom', note: 'newer on the server' });
  resetServer({ [CODE]: newer });
  A = openApp(makeClient('phone'), linked(CODE, vault(CODE)));   // this device hasn't seen that log yet
  A.addLog('saved immediately');                                   // no waiting
  await settle();
  check('saving right after opening doesn\'t overwrite newer cloud data', cloudNotes().includes('newer on the server') && cloudNotes().includes('saved immediately'), cloudNotes().slice(-3));
  A.close();

  // 2. Deleting your last pet doesn't bring the demo pet back
  resetServer({ [CODE]: { pets: [], records: [], _createdAt: 'x' } });
  A = openApp(makeClient('a'), linked(CODE, { pets: [], records: [] }));
  await settle();
  check('no demo pet on a synced device with no pets', A.state().pets.length === 0 && server.docs[CODE].pets.length === 0);
  A.close();
  A = openApp(makeClient('a'), unlinked({ pets: [], records: [] }));
  await settle();
  check('no demo pet after deleting your last pet (device without sync)', A.state().pets.length === 0 && !A.d.getElementById('petList').textContent.includes('Felix'));
  A.close();

  // 3. Corrupted storage on a synced device doesn't overwrite the vault
  resetServer({ [CODE]: vault(CODE) });
  A = openApp(makeClient('a'), { 'petHealth.syncCode': CODE, [STORAGE_KEY]: '{corrupt' });
  await settle();
  check('corrupted device leaves the vault alone', !server.docs[CODE].pets.some((p) => p.name === 'Felix') && server.docs[CODE].records.length === SAMPLE[CODE].records.length);
  check('corrupted device recovers from the cloud', A.state().pets.some((p) => p.name === 'Pepper'));
  A.close();

  // 4. Fresh device: demo pet, then loading a code replaces it without asking
  resetServer({ [OTHER_CODE]: vault(OTHER_CODE) });
  A = openApp(makeClient('a'), {});
  await settle();
  check('first visit shows the demo pet', A.state().pets.some((p) => p.name === 'Felix'));
  A.loadCode(OTHER_CODE); await settle();
  check('loads a code without asking when only demo data is here', A.log.confirms.length === 0 && A.state().pets[0].name === 'Biscuit');
  check('demo data never reaches the cloud', !JSON.stringify(server.docs[OTHER_CODE]).includes('Felix'));
  A.close();

  // 5. A mistyped code that happens to be valid
  resetServer({ [CODE]: vault(CODE) });
  A = openApp(makeClient('a'), unlinked(vault(OTHER_CODE)));
  await settle();
  A.loadCode('ZZZZ2345'); await settle();
  check('wrong code: "No vault found"', A.log.toasts.some((t) => t.includes('No vault found')), A.log.toasts);
  check('wrong code: no vault created, device not linked', !('ZZZZ2345' in server.docs) && !A.storage()['petHealth.syncCode']);
  A.close();

  // 6. A device with its own pets asks before replacing them
  resetServer({ [CODE]: vault(CODE) });
  A = openApp(makeClient('a'), unlinked(vault(OTHER_CODE)), { confirmAnswer: false });
  await settle();
  A.loadCode(CODE); await settle();
  check('asks before replacing this device\'s pets', A.log.confirms.some((c) => c.startsWith('Replace the data')));
  check('cancelling keeps them and stays unlinked', A.state().pets[0].name === 'Biscuit' && !A.storage()['petHealth.syncCode']);
  A.close();

  // 7. Logged offline, app closed, reopened later
  resetServer({ [CODE]: vault(CODE) });
  const cP = makeClient('phone');
  A = openApp(cP, linked(CODE, vault(CODE)));
  await settle();
  cP.online = false;
  A.addLog('logged offline at the vet'); await settle();
  const saved = A.storage();
  A.close(); cP.pending = []; // closing the app drops the unsent write
  B = openApp(makeClient('laptop'), linked(CODE, vault(CODE)));
  await settle(); B.addLog('from laptop meanwhile'); await settle(); B.close();
  A = openApp(makeClient('phone again'), saved);
  await settle();
  check('offline log reaches the cloud after reopening', cloudNotes().includes('logged offline at the vet'));
  check('the laptop\'s log is kept too', cloudNotes().includes('from laptop meanwhile'));
  check('unsent-changes flag cleared', !A.storage()['petHealth.unsyncedChanges']);
  A.close();

  // 7b. Two devices add to the same day's routine log, one of them offline
  const three = withRoutine(vault(CODE), ROUTINE.concat([{ id: 'i-gaba', kind: 'medication', med: 'Gabapentin', note: '' }]));
  resetServer({ [CODE]: three });
  const cP2 = makeClient('phone');
  A = openApp(cP2, linked(CODE, three));
  await settle();
  A.row('Famotidine').log.click(); await settle();          // online: creates today's log
  cP2.online = false;
  A.row('Proviable-DC').log.click(); await settle();        // offline
  const saved2 = A.storage();
  A.close(); cP2.pending = [];
  B = openApp(makeClient('laptop'), linked(CODE, three));
  await settle();
  B.row('Gabapentin').log.click(); await settle();          // laptop adds to the same log
  B.close();
  A = openApp(makeClient('phone again'), saved2);
  await settle();
  const names = medsOf(todays(server.docs[CODE].records)).map((m) => m.name).sort();
  check('same-day log: the offline medicine survives', names.includes('Proviable-DC'), names);
  check('same-day log: the other device\'s medicine survives', names.includes('Gabapentin') && names.includes('Famotidine'), names);
  A.close();

  // 8. New vault from a fresh device
  resetServer({});
  A = openApp(makeClient('a'), {});
  await settle();
  A.openSync(); A.click('msGenerate'); await settle();
  const newCode = A.storage()['petHealth.syncCode'];
  check('new vault created', !!(newCode && server.docs[newCode]), newCode);
  check('new vault has no demo data', server.docs[newCode] && server.docs[newCode].pets.length === 0);
  A.close();

  // 9. Renaming a pet while an update arrives
  resetServer({ [CODE]: vault(CODE) });
  A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  B = openApp(makeClient('b'), linked(CODE, vault(CODE)));
  await settle();
  A.click('editPetBtn');
  B.addLog('arrives mid-edit'); await settle();
  A.$('mName').value = 'Pepper Jr'; A.click('mSave'); await settle();
  check('rename saved despite an update mid-edit', server.docs[CODE].pets.some((p) => p.name === 'Pepper Jr'));
  check('the other device\'s log kept', cloudNotes().includes('arrives mid-edit'));
  check('_createdAt preserved', server.docs[CODE]._createdAt === SAMPLE[CODE]._createdAt);
  A.close(); B.close();
}

// =====================================================================
// EVERYDAY: dates, escaping, editing
// =====================================================================
async function everyday() {
  resetServer({ [CODE]: vault(CODE) });
  let A = openApp(makeClient('a'), linked(CODE, vault(CODE)), { now: EVENING });
  await settle();
  check('9:30 PM: date field shows today, not tomorrow', A.$('rDate').value === TODAY, A.$('rDate').value);
  A.addLog('evening log'); await settle();
  const ev = A.state().records.find((r) => r.note === 'evening log');
  check('9:30 PM: log saved with today\'s date', ev && ev.date === TODAY, ev && ev.date);
  check('form resets to today after saving', A.$('rDate').value === TODAY);
  A.close();

  // Anything stored in a vault is shown as text, never run as code
  const evil = '<img src=x id=pwned onerror="window.hacked=1">';
  const bad = vault(CODE);
  bad.pets[0].name = evil;
  bad.records.push({ id: 'evil', petId: 'p-pepper', date: '2026-09-23', type: evil, weight: evil, mood: evil, activity: evil, cost: evil, food: evil, med: evil, note: evil });
  bad.records.push({ id: 'evil2', petId: 'p-pepper', date: '2026-09-23', meds: [{ name: evil, note: evil }], tags: [evil], weight: '', note: '' });
  resetServer({ [CODE]: bad });
  A = openApp(makeClient('a'), linked(CODE, bad));
  await settle();
  A.chart('types'); A.chart('weight');
  check('stored HTML is never turned into page elements', !A.d.getElementById('pwned') && !A.w.hacked);
  check('it\'s shown as plain text instead', A.$('records').textContent.includes('<img src=x'));
  A.close();

  // Editing a log keeps it on its own pet
  resetServer({ [CODE]: vault(CODE) });
  A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  const target = SAMPLE[CODE].records.filter((r) => r.petId === 'p-pepper' && r.type === 'symptom').pop();
  A.editLog(target.id);
  A.selectPet('Miso');
  A.$('rNote').value = 'Wheezy snoring (corrected)';
  A.submit(); await settle();
  const edited = A.state().records.find((r) => r.id === target.id);
  check('an edited log stays with its pet', edited && edited.petId === 'p-pepper', edited && edited.petId);
  check('the edit was saved', edited && edited.note === 'Wheezy snoring (corrected)');
  A.close();
}

// =====================================================================
// ROUTINE: daily checklist
// =====================================================================
async function routine() {
  resetServer({ [CODE]: vault(CODE) });
  const A = openApp(makeClient('phone'), linked(CODE, vault(CODE)));
  const B = openApp(makeClient('laptop'), linked(CODE, vault(CODE)));
  await settle();
  const chips = [...A.d.querySelectorAll('[data-suggest]')].map((b) => b.textContent.replace('★', '').trim());
  check('suggests medicines given on most recent days', chips.includes('Famotidine') && chips.includes('Proviable-DC'), chips);
  check('doesn\'t suggest a medicine from another pet', !chips.includes('Gabapentin'), chips);
  [...A.d.querySelectorAll('[data-suggest]')].find((b) => b.textContent.includes('Famotidine')).click(); await settle();
  check('suggestions are replaced by the checklist once there\'s a routine', !A.d.querySelector('[data-suggest]'));
  // Further items are added with the ★ in the log form
  A.addFormMed('Proviable-DC').querySelector('.star').click(); await settle();
  A.click('starWeight'); await settle();
  A.click('clearForm');
  const pepper = () => A.state().pets.find((p) => p.id === 'p-pepper');
  const famoItem = (pepper().routine || []).find((it) => it.med === 'Famotidine');
  check('a suggested medicine takes its latest dose', famoItem && famoItem.note === 'Antacid 1/4 of a 10 mg pill twice a day', famoItem);
  const proItem = (pepper().routine || []).find((it) => it.med === 'Proviable-DC');
  check('a starred medicine takes its latest dose', proItem && proItem.note === 'Probiotic', proItem);
  check('checklist has both medicines and a weigh-in, none done', A.routine().length === 3 && A.routine().every((r) => !r.done), A.routine().map((r) => r.name));
  check('the routine syncs to the other device', ((B.state().pets.find((p) => p.id === 'p-pepper').routine) || []).length === 3);

  A.click('logAllMeds'); await settle();
  let meds = medsOf(todays(A.state().records, 'p-pepper'));
  check('"Log all" logs both medicines with their doses', meds.length === 2 &&
    meds.find((m) => m.name === 'Famotidine').note === 'Antacid 1/4 of a 10 mg pill twice a day' &&
    meds.find((m) => m.name === 'Proviable-DC').note === 'Probiotic', meds.map((m) => [m.name, m.note]));
  check('done items show when they were logged', /10:00/.test(A.row('Famotidine').status.textContent), A.row('Famotidine').status.textContent);

  const weigh = A.row('Weigh-in');
  weigh.log.click(); await settle();
  check('weigh-in refuses an empty weight', A.log.toasts.includes('Enter a weight first'), A.log.toasts);
  A.type(A.row('Weigh-in').weight, '11.12');
  A.row('Weigh-in').log.click(); await settle();
  check('weigh-in logs the weight', todays(A.state().records, 'p-pepper').some((r) => Number(r.weight) === 11.12));
  check('all three done', A.routine().every((r) => r.done));
  check('the other device sees today\'s logs', medsOf(todays(B.state().records, 'p-pepper')).length === 2);

  A.row('Famotidine').undo.click(); await settle();
  meds = medsOf(todays(A.state().records, 'p-pepper'));
  check('Undo takes one medicine back out', meds.length === 1 && meds[0].name === 'Proviable-DC', meds.map((m) => m.name));

  // Logging through the form (any capitalisation) ticks the matching item
  A.addFormMed('famotidine', 'given in the form');
  A.submit(); await settle();
  check('a medicine logged through the form ticks its box', A.row('Famotidine').done);

  // The routine never adds to a log made through the form
  A.$('rWeight').value = '11.2'; A.addLog('At vet'); await settle();
  const vetLog = todays(A.state().records).find((r) => r.note === 'At vet');
  check('form logs are left alone by the routine', vetLog && (vetLog.meds || []).length === 0, vetLog);

  A.selectPet('Miso'); await settle();
  check('each pet has its own routine', A.routine().length === 0);
  check('no script errors', A.log.errors.length === 0 && B.log.errors.length === 0, A.log.errors.concat(B.log.errors));
  A.close(); B.close();
}

// =====================================================================
// DOSES: editing, defaults, typing through updates
// =====================================================================
async function doses() {
  const data = withRoutine(vault(CODE), ROUTINE);
  resetServer({ [CODE]: data });
  let A = openApp(makeClient('phone'), linked(CODE, data));
  const B = openApp(makeClient('laptop'), linked(CODE, data));
  await settle();
  check('each dose is pre-filled with its default', A.row('Famotidine').note.value === ROUTINE[0].note && A.row('Proviable-DC').note.value === 'Probiotic');
  check('"Make default" hidden while unchanged', A.row('Famotidine').makeDefault.hidden);

  // Typing while another device's update redraws the checklist
  A.type(A.row('Famotidine').note, 'Antacid 1/4 pill, only took half');
  A.row('Famotidine').note.setSelectionRange(8, 8);
  B.addLog('laptop log while phone is typing'); await settle();
  check('an update from the other device arrived', A.state().records.some((r) => r.note === 'laptop log while phone is typing'));
  check('typed text survives the redraw', A.row('Famotidine').note.value === 'Antacid 1/4 pill, only took half');
  check('the cursor stays in place', A.d.activeElement === A.row('Famotidine').note && A.row('Famotidine').note.selectionStart === 8);
  check('"Make default" appears once the dose differs', !A.row('Famotidine').makeDefault.hidden);

  A.row('Famotidine').log.click(); await settle();
  const famo = medsOf(todays(A.state().records, 'p-pepper')).find((m) => m.name === 'Famotidine');
  check('the edited dose is used for this log', famo && famo.note === 'Antacid 1/4 pill, only took half', famo);
  check('...without changing the default', A.state().pets[0].routine.find((it) => it.med === 'Famotidine').note === ROUTINE[0].note);
  A.row('Famotidine').undo.click(); await settle();
  check('after Undo the default is back', A.row('Famotidine').note.value === ROUTINE[0].note);

  // Changing the default
  A.type(A.row('Famotidine').note, 'Antacid 1/3 of a 10 mg pill twice a day');
  A.row('Famotidine').makeDefault.click(); await settle();
  const newDefault = server.docs[CODE].pets[0].routine.find((it) => it.med === 'Famotidine').note;
  check('"Make default" saves and syncs the new default', newDefault === 'Antacid 1/3 of a 10 mg pill twice a day', newDefault);
  A.row('Famotidine').log.click(); await settle();
  check('later logs use the new default', medsOf(todays(A.state().records)).some((m) => m.note === 'Antacid 1/3 of a 10 mg pill twice a day'));
  A.close(); B.close();

  // A form log made first is never added to by the routine
  resetServer({ [CODE]: data });
  A = openApp(makeClient('a'), linked(CODE, data));
  await settle();
  A.$('rWeight').value = '11.2';
  A.addLog('At vet'); await settle();
  A.row('Famotidine').log.click(); await settle();
  const vet = todays(A.state().records).find((r) => r.note === 'At vet');
  check('quick log doesn\'t go into an earlier form log', vet && (vet.meds || []).length === 0, vet);
  check('...it gets its own log', medsOf(todays(A.state().records)).some((m) => m.name === 'Famotidine'));
  check('...and shows its dose, not the form log\'s note', A.row('Famotidine').desc && A.row('Famotidine').desc.textContent === ROUTINE[0].note);
  A.close();

  // The "stop daily" star asks first
  resetServer({ [CODE]: data });
  A = openApp(makeClient('a'), linked(CODE, data), { confirmAnswer: false });
  await settle();
  A.row('Famotidine').stop.click(); await settle();
  check('"stop daily" asks first', A.log.confirms.some((c) => c.includes('Famotidine')));
  check('cancelling keeps it', server.docs[CODE].pets[0].routine.length === 2);
  A.close();
  A = openApp(makeClient('b'), linked(CODE, data), { confirmAnswer: true });
  await settle();
  A.row('Famotidine').stop.click(); await settle();
  check('confirming removes it', server.docs[CODE].pets[0].routine.length === 1);
  A.close();
}

// =====================================================================
// CHARTS
// =====================================================================
async function charts() {
  resetServer({ [CODE]: vault(CODE) });
  let A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  const dn = (d) => { const p = d.split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 864e5); };
  const setRange = (v) => { A.$('chartRange').value = v; A.$('chartRange').dispatchEvent(new A.w.Event('change')); return A.w.__chart; };
  // Independent calculation from the sample data (all history)
  const byDay = {};
  SAMPLE[CODE].records.filter((r) => r.petId === 'p-pepper' && r.weight !== '' && r.weight != null)
    .sort((a, b) => a.date.localeCompare(b.date)).forEach((r) => { byDay[r.date] = Number(r.weight); });
  const days = Object.keys(byDay).sort();
  const vals = days.map((d) => byDay[d]);
  const avg = days.map((d) => {
    const inWeek = days.map((x, j) => [x, vals[j]]).filter(([x]) => dn(d) - dn(x) >= 0 && dn(d) - dn(x) <= 6);
    return Math.round(inWeek.reduce((s, [, v]) => s + v, 0) / inWeek.length * 100) / 100;
  });

  check('90 days is the default range', A.$('chartRange').value === '90');

  // All time
  A.chart('weight');
  let cfg = setRange('all');
  let sets = cfg.data.datasets;
  check('weight: one point per day', sets[0].data.length === days.length, [sets[0].data.length, days.length]);
  check('weight: daily values correct', JSON.stringify(sets[0].data.map((p) => p.y)) === JSON.stringify(vals));
  check('weight: 7-day average correct', sets[1] && JSON.stringify(sets[1].data.map((p) => p.y)) === JSON.stringify(avg));
  const gap = sets[0].data[1].x - sets[0].data[0].x;
  check('points are placed by date: a 13-month gap is 13 months wide', gap === dn('2026-04-01') - dn('2025-02-21') && sets[0].data[2].x - sets[0].data[1].x === 1, gap);
  const x = cfg.options.scales.x;
  check('the x axis is a date axis', x.type === 'linear' && /Apr/.test(x.ticks.callback(dn('2026-04-01'))));
  check('dates show the year when the chart spans years', /2026/.test(x.ticks.callback(dn('2026-04-01'))));
  const tip = cfg.options.plugins.tooltip.callbacks.title([{ parsed: { x: dn('2026-09-23') } }]);
  check('tooltips show the full date', /Sep/.test(tip) && /23/.test(tip) && /2026/.test(tip), tip);
  let summary = A.$('chartSummary').textContent;
  check('all time: summary shows latest (in lb and oz), 30-day and since-start', summary.includes('Latest ' + lbOz(vals[vals.length - 1])) && /30 days/.test(summary) && /Since Feb 21, 2025/.test(summary), summary);

  // 90 days
  cfg = setRange('90');
  sets = cfg.data.datasets;
  const from = '2026-06-27';
  const inRange = days.filter((d) => d >= from);
  check('90 days: only the last 90 days are shown', sets[0].data.length === inRange.length && sets[0].data.every((p) => p.x >= dn(from)), [sets[0].data.length, inRange.length]);
  check('90 days: the axis spans the whole range', cfg.options.scales.x.min === dn(from) && cfg.options.scales.x.max === dn(TODAY));
  check('90 days: no year on the dates', !/2026/.test(cfg.options.scales.x.ticks.callback(dn('2026-08-01'))));
  const firstIdx = days.indexOf(inRange[0]);
  check('90 days: the average at the start still uses the days before it', sets[1].data[0].y === avg[firstIdx]);
  summary = A.$('chartSummary').textContent;
  check('90 days: the summary follows the range', /Since Jun 27, 2026/.test(summary), summary);
  check('the range is remembered on this device', A.storage()['petHealth.chartRange'] === '90');

  // Other charts follow the range too
  const moodCfg = A.chart('mood');
  check('mood: placed by date', moodCfg.options.scales.x.type === 'linear' && moodCfg.data.datasets[0].data.every((p) => typeof p.x === 'number'));
  const vomitsAll = SAMPLE[CODE].records.filter((r) => r.petId === 'p-pepper' && r.type === 'vomit');
  const total = (c) => c.data.datasets[0].data.reduce((s, n) => s + n, 0);
  let v = A.chart('vomit-weekly');
  const inWindow = vomitsAll.filter((r) => r.date >= '2026-06-22').length; // from the Monday of the range's first week
  check('vomit per week: counts episodes in the range', total(v) === inWindow, [total(v), inWindow]);
  v = setRange('all');
  check('vomit per week: all time counts every episode', total(v) === vomitsAll.length, [total(v), vomitsAll.length]);
  setRange('30');
  A.chart('mood');
  check('summary hidden for other charts', A.$('chartSummary').textContent === '');
  const st = A.storage();
  A.close();
  A = openApp(makeClient('b'), st);
  await settle();
  check('the saved range is used after reopening', A.$('chartRange').value === '30');
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();
}

// =====================================================================
// UPDATE PROTECTION
// =====================================================================
async function updates() {
  resetServer({ [CODE]: vault(CODE) });
  let A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  A.addLog('first'); await settle();
  const w1 = server.docs[CODE]._w;
  A.addLog('second'); await settle();
  check('saves carry the app version', server.docs[CODE]._v === DATA_VERSION, server.docs[CODE]._v);
  check('each save has a new write stamp', w1 && server.docs[CODE]._w && w1 !== server.docs[CODE]._w);
  check('no update banner when up to date', A.$('updateBanner').hidden);
  A.close();

  if (RULES && RULES.stamped) {
    // A copy of the app that doesn't stamp its saves (i.e. from before this scheme)
    const raw = makeClient('unstamped');
    let refused = false;
    await raw.rawSet(CODE, { pets: server.docs[CODE].pets, records: server.docs[CODE].records }, { merge: true }).catch(() => { refused = true; });
    await settle();
    check('the rules refuse saves without a write stamp', refused);

    // The rules move on to a newer version while this copy is still open
    resetServer({ [CODE]: vault(CODE) });
    server.rules = makeRules(DATA_VERSION + 1);
    const cA = makeClient('stale');
    A = openApp(cA, linked(CODE, vault(CODE)));
    await settle();
    A.addLog('made on an outdated copy'); await settle();
    check('outdated copy: save refused', server.rejected >= 1 && !cloudNotes().includes('made on an outdated copy'));
    check('outdated copy: banner with Reload shown', !A.$('updateBanner').hidden && /Reload/.test(A.$('updateBanner').textContent));
    check('outdated copy: the change stays on the device', A.state().records.some((r) => r.note === 'made on an outdated copy'));
    const refusedSoFar = server.rejected;
    A.addLog('second outdated change'); await settle();
    check('outdated copy: stops retrying until reload', server.rejected === refusedSoFar);
    const st = A.storage(); A.close();
    server.rules = makeRules(RULES.minVersion); // reload brings the current version
    A = openApp(makeClient('reloaded'), st);
    await settle();
    check('after reload, unsent changes reach the cloud', cloudNotes().includes('made on an outdated copy') && cloudNotes().includes('second outdated change'));
    A.close();
  }

  // A newer version is live
  resetServer({ [CODE]: vault(CODE) });
  A = openApp(makeClient('a'), linked(CODE, vault(CODE)), { liveVersion: DATA_VERSION + 1 });
  await settle();
  check('newer version.json: banner shown on open', !A.$('updateBanner').hidden && /new version/i.test(A.$('updateBannerText').textContent));
  A.close();

  // Logs from a newer format: stop saving rather than damage them
  const future = vault(CODE);
  future.records.push({ id: 'future', v: DATA_VERSION + 1, petId: 'p-pepper', date: '2026-09-23', note: 'from a newer version', somethingNew: [{ x: 1 }] });
  resetServer({ [CODE]: future });
  const before = JSON.stringify(server.docs[CODE]);
  A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  const localBefore = A.storage()[STORAGE_KEY];
  A.addLog('should not save'); await settle();
  check('newer-format data: banner shown', !A.$('updateBanner').hidden);
  check('newer-format data: nothing written to the cloud or device', JSON.stringify(server.docs[CODE]) === before && A.storage()[STORAGE_KEY] === localBefore);
  A.close();
}

// =====================================================================
// THEMES
// =====================================================================
async function themes() {
  resetServer({ [CODE]: vault(CODE) });
  let A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  const root = () => A.d.documentElement.getAttribute('data-theme');
  const meta = () => A.d.querySelector('meta[name="theme-color"]').getAttribute('content');
  check('default theme when nothing is saved', !root());
  A.click('themeBtn');
  const options = [...A.d.querySelectorAll('[data-theme-id]')];
  check('picker lists Garden, Night and Ocean', options.map((o) => o.getAttribute('data-theme-id')).join() === 'garden,night,ocean');
  check('current theme is marked', options[0].getAttribute('aria-pressed') === 'true');
  A.chart('weight');
  const gardenAccent = A.w.__chart.data.datasets[0].pointBackgroundColor;
  A.d.querySelector('[data-theme-id="night"]').click(); await settle();
  check('choosing Night applies it', root() === 'night');
  check('Night is saved on this device', A.storage()['petHealth.theme'] === 'night');
  check('phone status bar color follows the theme', meta() === '#171614', meta());
  check('chart redraws in the theme\'s colors', A.w.__chart.data.datasets[0].pointBackgroundColor === '#8db27a' && gardenAccent === '#6b8e5a',
    [gardenAccent, A.w.__chart.data.datasets[0].pointBackgroundColor]);
  check('picker marks Night as current', A.d.querySelector('[data-theme-id="night"]').getAttribute('aria-pressed') === 'true');
  A.addLog('logged in night theme'); await settle();
  check('the theme isn\'t saved to the shared vault', !JSON.stringify(server.docs[CODE]).includes('night') || !('theme' in server.docs[CODE]));
  const st = A.storage();
  A.close();

  A = openApp(makeClient('b'), st);
  check('saved theme is applied as the page opens', A.d.documentElement.getAttribute('data-theme') === 'night');
  await settle();
  check('...and the status bar matches', A.d.querySelector('meta[name="theme-color"]').getAttribute('content') === '#171614');
  A.click('themeBtn');
  A.d.querySelector('[data-theme-id="ocean"]').click(); await settle();
  check('switching to Ocean', root() === 'ocean' && A.storage()['petHealth.theme'] === 'ocean');
  A.d.querySelector('[data-theme-id="garden"]').click(); await settle();
  check('back to Garden removes the theme', !root() && A.storage()['petHealth.theme'] === 'garden');
  A.click('modalClose');
  A.click('mobileFab');
  check('theme picker is in the phone menu too', !!A.$('miTheme'));
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();
}

// =====================================================================
// VET SUMMARY
// =====================================================================
async function vetSummary() {
  const sampleOf = (fn) => SAMPLE[CODE].records.filter((r) => r.petId === 'p-pepper' && fn(r));
  const inRange = (from, to) => (r) => r.date >= from && r.date <= to;
  const weightOn = (d) => sampleOf((r) => r.type === 'weight' && r.date === d)[0].weight;
  const fmt = (n) => Number(n).toFixed(2).replace(/\.?0+$/, '');
  const data = withRoutine(vault(CODE), ROUTINE);
  resetServer({ [CODE]: data });
  let A = openApp(makeClient('a'), linked(CODE, data));
  await settle();
  let printed = 0;
  A.w.print = () => { printed++; };
  const report = () => A.$('vetReport');
  const text = () => report().textContent;
  const create = (setup) => { A.click('vetSummaryBtn'); if (setup) setup(); A.click('vsCreate'); };
  const medRow = (name) => [...report().querySelectorAll('tr')].find((tr) => tr.querySelector('b') && tr.querySelector('b').textContent === name);

  // Options window
  A.click('vetSummaryBtn');
  const periods = [...A.$('vsPeriod').options].map((o) => o.value);
  check('no vet visit logged: "since last vet visit" not offered', !periods.includes('vet') && A.$('vsPeriod').value === '90', periods);
  check('pounds and ounces by default', A.$('vsUnit').value === 'lboz');
  check('full log off by default', A.$('vsFullLog').checked === false);
  A.click('vsCancel');

  // Last 90 days (Jun 27 – Sep 24)
  create();
  check('summary opens', !report().hidden && /Health summary: Pepper/.test(text()));
  check('shows the period', text().includes('(90 days)') && text().includes('Weights in lb and oz'));
  const wStart = weightOn('2026-06-27'), wEnd = weightOn('2026-09-23');
  check('weight: start and latest', text().includes(lbOz(wStart)) && text().includes(lbOz(wEnd)), [lbOz(wStart), lbOz(wEnd)]);
  const change = wEnd - wStart;
  check('weight: change and percentage', text().includes(signedLbOz(change)) &&
    text().includes((change >= 0 ? '+' : '−') + Math.abs(change / wStart * 100).toFixed(1) + '%'), signedLbOz(change));
  check('weight: chart drawn', !!report().querySelector('svg.vr-chart polyline'));
  check('daily medicine: given 89 of 89 days (today not counted yet)', medRow('Famotidine') && medRow('Famotidine').textContent.includes('89 of 89 days'), medRow('Famotidine') && medRow('Famotidine').textContent);
  check('latest dose shown', medRow('Famotidine').textContent.includes('Antacid 1/4 of a 10 mg pill twice a day'));
  check('no dose change inside this period', medRow('Famotidine').textContent.includes('None'));
  const vomits = sampleOf((r) => r.type === 'vomit' && inRange('2026-06-27', '2026-09-24')(r)).length;
  check('vomiting count', text().includes('Vomiting: ' + vomits), vomits);
  check('another pet\'s diarrhea is not included', text().includes('Stool logs: 0') && !/Diarrhea \d/.test(text()));
  const noteRows = sampleOf((r) => ['symptom', 'activity'].includes(r.type) && inRange('2026-06-27', '2026-09-24')(r)).length;
  const sections = [...report().querySelectorAll('section')];
  const notesSection = sections.find((sec) => sec.querySelector('h2').textContent === 'Symptoms and notes');
  check('symptoms and notes listed', notesSection.querySelectorAll('tr').length - 1 === noteRows, [notesSection.querySelectorAll('tr').length - 1, noteRows]);
  check('medicine doses aren\'t repeated as notes', !notesSection.textContent.includes('Antacid') && !notesSection.textContent.includes('Probiotic'));
  check('no full log unless asked', !report().querySelector('.vr-full'));
  check('the vault code never appears', !report().innerHTML.includes(CODE));
  A.click('vrPrint');
  check('Print button opens the print dialog', printed === 1);
  A.click('vrClose');
  check('Close hides the summary', report().hidden && !A.d.body.classList.contains('vr-open'));

  // Whole history: dose change, and counting from the first dose
  create(() => { A.$('vsPeriod').value = 'custom'; A.$('vsPeriod').dispatchEvent(new A.w.Event('change')); A.$('vsFrom').value = '2026-04-01'; A.$('vsTo').value = '2026-09-23'; });
  check('dose change listed with its date', medRow('Famotidine').textContent.includes('Antacid 1/6 of a 10 mg pill twice a day → Antacid 1/4 of a 10 mg pill twice a day') && /Jun 1\b/.test(medRow('Famotidine').textContent), medRow('Famotidine').textContent);
  check('counted from the first dose when it started in the period', medRow('Proviable-DC').textContent.includes('146 of 146 days'), medRow('Proviable-DC').textContent);
  A.click('vrClose');
  create(() => { A.$('vsPeriod').value = 'custom'; A.$('vsPeriod').dispatchEvent(new A.w.Event('change')); A.$('vsFrom').value = '2026-09-10'; A.$('vsTo').value = '2026-09-01'; });
  await settle();
  check('rejects a start date after the end date', A.log.toasts.includes('The start date is after the end date') && report().hidden);
  A.click('vsCancel');

  // Kilograms, full log, remembered unit
  create(() => { A.$('vsUnit').value = 'kg'; A.$('vsFullLog').checked = true; });
  check('kilograms: weights converted from pounds', text().includes('Weights in kg') && text().includes(fmt(wEnd * 0.45359237) + ' kg') && !/\d lb\b/.test(text()), fmt(wEnd * 0.45359237));
  const logsInRange = SAMPLE[CODE].records.filter((r) => r.petId === 'p-pepper' && inRange('2026-06-27', '2026-09-24')(r)).length;
  check('full log lists every log in the period', report().querySelector('.vr-full') && report().querySelectorAll('.vr-full tr').length - 1 === logsInRange, [report().querySelectorAll('.vr-full tr').length - 1, logsInRange]);
  A.d.dispatchEvent(new A.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes the summary', report().hidden);
  A.click('vetSummaryBtn');
  check('a unit picked for one summary doesn\'t change the device\'s setting', A.$('vsUnit').value === 'lboz');
  A.click('vsCancel');
  A.close();

  // Missed doses, and "since last vet visit"
  const d2 = withRoutine(vault(CODE), ROUTINE);
  d2.records = d2.records.filter((r) => !(r.med === 'Famotidine' && (r.date === '2026-08-10' || r.date === '2026-08-11')));
  d2.records.push({ id: 'vet1', petId: 'p-pepper', date: '2026-08-15', type: 'vet', weight: 11.3, note: 'Annual checkup, all good' });
  resetServer({ [CODE]: d2 });
  A = openApp(makeClient('b'), linked(CODE, d2));
  await settle();
  A.click('vetSummaryBtn');
  check('"since last vet visit" is offered and chosen', A.$('vsPeriod').value === 'vet' && A.$('vsPeriod').options[0].textContent.includes('Aug 15, 2026'));
  A.$('vsPeriod').value = '90';
  A.click('vsCreate');
  check('days given counted, with a weekly average', medRow('Famotidine').textContent.includes('87 of 89 days') && /About 6\.8 times a week/.test(medRow('Famotidine').textContent), medRow('Famotidine').textContent);
  check('vet visit appears in the notes', text().includes('Annual checkup, all good'));
  A.click('vrClose');
  A.click('vetSummaryBtn'); A.click('vsCreate');
  check('"since last vet visit" covers Aug 15 to today', text().includes('(41 days)'));
  A.click('vrClose');
  A.close();

  // Stored text is shown safely, and the phone menu has it too
  const bad = vault(CODE);
  const evil = '<img src=x id=pwned onerror="window.hacked=1">';
  bad.pets[0].name = evil; bad.pets[0].breed = evil;
  bad.records.push({ id: 'e1', petId: 'p-pepper', date: '2026-09-20', type: 'medication', med: evil, note: evil });
  bad.records.push({ id: 'e2', petId: 'p-pepper', date: '2026-09-20', type: 'symptom', note: evil });
  resetServer({ [CODE]: bad });
  A = openApp(makeClient('c'), linked(CODE, bad));
  await settle();
  A.click('vetSummaryBtn'); A.$('vsFullLog').checked = true; A.click('vsCreate');
  check('stored HTML in the summary is shown as text', !report().querySelector('#pwned') && text().includes('<img src=x'));
  A.click('vrClose');
  A.click('mobileFab');
  check('vet summary is in the phone menu', !!A.$('miVet'));
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();
  check('print shows only the summary', /@media print[\s\S]*body > \*:not\(#vetReport\)/.test(html));
}

// =====================================================================
// LABELS & PLAY: quick symptom/play labels and play size
// =====================================================================
async function labelsAndPlay() {
  resetServer({ [CODE]: vault(CODE) });
  let A = openApp(makeClient('phone'), linked(CODE, vault(CODE)));
  const B = openApp(makeClient('laptop'), linked(CODE, vault(CODE)));
  await settle();
  const d = A.d;
  const tag = (t) => d.querySelector('#rTags [data-tag="' + t + '"]');
  const chip = (kind, name) => d.querySelector('#labelPanel [data-label-kind="' + kind + '"][data-label="' + name + '"]');
  const starter = (kind, name) => d.querySelector('#labelPanel [data-starter-kind="' + kind + '"][data-label="' + name + '"]');
  const newLabel = (kind) => d.querySelector('#labelPanel [data-new-label="' + kind + '"]');
  const pepper = () => A.state().pets.find((p) => p.id === 'p-pepper');
  const latest = () => A.state().records.filter((r) => r.date === TODAY).pop();

  check('no label panel until Symptom or Activity is chosen', A.$('labelPanel').innerHTML === '');
  tag('symptom').click();
  check('choosing Symptom shows starter labels', !!starter('symptom', 'Restless'));
  starter('symptom', 'Restless').click(); await settle();
  check('tapping a starter adds it to the pet and selects it', (pepper().symptomLabels || []).includes('Restless') && chip('symptom', 'Restless').getAttribute('aria-pressed') === 'true');
  const recordsBefore = A.state().records.length;
  A.type(newLabel('symptom'), 'Climbing on counters');
  A.pressEnter(newLabel('symptom')); await settle();
  check('Enter adds a new label without saving the log', chip('symptom', 'Climbing on counters') && chip('symptom', 'Climbing on counters').getAttribute('aria-pressed') === 'true' && A.state().records.length === recordsBefore);
  check('labels sync to the other device', (B.state().pets.find((p) => p.id === 'p-pepper').symptomLabels || []).length === 2);

  tag('activity').click();
  check('choosing Activity shows play sizes', d.querySelectorAll('#labelPanel [data-size]').length === 4);
  d.querySelector('#labelPanel [data-size="big"]').click();
  A.type(newLabel('play'), 'Bed game');
  d.querySelector('#labelPanel [data-add-label="play"]').click(); await settle();
  A.addLog('Restless, then a big bed game'); await settle();
  let r = latest();
  check('the log saves its symptom labels', r && JSON.stringify(r.symptoms) === JSON.stringify(['Restless', 'Climbing on counters']), r && r.symptoms);
  check('the log saves play size and play labels', r && r.playSize === 'big' && JSON.stringify(r.playKinds) === JSON.stringify(['Bed game']), r && [r.playSize, r.playKinds]);
  check('the form clears afterwards', A.$('labelPanel').innerHTML === '' && !tag('symptom').getAttribute('aria-pressed').includes('true'));
  const card = d.querySelector('.record[data-id="' + r.id + '"]').textContent;
  check('the log card shows them', card.includes('Big play') && card.includes('Bed game') && card.includes('Restless'));

  // Labels only count when their tag is chosen
  tag('symptom').click(); chip('symptom', 'Restless').click(); tag('symptom').click();
  A.addLog('untagged'); await settle();
  r = latest();
  check('labels aren\'t saved when their tag is unticked', r.note === 'untagged' && r.symptoms.length === 0);

  // Editing restores and updates them
  const logged = A.state().records.find((x) => x.note === 'Restless, then a big bed game');
  A.editLog(logged.id);
  check('editing shows the log\'s labels and size', chip('symptom', 'Restless').getAttribute('aria-pressed') === 'true' && d.querySelector('#labelPanel [data-size="big"]').getAttribute('aria-pressed') === 'true');
  d.querySelector('#labelPanel [data-size="short"]').click();
  A.submit(); await settle();
  check('an edit updates the play size', A.state().records.find((x) => x.id === logged.id).playSize === 'short');

  // Removing a label from the pet's list keeps it on old logs
  tag('symptom').click();
  d.querySelector('#labelPanel [data-edit-labels="symptom"]').click();
  chip('symptom', 'Restless').click(); await settle();
  check('a label can be removed from the pet\'s list', !(pepper().symptomLabels || []).includes('Restless'));
  check('...logs that used it keep it', A.state().records.find((x) => x.id === logged.id).symptoms.includes('Restless'));
  A.click('clearForm');
  A.editLog(logged.id);
  check('...and it still shows when editing that log', chip('symptom', 'Restless') && chip('symptom', 'Restless').getAttribute('aria-pressed') === 'true');
  A.click('clearForm');

  // Typing a new label while another device's update redraws the form
  tag('activity').click();
  A.type(newLabel('play'), 'Str');
  newLabel('play').setSelectionRange(3, 3);
  B.addLog('laptop update'); await settle();
  check('a half-typed label survives an update from another device', newLabel('play').value === 'Str' && d.activeElement === newLabel('play'));
  A.click('clearForm');
  check('no script errors', A.log.errors.length === 0 && B.log.errors.length === 0, A.log.errors.concat(B.log.errors));
  A.close(); B.close();

  // Charts and vet summary, from logs with labels
  const data = vault(CODE);
  const add = (date, tags, extra) => data.records.push(Object.assign({ id: 'L' + data.records.length, v: DATA_VERSION, petId: 'p-pepper', date, weight: '', mood: '', activity: '', cost: '', food: '', meds: [], tags, note: 'x', symptoms: [], playSize: '', playKinds: [] }, extra));
  add('2026-09-01', ['activity'], { playSize: 'big', playKinds: ['Bed game', 'Sprints'] });
  add('2026-09-08', ['activity'], { playSize: 'big', playKinds: ['Bed game'] });
  add('2026-09-15', ['activity'], { playSize: 'decent', playKinds: ['String'] });
  add('2026-09-22', ['activity'], { playSize: 'tiny' });
  add('2026-09-02', ['symptom'], { symptoms: ['Restless', 'Begging'] });
  add('2026-09-09', ['symptom'], { symptoms: ['Restless'] });
  add('2026-09-16', ['symptom'], { symptoms: ['Restless', 'Hiding'] });
  add('2026-09-17', ['symptom'], { symptoms: ['Begging'] });
  add('2026-09-18', ['symptom'], { symptoms: ['Sneezing'] });
  add('2026-09-19', ['symptom'], { symptoms: ['Scratching'] });
  resetServer({ [CODE]: data });
  A = openApp(makeClient('c'), linked(CODE, data));
  await settle();
  A.$('chartRange').value = '30';
  const series = (cfg) => Object.fromEntries(cfg.data.datasets.map((ds) => [ds.label, ds.data.reduce((a, b) => a + b, 0)]));
  const inRange = (r) => r.date >= '2026-08-26';
  const sampleActivity = SAMPLE[CODE].records.filter((r) => r.petId === 'p-pepper' && r.type === 'activity' && r.date >= '2026-08-24').length;
  let got = series(A.chart('play-weekly'));
  check('play chart: sessions per week stacked by size', got.Big === 2 && got.Decent === 1 && got.Tiny === 1 && (got['Size not set'] || 0) === sampleActivity, got);
  got = series(A.chart('symptom-weekly'));
  const sampleSymptoms = SAMPLE[CODE].records.filter((r) => r.petId === 'p-pepper' && r.type === 'symptom' && r.date >= '2026-08-24').length;
  check('symptom chart: the four most common labels, then the rest', got.Restless === 3 && got.Begging === 2 && Object.keys(got).length === 6 && got['Other labels'] === 1 && got['No label'] === sampleSymptoms, got);
  check('both have a legend', A.w.__chart.options.plugins.legend.display === true);
  A.click('vetSummaryBtn'); A.$('vsPeriod').value = '30'; A.click('vsCreate');
  const rep = A.$('vetReport').textContent;
  const expectedSessions = 4 + sampleActivity;
  check('vet summary: play sessions by size and kind', rep.includes(expectedSessions + ' play sessions') && rep.includes('Big 2') && rep.includes('Bed game 2'), rep.slice(rep.indexOf('Play'), rep.indexOf('Play') + 120));
  check('vet summary: symptom label counts', /Restless 3 · Begging 2/.test(rep));
  check('vet summary: labels next to each note', [...A.$('vetReport').querySelectorAll('td .vr-muted')].some((e) => e.textContent === 'Restless, Hiding'));
  A.click('vrClose');
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();
}

// =====================================================================
// WEIGHT UNITS: pounds and ounces, decimal pounds, kilograms
// =====================================================================
async function weightUnits() {
  resetServer({ [CODE]: vault(CODE) });
  let A = openApp(makeClient('phone'), linked(CODE, vault(CODE)));
  const B = openApp(makeClient('laptop'), linked(CODE, vault(CODE)));
  await settle();
  const d = A.d;
  const today = () => A.state().records.filter((r) => r.date === TODAY && r.weight !== '');
  const logWeight = (lb, oz, note) => { A.$('rWeight').value = lb; A.$('rWeightOz').value = oz; A.addLog(note); };
  const setUnit = (u) => { A.$('weightUnit').value = u; A.$('weightUnit').dispatchEvent(new A.w.Event('change')); };

  check('pounds and ounces by default', A.$('weightUnit').value === 'lboz' && !A.$('rWeightOz').hidden);
  logWeight('12', '9', 'w1'); await settle();
  let r = A.state().records.find((x) => x.note === 'w1');
  check('12 lb 9 oz is stored as 12.5625 lb', r && r.weight === 12.5625, r && r.weight);
  check('the log card shows lb and oz', d.querySelector('.record[data-id="' + r.id + '"]').textContent.includes('Wt 12 lb 9 oz'));
  check('the weight stat shows lb and oz', A.$('sWeight').textContent === '12 lb 9 oz', A.$('sWeight').textContent);
  logWeight('12', '9.5', 'w2'); await settle();
  r = A.state().records.find((x) => x.note === 'w2');
  check('ounces can have a decimal', r.weight === 12.5938 && d.querySelector('.record[data-id="' + r.id + '"]').textContent.includes('12 lb 9.5 oz'), r.weight);
  logWeight('', '14', 'w3'); await settle();
  r = A.state().records.find((x) => x.note === 'w3');
  check('ounces only (e.g. a kitten)', r.weight === 0.875 && d.querySelector('.record[data-id="' + r.id + '"]').textContent.includes('Wt 14 oz'));
  logWeight('1', '20', 'w4'); await settle();
  r = A.state().records.find((x) => x.note === 'w4');
  check('16 or more ounces carry over into pounds', r.weight === 2.25 && d.querySelector('.record[data-id="' + r.id + '"]').textContent.includes('2 lb 4 oz'));
  const before = A.state().records.length;
  logWeight('-1', '', 'bad'); await settle();
  check('a negative weight is refused', A.state().records.length === before && A.log.toasts.includes('Check the weight'));
  A.click('clearForm');
  const w1 = A.state().records.find((x) => x.note === 'w1');
  A.editLog(w1.id);
  check('editing fills in pounds and ounces', A.$('rWeight').value === '12' && A.$('rWeightOz').value === '9');
  A.click('clearForm');

  // Existing decimal data (e.g. litter-box averages) shows in lb and oz
  const dec = SAMPLE[CODE].records.filter((x) => x.petId === 'p-pepper' && x.type === 'weight').pop();
  check('existing decimal weights show in lb and oz', d.querySelector('.record[data-id="' + dec.id + '"]').textContent.includes('Wt ' + lbOz(dec.weight)), lbOz(dec.weight));

  // Decimal pounds
  A.$('rWeight').value = '12'; A.$('rWeightOz').value = '8';
  setUnit('lb');
  check('switching to decimal pounds hides ounces and converts what\'s typed', A.$('rWeightOz').hidden && A.$('rWeight').value === '12.5');
  A.addLog('w5'); await settle();
  r = A.state().records.find((x) => x.note === 'w5');
  check('decimal pounds stored as typed', r.weight === 12.5 && d.querySelector('.record[data-id="' + r.id + '"]').textContent.includes('Wt 12.5 lb'));

  // Kilograms
  setUnit('kg');
  A.$('rWeight').value = '5.7'; A.addLog('w6'); await settle();
  r = A.state().records.find((x) => x.note === 'w6');
  check('kilograms are converted to pounds for storage', r.weight === Math.round(5.7 / 0.45359237 * 10000) / 10000, r.weight);
  check('...and shown in kilograms', d.querySelector('.record[data-id="' + r.id + '"]').textContent.includes('Wt 5.7 kg'));
  check('the unit is saved on this device only', A.storage()['petHealth.weightDisplay'] === 'kg' && B.$('weightUnit').value === 'lboz');
  check('the other device shows the same log in its own unit', B.d.querySelector('.record[data-id="' + r.id + '"]').textContent.includes('Wt ' + lbOz(r.weight)));
  setUnit('lboz');

  // Chart axis and tooltip
  A.$('chartRange').value = '30';
  let cfg = A.chart('weight');
  const y = cfg.options.scales.y.ticks;
  check('chart: axis marks land on whole ounces', y.stepSize > 0 && Math.abs(y.stepSize * 16 - Math.round(y.stepSize * 16)) < 1e-9, y.stepSize);
  check('chart: axis labels in lb and oz', y.callback(12.5) === '12 lb 8 oz');
  check('just under a pound rounds up: 12.999 lb is "13 lb", not "12 lb 16 oz"', y.callback(12.999) === '13 lb', y.callback(12.999));
  check('chart: tooltip in lb and oz', cfg.options.plugins.tooltip.callbacks.label({ parsed: { y: 12.5625 }, dataset: { label: 'Daily weight' } }) === 'Daily weight: 12 lb 9 oz');
  setUnit('kg');
  cfg = A.chart('weight');
  const pts = cfg.data.datasets[0].data;
  check('chart in kg: values converted', pts.every((pt) => pt.y < 7), pts.slice(-2));
  setUnit('lboz');

  check('no script errors', A.log.errors.length === 0 && B.log.errors.length === 0, A.log.errors.concat(B.log.errors));
  A.close(); B.close();

  // Checklist weigh-in with pounds and ounces (fresh vault, nothing weighed today)
  resetServer({ [CODE]: vault(CODE) });
  A = openApp(makeClient('phone'), linked(CODE, vault(CODE)));
  const B2 = openApp(makeClient('laptop'), linked(CODE, vault(CODE)));
  await settle();
  A.click('starWeight'); await settle();
  const row = () => A.row('Weigh-in');
  check('checklist weigh-in has pounds and ounces fields', !!row().weight && !!row().el.querySelector('[data-field="weightOz"]'));
  A.type(row().weight, '11');
  A.type(row().el.querySelector('[data-field="weightOz"]'), '2');
  B2.addLog('update from laptop'); await settle();
  check('typed ounces survive an update from another device', row().el.querySelector('[data-field="weightOz"]').value === '2');
  row().log.click(); await settle();
  const wi = A.state().records.filter((x) => x.routine && x.date === TODAY && x.weight !== '').pop();
  check('checklist weigh-in stored in pounds', wi && wi.weight === 11.125, wi && wi.weight);
  check('...and shown as 11 lb 2 oz', row().status.textContent.includes('11 lb 2 oz'));
  check('no script errors in the checklist', A.log.errors.length === 0 && B2.log.errors.length === 0, A.log.errors.concat(B2.log.errors));
  A.close(); B2.close();
}

// =====================================================================
// BULK IMPORT from a spreadsheet (CSV)
// =====================================================================
async function bulkImport() {
  const wait = async () => { await settle(); await new Promise((r) => setTimeout(r, 30)); await settle(); };
  // Feed a CSV file to the app, as if chosen in the file picker
  async function importCsv(A, text) {
    const input = A.$('csvInput');
    Object.defineProperty(input, 'files', { value: [new A.w.File([text], 'import.csv', { type: 'text/csv' })], configurable: true });
    input.dispatchEvent(new A.w.Event('change'));
    await wait();
  }
  // Capture files the app offers for download
  function captureDownloads(A) {
    A.downloads = [];
    A.w.URL.createObjectURL = (blob) => { A.downloads.push(blob); return 'blob:test'; };
    A.w.URL.revokeObjectURL = () => {};
    A.w.HTMLAnchorElement.prototype.click = function () {};
  }
  const readBlob = (A, blob) => new Promise((res) => { const fr = new A.w.FileReader(); fr.onload = () => res(fr.result); fr.readAsText(blob); });
  const preview = (A) => A.$('modalBody').textContent;

  resetServer({ [CODE]: vault(CODE) });
  let A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  captureDownloads(A);
  const startCount = A.state().records.length;

  A.click('importBtn');
  check('Import offers spreadsheet, template and backup restore', !!A.$('imCsv') && !!A.$('imTemplate') && !!A.$('imJson'));
  A.click('imTemplate'); await wait();
  const template = await readBlob(A, A.downloads[0]);
  check('template has the columns', /^"pet","date","lb","oz","medications","tags","symptoms","vomit","stool","vet type","play size","play"/.test(template), template.slice(0, 80));
  A.click('modalClose');
  await importCsv(A, template);
  check('importing the untouched template adds nothing', /Nothing new to add/.test(preview(A)) && /7 example rows/.test(preview(A)) && !A.$('impAdd'), preview(A));
  A.click('impCancel');

  // The main import
  const csv = [
    'pet,date,lb,oz,medications,tags,symptoms,play size,play,food,mood,activity,cost,note',
    'Pepper,9/20/2026,12,9,,,,,,,,,,Litter box average',
    'Pepper,2026-09-21,,,"Famotidine (1/4 pill); Proviable-DC (Probiotic)",,,,,,,,,',
    'pepper,"Sep 22, 2026",,,,,"Restless; Begging",,,,,,,"Restless, then begged ""a lot"""',
    'Miso,9/23/26,,,,Activity,,big,Bed game,,,,,Zoomies',
    'Biscuit,2026-09-23,24,8,,vet visit,,,,,,,$85.50,Groomer'
  ].join('\r\n');
  await importCsv(A, '\uFEFF' + csv); // with the byte-order mark Excel adds
  const pv = preview(A);
  check('preview: 5 new logs, per pet', /5 new logs to add/.test(pv) && /Pepper: 3/.test(pv) && /Miso: 1/.test(pv) && /Biscuit: 1/.test(pv), pv);
  check('preview: new pet named', /New pet will be created: Biscuit/.test(pv));
  check('nothing saved before confirming', A.state().records.length === startCount);
  A.click('impAdd'); await settle();
  const recs = A.state().records;
  const find = (note) => recs.find((r) => r.note === note);
  check('adds, never replaces', recs.length === startCount + 5 && server.docs[CODE].records.length === startCount + 5, [startCount, recs.length]);
  check('12 lb 9 oz stored as 12.5625 lb, US date read', find('Litter box average') && find('Litter box average').weight === 12.5625 && find('Litter box average').date === '2026-09-20');
  const medLog = recs.find((r) => r.date === '2026-09-21' && (r.meds || []).length === 2);
  check('medicines and doses', medLog && medLog.meds[0].name === 'Famotidine' && medLog.meds[0].note === '1/4 pill' && medLog.meds[1].note === 'Probiotic', medLog && medLog.meds);
  const sym = find('Restless, then begged "a lot"');
  check('quotes and commas inside a note; written-out date; pet name in any case', sym && sym.date === '2026-09-22' && sym.petId === 'p-pepper');
  check('symptom labels imply the Symptom tag', sym && sym.tags.includes('symptom') && JSON.stringify(sym.symptoms) === JSON.stringify(['Restless', 'Begging']));
  const play = find('Zoomies');
  check('play size and labels; 2-digit year', play && play.playSize === 'big' && play.playKinds[0] === 'Bed game' && play.tags.includes('activity') && play.date === '2026-09-23');
  const bis = A.state().pets.find((p) => p.name === 'Biscuit');
  const g = find('Groomer');
  check('new pet created and its log saved', bis && g && g.petId === bis.id && g.weight === 24.5 && g.tags.includes('vet') && g.cost === 85.5, g);
  check('imported logs record the current format version', recs.slice(-5).every((r) => r.v === DATA_VERSION));

  // The same file again
  await importCsv(A, csv);
  check('importing the same file again adds nothing', /Nothing new to add/.test(preview(A)) && /5 rows are already in the app/.test(preview(A)) && !A.$('impAdd'), preview(A));
  A.click('impCancel');

  // Problems are listed by row; good rows still import
  const bad = [
    'pet,date,lb,oz,tags,mood,play size,note',
    ',2026-09-20,12,,,,,no pet',
    'Pepper,13/45/2026,,,,,,bad date',
    'Pepper,2026-09-20,-2,,,,,negative',
    'Pepper,2026-09-20,,,,9,,mood too high',
    'Pepper,2026-09-20,,,activity,,huge,bad size',
    'Pepper,2026-09-20,,,,,,',
    'Pepper,2026-09-20,,,zoomies,,,good row with an odd tag'
  ].join('\n');
  await importCsv(A, bad);
  const bp = preview(A);
  check('problem rows listed by row number', /6 rows have problems/.test(bp) && /Row 2: No pet name/.test(bp) && /Row 3: Date "13\/45\/2026"/.test(bp) &&
    /Row 4: Weight/.test(bp) && /Row 5: Mood/.test(bp) && /Row 6: Play size "huge"/.test(bp) && /Row 7: Nothing to log/.test(bp), bp);
  check('good rows still import', /1 new log to add/.test(bp));
  check('unknown tags are mentioned, not silently dropped', /Tag "zoomies" isn't one the app uses/.test(bp));
  A.click('impCancel');
  check('cancelling saves nothing', A.state().records.length === startCount + 5);

  await importCsv(A, 'animal,day\nPepper,2026-09-20');
  check('missing pet/date columns explained', /must be column names, including "pet" and "date"/.test(preview(A)) && !A.$('impAdd'));
  A.click('impCancel');

  // Export CSV, then import it: everything is already there
  A.click('exportCsvBtn'); await wait();
  const exported = await readBlob(A, A.downloads[A.downloads.length - 1]);
  await importCsv(A, exported);
  const all = A.state().records.length;
  check('re-importing Export CSV finds every log already there', /Nothing new to add/.test(preview(A)) && new RegExp(all + ' rows are already in the app').test(preview(A)), preview(A).slice(0, 160));
  A.click('impCancel');

  // Stored text shown safely in the preview
  await importCsv(A, 'pet,date,note\n"<img src=x id=pwned>",2026-09-20,hi');
  check('names in the preview are shown as text', !A.d.getElementById('pwned') && /<img src=x id=pwned>/.test(preview(A)));
  A.click('impCancel');
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();

  // Vault size limit
  const big = vault(CODE);
  for (let i = big.records.length; i < 4995; i++) big.records.push({ id: 'f' + i, petId: 'p-pepper', date: '2026-01-01', type: 'symptom', note: 'n' + i });
  resetServer({ [CODE]: big });
  A = openApp(makeClient('b'), linked(CODE, big));
  await settle();
  const rows = ['pet,date,note'];
  for (let i = 0; i < 10; i++) rows.push('Pepper,2026-09-20,new ' + i);
  await importCsv(A, rows.join('\n'));
  check('refuses to go past 5,000 logs', /the limit is 5,000/.test(preview(A)) && !A.$('impAdd'), preview(A));
  A.close();
}

// =====================================================================
// VERSION 4: stool (was diarrhea), vomit/stool labels, vet visit type
// =====================================================================
async function stoolVomitVet() {
  // Old diarrhea logs convert to Stool: Diarrhea (old format and version 3 format)
  const data = vault(CODE);
  data.records.push({ id: 'v3d', v: 3, petId: 'p-pepper', date: '2026-09-15', weight: '', mood: '', activity: '', cost: '', food: 'Kibble',
    meds: [], tags: ['diarrhea'], note: 'v3 diarrhea', symptoms: [], playSize: '', playKinds: [] });
  resetServer({ [CODE]: data });
  let A = openApp(makeClient('a'), linked(CODE, data));
  await settle();
  A.addLog('trigger a save'); await settle();
  const cloud = server.docs[CODE].records;
  const oldMiso = cloud.find((r) => r.petId === 'p-miso' && r.note === 'Started after switching brands');
  check('old-format diarrhea log becomes Stool: Diarrhea', oldMiso && oldMiso.tags.includes('stool') && !oldMiso.tags.includes('diarrhea') && (oldMiso.stoolKinds || []).includes('Diarrhea'), oldMiso);
  check('...and keeps its food', oldMiso && oldMiso.food === 'New kibble');
  const v3 = cloud.find((r) => r.id === 'v3d');
  check('version 3 diarrhea log becomes Stool: Diarrhea', v3 && v3.tags.includes('stool') && !v3.tags.includes('diarrhea') && v3.stoolKinds.includes('Diarrhea') && v3.food === 'Kibble', v3);
  A.$('chartRange').value = 'all';
  const dw = A.chart('diarrhea-weekly');
  check('diarrhea chart still counts converted logs', dw.data.datasets[0].data.reduce((a, b) => a + b, 0) === 1);
  A.close();

  // Quick options in the form
  resetServer({ [CODE]: vault(CODE) });
  A = openApp(makeClient('b'), linked(CODE, vault(CODE)));
  await settle();
  const d = A.d;
  const tag = (t) => d.querySelector('#rTags [data-tag="' + t + '"]');
  const chip = (kind, name) => d.querySelector('#labelPanel [data-label-kind="' + kind + '"][data-label="' + name + '"]');
  const latest = () => A.state().records.filter((r) => r.date === TODAY).pop();
  check('the Diarrhea chip is now Stool', !tag('diarrhea') && tag('stool') && tag('stool').textContent === 'Stool');
  tag('stool').click();
  const stoolChips = [...d.querySelectorAll('#labelPanel [data-label-kind="stool"]')].map((b) => b.getAttribute('data-label'));
  check('stool offers its fixed options', ['Normal', 'Soft', 'Diarrhea', 'Hard', 'Blood', 'Mucus'].every((x) => stoolChips.includes(x)), stoolChips);
  chip('stool', 'Soft').click(); chip('stool', 'Mucus').click();
  A.type(d.querySelector('#labelPanel [data-new-label="stool"]'), 'Grass in it');
  A.pressEnter(d.querySelector('#labelPanel [data-new-label="stool"]')); await settle();
  tag('vomit').click();
  const vomitChips = [...d.querySelectorAll('#labelPanel [data-label-kind="vomit"]')].map((b) => b.getAttribute('data-label'));
  check('vomit offers its fixed options', ['Hairball', 'Food', 'Bile/foam', 'Liquid'].every((x) => vomitChips.includes(x)), vomitChips);
  chip('vomit', 'Hairball').click();
  tag('vet').click();
  check('vet visit offers three types', d.querySelectorAll('#labelPanel [data-vettype]').length === 3);
  d.querySelector('#labelPanel [data-vettype="emergency"]').click();
  A.addLog('rough night'); await settle();
  let r = latest();
  check('stool labels saved (fixed and custom)', r && JSON.stringify(r.stoolKinds) === JSON.stringify(['Soft', 'Mucus', 'Grass in it']), r && r.stoolKinds);
  check('vomit label saved', r && JSON.stringify(r.vomitKinds) === JSON.stringify(['Hairball']));
  check('vet visit type saved', r && r.vetType === 'emergency' && r.tags.includes('vet'));
  const pet = A.state().pets.find((p) => p.id === 'p-pepper');
  check('only the custom label is added to the pet\'s list', JSON.stringify(pet.stoolLabels) === JSON.stringify(['Grass in it']), pet.stoolLabels);
  const card = d.querySelector('.record[data-id="' + r.id + '"]').textContent;
  check('the log card shows them', card.includes('Soft') && card.includes('Hairball') && card.includes('Emergency visit') && card.includes('Stool'));
  A.editLog(r.id);
  check('editing restores the labels and visit type', chip('stool', 'Mucus').getAttribute('aria-pressed') === 'true' && d.querySelector('#labelPanel [data-vettype="emergency"]').getAttribute('aria-pressed') === 'true');
  A.click('clearForm');
  tag('stool').click();
  d.querySelector('#labelPanel [data-edit-labels="stool"]').click();
  chip('stool', 'Soft').click(); await settle(); // fixed option: toggles, can't be removed
  check('fixed options can\'t be removed', !!chip('stool', 'Soft') && chip('stool', 'Soft').getAttribute('aria-pressed') === 'true');
  chip('stool', 'Grass in it').click(); await settle();
  check('custom labels can be removed', !(A.state().pets.find((p) => p.id === 'p-pepper').stoolLabels || []).includes('Grass in it'));
  A.click('clearForm');
  const cw = A.chart('stool-weekly');
  check('Stool (weekly) chart stacks by label', cw && cw.data.datasets.some((ds) => ds.label === 'Soft'), cw && cw.data.datasets.map((x) => x.label));
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();
}

// =====================================================================
// ADD TO LAST LOG
// =====================================================================
async function addToLastLog() {
  resetServer({ [CODE]: vault(CODE) });
  const A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  const count = () => A.state().records.length;
  check('no log today: button off, hint explains', A.$('appendBtn').disabled && /No log for Pepper today yet/.test(A.$('appendHint').textContent), A.$('appendHint').textContent);
  A.$('rWeight').value = '11'; A.$('rWeightOz').value = '0';
  A.addLog('morning'); await settle();
  const before = count();
  const target = A.state().records.find((r) => r.note === 'morning');
  check('after a log: button on, hint names it', !A.$('appendBtn').disabled && /last log for today \(Weight\)/.test(A.$('appendHint').textContent), A.$('appendHint').textContent);
  A.$('rNote').value = 'evening';
  A.addFormMed('Famotidine', '1/4 pill');
  A.d.querySelector('#rTags [data-tag="symptom"]').click();
  A.click('appendBtn'); await settle();
  let t = A.state().records.find((r) => r.id === target.id);
  check('adds to the log instead of creating one', count() === before);
  check('notes combined on separate lines', t.note === 'morning\nevening', t.note);
  check('medicine and tag added', t.meds.some((m) => m.name === 'Famotidine' && m.note === '1/4 pill') && t.tags.includes('symptom'));
  check('the weight is kept', t.weight === 11);
  check('the form clears afterwards', A.$('rNote').value === '' && A.d.querySelectorAll('#medRows .med-row').length === 0);
  check('it syncs', server.docs[CODE].records.find((r) => r.id === target.id).note === 'morning\nevening');
  // A different weight asks first
  let asked = '';
  A.w.confirm = (msg) => { asked = msg; return false; };
  A.$('rWeight').value = '11'; A.$('rWeightOz').value = '4';
  A.click('appendBtn'); await settle();
  t = A.state().records.find((r) => r.id === target.id);
  check('replacing a value asks first', /Weight: 11 lb → 11 lb 4 oz/.test(asked), asked);
  check('saying no changes nothing', t.weight === 11);
  A.w.confirm = () => true;
  A.click('appendBtn'); await settle();
  t = A.state().records.find((r) => r.id === target.id);
  check('saying yes replaces it', t.weight === 11.25);
  // Another date, and editing
  A.$('rDate').value = '2026-09-20'; A.$('rDate').dispatchEvent(new A.w.Event('change'));
  check('the hint follows the chosen date', /Sep 20, 2026/.test(A.$('appendHint').textContent), A.$('appendHint').textContent);
  A.click('clearForm');
  A.editLog(target.id);
  check('hidden while editing a log', A.$('appendBtn').hidden && A.$('appendHint').hidden);
  A.click('clearForm');
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();
}

// =====================================================================
// FOOD & MOOD in the daily routine
// =====================================================================
async function foodMoodRoutine() {
  resetServer({ [CODE]: vault(CODE) });
  const A = openApp(makeClient('phone'), linked(CODE, vault(CODE)));
  const B = openApp(makeClient('laptop'), linked(CODE, vault(CODE)));
  await settle();
  const pepper = () => A.state().pets.find((p) => p.id === 'p-pepper');
  A.$('rFood').value = 'Science Diet';
  A.click('starFood'); A.click('starMood'); await settle();
  const food = (pepper().routine || []).find((it) => it.kind === 'food');
  check('★ on Food adds it with what\'s typed as the default', food && food.note === 'Science Diet', pepper().routine);
  check('★ on Mood adds it', (pepper().routine || []).some((it) => it.kind === 'mood'));
  check('stars show as on', A.$('starFood').getAttribute('aria-pressed') === 'true' && A.$('starMood').getAttribute('aria-pressed') === 'true');
  check('the routine syncs', (B.state().pets.find((p) => p.id === 'p-pepper').routine || []).length === 2);
  A.click('clearForm');
  check('checklist shows Food and Mood', !!A.row('Food') && !!A.row('Mood'));
  check('food shows its default, ready to edit', A.row('Food').note && A.row('Food').note.value === 'Science Diet');
  check('mood has 1–5 buttons', A.row('Mood').el.querySelectorAll('[data-mood]').length === 5);
  A.row('Mood').el.querySelector('[data-mood="4"]').click(); await settle();
  let logs = todays(A.state().records, 'p-pepper').filter((r) => r.routine);
  check('one tap logs mood', logs.length === 1 && logs[0].mood === 4);
  check('mood shows as done', A.row('Mood').done && /Mood 4\/5/.test(A.row('Mood').status.textContent), A.row('Mood').status.textContent);
  A.type(A.row('Food').note, 'Science Diet, 1/3 cup');
  check('"Make default" appears for an edited food', !A.row('Food').makeDefault.hidden);
  A.row('Food').log.click(); await settle();
  logs = todays(A.state().records, 'p-pepper').filter((r) => r.routine);
  check('food goes into the same routine log', logs.length === 1 && logs[0].food === 'Science Diet, 1/3 cup' && logs[0].mood === 4, logs);
  check('...without changing the default', pepper().routine.find((it) => it.kind === 'food').note === 'Science Diet');
  check('the other device sees it', todays(B.state().records, 'p-pepper').some((r) => r.food === 'Science Diet, 1/3 cup'));
  A.row('Mood').undo.click(); await settle();
  logs = todays(A.state().records, 'p-pepper').filter((r) => r.routine);
  check('Undo clears the mood only', logs[0].mood === '' && logs[0].food === 'Science Diet, 1/3 cup');
  const meds = [...A.d.querySelectorAll('#medOptions option')].map((o) => o.value);
  check('medicine suggestions don\'t list food or mood items', !meds.includes('undefined') && !meds.includes(''), meds.slice(0, 5));
  let asked = '';
  A.w.confirm = (msg) => { asked = msg; return false; };
  A.row('Food').stop.click();
  check('"stop daily" asks, naming daily food', /daily food/.test(asked), asked);
  check('no script errors', A.log.errors.length === 0 && B.log.errors.length === 0, A.log.errors.concat(B.log.errors));
  A.close(); B.close();
}

// =====================================================================
// VET SUMMARY (version 4): frequency, food, mood, breakdowns, chart marks
// =====================================================================
async function vetSummaryV4() {
  const data = withRoutine(vault(CODE), ROUTINE);
  const add = (date, extra) => data.records.push(Object.assign({ id: 'x' + data.records.length, v: DATA_VERSION, petId: 'p-pepper', date,
    weight: '', mood: '', activity: '', cost: '', food: '', meds: [], tags: [], note: '', symptoms: [], playSize: '', playKinds: [],
    vomitKinds: [], stoolKinds: [], vetType: '' }, extra));
  ['2026-08-28', '2026-09-04', '2026-09-11', '2026-09-18'].forEach((dt) => add(dt, { meds: [{ name: 'FortiFlora', note: 'Whole packet' }] }));
  add('2026-09-01', { meds: [{ name: 'Cerenia', note: '' }] });
  add('2026-09-10', { food: 'Science Diet', mood: 4 });
  add('2026-09-17', { food: 'Bland diet', mood: 2 });
  add('2026-09-12', { tags: ['stool'], stoolKinds: ['Soft'] });
  add('2026-09-13', { tags: ['stool'], stoolKinds: ['Diarrhea', 'Mucus'] });
  add('2026-09-14', { tags: ['vomit'], vomitKinds: ['Hairball'] });
  add('2026-09-15', { tags: ['vet'], vetType: 'emergency', note: 'Fluids' });
  resetServer({ [CODE]: data });
  const A = openApp(makeClient('a'), linked(CODE, data));
  await settle();
  A.click('vetSummaryBtn'); A.$('vsPeriod').value = '90'; A.click('vsCreate');
  const rep = () => A.$('vetReport');
  const text = () => rep().textContent;
  const medRow = (name) => [...rep().querySelectorAll('tr')].find((tr) => tr.querySelector('b') && tr.querySelector('b').textContent === name);
  check('daily medicine: days and weekly average', /89 of 89 days/.test(medRow('Famotidine').textContent) && /About 7 times a week/.test(medRow('Famotidine').textContent), medRow('Famotidine').textContent);
  check('weekly medicine: about once a week, no missed days', /4 of 27 days/.test(medRow('FortiFlora').textContent) && /About once a week/.test(medRow('FortiFlora').textContent) && !/[Mm]issed/.test(medRow('FortiFlora').textContent), medRow('FortiFlora').textContent);
  check('occasional medicine: less than once a week', /Less than once a week/.test(medRow('Cerenia').textContent), medRow('Cerenia').textContent);
  const foodRows = [...rep().querySelectorAll('section')].find((s) => s.querySelector('h2').textContent === 'Food');
  check('food section lists each food in order', foodRows && /Science Diet/.test(foodRows.textContent) && foodRows.textContent.indexOf('Science Diet') < foodRows.textContent.indexOf('Bland diet') && /change of food/.test(foodRows.textContent));
  const moods = data.records.filter((r) => r.petId === 'p-pepper' && r.date >= '2026-06-27' && r.mood !== '' && r.mood != null).map((r) => Number(r.mood));
  const avg = Number((moods.reduce((a, b) => a + b, 0) / moods.length).toFixed(1)).toString();
  check('mood: average and lowest', new RegExp('Average ' + avg.replace('.', '\\.') + ' of 5 over ' + moods.length + ' ratings').test(text()) && /Lowest 2 \(Sep 17\)/.test(text()), [avg, moods.length]);
  const vomits = data.records.filter((r) => r.petId === 'p-pepper' && r.date >= '2026-06-27' && (r.type === 'vomit' || (r.tags || []).includes('vomit'))).length;
  check('vomiting with label breakdown', text().includes('Vomiting: ' + vomits + ' (Hairball 1)'), vomits);
  check('stool with label breakdown', text().includes('Stool logs: 2 (Diarrhea 1 · Mucus 1 · Soft 1)'));
  check('vet visits line', /Vet visits in this period: 1 \(Emergency 1\)/.test(text()));
  // Chart marks: off by default, opt-in with checkboxes
  const boxes = () => [...rep().querySelectorAll('[data-mark]')];
  check('marks offered, all off by default', boxes().length === 5 && boxes().every((b) => !b.checked), boxes().map((b) => b.getAttribute('data-mark')));
  check('no marks on the chart by default', rep().querySelectorAll('.vr-chart title').length === 0);
  const tick = (k) => { const b = rep().querySelector('[data-mark="' + k + '"]'); b.checked = true; b.dispatchEvent(new A.w.Event('change')); };
  tick('medicine'); tick('food');
  const titles = [...rep().querySelectorAll('.vr-chart title')].map((x) => x.textContent);
  check('medicine changes marked', titles.some((x) => /FortiFlora started/.test(x)) && titles.some((x) => /Cerenia started/.test(x)), titles);
  check('food changes marked', titles.some((x) => /Changed to Bland diet/.test(x)), titles);
  check('choices remembered', JSON.parse(A.storage()['petHealth.vetMarks']).medicine === true);
  tick('diarrhea');
  check('diarrhea marked', [...rep().querySelectorAll('.vr-chart text')].some((x) => x.textContent === 'Diarrhea'));
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();
}

// =====================================================================
// CSV IMPORT (version 4 columns)
// =====================================================================
async function importV4() {
  resetServer({ [CODE]: vault(CODE) });
  const A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  const csv = ['pet,date,tags,vomit,stool,vet type,note',
    'Pepper,2026-09-20,diarrhea,,,,old word',
    'Pepper,2026-09-21,,Hairball,,,labels imply the tag',
    'Pepper,2026-09-22,,,Soft; Mucus,,',
    'Pepper,2026-09-23,,,,emergency,visit',
    'Pepper,2026-09-23,,,,urgent,bad type'].join('\n');
  const input = A.$('csvInput');
  Object.defineProperty(input, 'files', { value: [new A.w.File([csv], 'i.csv', { type: 'text/csv' })], configurable: true });
  input.dispatchEvent(new A.w.Event('change'));
  await settle(); await new Promise((r) => setTimeout(r, 30)); await settle();
  check('bad vet type reported', /Vet type "urgent"/.test(A.$('modalBody').textContent));
  A.click('impAdd'); await settle();
  const f = (note) => A.state().records.find((r) => r.note === note);
  check('"diarrhea" imports as Stool: Diarrhea', f('old word') && f('old word').tags.includes('stool') && f('old word').stoolKinds.includes('Diarrhea'));
  check('vomit labels imply the Vomit tag', f('labels imply the tag') && f('labels imply the tag').tags.includes('vomit') && f('labels imply the tag').vomitKinds[0] === 'Hairball');
  const stool = A.state().records.find((r) => r.date === '2026-09-22' && (r.stoolKinds || []).length);
  check('stool labels imply the Stool tag', stool && stool.tags.includes('stool') && stool.stoolKinds.join() === 'Soft,Mucus');
  check('vet type imports and implies the Vet tag', f('visit') && f('visit').vetType === 'emergency' && f('visit').tags.includes('vet'));
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();
}

// =====================================================================
// STORAGE: compact cloud saves, storage meter, near-full warning
// =====================================================================
async function storage() {
  resetServer({ [CODE]: vault(CODE) });
  let A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  A.addLog('compact save'); await settle();
  const cloud = server.docs[CODE].records;
  const emptyLeft = cloud.filter((r) => Object.entries(r).some(([k, v]) => !['id', 'petId', 'date', 'v', 'tags'].includes(k) &&
    (v === '' || v === null || v === false || (Array.isArray(v) && !v.length))));
  check('cloud logs are saved without empty fields', emptyLeft.length === 0, emptyLeft.slice(0, 2));
  check('...but always keep id, pet, date, version and tags', cloud.every((r) => r.id && r.petId && r.date && r.v && Array.isArray(r.tags)));
  check('this device keeps complete logs', A.state().records.every((r) => 'note' in r && 'weight' in r && Array.isArray(r.meds)));
  const B = openApp(makeClient('b'), linked(CODE, { pets: [], records: [] }));
  await settle();
  const byId = (recs) => JSON.stringify(recs.slice().sort((x, y) => x.id.localeCompare(y.id)));
  check('another device loads them back identically', byId(B.state().records) === byId(A.state().records));
  B.close();
  A.click('authBtn');
  const meter = A.d.querySelector('.storage-meter');
  check('sync window shows the storage meter', meter && /Cloud storage/.test(meter.textContent) && /% used/.test(meter.textContent) && /of 5,000 logs/.test(meter.textContent), meter && meter.textContent);
  A.click('modalClose');
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();

  // Near full (by log count): one warning per session after a save
  const big = vault(CODE);
  for (let i = big.records.length; i < 4100; i++) big.records.push({ id: 'f' + i, petId: 'p-pepper', date: '2026-01-01', tags: ['symptom'], v: DATA_VERSION });
  resetServer({ [CODE]: big });
  A = openApp(makeClient('c'), linked(CODE, big));
  await settle();
  A.addLog('one more'); await settle();
  check('near-full warning after a save', A.log.toasts.some((t) => /Cloud storage is 8\d% full/.test(t)), A.log.toasts);
  const warnings = () => A.log.toasts.filter((t) => /Cloud storage is/.test(t)).length;
  const n = warnings();
  A.addLog('and another'); await settle();
  check('...only once per session', warnings() === n);
  A.click('authBtn');
  check('the meter shows it getting full', A.d.querySelector('.storage-meter.full') && /Getting full/.test(A.d.querySelector('.storage-meter').textContent));
  A.close();
}

// =====================================================================
// CUSTOM MEASURES (version 5): setup, routine, form, chart, summary, spreadsheet
// =====================================================================
async function customMeasures() {
  resetServer({ [CODE]: vault(CODE) });
  const A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  const d = A.d;
  const pet = () => A.state().pets.find((p) => p.id === 'p-pepper');
  A.click('addMeasureBtn');
  A.$('meName').value = 'Blood glucose'; A.$('meUnit').value = 'mg/dL'; A.$('meLow').value = '80'; A.$('meHigh').value = '200';
  A.click('meSave'); await settle();
  A.click('addMeasureBtn');
  A.$('meName').value = 'Ketones'; A.$('meType').value = 'levels'; A.$('meType').dispatchEvent(new A.w.Event('change'));
  A.$('meLevelList').value = 'Negative\nTrace\nSmall\nModerate\nLarge';
  A.click('meSave'); await settle();
  const ms = pet().measures || [];
  check('measures created: a number with a normal range, and levels', ms.length === 2 && ms[0].id === 'm1' && ms[0].low === 80 && ms[0].high === 200 && ms[1].type === 'levels' && ms[1].levels.length === 5, ms);
  check('measures sync', (server.docs[CODE].pets[0].measures || []).length === 2);
  check('the form has a field per measure', d.querySelectorAll('#measureRows [data-measure]').length === 2);

  // Routine: a glucose curve from the checklist
  d.querySelector('[data-measure-star="m1"]').click(); await settle();
  const row = () => A.row('Blood glucose');
  const logOne = async (v) => { const el = row().el.querySelector('[data-mval]'); el.value = v; row().el.querySelector('[data-mlog]').click(); await settle(); };
  await logOne('142'); await logOne('260');
  const rds = todays(A.state().records, 'p-pepper').flatMap((r) => r.readings || []);
  check('several readings a day, each with a time', rds.length === 2 && rds.every((x) => x.m === 'm1' && /^\d\d:\d\d$/.test(x.t)), rds);
  check('...kept in one daily log', todays(A.state().records, 'p-pepper').filter((r) => (r.readings || []).length).length === 1);
  check('checklist shows the latest and how many today', /Latest 260 mg\/dL/.test(row().status.textContent) && /2 today/.test(row().status.textContent));
  check('a reading above the normal range is flagged', A.log.toasts.some((t) => /260 mg\/dL logged \(high\)/.test(t)));
  row().el.querySelector('[data-mundo]').click(); await settle();
  check('Undo removes only the latest reading', todays(A.state().records, 'p-pepper').flatMap((r) => r.readings || []).map((x) => x.v).join() === '142');
  await logOne('180');

  // Form: readings with a chosen time
  A.$('rDate').value = '2026-09-20'; A.$('rTime').value = '07:30';
  d.querySelector('#measureRows [data-measure="m2"]').value = 'Trace';
  d.querySelector('#measureRows [data-measure="m1"]').value = '95';
  A.addLog('morning check'); await settle();
  const f = A.state().records.find((r) => r.note === 'morning check');
  check('the form saves readings with the chosen time', f && f.readings.length === 2 && f.readings.every((x) => x.t === '07:30'), f && f.readings);
  check('log cards show readings', /Blood glucose 95 mg\/dL · 7:30/.test(d.querySelector('.record[data-id="' + f.id + '"]').textContent));
  const multi = todays(A.state().records, 'p-pepper').find((r) => (r.readings || []).length === 2);
  A.editLog(multi.id);
  d.querySelector('#measureRows [data-measure="m1"]').value = '150';
  A.submit(); await settle();
  const after = A.state().records.find((r) => r.id === multi.id);
  check('editing keeps readings the form doesn\'t show', after && after.readings.map((x) => x.v).sort().join() === '150,180', after && after.readings);

  // Chart
  A.$('chartRange').value = '30';
  check('measures appear in the chart menu', [...A.$('chartMode').options].some((o) => o.value === 'measure:m1' && o.textContent === 'Blood glucose (mg/dL)'));
  const cfg = A.chart('measure:m1');
  check('points placed by date and time of day', cfg.data.datasets[0].data.every((p) => p.x % 1 !== 0));
  check('normal range shaded', cfg.data.datasets.filter((x) => x.isRange).length === 2);
  check('levels chart labels its rows', A.chart('measure:m2').options.scales.y.ticks.callback(1) === 'Trace');

  // Vet summary: opt-in per measure
  A.click('vetSummaryBtn'); A.$('vsPeriod').value = '30'; A.click('vsCreate');
  const boxes = [...d.querySelectorAll('[data-include]')];
  check('summary offers each measure, off by default', boxes.length === 2 && boxes.every((b) => !b.checked) && !/Measurements/.test(d.querySelector('.vr-page').textContent));
  boxes.forEach((b) => { b.checked = true; b.dispatchEvent(new A.w.Event('change')); });
  const sec = d.querySelector('.vr-page').textContent;
  check('summary shows readings, average and range', /3 readings/.test(sec) && /average 141\.67 mg\/dL/.test(sec) && /lowest 95, highest 180/.test(sec) && /normal 80–200/.test(sec));
  check('summary counts levels', /Negative 0 · Trace 1 · Small 0/.test(sec));
  A.click('vrClose');

  // Spreadsheet
  A.downloads = []; A.w.URL.createObjectURL = (b) => { A.downloads.push(b); return 'blob:x'; }; A.w.URL.revokeObjectURL = () => {}; A.w.HTMLAnchorElement.prototype.click = function () {};
  A.click('exportCsvBtn'); await settle();
  const csv = await new Promise((res) => { const fr = new A.w.FileReader(); fr.onload = () => res(fr.result); fr.readAsText(A.downloads[0]); });
  check('export has a readings column', /Blood glucose=95 @07:30; Ketones=Trace @07:30/.test(csv));
  const input = A.$('csvInput');
  const imp = async (text) => { Object.defineProperty(input, 'files', { value: [new A.w.File([text], 'i.csv', { type: 'text/csv' })], configurable: true }); input.dispatchEvent(new A.w.Event('change')); await settle(); await new Promise((r) => setTimeout(r, 30)); await settle(); };
  await imp(csv);
  check('re-importing the export adds nothing', /Nothing new to add/.test(A.$('modalBody').textContent));
  A.click('impCancel');
  await imp('pet,date,readings\nPepper,2026-09-21,Blood glucose=120 @09:15; Ketones=small\nPepper,2026-09-21,Weight=5\nPepper,2026-09-21,Ketones=huge');
  const pv = A.$('modalBody').textContent;
  check('import checks the measure and its values', /1 new log to add/.test(pv) && /no measure called "Weight"/.test(pv) && /"huge" isn't one of its levels/.test(pv), pv);
  A.click('impAdd'); await settle();
  const imported = A.state().records.find((r) => r.date === '2026-09-21' && (r.readings || []).length);
  check('imported readings stored, level spelled as defined', imported && imported.readings.find((x) => x.m === 'm2').v === 'Small' && imported.readings.find((x) => x.m === 'm1').t === '09:15');

  // Another device loads them
  const B = openApp(makeClient('b'), linked(CODE, { pets: [], records: [] }));
  await settle();
  check('another device loads measures and readings', (B.state().pets.find((p) => p.id === 'p-pepper').measures || []).length === 2 && B.state().records.some((r) => (r.readings || []).length));
  B.close();
  check('no script errors', A.log.errors.length === 0, A.log.errors);
  A.close();
}

// =====================================================================
// PREVIOUS VERSION (optional): old and new copies of the app together
// =====================================================================
async function previousVersion() {
  const prevV = versionOf(PREVIOUS_HTML);
  const data = withRoutine(vault(CODE), ROUTINE);
  resetServer({ [CODE]: data });
  const O = openApp(makeClient('old'), linked(CODE, data), { html: PREVIOUS_HTML, liveVersion: DATA_VERSION });
  const N = openApp(makeClient('new'), linked(CODE, data));
  await settle();
  N.click('logAllMeds'); await settle();
  const log = todays(server.docs[CODE].records, 'p-pepper').find((r) => (r.meds || []).length === 2);
  check('new copy saves normally', !!log);
  if (prevV < DATA_VERSION) {
    // The old copy must never damage newer data: before the rules are raised
    // it has to stop itself (it sees logs from a newer version); after, the
    // rules refuse it too.
    O.close(); N.close();
    for (const [when, min] of [['before the rules are raised', RULES ? RULES.minVersion : 0], ['after the rules are raised', DATA_VERSION]]) {
      resetServer({ [CODE]: data });
      server.rules = RULES ? makeRules(min) : null;
      const n2 = openApp(makeClient('new'), linked(CODE, data));
      const o2 = openApp(makeClient('old'), linked(CODE, data), { html: PREVIOUS_HTML, liveVersion: DATA_VERSION });
      await settle();
      n2.addLog('written by the new version'); await settle();
      const newLog = server.docs[CODE].records.find((r) => r.note === 'written by the new version');
      const snapshot = JSON.stringify(newLog);
      const card = o2.d.querySelector('.record[data-id="' + (newLog && newLog.id) + '"] [data-action="edit"]');
      if (card) { card.click(); o2.$('rNote').value = 'edited on the old copy'; o2.submit(); await settle(); }
      o2.addLog('from the old copy'); await settle();
      check(when + ': old copy (version ' + prevV + ') shows the reload banner', !o2.$('updateBanner').hidden);
      check(when + ': old copy can\'t change the new version\'s logs', JSON.stringify(server.docs[CODE].records.find((r) => r.id === newLog.id)) === snapshot);
      check(when + ': old copy\'s own changes don\'t reach the cloud', !cloudNotes().includes('from the old copy'));
      n2.close(); o2.close();
    }
    return;
  } else {
    O.addLog('from the old copy'); await settle();
    check('same version: both copies save', cloudNotes().includes('from the old copy'));
    const card = O.d.querySelector('.record[data-id="' + log.id + '"] [data-action="edit"]');
    if (card) {
      card.click();
      O.$('rNote').value = 'edited on the old copy';
      O.submit(); await settle();
    }
    const after = server.docs[CODE].records.find((r) => r.id === log.id);
    check('same version: editing on the old copy keeps the medicines', after && (after.meds || []).length === 2, after);
  }
  O.close(); N.close();
}

// =====================================================================
(async () => {
  console.log('Pet Health Tracker tests');
  console.log('App: ' + APP_PATH + ' (version ' + DATA_VERSION + ')');
  if (PREVIOUS_PATH) console.log('Previous: ' + PREVIOUS_PATH + ' (version ' + versionOf(PREVIOUS_HTML) + ')');
  console.log('');
  await runGroup('Setup', setupChecks);
  for (const mobile of QUICK ? [false] : [false, true]) {
    LAYOUT_MOBILE = mobile;
    const tag = mobile ? ' (mobile)' : '';
    await runGroup('Conversion' + tag, conversion);
    await runGroup('Sync' + tag, sync);
    await runGroup('Everyday' + tag, everyday);
    await runGroup('Routine' + tag, routine);
    await runGroup('Doses' + tag, doses);
    await runGroup('Charts' + tag, charts);
    await runGroup('Update protection' + tag, updates);
    await runGroup('Themes' + tag, themes);
    await runGroup('Vet summary' + tag, vetSummary);
    await runGroup('Labels & play' + tag, labelsAndPlay);
    await runGroup('Weight units' + tag, weightUnits);
    await runGroup('Bulk import' + tag, bulkImport);
    await runGroup('Stool, vomit & vet type' + tag, stoolVomitVet);
    await runGroup('Add to last log' + tag, addToLastLog);
    await runGroup('Food & mood routine' + tag, foodMoodRoutine);
    await runGroup('Vet summary v4' + tag, vetSummaryV4);
    await runGroup('Import v4 columns' + tag, importV4);
    await runGroup('Storage' + tag, storage);
    await runGroup('Custom measures' + tag, customMeasures);
    if (PREVIOUS_HTML) await runGroup('Previous version' + tag, previousVersion);
  }
  let pass = 0, total = 0;
  for (const g of groups) {
    const ok = g.results.filter((r) => r.ok).length;
    pass += ok; total += g.results.length;
    const failed = g.results.filter((r) => !r.ok);
    console.log((failed.length ? 'FAIL ' : 'PASS ') + g.name + '  ' + ok + '/' + g.results.length);
    for (const r of g.results) {
      if (!r.ok) console.log('       x ' + r.name + (r.detail === undefined ? '' : '  -> ' + JSON.stringify(r.detail).slice(0, 300)));
      else if (VERBOSE) console.log('       - ' + r.name);
    }
  }
  console.log('');
  for (const n of notes) console.log('NOTE: ' + n);
  console.log(pass === total ? 'All ' + total + ' checks passed.' : (total - pass) + ' of ' + total + ' checks FAILED.');
  process.exit(pass === total ? 0 : 1);
})();

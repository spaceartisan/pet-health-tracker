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
const prevIdx = argv.indexOf('--previous');
const PREVIOUS_PATH = prevIdx >= 0 ? path.resolve(argv[prevIdx + 1]) : null;
const appArg = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--previous');
const APP_PATH = path.resolve(__dirname, appArg || '../index.html');
const ROOT = path.dirname(APP_PATH);
const read = (p) => fs.readFileSync(p, 'utf8');
if (!fs.existsSync(APP_PATH)) { console.error('Could not find ' + APP_PATH); process.exit(1); }

const html = read(APP_PATH);
const PREVIOUS_HTML = PREVIOUS_PATH ? read(PREVIOUS_PATH) : null;
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
    if (o.type && !kinds.includes(o.type)) lost.push([o.id, 'type', o.type, kinds]);
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
  const A = openApp(makeClient('a'), linked(CODE, vault(CODE)));
  await settle();
  // Independent calculation from the sample data
  const byDay = {};
  SAMPLE[CODE].records.filter((r) => r.petId === 'p-pepper' && r.weight !== '' && r.weight != null)
    .sort((a, b) => a.date.localeCompare(b.date)).forEach((r) => { byDay[r.date] = Number(r.weight); });
  const days = Object.keys(byDay).sort();
  const vals = days.map((d) => byDay[d]);
  const dayNum = (s) => Date.parse(s + 'T12:00:00Z') / 864e5;
  const avg = days.map((d, i) => {
    const inWeek = days.map((x, j) => [x, vals[j]]).filter(([x]) => dayNum(d) - dayNum(x) >= 0 && dayNum(d) - dayNum(x) <= 6);
    return Math.round(inWeek.reduce((s, [, v]) => s + v, 0) / inWeek.length * 100) / 100;
  });
  const cfg = A.chart('weight');
  const sets = cfg.data.datasets;
  check('weight: one point per day', cfg.data.labels.length === days.length, [cfg.data.labels.length, days.length]);
  check('weight: daily values correct', JSON.stringify(sets[0].data) === JSON.stringify(vals));
  check('weight: 7-day average correct', sets[1] && JSON.stringify(sets[1].data) === JSON.stringify(avg));
  const summary = A.$('chartSummary').textContent;
  check('weight: summary shows latest, 30-day and since-start', summary.includes(String(vals[vals.length - 1])) && /30 days/.test(summary) && /Since /.test(summary), summary);
  const vomits = SAMPLE[CODE].records.filter((r) => r.petId === 'p-pepper' && r.type === 'vomit').length;
  const v = A.chart('vomit-weekly');
  const total = v.data.datasets[0].data.reduce((s, n) => s + n, 0);
  check('vomit per week: every episode counted', total === vomits, [total, vomits]);
  A.chart('mood');
  check('summary hidden for other charts', A.$('chartSummary').textContent === '');
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
  check('pounds by default', A.$('vsUnit').value === 'lb');
  check('full log off by default', A.$('vsFullLog').checked === false);
  A.click('vsCancel');

  // Last 90 days (Jun 27 – Sep 24)
  create();
  check('summary opens', !report().hidden && /Health summary: Pepper/.test(text()));
  check('shows the period', text().includes('(90 days)') && text().includes('Weights in lb'));
  const wStart = weightOn('2026-06-27'), wEnd = weightOn('2026-09-23');
  check('weight: start and latest', text().includes(fmt(wStart) + ' lb') && text().includes(fmt(wEnd) + ' lb'), [wStart, wEnd]);
  const change = wEnd - wStart;
  check('weight: change and percentage', text().includes((change >= 0 ? '+' : '−') + Math.abs(change).toFixed(2) + ' lb') &&
    text().includes((change >= 0 ? '+' : '−') + Math.abs(change / wStart * 100).toFixed(1) + '%'));
  check('weight: chart drawn', !!report().querySelector('svg.vr-chart polyline'));
  check('daily medicine: given 89 of 89 days (today not counted yet)', medRow('Famotidine') && medRow('Famotidine').textContent.includes('89 of 89 days'), medRow('Famotidine') && medRow('Famotidine').textContent);
  check('latest dose shown', medRow('Famotidine').textContent.includes('Antacid 1/4 of a 10 mg pill twice a day'));
  check('no dose change inside this period', medRow('Famotidine').textContent.includes('None'));
  const vomits = sampleOf((r) => r.type === 'vomit' && inRange('2026-06-27', '2026-09-24')(r)).length;
  check('vomiting count', text().includes('Vomiting: ' + vomits), vomits);
  check('another pet\'s diarrhea is not included', text().includes('Diarrhea: 0'));
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
  check('kilograms used throughout', text().includes('Weights in kg') && text().includes(fmt(wEnd) + ' kg') && !/\d lb\b/.test(text()));
  const logsInRange = SAMPLE[CODE].records.filter((r) => r.petId === 'p-pepper' && inRange('2026-06-27', '2026-09-24')(r)).length;
  check('full log lists every log in the period', report().querySelector('.vr-full') && report().querySelectorAll('.vr-full tr').length - 1 === logsInRange, [report().querySelectorAll('.vr-full tr').length - 1, logsInRange]);
  A.d.dispatchEvent(new A.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Escape closes the summary', report().hidden);
  A.click('vetSummaryBtn');
  check('unit choice remembered on this device', A.$('vsUnit').value === 'kg');
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
  check('missed doses counted and listed', medRow('Famotidine').textContent.includes('87 of 89 days') && /Missed: Aug 10, Aug 11/.test(medRow('Famotidine').textContent), medRow('Famotidine').textContent);
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
    const refusedBefore = server.rejected;
    O.addLog('from the old copy'); await settle();
    check('old copy (version ' + prevV + ') is refused', server.rejected > refusedBefore && !cloudNotes().includes('from the old copy'));
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

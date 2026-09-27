// Pet Health Tracker app. Loaded by index.html as app.js?v=<release>.
// Everything that runs at start-up is in init(), at the end of this file.
(function () {
  'use strict';

  // ===== STATE =====
  // Keep storage key compatible with v1.2.0 so existing user data is preserved.
  var STORAGE_KEY = 'petHealth.responsive.v120';
  // Event tags a user picks. Everything else about a log (weight, medication,
  // meal) is derived from the data it holds — see kindsOf().
  var TAGS = ['symptom', 'vomit', 'stool', 'activity', 'vet'];
  // App version, for keeping out-of-date copies of the app from damaging data.
  // Every cloud save carries it (_v) plus a fresh write stamp (_w), and the
  // Firestore rules reject saves below their minimum version. Logs also carry
  // it (v): a device that finds logs from a newer version stops saving.
  //
  // To release an update that older copies must not save alongside:
  //   1. Bump DATA_VERSION here and "version" in version.json to the same number.
  //   2. Push, and wait until the new version is live on GitHub Pages.
  //   3. Bump minVersion() in the Firestore rules to match, then Publish.
  // Updates that don't need this can be pushed without changing any of them.
  var DATA_VERSION = 8; // 3: symptom/play labels. 4: Stool/vet labels. 5: custom measures. 6: structured food amounts + food presets. 7: multiple foods per log + food trends. 8: event types in Daily Routine
  var newerDataSeen = false;
  var updateNotice = '';   // message for the reload banner, if any
  var cloudBlocked = false; // the cloud refused this copy's saves; wait for a reload
  var lastUpdateCheck = 0; // when version.json was last checked
  var warnedFull = false;  // "cloud storage nearly full" shown this session
  // Quick labels and play size (used further down; defined here because startup reads them)
  var PLAY_SIZES = { tiny: 'Tiny', short: 'Short', decent: 'Decent', big: 'Big' };
  var LABEL_STARTERS = {
    symptom: ['Restless', 'Begging for food', 'Hiding', 'Scratching', 'Sneezing'],
    play: ['Chasing a toy', 'Zoomies', 'Climbing', 'Wand toy']
  };
  // Quick-label kinds: which tag shows them, where the pet's own labels and a
  // log's chosen labels are stored, and fixed options that are always offered.
  var LABEL_KINDS = {
    symptom: { tag: 'symptom', petKey: 'symptomLabels', logKey: 'symptoms', title: 'What kind of symptom?', noun: 'symptom' },
    vomit: { tag: 'vomit', petKey: 'vomitLabels', logKey: 'vomitKinds', title: 'What came up?', noun: 'vomit',
      presets: ['Hairball', 'Food', 'Bile/foam', 'Liquid'] },
    stool: { tag: 'stool', petKey: 'stoolLabels', logKey: 'stoolKinds', title: 'What was it like?', noun: 'stool',
      presets: ['Normal', 'Soft', 'Diarrhea', 'Hard', 'Blood', 'Mucus'] },
    play: { tag: 'activity', petKey: 'playLabels', logKey: 'playKinds', title: 'What kind of play?', noun: 'play' }
  };
  var VET_TYPES = { scheduled: 'Scheduled', unscheduled: 'Unscheduled', emergency: 'Emergency' };
  // Routine items there's one of per pet (medicines can be several). Read while loading saved data.
  var ROUTINE_SINGLES = { weight: 'Weigh-in', food: 'Food', mood: 'Mood' };
  var ROUTINE_EVENTS = {
    symptom: { title: 'Symptom', labelKind: 'symptom' },
    vomit: { title: 'Vomit', labelKind: 'vomit' },
    stool: { title: 'Stool', labelKind: 'stool' },
    activity: { title: 'Activity', labelKind: 'play' },
    vet: { title: 'Vet visit' }
  };
  var FOOD_PRESET_LIMIT = 30;
  var FOOD_UNITS = {
    can: { one: 'can', many: 'cans', kind: 'count' },
    pouch: { one: 'pouch', many: 'pouches', kind: 'count' },
    cup: { one: 'cup', many: 'cups', kind: 'count' },
    serving: { one: 'serving', many: 'servings', kind: 'count' },
    piece: { one: 'piece', many: 'pieces', kind: 'count' },
    g: { one: 'g', many: 'g', kind: 'mass', grams: 1 },
    oz: { one: 'oz', many: 'oz', kind: 'mass', grams: 28.349523125 },
    kg: { one: 'kg', many: 'kg', kind: 'mass', grams: 1000 },
    lb: { one: 'lb', many: 'lb', kind: 'mass', grams: 453.59237 }
  };
  var MEASURE_LIMIT = 10;        // custom measures per pet
  var editingKeepReadings = [];  // readings on the log being edited that the form doesn't show
  var formLabels = { symptom: [], vomit: [], stool: [], play: [] };
  var formPlaySize = '';
  var formVetType = '';
  var labelEditMode = { symptom: false, vomit: false, stool: false, play: false };
  // Color themes (used by the picker further down; defined here because startup reads it)
  var THEMES = [
    { id: 'garden', name: 'Garden', about: 'Warm cream and sage (default)', page: '#f7f3ec', swatch: ['#f7f3ec', '#5e7d4f', '#b65a3a'] },
    { id: 'night', name: 'Night', about: 'Dark, easy on the eyes', page: '#171614', swatch: ['#171614', '#8db27a', '#e08a68'] },
    { id: 'ocean', name: 'Ocean', about: 'Cool blue-grey and teal', page: '#eef3f6', swatch: ['#eef3f6', '#2e7d8f', '#d0674a'] }
  ];

  // ===== FIREBASE =====
  var db = null;
  var SYNC_CODE_KEY = 'petHealth.syncCode';
  // Set in init(), at the end of the file
  var syncCode, state, activePetId, chart, editingLogId, routineDrafts, $, modal, modalBody, modalTitle, firstVisit, startTheme;

  // ===== RENDER PIPELINE =====
  // ===== UPDATES =====
  function renderUpdateBanner() {
    var msg = newerDataSeen
      ? 'Your data was saved by a newer version of this app. Changes on this device won\'t be saved until you reload.'
      : updateNotice;
    $('updateBanner').hidden = !msg;
    $('updateBannerText').textContent = msg;
  }
  function showUpdateNotice(msg) {
    updateNotice = msg;
    renderUpdateBanner();
  }
  // Ask the server which version is live (version.json, next to index.html).
  // Checked on open and whenever the app comes back to the screen, so a phone
  // that's kept the app open for days still hears about updates.
  function checkForUpdate(force) {
    var now = Date.now();
    if (!force && now - lastUpdateCheck < 5 * 60 * 1000) return;
    lastUpdateCheck = now;
    if (!window.fetch) return;
    fetch('version.json?t=' + now, { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (info) {
        if (info && Number(info.version) > DATA_VERSION) {
          showUpdateNotice('A new version of the app is available. Reload to update — anything unsynced is kept.');
        }
      })
      .catch(function () { /* offline, or opened as a local file */ });
  }

  function render() {
    renderUpdateBanner();
    renderLabelPanel();
    renderMeasureRows();
    renderAppendHint();
    renderPets();
    renderSummary();
    renderToday();
    refreshSuggestions();
    renderFoodQuick();
    updateFoodPreview();
    renderStars();
    renderRecords();
    refreshChartOptions();
    renderChart();
  }
  // Add the active pet's measures to the chart menu (and drop another pet's)
  function refreshChartOptions() {
    var sel = $('chartMode');
    var current = sel.value;
    sel.querySelectorAll('[data-measure-opt]').forEach(function (o) { o.remove(); });
    var measures = petMeasures(activePet());
    if (measures.length) {
      var group = document.createElement('optgroup');
      group.label = 'Measurements';
      group.setAttribute('data-measure-opt', '1');
      measures.forEach(function (ms) {
        var o = document.createElement('option');
        o.value = 'measure:' + ms.id;
        o.textContent = ms.name + (ms.unit ? ' (' + ms.unit + ')' : '');
        o.setAttribute('data-measure-opt', '1');
        group.appendChild(o);
      });
      sel.appendChild(group);
    }
    sel.value = current;
    if (sel.value !== current) sel.value = 'weight'; // that measure isn't on this pet
  }

  function renderPets() {
    var list = $('petList');
    list.innerHTML = '';
    if (!state.pets.length) {
      list.innerHTML = '<div class="empty"><b>No pets yet</b>Add a pet to start tracking.</div>';
    }
    state.pets.forEach(function (p) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'pet-row' + (p.id === activePetId ? ' active' : '');
      b.setAttribute('role', 'listitem');
      b.innerHTML =
        '<div class="pet-avatar">' + esc(p.icon || '🐾') + '</div>' +
        '<div style="min-width:0">' +
          '<b>' + esc(p.name) + '</b>' +
          '<span>' + esc(p.species || 'Pet') + (p.breed ? ' · ' + esc(p.breed) : '') + '</span>' +
        '</div>';
      b.addEventListener('click', function () {
        activePetId = p.id;
        if (window.matchMedia('(max-width: 720px)').matches) switchTab('home', true);
        render();
      });
      list.appendChild(b);
    });
    var add = document.createElement('button');
    add.type = 'button';
    add.id = 'addPetBtn';
    add.className = 'pet-row add-pet-row';
    add.innerHTML = '<div class="pet-avatar">＋</div><div><b>Add a pet</b></div>';
    add.addEventListener('click', openAddPetModal);
    list.appendChild(add);
  }

  function renderSummary() {
    var p = activePet();
    var rs = petRecords();
    if (!p) {
      $('heroIcon').textContent = '🐾';
      $('heroName').innerHTML = 'No pet selected';
      $('heroMeta').textContent = 'Add a pet to begin tracking.';
      ['sWeight', 'sWeightChange', 'sMood', 'sVet'].forEach(function (id) { $(id).textContent = '—'; });
      $('careNotes').innerHTML = '<li>No pet selected.</li>';
      return;
    }
    $('heroIcon').textContent = p.icon || '🐾';
    $('heroName').innerHTML = '<span>' + esc(p.name) + '</span><span class="hero-actions">' +
      '<button class="edit-pet" type="button" id="vetSummaryBtn">🩺 Vet summary</button>' +
      '<button class="edit-pet" type="button" id="editPetBtn">Edit</button>' +
      '<button class="edit-pet danger-action" type="button" id="deletePetBtn">Delete</button></span>';
    $('editPetBtn').addEventListener('click', function () { openEditPetModal(p); });
    $('vetSummaryBtn').addEventListener('click', openVetSummaryDialog);
    $('deletePetBtn').addEventListener('click', function () { confirmDeletePet(p); });
    $('heroMeta').textContent = (p.species || 'Pet') + (p.breed ? ' · ' + p.breed : '') + age(p.birthday);

    var dw = dailyWeights(rs), lastW = dw.days.length - 1;
    $('sWeight').textContent = lastW >= 0 ? fmtWeight(dw.values[lastW]) : '—';
    // Same 30-day change as the weight chart (7-day averages)
    var j30 = lastW >= 0 ? weight30Ref(dw.days) : -1;
    $('sWeightChange').textContent = j30 >= 0 ? fmtWeightChange(dw.avg[lastW] - dw.avg[j30]) : '—';
    var since30 = shiftDay(today(), -29);
    var moods = rs.filter(function (r) { return has(r.mood) && isFinite(Number(r.mood)) && r.date >= since30; }).map(function (r) { return Number(r.mood); });
    $('sMood').textContent = moods.length ? avg(moods).toFixed(1) : '—';
    var vetDates = rs.filter(function (r) { return hasTag(r, 'vet') && r.date <= today(); }).map(function (r) { return r.date; }).sort();
    $('sVet').textContent = vetDates.length ? relativeDay(vetDates[vetDates.length - 1]) : '—';

    // Only what's worth noticing from the last two weeks
    var since14 = shiftDay(today(), -13);
    var recent = rs.filter(function (r) { return r.date >= since14; });
    var notes = [];
    function countNote(n, one, many) { if (n) notes.push(n + ' ' + (n === 1 ? one : many)); }
    function labelCounts(list) {
      var c = {}, order = [];
      list.forEach(function (l) { var k = normName(l); if (!c[k]) { c[k] = { name: l, n: 0 }; order.push(k); } c[k].n++; });
      return order.map(function (k) { return c[k].name + (c[k].n > 1 ? ' ×' + c[k].n : ''); }).join(', ');
    }
    var vomits = recent.filter(function (r) { return hasTag(r, 'vomit'); });
    countNote(vomits.length, 'vomit episode', 'vomit episodes');
    var diarrhea = recent.filter(isDiarrhea);
    countNote(diarrhea.length, 'diarrhea episode', 'diarrhea episodes');
    // Stool labels other than Normal and Diarrhea (already counted)
    var oddStool = [];
    recent.forEach(function (r) { if (hasTag(r, 'stool')) (r.stoolKinds || []).forEach(function (k) { var n = normName(k); if (n !== 'normal' && n !== 'diarrhea') oddStool.push(k); }); });
    if (oddStool.length) notes.push('Stool: ' + labelCounts(oddStool));
    var sym = recent.filter(function (r) { return hasTag(r, 'symptom'); });
    if (sym.length) {
      var symLabels = [];
      sym.forEach(function (r) { symLabels = symLabels.concat(r.symptoms || []); });
      notes.push(sym.length + ' symptom ' + (sym.length === 1 ? 'log' : 'logs') + (symLabels.length ? ': ' + labelCounts(symLabels) : ''));
    }
    var newMeds = [];
    recent.forEach(function (r) {
      r.meds.forEach(function (m) {
        var k = normName(m.name);
        if (newMeds.indexOf(m.name) >= 0) return;
        var before = rs.some(function (o) { return o.date < since14 && o.meds.some(function (x) { return normName(x.name) === k; }); });
        if (!before) newMeds.push(m.name);
      });
    });
    if (newMeds.length) notes.push('Started: ' + newMeds.join(', '));
    if (!notes.length) notes.push(rs.length ? 'Nothing unusual logged.' : 'No logs yet.');
    $('careNotes').innerHTML = notes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('');
  }

  var RECORDS_PAGE = 50;
  var recordsShown = RECORDS_PAGE, recordsKey = null;
  function renderRecords() {
    var q = ($('search').value || '').toLowerCase();
    var rs = petRecords()
      .map(function (r, i) { return { r: r, i: i }; })
      .filter(function (x) { return !q || JSON.stringify(x.r).toLowerCase().indexOf(q) >= 0; })
      // Newest day first; within a day, the most recently added log first.
      .sort(function (a, b) { return b.r.date.localeCompare(a.r.date) || b.i - a.i; })
      .map(function (x) { return x.r; });

    // Long histories are shown a page at a time
    var listKey = activePetId + '|' + q;
    if (listKey !== recordsKey) { recordsKey = listKey; recordsShown = RECORDS_PAGE; }
    var total = rs.length;
    rs = rs.slice(0, recordsShown);

    if (!rs.length) {
      $('records').innerHTML = '<div class="empty"><b>No logs found</b>' +
        (q ? 'Try a different search.' : 'Add your first log to begin.') + '</div>';
      return;
    }

    $('records').innerHTML = rs.map(function (r) {
      var bits = [];
      var rp = state.pets.find(function (x) { return x.id === r.petId; });
      // Every value is escaped: vault data can be written by anyone with the code.
      if (has(r.weight)) bits.push('Wt ' + esc(fmtWeight(r.weight)));
      if (has(r.mood)) bits.push('Mood ' + esc(r.mood) + '/5');
      if (has(r.activity)) bits.push(esc(r.activity) + ' min');
      if (has(r.cost) && Number(r.cost) > 0) bits.push('$' + Number(r.cost).toFixed(2));
      if (foodItemsOf(r).length) bits.push(esc(foodLogText(r, rp)));
      if (r.playSize) bits.push(esc(PLAY_SIZES[r.playSize] || r.playSize) + ' play');
      (r.playKinds || []).forEach(function (k) { bits.push(esc(k)); });
      (r.symptoms || []).forEach(function (k) { bits.push(esc(k)); });
      (r.vomitKinds || []).forEach(function (k) { bits.push(esc(k)); });
      (r.stoolKinds || []).forEach(function (k) { bits.push(esc(k)); });
      if (VET_TYPES[r.vetType]) bits.push(esc(VET_TYPES[r.vetType]) + ' visit');
      (r.readings || []).forEach(function (x) {
        var ms = measureById(rp, x.m);
        if (!ms) return;
        var flag = outOfRange(ms, x.v);
        bits.push(esc(ms.name) + ' ' + esc(fmtMeasureValue(ms, x.v)) + (flag ? ' (' + flag + ')' : '') + (x.t ? ' · ' + esc(timeText(x.t)) : ''));
      });
      var kinds = kindsOf(r);
      var pills = kinds.length
        ? kinds.map(function (k) { return '<span class="type-pill ' + esc(k) + '">' + esc(label(k)) + '</span>'; }).join('')
        : '<span class="type-pill">Note</span>';
      return '' +
        '<div class="record" data-id="' + esc(r.id) + '">' +
          '<div class="record-top">' +
            '<div class="record-top-left">' +
              '<div class="record-type">' + pills + '</div>' +
              '<div class="record-date">' + esc(formatDate(r.date)) + '</div>' +
            '</div>' +
            '<div class="record-actions">' +
              '<button class="ghost tiny" data-action="edit" type="button">Edit</button>' +
              '<button class="ghost tiny" data-action="delete" type="button">Delete</button>' +
            '</div>' +
          '</div>' +
          (bits.length ? '<div class="metrics">' + bits.map(function (b) { return '<span class="badge">' + b + '</span>'; }).join('') + '</div>' : '') +
          (r.meds.length ? '<div class="med-lines">' + r.meds.map(function (m) {
            return '<div class="med-line"><b>' + esc(m.name) + '</b>' + (m.note ? ' <span>· ' + esc(m.note) + '</span>' : '') + '</div>';
          }).join('') + '</div>' : '') +
          (r.note ? '<div class="note">' + esc(r.note) + '</div>' : '') +
        '</div>';
    }).join('');

    if (total > rs.length) {
      $('records').insertAdjacentHTML('beforeend', '<button class="ghost show-more" id="showMoreLogs" type="button">Show ' +
        Math.min(RECORDS_PAGE, total - rs.length) + ' more <span>· ' + (total - rs.length) + ' older</span></button>');
      $('showMoreLogs').addEventListener('click', function () { recordsShown += RECORDS_PAGE; renderRecords(); });
    }

    // Bind record-action buttons
    $('records').querySelectorAll('.record').forEach(function (el) {
      var id = el.dataset.id;
      el.querySelector('[data-action="edit"]').addEventListener('click', function () { editLog(id); });
      el.querySelector('[data-action="delete"]').addEventListener('click', function () { deleteLog(id); });
    });
  }

  // ===== DAILY ROUTINE =====
  // Each pet can have a routine: medicines given every day and an optional
  // weigh-in. It's stored on the pet (pet.routine), so it syncs like any other
  // pet detail. Items are added and removed with the ★ toggles on the log form
  // and on the Today card.
  function normName(v) { return String(v == null ? '' : v).trim().replace(/\s+/g, ' ').toLowerCase(); }
  function timeOf(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  // The most recent description logged for this medicine and pet. Logs from
  // before per-medicine notes existed kept the dose in the log's own note.
  function lastMedNote(records, petId, med) {
    var best = '', bestDate = '';
    records.forEach(function (r) {
      if (r.petId !== petId || r.date < bestDate) return;
      r.meds.forEach(function (m) {
        if (normName(m.name) !== normName(med)) return;
        var note = m.note || (r.meds.length === 1 ? r.note : '');
        if (note) { best = note; bestDate = r.date; }
      });
    });
    return best;
  }
  function isMedItem(it) { return !ROUTINE_SINGLES[it.kind] && it.kind !== 'measure' && it.kind !== 'event'; }
  function routineTitle(it, pet) {
    if (it.kind === 'measure') { var ms = measureById(pet || activePet(), it.m); return ms ? ms.name : 'Measure'; }
    if (it.kind === 'event') return (ROUTINE_EVENTS[it.tag] && ROUTINE_EVENTS[it.tag].title) || 'Event';
    return ROUTINE_SINGLES[it.kind] || it.med;
  }
  function routineItemFor(pet, kind, med) {
    return (pet.routine || []).find(function (it) {
      if (kind === 'measure') return it.kind === 'measure' && it.m === med; // med carries the measure id
      if (kind === 'event') return it.kind === 'event' && it.tag === med; // med carries the event tag
      return ROUTINE_SINGLES[kind] ? it.kind === kind : (isMedItem(it) && normName(it.med) === normName(med));
    });
  }
  // Most recent calendar day on which this routine item appears anywhere in
  // the pet's history. This intentionally uses all logs (not just routine-made
  // logs), so a supplement entered through the full form still counts.
  function lastRoutineDate(pet, item) {
    var last = '', t = today();
    state.records.forEach(function (r) {
      if (r.petId !== pet.id || !r.date || r.date > t || r.date <= last) return;
      var found = false;
      if (item.kind === 'measure') {
        found = (r.readings || []).some(function (x) { return x.m === item.m; });
      } else if (item.kind === 'event') {
        found = hasTag(r, item.tag);
      } else if (ROUTINE_SINGLES[item.kind]) {
        found = has(r[item.kind]);
      } else {
        found = (r.meds || []).some(function (m) { return normName(m.name) === normName(item.med); });
      }
      if (found) last = r.date;
    });
    return last;
  }
  function dayNumber(dateStr) {
    var p = String(dateStr || '').split('-');
    if (p.length !== 3) return NaN;
    return Math.round(Date.UTC(Number(p[0]), Number(p[1]) - 1, Number(p[2])) / 864e5);
  }
  // "Today", "Yesterday", "12 days ago", or the date once it's months back
  function relativeDay(d) {
    var days = dayNumber(today()) - dayNumber(d);
    if (days === 0) return 'Today';
    if (days === 1) return 'Yesterday';
    if (days > 1 && days < 60) return days + ' days ago';
    return formatDate(d);
  }
  function routineRecency(pet, item) {
    var last = lastRoutineDate(pet, item);
    if (!last) return 'Never logged';
    var days = dayNumber(today()) - dayNumber(last);
    if (days === 0) return 'Last logged today';
    if (days === 1) return 'Last logged yesterday';
    if (days > 1) return 'Last logged ' + days + ' days ago';
    return 'Last logged ' + formatDate(last);
  }
  // The most recent food logged for a pet, as defaults for Daily Routine.
  function lastFoodItems(petId) {
    var best = null;
    state.records.forEach(function (r) {
      var items = foodItemsOf(r);
      if (r.petId !== petId || !items.length) return;
      var stamp = String(r.date || '') + '|' + String(r.loggedAt || '') + '|' + String(r.id || '');
      if (!best || stamp > best.stamp) best = { stamp: stamp, items: items };
    });
    return best ? best.items.map(function (x) { return Object.assign({}, x); }) : [];
  }
  function lastFood(petId) {
    var items = lastFoodItems(petId);
    return items[0] ? items[0].name : '';
  }

  // ===== FOOD PRESETS / AMOUNTS =====
  function foodUnitLabel(unit, amount) {
    var u = FOOD_UNITS[unit] || { one: unit || '', many: unit || '' };
    return Math.abs(Number(amount) - 1) < 1e-9 ? u.one : u.many;
  }
  function foodUnitOptions(selected) {
    return Object.keys(FOOD_UNITS).map(function (u) {
      return '<option value="' + esc(u) + '"' + (u === selected ? ' selected' : '') + '>' + esc(FOOD_UNITS[u].one) + '</option>';
    }).join('');
  }
  function petFoodPresets(pet) { return pet && Array.isArray(pet.foodPresets) ? pet.foodPresets : []; }
  function foodPresetById(pet, id) {
    if (!pet || !id) return null;
    return petFoodPresets(pet).find(function (f) { return f.id === id; }) || null;
  }
  function foodPresetForName(pet, name) {
    var k = normName(name);
    if (!k) return null;
    return petFoodPresets(pet).find(function (f) { return normName(f.name) === k; }) || null;
  }
  function normalizeFoodPreset(raw) {
    raw = raw || {};
    var f = {
      id: raw.id || uid(),
      name: String(raw.name || '').trim().replace(/\s+/g, ' '),
      defaultAmount: raw.defaultAmount === '' || raw.defaultAmount == null ? 1 : Number(raw.defaultAmount),
      defaultUnit: FOOD_UNITS[raw.defaultUnit] ? raw.defaultUnit : 'can',
      packageAmount: raw.packageAmount === '' || raw.packageAmount == null ? '' : Number(raw.packageAmount),
      packageUnit: FOOD_UNITS[raw.packageUnit] && FOOD_UNITS[raw.packageUnit].kind === 'mass' ? raw.packageUnit : 'oz',
      kcal: raw.kcal === '' || raw.kcal == null ? '' : Number(raw.kcal),
      kcalBasisAmount: raw.kcalBasisAmount === '' || raw.kcalBasisAmount == null ? 1 : Number(raw.kcalBasisAmount),
      kcalBasisUnit: FOOD_UNITS[raw.kcalBasisUnit] ? raw.kcalBasisUnit : (FOOD_UNITS[raw.defaultUnit] ? raw.defaultUnit : 'can')
    };
    if (!(f.defaultAmount > 0)) f.defaultAmount = 1;
    if (!(f.packageAmount > 0)) f.packageAmount = '';
    if (!(f.kcal > 0)) f.kcal = '';
    if (!(f.kcalBasisAmount > 0)) f.kcalBasisAmount = 1;
    return f;
  }
  function normalizeFoodItem(raw) {
    raw = raw || {};
    var x = {
      name: String(raw.name == null ? (raw.food || '') : raw.name).trim().replace(/\s+/g, ' '),
      amount: raw.amount === '' || raw.amount == null ? '' : Number(raw.amount),
      unit: FOOD_UNITS[raw.unit] ? raw.unit : '',
      kcal: raw.kcal === '' || raw.kcal == null ? '' : Number(raw.kcal),
      presetId: raw.presetId ? String(raw.presetId) : '',
      unitSize: raw.unitSize === '' || raw.unitSize == null ? '' : Number(raw.unitSize),
      unitSizeUnit: FOOD_UNITS[raw.unitSizeUnit] && FOOD_UNITS[raw.unitSizeUnit].kind === 'mass' ? raw.unitSizeUnit : ''
    };
    if (x.amount !== '' && (!(x.amount > 0) || !isFinite(x.amount))) x.amount = '';
    if (x.kcal !== '' && (!(x.kcal > 0) || !isFinite(x.kcal))) x.kcal = '';
    if (x.unitSize !== '' && (!(x.unitSize > 0) || !isFinite(x.unitSize))) x.unitSize = '';
    if (!x.unit && x.amount !== '') x.unit = 'can';
    return x;
  }
  function foodItemsOf(record) {
    if (!record) return [];
    if (Array.isArray(record.foodItems) && record.foodItems.length) {
      return record.foodItems.map(normalizeFoodItem).filter(function (x) { return x.name; });
    }
    if (!record.food) return [];
    return [normalizeFoodItem({
      name: record.food, amount: record.foodAmount, unit: record.foodUnit, kcal: record.foodKcal,
      presetId: record.foodPresetId, unitSize: record.foodUnitSize, unitSizeUnit: record.foodUnitSizeUnit
    })];
  }
  // Keep the original scalar food fields mirrored to the first food line. This
  // lets older exports/copies keep seeing at least the first item while v7 uses
  // `foodItems` as the canonical list.
  function syncLegacyFoodFields(record) {
    var first = Array.isArray(record.foodItems) && record.foodItems.length ? normalizeFoodItem(record.foodItems[0]) : null;
    record.food = first ? first.name : '';
    record.foodAmount = first ? first.amount : '';
    record.foodUnit = first ? first.unit : '';
    record.foodKcal = first ? first.kcal : '';
    record.foodPresetId = first ? first.presetId : '';
    record.foodUnitSize = first ? first.unitSize : '';
    record.foodUnitSizeUnit = first ? first.unitSizeUnit : '';
  }
  function foodPackageMassGrams(preset) {
    if (!preset || !(Number(preset.packageAmount) > 0)) return '';
    var u = FOOD_UNITS[preset.packageUnit];
    if (!u || u.kind !== 'mass') return '';
    return Number(preset.packageAmount) * u.grams;
  }
  function convertFoodAmount(value, fromUnit, toUnit, preset) {
    value = Number(value);
    if (!(value >= 0) || !FOOD_UNITS[fromUnit] || !FOOD_UNITS[toUnit]) return '';
    if (fromUnit === toUnit) return value;
    var from = FOOD_UNITS[fromUnit], to = FOOD_UNITS[toUnit];
    if (from.kind === 'mass' && to.kind === 'mass') return value * from.grams / to.grams;
    var packG = foodPackageMassGrams(preset);
    if (!(packG > 0)) return '';
    if (from.kind === 'count' && fromUnit === preset.defaultUnit && to.kind === 'mass') return value * packG / to.grams;
    if (from.kind === 'mass' && to.kind === 'count' && toUnit === preset.defaultUnit) return value * from.grams / packG;
    return '';
  }
  function foodKcalFor(preset, amount, unit) {
    if (!preset || !(Number(preset.kcal) > 0) || !(Number(amount) > 0)) return '';
    var inBasis = convertFoodAmount(Number(amount), unit, preset.kcalBasisUnit, preset);
    if (inBasis === '' || !(Number(preset.kcalBasisAmount) > 0)) return '';
    return Math.round((Number(preset.kcal) * inBasis / Number(preset.kcalBasisAmount)) * 100) / 100;
  }
  function foodPresetSummary(f) {
    var bits = [];
    if (Number(f.defaultAmount) > 0) bits.push(trimNum(f.defaultAmount, 3) + ' ' + foodUnitLabel(f.defaultUnit, f.defaultAmount) + ' default');
    if (Number(f.packageAmount) > 0 && FOOD_UNITS[f.defaultUnit] && FOOD_UNITS[f.defaultUnit].kind === 'count') bits.push(trimNum(f.packageAmount, 3) + ' ' + f.packageUnit + ' each');
    if (Number(f.kcal) > 0) bits.push(trimNum(f.kcal, 2) + ' kcal / ' + trimNum(f.kcalBasisAmount || 1, 3) + ' ' + foodUnitLabel(f.kcalBasisUnit, f.kcalBasisAmount || 1));
    return bits.join(' · ');
  }
  function foodItemPreset(pet, item) {
    return foodPresetById(pet, item && item.presetId) || foodPresetForName(pet, item && item.name);
  }
  function foodItemConversionPreset(pet, item) {
    var live = foodItemPreset(pet, item);
    var out = live ? Object.assign({}, live) : { defaultUnit: item.unit, packageAmount: '', packageUnit: 'g' };
    // Frozen package size wins for historical conversion.
    if (Number(item.unitSize) > 0 && item.unitSizeUnit && FOOD_UNITS[item.unit] && FOOD_UNITS[item.unit].kind === 'count') {
      out.defaultUnit = item.unit;
      out.packageAmount = Number(item.unitSize);
      out.packageUnit = item.unitSizeUnit;
    }
    return out;
  }
  function foodItemAmountText(item, pet) {
    item = normalizeFoodItem(item);
    if (!(Number(item.amount) > 0) || !item.unit) return '';
    var amount = Number(item.amount), unit = item.unit;
    var preset = foodItemConversionPreset(pet, item);
    var packAmount = Number(item.unitSize) > 0 ? Number(item.unitSize) : (preset && unit === preset.defaultUnit && Number(preset.packageAmount) > 0 ? Number(preset.packageAmount) : '');
    var packUnit = item.unitSizeUnit || (preset && unit === preset.defaultUnit ? preset.packageUnit : '');
    if (FOOD_UNITS[unit] && FOOD_UNITS[unit].kind === 'count' && packAmount && packUnit) {
      return trimNum(amount, 3) + ' × ' + trimNum(packAmount, 3) + ' ' + packUnit + ' ' + foodUnitLabel(unit, amount);
    }
    return trimNum(amount, 3) + ' ' + foodUnitLabel(unit, amount);
  }
  function foodAmountText(record, pet) {
    return foodItemsOf(record).map(function (item) { return foodItemAmountText(item, pet); }).filter(Boolean).join(' + ');
  }
  function foodItemText(item, pet) {
    item = normalizeFoodItem(item);
    if (!item.name) return '';
    var text = item.name, amt = foodItemAmountText(item, pet);
    if (amt) text += ' · ' + amt;
    if (Number(item.kcal) > 0) text += ' · ' + trimNum(item.kcal, 1) + ' kcal';
    return text;
  }
  function foodLogText(record, pet) {
    return foodItemsOf(record).map(function (item) { return foodItemText(item, pet); }).filter(Boolean).join(' + ');
  }
  function foodTotalKcal(record) {
    var total = 0, found = false;
    foodItemsOf(record).forEach(function (x) { if (Number(x.kcal) > 0) { total += Number(x.kcal); found = true; } });
    return found ? Math.round(total * 100) / 100 : '';
  }
  function loggedFoodItem(pet, raw) {
    var preserveNutrition = !!(raw && raw._preserveNutrition);
    var item = normalizeFoodItem(raw);
    if (!item.name) return item;
    var fp = foodPresetById(pet, item.presetId) || foodPresetForName(pet, item.name);
    if (fp) item.presetId = fp.id;
    // Historical rows carry their frozen calorie/package values back through an
    // edit unchanged. If the user changes food, amount or unit, the row clears
    // _preserveNutrition and these values are recalculated from the live preset.
    if (!preserveNutrition && Number(item.amount) > 0 && item.unit) {
      item.kcal = '';
      item.unitSize = '';
      item.unitSizeUnit = '';
      if (fp && Number(fp.packageAmount) > 0 && item.unit === fp.defaultUnit && FOOD_UNITS[item.unit] && FOOD_UNITS[item.unit].kind === 'count') {
        item.unitSize = Number(fp.packageAmount);
        item.unitSizeUnit = fp.packageUnit;
      }
      var kcal = fp ? foodKcalFor(fp, item.amount, item.unit) : '';
      if (kcal !== '') item.kcal = kcal;
    }
    return item;
  }
  function setRecordFoodItems(record, items) {
    record.foodItems = (items || []).map(normalizeFoodItem).filter(function (x) { return x.name; });
    syncLegacyFoodFields(record);
  }

  // ----- Multi-line food entry in Add Log -----
  function foodRowData(row) {
    var raw = {
      name: row.querySelector('.food-name-input').value,
      amount: row.querySelector('.food-amount-input').value,
      unit: row.querySelector('.food-unit-select').value,
      presetId: row.querySelector('.food-preset-id').value,
      kcal: row.querySelector('.food-frozen-kcal').value,
      unitSize: row.querySelector('.food-frozen-unit-size').value,
      unitSizeUnit: row.querySelector('.food-frozen-unit-size-unit').value
    };
    var out = normalizeFoodItem(raw);
    if (row.getAttribute('data-preserve-nutrition') === '1') out._preserveNutrition = true;
    return out;
  }
  function clearFoodRowFrozenNutrition(row) {
    row.removeAttribute('data-preserve-nutrition');
    row.querySelector('.food-frozen-kcal').value = '';
    row.querySelector('.food-frozen-unit-size').value = '';
    row.querySelector('.food-frozen-unit-size-unit').value = '';
  }
  function foodRowPreset(row) {
    var p = formPet();
    if (!p) return null;
    var d = foodRowData(row);
    return foodPresetById(p, d.presetId) || foodPresetForName(p, d.name);
  }
  function updateFoodRowPreview(row) {
    if (!row) return;
    var preview = row.querySelector('.food-row-preview');
    var d = foodRowData(row), preset = foodRowPreset(row), bits = [];
    if (d._preserveNutrition) {
      if (Number(d.unitSize) > 0 && d.unitSizeUnit && FOOD_UNITS[d.unit] && FOOD_UNITS[d.unit].kind === 'count') bits.push(trimNum(d.unitSize, 3) + ' ' + d.unitSizeUnit + ' per ' + FOOD_UNITS[d.unit].one + ' when logged');
      if (Number(d.kcal) > 0) bits.push('<strong>' + esc(trimNum(d.kcal, 1)) + ' kcal eaten (saved with this log)</strong>');
    } else if (preset) {
      if (Number(preset.packageAmount) > 0 && FOOD_UNITS[preset.defaultUnit] && FOOD_UNITS[preset.defaultUnit].kind === 'count') bits.push(trimNum(preset.packageAmount, 3) + ' ' + preset.packageUnit + ' per ' + FOOD_UNITS[preset.defaultUnit].one);
      if (Number(preset.kcal) > 0) bits.push(trimNum(preset.kcal, 2) + ' kcal per ' + trimNum(preset.kcalBasisAmount || 1, 3) + ' ' + foodUnitLabel(preset.kcalBasisUnit, preset.kcalBasisAmount || 1));
      var kcal = foodKcalFor(preset, d.amount, d.unit);
      if (kcal !== '') bits.push('<strong>≈ ' + esc(trimNum(kcal, 1)) + ' kcal eaten</strong>');
      else if (Number(d.amount) > 0 && Number(preset.kcal) > 0) bits.push('Calorie conversion needs matching units' + (foodPackageMassGrams(preset) ? '' : ' or a package weight'));
    } else if (d.name) bits.push('Save this food under ⚙ Foods to enable one-tap defaults and calorie estimates.');
    preview.innerHTML = bits.join(' · ');
  }
  function addFoodRow(item, focus) {
    item = normalizeFoodItem(item || {});
    var row = document.createElement('div');
    row.className = 'food-row';
    if (Number(item.kcal) > 0 || Number(item.unitSize) > 0) row.setAttribute('data-preserve-nutrition', '1');
    row.innerHTML =
      '<input type="hidden" class="food-preset-id" value="' + esc(item.presetId) + '">' +
      '<input type="hidden" class="food-frozen-kcal" value="' + esc(item.kcal) + '">' +
      '<input type="hidden" class="food-frozen-unit-size" value="' + esc(item.unitSize) + '">' +
      '<input type="hidden" class="food-frozen-unit-size-unit" value="' + esc(item.unitSizeUnit) + '">' +
      '<label class="field food-name">Food / brand<input class="food-name-input" list="foodOptions" placeholder="e.g. Fancy Feast Chicken" autocomplete="off" value="' + esc(item.name) + '"></label>' +
      '<label class="field food-amount">Amount eaten<input class="food-amount-input" type="number" step="any" min="0" inputmode="decimal" placeholder="amount" value="' + esc(item.amount) + '"></label>' +
      '<label class="field food-unit">Unit<select class="food-unit-select" aria-label="Food amount unit">' + foodUnitOptions(item.unit || 'can') + '</select></label>' +
      '<button type="button" class="ghost remove-food" title="Remove food" aria-label="Remove food">✕</button>' +
      '<div class="food-row-preview"></div>';
    var nameEl = row.querySelector('.food-name-input');
    var amountEl = row.querySelector('.food-amount-input');
    var unitEl = row.querySelector('.food-unit-select');
    var presetEl = row.querySelector('.food-preset-id');
    nameEl.addEventListener('input', function () {
      clearFoodRowFrozenNutrition(row);
      var fp = foodPresetForName(formPet(), nameEl.value);
      presetEl.value = fp ? fp.id : '';
      updateFoodRowPreview(row); renderStars();
    });
    nameEl.addEventListener('change', function () {
      var fp = foodPresetForName(formPet(), nameEl.value);
      if (fp) applyFoodPresetToRow(row, fp, false); else updateFoodRowPreview(row);
    });
    amountEl.addEventListener('input', function () { clearFoodRowFrozenNutrition(row); updateFoodRowPreview(row); });
    unitEl.addEventListener('change', function () { clearFoodRowFrozenNutrition(row); updateFoodRowPreview(row); });
    row.querySelector('.remove-food').addEventListener('click', function () {
      var rows = $('foodRows').querySelectorAll('.food-row');
      if (rows.length === 1) {
        nameEl.value = ''; amountEl.value = ''; presetEl.value = ''; unitEl.value = 'can'; updateFoodRowPreview(row);
      } else row.remove();
      renderStars();
    });
    $('foodRows').appendChild(row);
    updateFoodRowPreview(row);
    if (focus) nameEl.focus();
    return row;
  }
  function renderFoodRows(items) {
    $('foodRows').innerHTML = '';
    var list = (items || []).map(normalizeFoodItem).filter(function (x) { return x.name || x.amount !== ''; });
    if (!list.length) list = [{}];
    list.forEach(function (x) { addFoodRow(x, false); });
  }
  function readFoodRows(validate) {
    if (validate === undefined) validate = true;
    var p = formPet(), out = [], problem = '';
    $('foodRows').querySelectorAll('.food-row').forEach(function (row) {
      if (problem) return;
      var d = foodRowData(row);
      if (!d.name && d.amount === '') return;
      if (!d.name) { if (validate) problem = 'Enter the food name'; return; }
      if (d.amount !== '' && (!(Number(d.amount) > 0) || !isFinite(Number(d.amount)))) { if (validate) problem = 'Check the food amount'; return; }
      out.push(loggedFoodItem(p, d));
    });
    if (problem) { toast(problem); return null; }
    return out;
  }
  function applyFoodPresetToRow(row, preset, useDefaultAmount) {
    if (!row || !preset) return;
    clearFoodRowFrozenNutrition(row);
    row.querySelector('.food-preset-id').value = preset.id;
    row.querySelector('.food-name-input').value = preset.name;
    row.querySelector('.food-unit-select').value = preset.defaultUnit;
    var amount = row.querySelector('.food-amount-input');
    if (useDefaultAmount || !amount.value) amount.value = Number(preset.defaultAmount) > 0 ? trimNum(preset.defaultAmount, 3) : '';
    updateFoodRowPreview(row); renderStars();
  }
  function applyFoodPresetToForm(preset, useDefaultAmount) {
    if (!preset) return;
    var target = null;
    $('foodRows').querySelectorAll('.food-row').forEach(function (row) {
      if (!target) {
        var d = foodRowData(row);
        if (!d.name && d.amount === '') target = row;
      }
    });
    if (!target) target = addFoodRow({}, false);
    applyFoodPresetToRow(target, preset, useDefaultAmount);
    target.querySelector('.food-amount-input').focus();
  }
  function updateFoodPreview() {
    if (!$ || !$('foodRows')) return;
    $('foodRows').querySelectorAll('.food-row').forEach(updateFoodRowPreview);
  }
  function renderFoodQuick() {
    if (!$ || !$('foodQuick')) return;
    var p = formPet(), foods = petFoodPresets(p), box = $('foodQuick');
    box.hidden = !foods.length;
    box.innerHTML = foods.map(function (f) {
      return '<button class="chip" type="button" data-food-quick="' + esc(f.id) + '" title="' + esc(foodPresetSummary(f)) + '">' + esc(f.name) + '</button>';
    }).join('');
    box.querySelectorAll('[data-food-quick]').forEach(function (b) {
      b.addEventListener('click', function () { applyFoodPresetToForm(foodPresetById(formPet(), b.getAttribute('data-food-quick')), true); });
    });
  }
  function openFoodManager() {
    var p = formPet() || activePet();
    if (!p) return toast('Add a pet first');
    modalTitle.textContent = 'Foods for ' + p.name;
    function draw(editId) {
      var cur = state.pets.find(function (x) { return x.id === p.id; });
      if (!cur) { closeModal(); return; }
      var editing = editId ? foodPresetById(cur, editId) : null;
      var f = editing || normalizeFoodPreset({ defaultUnit: 'can', kcalBasisUnit: 'can', defaultAmount: 1 });
      var foods = petFoodPresets(cur);
      modalBody.innerHTML =
        '<div class="food-preset-form">' +
          '<div class="food-preset-grid">' +
            '<label class="field">Food / brand<input id="fpName" autocomplete="off" placeholder="Fancy Feast Chicken" value="' + esc(f.name) + '"></label>' +
            '<label class="field">Default amount<input id="fpDefaultAmount" type="number" step="any" min="0" inputmode="decimal" value="' + esc(f.defaultAmount) + '"></label>' +
            '<label class="field">Default logging unit<select id="fpDefaultUnit">' + foodUnitOptions(f.defaultUnit) + '</select></label>' +
          '</div>' +
          '<div class="food-package-grid">' +
            '<label class="field">Package / serving net weight <input id="fpPackageAmount" type="number" step="any" min="0" inputmode="decimal" placeholder="optional" value="' + esc(f.packageAmount) + '"></label>' +
            '<label class="field">Weight unit<select id="fpPackageUnit"><option value="oz"' + (f.packageUnit === 'oz' ? ' selected' : '') + '>oz</option><option value="g"' + (f.packageUnit === 'g' ? ' selected' : '') + '>g</option><option value="lb"' + (f.packageUnit === 'lb' ? ' selected' : '') + '>lb</option><option value="kg"' + (f.packageUnit === 'kg' ? ' selected' : '') + '>kg</option></select></label>' +
          '</div>' +
          '<div class="food-energy-grid">' +
            '<label class="field">Calories<input id="fpKcal" type="number" step="any" min="0" inputmode="decimal" placeholder="optional" value="' + esc(f.kcal) + '"></label>' +
            '<span class="food-energy-per">per</span>' +
            '<label class="field">Basis amount<input id="fpKcalBasisAmount" type="number" step="any" min="0" inputmode="decimal" value="' + esc(f.kcalBasisAmount || 1) + '"></label>' +
            '<label class="field">Basis unit<select id="fpKcalBasisUnit">' + foodUnitOptions(f.kcalBasisUnit) + '</select></label>' +
          '</div>' +
          '<p class="food-help">Examples: 90 kcal per 1 can, 75 kcal per 1 pouch, 110 kcal per 100 g, or 3,700 kcal per 1 kg. Add a package weight when you want the app to convert between cans/pouches and grams or ounces.</p>' +
          '<div class="form-actions"><button class="sage" id="fpSave" type="button">' + (editing ? 'Save food' : 'Add food') + '</button>' +
            (editing ? '<button class="ghost" id="fpCancel" type="button">Cancel edit</button>' : '') + '</div>' +
        '</div>' +
        (foods.length ? '<div class="food-preset-list">' + foods.map(function (x) {
          return '<div class="food-preset-card"><div><b>' + esc(x.name) + '</b><span>' + esc(foodPresetSummary(x) || 'No calorie information') + '</span></div>' +
            '<div class="food-preset-actions"><button class="ghost tiny" type="button" data-fp-use="' + esc(x.id) + '">Use</button><button class="ghost tiny" type="button" data-fp-edit="' + esc(x.id) + '">Edit</button><button class="ghost tiny" type="button" data-fp-delete="' + esc(x.id) + '">Delete</button></div></div>';
        }).join('') + '</div>' : '<p class="routine-intro" style="margin-top:14px">No saved foods yet.</p>');

      $('fpDefaultUnit').addEventListener('change', function () {
        if (!$('fpKcal').value) $('fpKcalBasisUnit').value = $('fpDefaultUnit').value;
      });
      $('fpSave').addEventListener('click', function () {
        var name = $('fpName').value.trim().replace(/\s+/g, ' ');
        if (!name) return toast('Enter a food name');
        var da = Number($('fpDefaultAmount').value);
        if (!(da > 0)) return toast('Default amount must be greater than zero');
        var paRaw = $('fpPackageAmount').value.trim();
        var pa = paRaw === '' ? '' : Number(paRaw);
        if (paRaw !== '' && !(pa > 0)) return toast('Check the package weight');
        var kcalRaw = $('fpKcal').value.trim();
        var kcal = kcalRaw === '' ? '' : Number(kcalRaw);
        if (kcalRaw !== '' && !(kcal > 0)) return toast('Check the calories');
        var kb = Number($('fpKcalBasisAmount').value);
        if (kcal !== '' && !(kb > 0)) return toast('Calorie basis must be greater than zero');
        var dup = petFoodPresets(cur).find(function (x) { return normName(x.name) === normName(name) && (!editing || x.id !== editing.id); });
        if (dup) return toast('That food is already saved');
        var out = normalizeFoodPreset({ id: editing ? editing.id : uid(), name: name, defaultAmount: da, defaultUnit: $('fpDefaultUnit').value,
          packageAmount: pa, packageUnit: $('fpPackageUnit').value, kcal: kcal, kcalBasisAmount: kb, kcalBasisUnit: $('fpKcalBasisUnit').value });
        if (editing) cur.foodPresets = petFoodPresets(cur).map(function (x) { return x.id === editing.id ? out : x; });
        else {
          if (petFoodPresets(cur).length >= FOOD_PRESET_LIMIT) return toast('Food list is limited to ' + FOOD_PRESET_LIMIT + ' items');
          cur.foodPresets = petFoodPresets(cur).concat([out]);
        }
        delete cur.sample;
        save();
        render();
        draw(null);
        toast(editing ? 'Food updated' : 'Food saved');
      });
      if ($('fpCancel')) $('fpCancel').addEventListener('click', function () { draw(null); });
      modalBody.querySelectorAll('[data-fp-edit]').forEach(function (b) { b.addEventListener('click', function () { draw(b.getAttribute('data-fp-edit')); }); });
      modalBody.querySelectorAll('[data-fp-use]').forEach(function (b) { b.addEventListener('click', function () {
        var fp = foodPresetById(cur, b.getAttribute('data-fp-use')); closeModal(); applyFoodPresetToForm(fp, true);
      }); });
      modalBody.querySelectorAll('[data-fp-delete]').forEach(function (b) { b.addEventListener('click', function () {
        var fp = foodPresetById(cur, b.getAttribute('data-fp-delete'));
        if (!fp || !confirm('Delete ' + fp.name + ' from quick foods? Existing logs stay unchanged.')) return;
        cur.foodPresets = petFoodPresets(cur).filter(function (x) { return x.id !== fp.id; });
        (cur.routine || []).forEach(function (it) { if (it.kind === 'food') { if (it.foodPresetId === fp.id) delete it.foodPresetId; (it.foods || []).forEach(function (x) { if (x.presetId === fp.id) x.presetId = ''; }); } });
        save(); render(); draw(null); toast('Food removed');
      }); });
    }
    draw(null);
    openModal();
  }
  // Add or remove a daily item. item: { kind: 'weight' } or { kind: 'medication', med, note }.
  function toggleRoutine(pet, item) {
    if (!pet) return toast('Add a pet first');
    var single = ROUTINE_SINGLES[item.kind];
    var lookup = item.kind === 'measure' ? item.m : item.kind === 'event' ? item.tag : item.med;
    var existing = routineItemFor(pet, item.kind, lookup);
    if (existing) {
      pet.routine = pet.routine.filter(function (it) { return it !== existing; });
      toast(routineTitle(existing, pet) + ' removed from daily routine');
    } else {
      var name = String(item.med || '').trim().replace(/\s+/g, ' ');
      if (item.kind === 'measure') {
        var ms = measureById(pet, item.m);
        if (!ms) return;
        pet.routine = (pet.routine || []).concat([{ id: uid(), kind: 'measure', m: ms.id }]);
        save();
        render();
        return toast(ms.name + ' added to daily routine');
      }
      if (item.kind === 'event') {
        var cfg = ROUTINE_EVENTS[item.tag];
        if (!cfg) return toast('That event type cannot be added to Daily Routine');
        var ev = { id: uid(), kind: 'event', tag: item.tag, labels: Array.isArray(item.labels) ? item.labels.slice() : [] };
        if (item.playSize) ev.playSize = item.playSize;
        if (item.vetType) ev.vetType = item.vetType;
        if (item.activity !== '' && item.activity != null && isFinite(Number(item.activity)) && Number(item.activity) > 0) ev.activity = Number(item.activity);
        pet.routine = (pet.routine || []).concat([ev]);
        delete pet.sample;
        save(); render();
        return toast(cfg.title + ' added to daily routine');
      }
      if (!single && !name) return toast('Enter a medicine name first');
      var entry = item.kind === 'weight' ? { id: uid(), kind: 'weight' }
        : item.kind === 'mood' ? { id: uid(), kind: 'mood' }
        : item.kind === 'food' ? (function () {
            var foods = Array.isArray(item.foods) ? item.foods.map(normalizeFoodItem).filter(function (x) { return x.name; }) : [];
            if (!foods.length && item.note) foods = [normalizeFoodItem({ name: item.note, amount: item.foodAmount, unit: item.foodUnit || 'can', presetId: item.foodPresetId })];
            if (!foods.length) foods = lastFoodItems(pet.id).map(function (x) { return normalizeFoodItem({ name: x.name, amount: x.amount, unit: x.unit, presetId: x.presetId }); });
            return { id: uid(), kind: 'food', foods: foods };
          })()
        : { id: uid(), kind: 'medication', med: name, note: String(item.note || '').trim() || lastMedNote(state.records, pet.id, name) };
      pet.routine = (pet.routine || []).concat([entry]);
      delete pet.sample; // a demo pet with a routine is now the user's own
      toast((single || name) + ' added to daily routine');
    }
    save();
    render();
  }
  function routineStatus(pet) {
    var t = today();
    var todays = state.records.filter(function (r) { return r.petId === pet.id && r.date === t; });
    var used = {};
    return (pet.routine || []).map(function (item) {
      if (item.kind === 'measure') {
        var latest = null, latestLog = null, count = 0;
        todays.forEach(function (r) {
          (r.readings || []).forEach(function (x) {
            if (x.m !== item.m) return;
            count++;
            if (!latest || String(x.t || '') >= String(latest.t || '')) { latest = x; latestLog = r; }
          });
        });
        return { item: item, log: latestLog, med: null, reading: latest, count: count };
      }
      if (item.kind === 'event') {
        var eventLogs = todays.filter(function (r) { return hasTag(r, item.tag); });
        var latestEvent = null;
        eventLogs.forEach(function (r) {
          if (!latestEvent || String(r.loggedAt || '') >= String(latestEvent.loggedAt || '')) latestEvent = r;
        });
        return { item: item, log: latestEvent, med: null, count: eventLogs.length };
      }
      var match = null;
      for (var i = 0; i < todays.length && !match; i++) {
        var r = todays[i];
        if (ROUTINE_SINGLES[item.kind]) {
          var f = item.kind; // 'weight', 'food' or 'mood': the field of the same name
          if (has(r[f]) && !used[r.id + ':' + f]) { used[r.id + ':' + f] = true; match = { log: r, med: null }; }
          continue;
        }
        for (var j = 0; j < r.meds.length; j++) {
          if (used[r.id + ':' + j] || normName(r.meds[j].name) !== normName(item.med)) continue;
          used[r.id + ':' + j] = true;
          match = { log: r, med: r.meds[j] };
          break;
        }
      }
      return { item: item, log: match ? match.log : null, med: match ? match.med : null };
    });
  }
  function eventLabelsForRecord(r, tag) {
    var cfg = ROUTINE_EVENTS[tag];
    if (!cfg || !cfg.labelKind) return [];
    var key = LABEL_KINDS[cfg.labelKind].logKey;
    return (r && r[key]) || [];
  }
  function routineEventDefaultsText(it) {
    var bits = (it.labels || []).slice();
    if (it.tag === 'activity') {
      if (it.playSize) bits.unshift(PLAY_SIZES[it.playSize] || it.playSize);
      if (has(it.activity)) bits.push(it.activity + ' min');
    }
    if (it.tag === 'vet' && it.vetType) bits.push(VET_TYPES[it.vetType] || it.vetType);
    return bits.length ? 'Default: ' + bits.join(' · ') : 'Choose details below before logging';
  }
  function routineEventDraftKey(p, it, field) { return p.id + ':' + it.id + ':event:' + field; }
  function routineEventDraft(p, it) {
    function saved(field, fallback) {
      var k = routineEventDraftKey(p, it, field);
      return Object.prototype.hasOwnProperty.call(routineDrafts, k) ? routineDrafts[k] : fallback;
    }
    var labels = saved('labels', Array.isArray(it.labels) ? it.labels.slice() : []);
    return {
      labels: Array.isArray(labels) ? labels.slice() : [],
      playSize: String(saved('playSize', it.playSize || '')),
      vetType: String(saved('vetType', it.vetType || '')),
      activity: saved('activity', has(it.activity) ? String(it.activity) : '')
    };
  }
  function routineEventLabelChoices(p, it, selected) {
    var cfg = ROUTINE_EVENTS[it.tag];
    if (!cfg || !cfg.labelKind) return [];
    var kind = cfg.labelKind, lcfg = LABEL_KINDS[kind];
    var presets = (lcfg.presets || []).slice();
    var own = petLabelList(p, kind).filter(function (x) {
      return !presets.some(function (pr) { return normName(pr) === normName(x); });
    });
    // Symptom/play labels are user-defined. Until the pet has any, expose the
    // same starter choices as the full Add Log form so a routine entry cannot
    // become a context-free event.
    var starters = (!presets.length && !own.length) ? (LABEL_STARTERS[kind] || []).slice() : [];
    var out = presets.concat(own, starters);
    (selected || []).forEach(function (x) {
      if (!out.some(function (y) { return normName(x) === normName(y); })) out.push(x);
    });
    return out;
  }
  function routineEventEditorHtml(p, it, i) {
    var cfg = ROUTINE_EVENTS[it.tag] || {}, draft = routineEventDraft(p, it), html = '';
    if (cfg.labelKind) {
      var kind = cfg.labelKind;
      html += '<div class="routine-event-options" role="group" aria-label="' + esc(LABEL_KINDS[kind].title) + '">' +
        routineEventLabelChoices(p, it, draft.labels).map(function (name) {
          var on = draft.labels.some(function (x) { return normName(x) === normName(name); });
          return '<button type="button" class="tag-chip label-chip ' + esc(kind) + '-label" data-revent-label="' + esc(name) + '" data-revent-row="' + i + '" aria-pressed="' + on + '">' + esc(name) + '</button>';
        }).join('') + '</div>';
    }
    if (it.tag === 'activity') {
      html += '<div class="routine-event-activity"><span class="routine-event-prompt">Play size</span>' +
        Object.keys(PLAY_SIZES).map(function (k) {
          return '<button type="button" class="tag-chip size-btn" data-revent-size="' + k + '" data-revent-row="' + i + '" aria-pressed="' + (draft.playSize === k) + '">' + PLAY_SIZES[k] + '</button>';
        }).join('') +
        '<input type="number" min="0" step="1" inputmode="numeric" data-revent-activity="' + i + '" value="' + esc(draft.activity) + '" placeholder="minutes" aria-label="Activity minutes"></div>';
    }
    if (it.tag === 'vet') {
      html += '<div class="routine-event-options" role="group" aria-label="Visit type">' +
        Object.keys(VET_TYPES).map(function (k) {
          return '<button type="button" class="tag-chip vet-btn" data-revent-vet="' + k + '" data-revent-row="' + i + '" aria-pressed="' + (draft.vetType === k) + '">' + VET_TYPES[k] + '</button>';
        }).join('') + '</div>';
    }
    return '<div class="routine-event-editor" data-revent-editor="' + i + '">' +
      '<span class="routine-event-prompt">Add details for this ' + esc(routineTitle(it).toLowerCase()) + '</span>' + html +
      '<div class="routine-event-tools"><button class="ghost tiny" data-revent-default="' + i + '" type="button">Make default</button></div>' +
    '</div>';
  }
  function eventRowHtml(p, row, i) {
    var it = row.item, log = row.log;
    var stop = '<button class="star" data-stop="' + i + '" type="button" title="Remove from Daily Routine" aria-label="Remove from Daily Routine" aria-pressed="true">★</button>';
    var bits = log ? eventLabelsForRecord(log, it.tag).slice() : [];
    if (log && it.tag === 'activity') {
      if (log.playSize) bits.unshift(PLAY_SIZES[log.playSize] || log.playSize);
      if (has(log.activity)) bits.push(log.activity + ' min');
    }
    if (log && it.tag === 'vet' && log.vetType) bits.push(VET_TYPES[log.vetType] || log.vetType);
    var sub = log ? ((log.loggedAt ? 'Latest ' + timeOf(log.loggedAt) : 'Logged today') + ' · ' + row.count + ' today') : ('Not yet today · ' + routineRecency(p, it));
    var desc = log && bits.length ? bits.join(' · ') : routineEventDefaultsText(it);
    return '<div class="routine-row routine-event routine-event-' + esc(it.tag) + (log ? ' done' : '') + '">' +
      '<div class="routine-check" aria-hidden="true">✓</div>' +
      '<div class="routine-main"><b>' + esc(routineTitle(it)) + '</b><span class="routine-desc">' + esc(desc) + '</span><span>' + esc(sub) + '</span></div>' +
      '<div class="routine-actions"><button class="sage tiny" data-log="' + i + '" type="button">' + (log ? 'Log another' : 'Log') + '</button>' +
        (log ? '<button class="ghost tiny" data-undo="' + i + '" type="button">Undo latest</button>' : '') + stop + '</div>' +
      routineEventEditorHtml(p, it, i) +
    '</div>';
  }

  function renderToday() {
    var card = $('todayCard');
    var p = activePet();
    if (!p) { card.hidden = true; return; }
    card.hidden = false;
    $('todayTitle').textContent = 'Today · ' + p.name;
    var rows = routineStatus(p);
    var list = $('todayList');
    if (!rows.length) {
      var suggestions = suggestMeds(p);
      list.innerHTML =
        '<p class="routine-intro">Tap ★ next to a medicine, event, weight, food, mood or custom measurement in the log form, and it will appear here for quick logging.</p>' +
        (suggestions.length
          ? '<p class="small-label" style="margin-top:0">Given often lately</p><div class="chip-row" style="margin-bottom:0">' + suggestions.map(function (m, i) {
              return '<button class="chip" type="button" data-suggest="' + i + '">★ ' + esc(m) + '</button>';
            }).join('') + '</div>'
          : '');
      list.querySelectorAll('[data-suggest]').forEach(function (b) {
        b.addEventListener('click', function () { toggleRoutine(p, { kind: 'medication', med: suggestions[Number(b.getAttribute('data-suggest'))] }); });
      });
      return;
    }

    // Remember which simple checklist field has the cursor, so a cloud redraw
    // can put it back. Food uses its own multi-row draft below.
    var focus = null;
    var ae = document.activeElement;
    if (ae && list.contains(ae) && ae.getAttribute('data-draft')) {
      focus = { key: ae.getAttribute('data-draft'), start: null, end: null };
      try { focus.start = ae.selectionStart; focus.end = ae.selectionEnd; } catch (e) {}
    }
    function draftKey(it, field) { return p.id + ':' + it.id + ':' + field; }
    function draftOr(it, field, fallback) {
      var k = draftKey(it, field);
      return Object.prototype.hasOwnProperty.call(routineDrafts, k) ? routineDrafts[k] : fallback;
    }
    function foodDraftKey(it) { return draftKey(it, 'foods'); }
    function savedFoodDefaults(it) {
      var foods = Array.isArray(it.foods) ? it.foods.map(normalizeFoodItem).filter(function (x) { return x.name; }) : [];
      if (!foods.length && it.note) foods = [normalizeFoodItem({ name: it.note, amount: it.foodAmount, unit: it.foodUnit || 'can', presetId: it.foodPresetId })];
      if (!foods.length) foods = lastFoodItems(p.id).map(function (x) { return normalizeFoodItem({ name: x.name, amount: x.amount, unit: x.unit || 'can', presetId: x.presetId }); });
      return foods;
    }
    function routineFoodDraft(it) {
      var k = foodDraftKey(it);
      if (Array.isArray(routineDrafts[k])) return routineDrafts[k];
      var foods = savedFoodDefaults(it);
      routineDrafts[k] = foods.length ? foods.map(function (x) { return Object.assign({}, x); }) : [normalizeFoodItem({ unit: 'can' })];
      return routineDrafts[k];
    }
    function foodEditorHtml(it, i) {
      var foods = routineFoodDraft(it);
      var quick = petFoodPresets(p);
      return '<div class="routine-food-editor" data-rfood-editor="' + i + '">' +
        '<div class="routine-food-lines">' + foods.map(function (f, j) {
          f = normalizeFoodItem(f);
          return '<div class="routine-food-line" data-rfood-line="' + j + '">' +
            '<input type="hidden" data-rfood-preset value="' + esc(f.presetId) + '">' +
            '<input class="routine-food-name" list="foodOptions" data-rfood-name placeholder="Food / brand" aria-label="Food name" value="' + esc(f.name) + '">' +
            '<input class="routine-food-amount" type="number" step="any" min="0" inputmode="decimal" data-rfood-amount placeholder="amount" aria-label="Food amount" value="' + esc(f.amount) + '">' +
            '<select class="routine-food-unit" data-rfood-unit aria-label="Food unit">' + foodUnitOptions(f.unit || 'can') + '</select>' +
            '<button class="ghost routine-food-remove" data-rfood-remove="' + j + '" type="button" title="Remove food" aria-label="Remove food">✕</button>' +
          '</div>';
        }).join('') + '</div>' +
        '<div class="routine-food-tools"><button class="ghost tiny" data-rfood-add="' + i + '" type="button">＋ Food</button>' +
          (quick.length ? '<span class="routine-food-quick-label">QUICK</span>' + quick.map(function (f) {
            return '<button class="chip" data-rfood-quick="' + esc(f.id) + '" data-rfood-row="' + i + '" type="button" title="' + esc(foodPresetSummary(f)) + '">' + esc(f.name) + '</button>';
          }).join('') : '') +
          '<button class="ghost tiny" data-rfood-default="' + i + '" type="button">Make default</button>' +
        '</div></div>';
    }

    var doneCount = rows.filter(function (r) { return r.log; }).length;
    var remaining = rows.map(function (r, i) { return i; }).filter(function (i) { return !rows[i].log && rows[i].item.kind !== 'measure' && rows[i].item.kind !== 'event'; });
    list.innerHTML =
      '<div class="routine-list">' + rows.map(function (row, i) {
        var it = row.item, log = row.log;
        if (it.kind === 'measure') return measureRowHtml(p, row, i);
        if (it.kind === 'event') return eventRowHtml(p, row, i);
        var isWeight = it.kind === 'weight', isMood = it.kind === 'mood', isFood = it.kind === 'food';
        var title = esc(routineTitle(it));
        var stop = '<button class="star" data-stop="' + i + '" type="button" title="Stop repeating daily" aria-label="Stop repeating daily" aria-pressed="true">★</button>';
        if (log) {
          var at = (row.med && row.med.at) || log.loggedAt;
          var sub = (isWeight ? esc(fmtWeight(log.weight)) + ' · ' : isMood ? 'Mood ' + esc(log.mood) + '/5 · ' : '') + (at ? 'Logged ' + esc(timeOf(at)) : 'Logged today');
          var desc = isWeight || isMood ? '' : isFood ? foodLogText(log, p) : (row.med.note || (!log.routine && log.meds.length === 1 ? log.note : ''));
          return '<div class="routine-row routine-' + it.kind + ' done">' +
            '<div class="routine-check" aria-hidden="true">✓</div>' +
            '<div class="routine-main"><b>' + title + '</b>' + (desc ? '<span class="routine-desc">' + esc(desc) + '</span>' : '') + '<span>' + sub + '</span></div>' +
            '<div class="routine-actions"><button class="ghost tiny" data-undo="' + i + '" type="button">Undo</button>' + stop + '</div>' +
          '</div>';
        }
        var noteKey = draftKey(it, 'note');
        var weightKey = draftKey(it, 'weight');
        return '<div class="routine-row routine-' + it.kind + '">' +
          '<div class="routine-check" aria-hidden="true">✓</div>' +
          '<div class="routine-main"><b>' + title + '</b><span>Not yet today · ' + esc(routineRecency(p, it)) + '</span></div>' +
          '<div class="routine-actions">' +
            (isWeight
              ? '<input type="number" step="any" min="0" inputmode="decimal" placeholder="' + (weightUnit() === 'kg' ? 'kg' : 'lb') + '" aria-label="' + (weightUnit() === 'kg' ? 'Weight in kilograms' : 'Weight in pounds') + '" data-row="' + i + '" data-field="weight" data-draft="' + esc(weightKey) + '" value="' + esc(draftOr(it, 'weight', '')) + '">' +
                (weightUnit() === 'lboz' ? '<input class="wt-oz" type="number" step="any" min="0" inputmode="decimal" placeholder="oz" aria-label="Ounces" data-row="' + i + '" data-field="weightOz" data-draft="' + esc(weightKey + 'Oz') + '" value="' + esc(draftOr(it, 'weightOz', '')) + '">' : '')
              : '') +
            (isMood
              ? '<span class="mood-row" role="group" aria-label="Mood, 1 to 5">' + [1, 2, 3, 4, 5].map(function (n) { return '<button class="mood-btn" type="button" data-mood-row="' + i + '" data-mood="' + n + '" aria-label="Mood ' + n + ' of 5">' + n + '</button>'; }).join('') + '</span>'
              : '<button class="sage tiny" data-log="' + i + '" type="button">Log</button>') + stop +
          '</div>' +
          (isFood ? foodEditorHtml(it, i) : isWeight || isMood ? '' :
            '<div class="routine-desc-wrap"><input class="routine-desc-input" data-row="' + i + '" data-field="note" data-draft="' + esc(noteKey) + '" value="' + esc(draftOr(it, 'note', it.note || '')) + '" placeholder="Dose / note (optional)" aria-label="Note for ' + esc(it.med) + '">' +
              '<button class="ghost tiny" data-default="' + i + '" type="button"' + (String(draftOr(it, 'note', it.note || '')).trim() === String(it.note || '').trim() ? ' hidden' : '') + '>Make default</button></div>') +
        '</div>';
      }).join('') + '</div>' +
      '<div class="routine-footer"><span class="progress">' + doneCount + ' of ' + rows.length + ' done</span>' + (remaining.length >= 2 ? '<button class="secondary tiny" id="logAllMeds" type="button">Log all remaining</button>' : '') + '</div>';

    function field(i, name) {
      var el = list.querySelector('[data-row="' + i + '"][data-field="' + name + '"]');
      return el ? el.value : '';
    }
    function readRoutineFoodEditor(i) {
      var editor = list.querySelector('[data-rfood-editor="' + i + '"]');
      if (!editor) return [];
      var out = [];
      editor.querySelectorAll('[data-rfood-line]').forEach(function (line) {
        var item = normalizeFoodItem({
          name: line.querySelector('[data-rfood-name]').value,
          amount: line.querySelector('[data-rfood-amount]').value,
          unit: line.querySelector('[data-rfood-unit]').value,
          presetId: line.querySelector('[data-rfood-preset]').value
        });
        if (item.name || item.amount !== '') out.push(item);
      });
      return out;
    }
    function saveRoutineFoodDraft(i) {
      var it = rows[i] && rows[i].item;
      if (!it || it.kind !== 'food') return [];
      var foods = readRoutineFoodEditor(i);
      routineDrafts[foodDraftKey(it)] = foods.length ? foods : [normalizeFoodItem({ unit: 'can' })];
      return routineDrafts[foodDraftKey(it)];
    }
    function readRoutineEventEditor(i) {
      var it = rows[i] && rows[i].item;
      var editor = list.querySelector('[data-revent-editor="' + i + '"]');
      if (!it || it.kind !== 'event' || !editor) return { labels: [], playSize: '', vetType: '', activity: '' };
      var labels = [];
      editor.querySelectorAll('[data-revent-label][aria-pressed="true"]').forEach(function (b) { labels.push(b.getAttribute('data-revent-label')); });
      var size = editor.querySelector('[data-revent-size][aria-pressed="true"]');
      var vet = editor.querySelector('[data-revent-vet][aria-pressed="true"]');
      var activity = editor.querySelector('[data-revent-activity]');
      return { labels: labels, playSize: size ? size.getAttribute('data-revent-size') : '', vetType: vet ? vet.getAttribute('data-revent-vet') : '', activity: activity ? activity.value : '' };
    }
    function saveRoutineEventDraft(i) {
      var it = rows[i] && rows[i].item;
      if (!it || it.kind !== 'event') return;
      var d = readRoutineEventEditor(i);
      routineDrafts[routineEventDraftKey(p, it, 'labels')] = d.labels.slice();
      routineDrafts[routineEventDraftKey(p, it, 'playSize')] = d.playSize;
      routineDrafts[routineEventDraftKey(p, it, 'vetType')] = d.vetType;
      routineDrafts[routineEventDraftKey(p, it, 'activity')] = d.activity;
    }
    function entry(i) {
      var lbEl = list.querySelector('[data-row="' + i + '"][data-field="weight"]');
      var ozEl = list.querySelector('[data-row="' + i + '"][data-field="weightOz"]');
      var it = rows[i].item;
      if (it.kind === 'food') return { item: it, foods: readRoutineFoodEditor(i) };
      if (it.kind === 'event') return { item: it, event: readRoutineEventEditor(i) };
      return { item: it, note: field(i, 'note'), weight: lbEl ? readWeight(lbEl, ozEl) : '' };
    }

    list.querySelectorAll('[data-draft]').forEach(function (input) {
      input.addEventListener('input', function () { routineDrafts[input.getAttribute('data-draft')] = input.value; });
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        logRoutineItems(p.id, [entry(Number(input.getAttribute('data-row')))], false);
      });
    });
    list.querySelectorAll('[data-rfood-editor] input, [data-rfood-editor] select').forEach(function (el) {
      el.addEventListener('input', function () {
        var editor = el.closest('[data-rfood-editor]');
        var i = Number(editor.getAttribute('data-rfood-editor'));
        if (el.hasAttribute('data-rfood-name')) {
          var line = el.closest('[data-rfood-line]');
          var fp = foodPresetForName(p, el.value);
          line.querySelector('[data-rfood-preset]').value = fp ? fp.id : '';
        }
        saveRoutineFoodDraft(i);
      });
      el.addEventListener('change', function () {
        var editor = el.closest('[data-rfood-editor]'), i = Number(editor.getAttribute('data-rfood-editor'));
        if (el.hasAttribute('data-rfood-name')) {
          var line = el.closest('[data-rfood-line]'), fp = foodPresetForName(p, el.value);
          if (fp) {
            line.querySelector('[data-rfood-preset]').value = fp.id;
            var amt = line.querySelector('[data-rfood-amount]');
            var unit = line.querySelector('[data-rfood-unit]');
            if (!amt.value) amt.value = trimNum(fp.defaultAmount, 3);
            unit.value = fp.defaultUnit;
          }
        }
        saveRoutineFoodDraft(i);
      });
    });
    list.querySelectorAll('[data-rfood-add]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-rfood-add'));
        var foods = saveRoutineFoodDraft(i).slice();
        foods.push(normalizeFoodItem({ unit: 'can' }));
        routineDrafts[foodDraftKey(rows[i].item)] = foods;
        renderToday();
      });
    });
    list.querySelectorAll('[data-rfood-remove]').forEach(function (b) {
      b.addEventListener('click', function () {
        var editor = b.closest('[data-rfood-editor]'), i = Number(editor.getAttribute('data-rfood-editor'));
        var foods = saveRoutineFoodDraft(i).slice();
        foods.splice(Number(b.getAttribute('data-rfood-remove')), 1);
        routineDrafts[foodDraftKey(rows[i].item)] = foods.length ? foods : [normalizeFoodItem({ unit: 'can' })];
        renderToday();
      });
    });
    list.querySelectorAll('[data-rfood-quick]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-rfood-row')), fp = foodPresetById(p, b.getAttribute('data-rfood-quick'));
        if (!fp) return;
        var foods = saveRoutineFoodDraft(i).slice();
        var x = normalizeFoodItem({ name: fp.name, amount: fp.defaultAmount, unit: fp.defaultUnit, presetId: fp.id });
        var blank = foods.findIndex(function (f) { return !f.name && f.amount === ''; });
        if (blank >= 0) foods[blank] = x; else foods.push(x);
        routineDrafts[foodDraftKey(rows[i].item)] = foods;
        renderToday();
      });
    });
    list.querySelectorAll('[data-rfood-default]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-rfood-default'));
        var cur = state.pets.find(function (x) { return x.id === p.id; });
        var item = cur && (cur.routine || []).find(function (it) { return it.id === rows[i].item.id; });
        if (!item) return toast('This item was removed on another device');
        var foods = saveRoutineFoodDraft(i).map(normalizeFoodItem).filter(function (x) { return x.name; });
        if (!foods.length) return toast('Add a food first');
        item.foods = foods.map(function (x) { return { name: x.name, amount: x.amount, unit: x.unit || 'can', presetId: x.presetId || '' }; });
        delete item.note; delete item.foodAmount; delete item.foodUnit; delete item.foodPresetId;
        delete routineDrafts[foodDraftKey(item)];
        save(); render(); toast('New default for Food');
      });
    });
    list.querySelectorAll('[data-revent-label]').forEach(function (b) {
      b.addEventListener('click', function () {
        b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true');
        saveRoutineEventDraft(Number(b.getAttribute('data-revent-row')));
      });
    });
    list.querySelectorAll('[data-revent-size]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-revent-row'));
        var editor = list.querySelector('[data-revent-editor="' + i + '"]');
        var turnOn = b.getAttribute('aria-pressed') !== 'true';
        editor.querySelectorAll('[data-revent-size]').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        if (turnOn) b.setAttribute('aria-pressed', 'true');
        saveRoutineEventDraft(i);
      });
    });
    list.querySelectorAll('[data-revent-vet]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-revent-row'));
        var editor = list.querySelector('[data-revent-editor="' + i + '"]');
        var turnOn = b.getAttribute('aria-pressed') !== 'true';
        editor.querySelectorAll('[data-revent-vet]').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
        if (turnOn) b.setAttribute('aria-pressed', 'true');
        saveRoutineEventDraft(i);
      });
    });
    list.querySelectorAll('[data-revent-activity]').forEach(function (el) {
      el.addEventListener('input', function () { saveRoutineEventDraft(Number(el.getAttribute('data-revent-activity'))); });
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var i = Number(el.getAttribute('data-revent-activity'));
        logRoutineItems(p.id, [entry(i)], false);
      });
    });
    list.querySelectorAll('[data-revent-default]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-revent-default'));
        var cur = state.pets.find(function (x) { return x.id === p.id; });
        var item = cur && (cur.routine || []).find(function (it) { return it.id === rows[i].item.id; });
        if (!item) return toast('This item was removed on another device');
        var d = readRoutineEventEditor(i);
        var cfg = ROUTINE_EVENTS[item.tag] || {};
        if (cfg.labelKind && item.tag !== 'activity' && !d.labels.length) return toast('Choose at least one ' + LABEL_KINDS[cfg.labelKind].noun + ' detail first');
        if (item.tag === 'activity' && !d.labels.length && !d.playSize && !(Number(d.activity) > 0)) return toast('Choose a play detail, size, or minutes first');
        if (item.tag === 'vet' && !d.vetType) return toast('Choose the visit type first');
        item.labels = d.labels.slice();
        if (item.tag === 'activity') {
          item.playSize = d.playSize;
          item.activity = Number(d.activity) > 0 ? Number(d.activity) : '';
        }
        if (item.tag === 'vet') item.vetType = d.vetType;
        ['labels', 'playSize', 'vetType', 'activity'].forEach(function (field) { delete routineDrafts[routineEventDraftKey(p, item, field)]; });
        save(); render(); toast('New default for ' + routineTitle(item));
      });
    });

    list.querySelectorAll('[data-log]').forEach(function (b) {
      b.addEventListener('click', function () { logRoutineItems(p.id, [entry(Number(b.getAttribute('data-log')))], false); });
    });
    list.querySelectorAll('[data-mlog]').forEach(function (b) {
      b.addEventListener('click', function () {
        var i = Number(b.getAttribute('data-mlog'));
        var el = list.querySelector('[data-mval="' + i + '"]');
        logMeasureReading(p.id, rows[i].item, el ? el.value : '');
      });
    });
    list.querySelectorAll('[data-mval]').forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var i = Number(el.getAttribute('data-mval'));
        logMeasureReading(p.id, rows[i].item, el.value);
      });
    });
    list.querySelectorAll('[data-mundo]').forEach(function (b) {
      b.addEventListener('click', function () {
        var row = rows[Number(b.getAttribute('data-mundo'))], r = row.log;
        r.readings = r.readings.filter(function (x) { return x !== row.reading; });
        if (isBlankRecord(r)) state.records = state.records.filter(function (x) { return x.id !== r.id; });
        save(); render(); toast('Removed');
      });
    });
    list.querySelectorAll('[data-mood]').forEach(function (b) {
      b.addEventListener('click', function () {
        var en = entry(Number(b.getAttribute('data-mood-row')));
        en.mood = Number(b.getAttribute('data-mood'));
        logRoutineItems(p.id, [en], false);
      });
    });
    list.querySelectorAll('[data-undo]').forEach(function (b) {
      b.addEventListener('click', function () { undoRoutineLog(rows[Number(b.getAttribute('data-undo'))]); });
    });
    // Medicine dose defaults (food has its own multi-line Make default button).
    list.querySelectorAll('[data-default]').forEach(function (b) {
      var i = Number(b.getAttribute('data-default'));
      var input = list.querySelector('[data-row="' + i + '"][data-field="note"]');
      if (!input) return;
      function refreshDefaultButton() { b.hidden = input.value.trim() === String(rows[i].item.note || '').trim(); }
      input.addEventListener('input', refreshDefaultButton); refreshDefaultButton();
      b.addEventListener('click', function () {
        var cur = state.pets.find(function (x) { return x.id === p.id; });
        var item = cur && (cur.routine || []).find(function (it) { return it.id === rows[i].item.id; });
        if (!item) return toast('This item was removed on another device');
        item.note = input.value.trim();
        delete routineDrafts[p.id + ':' + item.id + ':note'];
        save(); render(); toast('New default for ' + routineTitle(item));
      });
    });
    list.querySelectorAll('[data-stop]').forEach(function (b) {
      b.addEventListener('click', function () {
        var it = rows[Number(b.getAttribute('data-stop'))].item;
        var what = it.kind === 'weight' ? 'the daily weigh-in' : it.kind === 'food' ? 'daily food' : it.kind === 'mood' ? 'daily mood' : it.kind === 'event' ? routineTitle(it, p) + ' quick log' : routineTitle(it, p);
        if (!confirm('Stop showing ' + what + ' every day?\n\nToday\'s log isn\'t affected. You can add it back with ★ in the log form.')) return;
        toggleRoutine(p, { kind: it.kind, med: it.med, m: it.m, tag: it.tag });
      });
    });
    if ($('logAllMeds')) $('logAllMeds').addEventListener('click', function () { logRoutineItems(p.id, remaining.map(entry), true); });

    if (focus) {
      var fields = list.querySelectorAll('[data-draft]');
      for (var f = 0; f < fields.length; f++) {
        if (fields[f].getAttribute('data-draft') !== focus.key) continue;
        fields[f].focus();
        try { if (focus.start != null) fields[f].setSelectionRange(focus.start, focus.end); } catch (e) {}
        break;
      }
    }
  }
  // entries: [{ item, note, weight }] — note and weight as typed on the checklist.
  // Items go into today's routine log for the pet (created if needed), so a
  // whole day's routine is one log rather than one per medicine. With `lenient`
  // a weigh-in left blank is skipped instead of blocking the others.
  function logRoutineItems(petId, entries, lenient) {
    var now = new Date().toISOString();
    var meds = [], weight = '', foods = [], mood = '', events = [];
    var pet = state.pets.find(function (x) { return x.id === petId; });
    for (var i = 0; i < entries.length; i++) {
      var en = entries[i], it = en.item;
      if (it.kind === 'weight') {
        if (en.weight === '' || !(Number(en.weight) > 0)) {
          if (lenient) continue;
          return toast('Enter a weight first');
        }
        weight = Number(en.weight);
      } else if (it.kind === 'food') {
        var rawFoods = Array.isArray(en.foods) ? en.foods : [];
        // Compatibility with a v6 routine row still in memory.
        if (!rawFoods.length && en.note) rawFoods = [{ name: en.note, amount: en.foodAmount, unit: en.foodUnit || 'can', presetId: it.foodPresetId || '' }];
        var cleaned = [], bad = '';
        rawFoods.forEach(function (raw) {
          if (bad) return;
          var f = normalizeFoodItem(raw);
          if (!f.name && f.amount === '') return;
          if (!f.name) { bad = 'Enter the food name'; return; }
          if (f.amount !== '' && (!(Number(f.amount) > 0) || !isFinite(Number(f.amount)))) { bad = 'Check the food amount'; return; }
          if (!f.unit && f.amount !== '') f.unit = 'can';
          cleaned.push(loggedFoodItem(pet, f));
        });
        if (bad) { if (lenient) continue; return toast(bad); }
        if (!cleaned.length) { if (lenient) continue; return toast('Enter the food first'); }
        foods = foods.concat(cleaned);
      } else if (it.kind === 'mood') {
        if (!(en.mood >= 1 && en.mood <= 5)) continue;
        mood = en.mood;
      } else if (it.kind === 'event') {
        var ecfg = ROUTINE_EVENTS[it.tag];
        if (!ecfg) continue;
        var ed = en.event || { labels: (it.labels || []).slice(), playSize: it.playSize || '', vetType: it.vetType || '', activity: it.activity || '' };
        var ev = Object.assign({}, it, { labels: Array.isArray(ed.labels) ? ed.labels.slice() : [] });
        if (it.tag === 'activity') {
          ev.playSize = ed.playSize || '';
          ev.activity = Number(ed.activity) > 0 ? Number(ed.activity) : '';
        }
        if (it.tag === 'vet') ev.vetType = ed.vetType || '';
        // A bare event marker is too ambiguous to be useful later.  Require
        // the same kind of context the full Add Log form supports.
        if (ecfg.labelKind && it.tag !== 'activity' && !ev.labels.length) {
          if (lenient) continue;
          return toast('Choose at least one ' + LABEL_KINDS[ecfg.labelKind].noun + ' detail first');
        }
        if (it.tag === 'activity' && !ev.labels.length && !ev.playSize && !(Number(ev.activity) > 0)) {
          if (lenient) continue;
          return toast('Choose a play detail, size, or minutes first');
        }
        if (it.tag === 'vet' && !ev.vetType) {
          if (lenient) continue;
          return toast('Choose the visit type first');
        }
        events.push(ev);
      } else {
        meds.push({ name: it.med, note: String(en.note || '').trim(), at: now });
      }
    }
    if (!meds.length && weight === '' && !foods.length && mood === '' && !events.length) return toast('Nothing to log yet');
    var target = null;
    if (meds.length || weight !== '' || foods.length || mood !== '') {
      target = todayRecordFor(petId);
      if (!target) {
        target = blankRecord(petId, today());
        target.loggedAt = now;
        target.routine = true;
        state.records.push(target);
      }
      target.meds = target.meds.concat(meds);
    }
    [['weight', weight], ['mood', mood]].forEach(function (pair) {
      if (pair[1] === '') return;
      var t = target;
      if (!t) return;
      if (has(t[pair[0]])) { t = blankRecord(petId, today()); t.loggedAt = now; t.routine = true; state.records.push(t); }
      t[pair[0]] = pair[1];
    });
    if (foods.length && target) {
      setRecordFoodItems(target, foodItemsOf(target).concat(foods));
    }
    events.forEach(function (it) {
      var er = blankRecord(petId, today());
      er.loggedAt = now;
      er.routine = true;
      er.tags = [it.tag];
      var cfg = ROUTINE_EVENTS[it.tag];
      if (cfg && cfg.labelKind) er[LABEL_KINDS[cfg.labelKind].logKey] = (it.labels || []).slice();
      if (it.tag === 'activity') { if (it.playSize) er.playSize = it.playSize; if (has(it.activity)) er.activity = it.activity; }
      if (it.tag === 'vet' && it.vetType) er.vetType = it.vetType;
      state.records.push(er);
    });
    entries.forEach(function (en) {
      delete routineDrafts[petId + ':' + en.item.id + ':note'];
      delete routineDrafts[petId + ':' + en.item.id + ':weight'];
      delete routineDrafts[petId + ':' + en.item.id + ':weightOz'];
      delete routineDrafts[petId + ':' + en.item.id + ':foodAmount'];
      delete routineDrafts[petId + ':' + en.item.id + ':foodUnit'];
      delete routineDrafts[petId + ':' + en.item.id + ':foods'];
      if (en.item.kind === 'event') {
        ['labels', 'playSize', 'vetType', 'activity'].forEach(function (field) {
          delete routineDrafts[routineEventDraftKey(pet, en.item, field)];
        });
      }
    });
    save(); render();
    var done = meds.map(function (m) { return m.name; });
    if (weight !== '') done.push('Weight');
    if (foods.length) done.push('Food');
    if (mood !== '') done.push('Mood');
    events.forEach(function (it) { done.push(routineTitle(it)); });
    toast(done.length === 1 ? done[0] + ' logged' : done.length + ' items logged');
  }
  // Today's routine log for a pet: the latest log the routine itself created
  // today. Logs made through the form are never added to.
  function todayRecordFor(petId) {
    var t = today(), found = null;
    state.records.forEach(function (r) { if (r.routine && r.petId === petId && r.date === t && !r.tags.length) found = r; });
    return found;
  }
  // Take one item back out of today's log. The log itself goes only when
  // nothing else is left in it.
  // A routine row for a custom measure. It can be logged several times a day
  // (e.g. a glucose curve); it shows the latest reading and how many today.
  function measureRowHtml(p, row, i) {
    var it = row.item;
    var ms = measureById(p, it.m);
    if (!ms) return '';
    var stop = '<button class="star" data-stop="' + i + '" type="button" title="Stop repeating daily" aria-label="Stop repeating daily" aria-pressed="true">★</button>';
    var input = ms.type === 'number'
      ? '<input class="m-val" type="number" step="any" inputmode="decimal" data-mval="' + i + '" placeholder="' + esc(ms.unit || 'value') + '" aria-label="' + esc(ms.name) + '">'
      : '<select class="m-val" data-mval="' + i + '" aria-label="' + esc(ms.name) + '"><option value=""></option>' +
          (ms.levels || []).map(function (l) { return '<option value="' + esc(l) + '">' + esc(l) + '</option>'; }).join('') + '</select>';
    var sub = row.reading
      ? 'Latest ' + esc(fmtMeasureValue(ms, row.reading.v)) + (row.reading.t ? ' at ' + esc(timeText(row.reading.t)) : '') + ' · ' + row.count + ' today'
      : 'Not yet today · ' + esc(routineRecency(p, it));
    return '<div class="routine-row routine-measure' + (row.reading ? ' done' : '') + '">' +
      '<div class="routine-check" aria-hidden="true">✓</div>' +
      '<div class="routine-main"><b>' + esc(ms.name) + '</b><span>' + sub + '</span></div>' +
      '<div class="routine-actions">' + input +
        '<button class="sage tiny" data-mlog="' + i + '" type="button">Log</button>' +
        (row.reading ? '<button class="ghost tiny" data-mundo="' + i + '" type="button" title="Remove the latest reading">Undo</button>' : '') +
        stop +
      '</div></div>';
  }
  // Add one reading, with the current time, to today's routine log
  function logMeasureReading(petId, item, value) {
    var p = state.pets.find(function (x) { return x.id === petId; });
    var ms = measureById(p, item.m);
    if (!ms) return;
    var v = String(value == null ? '' : value).trim();
    if (v === '') return toast('Enter a value first');
    if (ms.type === 'number') {
      if (!isFinite(Number(v))) return toast('Check the value for ' + ms.name);
      v = Number(v);
    }
    var target = todayRecordFor(petId);
    if (!target) {
      target = blankRecord(petId, today());
      target.loggedAt = new Date().toISOString();
      target.routine = true;
      state.records.push(target);
    }
    target.readings = (target.readings || []).concat([{ m: ms.id, v: v, t: nowHHMM() }]);
    save();
    render();
    var flag = outOfRange(ms, v);
    toast(ms.name + ' ' + fmtMeasureValue(ms, v) + ' logged' + (flag ? ' (' + flag + ')' : ''));
  }
  function undoRoutineLog(row) {
    var r = row.log;
    if (row.med) r.meds = r.meds.filter(function (m) { return m !== row.med; });
    else if (row.item.kind === 'event') {
      var tag = row.item.tag;
      r.tags = (r.tags || []).filter(function (t) { return t !== tag; });
      var cfg = ROUTINE_EVENTS[tag];
      if (cfg && cfg.labelKind) r[LABEL_KINDS[cfg.labelKind].logKey] = [];
      if (tag === 'activity') { r.playSize = ''; r.playKinds = []; if (r.routine) r.activity = ''; }
      if (tag === 'vet') r.vetType = '';
    } else {
      if (row.item.kind === 'food') setRecordFoodItems(r, []);
      else r[row.item.kind] = ''; // 'weight' or 'mood'
    }
    if (isBlankRecord(r)) state.records = state.records.filter(function (x) { return x.id !== r.id; });
    save();
    render();
    toast('Removed');
  }
  // Medicines given on at least 3 of the last 14 days, most frequent first.
  function suggestMeds(pet) {
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 14);
    var from = localDate(cutoff);
    var days = {}, spelling = {};
    state.records.forEach(function (r) {
      if (r.petId !== pet.id || r.date < from) return;
      r.meds.forEach(function (m) {
        var k = normName(m.name);
        if (!k) return;
        days[k] = days[k] || {};
        days[k][r.date] = true;
        spelling[k] = String(m.name).trim();
      });
    });
    return Object.keys(days)
      .filter(function (k) { return Object.keys(days[k]).length >= 3; })
      .sort(function (a, b) { return Object.keys(days[b]).length - Object.keys(days[a]).length; })
      .map(function (k) { return spelling[k]; });
  }

  // ===== SUGGESTIONS FOR MEDICINE AND FOOD NAMES =====
  // Offers names already used, most common first, in their most common
  // spelling, so "Famotidine" isn't split into "Famotadine" by a typo.
  function topValues(values) {
    var counts = {}, spellings = {};
    values.forEach(function (raw) {
      var v = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ');
      if (!v) return;
      var k = v.toLowerCase();
      counts[k] = (counts[k] || 0) + 1;
      spellings[k] = spellings[k] || {};
      spellings[k][v] = (spellings[k][v] || 0) + 1;
    });
    return Object.keys(counts)
      .sort(function (a, b) { return counts[b] - counts[a]; })
      .slice(0, 50)
      .map(function (k) {
        var sp = spellings[k];
        return Object.keys(sp).sort(function (a, b) { return sp[b] - sp[a]; })[0];
      });
  }
  function refreshSuggestions() {
    var names = [];
    state.records.forEach(function (r) { r.meds.forEach(function (m) { names.push(m.name); }); });
    var meds = topValues(names);
    // Include routine medicines so they're suggested even before first logged
    state.pets.forEach(function (p) {
      (p.routine || []).forEach(function (it) {
        if (isMedItem(it) && it.med && !meds.some(function (m) { return normName(m) === normName(it.med); })) meds.push(it.med);
      });
    });
    $('medOptions').innerHTML = meds.map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
    var foodNames = topValues([].concat.apply([], state.records.map(function (r) { return foodItemsOf(r).map(function (x) { return x.name; }); })));
    state.pets.forEach(function (p) {
      petFoodPresets(p).forEach(function (f) {
        if (f.name && !foodNames.some(function (n) { return normName(n) === normName(f.name); })) foodNames.push(f.name);
      });
    });
    $('foodOptions').innerHTML = foodNames.map(function (v) { return '<option value="' + esc(v) + '">'; }).join('');
  }

  // ===== LOG FORM: TAGS, MEDICINE ROWS, ★ TOGGLES =====
  // The pet a log in the form belongs to: the one being edited, else the active pet.
  function formPet() {
    var r = editingLogId ? state.records.find(function (x) { return x.id === editingLogId; }) : null;
    return r ? state.pets.find(function (p) { return p.id === r.petId; }) : activePet();
  }
  function addMedRow(name, note) {
    var row = document.createElement('div');
    row.className = 'med-row';
    row.innerHTML =
      '<input class="med-name" list="medOptions" placeholder="Medicine" aria-label="Medicine name" autocomplete="off">' +
      '<button type="button" class="star" title="Give every day" aria-label="Give every day" aria-pressed="false">☆</button>' +
      '<button type="button" class="remove-med" title="Remove" aria-label="Remove medicine">✕</button>' +
      '<input class="med-note" placeholder="Dose / note (optional)" aria-label="Medicine note" autocomplete="off">';
    var nameEl = row.querySelector('.med-name');
    var noteEl = row.querySelector('.med-note');
    nameEl.value = name || '';
    noteEl.value = note || '';
    nameEl.addEventListener('input', renderStars);
    // Once a name is chosen, offer the dose used last time for it.
    nameEl.addEventListener('change', function () {
      if (noteEl.value) return;
      var p = formPet();
      if (!p) return;
      var it = routineItemFor(p, 'medication', nameEl.value);
      noteEl.value = (it && it.note) || lastMedNote(state.records, p.id, nameEl.value);
    });
    row.querySelector('.star').addEventListener('click', function () {
      toggleRoutine(formPet(), { kind: 'medication', med: nameEl.value, note: noteEl.value });
    });
    row.querySelector('.remove-med').addEventListener('click', function () { row.remove(); });
    $('medRows').appendChild(row);
    renderStars();
    return row;
  }
  function readMedRows() {
    var meds = [];
    $('medRows').querySelectorAll('.med-row').forEach(function (row) {
      var name = row.querySelector('.med-name').value.trim().replace(/\s+/g, ' ');
      if (name) meds.push({ name: name, note: row.querySelector('.med-note').value.trim() });
    });
    return meds;
  }
  // ★ buttons show whether the form's pet already gets that item daily.
  function renderStars() {
    var p = formPet();
    function set(btn, on) { btn.setAttribute('aria-pressed', on); btn.textContent = on ? '★' : '☆'; }
    set($('starWeight'), !!(p && routineItemFor(p, 'weight')));
    set($('starFood'), !!(p && routineItemFor(p, 'food')));
    set($('starMood'), !!(p && routineItemFor(p, 'mood')));
    $('rTags').querySelectorAll('[data-routine-tag]').forEach(function (b) {
      set(b, !!(p && routineItemFor(p, 'event', b.getAttribute('data-routine-tag'))));
    });
    $('medRows').querySelectorAll('.med-row').forEach(function (row) {
      set(row.querySelector('.star'), !!(p && routineItemFor(p, 'medication', row.querySelector('.med-name').value)));
    });
  }
  // ===== WEIGHT UNITS =====
  // Weights are always stored as decimal pounds. Each device chooses how to
  // enter and show them: pounds and ounces (default), decimal pounds, or kg.
  function weightUnit() {
    try { var u = localStorage.getItem('petHealth.weightDisplay'); if (u === 'lb' || u === 'kg') return u; } catch (e) {}
    return 'lboz';
  }
  function trimNum(n, digits) { return Number(n).toFixed(digits).replace(/\.?0+$/, ''); }
  // One weight, e.g. "12 lb 9 oz", "12.56 lb" or "5.7 kg"
  function fmtWeight(lb, unit) {
    unit = unit || weightUnit();
    var v = Number(lb);
    if (!isFinite(v)) return String(lb);
    if (unit === 'kg') return trimNum(v * 0.45359237, 2) + ' kg';
    if (unit === 'lb') return trimNum(v, 2) + ' lb';
    var totalOz = Math.round(Math.abs(v) * 16 * 10) / 10;
    var whole = Math.floor(totalOz / 16), oz = Math.round((totalOz - whole * 16) * 10) / 10;
    var text = whole ? whole + ' lb' + (oz ? ' ' + trimNum(oz, 1) + ' oz' : '') : trimNum(oz, 1) + ' oz';
    return (v < 0 ? '−' : '') + text;
  }
  // A change in weight, e.g. "+3 oz", "−1 lb 2 oz", "+0.21 lb"
  function fmtWeightChange(diffLb, unit) {
    var sign = diffLb > 0 ? '+' : diffLb < 0 ? '−' : '±';
    return sign + fmtWeight(Math.abs(diffLb), unit);
  }
  function weightUnitName(unit) { return { lboz: 'lb and oz', lb: 'lb', kg: 'kg' }[unit || weightUnit()]; }
  // Read a weight from a main field (lb or kg) and optional ounces field.
  // Returns decimal pounds, '' if both are empty, or NaN if it doesn't make sense.
  function readWeight(mainEl, ozEl) {
    var unit = weightUnit();
    var a = mainEl ? String(mainEl.value).trim() : '';
    var b = ozEl && unit === 'lboz' ? String(ozEl.value).trim() : '';
    if (a === '' && b === '') return '';
    var main = a === '' ? 0 : Number(a), oz = b === '' ? 0 : Number(b);
    if (!isFinite(main) || !isFinite(oz) || main < 0 || oz < 0) return NaN;
    var lb = unit === 'kg' ? main / 0.45359237 : main + oz / 16;
    return lb > 0 ? Math.round(lb * 10000) / 10000 : NaN;
  }
  // Fill a main field (and ounces field) from decimal pounds
  function writeWeight(mainEl, ozEl, lb) {
    var unit = weightUnit();
    if (lb === '' || lb == null || !isFinite(Number(lb))) { mainEl.value = ''; if (ozEl) ozEl.value = ''; return; }
    var v = Number(lb);
    if (unit === 'kg') { mainEl.value = trimNum(v * 0.45359237, 2); if (ozEl) ozEl.value = ''; return; }
    if (unit === 'lb') { mainEl.value = trimNum(v, 4); if (ozEl) ozEl.value = ''; return; }
    var totalOz = Math.round(v * 16 * 10) / 10;
    var whole = Math.floor(totalOz / 16);
    mainEl.value = String(whole);
    if (ozEl) ozEl.value = trimNum(totalOz - whole * 16, 1);
  }
  function setWeightUnit(unit) {
    // Keep what's typed in the form, re-shown in the new unit
    var typed = readWeight($('rWeight'), $('rWeightOz'));
    try { localStorage.setItem('petHealth.weightDisplay', unit); } catch (e) {}
    applyWeightUnitToForm();
    if (typed !== '' && !isNaN(typed)) writeWeight($('rWeight'), $('rWeightOz'), typed);
    render();
  }
  function applyWeightUnitToForm() {
    var unit = weightUnit();
    $('weightUnit').value = unit;
    $('rWeightOz').hidden = unit !== 'lboz';
    $('rWeight').placeholder = unit === 'kg' ? 'kg' : 'lb';
    $('rWeight').setAttribute('aria-label', unit === 'kg' ? 'Weight in kilograms' : 'Weight in pounds');
  }

  // ===== CUSTOM MEASURES =====
  // Each pet can have up to 10 measures (pet.measures): things measured at
  // home like blood glucose or urine pH. A measure is a number with a unit
  // (no conversion, the unit is just a label) or a set of levels, lowest
  // first. Readings are stored on logs as { m, v, t } to keep the vault small.
  function petMeasures(p) { return (p && Array.isArray(p.measures)) ? p.measures : []; }
  function measureById(p, id) { return petMeasures(p).find(function (x) { return x.id === id; }) || null; }
  function nextMeasureId(p) {
    var n = 0;
    petMeasures(p).forEach(function (x) { var k = parseInt(String(x.id).slice(1), 10); if (k > n) n = k; });
    return 'm' + (n + 1);
  }
  function uniqueReadings(list) {
    var seen = {};
    return list.filter(function (x) { var k = x.m + '|' + x.v + '|' + (x.t || ''); if (seen[k]) return false; seen[k] = true; return true; });
  }
  function nowHHMM() { var d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function timeText(t) {
    if (!t) return '';
    var p = String(t).split(':');
    var d = new Date(2000, 0, 1, +p[0], +p[1]);
    return isNaN(d.getTime()) ? String(t) : d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  // "142 mg/dL" or "Trace"
  function fmtMeasureValue(ms, v) {
    if (ms && ms.type === 'number') return trimNum(v, 3) + (ms.unit ? ' ' + ms.unit : '');
    return String(v);
  }
  function outOfRange(ms, v) {
    if (!ms || ms.type !== 'number') return '';
    if (has(ms.low) && Number(v) < Number(ms.low)) return 'low';
    if (has(ms.high) && Number(v) > Number(ms.high)) return 'high';
    return '';
  }

  // The form's Measurements section: one field per measure of the pet
  function renderMeasureRows() {
    var box = $('measureRows');
    var p = formPet();
    // Keep what's typed (and the cursor) through redraws
    var typed = {};
    box.querySelectorAll('[data-measure]').forEach(function (el) { typed[el.getAttribute('data-measure')] = el.value; });
    var ae = document.activeElement;
    var focusId = ae && box.contains(ae) && ae.getAttribute('data-measure');
    var list = petMeasures(p);
    $('addMeasureBtn').hidden = !p || list.length >= MEASURE_LIMIT;
    if (!list.length) {
      box.innerHTML = '<p class="measure-empty">Track things you measure at home, like blood glucose or urine pH. Tap ＋ Measure to set one up.</p>';
      return;
    }
    box.innerHTML = list.map(function (ms) {
      var starred = !!(p && routineItemFor(p, 'measure', ms.id));
      var input = ms.type === 'number'
        ? '<input type="number" step="any" inputmode="decimal" data-measure="' + esc(ms.id) + '" placeholder="' + esc(ms.unit || 'value') + '" aria-label="' + esc(ms.name) + '">'
        : '<select data-measure="' + esc(ms.id) + '" aria-label="' + esc(ms.name) + '"><option value=""></option>' +
            (ms.levels || []).map(function (l) { return '<option value="' + esc(l) + '">' + esc(l) + '</option>'; }).join('') + '</select>';
      return '<div class="measure-row">' +
        '<span class="m-name">' + esc(ms.name) + (ms.unit ? ' <small>' + esc(ms.unit) + '</small>' : '') + '</span>' + input +
        '<button type="button" class="star" data-measure-star="' + esc(ms.id) + '" aria-pressed="' + starred + '" title="Measure every day" aria-label="Measure ' + esc(ms.name) + ' every day">' + (starred ? '★' : '☆') + '</button>' +
        '<button type="button" class="ghost tiny m-edit" data-measure-edit="' + esc(ms.id) + '" aria-label="Edit ' + esc(ms.name) + '">✎</button>' +
      '</div>';
    }).join('');
    box.querySelectorAll('[data-measure]').forEach(function (el) {
      var id = el.getAttribute('data-measure');
      if (typed[id] !== undefined) el.value = typed[id];
      if (id === focusId) el.focus();
    });
    box.querySelectorAll('[data-measure-star]').forEach(function (b) {
      b.addEventListener('click', function () { toggleRoutine(formPet(), { kind: 'measure', m: b.getAttribute('data-measure-star') }); });
    });
    box.querySelectorAll('[data-measure-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openMeasureEditor(b.getAttribute('data-measure-edit')); });
    });
  }
  // Readings typed into the form. Returns null (with a message) if one doesn't make sense.
  function readFormReadings(petId, date) {
    var p = state.pets.find(function (x) { return x.id === petId; });
    var out = [], bad = '';
    var t = $('rTime').value || (date === today() ? nowHHMM() : '');
    document.querySelectorAll('#measureRows [data-measure]').forEach(function (el) {
      var v = String(el.value).trim();
      if (v === '') return;
      var ms = measureById(p, el.getAttribute('data-measure'));
      if (!ms) return;
      if (ms.type === 'number') {
        var n = Number(v);
        if (!isFinite(n)) { bad = ms.name; return; }
        out.push(t ? { m: ms.id, v: n, t: t } : { m: ms.id, v: n });
      } else {
        out.push(t ? { m: ms.id, v: v, t: t } : { m: ms.id, v: v });
      }
    });
    if (bad) { toast('Check the value for ' + bad); return null; }
    return out;
  }
  // Editing a log: show the first reading of each measure; keep any others as they are
  function fillFormReadings(r) {
    renderMeasureRows();
    var shown = {};
    editingKeepReadings = [];
    (r.readings || []).forEach(function (x) {
      var el = document.querySelector('#measureRows [data-measure="' + x.m + '"]');
      if (el && !shown[x.m]) { shown[x.m] = true; el.value = String(x.v); if (x.t && !$('rTime').value) $('rTime').value = x.t; }
      else editingKeepReadings.push(x);
    });
  }

  // Create or edit a measure
  function openMeasureEditor(id) {
    var p = formPet();
    if (!p) return toast('Add a pet first');
    var ms = id ? measureById(p, id) : null;
    if (!ms && petMeasures(p).length >= MEASURE_LIMIT) return toast('Up to ' + MEASURE_LIMIT + ' measures per pet');
    modalTitle.textContent = ms ? 'Edit ' + ms.name : 'New measure for ' + p.name;
    var type = ms ? ms.type : 'number';
    modalBody.innerHTML =
      '<label class="field">Name<input id="meName" maxlength="40" placeholder="e.g. Blood glucose" value="' + esc(ms ? ms.name : '') + '"></label>' +
      '<label class="field" style="margin-top:10px">Type<select id="meType">' +
        '<option value="number">Number (e.g. glucose, pH, temperature)</option>' +
        '<option value="levels">Levels (e.g. test strip: Negative, Trace, Small…)</option>' +
      '</select></label>' +
      '<div id="meNumber">' +
        '<label class="field" style="margin-top:10px">Unit (just a label, nothing is converted)<input id="meUnit" maxlength="16" placeholder="e.g. mg/dL" value="' + esc(ms ? ms.unit || '' : '') + '"></label>' +
        '<div class="form-grid cols-2" style="margin-top:10px">' +
          '<label class="field">Normal low (optional)<input id="meLow" type="number" step="any" value="' + esc(ms && has(ms.low) ? ms.low : '') + '"></label>' +
          '<label class="field">Normal high (optional)<input id="meHigh" type="number" step="any" value="' + esc(ms && has(ms.high) ? ms.high : '') + '"></label>' +
        '</div>' +
      '</div>' +
      '<div id="meLevels"><label class="field" style="margin-top:10px">Levels, lowest first, one per line' +
        '<textarea id="meLevelList" class="levels-input" placeholder="Negative&#10;Trace&#10;Small&#10;Moderate&#10;Large">' + esc(ms && ms.levels ? ms.levels.join('\n') : '') + '</textarea></label></div>' +
      (ms && ms.unit ? '<p class="routine-intro" style="color:var(--muted);margin-top:8px">Changing the unit only changes the label. Values already logged aren\'t converted.</p>' : '') +
      '<div class="form-actions" style="margin-top:14px"><button class="sage" id="meSave" type="button">' + (ms ? 'Save' : 'Add measure') + '</button>' +
      (ms ? '<button class="ghost" id="meDelete" type="button" style="color:var(--danger)">Delete</button>' : '<button class="ghost" id="meCancel" type="button">Cancel</button>') + '</div>';
    $('meType').value = type;
    function showType() { $('meNumber').hidden = $('meType').value !== 'number'; $('meLevels').hidden = $('meType').value !== 'levels'; }
    showType();
    $('meType').addEventListener('change', showType);
    if (ms) $('meType').disabled = true; // changing type would make logged values meaningless
    if ($('meCancel')) $('meCancel').addEventListener('click', closeModal);
    $('meSave').addEventListener('click', function () {
      var cur = state.pets.find(function (x) { return x.id === p.id; });
      if (!cur) return closeModal();
      var name = $('meName').value.trim().replace(/\s+/g, ' ');
      if (!name) return toast('Give the measure a name');
      var clash = petMeasures(cur).some(function (x) { return x.id !== (ms && ms.id) && normName(x.name) === normName(name); });
      if (clash) return toast(cur.name + ' already has a measure called ' + name);
      var def = { id: ms ? ms.id : nextMeasureId(cur), name: name, type: $('meType').value };
      if (def.type === 'number') {
        def.unit = $('meUnit').value.trim();
        var lo = $('meLow').value.trim(), hi = $('meHigh').value.trim();
        if (lo !== '') def.low = Number(lo);
        if (hi !== '') def.high = Number(hi);
        if ((lo !== '' && !isFinite(def.low)) || (hi !== '' && !isFinite(def.high))) return toast('Check the normal range');
        if (lo !== '' && hi !== '' && def.low > def.high) return toast('The normal low is above the high');
      } else {
        def.levels = $('meLevelList').value.split(/\n|,/).map(function (x) { return x.trim(); }).filter(Boolean)
          .filter(function (x, i, a) { return a.findIndex(function (y) { return normName(y) === normName(x); }) === i; });
        if (def.levels.length < 2) return toast('Add at least two levels');
      }
      cur.measures = ms ? petMeasures(cur).map(function (x) { return x.id === ms.id ? def : x; }) : petMeasures(cur).concat([def]);
      delete cur.sample;
      save();
      closeModal();
      render();
      toast(ms ? name + ' updated' : name + ' added');
    });
    if ($('meDelete')) $('meDelete').addEventListener('click', function () {
      if (!confirm('Delete ' + ms.name + '?\n\nReadings already logged stay in the logs, but won\'t show in charts or the vet summary.')) return;
      var cur = state.pets.find(function (x) { return x.id === p.id; });
      if (!cur) return closeModal();
      cur.measures = petMeasures(cur).filter(function (x) { return x.id !== ms.id; });
      cur.routine = (cur.routine || []).filter(function (it) { return !(it.kind === 'measure' && it.m === ms.id); });
      save();
      closeModal();
      render();
      toast(ms.name + ' deleted');
    });
    openModal();
  }

  // ===== QUICK LABELS & PLAY SIZE =====
  // Each pet has its own symptom labels and play labels (pet.symptomLabels,
  // pet.playLabels), so they sync like other pet details. A log stores the
  // ones picked (symptoms, playKinds) and a play size.
  function petLabelList(p, kind) {
    return (p && p[LABEL_KINDS[kind].petKey]) || [];
  }
  function tagPressed(tag) {
    var b = $('rTags').querySelector('[data-tag="' + tag + '"]');
    return !!b && b.getAttribute('aria-pressed') === 'true';
  }
  function toggleIn(list, name) {
    var i = list.findIndex(function (x) { return normName(x) === normName(name); });
    if (i >= 0) list.splice(i, 1); else list.push(name);
  }
  function addPetLabel(kind, name) {
    name = String(name || '').trim().replace(/\s+/g, ' ');
    if (!name) return;
    var p = formPet();
    if (!p) return;
    var key = LABEL_KINDS[kind].petKey;
    var presets = LABEL_KINDS[kind].presets || [];
    var list = (p[key] || []).slice();
    var existingName = presets.concat(list).find(function (x) { return normName(x) === normName(name); });
    if (!existingName) { list.push(name); p[key] = list; save(); }
    if (!formLabels[kind].some(function (x) { return normName(x) === normName(name); })) formLabels[kind].push(existingName || name);
    renderLabelPanel();
  }
  function renderLabelPanel() {
    var panel = $('labelPanel');
    var p = formPet();
    // Keep an in-progress new label (and the cursor) through redraws
    var active = document.activeElement;
    var keep = active && panel.contains(active) && active.getAttribute('data-new-label')
      ? { kind: active.getAttribute('data-new-label'), value: active.value, start: active.selectionStart } : null;
    function group(kind) {
      var cfg = LABEL_KINDS[kind];
      var chosen = formLabels[kind];
      var presets = cfg.presets || [];
      var own = petLabelList(p, kind).filter(function (x) { return !presets.some(function (pr) { return normName(pr) === normName(x); }); });
      var list = presets.concat(own);
      // Labels on this log that are no longer offered still show
      chosen.forEach(function (c) { if (!list.some(function (x) { return normName(x) === normName(c); })) list = list.concat([c]); });
      var editing = labelEditMode[kind];
      var chips = list.map(function (name) {
        var on = chosen.some(function (x) { return normName(x) === normName(name); });
        var fixed = presets.some(function (pr) { return normName(pr) === normName(name); });
        return '<button type="button" class="tag-chip label-chip ' + kind + '-label" data-label-kind="' + kind + '" data-label="' + esc(name) + '"' +
          (fixed ? ' data-preset="1"' : '') + ' aria-pressed="' + on + '">' +
          esc(name) + (editing && !fixed ? '<span class="remove" aria-hidden="true">×</span>' : '') + '</button>';
      }).join('');
      // Suggestions until the pet has labels of its own (kinds without fixed options)
      var starters = (presets.length || own.length) ? '' : (LABEL_STARTERS[kind] || []).map(function (name) {
        return '<button type="button" class="tag-chip label-chip suggested" data-starter-kind="' + kind + '" data-label="' + esc(name) + '">+ ' + esc(name) + '</button>';
      }).join('');
      return '<div class="label-group">' +
        '<div class="label-group-head"><span>' + cfg.title + '</span>' +
          (own.length ? '<button type="button" class="ghost tiny" data-edit-labels="' + kind + '">' + (editing ? 'Done' : 'Edit labels') + '</button>' : '') +
        '</div>' +
        '<div class="tag-chips">' + chips + starters + '</div>' +
        '<div class="new-label"><input data-new-label="' + kind + '" placeholder="New label" aria-label="New ' + cfg.noun + ' label">' +
          '<button type="button" class="secondary" data-add-label="' + kind + '">Add</button></div>' +
      '</div>';
    }
    var html = '';
    if (tagPressed('symptom')) html += group('symptom');
    if (tagPressed('vomit')) html += group('vomit');
    if (tagPressed('stool')) html += group('stool');
    if (tagPressed('activity')) {
      html += '<div class="label-group"><div class="label-group-head"><span>How big was the play?</span></div>' +
        '<div class="size-row">' + Object.keys(PLAY_SIZES).map(function (k) {
          return '<button type="button" class="tag-chip size-btn" data-size="' + k + '" aria-pressed="' + (formPlaySize === k) + '">' + PLAY_SIZES[k] + '</button>';
        }).join('') + '</div></div>';
      html += group('play');
    }
    if (tagPressed('vet')) {
      html += '<div class="label-group"><div class="label-group-head"><span>What kind of visit?</span></div>' +
        '<div class="vet-row">' + Object.keys(VET_TYPES).map(function (k) {
          return '<button type="button" class="tag-chip vet-btn" data-vettype="' + k + '" aria-pressed="' + (formVetType === k) + '">' + VET_TYPES[k] + '</button>';
        }).join('') + '</div></div>';
    }
    panel.innerHTML = html;
    panel.querySelectorAll('[data-label-kind]').forEach(function (b) {
      b.addEventListener('click', function () {
        var kind = b.getAttribute('data-label-kind'), name = b.getAttribute('data-label');
        if (labelEditMode[kind] && !b.hasAttribute('data-preset')) {
          // Remove from this pet's list; logs that already use it keep it
          var cur = formPet(), key = LABEL_KINDS[kind].petKey;
          if (cur) { cur[key] = (cur[key] || []).filter(function (x) { return normName(x) !== normName(name); }); save(); }
          formLabels[kind] = formLabels[kind].filter(function (x) { return normName(x) !== normName(name); });
        } else {
          toggleIn(formLabels[kind], name);
        }
        renderLabelPanel();
      });
    });
    panel.querySelectorAll('[data-starter-kind]').forEach(function (b) {
      b.addEventListener('click', function () { addPetLabel(b.getAttribute('data-starter-kind'), b.getAttribute('data-label')); });
    });
    panel.querySelectorAll('[data-edit-labels]').forEach(function (b) {
      b.addEventListener('click', function () { var k = b.getAttribute('data-edit-labels'); labelEditMode[k] = !labelEditMode[k]; renderLabelPanel(); });
    });
    panel.querySelectorAll('[data-size]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-size');
        formPlaySize = formPlaySize === k ? '' : k;
        renderLabelPanel();
      });
    });
    panel.querySelectorAll('[data-vettype]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-vettype');
        formVetType = formVetType === k ? '' : k;
        renderLabelPanel();
      });
    });
    panel.querySelectorAll('[data-add-label]').forEach(function (b) {
      b.addEventListener('click', function () {
        var kind = b.getAttribute('data-add-label');
        addPetLabel(kind, panel.querySelector('[data-new-label="' + kind + '"]').value);
      });
    });
    panel.querySelectorAll('[data-new-label]').forEach(function (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault(); // don't submit the whole log
        addPetLabel(input.getAttribute('data-new-label'), input.value);
      });
    });
    if (keep) {
      var again = panel.querySelector('[data-new-label="' + keep.kind + '"]');
      if (again) { again.value = keep.value; again.focus(); try { again.setSelectionRange(keep.start, keep.start); } catch (e) {} }
    }
  }

  function readTags() {
    var tags = [];
    $('rTags').querySelectorAll('.tag-chip').forEach(function (b) {
      if (b.getAttribute('aria-pressed') === 'true') tags.push(b.getAttribute('data-tag'));
    });
    return tags;
  }
  function setTags(tags) {
    $('rTags').querySelectorAll('.tag-chip').forEach(function (b) {
      b.setAttribute('aria-pressed', tags.indexOf(b.getAttribute('data-tag')) >= 0);
    });
  }

  // One weight per day (the last weigh-in that day), sorted by date, with a
  // 7-day average that smooths out day-to-day noise from the scale.
  function dailyWeights(records) {
    var byDay = {};
    records.slice().sort(byDate).forEach(function (r) {
      if (r.weight !== '' && r.weight != null && isFinite(Number(r.weight))) byDay[r.date] = Number(r.weight);
    });
    var days = Object.keys(byDay).sort();
    var values = days.map(function (d) { return byDay[d]; });
    var avg = days.map(function (d, i) {
      var from = shiftDay(d, -6), sum = 0, n = 0;
      for (var j = i; j >= 0 && days[j] >= from; j--) { sum += values[j]; n++; }
      return Math.round(sum / n * 100) / 100;
    });
    return { days: days, values: values, avg: avg };
  }
  // Index of the last day at least 30 days before the latest one, or -1
  function weight30Ref(days) {
    var refDay = shiftDay(days[days.length - 1], -30);
    for (var j = days.length - 1; j >= 0; j--) { if (days[j] <= refDay) return j; }
    return -1;
  }
  // Latest weight, plus change over 30 days and since the first weigh-in.
  // Changes compare 7-day averages so one odd reading doesn't skew them.
  function renderWeightSummary(days, values, avg) {
    var last = days.length - 1;
    function change(text, from) {
      var diff = avg[last] - avg[from];
      var pct = avg[from] ? diff / avg[from] * 100 : 0;
      var sign = diff > 0 ? '+' : diff < 0 ? '−' : '±';
      return '<span class="badge" title="Based on 7-day averages">' + esc(text) + ' <b>' + esc(fmtWeightChange(diff)) +
        ' (' + sign + Math.abs(pct).toFixed(1) + '%)</b></span>';
    }
    var parts = ['<span class="badge">Latest <b>' + esc(fmtWeight(values[last])) + '</b></span>'];
    var j30 = weight30Ref(days);
    if (j30 >= 0) parts.push(change('30 days', j30));
    if (last > 0) parts.push(change('Since ' + formatDate(days[0]), 0));
    $('chartSummary').innerHTML = parts.join('');
  }

  // Chart colors come from the active theme (the --chart-* variables in the CSS).
  function chartColors() {
    var css = getComputedStyle(document.documentElement);
    function v(name, fallback) { return (css.getPropertyValue(name) || '').trim() || fallback; }
    return {
      accent: v('--chart-accent', '#6b8e5a'),
      accentFill: v('--chart-accent-fill', 'rgba(107, 142, 90, .12)'),
      accentBar: v('--chart-accent-bar', 'rgba(107, 142, 90, .8)'),
      accentSoft: v('--chart-accent-soft', 'rgba(107, 142, 90, .45)'),
      accentFaint: v('--chart-accent-faint', 'rgba(107, 142, 90, .08)'),
      avg: v('--chart-avg', '#c2613f'),
      vomit: v('--chart-vomit', 'rgba(194, 97, 63, .85)'),
      vomitLine: v('--chart-vomit-line', '#c2613f'),
      diarrhea: v('--chart-diarrhea', 'rgba(146, 99, 22, .85)'),
      diarrheaLine: v('--chart-diarrhea-line', '#926316'),
      text: v('--chart-text', '#8a8278'),
      legend: v('--chart-legend', '#4a4640'),
      grid: v('--chart-grid', '#e3dccc'),
      tooltip: v('--chart-tooltip', '#1f1d1a'),
      tooltipText: v('--chart-tooltip-text', '#ffffff'),
      pointBorder: v('--chart-point-border', '#ffffff'),
      // Distinct colors for stacked bars, all at least 3:1 against the card
      series: [v('--chart-s1', '#5e7d4f'), v('--chart-s2', '#b65a3a'), v('--chart-s3', '#926316'),
        v('--chart-s4', '#3d6594'), v('--chart-s5', '#7d5596'), v('--chart-s6', '#6c655d')]
    };
  }

  function renderChart() {
    var C = chartColors();
    var canvas = $('chart');
    if (!canvas) return;
    // The app shell is installable/offline-capable, but Chart.js is delivered
    // by a CDN. On a first-ever offline launch, keep the rest of the tracker
    // usable instead of letting a missing chart library stop startup.
    if (typeof Chart === 'undefined') {
      if (chart) { chart.destroy(); chart = null; }
      $('chartSummary').textContent = 'Trend charts will be available when you are online.';
      return;
    }
    var mode = $('chartMode').value;
    var foodUnitSelect = $('foodChartUnit');
    if (foodUnitSelect) foodUnitSelect.hidden = mode !== 'food';
    // Time range: only logs from the chosen period (30 / 90 / 365 days, or all)
    var range = $('chartRange').value;
    var rangeFrom = range === 'all' ? null : shiftDay(today(), -(Number(range) - 1));
    function inRange(d) { return !rangeFrom || d >= rangeFrom; }
    var allRecords = petRecords().slice().sort(byDate);
    var rs = allRecords.filter(function (r) { return inRange(r.date); });
    var labels = [], data = [], chartType = 'line', name = label(mode);
    // Weight, mood, activity and cost are placed by date, so gaps between logs
    // show as gaps. Positions are whole days (UTC) to avoid time-zone drift.
    var mDef = mode.indexOf('measure:') === 0 ? measureById(activePet(), mode.slice(8)) : null;
    var isTimeMode = mode === 'weight' || mode === 'food' || mode === 'mood' || mode === 'activity' || mode === 'cost' || !!mDef;
    function dayNum(d) { var p = d.split('-'); return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 864e5); }
    function dayText(n, withYear) {
      var o = { month: 'short', day: 'numeric', timeZone: 'UTC' };
      if (withYear) o.year = 'numeric';
      return new Date(Math.round(n) * 864e5).toLocaleDateString(undefined, o);
    }

    if (chart) { chart.destroy(); chart = null; }
    $('chartSummary').innerHTML = '';

    // Helper: Monday-anchored week start (YYYY-MM-DD) for a given YYYY-MM-DD string
    function weekStartOf(dateStr) {
      var d = new Date(dateStr + 'T00:00:00');
      if (isNaN(d.getTime())) return null;
      var dow = d.getDay(); // 0=Sun..6=Sat
      var offsetToMon = (dow + 6) % 7; // 0 if Mon, 6 if Sun
      d.setDate(d.getDate() - offsetToMon);
      return localDate(d);
    }
    function addDays(dateStr, n) {
      var d = new Date(dateStr + 'T00:00:00');
      d.setDate(d.getDate() + n);
      return localDate(d);
    }
    function shortWeekLabel(dateStr) {
      var d = new Date(dateStr + 'T00:00:00');
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
    // Build weekly buckets from earliest-relevant week (or N weeks back, whichever is older) through current week.
    // Returns { labels: [weekStart...], series: { typeKey: [counts...] } }
    function matchesKind(r, t) { return t === 'diarrhea' ? isDiarrhea(r) : hasTag(r, t); }
    function buildWeeklyBuckets(typeKeys, minWeeks) {
      var nowWeek = weekStartOf(today());
      var earliest = null;
      rs.forEach(function (r) {
        if (!typeKeys.some(function (t) { return matchesKind(r, t); })) return;
        var ws = weekStartOf(r.date);
        if (ws && (!earliest || ws < earliest)) earliest = ws;
      });
      // If no events, use minWeeks back so the chart shows an empty baseline
      var fallbackStart = nowWeek;
      for (var i = 0; i < (minWeeks - 1); i++) fallbackStart = addDays(fallbackStart, -7);
      var startWeek = rangeFrom ? weekStartOf(rangeFrom)
        : (earliest && earliest < fallbackStart ? earliest : fallbackStart);

      var weeks = [];
      var cursor = startWeek;
      // Cap at 200 weeks just to be safe
      var safety = 0;
      while (cursor <= nowWeek && safety++ < 200) {
        weeks.push(cursor);
        cursor = addDays(cursor, 7);
      }
      var series = {};
      typeKeys.forEach(function (t) {
        series[t] = weeks.map(function () { return 0; });
      });
      // A log tagged with several types counts once in each series.
      rs.forEach(function (r) {
        var ws = weekStartOf(r.date);
        var idx = weeks.indexOf(ws);
        if (idx < 0) return;
        typeKeys.forEach(function (t) { if (matchesKind(r, t)) series[t][idx]++; });
      });
      return { weeks: weeks, series: series };
    }

    // Color tokens that match the type-pill palette in the records list
    var TYPE_COLORS = {
      vomit:    { fill: C.vomit, line: C.vomitLine },
      diarrhea: { fill: C.diarrhea, line: C.diarrheaLine }
    };

    // Compose chart config based on mode
    var chartConfig = null;

    if (mode === 'food') {
      var petForFood = activePet();
      var foodAxis = foodUnitSelect ? foodUnitSelect.value : 'kcal';
      var allFoodItems = [];
      allRecords.forEach(function (r) { allFoodItems = allFoodItems.concat(foodItemsOf(r)); });
      var hasAnyKcal = allFoodItems.some(function (f) { return Number(f.kcal) > 0; });
      var kcalOpt = foodUnitSelect && foodUnitSelect.querySelector('option[value="kcal"]');
      if (kcalOpt) kcalOpt.disabled = !hasAnyKcal;
      // If this pet has never had calorie data, begin with a unit they actually
      // use rather than opening to an empty kcal chart.
      if (foodAxis === 'kcal' && !hasAnyKcal) {
        var firstMeasured = allFoodItems.find(function (f) { return Number(f.amount) > 0 && FOOD_UNITS[f.unit]; });
        foodAxis = firstMeasured ? firstMeasured.unit : 'can';
        if (foodUnitSelect) foodUnitSelect.value = foodAxis;
      }
      // Food is a longitudinal intake measure, so plot one daily total as a
      // line (like weight) rather than a stacked categorical bar chart.  Foods
      // that cannot be converted to the selected axis are reported, not zeroed.
      var omitted = 0;
      function foodTotals(records, count) {
        var byDay = {};
        records.forEach(function (r) {
          foodItemsOf(r).forEach(function (f) {
            var value = '';
            if (foodAxis === 'kcal') value = Number(f.kcal) > 0 ? Number(f.kcal) : '';
            else if (Number(f.amount) > 0 && f.unit) value = convertFoodAmount(Number(f.amount), f.unit, foodAxis, foodItemConversionPreset(petForFood, f));
            if (value === '' || !isFinite(Number(value))) { if (count && f.name) omitted++; return; }
            byDay[r.date] = (byDay[r.date] || 0) + Number(value);
          });
        });
        return byDay;
      }
      var byDayFood = foodTotals(rs, true);
      var foodDays = Object.keys(byDayFood).sort();
      labels = foodDays.map(formatDate);
      data = foodDays.map(function (d) { return { x: dayNum(d), y: Math.round(byDayFood[d] * 1000) / 1000 }; });
      name = 'Food intake';
      chartType = 'line';
      // Average daily intake over the last 7 and 30 days, counting only days
      // with food logged (a day with nothing logged is unknown, not zero).
      var allFoodDays = foodTotals(allRecords, false);
      var unitText = foodAxis === 'kcal' ? 'kcal' : foodUnitLabel(foodAxis, 2);
      var avgSince = function (daysBack) {
        var from = shiftDay(today(), -(daysBack - 1)), sum = 0, n = 0;
        Object.keys(allFoodDays).forEach(function (d) { if (d >= from) { sum += allFoodDays[d]; n++; } });
        return n ? sum / n : null;
      };
      var avg7 = avgSince(7), avg30 = avgSince(30);
      var fmtAvg = function (v) { return foodAxis === 'kcal' ? Math.round(v).toLocaleString() : trimNum(v, 2); };
      var foodParts = [];
      if (avg7 !== null) foodParts.push('<span class="badge" title="Days with food logged">7-day avg <b>' + esc(fmtAvg(avg7)) + ' ' + esc(unitText) + '/day</b></span>');
      if (avg30 !== null) {
        var vs = avg7 !== null && avg30 ? (avg7 - avg30) / avg30 * 100 : null;
        foodParts.push('<span class="badge" title="Days with food logged">30-day avg <b>' + esc(fmtAvg(avg30)) + ' ' + esc(unitText) + '/day</b>' +
          (vs !== null && Math.abs(vs) >= 5 ? ' <b>(last 7 days ' + (vs > 0 ? '+' : '−') + Math.abs(vs).toFixed(0) + '%)</b>' : '') + '</span>');
      }
      if (omitted) foodParts.push('<span class="chart-note">' + omitted + ' food ' + (omitted === 1 ? 'line' : 'lines') + (foodAxis === 'kcal' ? ' without kcal omitted' : ' in other units omitted') + '</span>');
      $('chartSummary').innerHTML = foodParts.join('');
    } else if (mode === 'vomit-weekly' || mode === 'diarrhea-weekly') {
      var typeKey = mode === 'vomit-weekly' ? 'vomit' : 'diarrhea';
      var bucket = buildWeeklyBuckets([typeKey], 12);
      labels = bucket.weeks.map(shortWeekLabel);
      data = bucket.series[typeKey];
      chartType = 'bar';
      name = label(typeKey) + ' / week';
      var col = TYPE_COLORS[typeKey];
      chartConfig = {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [{
            label: name,
            data: data,
            backgroundColor: col.fill,
            borderColor: col.line,
            borderWidth: 0,
            borderRadius: 4,
          }]
        }
      };
    } else if (mode === 'play-weekly' || mode === 'symptom-weekly' || mode === 'stool-weekly') {
      // Play sessions per week stacked by size, or symptom logs per week
      // stacked by label (the four most common get their own color).
      var isPlay = mode === 'play-weekly';
      var labelTag = mode === 'stool-weekly' ? 'stool' : 'symptom';
      var labelsOf = function (r) { return (mode === 'stool-weekly' ? r.stoolKinds : r.symptoms) || []; };
      var events = rs.filter(function (r) { return hasTag(r, isPlay ? 'activity' : labelTag); });
      var keys, names = {}, colors = {}, keyOf;
      if (isPlay) {
        keys = ['big', 'decent', 'short', 'tiny', 'unsized'];
        names = { big: 'Big', decent: 'Decent', short: 'Short', tiny: 'Tiny', unsized: 'Size not set' };
        // One distinct color per size (faded shades of one color were too hard to see)
        colors = { big: C.series[0], decent: C.series[2], short: C.series[3], tiny: C.series[4], unsized: C.series[5] };
        keyOf = function (r) { return [PLAY_SIZES[r.playSize] ? r.playSize : 'unsized']; };
      } else {
        var tally = {}, spelled = {};
        events.forEach(function (r) {
          labelsOf(r).forEach(function (l) { var k = normName(l); tally[k] = (tally[k] || 0) + 1; spelled[k] = l; });
        });
        var top = Object.keys(tally).sort(function (a, b) { return tally[b] - tally[a]; }).slice(0, 4);
        // Green means "fine": only a Normal stool gets it; other labels get
        // the warm colors, so problems stand out.
        var palette = [C.series[1], C.series[2], C.series[3], C.series[4]];
        keys = top.concat(['other', 'none']);
        var pi = 0;
        top.forEach(function (k) { names[k] = spelled[k]; colors[k] = k === 'normal' ? C.series[0] : palette[pi++]; });
        names.other = 'Other labels'; colors.other = C.series[5];
        names.none = 'No label'; colors.none = C.text;
        keyOf = function (r) {
          var ks = labelsOf(r).map(function (l) { var k = normName(l); return top.indexOf(k) >= 0 ? k : 'other'; });
          ks = ks.filter(function (k, i) { return ks.indexOf(k) === i; });
          return ks.length ? ks : ['none'];
        };
      }
      // Weeks: the whole range, or from the first event (at least 12 weeks) for All time
      var nowWk = weekStartOf(today());
      var firstWk = nowWk;
      events.forEach(function (r) { var w = weekStartOf(r.date); if (w && w < firstWk) firstWk = w; });
      var twelveBack = nowWk;
      for (var b = 0; b < 11; b++) twelveBack = addDays(twelveBack, -7);
      var startWk = rangeFrom ? weekStartOf(rangeFrom) : (firstWk < twelveBack ? firstWk : twelveBack);
      var wks = [];
      for (var c = startWk, guard = 0; c <= nowWk && guard < 400; c = addDays(c, 7), guard++) wks.push(c);
      var series = {};
      keys.forEach(function (k) { series[k] = wks.map(function () { return 0; }); });
      events.forEach(function (r) {
        var idx = wks.indexOf(weekStartOf(r.date));
        if (idx >= 0) keyOf(r).forEach(function (k) { series[k][idx]++; });
      });
      keys = keys.filter(function (k) { return series[k].some(function (n) { return n > 0; }); });
      labels = wks.map(shortWeekLabel);
      chartType = 'bar';
      name = isPlay ? 'Activity' : mode === 'stool-weekly' ? 'Stool' : 'Symptoms';
      data = events.length ? [1] : []; // marks "has data" for the empty check
      chartConfig = {
        type: 'bar',
        data: {
          labels: labels,
          datasets: keys.map(function (k) {
            return { label: names[k], data: series[k], backgroundColor: colors[k], borderColor: C.pointBorder, borderWidth: 1, borderRadius: 4, stack: 'w' };
          })
        }
      };
    } else if (mode === 'gi-weekly') {
      var bucket2 = buildWeeklyBuckets(['vomit', 'diarrhea'], 12);
      labels = bucket2.weeks.map(shortWeekLabel);
      chartType = 'bar';
      name = 'GI episodes / week';
      // Show empty-state if BOTH series are entirely zero
      var totalEvents = bucket2.series.vomit.concat(bucket2.series.diarrhea).reduce(function (s, n) { return s + n; }, 0);
      data = totalEvents ? [1] : []; // marker so the empty-state branch below doesn't trigger when there ARE events
      chartConfig = {
        type: 'bar',
        data: {
          labels: labels,
          datasets: [
            {
              label: 'Vomit',
              data: bucket2.series.vomit,
              backgroundColor: TYPE_COLORS.vomit.fill,
              borderColor: C.pointBorder,
              borderWidth: 1,
              borderRadius: 4,
              stack: 'gi',
            },
            {
              label: 'Diarrhea',
              data: bucket2.series.diarrhea,
              backgroundColor: TYPE_COLORS.diarrhea.fill,
              borderColor: C.pointBorder,
              borderWidth: 1,
              borderRadius: 4,
              stack: 'gi',
            }
          ]
        }
      };
    } else if (mDef) {
      // A custom measure, placed by date and time of day. Numbers: a line with
      // the normal range shaded. Levels: dots on a row per level.
      var pts = [];
      rs.forEach(function (r) {
        (r.readings || []).forEach(function (x) {
          if (x.m !== mDef.id) return;
          var mins = 720;
          if (x.t) { var hm = String(x.t).split(':'); mins = (+hm[0]) * 60 + (+hm[1] || 0); }
          var y = mDef.type === 'number' ? Number(x.v)
            : (mDef.levels || []).findIndex(function (l) { return normName(l) === normName(x.v); });
          if (mDef.type === 'number' ? !isFinite(y) : y < 0) return;
          pts.push({ x: dayNum(r.date) + mins / 1440, y: y });
        });
      });
      pts.sort(function (a, b) { return a.x - b.x; });
      labels = pts.map(function () { return ''; });
      name = mDef.name;
      if (pts.length) {
        var sets = [{
          label: mDef.name, data: pts,
          borderColor: C.accent, backgroundColor: C.accent, borderWidth: 2, tension: 0.2, fill: false,
          showLine: mDef.type === 'number', pointRadius: mDef.type === 'number' ? 3 : 5, pointHoverRadius: 6,
          pointBackgroundColor: C.accent, pointBorderColor: C.pointBorder, pointBorderWidth: 1
        }];
        if (mDef.type === 'number' && (has(mDef.low) || has(mDef.high))) {
          var bx0 = rangeFrom ? dayNum(rangeFrom) : pts[0].x, bx1 = dayNum(today()) + 1;
          var band = function (y, lbl, fill) {
            return { label: lbl, data: [{ x: bx0, y: y }, { x: bx1, y: y }], isRange: true, borderColor: C.grid, borderDash: [4, 4],
              borderWidth: 1, pointRadius: 0, pointHoverRadius: 0, fill: fill, backgroundColor: C.accentFaint };
          };
          if (has(mDef.low)) sets.push(band(Number(mDef.low), 'Normal low', false));
          if (has(mDef.high)) sets.push(band(Number(mDef.high), 'Normal high', has(mDef.low) ? '-1' : false));
        }
        chartConfig = { type: 'line', data: { datasets: sets } };
      }
    } else if (mode === 'weight') {
      // One point per day (the last weigh-in that day), plus a 7-day average
      // that smooths out day-to-day noise from the scale.
      var dw = dailyWeights(allRecords);
      var allDays = dw.days, allValues = dw.values, allAvg = dw.avg;
      var keep = allDays.map(function (d, i) { return inRange(d) ? i : -1; }).filter(function (i) { return i >= 0; });
      var wDays = keep.map(function (i) { return allDays[i]; });
      var wValues = keep.map(function (i) { return allValues[i]; });
      var wAvg = keep.map(function (i) { return allAvg[i]; });
      labels = wDays.map(formatDate);
      data = wValues;
      var wUnitNow = weightUnit();
      var xy = function (vals) {
        return wDays.map(function (d, i) {
          return { x: dayNum(d), y: wUnitNow === 'kg' ? Math.round(vals[i] * 0.45359237 * 1000) / 1000 : vals[i] };
        });
      };
      if (wDays.length) {
        var showAvg = wDays.length >= 5;
        var dense = wDays.length > 40;
        var wSets = [{
          label: 'Daily weight',
          data: xy(wValues),
          borderColor: showAvg ? C.accentSoft : C.accent,
          backgroundColor: C.accentFaint,
          borderWidth: showAvg ? 1.5 : 2,
          fill: !showAvg,
          tension: 0.25,
          pointRadius: dense ? 0 : 3,
          pointHoverRadius: 4,
          pointBackgroundColor: C.accent,
          pointBorderColor: C.pointBorder,
          pointBorderWidth: 1
        }];
        if (showAvg) {
          wSets.push({
            label: '7-day average',
            data: xy(wAvg),
            borderColor: C.avg,
            borderWidth: 2.5,
            fill: false,
            tension: 0.35,
            pointRadius: 0,
            pointHoverRadius: 4
          });
        }
        chartConfig = { type: 'line', data: { datasets: wSets } };
        renderWeightSummary(wDays, wValues, wAvg);
      }
    } else {
      rs.forEach(function (r) {
        if (r[mode] !== '' && r[mode] != null && isFinite(Number(r[mode]))) {
          labels.push(formatDate(r.date));
          data.push({ x: dayNum(r.date), y: Number(r[mode]) });
        }
      });
    }

    var isStackedWeekly = mode === 'gi-weekly' || mode === 'play-weekly' || mode === 'symptom-weekly' || mode === 'stool-weekly';
    var isFoodChart = mode === 'food';
    var isWeeklyMode = mode === 'vomit-weekly' || mode === 'diarrhea-weekly' || isStackedWeekly;

    // Empty state: for weekly modes we always have padded labels (≥12 weeks),
    // so the real "no data" signal is whether `data` ended up empty (we set it to []
    // when no events of the relevant type exist).
    var isEmpty = isWeeklyMode ? (isStackedWeekly ? !data.length : data.every(function (n) { return n === 0; }))
                                : !labels.length;
    if (isEmpty) {
      var ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = C.text;
      ctx.font = '13px Geist, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No data for ' + name.toLowerCase() + ' yet', canvas.width / 2, canvas.height / 2);
      return;
    }

    // Default config for the simple numeric modes (mood, activity, cost)
    if (!chartConfig) {
      chartConfig = {
        type: chartType,
        data: {
          labels: isTimeMode ? undefined : labels,
          datasets: [{
            label: name,
            data: data,
            tension: mode === 'mood' ? 0 : 0.35,
            // Mood is a 1-5 rating, not an amount, so it isn't shaded to zero
            fill: chartType === 'line' && mode !== 'mood',
            backgroundColor: chartType === 'line' ? C.accentFill : C.accentBar,
            borderColor: C.accent,
            borderWidth: 2,
            // Dots only while there are few enough to tell apart (hover still shows each day)
            pointRadius: chartType === 'line' ? (data.length > 40 ? 0 : 3) : 0,
            pointHoverRadius: 5,
            pointBackgroundColor: C.accent,
            pointBorderColor: C.pointBorder,
            pointBorderWidth: 2,
            borderRadius: chartType === 'bar' ? 4 : 0,
          }]
        }
      };
    }

    var showLegend = isStackedWeekly || (mode === 'weight' && chartConfig.data.datasets.length > 1);

    chartConfig.options = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: showLegend,
          position: 'top',
          align: 'end',
          labels: {
            color: C.legend,
            font: { family: 'Geist', size: 12, weight: '500' },
            usePointStyle: true,
            pointStyle: 'rectRounded',
            padding: 12,
            boxWidth: 12,
            boxHeight: 12,
          }
        },
        tooltip: {
          backgroundColor: C.tooltip,
          titleColor: C.tooltipText,
          bodyColor: C.tooltipText,
          titleFont: { family: 'Geist', weight: '600' },
          bodyFont: { family: 'Geist' },
          padding: 10,
          cornerRadius: 8,
          filter: function (item) { return !item.dataset.isRange; },
          callbacks: isFoodChart ? {
            title: function (items) { return items[0] ? dayText(items[0].parsed.x, true) : ''; },
            label: function (item) {
              var u = $('foodChartUnit').value;
              return item.dataset.label + ': ' + trimNum(item.parsed.y, u === 'kcal' ? 1 : 3) + (u === 'kcal' ? ' kcal' : ' ' + foodUnitLabel(u, item.parsed.y));
            }
          } : isTimeMode ? {
            title: function (items) {
              if (!items[0]) return '';
              var x = items[0].parsed.x;
              if (!mDef) return dayText(x, true);
              var mins = Math.round((x - Math.floor(x)) * 1440);
              return dayText(Math.floor(x), true) + ' · ' + timeText(String(Math.floor(mins / 60)).padStart(2, '0') + ':' + String(mins % 60).padStart(2, '0'));
            },
            label: function (item) {
              if (!mDef) return item.dataset.label + ': ' + item.formattedValue;
              var v = mDef.type === 'number' ? item.parsed.y : (mDef.levels || [])[item.parsed.y];
              var flag = outOfRange(mDef, v);
              return mDef.name + ': ' + fmtMeasureValue(mDef, v) + (flag ? ' (' + flag + ')' : '');
            }
          } : isWeeklyMode ? {
            title: function (items) { return 'Week of ' + (items[0] && items[0].label); },
            label: function (item) {
              var v = item.parsed.y;
              var unit = mode === 'play-weekly' ? ['session', 'sessions'] : (mode === 'symptom-weekly' || mode === 'stool-weekly') ? ['log', 'logs'] : ['episode', 'episodes'];
              return item.dataset.label + ': ' + v + ' ' + (v === 1 ? unit[0] : unit[1]);
            }
          } : undefined
        }
      },
      scales: {
        y: {
          beginAtZero: mode !== 'weight' && mode !== 'mood' && !mDef,
          min: mode === 'mood' ? 1 : undefined,
          max: mode === 'mood' ? 5 : undefined,
          stacked: isStackedWeekly,
          ticks: Object.assign({ precision: isFoodChart ? undefined : 0, color: C.text, font: { family: 'Geist', size: 11 }, stepSize: isWeeklyMode || mode === 'mood' ? 1 : undefined }, weightTicks(), measureTicks()),
          grid: { color: C.grid },
          title: isFoodChart ? { display: true, text: $('foodChartUnit').value === 'kcal' ? 'kcal' : foodUnitLabel($('foodChartUnit').value, 2), color: C.text, font: { family: 'Geist', size: 11, weight: '500' } } : isWeeklyMode ? { display: true, text: mode === 'play-weekly' ? 'Sessions' : (mode === 'symptom-weekly' || mode === 'stool-weekly') ? 'Logs' : 'Episodes', color: C.text, font: { family: 'Geist', size: 11, weight: '500' } } : undefined,
        },
        x: isTimeMode ? timeAxis() : {
          stacked: isStackedWeekly,
          ticks: { color: C.text, font: { family: 'Geist', size: 11 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 16 },
          grid: { display: false }
        }
      }
    };

    // Weight axis labels in the device's unit. For pounds and ounces the marks
    // land on whole ounces or pounds (4 oz, 8 oz, 1 lb...) so labels are exact.
    // Measure axis: numbers with their unit, or level names
    function measureTicks() {
      if (!mDef) return {};
      if (mDef.type === 'number') return { precision: undefined, callback: function (v) { return trimNum(v, 2) + (mDef.unit ? ' ' + mDef.unit : ''); } };
      var levels = mDef.levels || [];
      return { precision: undefined, stepSize: 0.5, callback: function (v) { return Number.isInteger(v) && levels[v] !== undefined ? levels[v] : ''; } };
    }
    function weightTicks() {
      if (mode !== 'weight') return {};
      var u = weightUnit();
      var t = { precision: undefined, callback: function (v) { return u === 'kg' ? trimNum(v, 2) + ' kg' : fmtWeight(v, u); } };
      if (u === 'lboz') {
        var ys = [];
        chartConfig.data.datasets.forEach(function (ds) { ds.data.forEach(function (pt) { ys.push(pt.y); }); });
        var span = ys.length ? Math.max.apply(null, ys) - Math.min.apply(null, ys) : 1;
        var steps = [1 / 16, 2 / 16, 4 / 16, 8 / 16, 1, 2, 5, 10, 25];
        t.stepSize = steps.find(function (st) { return span / st <= 6; }) || 50;
      }
      return t;
    }

    // Date axis for the time charts: spans the whole range, labelled with dates
    // (and years when the chart covers more than about a year).
    function timeAxis() {
      var xs = [];
      chartConfig.data.datasets.forEach(function (ds) { ds.data.forEach(function (p) { xs.push(p.x); }); });
      var lo = rangeFrom ? dayNum(rangeFrom) : Math.min.apply(null, xs);
      var hi = Math.max(dayNum(today()), Math.max.apply(null, xs));
      var withYear = hi - lo > 330;
      return {
        type: 'linear',
        min: lo,
        max: hi,
        ticks: {
          color: C.text, font: { family: 'Geist', size: 11 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 16, maxTicksLimit: 7,
          callback: function (v) { return dayText(v, withYear); }
        },
        grid: { display: false }
      };
    }

    if (mode === 'weight' && chartConfig.options.plugins.tooltip.callbacks) {
      chartConfig.options.plugins.tooltip.callbacks.label = function (item) {
        var y = item.parsed.y;
        return item.dataset.label + ': ' + fmtWeight(weightUnit() === 'kg' ? y / 0.45359237 : y);
      };
    }

    chart = new Chart(canvas, chartConfig);
  }

  // ===== PET CRUD =====
  function openAddPetModal() {
    modalTitle.textContent = 'Add a pet';
    modalBody.innerHTML =
      '<div class="form-grid cols-2">' +
        '<label class="field">Name<input id="mName" placeholder="Felix" autocomplete="off" autofocus></label>' +
        '<label class="field">Icon<select id="mIcon">' +
          '<option>🐱</option><option>🐶</option><option>🐰</option><option>🐦</option>' +
          '<option>🐹</option><option>🐢</option><option>🐠</option><option>🦎</option><option>🐾</option>' +
        '</select></label>' +
      '</div>' +
      '<div class="form-grid cols-2" style="margin-top:10px">' +
        '<label class="field">Species<select id="mSpecies">' +
          '<option>Cat</option><option>Dog</option><option>Rabbit</option><option>Bird</option>' +
          '<option>Reptile</option><option>Fish</option><option>Other</option>' +
        '</select></label>' +
        '<label class="field">Breed<input id="mBreed" placeholder="Tuxedo" autocomplete="off"></label>' +
      '</div>' +
      '<label class="field" style="margin-top:10px">Birthday<input type="date" id="mBirthday"></label>' +
      '<div class="form-actions" style="margin-top:14px">' +
        '<button id="mSave" class="sage" type="button">Add pet</button>' +
        '<button id="mCancel" class="ghost" type="button">Cancel</button>' +
      '</div>';
    openModal();
    $('mName').focus();
    $('mSave').addEventListener('click', function () {
      var name = $('mName').value.trim();
      if (!name) return toast('Please enter a name');
      if (state.pets.length >= VAULT_LIMIT_PETS) return toast('You can have up to ' + VAULT_LIMIT_PETS + ' pets');
      var pet = {
        id: uid(),
        name: name,
        icon: $('mIcon').value,
        species: $('mSpecies').value,
        breed: $('mBreed').value.trim(),
        birthday: $('mBirthday').value
      };
      state.pets.push(pet);
      activePetId = pet.id;
      save();
      render();
      closeModal();
      toast('Pet added');
    });
    $('mCancel').addEventListener('click', closeModal);
  }

  function openEditPetModal(pet) {
    modalTitle.textContent = 'Edit ' + pet.name;
    modalBody.innerHTML =
      '<div class="form-grid cols-2">' +
        '<label class="field">Name<input id="mName" value="' + esc(pet.name) + '" autocomplete="off"></label>' +
        '<label class="field">Icon<select id="mIcon">' +
          ['🐱','🐶','🐰','🐦','🐹','🐢','🐠','🦎','🐾'].map(function(i){
            return '<option' + (pet.icon === i ? ' selected' : '') + '>' + i + '</option>';
          }).join('') +
        '</select></label>' +
      '</div>' +
      '<div class="form-grid cols-2" style="margin-top:10px">' +
        '<label class="field">Species<select id="mSpecies">' +
          ['Cat','Dog','Rabbit','Bird','Reptile','Fish','Other'].map(function(s){
            return '<option' + (pet.species === s ? ' selected' : '') + '>' + s + '</option>';
          }).join('') +
        '</select></label>' +
        '<label class="field">Breed<input id="mBreed" value="' + esc(pet.breed || '') + '" autocomplete="off"></label>' +
      '</div>' +
      '<label class="field" style="margin-top:10px">Birthday<input type="date" id="mBirthday" value="' + esc(pet.birthday || '') + '"></label>' +
      '<div class="form-actions" style="margin-top:14px">' +
        '<button id="mSave" class="sage" type="button">Save changes</button>' +
        '<button id="mCancel" class="ghost" type="button">Cancel</button>' +
      '</div>';
    openModal();
    $('mSave').addEventListener('click', function () {
      var name = $('mName').value.trim();
      if (!name) return toast('Name required');
      // Look the pet up again: a cloud update may have replaced it while this was open.
      var target = state.pets.find(function (x) { return x.id === pet.id; });
      if (!target) { closeModal(); return toast('This pet was removed on another device'); }
      target.name = name;
      target.icon = $('mIcon').value;
      target.species = $('mSpecies').value;
      target.breed = $('mBreed').value.trim();
      target.birthday = $('mBirthday').value;
      delete target.sample; // an edited demo pet is now the user's own
      save();
      render();
      closeModal();
      toast('Pet updated');
    });
    $('mCancel').addEventListener('click', closeModal);
  }

  function confirmDeletePet(petArg) {
    var p = petArg || activePet();
    if (!p) return;
    if (!confirm('Delete ' + p.name + ' and all of their logs? This cannot be undone.')) return;
    state.pets = state.pets.filter(function (x) { return x.id !== p.id; });
    state.records = state.records.filter(function (r) { return r.petId !== p.id; });
    if (activePetId === p.id) {
      activePetId = state.pets[0] ? state.pets[0].id : null;
    }
    save();
    render();
    toast('Pet deleted');
  }

  // ===== LOG CRUD =====
  // Everything filled in on the form, as a log. Returns null (with a message)
  // if something doesn't make sense or nothing was entered.
  function readForm(existing) {
    var record = blankRecord(existing ? existing.petId : activePetId, $('rDate').value || today());
    record.mood = num($('rMood').value);
    record.weight = readWeight($('rWeight'), $('rWeightOz'));
    if (typeof record.weight === 'number' && isNaN(record.weight)) { toast('Check the weight'); return null; }
    record.activity = num($('rActivity').value);
    record.cost = num($('rCost').value);
    var formFoods = readFoodRows(true);
    if (formFoods === null) return null;
    setRecordFoodItems(record, formFoods);
    record.note = $('rNote').value.trim();
    record.meds = readMedRows();
    // Tags outside the chip set (kept from older data) survive an edit untouched.
    record.tags = (existing ? existing.tags.filter(function (t) { return TAGS.indexOf(t) < 0; }) : []).concat(readTags());
    // Labels, play size and visit type only count when their tag is chosen
    Object.keys(LABEL_KINDS).forEach(function (kind) {
      var cfg = LABEL_KINDS[kind];
      record[cfg.logKey] = tagPressed(cfg.tag) ? formLabels[kind].slice() : [];
    });
    record.playSize = tagPressed('activity') ? formPlaySize : '';
    record.vetType = tagPressed('vet') ? formVetType : '';
    var readings = readFormReadings(record.petId, record.date);
    if (!readings) return null;
    // When editing, readings the form doesn't show (e.g. a second glucose reading that day) are kept
    record.readings = (existing ? editingKeepReadings.slice() : []).concat(readings);
    if (isBlankRecord(record)) { toast('Enter something to log'); return null; }
    return record;
  }

  // The most recent log for a pet on a date (the one "Add to last log" adds to)
  function lastLogFor(petId, date) {
    var found = null;
    state.records.forEach(function (r) { if (r.petId === petId && r.date === date) found = r; });
    return found;
  }
  // Show which log "Add to last log" would add to, or why it can't
  function renderAppendHint() {
    var btn = $('appendBtn'), hint = $('appendHint');
    var p = formPet();
    var date = $('rDate').value || today();
    var target = p && !editingLogId ? lastLogFor(p.id, date) : null;
    btn.hidden = !!editingLogId;
    btn.disabled = !target;
    hint.hidden = !!editingLogId || !p;
    if (!p) return;
    var when = date === today() ? 'today' : formatDate(date);
    hint.textContent = target
      ? '"Add to last log" adds to ' + p.name + '\'s last log for ' + when + ' (' + (kindsOf(target).map(label).join(', ') || 'Note') + ').'
      : 'No log for ' + p.name + ' ' + (date === today() ? 'today' : 'on ' + formatDate(date)) + ' yet, so "Add to last log" is off.';
  }
  // Combine what's on the form with the pet's most recent log for that date,
  // instead of creating a new one. Asks before replacing any value.
  function appendToLastLog() {
    if (editingLogId) return;
    var p = formPet();
    if (!p) return toast('Add a pet first');
    var date = $('rDate').value || today();
    var target = lastLogFor(p.id, date);
    if (!target) return toast('No log for ' + p.name + ' on ' + formatDate(date) + ' yet');
    var add = readForm(null);
    if (!add) return;
    var conflicts = [];
    function scalar(field, name, show) {
      if (has(add[field]) && has(target[field]) && normName(add[field]) !== normName(target[field])) {
        conflicts.push(name + ': ' + show(target[field]) + ' → ' + show(add[field]));
      }
    }
    scalar('weight', 'Weight', function (v) { return fmtWeight(v); });
    scalar('mood', 'Mood', function (v) { return v + '/5'; });
    scalar('activity', 'Activity', function (v) { return v + ' min'; });
    scalar('cost', 'Cost', function (v) { return '$' + v; });
    scalar('playSize', 'Play size', function (v) { return PLAY_SIZES[v] || v; });
    scalar('vetType', 'Visit type', function (v) { return VET_TYPES[v] || v; });
    if (conflicts.length && !confirm('That log already has:\n\n' + conflicts.join('\n') + '\n\nReplace with the new values?')) return;
    ['weight', 'mood', 'activity', 'cost', 'playSize', 'vetType'].forEach(function (f) { if (has(add[f])) target[f] = add[f]; });
    var appendedFoods = foodItemsOf(add);
    if (appendedFoods.length) setRecordFoodItems(target, foodItemsOf(target).concat(appendedFoods));
    add.meds.forEach(function (m) {
      var dup = target.meds.some(function (x) { return normName(x.name) === normName(m.name) && normName(x.note) === normName(m.note); });
      if (!dup) target.meds.push(m);
    });
    function union(a, b) {
      return (a || []).concat(b || []).filter(function (x, i, all) {
        return all.findIndex(function (y) { return normName(y) === normName(x); }) === i;
      });
    }
    target.tags = union(target.tags, add.tags);
    Object.keys(LABEL_KINDS).forEach(function (kind) { var k = LABEL_KINDS[kind].logKey; target[k] = union(target[k], add[k]); });
    if (add.note) target.note = target.note ? target.note + '\n' + add.note : add.note;
    target.readings = uniqueReadings((target.readings || []).concat(add.readings || []));
    target.v = DATA_VERSION;
    save();
    clearRecordForm();
    render();
    toast('Added to ' + p.name + '\'s ' + (date === today() ? 'latest log today' : formatDate(date) + ' log'));
    if (window.matchMedia('(max-width: 720px)').matches) switchTab('logs', true);
  }

  function handleRecordSubmit(e) {
    e.preventDefault();
    if (!activePetId) return toast('Add a pet first');
    // When editing, the log stays with the pet it belongs to, even if a
    // different pet has been selected since Edit was tapped.
    var existing = editingLogId ? state.records.find(function (r) { return r.id === editingLogId; }) : null;
    if (editingLogId && !existing) {
      clearRecordForm();
      return toast('This log was deleted on another device');
    }
    var record = readForm(existing);
    if (!record) return;
    record.id = editingLogId || record.id;
    if (existing) {
      // Keep when each medicine was given, if it's still on the log.
      record.meds.forEach(function (m) {
        var prev = existing.meds.find(function (x) { return x.at && normName(x.name) === normName(m.name); });
        if (prev) m.at = prev.at;
      });
      if (existing.loggedAt) record.loggedAt = existing.loggedAt;
      if (existing.sample) record.sample = true;
      if (existing.routine) record.routine = true;
      state.records = state.records.map(function (r) { return r.id === editingLogId ? record : r; });
      toast('Log updated');
    } else {
      record.loggedAt = new Date().toISOString();
      state.records.push(record);
      toast('Log added');
    }
    editingLogId = null;
    save();
    clearRecordForm();
    render();
    if (window.matchMedia('(max-width: 720px)').matches) switchTab('logs', true);
  }

  function editLog(id) {
    var r = state.records.find(function (x) { return x.id === id; });
    if (!r) return;
    editingLogId = id;
    $('rId').value = id;
    $('rDate').value = r.date;
    $('rMood').value = r.mood;
    writeWeight($('rWeight'), $('rWeightOz'), r.weight);
    $('rActivity').value = r.activity;
    $('rCost').value = r.cost;
    renderFoodRows(foodItemsOf(r));
    updateFoodPreview();
    $('rNote').value = r.note || '';
    fillFormReadings(r);
    setTags(r.tags);
    formLabels = { symptom: (r.symptoms || []).slice(), vomit: (r.vomitKinds || []).slice(),
      stool: (r.stoolKinds || []).slice(), play: (r.playKinds || []).slice() };
    formPlaySize = r.playSize || '';
    formVetType = r.vetType || '';
    renderAppendHint();
    renderLabelPanel();
    $('medRows').innerHTML = '';
    r.meds.forEach(function (m) { addMedRow(m.name, m.note); });
    renderStars();
    $('formTitle').textContent = 'Edit log';
    $('formHint').textContent = 'Editing existing entry';
    $('submitBtn').textContent = 'Save changes';
    if (window.matchMedia('(max-width: 720px)').matches) switchTab('add', true);
    // Scroll the form into view on smaller screens
    document.querySelector('.record-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function deleteLog(id) {
    if (!confirm('Delete this log?')) return;
    state.records = state.records.filter(function (r) { return r.id !== id; });
    if (editingLogId === id) {
      editingLogId = null;
      clearRecordForm();
    }
    save();
    render();
    toast('Log deleted');
  }

  function clearRecordForm() {
    editingLogId = null;
    $('rId').value = '';
    ['rMood', 'rWeight', 'rWeightOz', 'rActivity', 'rCost', 'rNote', 'rTime'].forEach(function (id) { $(id).value = ''; });
    renderFoodRows([]);
    updateFoodPreview();
    editingKeepReadings = [];
    document.querySelectorAll('#measureRows [data-measure]').forEach(function (el) { el.value = ''; });
    $('rDate').value = today();
    setTags([]);
    formLabels = { symptom: [], vomit: [], stool: [], play: [] };
    formPlaySize = '';
    formVetType = '';
    labelEditMode = { symptom: false, vomit: false, stool: false, play: false };
    renderAppendHint();
    renderLabelPanel();
    $('medRows').innerHTML = '';
    renderStars();
    $('formTitle').textContent = 'Add a log';
    $('formHint').textContent = 'All fields optional';
    $('submitBtn').textContent = 'Add log';
  }

  // ===== EXPORT / IMPORT =====
  function exportJson() {
    download('pet-health-tracker.json', JSON.stringify(state, null, 2), 'application/json');
    toast('JSON exported');
  }

  function exportCsv() {
    var rows = [['pet', 'species', 'breed', 'date', 'types', 'symptoms', 'vomit', 'stool', 'vet type', 'play size', 'play', 'weight', 'mood', 'activity', 'cost', 'food', 'food amount', 'food unit', 'food kcal', 'food unit size', 'food unit size unit', 'food items json', 'medications', 'readings', 'note']];
    state.records.forEach(function (r) {
      var p = state.pets.find(function (x) { return x.id === r.petId; }) || {};
      var meds = r.meds.map(function (m) { return m.name + (m.note ? ' (' + m.note + ')' : ''); }).join('; ');
      rows.push([p.name || '', p.species || '', p.breed || '', r.date, kindsOf(r).join('; '), (r.symptoms || []).join('; '),
        (r.vomitKinds || []).join('; '), (r.stoolKinds || []).join('; '), r.vetType || '', r.playSize || '', (r.playKinds || []).join('; '),
        r.weight, r.mood, r.activity, r.cost, r.food, r.foodAmount, r.foodUnit, r.foodKcal, r.foodUnitSize, r.foodUnitSizeUnit, JSON.stringify(foodItemsOf(r)), meds, readingsText(p, r), r.note]);
    });
    // The byte-order mark tells Excel the file is UTF-8, so emoji and accents
    // survive. The importer strips it.
    download('pet-health-tracker.csv', '\uFEFF' + rows.map(csvLine).join('\n'), 'text/csv');
    toast('CSV exported');
  }

  function triggerImport() { $('fileInput').click(); }

  // ===== BULK IMPORT FROM A SPREADSHEET (CSV) =====
  // Adds logs from a CSV (e.g. edited in Excel or Google Sheets). It never
  // replaces anything: rows already in the app are skipped, problems are
  // listed by row number, and nothing is saved until the preview is confirmed.
  function openImportChooser() {
    modalTitle.textContent = 'Import';
    modalBody.innerHTML =
      '<div class="menu-list">' +
        '<button class="menu-item" id="imCsv" type="button"><span class="menu-icon">📄</span>' +
          '<span>Add logs from a spreadsheet (CSV)<small class="menu-sub">Adds to what\'s here. You\'ll see a preview first.</small></span></button>' +
        '<button class="menu-item" id="imTemplate" type="button"><span class="menu-icon">⬇</span>' +
          '<span>Download the spreadsheet template<small class="menu-sub">Columns to fill in, with example rows.</small></span></button>' +
        '<button class="menu-item" id="imJson" type="button"><span class="menu-icon">♻</span>' +
          '<span>Restore a backup (JSON)<small class="menu-sub">Replaces all pets and logs with the backup.</small></span></button>' +
      '</div>';
    openModal();
    $('imCsv').addEventListener('click', function () { closeModal(); $('csvInput').click(); });
    $('imTemplate').addEventListener('click', function () { downloadCsvTemplate(); });
    $('imJson').addEventListener('click', function () { closeModal(); triggerImport(); });
  }

  function downloadCsvTemplate() {
    var p = activePet();
    var name = p ? p.name : 'Luna';
    var rows = [
      ['pet', 'date', 'lb', 'oz', 'medications', 'tags', 'symptoms', 'vomit', 'stool', 'vet type', 'play size', 'play', 'food', 'food amount', 'food unit', 'food kcal', 'food items json', 'mood', 'activity', 'cost', 'note', 'readings'],
      ['Example', '2026-09-20', '12', '9', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Rows for the pet "Example" are skipped. Replace them with your own.', ''],
      ['Example', '2026-09-20', '', '', 'Famotidine (1/4 of a 10 mg pill); Proviable-DC (Probiotic)', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', 'Blood glucose=142 @08:00'],
      ['Example', '9/21/2026', '', '', '', 'symptom', 'Restless; Begging for food', '', '', '', '', '', '', '', '', '', '', '', '', 'Restless all evening', ''],
      ['Example', '9/22/2026', '', '', '', 'activity', '', '', '', '', 'big', 'Bed game; String', '', '', '', '', '', '', '', '', 'Big play at 10 pm', ''],
      ['Example', '9/23/2026', '', '', '', 'vomit', '', 'Hairball', '', '', '', '', 'Fancy Feast Chicken', '1.35', 'can', '122', '', '', '', '', '1.35 cans eaten', ''],
      ['Example', '9/23/2026', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '[{"name":"Fancy Feast Chicken","amount":0.75,"unit":"can","kcal":67.5},{"name":"Science Diet","amount":0.5,"unit":"pouch","kcal":38}]', '', '', '', 'Multiple foods can share one log by using food items json.', ''],
      ['Example', '9/23/2026', '', '', '', 'stool', '', '', 'Soft', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ['Example', '9/24/2026', '', '', '', 'vet visit', '', '', '', 'scheduled', '', '', '', '', '', '', '', '', '', '85', 'Annual checkup (' + name + ')', '']
    ];
    download('pet-health-import-template.csv', rows.map(csvLine).join('\n'), 'text/csv');
    toast('Template downloaded');
  }
  // "Blood glucose=142 @08:00; Ketones=Trace @08:05"
  function readingsText(pet, r) {
    return (r.readings || []).map(function (x) {
      var ms = measureById(pet, x.m);
      return ms ? ms.name + '=' + x.v + (x.t ? ' @' + x.t : '') : '';
    }).filter(Boolean).join('; ');
  }
  // Spreadsheets run a cell starting with = + - or @ as a formula, so a note
  // like "=HYPERLINK(...)" could do something when the file is opened. Such
  // cells get a leading apostrophe, which spreadsheets hide and parseCsv
  // removes again. Plain numbers (e.g. -3) are left alone.
  function csvCell(x) {
    var t = String(x == null ? '' : x);
    if (/^[=+\-@\t\r]/.test(t) && !isFinite(Number(t))) t = "'" + t;
    return '"' + t.replace(/"/g, '""') + '"';
  }
  function csvLine(row) { return row.map(csvCell).join(','); }

  // Split CSV text into rows of fields (quotes, commas inside quotes, line
  // breaks inside quotes, Excel's byte-order mark, and ; as a separator).
  function parseCsv(text) {
    text = String(text).replace(/^\uFEFF/, '');
    var first = text.split(/\r?\n/)[0] || '';
    var delim = first.indexOf(',') < 0 && first.indexOf(';') >= 0 ? ';' : ',';
    var rows = [], row = [], field = '', quoted = false;
    // Undo csvCell's formula guard
    function unguard(f) { return /^'[=+\-@\t\r]/.test(f) ? f.slice(1) : f; }
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (quoted) {
        if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { row.push(unguard(field)); field = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(unguard(field)); rows.push(row); row = []; field = '';
      } else field += ch;
    }
    if (field !== '' || row.length) { row.push(unguard(field)); rows.push(row); }
    return rows;
  }

  // Dates like 2026-09-24, 9/24/2026 (US order), 9/24/26 or Sep 24, 2026
  function parseCsvDate(text) {
    var s = String(text || '').trim().replace(/[ T]\d{1,2}:\d{2}(:\d{2})?( ?[AP]M)?$/i, '');
    var m, y, mo, d;
    if ((m = /^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4}|\d{2})$/.exec(s))) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    else if (/[a-z]{3}/i.test(s) && !isNaN(Date.parse(s))) { var dt = new Date(Date.parse(s)); y = dt.getFullYear(); mo = dt.getMonth() + 1; d = dt.getDate(); }
    else return '';
    var check = new Date(y, mo - 1, d);
    if (y < 1990 || y > 2100 || check.getFullYear() !== y || check.getMonth() !== mo - 1 || check.getDate() !== d) return '';
    return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  // A log's content, for spotting rows that are already in the app
  function logSignature(r) {
    function t(x) { return String(x == null ? '' : x).trim().toLowerCase().replace(/\s+/g, ' '); }
    function n(x) { return has(x) && isFinite(Number(x)) ? Math.round(Number(x) * 1000) / 1000 : ''; }
    var foodSig = foodItemsOf(r).map(function (f) { return [t(f.name), n(f.amount), t(f.unit), n(f.kcal), n(f.unitSize), t(f.unitSizeUnit)].join('|'); });
    return JSON.stringify([r.petId, r.date, n(r.weight), n(r.mood), n(r.activity), n(r.cost), foodSig, t(r.note),
      (r.meds || []).map(function (m) { return t(m.name) + '|' + t(m.note); }).sort(),
      (r.tags || []).slice().sort(), (r.symptoms || []).map(t).sort(), t(r.playSize), (r.playKinds || []).map(t).sort(),
      (r.vomitKinds || []).map(t).sort(), (r.stoolKinds || []).map(t).sort(), t(r.vetType),
      (r.readings || []).map(function (x) { return x.m + '|' + t(x.v) + '|' + (x.t || ''); }).sort()]);
  }

  // Work out what a CSV would add, without changing anything
  function planCsvImport(text) {
    var COLUMNS = {
      pet: ['pet', 'pet name', 'name'], species: ['species'], date: ['date', 'day'],
      lb: ['lb', 'lbs', 'pounds', 'weight lb', 'weight (lb)'], oz: ['oz', 'ounces', 'weight oz', 'weight (oz)'],
      weight: ['weight'], kg: ['kg', 'weight kg', 'weight (kg)'],
      meds: ['medications', 'medication', 'medicines', 'medicine', 'meds'],
      tags: ['tags', 'types', 'type', 'events'], symptoms: ['symptoms', 'symptom labels'],
      vomit: ['vomit', 'vomit labels'], stool: ['stool', 'stool labels'], vetType: ['vet type', 'visit type'],
      readings: ['readings', 'measurements', 'measures'],
      playSize: ['play size', 'size'], play: ['play', 'play labels'],
      food: ['food', 'meal'], foodAmount: ['food amount', 'amount eaten', 'meal amount'], foodUnit: ['food unit', 'meal unit'],
      foodKcal: ['food kcal', 'calories eaten', 'kcal'], foodUnitSize: ['food unit size', 'package size'], foodUnitSizeUnit: ['food unit size unit', 'package size unit'],
      foodItems: ['food items json', 'food items', 'foods json'],
      mood: ['mood'], activity: ['activity', 'activity minutes', 'minutes'],
      cost: ['cost', 'price'], note: ['note', 'notes', 'description', 'comment']
    };
    var TAG_WORDS = { symptom: 'symptom', symptoms: 'symptom', vomit: 'vomit', vomiting: 'vomit', diarrhea: 'stool', diarrhoea: 'stool',
      stool: 'stool', poop: 'stool', 'bowel movement': 'stool',
      activity: 'activity', play: 'activity', vet: 'vet', 'vet visit': 'vet' };
    var DERIVED = ['weight', 'medication', 'medications', 'medicine', 'meal', 'food', 'note'];
    var plan = { adds: [], newPets: [], perPet: {}, duplicates: 0, examples: 0, problems: [], warnings: [], error: '' };

    var rows = parseCsv(text).filter(function (r) { return r.some(function (c) { return String(c).trim() !== ''; }); });
    if (!rows.length) { plan.error = 'The file is empty.'; return plan; }
    var header = rows[0].map(function (h) { return String(h).trim().toLowerCase().replace(/\s+/g, ' '); });
    var col = {};
    Object.keys(COLUMNS).forEach(function (key) {
      var i = header.findIndex(function (h) { return COLUMNS[key].indexOf(h) >= 0; });
      if (i >= 0) col[key] = i;
    });
    if (col.pet === undefined || col.date === undefined) {
      plan.error = 'The first row must be column names, including "pet" and "date". Download the template to see the layout.';
      return plan;
    }

    var petsByName = {};
    state.pets.forEach(function (p) { petsByName[normName(p.name)] = p; });
    var seen = {};
    state.records.forEach(function (r) { seen[logSignature(r)] = true; });
    var unknownTags = {};

    rows.slice(1).forEach(function (row, idx) {
      var line = idx + 2; // row number as shown in a spreadsheet
      function get(key) { return col[key] === undefined ? '' : String(row[col[key]] == null ? '' : row[col[key]]).trim(); }
      function list(key) { return get(key).split(';').map(function (x) { return x.trim().replace(/\s+/g, ' '); }).filter(Boolean); }
      function problem(msg) { plan.problems.push({ row: line, msg: msg }); }

      var petName = get('pet').replace(/\s+/g, ' ');
      if (!petName) return problem('No pet name');
      if (normName(petName) === 'example') { plan.examples++; return; }
      var date = parseCsvDate(get('date'));
      if (!date) return problem(get('date') ? 'Date "' + get('date') + '" isn\'t recognized (use 2026-09-24 or 9/24/2026)' : 'No date');

      // Weight: lb + oz, or decimal "weight" in pounds, or kg
      var weight = '';
      var lbText = get('lb'), ozText = get('oz'), wText = get('weight'), kgText = get('kg');
      if (lbText !== '' || ozText !== '') {
        var lb = lbText === '' ? 0 : Number(lbText), oz = ozText === '' ? 0 : Number(ozText);
        if (!isFinite(lb) || !isFinite(oz) || lb < 0 || oz < 0 || lb + oz <= 0) return problem('Weight "' + lbText + ' lb ' + ozText + ' oz" doesn\'t make sense');
        weight = Math.round((lb + oz / 16) * 10000) / 10000;
      } else if (wText !== '') {
        var w = Number(wText);
        if (!isFinite(w) || w <= 0) return problem('Weight "' + wText + '" doesn\'t make sense');
        weight = w;
      } else if (kgText !== '') {
        var kg = Number(kgText);
        if (!isFinite(kg) || kg <= 0) return problem('Weight "' + kgText + ' kg" doesn\'t make sense');
        weight = Math.round(kg / 0.45359237 * 10000) / 10000;
      }
      function number(key, lo, hi, what) {
        var t = get(key).replace(/[$,]/g, '');
        if (t === '') return '';
        var v = Number(t);
        if (!isFinite(v) || v < lo || (hi !== undefined && v > hi)) throw { row: line, msg: what + ' "' + get(key) + '" doesn\'t make sense' };
        return v;
      }
      var mood, activity, cost;
      try { mood = number('mood', 1, 5, 'Mood (1–5)'); activity = number('activity', 0, undefined, 'Activity minutes'); cost = number('cost', 0, undefined, 'Cost'); }
      catch (e) { return plan.problems.push(e); }

      var size = get('playSize').toLowerCase();
      if (size && !PLAY_SIZES[size]) return problem('Play size "' + get('playSize') + '" should be tiny, short, decent or big');

      var vetType = get('vetType').toLowerCase();
      if (vetType && !VET_TYPES[vetType]) return problem('Vet type "' + get('vetType') + '" should be scheduled, unscheduled or emergency');
      var tags = [];
      var stoolKinds = list('stool');
      list('tags').forEach(function (word) {
        var k = word.toLowerCase();
        // "Diarrhea" is a stool log marked Diarrhea
        if ((k === 'diarrhea' || k === 'diarrhoea') && !stoolKinds.some(function (x) { return normName(x) === 'diarrhea'; })) stoolKinds.push('Diarrhea');
        if (TAG_WORDS[k]) { if (tags.indexOf(TAG_WORDS[k]) < 0) tags.push(TAG_WORDS[k]); }
        else if (DERIVED.indexOf(k) < 0) unknownTags[word] = (unknownTags[word] || []).concat([line]);
      });
      var meds = list('meds').map(function (m) {
        var mm = /^(.*?)\s*\((.*)\)\s*$/.exec(m);
        return mm ? { name: mm[1].trim(), note: mm[2].trim() } : { name: m, note: '' };
      }).filter(function (m) { return m.name; });
      var symptoms = list('symptoms'), playKinds = list('play'), vomitKinds = list('vomit');
      // Labels imply their tag, so they're counted as symptoms / vomit / stool / play
      if (symptoms.length && tags.indexOf('symptom') < 0) tags.push('symptom');
      if (vomitKinds.length && tags.indexOf('vomit') < 0) tags.push('vomit');
      if (stoolKinds.length && tags.indexOf('stool') < 0) tags.push('stool');
      if (vetType && tags.indexOf('vet') < 0) tags.push('vet');
      if ((size || playKinds.length) && tags.indexOf('activity') < 0) tags.push('activity');

      var key = normName(petName);
      var pet = petsByName[key];
      if (!pet) {
        var species = get('species');
        pet = { id: uid(), name: petName, icon: /dog/i.test(species) ? '🐶' : /cat/i.test(species) ? '🐱' : '🐾', species: species || 'Other', breed: '', birthday: '' };
        petsByName[key] = pet;
        plan.newPets.push(pet);
      }
      // Readings: "Name=value @HH:MM; ..." for measures this pet has
      var readings = [], readingProblem = '';
      list('readings').forEach(function (part) {
        if (readingProblem) return;
        var mm = /^(.+?)\s*=\s*(.+?)(?:\s*@\s*(\d{1,2}):(\d{2}))?$/.exec(part);
        if (!mm) { readingProblem = 'Reading "' + part + '" should look like Name=value @HH:MM'; return; }
        var ms = petMeasures(pet).find(function (x) { return normName(x.name) === normName(mm[1]); });
        if (!ms) { readingProblem = pet.name + ' has no measure called "' + mm[1].trim() + '" (set it up in the app first)'; return; }
        var val = mm[2].trim();
        if (ms.type === 'number') {
          if (!isFinite(Number(val))) { readingProblem = ms.name + ' "' + val + '" isn\'t a number'; return; }
          val = Number(val);
        } else {
          var lv = (ms.levels || []).find(function (l) { return normName(l) === normName(val); });
          if (!lv) { readingProblem = ms.name + ' "' + val + '" isn\'t one of its levels'; return; }
          val = lv;
        }
        var reading = { m: ms.id, v: val };
        if (mm[3] !== undefined) {
          if (+mm[3] > 23 || +mm[4] > 59) { readingProblem = 'Time "' + mm[3] + ':' + mm[4] + '" isn\'t valid'; return; }
          reading.t = String(mm[3]).padStart(2, '0') + ':' + mm[4];
        }
        readings.push(reading);
      });
      if (readingProblem) return problem(readingProblem);
      var rec = blankRecord(pet.id, date);
      rec.readings = readings;
      rec.weight = weight;
      rec.meds = meds;
      rec.tags = tags;
      rec.symptoms = symptoms;
      rec.playSize = size;
      rec.playKinds = playKinds;
      rec.vomitKinds = vomitKinds;
      rec.stoolKinds = stoolKinds;
      rec.vetType = vetType;
      var foodJson = get('foodItems');
      if (foodJson) {
        var parsedFoods;
        try { parsedFoods = JSON.parse(foodJson); } catch (e) { return problem('Food items JSON is not valid JSON'); }
        if (!Array.isArray(parsedFoods)) return problem('Food items JSON must be a list');
        var importedFoods = [], foodProblem = '';
        parsedFoods.forEach(function (raw) {
          if (foodProblem) return;
          var f = normalizeFoodItem(raw);
          if (!f.name) { foodProblem = 'Every food item needs a name'; return; }
          if (f.amount !== '' && (!(Number(f.amount) > 0) || !FOOD_UNITS[f.unit])) { foodProblem = 'Check the amount/unit for ' + f.name; return; }
          importedFoods.push(f);
        });
        if (foodProblem) return problem(foodProblem);
        setRecordFoodItems(rec, importedFoods);
      } else {
        rec.food = get('food');
        var faText = get('foodAmount').replace(/,/g, '');
        if (faText !== '') {
          var fa = Number(faText);
          if (!(fa > 0) || !isFinite(fa)) return problem('Food amount "' + get('foodAmount') + '" doesn\'t make sense');
          if (!rec.food) return problem('Food amount was given without a food name');
          rec.foodAmount = fa;
          var fu = get('foodUnit').toLowerCase();
          if (!FOOD_UNITS[fu]) return problem('Food unit "' + get('foodUnit') + '" isn\'t recognized');
          rec.foodUnit = fu;
          var fkText = get('foodKcal').replace(/,/g, '');
          if (fkText !== '') { var fk = Number(fkText); if (!(fk > 0) || !isFinite(fk)) return problem('Food kcal "' + get('foodKcal') + '" doesn\'t make sense'); rec.foodKcal = fk; }
          var fsText = get('foodUnitSize').replace(/,/g, '');
          if (fsText !== '') { var fs = Number(fsText); if (!(fs > 0) || !isFinite(fs)) return problem('Food unit size "' + get('foodUnitSize') + '" doesn\'t make sense'); rec.foodUnitSize = fs; }
          var fsu = get('foodUnitSizeUnit').toLowerCase();
          if (fsu) { if (!FOOD_UNITS[fsu] || FOOD_UNITS[fsu].kind !== 'mass') return problem('Food unit size unit "' + get('foodUnitSizeUnit') + '" isn\'t a weight unit'); rec.foodUnitSizeUnit = fsu; }
        }
        if (rec.food) setRecordFoodItems(rec, [normalizeFoodItem({ name: rec.food, amount: rec.foodAmount, unit: rec.foodUnit, kcal: rec.foodKcal, unitSize: rec.foodUnitSize, unitSizeUnit: rec.foodUnitSizeUnit })]);
      }
      rec.mood = mood;
      rec.activity = activity;
      rec.cost = cost;
      rec.note = get('note');
      if (isBlankRecord(rec)) return problem('Nothing to log on this row');
      var sig = logSignature(rec);
      if (seen[sig]) { plan.duplicates++; return; }
      seen[sig] = true;
      plan.adds.push(rec);
      plan.perPet[pet.name] = (plan.perPet[pet.name] || 0) + 1;
    });

    Object.keys(unknownTags).forEach(function (w) {
      plan.warnings.push('Tag "' + w + '" isn\'t one the app uses, so it was left off (row ' + unknownTags[w].slice(0, 5).join(', ') + (unknownTags[w].length > 5 ? '…' : '') + ')');
    });
    // Stay within what the cloud vault can hold
    var total = state.records.length + plan.adds.length;
    var petTotal = state.pets.length + plan.newPets.filter(function (p) { return plan.adds.some(function (r) { return r.petId === p.id; }); }).length;
    if (total > VAULT_LIMIT_LOGS) plan.error = 'This would bring the vault to ' + total.toLocaleString() + ' logs; the limit is ' + VAULT_LIMIT_LOGS.toLocaleString() + '.';
    else if (petTotal > VAULT_LIMIT_PETS) plan.error = 'This would bring you to ' + petTotal + ' pets; the limit is ' + VAULT_LIMIT_PETS + '.';
    else if (vaultUsage(state.pets.concat(plan.newPets), state.records.concat(plan.adds)).byBytes > 0.97) {
      plan.error = 'This would make the vault too large to sync (about 1 MB is the limit). Try importing fewer rows.';
    }
    // New pets only count if they have logs to add
    plan.newPets = plan.newPets.filter(function (p) { return plan.adds.some(function (r) { return r.petId === p.id; }); });
    return plan;
  }

  function handleCsvImport(e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      $('csvInput').value = '';
      showImportPreview(planCsvImport(reader.result));
    };
    reader.onerror = function () { $('csvInput').value = ''; toast('Could not read file'); };
    reader.readAsText(f);
  }

  function showImportPreview(plan) {
    modalTitle.textContent = 'Import preview';
    var h = '';
    if (plan.error) {
      h += '<p class="import-error">' + esc(plan.error) + '</p>';
    } else if (plan.adds.length) {
      h += '<p class="import-lead"><b>' + plan.adds.length + '</b> new ' + (plan.adds.length === 1 ? 'log' : 'logs') + ' to add</p>' +
        '<ul class="import-list">' + Object.keys(plan.perPet).map(function (n) {
          return '<li>' + esc(n) + ': ' + plan.perPet[n] + '</li>';
        }).join('') + '</ul>';
      if (plan.newPets.length) {
        h += '<p class="import-note">New ' + (plan.newPets.length === 1 ? 'pet' : 'pets') + ' will be created: <b>' +
          plan.newPets.map(function (p) { return esc(p.name); }).join(', ') + '</b>. If that\'s a typo, cancel and fix the name.</p>';
      }
    } else {
      h += '<p class="import-lead">Nothing new to add.</p>';
    }
    if (plan.duplicates) h += '<p class="import-note">' + plan.duplicates + ' ' + (plan.duplicates === 1 ? 'row is' : 'rows are') + ' already in the app and will be skipped.</p>';
    if (plan.examples) h += '<p class="import-note">' + plan.examples + ' example ' + (plan.examples === 1 ? 'row' : 'rows') + ' (pet "Example") skipped.</p>';
    if (plan.problems.length) {
      h += '<p class="import-note"><b>' + plan.problems.length + ' ' + (plan.problems.length === 1 ? 'row has a problem' : 'rows have problems') + '</b> and will be skipped:</p>' +
        '<ul class="import-list">' + plan.problems.slice(0, 10).map(function (pr) { return '<li>Row ' + pr.row + ': ' + esc(pr.msg) + '</li>'; }).join('') +
        (plan.problems.length > 10 ? '<li>…and ' + (plan.problems.length - 10) + ' more</li>' : '') + '</ul>';
    }
    plan.warnings.forEach(function (w) { h += '<p class="import-note">' + esc(w) + '</p>'; });
    var canAdd = !plan.error && plan.adds.length;
    h += '<div class="form-actions" style="margin-top:14px">' +
      (canAdd ? '<button class="sage" id="impAdd" type="button">Add ' + plan.adds.length + ' ' + (plan.adds.length === 1 ? 'log' : 'logs') + '</button>' : '') +
      '<button class="ghost" id="impCancel" type="button">' + (canAdd ? 'Cancel' : 'Close') + '</button></div>';
    modalBody.innerHTML = h;
    openModal();
    $('impCancel').addEventListener('click', closeModal);
    if (canAdd) $('impAdd').addEventListener('click', function () { applyImportPlan(plan); });
  }

  function applyImportPlan(plan) {
    state.pets = state.pets.concat(plan.newPets);
    state.records = state.records.concat(plan.adds);
    var firstPet = plan.adds[0] && plan.adds[0].petId;
    if (firstPet) activePetId = firstPet;
    save();
    closeModal();
    render();
    toast('Added ' + plan.adds.length + ' ' + (plan.adds.length === 1 ? 'log' : 'logs'));
  }

  function handleImport(e) {
    var f = e.target.files && e.target.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        if (!data || !Array.isArray(data.pets) || !Array.isArray(data.records)) {
          throw new Error('Invalid format');
        }
        var seenBefore = newerDataSeen;
        var restored = normalizeState(data);
        var restoredNewer = newerDataSeen;
        newerDataSeen = seenBefore; // only counts once the restore is confirmed
        var tooBig = syncCode && vaultTooBig(restored.pets, restored.records);
        if (tooBig) {
          toast('This backup is too big for your cloud vault (' + tooBig + ')');
          $('fileInput').value = '';
          return;
        }
        if (!confirm('Restoring replaces ALL pets and logs on this device' + (syncCode ? ', and in your synced vault on every device' : '') + ', with the backup.\n\nTo add logs instead, use "Add logs from a spreadsheet". Continue?')) {
          $('fileInput').value = '';
          return;
        }
        state = restored;
        if (restoredNewer) newerDataSeen = true;
        activePetId = state.pets[0] ? state.pets[0].id : null;
        save();
        render();
        toast('Data imported');
      } catch (err) {
        toast('Could not read file');
      }
      $('fileInput').value = '';
    };
    reader.readAsText(f);
  }

  // ===== MOBILE TAB / MODAL HELPERS =====
  // Track whether we're currently in mobile layout so resize handlers can detect
  // boundary crossings instead of running tab-switching logic on every resize.
  var isMobileLayout; // set in init()

  function applyMobileTab() {
    var nowMobile = window.matchMedia('(max-width: 720px)').matches;
    if (!nowMobile) {
      // Desktop: ensure all panels are visible. Cheap to re-apply but safe.
      document.querySelectorAll('.panel').forEach(function (el) { el.classList.add('active'); });
      // Clear any active state on the mobile nav buttons (they're hidden by CSS but the class persists)
      document.querySelectorAll('.mobile-nav button').forEach(function (b) {
        b.classList.toggle('active', b.dataset.tab === 'home');
      });
      isMobileLayout = false;
      return;
    }
    // Only force tab state on mobile when transitioning IN from desktop;
    // otherwise leave the user on whatever tab they're viewing.
    if (!isMobileLayout) {
      switchTab('home', /* userInitiated */ false);
    }
    isMobileLayout = true;
  }

  function switchTab(tab, userInitiated) {
    if (!window.matchMedia('(max-width: 720px)').matches) return; // desktop ignores
    var panelMap = { home: 'panel-home', add: 'panel-log', trends: 'panel-log', logs: 'panel-log' };
    document.querySelectorAll('.panel').forEach(function (el) {
      el.classList.toggle('active', el.id === panelMap[tab]);
    });
    document.querySelectorAll('.mobile-nav button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    // Only auto-scroll when the user explicitly tapped a tab.
    // This prevents resize/orientation events from yanking the page to the top.
    if (!userInitiated) return;
    if (tab === 'add') {
      setTimeout(function () { document.querySelector('.record-form').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
    } else if (tab === 'trends') {
      setTimeout(function () { document.getElementById('trends-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
    } else if (tab === 'logs') {
      setTimeout(function () { document.querySelector('.records-card').scrollIntoView({ behavior: 'smooth', block: 'start' }); }, 50);
    } else if (tab === 'home') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ===== VET SUMMARY =====
  // A one-page summary of one pet over a period, for handing to a vet. It's
  // shown over the app and printed (or saved as PDF) with the browser's print
  // dialog. Only that pet's data goes in; never the vault code.
  function dayCount(from, to) {
    return Math.round((new Date(to + 'T00:00:00') - new Date(from + 'T00:00:00')) / 864e5) + 1;
  }
  // The Monday on or before a YYYY-MM-DD date
  function mondayOf(dateStr) {
    var d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() - (d.getDay() + 6) % 7);
    return localDate(d);
  }
  function shiftDay(dateStr, n) {
    var d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return localDate(d);
  }
  function shortDate(d) {
    var dt = new Date(d + 'T00:00:00');
    return isNaN(dt.getTime()) ? d : dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function lastVetVisit(pet) {
    var t = today(), last = '';
    state.records.forEach(function (r) {
      if (r.petId === pet.id && hasTag(r, 'vet') && r.date <= t && r.date > last) last = r.date;
    });
    return last;
  }
  // Everything the summary shows, worked out from the logs.
  function computeVetSummary(pet, from, to) {
    var recs = state.records
      .filter(function (r) { return r.petId === pet.id && r.date >= from && r.date <= to; })
      .sort(function (a, b) { return a.date === b.date ? String(a.loggedAt || '').localeCompare(String(b.loggedAt || '')) : a.date.localeCompare(b.date); });

    // Weight: the last weigh-in of each day
    var byDay = {};
    recs.forEach(function (r) { if (has(r.weight) && isFinite(Number(r.weight))) byDay[r.date] = Number(r.weight); });
    var wDays = Object.keys(byDay).sort();
    var weight = null;
    if (wDays.length) {
      var vals = wDays.map(function (d) { return byDay[d]; });
      var first = vals[0], last = vals[vals.length - 1];
      weight = {
        first: { date: wDays[0], value: first },
        last: { date: wDays[wDays.length - 1], value: last },
        min: Math.min.apply(null, vals),
        max: Math.max.apply(null, vals),
        change: last - first,
        pct: first ? (last - first) / first * 100 : 0,
        points: wDays.map(function (d) { return { date: d, value: byDay[d] }; })
      };
    }

    // Medicines: days given, current dose, dose changes, and for daily-routine
    // medicines, how many of the expected days they were given
    var meds = {}, order = [];
    recs.forEach(function (r) {
      r.meds.forEach(function (m) {
        var k = normName(m.name);
        if (!k) return;
        if (!meds[k]) { meds[k] = { name: m.name, days: {}, dose: '', changes: [] }; order.push(k); }
        var md = meds[k];
        md.name = m.name;
        md.days[r.date] = true;
        var note = String(m.note || (r.meds.length === 1 ? r.note : '') || '').trim();
        if (note && normName(note) !== normName(md.dose)) {
          if (md.dose) md.changes.push({ date: r.date, from: md.dose, to: note });
          md.dose = note;
        }
      });
    });
    var t = today();
    var medicines = order.map(function (k) {
      var md = meds[k];
      var days = Object.keys(md.days).sort();
      var out = { name: md.name, dose: md.dose, changes: md.changes, daysGiven: days.length, first: days[0], last: days[days.length - 1] };
      // Given on X of Y days, and how often that is per week. Y counts from the
      // period start if it was already being given, otherwise from its first dose.
      // (No "missed" days: the app doesn't know the intended schedule.)
      var givenBefore = state.records.some(function (r) {
        return r.petId === pet.id && r.date < from && r.meds.some(function (m) { return normName(m.name) === k; });
      });
      var start = givenBefore ? from : days[0];
      var end = to < t ? to : t;
      if (end === t && !md.days[t]) end = shiftDay(t, -1); // today isn't over yet
      if (start <= end) {
        out.span = dayCount(start, end);
        out.given = days.filter(function (d) { return d >= start && d <= end; }).length;
        out.perWeek = out.given / out.span * 7;
      }
      return out;
    });

    // Vomiting and diarrhea
    function episodes(match, labelKey) {
      return recs.filter(match).map(function (r) { return { date: r.date, note: r.note, labels: (r[labelKey] || []).slice() }; });
    }
    // Other notes: symptoms, vet visits, and any log with a note, except
    // medicine-only logs (their notes are doses) and episodes (listed above)
    var notes = recs.filter(function (r) {
      if (hasTag(r, 'vomit') || hasTag(r, 'stool')) return false;
      var medicineOnly = r.meds.length && !r.tags.length && !has(r.weight) && !foodItemsOf(r).length && !has(r.activity) && !has(r.mood);
      if (medicineOnly) return false;
      return !!r.note || hasTag(r, 'symptom') || hasTag(r, 'vet');
    }).map(function (r) {
      var detail = (r.symptoms || []).slice();
      if (hasTag(r, 'vet') && VET_TYPES[r.vetType]) detail.unshift(VET_TYPES[r.vetType] + ' visit');
      if (hasTag(r, 'activity')) {
        if (PLAY_SIZES[r.playSize]) detail.push(PLAY_SIZES[r.playSize] + ' play');
        detail = detail.concat(r.playKinds || []);
      }
      return { date: r.date, kinds: kindsOf(r), detail: detail, note: r.note };
    });

    // Label counts for symptoms, and play sessions by size and kind
    function countLabels(list) {
      var n = {}, spelled = {};
      list.forEach(function (l) { var k = normName(l); if (!k) return; n[k] = (n[k] || 0) + 1; spelled[k] = l; });
      return Object.keys(n).sort(function (a, b) { return n[b] - n[a] || a.localeCompare(b); })
        .map(function (k) { return { name: spelled[k], count: n[k] }; });
    }
    var symptomLogs = recs.filter(function (r) { return hasTag(r, 'symptom'); });
    var playLogs = recs.filter(function (r) { return hasTag(r, 'activity'); });
    var sizes = { big: 0, decent: 0, short: 0, tiny: 0 };
    playLogs.forEach(function (r) { if (sizes[r.playSize] !== undefined) sizes[r.playSize]++; });

    // Food: each distinct food gets its own row because a single log can now
    // contain several foods at once.
    var foods = [], foodByName = {};
    recs.forEach(function (r) {
      foodItemsOf(r).forEach(function (item) {
        var k = normName(item.name);
        if (!k) return;
        if (!foodByName[k]) { foodByName[k] = { food: item.name, from: r.date, to: r.date, days: {} }; foods.push(foodByName[k]); }
        var f = foodByName[k];
        if (r.date < f.from) f.from = r.date;
        if (r.date > f.to) f.to = r.date;
        f.days[r.date] = true;
      });
    });
    foods.forEach(function (f) { f.dayCount = Object.keys(f.days).length; delete f.days; });
    // Intake by week (Monday to Sunday): days with food logged, average
    // calories on days that have calorie data, and each food's average amount
    // on the days it was eaten.
    var foodWeeks = [], weekByStart = {};
    recs.forEach(function (r) {
      var items = foodItemsOf(r);
      if (!items.length) return;
      var wk = mondayOf(r.date);
      var w = weekByStart[wk];
      if (!w) { w = weekByStart[wk] = { week: wk, days: {}, kcal: {}, foods: [], byKey: {} }; foodWeeks.push(w); }
      w.days[r.date] = true;
      var k = foodTotalKcal(r);
      if (k !== '') w.kcal[r.date] = (w.kcal[r.date] || 0) + k;
      items.forEach(function (f) {
        if (!f.name) return;
        var key = normName(f.name) + '|' + (f.unit || '');
        var e = w.byKey[key];
        if (!e) { e = w.byKey[key] = { name: f.name, unit: f.unit || '', amount: 0, days: {} }; w.foods.push(e); }
        if (Number(f.amount) > 0) e.amount += Number(f.amount);
        e.days[r.date] = true;
      });
    });
    foodWeeks.sort(function (a, b) { return a.week.localeCompare(b.week); });
    foodWeeks.forEach(function (w) {
      w.dayCount = Object.keys(w.days).length;
      var kd = Object.keys(w.kcal);
      w.avgKcal = kd.length ? kd.reduce(function (t, d) { return t + w.kcal[d]; }, 0) / kd.length : null;
      w.foods = w.foods.map(function (e) {
        var n = Object.keys(e.days).length;
        return { name: e.name, perDay: e.amount > 0 && e.unit ? e.amount / n : null, unit: e.unit };
      });
      delete w.days; delete w.kcal; delete w.byKey;
    });

    // Mood: average, and the lowest days
    var moods = recs.filter(function (r) { return has(r.mood) && isFinite(Number(r.mood)); })
      .map(function (r) { return { date: r.date, value: Number(r.mood) }; });
    var mood = null;
    if (moods.length) {
      var lowest = Math.min.apply(null, moods.map(function (m) { return m.value; }));
      mood = {
        count: moods.length,
        average: moods.reduce(function (a, m) { return a + m.value; }, 0) / moods.length,
        lowest: lowest,
        lowestDates: moods.filter(function (m) { return m.value === lowest; }).map(function (m) { return m.date; })
      };
    }

    // Events for the chart: one per day, each { date, text }
    function eventsByDay(items) {
      var out = [];
      items.forEach(function (it) {
        var same = out.find(function (o) { return o.date === it.date; });
        if (same) { if (it.text) same.text = same.text ? same.text + '; ' + it.text : it.text; }
        else out.push({ date: it.date, text: it.text || '' });
      });
      return out.sort(function (a, b) { return a.date.localeCompare(b.date); });
    }
    function uniqueDates(list) {
      return eventsByDay(list.map(function (r) { return { date: r.date, text: '' }; }));
    }
    // A medicine starting during the period, or its dose changing
    function medicineChanges() {
      var items = [];
      medicines.forEach(function (m) {
        var k = normName(m.name);
        var givenBefore = state.records.some(function (r) {
          return r.petId === pet.id && r.date < from && r.meds.some(function (x) { return normName(x.name) === k; });
        });
        if (!givenBefore && m.first) items.push({ date: m.first, text: m.name + ' started' });
        m.changes.forEach(function (c) { items.push({ date: c.date, text: m.name + ': ' + c.from + ' → ' + c.to }); });
      });
      return eventsByDay(items);
    }
    // Mark days where the set of foods changes. With multiple foods in one
    // day this is more accurate than treating one food as the day's identity.
    function foodChanges() {
      var dayFoods = {}, beforeDay = '', beforeNames = [];
      state.records.slice().sort(byDate).forEach(function (r) {
        if (r.petId !== pet.id) return;
        var names = foodItemsOf(r).map(function (x) { return x.name; });
        if (!names.length) return;
        if (r.date < from) {
          if (!beforeDay || r.date >= beforeDay) {
            if (r.date !== beforeDay) beforeNames = [];
            beforeDay = r.date;
            beforeNames = beforeNames.concat(names);
          }
          return;
        }
        if (r.date > to) return;
        dayFoods[r.date] = (dayFoods[r.date] || []).concat(names);
      });
      function clean(list) {
        var seen = {};
        return list.filter(function (n) { var k = normName(n); if (!k || seen[k]) return false; seen[k] = true; return true; }).sort(function (a, b) { return normName(a).localeCompare(normName(b)); });
      }
      var prev = clean(beforeNames), items = [];
      Object.keys(dayFoods).sort().forEach(function (d) {
        var cur = clean(dayFoods[d]);
        var a = prev.map(normName).join('|'), b = cur.map(normName).join('|');
        if (a && a !== b) items.push({ date: d, text: 'Food: ' + cur.join(', ') });
        prev = cur;
      });
      return eventsByDay(items);
    }
    // Vet visits by type
    var visits = recs.filter(function (r) { return hasTag(r, 'vet'); });

    // Custom measures with readings in the period
    var measureStats = petMeasures(pet).map(function (ms) {
      var rd = [];
      recs.forEach(function (r) { (r.readings || []).forEach(function (x) { if (x.m === ms.id) rd.push({ date: r.date, t: x.t || '', v: x.v }); }); });
      if (!rd.length) return null;
      rd.sort(function (a, b) { return (a.date + a.t).localeCompare(b.date + b.t); });
      var out = { def: ms, readings: rd, latest: rd[rd.length - 1] };
      if (ms.type === 'number') {
        var vals = rd.map(function (x) { return Number(x.v); });
        out.min = Math.min.apply(null, vals);
        out.max = Math.max.apply(null, vals);
        out.avg = vals.reduce(function (a, b) { return a + b; }, 0) / vals.length;
        out.below = vals.filter(function (v) { return outOfRange(ms, v) === 'low'; }).length;
        out.above = vals.filter(function (v) { return outOfRange(ms, v) === 'high'; }).length;
      } else {
        out.levelCounts = (ms.levels || []).map(function (l) {
          return { name: l, count: rd.filter(function (x) { return normName(x.v) === normName(l); }).length };
        });
      }
      return out;
    }).filter(Boolean);

    return {
      measures: measureStats,
      foods: foods,
      foodWeeks: foodWeeks,
      mood: mood,
      visits: { count: visits.length, types: countLabels(visits.map(function (r) { return VET_TYPES[r.vetType] || ''; }).filter(Boolean)) },
      vomitLabels: countLabels([].concat.apply([], recs.filter(function (r) { return hasTag(r, 'vomit'); }).map(function (r) { return r.vomitKinds || []; }))),
      stoolLabels: countLabels([].concat.apply([], recs.filter(function (r) { return hasTag(r, 'stool'); }).map(function (r) { return r.stoolKinds || []; }))),
      // Dates of events to mark on the weight chart (one mark per day)
      events: {
        symptom: uniqueDates(recs.filter(function (r) { return hasTag(r, 'symptom'); })),
        vomit: uniqueDates(recs.filter(function (r) { return hasTag(r, 'vomit'); })),
        diarrhea: uniqueDates(recs.filter(isDiarrhea)),
        medicine: medicineChanges(),
        food: foodChanges()
      },
      symptomCount: symptomLogs.length,
      symptomLabels: countLabels([].concat.apply([], symptomLogs.map(function (r) { return r.symptoms || []; }))),
      play: {
        sessions: playLogs.length,
        sizes: sizes,
        kinds: countLabels([].concat.apply([], playLogs.map(function (r) { return r.playKinds || []; })))
      },
      pet: pet, from: from, to: to, days: dayCount(from, to), logs: recs,
      weight: weight, medicines: medicines,
      vomit: episodes(function (r) { return hasTag(r, 'vomit'); }, 'vomitKinds'),
      diarrhea: episodes(isDiarrhea, 'stoolKinds'),
      stool: episodes(function (r) { return hasTag(r, 'stool'); }, 'stoolKinds'),
      notes: notes
    };
  }

  function renderVetReport(sum, unit, fullLog, marks, include) {
    var p = sum.pet;
    function wt(v) { return esc(fmtWeight(v, unit)); }
    function signed(v, digits) { return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(digits); }
    var h = '';

    // Pet and period
    h += '<header class="vr-head"><h1>Health summary: ' + esc(p.name) + '</h1>' +
      '<p>' + esc((p.species || 'Pet') + (p.breed ? ' · ' + p.breed : '') + age(p.birthday)) + '</p>' +
      '<p class="vr-muted">' + esc(formatDate(sum.from)) + ' – ' + esc(formatDate(sum.to)) + ' (' + sum.days + ' days) · Weights in ' + esc(weightUnitName(unit)) + '</p>' +
      (sum.visits.count
        ? '<p>Vet visits in this period: <b>' + sum.visits.count + '</b>' +
          (sum.visits.types.length ? ' (' + sum.visits.types.map(function (v) { return esc(v.name) + ' ' + v.count; }).join(', ') + ')' : '') + '</p>'
        : '') +
      '</header>';

    // Weight
    h += '<section><h2>Weight</h2>';
    if (sum.weight) {
      var w = sum.weight;
      h += '<div class="vr-scroll"><table><tr><th>Start</th><th>Latest</th><th>Change</th><th>Range</th></tr><tr>' +
        '<td>' + wt(w.first.value) + '<div class="vr-muted">' + esc(formatDate(w.first.date)) + '</div></td>' +
        '<td>' + wt(w.last.value) + '<div class="vr-muted">' + esc(formatDate(w.last.date)) + '</div></td>' +
        '<td>' + esc(fmtWeightChange(w.change, unit)) + '<div class="vr-muted">' + signed(w.pct, 1) + '%</div></td>' +
        '<td>' + wt(w.min) + ' – ' + wt(w.max) + '<div class="vr-muted">' + w.points.length + ' weigh-ins</div></td>' +
        '</tr></table></div>';
    } else {
      h += '<p class="vr-muted">No weights logged in this period.</p>';
    }
    marks = marks || {};
    var anyMarked = VET_MARKS.some(function (l) { return marks[l.key] && sum.events[l.key].length; });
    if ((sum.weight && sum.weight.points.length > 1) || anyMarked) {
      h += weightSparkline(sum.weight && sum.weight.points.length > 1 ? sum.weight : null, unit, sum.events, sum.from, sum.to, marks);
    }
    h += '</section>';

    // Medicines
    h += '<section><h2>Medicines</h2>';
    if (sum.medicines.length) {
      h += '<div class="vr-scroll"><table><tr><th>Medicine</th><th>Latest dose</th><th>Given</th><th>Dose changes</th></tr>' +
        sum.medicines.map(function (m) {
          var given;
          if (m.daysGiven === 1) {
            // A one-off dose: "1 of 12 days" would read as 11 missed doses
            given = 'Once<div class="vr-muted">' + esc(shortDate(m.first)) + '</div>';
          } else if (m.span) {
            var pw = Math.round(m.perWeek * 10) / 10;
            given = m.given + ' of ' + m.span + ' days' +
              '<div class="vr-muted">' + (pw < 1 ? 'Less than once a week' : pw === 1 ? 'About once a week' : 'About ' + trimNum(pw, 1) + ' times a week') + '</div>';
          } else {
            given = m.daysGiven + (m.daysGiven === 1 ? ' day' : ' days') +
              '<div class="vr-muted">' + esc(shortDate(m.first)) + (m.last !== m.first ? ' – ' + esc(shortDate(m.last)) : '') + '</div>';
          }
          var changes = m.changes.length
            ? m.changes.map(function (c) { return esc(shortDate(c.date)) + ': ' + esc(c.from) + ' → ' + esc(c.to); }).join('<br>')
            : '<span class="vr-muted">None</span>';
          return '<tr><td><b>' + esc(m.name) + '</b></td><td>' + (m.dose ? esc(m.dose) : '<span class="vr-muted">Not recorded</span>') + '</td><td>' + given + '</td><td>' + changes + '</td></tr>';
        }).join('') + '</table></div>';
    } else {
      h += '<p class="vr-muted">No medicines logged in this period.</p>';
    }
    h += '</section>';

    // Vomiting and diarrhea
    h += '<section><h2>Vomiting and stool</h2>';
    if (sum.vomit.length || sum.stool.length) {
      var breakdown = function (list) { return list.length ? ' (' + list.map(function (l) { return esc(l.name) + ' ' + l.count; }).join(' · ') + ')' : ''; };
      // Normal stools with no note are counted but not listed, so the table
      // shows only what a vet would ask about.
      var isRoutineStool = function (e) { return !e.note && e.labels.length && e.labels.every(function (l) { return normName(l) === 'normal'; }); };
      var rows = sum.vomit.map(function (e) { return { date: e.date, what: 'Vomiting', labels: e.labels, note: e.note }; })
        .concat(sum.stool.filter(function (e) { return !isRoutineStool(e); }).map(function (e) { return { date: e.date, what: 'Stool', labels: e.labels, note: e.note }; }))
        .sort(function (a, b) { return a.date.localeCompare(b.date); });
      var hidden = sum.stool.filter(isRoutineStool).length;
      h += '<p>Vomiting: <b>' + sum.vomit.length + '</b>' + breakdown(sum.vomitLabels) + '</p>' +
        '<p>Stool logs: <b>' + sum.stool.length + '</b>' + breakdown(sum.stoolLabels) + '</p>';
      if (rows.length) {
        h += '<div class="vr-scroll"><table><tr><th>Date</th><th>Episode</th><th>Note</th></tr>' +
          rows.map(function (e) {
            return '<tr><td>' + esc(formatDate(e.date)) + '</td><td>' + e.what +
              (e.labels.length ? '<div class="vr-muted">' + esc(e.labels.join(', ')) + '</div>' : '') +
              '</td><td>' + esc(e.note || '') + '</td></tr>';
          }).join('') +
          '</table></div>';
      }
      if (hidden) h += '<p class="vr-muted">' + hidden + ' normal ' + (hidden === 1 ? 'stool' : 'stools') + ' not listed.</p>';
    } else {
      h += '<p class="vr-muted">None logged in this period.</p>';
    }
    h += '</section>';

    // Food
    h += '<section><h2>Food</h2>';
    if (sum.foods.length) {
      h += '<div class="vr-scroll"><table><tr><th>Food</th><th>Dates</th><th>Days logged</th></tr>' +
        sum.foods.map(function (f) {
          return '<tr><td>' + esc(f.food) + '</td><td>' + esc(shortDate(f.from)) + (f.to !== f.from ? ' – ' + esc(shortDate(f.to)) : '') + '</td><td>' + f.dayCount + '</td></tr>';
        }).join('') + '</table></div>';
      if (sum.foodWeeks.some(function (w) { return w.avgKcal !== null || w.foods.some(function (f) { return f.perDay !== null; }); })) {
        h += '<h3 class="vr-sub">Intake by week</h3><p class="vr-muted">Averages are per day with food logged.</p>' +
          '<div class="vr-scroll"><table><tr><th>Week of</th><th>Days logged</th><th>Calories / day</th><th>Amount / day</th></tr>' +
          sum.foodWeeks.map(function (w) {
            var amounts = w.foods.map(function (f) {
              return esc(f.name) + (f.perDay !== null ? ' <span class="vr-muted">' + esc(trimNum(f.perDay, 2) + ' ' + foodUnitLabel(f.unit, f.perDay)) + '</span>' : '');
            }).join('<br>');
            return '<tr><td>' + esc(shortDate(w.week)) + '</td><td>' + w.dayCount + '</td><td>' +
              (w.avgKcal !== null ? esc(Math.round(w.avgKcal).toLocaleString()) + ' kcal' : '—') + '</td><td>' + amounts + '</td></tr>';
          }).join('') + '</table></div>';
      }
    } else {
      h += '<p class="vr-muted">No food logged in this period.</p>';
    }
    h += '</section>';

    // Mood
    if (sum.mood) {
      var mo = sum.mood;
      h += '<section><h2>Mood</h2><p>Average <b>' + trimNum(mo.average, 1) + '</b> of 5 over ' + mo.count + (mo.count === 1 ? ' rating' : ' ratings') +
        ' · Lowest ' + mo.lowest + ' (' + mo.lowestDates.slice(0, 4).map(function (d) { return esc(shortDate(d)); }).join(', ') +
        (mo.lowestDates.length > 4 ? ' and ' + (mo.lowestDates.length - 4) + ' more' : '') + ')</p></section>';
    }

    // Play
    if (sum.play.sessions) {
      var pl = sum.play;
      var sized = Object.keys(pl.sizes).filter(function (k) { return pl.sizes[k]; })
        .map(function (k) { return PLAY_SIZES[k] + ' ' + pl.sizes[k]; });
      h += '<section><h2>Play</h2><p><b>' + pl.sessions + '</b> play ' + (pl.sessions === 1 ? 'session' : 'sessions') +
        (sized.length ? ' · ' + esc(sized.join(' · ')) : '') + '</p>' +
        (pl.kinds.length ? '<p class="vr-muted">' + pl.kinds.map(function (k) { return esc(k.name) + ' ' + k.count; }).join(' · ') + '</p>' : '') +
        '</section>';
    }

    // Symptoms and notes
    h += '<section><h2>Symptoms and notes</h2>';
    if (sum.symptomLabels.length) {
      h += '<p><b>' + sum.symptomCount + '</b> symptom ' + (sum.symptomCount === 1 ? 'log' : 'logs') + ' · ' +
        sum.symptomLabels.map(function (l) { return esc(l.name) + ' ' + l.count; }).join(' · ') + '</p>';
    }
    if (sum.notes.length) {
      h += '<div class="vr-scroll"><table><tr><th>Date</th><th>Type</th><th>Note</th></tr>' +
        sum.notes.map(function (n) {
          return '<tr><td>' + esc(formatDate(n.date)) + '</td><td>' + esc(n.kinds.map(label).join(', ') || 'Note') +
            (n.detail.length ? '<div class="vr-muted">' + esc(n.detail.join(', ')) + '</div>' : '') +
            '</td><td>' + esc(n.note || '') + '</td></tr>';
        }).join('') + '</table></div>';
    } else {
      h += '<p class="vr-muted">None logged in this period.</p>';
    }
    h += '</section>';

    // Every log, if asked for
    if (fullLog) {
      h += '<section class="vr-full"><h2>All logs (' + sum.logs.length + ')</h2>';
      h += sum.logs.length ? '<div class="vr-scroll"><table><tr><th>Date</th><th>Recorded</th><th>Note</th></tr>' +
        sum.logs.map(function (r) {
          var bits = [];
          if (has(r.weight)) bits.push('Weight ' + wt(r.weight));
          r.meds.forEach(function (m) { bits.push(esc(m.name) + (m.note ? ' (' + esc(m.note) + ')' : '')); });
          r.tags.forEach(function (tg) { bits.push(esc(label(tg))); });
          if (PLAY_SIZES[r.playSize]) bits.push(esc(PLAY_SIZES[r.playSize]) + ' play');
          (r.playKinds || []).concat(r.symptoms || [], r.vomitKinds || [], r.stoolKinds || []).forEach(function (l) { bits.push(esc(l)); });
          if (VET_TYPES[r.vetType]) bits.push(esc(VET_TYPES[r.vetType]) + ' visit');
          (r.readings || []).forEach(function (x) {
            var md = measureById(p, x.m);
            if (md) bits.push(esc(md.name) + ' ' + esc(fmtMeasureValue(md, x.v)) + (x.t ? ' at ' + esc(timeText(x.t)) : ''));
          });
          if (foodItemsOf(r).length) bits.push('Food: ' + esc(foodLogText(r, p)));
          if (has(r.activity)) bits.push('Activity ' + esc(r.activity) + ' min');
          if (has(r.mood)) bits.push('Mood ' + esc(r.mood) + '/5');
          if (has(r.cost)) bits.push('Cost $' + esc(r.cost));
          return '<tr><td>' + esc(formatDate(r.date)) + '</td><td>' + (bits.join('; ') || '—') + '</td><td>' + esc(r.note || '') + '</td></tr>';
        }).join('') + '</table></div>' : '<p class="vr-muted">No logs in this period.</p>';
      h += '</section>';
    }

    // Measurements (each one opt-in)
    include = include || {};
    var chosen = sum.measures.filter(function (m) { return include[sum.pet.id + ':' + m.def.id]; });
    if (chosen.length) {
      h += '<section><h2>Measurements</h2>' + chosen.map(function (m) {
        var d = m.def, line;
        var when = esc(shortDate(m.latest.date)) + (m.latest.t ? ' ' + esc(timeText(m.latest.t)) : '');
        if (d.type === 'number') {
          var range = has(d.low) || has(d.high) ? ' · normal ' + (has(d.low) ? trimNum(d.low, 3) : '') + '–' + (has(d.high) ? trimNum(d.high, 3) : '') : '';
          line = m.readings.length + (m.readings.length === 1 ? ' reading' : ' readings') +
            ' · latest <b>' + esc(fmtMeasureValue(d, m.latest.v)) + '</b> (' + when + ')' +
            ' · average ' + esc(fmtMeasureValue(d, Math.round(m.avg * 100) / 100)) +
            ' · lowest ' + esc(trimNum(m.min, 3)) + ', highest ' + esc(trimNum(m.max, 3)) + esc(range) +
            (m.above || m.below ? '<div class="vr-muted">' + (m.above ? m.above + ' above normal' : '') + (m.above && m.below ? ', ' : '') + (m.below ? m.below + ' below normal' : '') + '</div>' : '');
        } else {
          line = m.readings.length + (m.readings.length === 1 ? ' reading' : ' readings') + ' · latest <b>' + esc(m.latest.v) + '</b> (' + when + ')' +
            '<div class="vr-muted">' + m.levelCounts.map(function (l) { return esc(l.name) + ' ' + l.count; }).join(' · ') + '</div>';
        }
        return '<h3 class="vr-sub">' + esc(d.name) + (d.unit ? ' (' + esc(d.unit) + ')' : '') + '</h3><p>' + line + '</p>' + measureSparkline(m, sum.from, sum.to);
      }).join('') + '</section>';
    }

    h += '<footer class="vr-foot">Recorded by the owner in Pet Health Tracker · Created ' + esc(formatDate(today())) + '</footer>';
    return h;
  }
  // Small weight chart for the printout, drawn as SVG so it prints crisply.
  // Spaced by date, so gaps between weigh-ins show as gaps.
  // Weight over the whole period, with rows underneath marking symptoms,
  // vomiting and diarrhea, so a vet can see whether they line up with weight
  // changes. Shapes, not colors, tell the events apart so it prints in black
  // and white. Drawn as SVG so it prints crisply.
  // A small chart for one measure on the vet summary: numbers as a line with
  // the normal range shaded; levels as dots on a row per level.
  function measureSparkline(m, from, to) {
    var d = m.def;
    var W = 640, padL = 80, padR = 12, padT = 8, axisH = 20;
    var isNum = d.type === 'number';
    var levels = d.levels || [];
    var plotH = isNum ? 90 : Math.max(2, levels.length) * 16;
    var H = padT + plotH + axisH;
    var t0 = new Date(from + 'T00:00:00').getTime(), t1 = new Date(to + 'T23:59:00').getTime();
    function x(r) {
      var hm = String(r.t || '12:00').split(':');
      var t = new Date(r.date + 'T00:00:00').getTime() + ((+hm[0]) * 60 + (+hm[1] || 0)) * 60000;
      return padL + (t1 === t0 ? 0.5 : (t - t0) / (t1 - t0)) * (W - padL - padR);
    }
    var svg = '';
    if (isNum) {
      var lo = m.min, hi = m.max;
      if (has(d.low)) lo = Math.min(lo, Number(d.low));
      if (has(d.high)) hi = Math.max(hi, Number(d.high));
      if (hi === lo) { hi += 1; lo -= 1; }
      // Some space above and below, so the normal range reads as a band
      var pad = (hi - lo) * 0.15;
      hi += pad; lo -= pad;
      var y = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * plotH; };
      var ticks = [];
      if (has(d.low) || has(d.high)) {
        var top = y(has(d.high) ? Number(d.high) : hi), bottom = y(has(d.low) ? Number(d.low) : lo);
        svg += '<rect x="' + padL + '" y="' + top.toFixed(1) + '" width="' + (W - padL - padR) + '" height="' + Math.max(0, bottom - top).toFixed(1) + '" fill="#eee"/>';
        if (has(d.high)) ticks.push(Number(d.high));
        if (has(d.low)) ticks.push(Number(d.low));
      }
      // Label the normal range's edges, plus readings beyond it
      if (!has(d.high) || m.max > Number(d.high)) ticks.push(m.max);
      if (!has(d.low) || m.min < Number(d.low)) ticks.push(m.min);
      var placed = []; // skip a label that would overlap one already drawn
      ticks.filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (v) {
        var ty = y(v);
        if (placed.some(function (p) { return Math.abs(p - ty) < 12; })) return;
        placed.push(ty);
        svg += '<text x="' + (padL - 6) + '" y="' + (ty + 4).toFixed(1) + '" text-anchor="end">' + esc(trimNum(v, 3)) + '</text>';
      });
      svg += '<polyline fill="none" stroke="#222" stroke-width="1.5" points="' +
        m.readings.map(function (r) { return x(r).toFixed(1) + ',' + y(Number(r.v)).toFixed(1); }).join(' ') + '"/>';
      m.readings.forEach(function (r) { svg += '<circle cx="' + x(r).toFixed(1) + '" cy="' + y(Number(r.v)).toFixed(1) + '" r="2.5" fill="#222"/>'; });
    } else {
      levels.forEach(function (l, i) {
        var cy = padT + plotH - (i + 0.5) * (plotH / levels.length);
        svg += '<line x1="' + padL + '" y1="' + cy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + cy.toFixed(1) + '" stroke="#eee"/>' +
          '<text x="' + (padL - 6) + '" y="' + (cy + 4).toFixed(1) + '" text-anchor="end">' + esc(l) + '</text>';
      });
      m.readings.forEach(function (r) {
        var i = levels.findIndex(function (l) { return normName(l) === normName(r.v); });
        if (i < 0) return;
        var cy = padT + plotH - (i + 0.5) * (plotH / levels.length);
        svg += '<circle cx="' + x(r).toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="4" fill="#222"/>';
      });
    }
    svg += '<text x="' + padL + '" y="' + (H - 4) + '">' + esc(shortDate(from)) + '</text>' +
      '<text x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(shortDate(to)) + '</text>';
    return '<svg class="vr-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + esc(d.name) + ' over the period">' + svg + '</svg>';
  }
  function vetMeasureChoices() {
    try { return JSON.parse(localStorage.getItem('petHealth.vetMeasures') || '{}') || {}; } catch (e) { return {}; }
  }

  // What can be marked on the vet summary's weight chart (all off by default)
  var VET_MARKS = [
    { key: 'symptom', label: 'Symptom', choice: 'Symptoms', shape: 'triangle' },
    { key: 'vomit', label: 'Vomit', choice: 'Vomit', shape: 'circle' },
    { key: 'diarrhea', label: 'Diarrhea', choice: 'Diarrhea', shape: 'square' },
    { key: 'medicine', label: 'Medicine', choice: 'Medicine changes', shape: 'diamond' },
    { key: 'food', label: 'Food', choice: 'Food changes', shape: 'ring' }
  ];
  function vetMarks() {
    try { return JSON.parse(localStorage.getItem('petHealth.vetMarks') || '{}') || {}; } catch (e) { return {}; }
  }
  function weightSparkline(w, u, events, from, to, marks) {
    var LANES = VET_MARKS.filter(function (l) {
      return marks && marks[l.key] && events && events[l.key] && events[l.key].length;
    });
    var W = 640, padL = 80, padR = 12, padT = 10;
    var chartH = w ? 110 : 0, laneH = 18, axisH = 20;
    var lanesTop = padT + chartH + (w ? 10 : 0);
    var H = lanesTop + LANES.length * laneH + axisH;
    var t0 = new Date(from + 'T00:00:00').getTime(), t1 = new Date(to + 'T00:00:00').getTime();
    function x(d) { return padL + (t1 === t0 ? 0.5 : (new Date(d + 'T00:00:00').getTime() - t0) / (t1 - t0)) * (W - padL - padR); }
    var svg = '';
    // Faint dotted lines from each event up through the weight chart
    LANES.forEach(function (l, li) {
      var ly = lanesTop + li * laneH + laneH / 2;
      events[l.key].forEach(function (ev) {
        svg += '<line x1="' + x(ev.date).toFixed(1) + '" y1="' + padT + '" x2="' + x(ev.date).toFixed(1) + '" y2="' + ly.toFixed(1) + '" stroke="#bbb" stroke-width="0.8" stroke-dasharray="2 3"/>';
      });
    });
    if (w) {
      var lo = w.min, hi = w.max;
      if (hi === lo) { hi += 0.5; lo -= 0.5; }
      var y = function (v) { return padT + (1 - (v - lo) / (hi - lo)) * chartH; };
      var pts = w.points.map(function (p) { return x(p.date).toFixed(1) + ',' + y(p.value).toFixed(1); }).join(' ');
      svg +=
        '<line x1="' + padL + '" y1="' + y(w.max).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(w.max).toFixed(1) + '" stroke="#ddd"/>' +
        '<line x1="' + padL + '" y1="' + y(w.min).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + y(w.min).toFixed(1) + '" stroke="#ddd"/>' +
        '<text x="' + (padL - 6) + '" y="' + (y(w.max) + 4).toFixed(1) + '" text-anchor="end">' + esc(fmtWeight(w.max, u)) + '</text>' +
        '<text x="' + (padL - 6) + '" y="' + (y(w.min) + 4).toFixed(1) + '" text-anchor="end">' + esc(fmtWeight(w.min, u)) + '</text>' +
        '<polyline fill="none" stroke="#222" stroke-width="1.5" points="' + pts + '"/>';
    }
    // One row per kind of event
    LANES.forEach(function (l, li) {
      var cy = lanesTop + li * laneH + laneH / 2;
      svg += '<line x1="' + padL + '" y1="' + cy.toFixed(1) + '" x2="' + (W - padR) + '" y2="' + cy.toFixed(1) + '" stroke="#eee"/>' +
        '<text x="' + (padL - 6) + '" y="' + (cy + 4).toFixed(1) + '" text-anchor="end">' + l.label + '</text>';
      events[l.key].forEach(function (ev) {
        var cx = x(ev.date), X = cx.toFixed(1), Y = cy.toFixed(1);
        var tip = '<title>' + esc(shortDate(ev.date) + (ev.text ? ': ' + ev.text : '')) + '</title>';
        if (l.shape === 'circle') svg += '<circle cx="' + X + '" cy="' + Y + '" r="4.5" fill="#222">' + tip + '</circle>';
        else if (l.shape === 'ring') svg += '<circle cx="' + X + '" cy="' + Y + '" r="4.5" fill="#fff" stroke="#222" stroke-width="1.8">' + tip + '</circle>';
        else if (l.shape === 'square') svg += '<rect x="' + (cx - 4).toFixed(1) + '" y="' + (cy - 4).toFixed(1) + '" width="8" height="8" fill="#222">' + tip + '</rect>';
        else if (l.shape === 'diamond') svg += '<polygon points="' + X + ',' + (cy - 5.5).toFixed(1) + ' ' + (cx + 5.5).toFixed(1) + ',' + Y + ' ' + X + ',' + (cy + 5.5).toFixed(1) + ' ' + (cx - 5.5).toFixed(1) + ',' + Y + '" fill="#222">' + tip + '</polygon>';
        else svg += '<polygon points="' + X + ',' + (cy - 5).toFixed(1) + ' ' + (cx - 5).toFixed(1) + ',' + (cy + 4).toFixed(1) + ' ' + (cx + 5).toFixed(1) + ',' + (cy + 4).toFixed(1) + '" fill="#222">' + tip + '</polygon>';
      });
    });
    // Period dates along the bottom: the ends, plus a few in between for longer periods
    svg += '<text x="' + padL + '" y="' + (H - 4) + '">' + esc(shortDate(from)) + '</text>' +
      '<text x="' + (W - padR) + '" y="' + (H - 4) + '" text-anchor="end">' + esc(shortDate(to)) + '</text>';
    var span = dayCount(from, to);
    if (span >= 14) {
      [1, 2, 3].forEach(function (q) {
        var d = shiftDay(from, Math.round((span - 1) * q / 4));
        svg += '<line x1="' + x(d).toFixed(1) + '" y1="' + (H - axisH + 2) + '" x2="' + x(d).toFixed(1) + '" y2="' + (H - axisH + 6) + '" stroke="#999"/>' +
          '<text x="' + x(d).toFixed(1) + '" y="' + (H - 4) + '" text-anchor="middle">' + esc(shortDate(d)) + '</text>';
      });
    }
    var label = (w ? 'Weight over the period' : 'Events over the period') +
      (LANES.length ? ', with ' + LANES.map(function (l) { return l.label.toLowerCase(); }).join(', ') + ' marked' : '');
    return '<svg class="vr-chart" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + label + '">' + svg + '</svg>';
  }


  function openVetSummaryDialog() {
    var p = activePet();
    if (!p) return toast('Add a pet first');
    var lastVet = lastVetVisit(p);
    modalTitle.textContent = 'Vet summary for ' + p.name;
    modalBody.innerHTML =
      '<p class="routine-intro">A one-page summary to print or save as a PDF for your vet.</p>' +
      '<label class="field">Period<select id="vsPeriod">' +
        (lastVet ? '<option value="vet">Since last vet visit (' + esc(formatDate(lastVet)) + ')</option>' : '') +
        '<option value="30">Last 30 days</option>' +
        '<option value="90">Last 90 days</option>' +
        '<option value="custom">Choose dates…</option>' +
      '</select></label>' +
      '<div class="form-grid cols-2 vs-custom" id="vsCustom" hidden style="margin-top:10px">' +
        '<label class="field">From<input type="date" id="vsFrom"></label>' +
        '<label class="field">To<input type="date" id="vsTo"></label>' +
      '</div>' +
      '<label class="field" style="margin-top:10px">Show weights in<select id="vsUnit">' +
        '<option value="lboz">Pounds and ounces</option><option value="lb">Pounds (decimal)</option><option value="kg">Kilograms</option>' +
      '</select></label>' +
      '<label class="vs-check"><input type="checkbox" id="vsFullLog"> Also include every log at the end</label>' +
      '<p class="routine-intro" style="color:var(--muted)">Only ' + esc(p.name) + '\'s logs are included, never your sync code.</p>' +
      '<div class="form-actions"><button class="sage" id="vsCreate" type="button">Create summary</button>' +
      '<button class="ghost" id="vsCancel" type="button">Cancel</button></div>';
    $('vsPeriod').value = lastVet ? 'vet' : '90';
    $('vsUnit').value = weightUnit(); // this device's setting; changing it here only affects this summary
    $('vsFrom').value = shiftDay(today(), -89);
    $('vsTo').value = today();
    $('vsPeriod').addEventListener('change', function () { $('vsCustom').hidden = $('vsPeriod').value !== 'custom'; });
    $('vsCancel').addEventListener('click', closeModal);
    $('vsCreate').addEventListener('click', function () {
      var t = today(), from, to = t, period = $('vsPeriod').value;
      if (period === 'vet') from = lastVet;
      else if (period === '30') from = shiftDay(t, -29);
      else if (period === '90') from = shiftDay(t, -89);
      else {
        from = $('vsFrom').value; to = $('vsTo').value;
        if (!from || !to) return toast('Choose both dates');
        if (from > to) return toast('The start date is after the end date');
      }
      var unit = $('vsUnit').value;
      var fullLog = $('vsFullLog').checked;
      closeModal();
      openVetReport(p, from, to, unit, fullLog);
    });
    openModal();
  }
  function openVetReport(pet, from, to, unit, fullLog) {
    var report = $('vetReport');
    var sum = computeVetSummary(pet, from, to);
    var marks = vetMarks();
    // Only offer marks that have something to show in this period
    var offered = VET_MARKS.filter(function (l) { return sum.events[l.key].length; });
    var include = vetMeasureChoices();
    report.innerHTML =
      '<div class="vr-toolbar">' +
        (offered.length
          ? '<div class="vr-marks"><span>Mark on the weight chart:</span>' + offered.map(function (l) {
              return '<label><input type="checkbox" data-mark="' + l.key + '"' + (marks[l.key] ? ' checked' : '') + '> ' + l.choice + '</label>';
            }).join('') + '</div>'
          : '') +
        (sum.measures.length
          ? '<div class="vr-marks"><span>Include measurements:</span>' + sum.measures.map(function (m) {
              var key = pet.id + ':' + m.def.id;
              return '<label><input type="checkbox" data-include="' + esc(key) + '"' + (include[key] ? ' checked' : '') + '> ' + esc(m.def.name) + '</label>';
            }).join('') + '</div>'
          : '') +
        '<button class="sage" id="vrPrint" type="button">Print / Save as PDF</button>' +
        '<button class="secondary" id="vrClose" type="button">Close</button>' +
      '</div>' +
      '<article class="vr-page">' + renderVetReport(sum, unit, fullLog, marks, include) + '</article>';
    report.querySelectorAll('[data-mark]').forEach(function (box) {
      box.addEventListener('change', function () {
        marks[box.getAttribute('data-mark')] = box.checked;
        try { localStorage.setItem('petHealth.vetMarks', JSON.stringify(marks)); } catch (e) {}
        var top = report.scrollTop;
        report.querySelector('.vr-page').innerHTML = renderVetReport(sum, unit, fullLog, marks, include);
        report.scrollTop = top;
      });
    });
    report.querySelectorAll('[data-include]').forEach(function (box) {
      box.addEventListener('change', function () {
        include[box.getAttribute('data-include')] = box.checked;
        try { localStorage.setItem('petHealth.vetMeasures', JSON.stringify(include)); } catch (e) {}
        var top = report.scrollTop;
        report.querySelector('.vr-page').innerHTML = renderVetReport(sum, unit, fullLog, marks, include);
        report.scrollTop = top;
      });
    });
    report.hidden = false;
    report.scrollTop = 0;
    document.body.classList.add('vr-open');
    $('vrPrint').addEventListener('click', function () { window.print(); });
    $('vrClose').addEventListener('click', closeVetReport);
  }
  function closeVetReport() {
    var report = $('vetReport');
    report.hidden = true;
    report.innerHTML = '';
    document.body.classList.remove('vr-open');
  }

  // ===== COLOR THEMES =====
  // Saved per device, so each person picks their own. Colors live in the CSS
  // (:root and :root[data-theme="..."]); swatches here are just for the picker.
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'garden';
  }
  function applyTheme(id) {
    var theme = THEMES.find(function (t) { return t.id === id; }) || THEMES[0];
    if (theme.id === 'garden') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme.id);
    try { localStorage.setItem('petHealth.theme', theme.id); } catch (e) {}
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme.page); // phone status bar color
    renderChart(); // charts read their colors from the theme
  }
  function openThemePicker() {
    modalTitle.textContent = 'Color theme';
    function draw() {
      var active = currentTheme();
      modalBody.innerHTML = '<div class="theme-list">' + THEMES.map(function (t) {
        return '<button class="theme-option" type="button" data-theme-id="' + t.id + '" aria-pressed="' + (t.id === active) + '">' +
          '<span class="theme-swatch">' + t.swatch.map(function (c) { return '<i style="background:' + c + '"></i>'; }).join('') + '</span>' +
          '<span>' + t.name + '<small>' + t.about + '</small></span>' +
        '</button>';
      }).join('') + '</div>' +
      '<p class="routine-intro" style="margin:14px 0 0;color:var(--muted)">Saved on this device only.</p>';
      modalBody.querySelectorAll('[data-theme-id]').forEach(function (b) {
        b.addEventListener('click', function () { applyTheme(b.getAttribute('data-theme-id')); draw(); });
      });
    }
    draw();
    openModal();
  }

  function openMobileMenu() {
    modalTitle.textContent = 'More';
    modalBody.innerHTML =
      '<div class="menu-list">' +
        '<button class="menu-item" id="miAuth" type="button"><span class="menu-icon">☁</span>' + (syncCode ? 'Cloud sync · ' + esc(syncCode) : 'Set up cloud sync') + '</button>' +
        '<button class="menu-item" id="miAddPet" type="button"><span class="menu-icon">🐾</span>Add pet</button>' +
        '<button class="menu-item" id="miImport" type="button"><span class="menu-icon">⬆</span>Import</button>' +
        '<button class="menu-item" id="miExportCsv" type="button"><span class="menu-icon">📊</span>Export CSV</button>' +
        '<button class="menu-item" id="miExportJson" type="button"><span class="menu-icon">💾</span>Export JSON</button>' +
        '<button class="menu-item" id="miVet" type="button"><span class="menu-icon">🩺</span>Vet summary</button>' +
        '<button class="menu-item" id="miTheme" type="button"><span class="menu-icon">🎨</span>Color theme</button>' +
      '</div>';
    openModal();
    $('miAuth').addEventListener('click', function () { closeModal(); handleAuthClick(); });
    $('miTheme').addEventListener('click', function () { closeModal(); setTimeout(openThemePicker, 250); });
    $('miVet').addEventListener('click', function () { closeModal(); setTimeout(openVetSummaryDialog, 250); });
    $('miAddPet').addEventListener('click', function () { closeModal(); setTimeout(openAddPetModal, 250); });
    $('miImport').addEventListener('click', function () { closeModal(); setTimeout(openImportChooser, 250); });
    $('miExportCsv').addEventListener('click', function () { closeModal(); exportCsv(); });
    $('miExportJson').addEventListener('click', function () { closeModal(); exportJson(); });
  }

  function openModal() { modal.classList.add('open'); document.body.style.overflow = 'hidden'; }
  function closeModal() {
    // Commit any field still being typed in (e.g. a routine description) before
    // the window's contents are removed. Browsers skip "change" on removed fields.
    var active = document.activeElement;
    if (active && modal.contains(active) && active.blur) active.blur();
    modal.classList.remove('open'); document.body.style.overflow = ''; modalBody.innerHTML = ''; }

  // Re-apply panels on resize across desktop/mobile boundary
  var resizeT;
  // (window resize listener: set up in init())

  // ===== UTIL =====
  function activePet() { return state.pets.find(function (p) { return p.id === activePetId; }); }
  function petRecords() { return state.records.filter(function (r) { return r.petId === activePetId; }); }
  function load() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { pets: [], records: [] };
      return normalizeState(JSON.parse(raw));
    } catch (e) { return { pets: [], records: [] }; }
  }

  // ===== DATA SHAPE =====
  // A log holds whatever happened: weight, mood, activity minutes, cost, food,
  // any number of medicines (each with its own dose note) and event tags.
  // Older logs had a single `type` and a single `med` string; they're converted
  // on every read, so data written by an older copy of the app still loads.
  function blankRecord(petId, date) {
    return { id: uid(), v: DATA_VERSION, petId: petId, date: date, weight: '', mood: '', activity: '', cost: '', food: '', foodAmount: '', foodUnit: '', foodKcal: '', foodPresetId: '', foodUnitSize: '', foodUnitSizeUnit: '', foodItems: [], meds: [], tags: [], note: '',
      symptoms: [], playSize: '', playKinds: [], vomitKinds: [], stoolKinds: [], vetType: '', readings: [] };
  }
  // A stool log marked as diarrhea (what used to be a Diarrhea log)
  function isDiarrhea(r) {
    return hasTag(r, 'stool') && (r.stoolKinds || []).some(function (k) { return normName(k) === 'diarrhea'; });
  }
  function normalizeRecord(raw) {
    if (Number(raw && raw.v) > DATA_VERSION) newerDataSeen = true;
    var r = Object.assign({}, raw);
    ['weight', 'mood', 'activity', 'cost'].forEach(function (k) { if (r[k] == null) r[k] = ''; });
    r.food = r.food == null ? '' : String(r.food);
    r.foodAmount = r.foodAmount === '' || r.foodAmount == null ? '' : Number(r.foodAmount);
    if (r.foodAmount !== '' && (!(r.foodAmount > 0) || !isFinite(r.foodAmount))) r.foodAmount = '';
    r.foodUnit = FOOD_UNITS[r.foodUnit] ? r.foodUnit : '';
    r.foodKcal = r.foodKcal === '' || r.foodKcal == null ? '' : Number(r.foodKcal);
    if (r.foodKcal !== '' && (!(r.foodKcal > 0) || !isFinite(r.foodKcal))) r.foodKcal = '';
    r.foodPresetId = r.foodPresetId ? String(r.foodPresetId) : '';
    r.foodUnitSize = r.foodUnitSize === '' || r.foodUnitSize == null ? '' : Number(r.foodUnitSize);
    if (r.foodUnitSize !== '' && (!(r.foodUnitSize > 0) || !isFinite(r.foodUnitSize))) r.foodUnitSize = '';
    r.foodUnitSizeUnit = FOOD_UNITS[r.foodUnitSizeUnit] && FOOD_UNITS[r.foodUnitSizeUnit].kind === 'mass' ? r.foodUnitSizeUnit : '';
    // v7: food is a list. Migrate the v6 single-food fields in place, then
    // mirror the first item back to them for backward compatibility.
    if (Array.isArray(r.foodItems)) r.foodItems = r.foodItems.map(normalizeFoodItem).filter(function (x) { return x.name; });
    else r.foodItems = [];
    if (!r.foodItems.length && r.food) r.foodItems = [normalizeFoodItem({ name: r.food, amount: r.foodAmount, unit: r.foodUnit, kcal: r.foodKcal, presetId: r.foodPresetId, unitSize: r.foodUnitSize, unitSizeUnit: r.foodUnitSizeUnit })];
    syncLegacyFoodFields(r);
    r.note = r.note == null ? '' : String(r.note);
    r.meds = (Array.isArray(r.meds) ? r.meds : []).filter(function (m) { return m && m.name; }).map(function (m) {
      var out = { name: String(m.name), note: m.note == null ? '' : String(m.note) };
      if (m.at) out.at = m.at;
      return out;
    });
    if (r.med && !r.meds.length) r.meds.push({ name: String(r.med).trim(), note: '' });
    // Custom-measure readings: { m: measure id, v: number or level, t: 'HH:MM' }
    r.readings = (Array.isArray(r.readings) ? r.readings : []).filter(function (x) { return x && x.m && x.v !== '' && x.v != null; })
      .map(function (x) { var o = { m: String(x.m), v: typeof x.v === 'number' ? x.v : String(x.v) }; if (x.t) o.t = String(x.t); return o; });
    // Every field present, whether or not it was saved (cloud saves leave out empty ones)
    ['symptoms', 'playKinds', 'vomitKinds', 'stoolKinds'].forEach(function (k) {
      r[k] = Array.isArray(r[k]) ? r[k].filter(function (x) { return typeof x === 'string' && x; }) : [];
    });
    r.playSize = r.playSize ? String(r.playSize) : '';
    r.vetType = r.vetType ? String(r.vetType) : '';
    var legacy = !Array.isArray(r.tags);
    r.tags = legacy ? [] : r.tags.filter(function (t, i, a) { return typeof t === 'string' && a.indexOf(t) === i; });
    // Version 4: Diarrhea became Stool, with "Diarrhea" as the stool's label
    var wasDiarrhea = (legacy && r.type === 'diarrhea') || r.tags.indexOf('diarrhea') >= 0;
    if (legacy && r.type === 'diarrhea') r.type = 'stool';
    r.tags = r.tags.filter(function (t) { return t !== 'diarrhea'; });
    if (legacy && r.type) {
      // Event types become tags. A data type with no data behind it (e.g. an
      // "activity" log that's only a note) is kept as a tag so it stays visible.
      if (TAGS.indexOf(r.type) >= 0 || !kindsOf(r).length) r.tags.push(r.type);
    }
    if (wasDiarrhea) {
      if (r.tags.indexOf('stool') < 0) r.tags.push('stool');
      r.stoolKinds = Array.isArray(r.stoolKinds) ? r.stoolKinds.slice() : [];
      if (!r.stoolKinds.some(function (k) { return normName(k) === 'diarrhea'; })) r.stoolKinds.push('Diarrhea');
    }
    delete r.type;
    delete r.med;
    if (!(Number(r.v) > DATA_VERSION)) r.v = DATA_VERSION;
    return r;
  }
  function normalizeState(s) {
    var st = {
      pets: Array.isArray(s && s.pets) ? s.pets.filter(Boolean) : [],
      records: Array.isArray(s && s.records) ? s.records.filter(Boolean).map(normalizeRecord) : []
    };
    // Per-pet quick foods are compact configuration, not separate logs.
    st.pets.forEach(function (p) {
      p.foodPresets = (Array.isArray(p.foodPresets) ? p.foodPresets : []).filter(function (f) { return f && f.name; }).slice(0, FOOD_PRESET_LIMIT).map(normalizeFoodPreset);
      if (!Array.isArray(p.routine)) return;
      p.routine.forEach(function (it) {
        if (it && isMedItem(it) && typeof it.note !== 'string') it.note = lastMedNote(st.records, p.id, it.med);
        if (it && it.kind === 'event') {
          if (!ROUTINE_EVENTS[it.tag]) return;
          it.labels = Array.isArray(it.labels) ? it.labels.filter(function (x) { return typeof x === 'string' && x; }) : [];
          if (it.activity !== '' && it.activity != null) { it.activity = Number(it.activity); if (!(it.activity > 0) || !isFinite(it.activity)) delete it.activity; }
          if (it.playSize && !PLAY_SIZES[it.playSize]) delete it.playSize;
          if (it.vetType && !VET_TYPES[it.vetType]) delete it.vetType;
        }
        if (it && it.kind === 'food') {
          var rf = Array.isArray(it.foods) ? it.foods.map(normalizeFoodItem).filter(function (x) { return x.name; }) : [];
          if (!rf.length && it.note) rf = [normalizeFoodItem({ name: it.note, amount: it.foodAmount, unit: it.foodUnit || 'can', presetId: it.foodPresetId })];
          it.foods = rf.map(function (x) { return { name: x.name, amount: x.amount, unit: x.unit || 'can', presetId: x.presetId || '' }; });
          delete it.note; delete it.foodAmount; delete it.foodUnit; delete it.foodPresetId;
        }
      });
    });
    return st;
  }
  function has(v) { return v !== '' && v != null; }
  function hasTag(r, t) { return r.tags.indexOf(t) >= 0; }
  // What a log is about, for pills and charts: its tags plus what its data implies.
  function kindsOf(r) {
    var k = r.tags.slice();
    if (has(r.weight)) k.push('weight');
    if (r.meds.length) k.push('medication');
    if (foodItemsOf(r).length) k.push('meal');
    if (has(r.activity) && k.indexOf('activity') < 0) k.push('activity');
    if ((r.readings || []).length) k.push('measure');
    return k;
  }
  function isBlankRecord(r) {
    return !has(r.weight) && !has(r.mood) && !has(r.activity) && !has(r.cost) && !foodItemsOf(r).length && !r.meds.length && !r.tags.length && !r.note &&
      !(r.readings || []).length;
  }
  // ===== SAVING & CLOUD SYNC =====
  // Local storage is always written first, so nothing is lost if the cloud is
  // unreachable. Cloud writes are held back until this device has received the
  // latest copy of the vault, so a stale device can't overwrite newer data.
  var PENDING_KEY = 'petHealth.unsyncedChanges';
  var unsubscribe = null;      // stops the live cloud listener
  var cloudReady = false;      // true once we hold the latest cloud copy
  var writeSeq = 0;

  function writeLocal() {
    if (newerDataSeen) return; // never overwrite data from a newer app version
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save — storage full?'); }
  }
  function save() {
    if (newerDataSeen) {
      render();
      return toast('Not saved — reload the page to get the latest version first');
    }
    writeLocal();
    pushToCloud();
  }
  // Added to every cloud save. The rules require _v to be recent enough and _w
  // to differ from the last save, which copies of the app from before this
  // scheme never do, so their saves are refused.
  function writeStamp() { return { _v: DATA_VERSION, _w: uid() }; }

  // ===== CLOUD STORAGE =====
  // Logs are saved to the cloud without their empty fields (blank text, empty
  // lists, flags that are off). Loading fills them back in (normalizeRecord),
  // so nothing changes on screen. id, petId, date, v and tags always stay:
  // a log without a tags list is treated as the pre-2026 format.
  var VAULT_LIMIT_BYTES = 1048576; // Firestore's maximum document size (1 MiB)
  var VAULT_LIMIT_LOGS = 5000;     // records.size() limit in firestore.rules
  var VAULT_LIMIT_PETS = 50;       // pets.size() limit in firestore.rules
  function isEmptyValue(v) { return v === '' || v == null || v === false || (Array.isArray(v) && !v.length); }
  function compactRecord(r) {
    var out = {};
    Object.keys(r).forEach(function (k) {
      var v = r[k];
      if (k === 'meds' && Array.isArray(v)) {
        v = v.map(function (m) { var o = { name: m.name }; if (m.note) o.note = m.note; if (m.at) o.at = m.at; return o; });
      }
      if (k === 'id' || k === 'petId' || k === 'date' || k === 'v' || k === 'tags' || !isEmptyValue(v)) out[k] = v;
    });
    if (!Array.isArray(out.tags)) out.tags = [];
    return out;
  }
  function cloudRecords(records) { return records.map(compactRecord); }
  // Size of a value as Firestore counts it: strings are UTF-8 bytes + 1,
  // numbers 8, booleans and null 1, lists the sum of their items, and maps the
  // sum of each field name (as a string) plus its value.
  // UTF-8 byte length of a string (like TextEncoder, which some environments lack)
  function utf8Bytes(str) {
    var n = 0;
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF) { n += 4; i++; } // surrogate pair (e.g. emoji)
      else n += 3;
    }
    return n;
  }
  function firestoreBytes(v) {
    if (v === null || v === undefined || typeof v === 'boolean') return 1;
    if (typeof v === 'number') return 8;
    if (typeof v === 'string') return utf8Bytes(v) + 1;
    if (Array.isArray(v)) return v.reduce(function (n, x) { return n + firestoreBytes(x); }, 0);
    return Object.keys(v).reduce(function (n, k) { return n + utf8Bytes(k) + 1 + firestoreBytes(v[k]); }, 0);
  }
  // How full the cloud vault is (or would be, for the given pets and logs)
  function vaultUsage(pets, records) {
    var doc = { pets: pets, records: cloudRecords(records), _email: '', _createdAt: '2026-01-01T00:00:00.000Z', _v: DATA_VERSION, _w: 'xxxxxxxxxxxxxxxxxxxx' };
    var bytes = 7 + 9 + 16 + firestoreBytes(doc) + 32 + 260; // name + fields + overhead, with room for an email
    var byBytes = bytes / VAULT_LIMIT_BYTES, byLogs = records.length / VAULT_LIMIT_LOGS;
    return { bytes: bytes, logs: records.length, byBytes: byBytes, byLogs: byLogs, used: Math.max(byBytes, byLogs) };
  }
  // Why the cloud would refuse these pets and logs for size, or '' if it wouldn't.
  // The rules answer an oversized save with the same "permission denied" as an
  // out-of-date app, so it's checked here instead of being sent and refused.
  function vaultTooBig(pets, records) {
    if (pets.length > VAULT_LIMIT_PETS) return pets.length + ' pets; the limit is ' + VAULT_LIMIT_PETS;
    if (records.length > VAULT_LIMIT_LOGS) return records.length.toLocaleString() + ' logs; the limit is ' + VAULT_LIMIT_LOGS.toLocaleString();
    if (vaultUsage(pets, records).byBytes > 1) return 'more than 1 MB of data';
    return '';
  }
  function warnIfNearlyFull() {
    if (warnedFull || !syncCode) return;
    var u = vaultUsage(state.pets, state.records);
    if (u.used >= 0.8) {
      warnedFull = true;
      toast('Cloud storage is ' + Math.round(u.used * 100) + '% full — see Cloud sync for details');
    }
  }
  function pushToCloud() {
    if (!db || !syncCode || newerDataSeen) return;
    // Remember there are changes the cloud hasn't confirmed yet. This survives
    // the app being closed, so they're merged in next time instead of lost.
    try { localStorage.setItem(PENDING_KEY, '1'); } catch (e) {}
    if (!cloudReady) return; // sent once the latest cloud copy has arrived
    if (cloudBlocked) return; // kept on this device and merged in after a reload
    var tooBig = vaultTooBig(state.pets, state.records);
    if (tooBig) {
      // Kept on this device (and marked unsynced) until enough is removed
      reportSyncError({ code: 'resource-exhausted', detail: tooBig });
      return;
    }
    var mySeq = ++writeSeq;
    // A copy of what's being sent. If the cloud refuses it, Firestore rolls
    // this device's view back to the server's copy; this puts the changes back.
    var sent = JSON.parse(JSON.stringify({ pets: state.pets, records: state.records }));
    // merge:true keeps _email and _createdAt, which are written at code-generation time
    db.collection('vaults').doc(syncCode)
      .set(Object.assign({ pets: state.pets, records: cloudRecords(state.records) }, writeStamp()), { merge: true })
      .then(function () {
        if (mySeq === writeSeq) { try { localStorage.removeItem(PENDING_KEY); } catch (e) {} }
        warnIfNearlyFull();
      })
      .catch(function (err) {
        if (err && err.code === 'permission-denied') {
          cloudBlocked = true;
          state = mergeById(state, sent);
          writeLocal();
          try { localStorage.setItem(PENDING_KEY, '1'); } catch (e) {}
          afterRemoteChange();
        }
        reportSyncError(err);
      });
  }
  function hasPendingChanges() {
    try { return localStorage.getItem(PENDING_KEY) === '1'; } catch (e) { return false; }
  }

  // Keep this device in step with the cloud. Any change made on another device
  // arrives here within a second or two while the app is open.
  function startSync(trustLocal) {
    stopSync();
    cloudReady = !!trustLocal;
    var first = true;
    unsubscribe = db.collection('vaults').doc(syncCode).onSnapshot(function (doc) {
      // Our own write echoing back before the server confirms it — nothing new.
      if (doc.metadata.hasPendingWrites) return;
      var needsPush = false;
      if (doc.exists) {
        var remote = cleanState(doc.data());
        if (cloudBlocked) {
          // This device can't save to the cloud until it reloads. Show what
          // other devices change, but keep this device's unsent changes too.
          state = mergeById(remote, state);
        } else if (first && !cloudReady && hasPendingChanges()) {
          // Changes made on this device never reached the cloud (e.g. edited
          // offline, then the app was closed). Keep both sides.
          state = mergeById(remote, state);
          needsPush = true;
        } else {
          state = remote;
        }
        writeLocal();
      } else if (first && hasRealData()) {
        // Vault doesn't exist yet — upload what's on this device.
        needsPush = true;
      }
      cloudReady = true;
      first = false;
      if (needsPush) pushToCloud();
      else if (doc.exists && !cloudBlocked) { try { localStorage.removeItem(PENDING_KEY); } catch (e) {} }
      afterRemoteChange();
    }, function (err) {
      reportSyncError(err);
    });
  }
  function stopSync() {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
    cloudReady = false;
  }
  function afterRemoteChange() {
    if (!state.pets.some(function (p) { return p.id === activePetId; })) {
      activePetId = state.pets[0] ? state.pets[0].id : null;
    }
    // If the log being edited was deleted on another device, drop the edit.
    if (editingLogId && !state.records.some(function (r) { return r.id === editingLogId; })) {
      clearRecordForm();
    }
    render();
  }
  function cleanState(d) { return normalizeState(d); }
  // Combine two copies, keeping every pet and log from both. Where both have
  // the same item, this device's version wins.
  function mergeById(remote, local) {
    function merge(a, b, combine) {
      var byId = {};
      var order = [];
      a.concat(b).forEach(function (item) {
        if (!item || !item.id) return;
        if (!(item.id in byId)) { order.push(item.id); byId[item.id] = item; }
        else byId[item.id] = combine ? combine(byId[item.id], item) : item;
      });
      return order.map(function (id) { return byId[id]; });
    }
    return { pets: merge(remote.pets, local.pets), records: merge(remote.records, local.records, mergeRecord) };
  }
  // The same log changed on two devices (e.g. both added to today's routine
  // log while one was offline). Keep everything from both: every medicine and
  // tag, and any field that one side left empty takes the other side's value.
  function mergeRecord(remote, local) {
    var out = Object.assign({}, remote, local);
    ['weight', 'mood', 'activity', 'cost', 'note'].forEach(function (k) {
      if (!has(local[k]) && has(remote[k])) out[k] = remote[k];
    });
    var mergedFoods = [], foodSeen = {};
    foodItemsOf(local).concat(foodItemsOf(remote)).forEach(function (f) {
      var key = [normName(f.name), f.amount, f.unit, f.kcal, f.unitSize, f.unitSizeUnit].join('|');
      if (foodSeen[key]) return;
      foodSeen[key] = true;
      mergedFoods.push(f);
    });
    setRecordFoodItems(out, mergedFoods);
    function medKey(m) { return (m.at || '') + '|' + normName(m.name); }
    var seen = {};
    out.meds = remote.meds.concat(local.meds).filter(function (m) {
      var k = medKey(m);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    });
    out.tags = remote.tags.concat(local.tags).filter(function (t, i, all) { return all.indexOf(t) === i; });
    function union(a, b) {
      var seen = {};
      return (a || []).concat(b || []).filter(function (x) { var k = normName(x); if (seen[k]) return false; seen[k] = true; return true; });
    }
    out.symptoms = union(remote.symptoms, local.symptoms);
    out.playKinds = union(remote.playKinds, local.playKinds);
    out.vomitKinds = union(remote.vomitKinds, local.vomitKinds);
    out.stoolKinds = union(remote.stoolKinds, local.stoolKinds);
    out.readings = uniqueReadings((remote.readings || []).concat(local.readings || []));
    if (!local.playSize && remote.playSize) out.playSize = remote.playSize;
    if (!local.vetType && remote.vetType) out.vetType = remote.vetType;
    return out;
  }
  // True if this device holds anything besides the untouched demo data.
  function hasRealData() {
    return state.pets.some(function (p) { return !p.sample; }) ||
           state.records.some(function (r) { return !r.sample; });
  }

  // Reports failed cloud writes. Throttled so rapid edits don't stack up a
  // toast per save. Local data is always saved first.
  var lastSyncErrorAt = 0;
  function reportSyncError(err) {
    var now = Date.now();
    if (now - lastSyncErrorAt < 30000) return;
    lastSyncErrorAt = now;
    var code = err && err.code;
    if (code === 'permission-denied') {
      // Most likely this copy of the app is out of date and the rules now
      // require a newer one. Reloading fixes that; unsent changes are merged in.
      showUpdateNotice('Your changes are saved on this device but couldn\'t sync. Reload to get the latest version of the app.');
      checkForUpdate(true);
    } else if (code === 'invalid-argument' || code === 'resource-exhausted') {
      toast('Cloud vault is full' + (err.detail ? ' (' + err.detail + ')' : '') + ' — your data is still saved on this device');
    } else {
      toast('Cloud sync failed — your data is still saved on this device');
    }
  }

  // Demo pet for a first visit. Marked `sample` so it's never mistaken for real
  // data: it isn't uploaded to a new vault and doesn't block loading a code.
  function seed() {
    var p = { id: uid(), name: 'Felix', icon: '🐱', species: 'Cat', breed: 'Tuxedo', birthday: '2020-04-18', sample: true };
    function r(date, fields) {
      return Object.assign(blankRecord(p.id, date), { sample: true }, fields);
    }
    state = {
      pets: [p],
      records: [
        r('2026-04-12', { tags: ['vomit'], mood: 2, note: 'Once in the morning, hairball.' }),
        r('2026-04-19', { tags: ['stool'], stoolKinds: ['Diarrhea'], mood: 2, food: 'New kibble', note: 'Started after switching brands.' }),
        r('2026-04-21', { tags: ['vomit'], mood: 3, note: 'Ate too fast at dinner.' }),
        r('2026-04-26', { weight: 12.0, mood: 4, activity: 12, note: 'Normal appetite, playful.' }),
        r('2026-04-28', { mood: 3, activity: 5, meds: [{ name: 'Antibiotic', note: '1 tablet with food' }], note: 'No side effects observed.' }),
        r('2026-05-01', { tags: ['symptom'], mood: 3, activity: 8, note: 'Light sneezing during morning.' })
      ]
    };
    writeLocal();
  }
  function handleAuthClick() { openSyncModal(); }
  // "Cloud storage: 9% used", with a bar and the details
  function storageMeterHtml() {
    var u = vaultUsage(state.pets, state.records);
    var pct = Math.max(1, Math.round(u.used * 100));
    var full = u.used >= 0.8;
    return '<div class="storage-meter' + (full ? ' full' : '') + '">' +
      '<div class="storage-head"><span>Cloud storage</span><b>' + pct + '% used</b></div>' +
      '<div class="storage-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '"><i style="width:' + Math.min(100, pct) + '%"></i></div>' +
      '<div class="storage-detail">' + Math.round(u.bytes / 1024) + ' KB of 1 MB · ' + u.logs.toLocaleString() + ' of ' + VAULT_LIMIT_LOGS.toLocaleString() + ' logs</div>' +
      (full ? '<div class="storage-detail">Getting full. Export a backup; older logs will need archiving soon.</div>' : '') +
    '</div>';
  }
  function openSyncModal() {
    modalTitle.textContent = 'Cloud Sync';
    if (syncCode) {
      modalBody.innerHTML =
        '<p style="font-size:13px;color:var(--ink-2);margin:0 0 14px">Your sync code — enter this on any other device to load your data. Keep it somewhere safe.</p>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px">' +
          '<code style="font-family:monospace;font-size:26px;font-weight:700;letter-spacing:.18em;background:var(--bg);border:1px solid var(--line);border-radius:var(--radius-sm);padding:10px 14px;flex:1;text-align:center">' + esc(syncCode) + '</code>' +
          '<button id="msCopy" class="secondary" type="button" style="flex-shrink:0;min-height:44px">Copy</button>' +
        '</div>' +
        storageMeterHtml() +
        '<label class="field" style="margin-bottom:12px">Add or update email<input type="email" id="msEmailUpdate" placeholder="you@example.com" autocomplete="email"></label>' +
        '<button id="msSaveEmail" class="secondary" type="button" style="width:100%;margin-bottom:10px">Save email</button>' +
        '<button id="msDisconnect" class="ghost" type="button" style="width:100%;color:var(--danger)">Disconnect this device</button>';
      openModal();
      $('msCopy').addEventListener('click', function () {
        if (navigator.clipboard) {
          navigator.clipboard.writeText(syncCode).then(function () { toast('Code copied!'); });
        } else {
          toast(syncCode);
        }
      });
      $('msSaveEmail').addEventListener('click', function () {
        var email = ($('msEmailUpdate').value || '').trim().toLowerCase();
        if (!email) return toast('Please enter an email address');
        if (db) {
          db.collection('vaults').doc(syncCode).set(Object.assign({ _email: email }, writeStamp()), { merge: true })
            .then(function () { toast('Email saved ☁'); $('msEmailUpdate').value = ''; })
            .catch(function (err) {
              if (err && err.code === 'permission-denied') return reportSyncError(err);
              toast('Could not save email');
            });
        }
      });
      $('msDisconnect').addEventListener('click', function () {
        if (!confirm('Disconnect cloud sync on this device? Your local data is not deleted.')) return;
        stopSync();
        syncCode = null;
        try { localStorage.removeItem(SYNC_CODE_KEY); } catch (e) {}
        try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
        renderAuthBtn();
        closeModal();
        toast('Cloud sync disconnected');
      });
    } else {
      modalBody.innerHTML =
        '<p style="font-size:13px;color:var(--ink-2);margin:0 0 16px">Sync your data across devices — no account needed. Save your code somewhere safe; it\'s the only way to access your data from another device.</p>' +
        '<label class="field" style="margin-bottom:12px">Email (optional — saved with your vault, and readable by anyone with the code)<input type="email" id="msEmail" placeholder="you@example.com" autocomplete="email"></label>' +
        '<button id="msGenerate" class="sage" type="button" style="width:100%;margin-bottom:16px">Generate a new code</button>' +
        '<p style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin:0 0 6px">Already have a code?</p>' +
        '<div style="display:flex;gap:8px">' +
          '<input id="msExisting" placeholder="XXXXXXXX" maxlength="8" style="flex:1;font-family:monospace;font-size:18px;text-transform:uppercase;letter-spacing:.12em">' +
          '<button id="msLoad" class="secondary" type="button" style="flex-shrink:0;min-height:44px">Load</button>' +
        '</div>';
      openModal();
      $('msGenerate').addEventListener('click', function () {
        if (!db) return toast('Cloud sync is unavailable right now');
        var code = genCode();
        var email = ($('msEmail').value || '').trim().toLowerCase();
        // Start the new vault with this device's data — but not the demo pet.
        if (!hasRealData()) {
          state = { pets: [], records: [] };
          writeLocal();
          activePetId = null;
          render();
        }
        syncCode = code;
        storageSet(SYNC_CODE_KEY, code);
        var doc = Object.assign({ pets: state.pets, records: cloudRecords(state.records), _email: email, _createdAt: new Date().toISOString() }, writeStamp());
        db.collection('vaults').doc(code).set(doc).catch(reportSyncError);
        startSync(true); // this device's copy is the vault's starting point
        renderAuthBtn();
        closeModal();
        setTimeout(openSyncModal, 200);
      });
      $('msLoad').addEventListener('click', function () {
        var entered = ($('msExisting').value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (entered.length !== 8) return toast('Code must be exactly 8 characters');
        // Codes never contain 0, 1, I or O — catch typos before they reach the server
        if (!/^[A-HJ-NP-Z2-9]{8}$/.test(entered)) return toast('That code has an invalid character — codes never use 0, 1, I or O');
        if (!db) return toast('Cloud sync is unavailable right now');
        var loadBtn = $('msLoad');
        loadBtn.disabled = true;
        loadBtn.textContent = 'Checking…';
        db.collection('vaults').doc(entered).get().then(function (doc) {
          loadBtn.disabled = false;
          loadBtn.textContent = 'Load';
          // A mistyped code must not quietly create a new vault.
          if (!doc.exists) return toast('No vault found with that code — check it and try again');
          var remote = cleanState(doc.data());
          if (hasRealData() && !confirm(
            'Replace the data on this device with the data saved under ' + entered + '?\n\n' +
            'This device: ' + state.pets.length + ' pet(s), ' + state.records.length + ' log(s)\n' +
            'Cloud vault: ' + remote.pets.length + ' pet(s), ' + remote.records.length + ' log(s)\n\n' +
            'To keep this device\'s data, cancel and use Export JSON first.'
          )) return;
          syncCode = entered;
          storageSet(SYNC_CODE_KEY, entered);
          try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
          state = remote;
          writeLocal();
          activePetId = null;
          afterRemoteChange();
          startSync(false);
          renderAuthBtn();
          closeModal();
          toast('Data loaded ☁');
        }).catch(function () {
          loadBtn.disabled = false;
          loadBtn.textContent = 'Load';
          toast('Could not reach the cloud — check your connection and try again');
        });
      });
    }
  }
  function renderAuthBtn() {
    var btn = $('authBtn');
    if (!btn) return;
    if (syncCode) {
      btn.textContent = '☁ ' + syncCode;
      btn.title = 'Cloud sync active — click to manage';
    } else {
      btn.textContent = '☁ Cloud sync';
      btn.title = 'Set up sync across devices';
    }
  }
  function genCode() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no ambiguous 0/O/1/I
    var arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(function (b) { return chars[b % 32]; }).join('');
  }
  function uid() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
  // Dates are the device's local calendar day. toISOString() and valueAsDate use
  // UTC, which in the US evening is already tomorrow.
  function localDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function today() { return localDate(new Date()); }
  function num(v) { return v === '' || v == null ? '' : Number(v); }
  function byDate(a, b) { return String(a.date).localeCompare(String(b.date)); }
  function avg(a) { return a.reduce(function (x, y) { return x + y; }, 0) / a.length; }
  function label(t) {
    return ({
      weight: 'Weight', food: 'Food intake', meal: 'Meal', medication: 'Medication',
      activity: 'Activity', symptom: 'Symptom', vet: 'Vet visit', measure: 'Measurement',
      vomit: 'Vomit', diarrhea: 'Diarrhea', stool: 'Stool',
      mood: 'Mood', cost: 'Cost', types: 'Types'
    })[t] || t;
  }
  function age(b) {
    if (!b) return '';
    var ms = Date.now() - new Date(b).getTime();
    if (isNaN(ms) || ms < 0) return '';
    var y = ms / 31557600000;
    return ' · ' + (y < 1 ? Math.max(1, Math.round(y * 12)) + ' mo' : y.toFixed(1) + ' yr');
  }
  function formatDate(d) {
    if (!d) return '';
    try {
      var dt = new Date(d + 'T00:00:00');
      return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) { return d; }
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (m) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[m];
    });
  }
  // localStorage can throw (storage blocked, some private modes). These never do.
  function storageGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function storageSet(key, value) { try { localStorage.setItem(key, value); } catch (e) {} }
  var toastT;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(function () { t.classList.remove('show'); }, 1800);
  }
  function download(name, text, type) {
    var blob = new Blob([text], { type: type });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  }

  // ===== START-UP =====
  // Everything that runs when the app opens is in init(), which is called on
  // the very last line. By then every setting and function above has been
  // defined, wherever it sits in the file. Add new start-up steps here, never
  // as loose statements elsewhere: that's what caused "used before it's set"
  // bugs in the past.
  function init() {
    isMobileLayout = window.matchMedia('(max-width: 720px)').matches;
    syncCode = storageGet(SYNC_CODE_KEY) || null;
    try {
      firebase.initializeApp({
        apiKey: 'AIzaSyBcKEqOQT5LbxdZwIk9JoIxEU0retR5Yew',
        projectId: 'pet-tracker-28832',
        appId: '1:915436677489:web:9dd0b41b60e7be37c96ed0'
      });
      db = firebase.firestore();
    } catch (e) { console.warn('Firebase init failed:', e); }

    state = load();
    activePetId = state.pets[0] ? state.pets[0].id : null;
    chart = null;
    editingLogId = null;
    // Checklist text typed but not logged yet, kept across redraws.
    routineDrafts = {};

    // ===== DOM HELPERS =====
    $ = function (id) { return document.getElementById(id); };
    modal = $('modal');
    modalBody = $('modalBody');
    modalTitle = $('modalTitle');

    // Initialize date input to today
    $('rDate').value = today();

    // ===== EVENT LISTENERS =====
    $('authBtn').addEventListener('click', handleAuthClick);
    $('recordForm').addEventListener('submit', handleRecordSubmit);
    $('clearForm').addEventListener('click', clearRecordForm);
    $('appendBtn').addEventListener('click', appendToLastLog);
    $('addMeasureBtn').addEventListener('click', function () { openMeasureEditor(null); });
    $('manageFoodsBtn').addEventListener('click', openFoodManager);
    $('addFoodRow').addEventListener('click', function () { addFoodRow({}, true); });
    renderFoodRows([]);
    $('rDate').addEventListener('change', renderAppendHint);
    $('addMedRow').addEventListener('click', function () { addMedRow('', '').querySelector('.med-name').focus(); });
    $('starWeight').addEventListener('click', function () { toggleRoutine(formPet(), { kind: 'weight' }); });
    $('starFood').addEventListener('click', function () { toggleRoutine(formPet(), { kind: 'food', foods: readFoodRows(false) || [] }); });
    $('starMood').addEventListener('click', function () { toggleRoutine(formPet(), { kind: 'mood' }); });
    $('weightUnit').addEventListener('change', function () { setWeightUnit($('weightUnit').value); });
    applyWeightUnitToForm();
    $('rTags').querySelectorAll('.tag-chip').forEach(function (b) {
      b.addEventListener('click', function () {
        b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true');
        renderLabelPanel();
      });
    });
    $('rTags').querySelectorAll('[data-routine-tag]').forEach(function (b) {
      b.addEventListener('click', function () {
        var tag = b.getAttribute('data-routine-tag');
        var cfg = ROUTINE_EVENTS[tag] || {};
        var labels = cfg.labelKind ? (formLabels[cfg.labelKind] || []).slice() : [];
        toggleRoutine(formPet(), { kind: 'event', tag: tag, labels: labels,
          playSize: tag === 'activity' ? formPlaySize : '',
          vetType: tag === 'vet' ? formVetType : '',
          activity: tag === 'activity' ? $('rActivity').value : '' });
      });
    });
    $('chartMode').addEventListener('change', renderChart);
    try {
      var savedFoodUnit = localStorage.getItem('petHealth.foodChartUnit');
      if (savedFoodUnit && $('foodChartUnit').querySelector('option[value="' + savedFoodUnit + '"]')) $('foodChartUnit').value = savedFoodUnit;
    } catch (e) {}
    $('foodChartUnit').addEventListener('change', function () {
      try { localStorage.setItem('petHealth.foodChartUnit', $('foodChartUnit').value); } catch (e) {}
      renderChart();
    });
    try { var savedRange = localStorage.getItem('petHealth.chartRange'); if (savedRange) $('chartRange').value = savedRange; } catch (e) {}
    $('chartRange').addEventListener('change', function () {
      try { localStorage.setItem('petHealth.chartRange', $('chartRange').value); } catch (e) {}
      renderChart();
    });
    $('search').addEventListener('input', renderRecords);
    $('exportCsvBtn').addEventListener('click', exportCsv);
    $('exportJsonBtn').addEventListener('click', exportJson);
    $('themeBtn').addEventListener('click', openThemePicker);
    $('importBtn').addEventListener('click', openImportChooser);
    $('csvInput').addEventListener('change', handleCsvImport);
    $('fileInput').addEventListener('change', handleImport);
    $('modalClose').addEventListener('click', closeModal);
    modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
      else if (e.key === 'Escape' && !$('vetReport').hidden) closeVetReport();
    });

    // Mobile bottom nav
    document.querySelectorAll('.mobile-nav button').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.tab, true); });
    });
    $('mobileFab').addEventListener('click', openMobileMenu);

    // ===== INITIAL RENDER =====
    applyMobileTab(); // default tab on mobile
    // Only show the demo pet on a genuine first visit. Never on a device linked to
    // a vault, and never again after the user deletes their last pet.
    firstVisit = storageGet(STORAGE_KEY) === null;
    if (firstVisit && !syncCode) seed();
    activePetId = state.pets[0] ? state.pets[0].id : null;
    renderAuthBtn();
    render();

    // Keep this device in step with the cloud if it's linked to a vault
    if (db && syncCode) startSync(false);

    startTheme = THEMES.find(function (t) { return t.id === currentTheme(); });
    if (startTheme) document.querySelector('meta[name="theme-color"]').setAttribute('content', startTheme.page);

    checkForUpdate(true);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') checkForUpdate(false);
    });

    window.addEventListener('resize', function () {
      clearTimeout(resizeT);
      resizeT = setTimeout(applyMobileTab, 150);
    });
  }

  init();

})();

/* 
  Arbeitszeiterfassung (Lehrkräfte) – reine Client‑Side App
  - Speichert Daten in localStorage (kein Server, DSGVO‑freundlich lokal)
  - PWA‑fähig via manifest + Service Worker
  - Features: Start/Stop, Kategorien, Notiz, Filter, Summen, CSV Export, Backup
*/

const LS_KEYS = {
  entries: 'tt_entries_v1',
  categories: 'tt_categories_v1',
  state: 'tt_state_v1',
  settings: 'tt_settings_v1'
};

const DEFAULT_CATEGORIES = [
  'Unterricht',
  'Vor-/Nachbereitung',
  'Korrekturen',
  'Konferenzen',
  'Pausenaufsicht',
  'Elternkontakte',
  'Fortbildung',
  'Sonstiges'
];

let entries = load(LS_KEYS.entries, []);
let categories = load(LS_KEYS.categories, DEFAULT_CATEGORIES);
let state = load(LS_KEYS.state, { running:false, startTime:null, category:categories[0] || 'Sonstiges', note:'' });
let settings = load(LS_KEYS.settings, { rounding5:false });

/** Hilfsfunktionen **/
function save(key, value){ localStorage.setItem(key, JSON.stringify(value)); }
function load(key, fallback){ try{ return JSON.parse(localStorage.getItem(key)) ?? fallback; }catch{ return fallback; } }
function pad(n){ return String(n).padStart(2,'0'); }
function msToHMS(ms){
  const s = Math.floor(ms/1000);
  const hh = Math.floor(s/3600);
  const mm = Math.floor((s%3600)/60);
  const ss = s%60;
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}`;
}
function msToHM(ms){
  const s = Math.floor(ms/1000);
  const hh = Math.floor(s/3600);
  const mm = Math.floor((s%3600)/60);
  return `${pad(hh)}:${pad(mm)}`;
}
function parseDateInput(value){ return value ? new Date(value + 'T00:00:00') : null; }
function dateISO(d){ const z = new Date(d); z.setMinutes(z.getMinutes() - z.getTimezoneOffset()); return z.toISOString(); }
function formatDateTime(d){
  const dd = new Date(d);
  return dd.toLocaleString(undefined, { dateStyle:'medium', timeStyle:'short' });
}
function sameDay(a,b){
  const da = new Date(a), db = new Date(b);
  return da.getFullYear()===db.getFullYear() && da.getMonth()===db.getMonth() && da.getDate()===db.getDate();
}
function roundTo5Minutes(ms){
  const five = 5*60*1000;
  return Math.round(ms / five) * five;
}

/** DOM Referenzen **/
const categorySelect = document.getElementById('categorySelect');
const addCategoryBtn = document.getElementById('addCategoryBtn');
const noteInput = document.getElementById('noteInput');
const timerDisplay = document.getElementById('timerDisplay');
const timerSince = document.getElementById('timerSince');
const toggleTimerBtn = document.getElementById('toggleTimerBtn');
const todayTotalEl = document.getElementById('todayTotal');

const fromDate = document.getElementById('fromDate');
const toDate = document.getElementById('toDate');
const filterCategory = document.getElementById('filterCategory');
const applyFiltersBtn = document.getElementById('applyFiltersBtn');
const clearFiltersBtn = document.getElementById('clearFiltersBtn');
const exportCsvBtn = document.getElementById('exportCsvBtn');

const rounding5 = document.getElementById('rounding5');
const backupBtn = document.getElementById('backupBtn');
const restoreFile = document.getElementById('restoreFile');

const summaryEl = document.getElementById('summary');
const entriesEl = document.getElementById('entries');

const installBtn = document.getElementById('installBtn');

let tickInterval = null;
let deferredPrompt = null;

/** Init **/
init();

function init(){
  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installBtn.classList.remove('hidden');
  });
  installBtn?.addEventListener('click', async () => {
    installBtn.classList.add('hidden');
    if(deferredPrompt){
      deferredPrompt.prompt();
      await deferredPrompt.userChoice;
      deferredPrompt = null;
    }
  });

  // Service Worker registrieren (falls unterstützt)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(console.warn);
  }

  // UI laden
  renderCategories();
  renderFilterCategories();
  rounding5.checked = !!settings.rounding5;
  rounding5.addEventListener('change', () => {
    settings.rounding5 = rounding5.checked;
    save(LS_KEYS.settings, settings);
    render(); // Summen können sich ändern
  });

  addCategoryBtn.addEventListener('click', onAddCategory);
  toggleTimerBtn.addEventListener('click', onToggleTimer);

  applyFiltersBtn.addEventListener('click', render);
  clearFiltersBtn.addEventListener('click', () => {
    fromDate.value = '';
    toDate.value = '';
    filterCategory.value = '';
    render();
  });

  exportCsvBtn.addEventListener('click', exportCSV);

  backupBtn.addEventListener('click', makeBackup);
  restoreFile.addEventListener('change', onRestore);

  // Timer Zustand
  categorySelect.value = state.category || categories[0] || 'Sonstiges';
  noteInput.value = state.note || '';

  if(state.running && state.startTime){
    startTick();
    toggleTimerBtn.textContent = 'Stop';
    toggleTimerBtn.classList.add('danger');
    timerSince.textContent = 'seit ' + new Date(state.startTime).toLocaleTimeString();
  }else{
    updateTimerDisplay(0);
    timerSince.textContent = '';
  }

  render();
}

function renderCategories(){
  categorySelect.innerHTML = '';
  categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    categorySelect.append(opt);
  });
}

function renderFilterCategories(){
  filterCategory.innerHTML = '';
  const all = document.createElement('option');
  all.value = ''; all.textContent = 'Alle Kategorien';
  filterCategory.append(all);
  categories.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    filterCategory.append(opt);
  });
}

function onAddCategory(){
  const name = prompt('Neue Kategorie:');
  if(!name) return;
  const trimmed = name.trim();
  if(!trimmed) return;
  if(categories.includes(trimmed)) { alert('Kategorie existiert bereits.'); return; }
  categories.push(trimmed);
  save(LS_KEYS.categories, categories);
  renderCategories();
  renderFilterCategories();
  categorySelect.value = trimmed;
}

function onToggleTimer(){
  if(!state.running){
    // Start
    state.running = true;
    state.startTime = new Date().toISOString();
    state.category = categorySelect.value;
    state.note = noteInput.value.trim();
    save(LS_KEYS.state, state);

    toggleTimerBtn.textContent = 'Stop';
    toggleTimerBtn.classList.add('danger');
    timerSince.textContent = 'seit ' + new Date(state.startTime).toLocaleTimeString();
    startTick();
  }else{
    // Stop
    const start = new Date(state.startTime);
    const end = new Date();
    let duration = end - start;
    if(settings.rounding5) duration = roundTo5Minutes(duration);

    const entry = {
      id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()),
      start: start.toISOString(),
      end: new Date(start.getTime() + duration).toISOString(), // falls gerundet
      durationMs: duration,
      category: state.category || categorySelect.value,
      note: state.note || noteInput.value.trim()
    };
    entries.push(entry);
    save(LS_KEYS.entries, entries);

    // Reset Timer
    state = { running:false, startTime:null, category:categorySelect.value, note:noteInput.value.trim() };
    save(LS_KEYS.state, state);

    stopTick();
    toggleTimerBtn.textContent = 'Start';
    toggleTimerBtn.classList.remove('danger');
    updateTimerDisplay(0);
    timerSince.textContent = '';

    render();
  }
}

function startTick(){
  stopTick();
  tickInterval = setInterval(() => {
    if(state.running && state.startTime){
      const elapsed = Date.now() - new Date(state.startTime).getTime();
      updateTimerDisplay(elapsed);
    }
  }, 500);
}
function stopTick(){
  if(tickInterval){ clearInterval(tickInterval); tickInterval = null; }
}
function updateTimerDisplay(ms){
  timerDisplay.textContent = msToHMS(ms);
}

/** Rendering der Übersicht & Summen **/
function render(){
  // Tagesgesamt
  const today = new Date();
  const todaySum = entries
    .filter(e => sameDay(e.start, today))
    .reduce((acc,e) => acc + e.durationMs, 0);
  todayTotalEl.textContent = msToHM(todaySum);

  // Filter anwenden
  const fFrom = parseDateInput(fromDate.value);
  const fTo = parseDateInput(toDate.value);
  let filtered = [...entries];
  if(fFrom) filtered = filtered.filter(e => new Date(e.start) >= fFrom);
  if(fTo) {
    // Bis einschließlich fTo
    const toEnd = new Date(fTo); toEnd.setDate(toEnd.getDate() + 1);
    filtered = filtered.filter(e => new Date(e.start) < toEnd);
  }
  if(filterCategory.value) filtered = filtered.filter(e => e.category === filterCategory.value);

  // Sort absteigend
  filtered.sort((a,b) => new Date(b.start) - new Date(a.start));

  // Summary nach Kategorie
  const byCat = {};
  filtered.forEach(e => {
    byCat[e.category] = (byCat[e.category] || 0) + e.durationMs;
  });
  renderSummary(byCat);

  // Einträge
  renderEntries(filtered);
}

function renderSummary(byCat){
  summaryEl.innerHTML = '';
  const total = Object.values(byCat).reduce((a,b)=>a+b,0);
  const wrap = document.createElement('div');
  wrap.className = 'summary-grid';
  Object.entries(byCat).sort((a,b)=>b[1]-a[1]).forEach(([cat, ms])=>{
    const catEl = document.createElement('div');
    catEl.className = 'cat';
    catEl.textContent = cat;
    const durEl = document.createElement('div');
    durEl.className = 'dur';
    durEl.textContent = msToHM(ms);
    wrap.append(catEl, durEl);
  });
  const sep = document.createElement('div'); sep.style.borderTop = '1px solid var(--border)'; sep.style.gridColumn='1/-1'; sep.style.margin='.3rem 0';
  const totalLabel = document.createElement('div'); totalLabel.innerHTML = '<strong>Summe</strong>';
  const totalDur = document.createElement('div'); totalDur.innerHTML = `<strong>${msToHM(total)}</strong>`;
  summaryEl.append(wrap, sep, totalLabel, totalDur);
}

function renderEntries(list){
  entriesEl.innerHTML = '';
  if(list.length===0){
    const empty = document.createElement('div');
    empty.className = 'info';
    empty.textContent = 'Keine Einträge im gewählten Zeitraum.';
    entriesEl.append(empty);
    return;
  }
  list.forEach(e=>{
    const div = document.createElement('div');
    div.className = 'entry';
    const title = document.createElement('div');
    title.innerHTML = `<span class="badge">${e.category}</span>`;
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.innerHTML = `
      <span>Start: ${formatDateTime(e.start)}</span>
      <span>Ende: ${formatDateTime(e.end)}</span>
      <span>Dauer: <strong>${msToHM(e.durationMs)}</strong></span>
    `;
    const note = document.createElement('div');
    note.textContent = e.note || '';
    note.className = 'note';

    const actions = document.createElement('div');
    actions.className = 'actions';
    const editBtn = document.createElement('button');
    editBtn.className = 'secondary';
    editBtn.textContent = 'Bearbeiten';
    editBtn.addEventListener('click', ()=> editEntry(e.id));

    const delBtn = document.createElement('button');
    delBtn.className = 'secondary';
    delBtn.textContent = 'Löschen';
    delBtn.addEventListener('click', ()=> deleteEntry(e.id));

    actions.append(editBtn, delBtn);
    div.append(title, meta, note, actions);
    entriesEl.append(div);
  });
}

function editEntry(id){
  const e = entries.find(x=>x.id===id);
  if(!e) return;
  const newStart = prompt('Start (ISO, z. B. 2026-01-28T07:45)', e.start.slice(0,16));
  if(!newStart) return;
  const newEnd = prompt('Ende (ISO, z. B. 2026-01-28T08:30)', e.end.slice(0,16));
  if(!newEnd) return;
  const newCat = prompt('Kategorie', e.category) || e.category;
  const newNote = prompt('Notiz', e.note || '') ?? e.note;

  const s = new Date(newStart);
  const ed = new Date(newEnd);
  if(isNaN(s) || isNaN(ed) || ed <= s){ alert('Ungültige Zeiten.'); return; }

  e.start = s.toISOString();
  e.end = ed.toISOString();
  e.durationMs = ed - s;
  e.category = newCat.trim() || e.category;
  e.note = (newNote ?? '').trim();

  save(LS_KEYS.entries, entries);
  render();
}

function deleteEntry(id){
  if(!confirm('Eintrag wirklich löschen?')) return;
  entries = entries.filter(x=>x.id!==id);
  save(LS_KEYS.entries, entries);
  render();
}

/** Export / Backup **/
function exportCSV(){
  // Aktuelle Filter berücksichtigen
  const fFrom = parseDateInput(fromDate.value);
  const fTo = parseDateInput(toDate.value);
  let list = [...entries];
  if(fFrom) list = list.filter(e => new Date(e.start) >= fFrom);
  if(fTo) { const toEnd = new Date(fTo); toEnd.setDate(toEnd.getDate() + 1); list = list.filter(e => new Date(e.start) < toEnd); }
  if(filterCategory.value) list = list.filter(e => e.category === filterCategory.value);

  const lines = [
    ['ID','Start','Ende','Dauer (hh:mm)','Dauer (Min)','Kategorie','Notiz'].join(';')
  ];
  list.forEach(e=>{
    const mins = Math.round(e.durationMs/60000);
    lines.push([
      e.id,
      new Date(e.start).toISOString(),
      new Date(e.end).toISOString(),
      msToHM(e.durationMs),
      mins,
      e.category.replaceAll(';', ','),
      (e.note||'').replaceAll('\n',' ').replaceAll(';', ',')
    ].join(';'));
  });
  const blob = new Blob([lines.join('\n')], {type:'text/csv;charset=utf-8;'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `arbeitszeit_${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function makeBackup(){
  const data = {
    entries, categories, state, settings,
    exportedAt: new Date().toISOString(),
    version: 1
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `arbeitszeit_backup_${new Date().toISOString().slice(0,10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function onRestore(e){
  const file = e.target.files?.[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try{
      const data = JSON.parse(reader.result);
      if(!data.entries || !Array.isArray(data.entries)) throw new Error('Ungültiges Backup.');
      entries = data.entries;
      categories = Array.isArray(data.categories) ? data.categories : categories;
      state = typeof data.state==='object' ? data.state : state;
      settings = typeof data.settings==='object' ? data.settings : settings;
      save(LS_KEYS.entries, entries);
      save(LS_KEYS.categories, categories);
      save(LS_KEYS.state, state);
      save(LS_KEYS.settings, settings);
      renderCategories();
      renderFilterCategories();
      rounding5.checked = !!settings.rounding5;
      render();
      alert('Backup erfolgreich eingespielt.');
    }catch(err){
      alert('Fehler beim Einspielen: ' + err.message);
    }
  };
  reader.readAsText(file);
}

/** Initiale Werte für Datumsfilter: aktuelle Woche **/
(function initDefaultFilters(){
  const now = new Date();
  const dow = (now.getDay()+6)%7; // Montag=0
  const monday = new Date(now); monday.setDate(now.getDate()-dow);
  const sunday = new Date(monday); sunday.setDate(monday.getDate()+6);
  fromDate.valueAsDate = monday;
  toDate.valueAsDate = sunday;
})();

// Bewahre Zustand (Kategorie & Notiz) während Timer nicht läuft
categorySelect.addEventListener('change', ()=>{
  state.category = categorySelect.value;
  save(LS_KEYS.state, state);
});
noteInput.addEventListener('input', ()=>{
  state.note = noteInput.value.trim();
  save(LS_KEYS.state, state);
});

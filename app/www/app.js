'use strict';
/* global UI, icon, Engine, P, Cap */
// Interfejs Monitora prawa: wspólny dla Windows, Linuksa (Electron) i Androida (Capacitor).
const { h, iconEl, toast, sheet, toggle, segmented, select, spinner, group, row, busy } = UI;

const PRIORITY_LABEL = { hi: 'Wysoki', mid: 'Średni', lo: 'Niski' };
const PRIORITY_CHIP = { hi: 'red', mid: 'orange', lo: 'teal' };
const WORKFLOW_LABEL = { new: 'Nowa', in_progress: 'W toku', done: 'Zrobiona', dismissed: 'Odrzucona' };
const WORKFLOW_CHIP = { new: 'blue', in_progress: 'purple', done: 'green', dismissed: '' };
const STATUS_LABEL = { obowiazuje: 'Obowiązuje', projekt: 'Projekt', wytyczne: 'Wytyczne', informacja: 'Informacja' };
const AFFECTS_LABEL = { yes: 'Dotyczy placówki', maybe: 'Może dotyczyć', no: 'Nie dotyczy' };
const CONF_LABEL = { high: 'wysoka', medium: 'średnia', low: 'niska' };
const MONTHS_SHORT = ['sty', 'lut', 'mar', 'kwi', 'maj', 'cze', 'lip', 'sie', 'wrz', 'paź', 'lis', 'gru'];
const WD = ['niedziela', 'poniedziałek', 'wtorek', 'środa', 'czwartek', 'piątek', 'sobota'];
const OPEN = new Set(['new', 'in_progress']);

const SETTINGS_DEFAULTS = () => ({
  ai: {
    v: Engine.AI_SETTINGS_VERSION, provider: P.kind === 'desktop' ? 'codex' : 'gemini-api', fallback: true, order: [...Engine.ACCOUNT_IDS],
    connected: {}, consent: {}, paths: {}, model: 'sonnet', codexModel: '', geminiModel: '',
    apiModel: 'claude-sonnet-5-5', geminiApiModel: Engine.DEFAULT_GEMINI_MODEL,
  },
  ui: { theme: 'system' },
  app: { autoScan: true, runInBackground: true, autostart: false, notifications: true },
  hints: {},
});

const state = {
  info: null,
  settings: null,
  monitor: null,
  cfg: null,
  changes: [],
  runs: [],
  lastLog: null,
  view: 'dashboard',
  scanning: null, // { reason, lines: [] }
  filter: { wf: 'open', prio: 'all', q: '', source: 'all' },
  tasksMode: 'role',
  tasksRole: 'all',
  settingsTab: 'general',
  secrets: { anthropic: false, gemini: false },
  accounts: {}, // stan kont AI z procesu głównego: { installed, loggedIn, path, version, email, plan }
  acc: {}, // stan interfejsu kont: { installing, log, login, guide }
  aiAdvanced: false,
  check: null,
  mobile: false,
};

// ───────────────────────── narzędzia ─────────────────────────
const plural = (n, a, b, c) => { if (n === 1) return a; const d = n % 10, t = n % 100; return d >= 2 && d <= 4 && !(t >= 12 && t <= 14) ? b : c; };
const tz = () => (state.cfg && state.cfg.school.timezone) || 'Europe/Warsaw';
const today = () => Engine.localParts(new Date(), tz()).date;
const plDate = (iso) => (iso ? Engine.plDate(String(iso).slice(0, 10)) : '');
const longToday = () => new Date().toLocaleDateString('pl-PL', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz() });
const timeOf = (isoTs) => new Date(isoTs).toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', timeZone: tz() });
const cap = (s) => String(s || '').replace(/^./, (c) => c.toUpperCase());
function errToast(e) { toast(e.message || String(e), 'error', 8000); }

function relDays(iso) {
  if (!iso) return '';
  const d = Engine.daysBetween(today(), String(iso).slice(0, 10));
  if (d === 0) return 'dziś';
  if (d === 1) return 'jutro';
  if (d === -1) return 'wczoraj';
  return d > 0 ? `za ${d} ${plural(d, 'dzień', 'dni', 'dni')}` : `${-d} ${plural(-d, 'dzień', 'dni', 'dni')} temu`;
}

const chip = (text, color, ic) => h('span', { class: 'chip ' + (color || '') }, ic ? iconEl(ic, 11) : null, text);
const prioChip = (p) => chip(PRIORITY_LABEL[p] || p, PRIORITY_CHIP[p]);
const wfChip = (w) => chip(WORKFLOW_LABEL[w] || w, WORKFLOW_CHIP[w]);

const isAccount = (p) => Engine.ACCOUNT_IDS.includes(p);
function aiReady() {
  const p = state.settings.ai.provider;
  if (isAccount(p)) return P.kind === 'desktop' && !!(state.accounts[p] && state.accounts[p].loggedIn);
  if (p === 'api') return state.secrets.anthropic;
  if (p === 'gemini-api') return state.secrets.gemini;
  return false;
}
function aiLabel() {
  return Engine.AI_PROVIDERS[state.settings.ai.provider] || 'AI';
}

// ───────────────────────── dane ─────────────────────────
async function loadSettings() {
  const raw = (await P.kvGet('settings')) || {};
  const d = SETTINGS_DEFAULTS();
  // Ustawienia z wersji 1.0 (konto Claude, klucze API, tryb „Bez AI”) przechodzą na nowy układ kont AI.
  const migrated = raw.ai && raw.ai.v !== Engine.AI_SETTINGS_VERSION;
  const ai = { ...d.ai, ...Engine.migrateAiSettings(raw.ai, P.kind) };
  state.settings = { ai, ui: { ...d.ui, ...(raw.ui || {}) }, app: { ...d.app, ...(raw.app || {}) }, hints: { ...(raw.hints || {}) } };
  if (migrated) await P.kvSet('settings', state.settings).catch(() => {});
}

async function saveSettings(patch, quiet) {
  try {
    const s = state.settings;
    // Scalanie o jeden poziom głębiej dla słowników (connected, consent, paths), żeby zmiana jednego konta nie kasowała reszty.
    const isDict = (x) => x && typeof x === 'object' && !Array.isArray(x);
    for (const [k, v] of Object.entries(patch)) {
      const cur = { ...(s[k] || {}) };
      for (const [kk, vv] of Object.entries(v)) cur[kk] = isDict(vv) && isDict(cur[kk]) ? { ...cur[kk], ...vv } : vv;
      s[k] = cur;
    }
    await P.kvSet('settings', s);
    await P.settingsChanged();
    applyTheme();
    if (!quiet) toast('Zapisano ustawienia', 'success', 1600);
  } catch (e) { errToast(e); }
}

async function loadData() {
  const m = state.monitor;
  state.cfg = await m.config();
  state.changes = await m.store.listChanges();
  state.runs = await m.store.listRuns();
  const st = await m.store.get();
  state.lastLog = (st.log || []).slice().reverse().find((l) => l.kind === 'scan' || l.kind === 'scan-error') || null;
}

async function loadSecrets() {
  state.secrets.anthropic = await P.hasSecret('anthropic');
  state.secrets.gemini = await P.hasSecret('gemini');
}

/** Zapisuje zmianę ustawień placówki (warstwa nad config/default.json). */
async function saveCfg(patch, quiet) {
  try {
    const cur = (await state.monitor.store.getConfig()) || {};
    const next = { ...cur, ...patch };
    const errors = Engine.validateConfig(next);
    if (errors.length) throw new Error('Niepoprawne ustawienia: ' + errors.slice(0, 2).join('; '));
    await state.monitor.store.setConfig(next);
    state.cfg = await state.monitor.config();
    if (!quiet) toast('Zapisano', 'success', 1400);
  } catch (e) { errToast(e); }
}

function applyTheme() {
  const t = state.settings.ui.theme;
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}

// ───────────────────────── start ─────────────────────────
async function init() {
  state.info = await P.info();
  document.body.classList.add('platform-' + state.info.platform, 'kind-' + P.kind);
  const mq = window.matchMedia('(max-width: 760px)');
  state.mobile = P.kind === 'android' || mq.matches;
  document.body.classList.toggle('mobile', state.mobile);
  mq.addEventListener('change', (e) => { if (P.kind !== 'android') { state.mobile = e.matches; document.body.classList.toggle('mobile', state.mobile); render(); } });

  await loadSettings();
  applyTheme();
  state.monitor = Engine.createMonitor({
    platform: {
      fetch: P.fetch, loadState: () => P.kvGet('state'), saveState: (json) => P.kvSet('state', json),
      secret: P.secret, aiRun: P.aiRun, notify: (t, b) => { if (state.settings.app.notifications) P.notify(t, b); },
    },
    getSettings: () => state.settings,
  });
  state.monitor.on(onEngineEvent);
  await Promise.all([loadData(), loadSecrets()]);

  if (P.kind === 'desktop') {
    document.querySelectorAll('#traffic .tl').forEach((b) => b.addEventListener('click', async () => {
      const maximized = await P.windowControl(b.dataset.act);
      if (b.dataset.act === 'maximize') b.title = maximized ? 'Przywróć' : 'Maksymalizuj';
    }));
    P.on('window:state', (s) => { const b = document.querySelector('#traffic .tl.max'); if (b) b.title = s.maximized ? 'Przywróć' : 'Maksymalizuj'; });
    document.querySelector('.titlebar').addEventListener('dblclick', (e) => { if (!e.target.closest('.traffic')) P.windowControl('maximize'); });
    window.addEventListener('blur', () => document.body.classList.add('window-blur'));
    window.addEventListener('focus', () => document.body.classList.remove('window-blur'));
    P.on('account:log', ({ id, text }) => {
      const A = accUi(id);
      A.log = (A.log + text).slice(-4000);
      const el = document.querySelector(`.acc-log[data-id="${id}"]`);
      if (el) el.textContent = A.log.split('\n').slice(-6).join('\n');
    });
    P.on('account:login', onAccountLogin);
    P.on('scan:request', (r) => runScan(r && r.reason));
  }
  P.on('nav', (n) => go(n.view || 'changes'));
  if (P.kind === 'android') {
    // Przycisk „wstecz”: zamyka arkusz, potem wraca na pulpit, na końcu chowa aplikację (skan nie jest przerywany).
    Cap.App.addListener('backButton', () => {
      const o = document.querySelector('.sheet-overlay');
      if (o) { const x = o.querySelector('.sheet-head .icon-btn'); if (x) x.click(); return; }
      if (state.view !== 'dashboard') { go('dashboard'); return; }
      Cap.App.minimizeApp();
    });
  }
  P.onResume(() => { reload().then(() => autoScan()); });
  document.getElementById('content').addEventListener('scroll', (e) => e.target.classList.toggle('scrolled', e.target.scrollTop > 4));

  render();
  if (P.kind === 'desktop') await refreshAccounts();
  if (state.info.shots) return; // zrzuty ekranu: bez automatycznego skanu
  setTimeout(autoScan, P.kind === 'android' ? 2500 : 8000);
  setInterval(autoScan, 5 * 60 * 1000);
}

async function reload() { await loadData(); render(); }

async function autoScan() {
  try {
    if (!state.settings.app.autoScan || state.scanning || !aiReady()) return;
    if (await state.monitor.isDue()) await runScan('automatycznie');
  } catch (e) { console.error('Automatyczny skan:', e); }
}

function onEngineEvent(ev) {
  if (ev.type === 'start') { state.scanning = { reason: ev.reason, lines: [] }; render(); }
  if (ev.type === 'progress' && state.scanning) {
    state.scanning.lines.push(ev.line);
    const el = document.getElementById('scan-line');
    if (el) el.textContent = ev.line.trim();
    const pill = document.querySelector('.agent-pill .t2');
    if (pill) pill.textContent = ev.line.trim().slice(0, 60);
  }
  if (ev.type === 'check') { state.check = ev.results; if (state.view === 'sources') render(); }
}

async function runScan(reason = 'ręcznie') {
  if (state.scanning) { toast('Skan już trwa…', 'info', 2000); return; }
  if (!aiReady()) {
    toast(P.kind === 'desktop' ? 'Najpierw połącz konto AI (ChatGPT, Gemini albo Claude) w Ustawieniach → AI.' : 'Najpierw wpisz klucz API Gemini albo Claude w Ustawieniach → AI.', 'error', 6000);
    state.settingsTab = 'ai'; go('settings');
    return;
  }
  try {
    const sum = await state.monitor.scan({ reason });
    state.scanning = null;
    await loadData();
    render();
    const bad = sum.health.filter((x) => !x.ok).length;
    const aiMissed = sum.ai ? sum.ai.failed + sum.ai.pending : 0;
    const extra = [
      bad ? `${bad} ${plural(bad, 'źródło', 'źródła', 'źródeł')} z błędem` : '',
      aiMissed ? `${aiMissed} ${plural(aiMissed, 'pozycja czeka', 'pozycje czekają', 'pozycji czeka')} na analizę AI${sum.ai.stopped ? ` (${sum.ai.stopped.slice(0, 120)})` : ''}` : '',
    ].filter(Boolean).join(', ');
    toast(`Skan zakończony: ${sum.fresh.length ? `${sum.fresh.length} ${plural(sum.fresh.length, 'nowa zmiana', 'nowe zmiany', 'nowych zmian')}` : 'brak nowych zmian'}${extra ? `, ${extra}` : ''}.`,
      bad || aiMissed ? 'error' : 'success', aiMissed ? 10000 : 6000);
  } catch (e) {
    state.scanning = null;
    await loadData();
    render();
    errToast(e);
  }
}

function go(view) {
  state.view = view;
  render();
  document.getElementById('content').scrollTop = 0;
}

// ───────────────────────── nawigacja ─────────────────────────
const NAV = [
  ['dashboard', 'home', 'Pulpit'],
  ['changes', 'scale', 'Zmiany prawa'],
  ['tasks', 'tasks', 'Zadania'],
  ['sources', 'antenna', 'Źródła'],
];
const TITLES = { dashboard: 'Pulpit', changes: 'Zmiany prawa', tasks: 'Zadania', sources: 'Źródła i skany', settings: 'Ustawienia' };

function openCount() { return state.changes.filter((c) => c.workflow === 'new').length; }

function scanPill() {
  const S = state.scanning;
  const last = state.runs[0];
  const err = state.lastLog && state.lastLog.kind === 'scan-error' && (!last || state.lastLog.at > last.at);
  const dotCls = S ? 'busy' : err ? 'err' : !state.settings.app.autoScan ? 'off' : '';
  const t1 = S ? 'Skanuję…' : err ? 'Skan: problem' : last ? (last.date === today() ? 'Dzisiejszy skan gotowy' : 'Ostatni skan: ' + plDate(last.date)) : 'Jeszcze bez skanu';
  const t2 = S ? (S.lines[S.lines.length - 1] || 'Pobieram listy aktów…').trim().slice(0, 60)
    : err ? state.lastLog.error.slice(0, 60)
      : last ? `${timeOf(last.at)} · kliknij, aby skanować` : 'Kliknij, aby skanować teraz';
  return h('div', { class: 'agent-pill', title: 'Skanuj teraz', onclick: () => runScan() },
    h('span', { class: 'agent-dot ' + dotCls }),
    h('div', { style: { minWidth: 0 } }, h('div', { class: 't1' }, t1), h('div', { class: 't2' }, t2)));
}

function renderSidebar() {
  const sb = document.getElementById('sidebar');
  const n = openCount();
  sb.replaceChildren(
    h('div', { class: 'brand' },
      h('div', { class: 'brand-logo', html: icon('scale', 20) }),
      h('div', { style: { minWidth: 0 } }, h('div', { class: 'brand-name' }, 'Monitor prawa'), h('div', { class: 'brand-sub' }, shortSchool()))),
    h('div', { class: 'nav-section' }, 'Monitoring'),
    ...NAV.map(([v, ic, label]) => h('div', { class: 'nav-item' + (state.view === v ? ' active' : ''), onclick: () => go(v) },
      h('span', { html: icon(ic, 17) }), label, v === 'changes' && n ? h('span', { class: 'nav-badge' }, n) : null)),
    h('div', { class: 'nav-section' }, 'Aplikacja'),
    h('div', { class: 'nav-item' + (state.view === 'settings' ? ' active' : ''), onclick: () => go('settings') }, h('span', { html: icon('gear', 17) }), 'Ustawienia'),
    h('div', { class: 'sidebar-spacer' }),
    scanPill());
  const tb = document.getElementById('tabbar');
  tb.replaceChildren(...[...NAV, ['settings', 'gear', 'Ustawienia']].map(([v, ic, label]) =>
    h('button', { class: 'tab' + (state.view === v ? ' active' : ''), onclick: () => go(v) },
      h('span', { class: 'tab-ic', html: icon(ic, 22) }, v === 'changes' && n ? h('span', { class: 'tab-badge' }, n) : null),
      h('span', { class: 'tab-label' }, label === 'Zmiany prawa' ? 'Zmiany' : label))));
}

function shortSchool() {
  const n = (state.cfg && state.cfg.school.name) || '';
  return n.replace(/^Specjalny Ośrodek Szkolno-Wychowawczy/, 'SOSW');
}

function render() {
  renderSidebar();
  const c = document.getElementById('content');
  const views = { dashboard: viewDashboard, changes: viewChanges, tasks: viewTasks, sources: viewSources, settings: viewSettings };
  const el = views[state.view]();
  el.classList.add('fade-in');
  c.replaceChildren(el);
  document.getElementById('window-title').textContent = `${TITLES[state.view]} — Monitor prawa`;
}

function toolbar(title, ...right) {
  return h('div', { class: 'toolbar' }, h('h1', null, title), h('div', { class: 'spacer' }), ...right);
}

function scanButton(cls = '') {
  return h('button', { class: 'btn primary ' + cls, disabled: state.scanning ? true : null, onclick: () => runScan() },
    state.scanning ? spinner(14) : iconEl('refresh', 14), state.scanning ? 'Skanuję…' : 'Skanuj teraz');
}

function scanBanner() {
  if (!state.scanning) return null;
  const last = state.scanning.lines[state.scanning.lines.length - 1] || 'Pobieram listy nowych aktów…';
  return h('div', { class: 'card progress-banner scan-banner' }, spinner(18),
    h('div', { style: { minWidth: 0, flex: 1 } },
      h('div', { style: { fontWeight: 600 } }, `Trwa skan (${state.scanning.reason})`),
      h('div', { class: 'muted small ellipsis', id: 'scan-line' }, last.trim())));
}

function connectBanner() {
  if (aiReady()) return null;
  const desk = P.kind === 'desktop' && isAccount(state.settings.ai.provider);
  return h('div', { class: 'card connect-banner' },
    h('div', { class: 'acc-logo', html: icon('key', 22) }),
    h('div', { style: { flex: 1, minWidth: 0 } },
      h('div', { class: 'acc-title' }, desk ? 'Połącz konto AI' : 'Podłącz analizę AI'),
      h('div', { class: 'muted small' }, desk
        ? 'Wystarczy darmowe konto ChatGPT albo Google (Gemini); Claude wymaga planu Pro. Zainstaluję oficjalny program i otworzę stronę logowania. Potem każdy nowy akt dostanie streszczenie i zadania dla ról.'
        : 'Wpisz klucz API Gemini (darmowy poziom Google AI Studio) albo Claude. Bez tego aplikacja nie przeanalizuje nowych aktów.')),
    h('button', { class: 'btn primary lg', onclick: () => { state.settingsTab = 'ai'; go('settings'); } }, desk ? 'Połącz' : 'Ustaw'));
}

// ───────────────────────── PULPIT ─────────────────────────
function upcomingItems(days = 45) {
  const t = today();
  const out = [];
  for (const c of state.changes) {
    if (!OPEN.has(c.workflow)) continue;
    if (c.effective_date) out.push({ date: c.effective_date, kind: 'effective', text: 'Wejście w życie', c });
    for (const task of c.tasks || []) if (task.deadline) out.push({ date: task.deadline, kind: 'task', text: `${task.role}: ${task.action}`, c });
  }
  return out.filter((x) => { const d = Engine.daysBetween(t, x.date); return d >= -3 && d <= days; }).sort((a, b) => a.date.localeCompare(b.date));
}

function viewDashboard() {
  const hour = Number(new Date().toLocaleString('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz() }));
  const greet = hour < 5 || hour >= 18 ? 'Dobry wieczór' : 'Dzień dobry';
  const RANK = { hi: 0, mid: 1, lo: 2 };
  const open = state.changes.filter((c) => OPEN.has(c.workflow)).sort((a, b) => (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3));
  const fresh = state.changes.filter((c) => c.workflow === 'new');
  const hi = open.filter((c) => c.priority === 'hi');
  const tasks = open.reduce((n, c) => n + (c.tasks || []).length, 0);
  const last = state.runs[0];
  const badSources = last ? (last.summary.health || []).filter((x) => !x.ok).length : 0;
  const up = upcomingItems();
  const next = up.find((u) => Engine.daysBetween(today(), u.date) >= 0);

  return h('div', null,
    toolbar('Pulpit', scanButton()),
    h('div', { class: 'page' },
      h('div', { class: 'hello' }, h('h1', null, greet), h('p', null, `${cap(longToday())} · ${shortSchool()}`)),
      connectBanner(),
      scanBanner(),
      h('div', { class: 'grid grid-3', style: { marginBottom: '16px' } },
        h('div', { class: 'hero blue', onclick: () => { state.filter.wf = 'new'; go('changes'); } },
          h('div', { class: 'hero-ic', html: icon('bell', 22) }),
          h('div', null, h('h3', null, fresh.length ? `${fresh.length} ${plural(fresh.length, 'nowa zmiana', 'nowe zmiany', 'nowych zmian')}` : 'Brak nowych zmian'),
            h('p', null, fresh.length ? 'Przejrzyj streszczenia i oznacz, co już obsłużone.' : last ? `Ostatni skan: ${plDate(last.date)}, ${timeOf(last.at)}.` : 'Uruchom pierwszy skan, aby pobrać akty z ostatnich 7 dni.'))),
        h('div', { class: 'hero purple', onclick: () => go('tasks') },
          h('div', { class: 'hero-ic', html: icon('tasks', 22) }),
          h('div', null, h('h3', null, tasks ? `${tasks} ${plural(tasks, 'zadanie', 'zadania', 'zadań')} dla ról` : 'Zadania dla ról'),
            h('p', null, tasks ? 'Konkretne działania przypisane dyrektorowi, pedagogom i administracji.' : 'Po analizie AI każda zmiana dostaje zadania dla właściwych osób.'))),
        h('div', { class: 'hero green', onclick: () => next && openChange(next.c) },
          h('div', { class: 'hero-ic', html: icon('calendar', 22) }),
          h('div', null, h('h3', null, next ? `Termin ${relDays(next.date)}` : 'Brak bliskich terminów'),
            h('p', { class: 'clamp2' }, next ? `${plDate(next.date)}: ${next.c.title}` : 'Tu pojawi się najbliższa data wejścia w życie lub termin zadania.')))),
      h('div', { class: 'grid grid-4', style: { marginBottom: '16px' } },
        statCard('Otwarte zmiany', open.length, plural(open.length, 'zmiana', 'zmiany', 'zmian'), 'scale'),
        statCard('Wysoki priorytet', hi.length, 'otwarte', 'flag'),
        statCard('Sprawdzone w ostatnim skanie', last ? last.summary.reviewed || 0 : 0, 'pozycji', 'search'),
        statCard('Źródła z błędem', badSources, last ? `z ${(last.summary.health || []).length}` : '', 'warn')),
      h('div', { class: 'grid grid-2' },
        h('div', { class: 'card card-pad' },
          h('div', { class: 'card-title' }, h('span', { html: icon('scale', 16) }), 'Ostatnie zmiany', h('span', { class: 'spacer' }),
            h('button', { class: 'btn plain sm', onclick: () => { state.filter.wf = 'open'; go('changes'); } }, 'Wszystkie')),
          open.length ? open.slice(0, 6).map((c) => h('div', { class: 'ch-row', onclick: () => openChange(c) },
            prioChip(c.priority),
            h('div', { style: { minWidth: 0, flex: 1 } }, h('div', { class: 'ch-title' }, c.title), h('div', { class: 'muted small' }, `${c.source_name} · ${plDate(c.run_date)}`)),
            h('span', { class: 'muted', html: icon('chevronR', 14) })))
            : h('div', { class: 'empty' }, iconEl('checkCircle', 28), h('p', { style: { marginTop: '8px' } }, 'Wszystko obsłużone, brak otwartych zmian.'))),
        h('div', { class: 'card card-pad' },
          h('div', { class: 'card-title' }, h('span', { html: icon('calendar', 16) }), 'Nadchodzące terminy'),
          up.length ? up.slice(0, 7).map((u) => {
            const d = new Date(`${u.date}T12:00:00Z`);
            return h('div', { class: 'up-item', style: { cursor: 'pointer' }, onclick: () => openChange(u.c) },
              h('div', { class: 'date-badge' }, h('div', { class: 'm' }, MONTHS_SHORT[d.getUTCMonth()]), h('div', { class: 'd' }, d.getUTCDate())),
              h('div', { style: { minWidth: 0 } }, h('div', { class: 'ellipsis', style: { fontWeight: 550 } }, u.kind === 'task' ? u.text : u.c.title),
                h('div', { class: 'kind' }, h('span', { class: 'dot ' + (u.kind === 'task' ? 'occasion' : 'holiday') }), u.kind === 'task' ? 'Termin zadania' : 'Wejście w życie', ' · ', relDays(u.date))));
          }) : h('div', { class: 'empty' }, 'Brak terminów w najbliższych tygodniach.')))));
}

function statCard(label, value, unit, ic) {
  return h('div', { class: 'card stat' },
    h('div', { class: 'label', html: icon(ic, 14) + ' ' + label }),
    h('div', { class: 'value' }, String(value), unit ? h('small', null, unit) : null));
}

// ───────────────────────── ZMIANY ─────────────────────────
function filteredChanges() {
  const f = state.filter;
  const q = f.q.trim().toLowerCase();
  const RANK = { hi: 0, mid: 1, lo: 2 };
  return state.changes.slice().sort((a, b) => (b.run_date || '').localeCompare(a.run_date || '') || (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3)).filter((c) =>
    (f.wf === 'all' || (f.wf === 'open' ? OPEN.has(c.workflow) : c.workflow === f.wf))
    && (f.prio === 'all' || c.priority === f.prio)
    && (f.source === 'all' || c.source_id === f.source)
    && (!q || `${c.title} ${c.summary} ${c.what_changes}`.toLowerCase().includes(q)));
}

function viewChanges() {
  const f = state.filter;
  const list = filteredChanges();
  const search = h('input', { class: 'input search', type: 'search', placeholder: 'Szukaj w tytułach i streszczeniach', value: f.q,
    oninput: (e) => { f.q = e.target.value; const pos = e.target.selectionStart; render(); const s = document.querySelector('.input.search'); if (s) { s.focus(); s.setSelectionRange(pos, pos); } } });
  const sources = [...new Map(state.changes.map((c) => [c.source_id, c.source_name])).entries()];
  return h('div', null,
    toolbar('Zmiany prawa', state.mobile ? null : search, scanButton()),
    h('div', { class: 'page' },
      scanBanner(),
      state.mobile ? h('div', { style: { marginBottom: '12px' } }, search) : null,
      h('div', { class: 'filterbar' },
        segmented([{ value: 'open', label: 'Otwarte' }, { value: 'new', label: 'Nowe' }, { value: 'done', label: 'Zrobione' }, { value: 'dismissed', label: 'Odrzucone' }, { value: 'all', label: 'Wszystkie' }], f.wf, (v) => { f.wf = v; render(); }),
        segmented([{ value: 'all', label: 'Każdy priorytet' }, { value: 'hi', label: 'Wysoki' }, { value: 'mid', label: 'Średni' }, { value: 'lo', label: 'Niski' }], f.prio, (v) => { f.prio = v; render(); }),
        sources.length > 1 ? select([{ value: 'all', label: 'Wszystkie źródła' }, ...sources.map(([v, l]) => ({ value: v, label: l }))], f.source, (v) => { f.source = v; render(); }) : null),
      list.length ? h('div', { class: 'ch-list' }, list.map(changeCard))
        : h('div', { class: 'card empty', style: { padding: '48px 20px' } }, iconEl('scale', 30),
          h('p', { style: { marginTop: '10px' } }, state.changes.length ? 'Brak zmian spełniających filtr.' : 'Jeszcze nie ma żadnych zmian. Uruchom skan, aby pobrać akty z ostatnich dni.'),
          !state.changes.length ? h('div', { style: { marginTop: '14px' } }, scanButton()) : null)));
}

function changeCard(c) {
  const tasks = (c.tasks || []).length;
  return h('div', { class: 'card ch-card prio-' + c.priority, onclick: () => openChange(c) },
    h('div', { class: 'ch-chips' }, prioChip(c.priority), c.workflow !== 'new' ? wfChip(c.workflow) : chip('Nowa', 'blue', 'bell'),
      chip(STATUS_LABEL[c.status] || c.status), h('span', { class: 'muted small ellipsis' }, c.source_name)),
    h('h3', { class: 'ch-h' }, c.title),
    c.summary ? h('p', { class: 'ch-sum' }, c.summary) : null,
    h('div', { class: 'ch-foot muted small' },
      c.effective_date ? h('span', null, iconEl('calendar', 12), ` Wejście w życie ${plDate(c.effective_date)} (${relDays(c.effective_date)})`) : h('span', null, iconEl('calendar', 12), ' Bez daty wejścia w życie'),
      tasks ? h('span', null, iconEl('tasks', 12), ` ${tasks} ${plural(tasks, 'zadanie', 'zadania', 'zadań')}`) : null,
      c.requires_statute_change ? h('span', null, iconEl('doc', 12), ' Zmiana statutu') : null,
      h('span', { class: 'spacer' }), h('span', null, `wykryto ${plDate(c.run_date)}`)));
}

function openChange(c0) {
  const c = state.changes.find((x) => x.key === c0.key) || c0;
  const note = h('textarea', { class: 'input full', rows: 3, placeholder: 'Notatka (np. kto się zajmuje, co już zrobiono)', value: c.note || '' });
  let wf = c.workflow;
  const excerpt = c.act_excerpt ? h('details', { class: 'excerpt' }, h('summary', null, 'Najważniejsze przepisy (cytat z aktu)'), h('pre', null, c.act_excerpt)) : null;
  const body = h('div', { class: 'ch-detail' },
    h('div', { class: 'ch-chips' }, prioChip(c.priority), chip(STATUS_LABEL[c.status] || c.status), chip(AFFECTS_LABEL[c.affects_school] || '', c.affects_school === 'yes' ? 'purple' : ''),
      c.confidence ? chip(`Pewność: ${CONF_LABEL[c.confidence] || c.confidence}`, c.confidence === 'low' ? 'orange' : '') : null),
    c.summary ? h('p', { class: 'lead' }, c.summary) : null,
    c.what_changes ? h('div', { class: 'd-sec' }, h('h4', null, 'Co się zmienia dla placówki'), h('p', null, c.what_changes)) : null,
    (c.priority_reasons || []).length ? h('div', { class: 'd-sec' }, h('h4', null, 'Dlaczego taki priorytet'), h('ul', { class: 'bullets' }, c.priority_reasons.map((r) => h('li', null, r)))) : null,
    (c.tasks || []).length ? h('div', { class: 'd-sec' }, h('h4', null, 'Zadania'),
      c.tasks.map((t) => h('div', { class: 'issue' }, h('span', { class: 'ic', html: icon('person', 14) }),
        h('div', null, h('b', null, t.role), ': ', t.action, t.deadline ? h('span', { class: 'muted' }, ` (do ${plDate(t.deadline)}, ${relDays(t.deadline)})`) : null)))) : null,
    (c.documents || []).length || c.requires_statute_change || c.requires_council_resolution ? h('div', { class: 'd-sec' }, h('h4', null, 'Dokumenty szkoły'),
      h('div', { class: 'ch-chips' }, (c.documents || []).map((d) => chip(d, 'blue', 'doc')),
        c.requires_statute_change ? chip('Wymaga zmiany statutu', 'red') : null,
        c.requires_council_resolution ? chip('Wymaga uchwały rady pedagogicznej', 'orange') : null)) : null,
    h('div', { class: 'd-sec' }, h('h4', null, 'Akt'),
      h('div', { class: 'kv' },
        h('span', null, 'Źródło'), h('span', null, c.source_name),
        c.published_at ? h('span', null, 'Publikacja') : null, c.published_at ? h('span', null, plDate(c.published_at)) : null,
        h('span', null, 'Wejście w życie'), h('span', null, c.effective_date ? `${plDate(c.effective_date)} (${relDays(c.effective_date)})` : 'brak w danych'),
        c.legal_basis ? h('span', null, 'Podstawa') : null, c.legal_basis ? h('span', null, c.legal_basis) : null)),
    c.review_note ? h('div', { class: 'note-box warn' }, iconEl('warn', 16), h('div', null, h('b', null, 'Do sprawdzenia: '), c.review_note)) : null,
    excerpt,
    h('div', { class: 'd-sec' }, h('h4', null, 'Stan obsługi'),
      segmented(Object.entries(WORKFLOW_LABEL).map(([value, label]) => ({ value, label })), wf, (v) => { wf = v; }),
      h('div', { style: { marginTop: '10px' } }, note)),
    h('p', { class: 'muted small', style: { marginTop: '14px' } }, 'Streszczenie przygotował asystent AI i może zawierać błędy. Przed zmianą dokumentów sprawdź treść aktu w źródle.'));
  sheet({
    title: c.title,
    subtitle: `${c.source_name} · wykryto ${plDate(c.run_date)}`,
    wide: true,
    body,
    actions: [
      c.url ? { label: 'Otwórz źródło', onClick: () => { P.openExternal(c.url); return false; } } : null,
      { label: 'Zamknij' },
      { label: 'Zapisz', kind: 'primary', onClick: async () => {
        try { await state.monitor.store.updateChange(c.key, { workflow: wf, note: note.value }); await loadData(); render(); toast('Zapisano', 'success', 1400); } catch (e) { errToast(e); return false; }
      } },
    ].filter(Boolean),
  });
}

// ───────────────────────── ZADANIA ─────────────────────────
function allTasks() {
  const out = [];
  for (const c of state.changes) {
    if (!OPEN.has(c.workflow)) continue;
    for (const t of c.tasks || []) out.push({ ...t, c });
  }
  return out;
}

function viewTasks() {
  const tasks = allTasks();
  const roles = state.cfg.roles.map((r) => r.name);
  const filtered = tasks.filter((t) => state.tasksRole === 'all' || t.role === state.tasksRole);
  let content;
  if (!filtered.length) {
    content = h('div', { class: 'card empty', style: { padding: '48px 20px' } }, iconEl('tasks', 30), h('p', { style: { marginTop: '10px' } }, 'Brak otwartych zadań.'));
  } else if (state.tasksMode === 'role') {
    const byRole = new Map();
    for (const t of filtered) { if (!byRole.has(t.role)) byRole.set(t.role, []); byRole.get(t.role).push(t); }
    const order = [...roles, ...[...byRole.keys()].filter((r) => !roles.includes(r))];
    content = h('div', null, order.filter((r) => byRole.has(r)).map((r) => group(`${r} · ${byRole.get(r).length}`,
      byRole.get(r).sort((a, b) => (a.deadline || '9').localeCompare(b.deadline || '9')).map(taskRow))));
  } else {
    const sorted = filtered.slice().sort((a, b) => (a.deadline || a.c.effective_date || '9').localeCompare(b.deadline || b.c.effective_date || '9'));
    content = group(null, sorted.map(taskRow));
  }
  return h('div', null,
    toolbar('Zadania', segmented([{ value: 'role', label: 'Według ról' }, { value: 'date', label: 'Według terminów' }], state.tasksMode, (v) => { state.tasksMode = v; render(); })),
    h('div', { class: 'page' },
      h('div', { class: 'filterbar' }, select([{ value: 'all', label: 'Wszystkie role' }, ...roles.map((r) => ({ value: r, label: r }))], state.tasksRole, (v) => { state.tasksRole = v; render(); }),
        h('span', { class: 'muted small' }, 'Zadania z otwartych zmian. Oznacz zmianę jako zrobioną, gdy wszystkie zadania są wykonane.')),
      content));
}

function taskRow(t) {
  const date = t.deadline || t.c.effective_date;
  const late = date && Engine.daysBetween(today(), date) < 0;
  return h('div', { class: 'row task-row', onclick: () => openChange(t.c) },
    h('div', { class: 'row-label' },
      h('span', { class: 'row-icon', style: { background: `var(--${PRIORITY_CHIP[t.c.priority] === 'teal' ? 'teal' : PRIORITY_CHIP[t.c.priority]})` }, html: icon('check', 13) }),
      h('div', { style: { minWidth: 0 } },
        h('div', null, state.tasksMode === 'date' ? h('b', null, `${t.role}: `) : null, t.action),
        h('div', { class: 'row-hint ellipsis' }, t.c.title))),
    h('div', { class: 'row-control' }, date ? h('span', { class: 'chip ' + (late ? 'red' : '') }, t.deadline ? `do ${plDate(date)}` : `wchodzi ${plDate(date)}`) : h('span', { class: 'muted small' }, 'bez terminu')));
}

// ───────────────────────── ŹRÓDŁA ─────────────────────────
function viewSources() {
  const last = state.runs[0];
  const health = new Map(((last && last.summary.health) || []).map((x) => [x.id, x]));
  const checks = new Map((state.check || []).map((x) => [x.id, x]));
  const cfgSources = state.cfg.sources;
  const toggleSource = async (s, on) => {
    const cur = (await state.monitor.store.getConfig()) || {};
    const list = (cur.sources || []).filter((x) => x.id !== s.id);
    await saveCfg({ sources: [...list, { ...s, enabled: on }] }, true);
    render();
  };
  return h('div', null,
    toolbar('Źródła i skany',
      h('button', { class: 'btn', disabled: state.check === 'busy' ? true : null, onclick: async (e) => {
        await busy(e.currentTarget, async () => { state.check = []; try { state.check = await state.monitor.checkSources(); } catch (er) { errToast(er); } render(); }, 'Sprawdzam…');
      } }, iconEl('antenna', 14), 'Sprawdź źródła'),
      scanButton()),
    h('div', { class: 'page' },
      scanBanner(),
      last ? h('div', { class: 'card card-pad', style: { marginBottom: '18px' } },
        h('div', { class: 'card-title' }, h('span', { html: icon('clock', 16) }), `Ostatni skan: ${plDate(last.date)}, ${timeOf(last.at)}`, h('span', { class: 'spacer' }),
          h('button', { class: 'btn sm', onclick: () => openReport(last.date) }, iconEl('doc', 13), 'Raport')),
        h('div', { class: 'muted' }, `Sprawdzono ${last.summary.reviewed || 0} nowych pozycji, ${last.summary.changes || 0} ${plural(last.summary.changes || 0, 'zmiana dotyczy', 'zmiany dotyczą', 'zmian dotyczy')} placówki.`),
        state.lastLog && state.lastLog.lines ? h('details', { class: 'excerpt', style: { marginTop: '10px' } }, h('summary', null, 'Dziennik ostatniego skanu'), h('pre', null, state.lastLog.lines.join('\n'))) : null)
        : h('div', { class: 'note-box' }, iconEl('info', 16), h('div', null, 'Pierwszy skan obejmie ostatnie ', String(state.cfg.schedule.lookbackDays), ' dni. Źródła bez dat (np. BIP) przy pierwszym skanie tylko zapamiętują istniejące pozycje.')),
      group('Źródła', cfgSources.map((s) => {
        const hl = health.get(s.id);
        const ck = checks.get(s.id);
        const aiWait = hl ? (hl.aiFailed || 0) + (hl.aiPending || 0) : 0;
        const hint = ck ? (ck.ok ? `Test: OK, ${ck.count} pozycji${ck.sample ? ` (np. ${ck.sample.slice(0, 60)})` : ''}${ck.warn ? `. Uwaga: ${ck.warn}` : ''}` : `Test: błąd: ${ck.error}`)
          : hl ? (hl.ok ? `Ostatnio: ${hl.listed} na liście, ${hl.fresh} nowych, ${hl.analyzed} przeanalizowanych${hl.baselined ? `, zapamiętano ${hl.baselined}` : ''}${aiWait ? `, ${aiWait} czeka na analizę AI` : ''}${hl.warn ? `. Uwaga: ${hl.warn}` : ''}` : `Błąd: ${hl.error}`) : 'Jeszcze nie sprawdzano';
        const bad = (ck && !ck.ok) || (!ck && hl && !hl.ok);
        const warn = !bad && ((ck && ck.warn) || (!ck && hl && (hl.warn || aiWait)));
        return row(s.name, toggle(s.enabled !== false, (v) => toggleSource(s, v)),
          { icon: bad || warn ? 'warn' : 'antenna', color: s.enabled === false ? 'var(--text-3)' : bad ? 'var(--red)' : warn ? 'var(--orange)' : 'var(--green)', hint });
      }), 'Wyłączone źródło nie jest pobierane przy skanie. Wiarygodność źródeł opisuje README w repozytorium.'),
      state.runs.length ? group('Historia skanów', state.runs.slice(0, 30).map((r) => {
        const bad = (r.summary.health || []).filter((x) => !x.ok).length;
        return row(`${cap(new Date(`${r.date}T12:00:00Z`).toLocaleDateString('pl-PL', { weekday: 'long', timeZone: 'UTC' }))}, ${plDate(r.date)}`,
          h('button', { class: 'btn sm', onclick: () => openReport(r.date) }, 'Raport'),
          { icon: bad ? 'warn' : 'checkCircle', color: bad ? 'var(--orange)' : 'var(--green)', hint: `${r.summary.changes || 0} ${plural(r.summary.changes || 0, 'zmiana', 'zmiany', 'zmian')}, sprawdzono ${r.summary.reviewed || 0}${bad ? `, ${bad} ${plural(bad, 'źródło', 'źródła', 'źródeł')} z błędem` : ''}` });
      })) : null));
}

async function openReport(date) {
  const r = await state.monitor.store.getReport(date);
  if (!r) { toast('Brak zapisanego raportu z tego dnia.', 'info'); return; }
  const frame = h('iframe', { class: 'report-frame', sandbox: '', srcdoc: r.html, title: r.subject });
  sheet({ title: r.subject, subtitle: `Raport z ${plDate(date)}`, wide: true, body: frame, actions: [{ label: 'Zamknij', kind: 'primary' }] });
}

// ───────────────────────── USTAWIENIA ─────────────────────────
function viewSettings() {
  const tabs = [
    { value: 'general', label: 'Ogólne', icon: 'home' },
    { value: 'ai', label: 'AI', icon: 'cpu' },
    { value: 'scan', label: 'Skan', icon: 'clock' },
    { value: 'roles', label: 'Role', icon: 'people' },
    { value: 'docs', label: 'Dokumenty', icon: 'doc' },
    { value: 'rules', label: 'Reguły', icon: 'flag' },
  ];
  const body = { general: settingsGeneral, ai: settingsAi, scan: settingsScan, roles: settingsRoles, docs: settingsDocs, rules: settingsRules }[state.settingsTab]();
  return h('div', null,
    toolbar('Ustawienia'),
    h('div', { class: 'page' },
      h('div', { class: 'settings-tabs' }, segmented(tabs, state.settingsTab, (v) => { state.settingsTab = v; render(); })),
      body));
}

function textInput(value, onSave, attrs = {}) {
  return h('input', { class: 'input', style: { width: attrs.width || '300px' }, value: value == null ? '' : value, placeholder: attrs.placeholder || '', type: attrs.type || 'text', min: attrs.min, max: attrs.max, onchange: (e) => onSave(e.target.value) });
}

function settingsGeneral() {
  const s = state.settings;
  const school = state.cfg.school;
  return h('div', null,
    group('Placówka', [
      row('Nazwa', textInput(school.name, (v) => saveCfg({ school: { ...school, name: v.trim() || school.name } }), { width: '380px' }), { icon: 'home', color: 'var(--accent)' }),
      row('Opis placówki dla AI', h('textarea', { class: 'input full', rows: 5, value: school.profile, onchange: (e) => saveCfg({ school: { ...state.cfg.school, profile: e.target.value } }) }),
        { icon: 'sparkles', color: 'var(--purple)', stack: true, hint: 'Typ szkoły, oddziały, internat, kształcenie zawodowe. Od tego opisu zależy ocena, czy akt dotyczy placówki.' }),
    ]),
    group('Wygląd', [
      row('Motyw', segmented([{ value: 'system', label: 'Systemowy' }, { value: 'light', label: 'Jasny' }, { value: 'dark', label: 'Ciemny' }], s.ui.theme, (v) => saveSettings({ ui: { theme: v } }, true)), { icon: 'paint', color: 'var(--pink)' }),
    ]),
    group('Dane', [
      row('Folder danych', P.kind === 'desktop' ? h('button', { class: 'btn sm', onclick: () => P.openData() }, iconEl('folder', 13), 'Otwórz') : h('span', { class: 'muted' }, state.info.dataDir),
        { icon: 'folder', color: 'var(--orange)', hint: P.kind === 'desktop' ? (state.info.portable ? `Wersja przenośna: dane leżą obok pliku .exe (${state.info.dataDir}).` : state.info.dataDir) : 'Dane są tylko na tym urządzeniu. Rób kopię przed odinstalowaniem.' }),
      row('Kopia danych', h('div', { class: 'btn-row' },
        h('button', { class: 'btn sm', onclick: exportBackup }, iconEl('download', 13), 'Zapisz kopię'),
        h('button', { class: 'btn sm', onclick: importBackup }, iconEl('upload', 13), 'Wczytaj kopię')),
        { icon: 'shield', color: 'var(--green)', hint: 'Plik JSON ze zmianami, historią skanów i ustawieniami placówki (bez kluczy API).' }),
      row('Wersja', h('span', { class: 'muted' }, `${state.info.version} · ${{ desktop: state.info.platform === 'win32' ? 'Windows' : 'Linux', android: 'Android', web: 'przeglądarka' }[P.kind]}`), { icon: 'info', color: 'var(--text-3)' }),
    ]));
}

async function exportBackup() {
  try {
    const name = `monitor-prawa-kopia-${today()}.json`;
    const p = await P.saveFile({ title: 'Zapisz kopię danych', name, text: await state.monitor.store.exportAll() });
    if (p) toast(`Zapisano kopię: ${p}`, 'success', 5000);
  } catch (e) { errToast(e); }
}

async function importBackup() {
  try {
    const text = await P.openFile({ title: 'Wczytaj kopię danych' });
    if (!text) return;
    await state.monitor.store.importAll(text);
    await loadData(); render();
    toast('Wczytano kopię danych', 'success');
  } catch (e) { errToast(e); }
}

// ───────────────────────── KONTA AI ─────────────────────────
// Trzy konta, jedno pod drugim (wzór: Asystent IPET). Domyślnie darmowe: ChatGPT i Google Gemini; Claude wymaga planu Pro.
// Programy producentów działają tylko na komputerze; na telefonie zostają klucze API Claude i Gemini.
const ACCOUNTS = [
  {
    id: 'codex', name: 'ChatGPT', vendor: 'OpenAI', program: 'Codex CLI', icon: 'sparkles', grad: 'linear-gradient(145deg, #1fc485, #0a7d55)', free: true,
    plan: 'Wystarczy darmowe konto ChatGPT',
    blurb: 'Modele GPT od OpenAI. Logujesz się na stronie OpenAI tym samym kontem co w ChatGPT.',
    signup: 'https://chatgpt.com', dataUrl: 'https://chatgpt.com/#settings/DataControls',
    install: { win: 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"', unix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
    login: 'codex login', loginHint: 'Otworzy się strona logowania OpenAI – zaloguj się kontem ChatGPT.',
  },
  {
    id: 'gemini', name: 'Google Gemini', vendor: 'Google', program: 'Antigravity CLI', icon: 'brain', grad: 'linear-gradient(145deg, #4f8cff, #8a5cff)', free: true,
    plan: 'Wystarczy darmowe konto Google (Gmail)',
    blurb: 'Modele Gemini od Google. Logujesz się na stronie Google swoim prywatnym kontem (Gmail).',
    signup: 'https://accounts.google.com/signup', dataUrl: 'https://myaccount.google.com/data-and-privacy',
    install: { win: 'powershell -ExecutionPolicy ByPass -c "irm https://antigravity.google/cli/install.ps1 | iex"', unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    login: 'agy', loginHint: 'Uruchom program – otworzy się strona logowania Google. Po zalogowaniu wpisz /exit i naciśnij Enter.',
  },
  {
    id: 'claude-code', name: 'Claude', vendor: 'Anthropic', program: 'Claude Code', icon: 'speech', grad: 'linear-gradient(145deg, #d97757, #b9532f)', free: false,
    plan: 'Wymaga płatnego planu Claude Pro lub Max',
    blurb: 'Modele Claude od Anthropic. Darmowe konto Claude nie obejmuje programu Claude Code.',
    signup: 'https://claude.ai/upgrade', dataUrl: 'https://claude.ai/settings/data-privacy-controls',
    install: { win: 'powershell -ExecutionPolicy ByPass -c "irm https://claude.ai/install.ps1 | iex"', unix: 'curl -fsSL https://claude.ai/install.sh | bash' },
    login: 'claude auth login', loginHint: 'Otworzy się strona logowania Claude – zaloguj się kontem z planem Pro lub Max.',
  },
];
const accDef = (id) => ACCOUNTS.find((a) => a.id === id) || { id, name: id, vendor: '', program: id };
function accUi(id) { return (state.acc[id] = state.acc[id] || { installing: false, log: '', login: null, guide: false }); }
const isWinPlatform = () => state.info && state.info.platform === 'win32';
const isTyping = () => { const a = document.activeElement; return !!(a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== 'checkbox'); };
const rerenderSoft = () => { if (state.view === 'settings' || state.view === 'dashboard') { if (!isTyping()) render(); } };

async function refreshAccounts(ids = ACCOUNTS.map((a) => a.id)) {
  if (!P.accounts) return;
  await Promise.all(ids.map(async (id) => {
    try { state.accounts[id] = await P.accounts.status(id); } catch (_) { state.accounts[id] = { id, installed: false, loggedIn: false }; }
  }));
  await syncConnected();
  rerenderSoft();
}

// „Połączone konta” w ustawieniach (do przełączania przy limicie) zgodne z faktycznym stanem programów.
async function syncConnected() {
  const ai = state.settings.ai;
  const conn = { ...(ai.connected || {}) };
  const patch = {};
  for (const d of ACCOUNTS) {
    const st = state.accounts[d.id];
    if (!st) continue;
    if (!!conn[d.id] !== !!st.loggedIn) { conn[d.id] = !!st.loggedIn; patch.connected = { ...(patch.connected || {}), [d.id]: !!st.loggedIn }; }
  }
  // wybrane konto nie jest połączone, a inne jest – używamy połączonego
  if (isAccount(ai.provider) && !conn[ai.provider]) {
    const next = ACCOUNTS.find((d) => conn[d.id]);
    if (next) patch.provider = next.id;
  }
  if (Object.keys(patch).length) await saveSettings({ ai: patch }, true);
}

function onAccountLogin(ev) {
  const A = accUi(ev.id);
  if (ev.stage === 'done') {
    A.login = null;
    const def = accDef(ev.id);
    // Antigravity CLI nie ma polecenia „status”: udane logowanie zapamiętujemy w ustawieniach
    const after = ev.id === 'gemini' ? saveSettings({ ai: { connected: { gemini: true } } }, true) : Promise.resolve();
    after.then(() => refreshAccounts([ev.id])).then(() => toast(`Połączono z kontem ${def.name}`, 'success'));
    return;
  }
  if (ev.stage === 'error') { A.login = null; errToast(new Error(ev.error)); render(); return; }
  A.login = { ...(A.login || {}), stage: ev.stage, mode: ev.mode, url: ev.url || (A.login && A.login.url), code: ev.code || (A.login && A.login.code) };
  if (state.view === 'settings') render();
}

function copyText(t) {
  try { navigator.clipboard.writeText(t); toast('Skopiowano', 'success', 1400); } catch (_) { toast('Zaznacz i skopiuj tekst ręcznie', 'info'); }
}

function cmdBox(text) {
  return h('div', { class: 'cmd-box' }, h('code', null, text), h('button', { class: 'btn sm', onclick: () => copyText(text) }, iconEl('copy', 12), 'Kopiuj'));
}

function accLogo(def, ok) {
  return h('div', { class: 'acc-logo', style: { background: def.grad } }, h('span', { html: icon(def.icon, 22) }), ok ? h('span', { class: 'acc-badge', html: icon('check', 10) }) : null);
}

function accountCard(def) {
  const st = state.accounts[def.id];
  const A = accUi(def.id);
  const ai = state.settings.ai;
  const active = ai.provider === def.id;
  const connected = !!(st && st.loggedIn);
  const chips = [
    def.free ? h('span', { class: 'chip green' }, 'bezpłatnie') : h('span', { class: 'chip orange' }, 'płatny plan'),
    active && connected ? h('span', { class: 'chip blue' }, 'używane do analizy') : null,
  ];
  const head = (sub, ...buttons) => h('div', { class: 'acc-row' }, accLogo(def, connected),
    h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'acc-title' }, def.name, ...chips), h('div', { class: 'muted small' }, sub)),
    ...buttons);
  const wrap = h('div', { class: 'account' + (active && connected ? ' active' : '') });

  if (!st) { wrap.append(head('Sprawdzam połączenie…', spinner(16))); return wrap; }

  if (A.installing) {
    wrap.append(head(`Instaluję ${def.program} od ${def.vendor}… (ok. 1 minuty)`, spinner(18)),
      h('pre', { class: 'acc-log', 'data-id': def.id }, (A.log || '').split('\n').slice(-6).join('\n')));
    return wrap;
  }

  if (A.login) { wrap.append(head(def.plan), loginPanel(def, A.login)); return wrap; }

  if (connected) {
    const who = [st.email, st.plan ? `plan ${st.plan}` : null, st.method ? `logowanie: ${st.method}` : null].filter(Boolean).join(' · ');
    wrap.append(head(`Połączono${who ? ' · ' + who : ''}`,
      !active ? h('button', { class: 'btn', onclick: async () => { await saveSettings({ ai: { provider: def.id } }, true); toast(`Analiza korzysta teraz z konta ${def.name}`, 'success'); render(); } }, 'Używaj') : null,
      h('button', { class: 'btn', onclick: (e) => busy(e.currentTarget, async () => { try { toast(await P.accounts.test(def.id), 'success', 6000); } catch (er) { errToast(er); } }, 'Testuję…') }, iconEl('bolt', 13), 'Testuj'),
      h('button', { class: 'btn danger', onclick: () => disconnectAccount(def) }, 'Odłącz')));
    return wrap;
  }

  wrap.append(head(`${def.plan}. ${st.installed ? `Program ${def.program} jest zainstalowany – wystarczy się zalogować.` : def.blurb}`,
    h('button', { class: 'btn primary', onclick: () => connectAccount(def) }, iconEl('key', 13), 'Połącz')));
  if (A.guide) wrap.append(guidePanel(def));
  else {
    wrap.append(h('div', { class: 'acc-sub' }, h('div', { class: 'acc-links', style: { marginTop: 0 } },
      h('button', { class: 'btn plain sm', onclick: () => { A.guide = true; render(); } }, iconEl('list', 12), 'Poprowadź mnie krok po kroku'),
      h('button', { class: 'btn plain sm', onclick: () => P.openExternal(def.signup) }, iconEl('globe', 12), def.free ? 'Nie mam konta – załóż bezpłatnie' : 'Plany Claude'))));
  }
  return wrap;
}

function loginPanel(def, L) {
  const A = accUi(def.id);
  const cancel = h('button', { class: 'btn', onclick: async () => { await P.accounts.cancel(def.id).catch(() => {}); A.login = null; render(); } }, 'Anuluj');
  const waiting = (title, sub) => h('div', { class: 'acc-row acc-wait' }, h('div', { class: 'acc-spin' }, spinner(18)), h('div', { style: { flex: 1 } }, h('div', { class: 'acc-title' }, title), h('div', { class: 'muted small' }, sub)), cancel);

  if (L.stage === 'terminal' || L.mode === 'terminal') {
    return h('div', { class: 'acc-sub' },
      waiting('Logowanie w okienku terminala…', def.id === 'gemini'
        ? 'Otworzyłem małe okno logowania i stronę Google w przeglądarce. Zaloguj się kontem Google. Jeśli strona pokaże kod – wklej go w okienku terminala i naciśnij Enter. Aplikacja połączy się sama.'
        : `Otworzyłem okno logowania ${def.name}. Zaloguj się w przeglądarce; jeśli strona pokaże kod – wklej go w okienku i naciśnij Enter.`),
      h('p', { class: 'muted small', style: { marginTop: '8px' } }, 'Nie widzisz okienka? Sprawdź pasek zadań albo wybierz „Poprowadź mnie krok po kroku”.'));
  }

  if (L.stage === 'device' || L.mode === 'device') {
    return h('div', { class: 'acc-sub' },
      waiting('Logowanie kodem…', 'Otwórz stronę OpenAI, zaloguj się i wpisz poniższy kod. Aplikacja połączy się sama.'),
      h('div', { class: 'device-box' },
        h('div', null, h('div', { class: 'muted small' }, '1. Otwórz stronę'), h('button', { class: 'btn sm', disabled: L.url ? null : true, onclick: () => P.openExternal(L.url) }, iconEl('globe', 12), L.url ? 'Otwórz stronę logowania' : 'czekam na adres…')),
        h('div', null, h('div', { class: 'muted small' }, '2. Wpisz kod'), L.code ? h('div', { class: 'device-code' }, L.code, h('button', { class: 'btn sm', onclick: () => copyText(L.code) }, iconEl('copy', 12), 'Kopiuj')) : spinner(14))));
  }

  const parts = [waiting('Czekam na zalogowanie w przeglądarce…', `${def.loginHint} Aplikacja połączy się sama.`)];
  const links = [];
  if (L.url) links.push(h('button', { class: 'btn plain sm', onclick: () => P.openExternal(L.url) }, iconEl('globe', 12), 'Przeglądarka się nie otworzyła? Otwórz stronę logowania'));
  if (def.id === 'codex') links.push(h('button', { class: 'btn plain sm', onclick: () => startAccountLogin(def, 'device') }, iconEl('key', 12), 'Nie działa? Zaloguj się kodem'));
  if (links.length) parts.push(h('div', { class: 'acc-links' }, links));
  if (def.id === 'claude-code') {
    const code = h('input', { class: 'input', style: { flex: 1 }, placeholder: 'Wklej kod ze strony logowania (jeśli się pojawił)' });
    parts.push(h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', width: '100%' } }, code,
      h('button', { class: 'btn primary', onclick: async () => { if (!code.value.trim()) return; try { await P.accounts.code(def.id, code.value); toast('Przekazano kod – trwa łączenie…', 'info', 3000); } catch (er) { errToast(er); } } }, 'Zatwierdź kod')));
  }
  return h('div', { class: 'acc-sub' }, parts);
}

function guidePanel(def) {
  const A = accUi(def.id);
  const win = isWinPlatform();
  const st = state.accounts[def.id] || {};
  const step = (n, title, body) => h('div', { class: 'guide-step' + (n === 3 && st.installed ? ' done' : '') },
    h('div', { class: 'guide-num' }, n === 3 && st.installed ? h('span', { html: icon('check', 12) }) : String(n)),
    h('div', { style: { flex: 1, minWidth: 0 } }, h('div', { class: 'guide-title' }, title), body || null));
  return h('div', { class: 'acc-guide' },
    h('div', { class: 'guide-head' }, h('b', null, `Połączenie z ${def.name} krok po kroku`), h('div', { class: 'spacer' }), h('button', { class: 'btn plain sm', onclick: () => { A.guide = false; render(); } }, 'Zwiń')),
    step(1, def.free ? `Załóż bezpłatne konto ${def.vendor}, jeśli go nie masz.` : 'Upewnij się, że masz plan Claude Pro lub Max.', h('button', { class: 'btn sm', onclick: () => P.openExternal(def.signup) }, iconEl('globe', 12), 'Otwórz stronę')),
    step(2, win ? 'Otwórz PowerShell: kliknij prawym przyciskiem menu Start i wybierz „Terminal”.' : 'Otwórz Terminal (Ctrl+Alt+T).'),
    step(3, st.installed ? `${def.program} jest już zainstalowany.` : `Wklej polecenie instalacji ${def.program} i naciśnij Enter:`, st.installed ? null : cmdBox(win ? def.install.win : def.install.unix)),
    step(4, win ? 'Zamknij i otwórz Terminal ponownie, a potem wpisz polecenie logowania:' : 'Wpisz polecenie logowania:', h('div', null, cmdBox(def.login), h('div', { class: 'muted small', style: { marginTop: '4px' } }, def.loginHint))),
    step(5, 'Wróć tutaj i sprawdź połączenie.', h('div', { class: 'guide-actions' },
      h('button', { class: 'btn primary sm', onclick: (e) => busy(e.currentTarget, () => checkAccount(def), 'Sprawdzam…') }, iconEl('checkCircle', 12), 'Sprawdź połączenie'),
      st.installed ? h('button', { class: 'btn sm', onclick: () => startAccountLogin(def, 'terminal') }, 'Otwórz logowanie w okienku') : null,
      h('button', { class: 'btn plain sm', onclick: () => browseProgram(def) }, iconEl('folder', 12), 'Wskaż program…'))));
}

async function browseProgram(def) {
  try {
    const f = await P.accounts.browse(def.id);
    if (!f) return;
    await saveSettings({ ai: { paths: { [def.id]: f } } }, true);
    await refreshAccounts([def.id]);
  } catch (e) { errToast(e); }
}

async function checkAccount(def) {
  await refreshAccounts([def.id]);
  let st = state.accounts[def.id];
  if (st && st.installed && !st.loggedIn && def.id === 'gemini') {
    // Antigravity CLI nie ma polecenia „status” – krótkie zapytanie testowe potwierdza logowanie
    try { await P.accounts.test('gemini'); await saveSettings({ ai: { connected: { gemini: true } } }, true); await refreshAccounts(['gemini']); st = state.accounts.gemini; } catch (_) { /* niezalogowany */ }
  }
  if (!st || !st.installed) toast(`Nie znaleziono programu ${def.program}. Zainstaluj go (krok 3) albo wskaż jego plik.`, 'error', 7000);
  else if (!st.loggedIn) toast(`${def.program} jest zainstalowany, ale nie jesteś zalogowany (krok 4).`, 'info', 7000);
  else { accUi(def.id).guide = false; toast(`Połączono z kontem ${def.name}`, 'success'); render(); }
}

function connectAccount(def) {
  const consent = (state.settings.ai.consent || {})[def.id];
  if (consent) return runConnect(def);
  const installed = (state.accounts[def.id] || {}).installed;
  const chk = h('input', { type: 'checkbox' });
  const goBtn = h('button', { class: 'btn primary', disabled: true }, iconEl('bolt', 13), installed ? 'Połącz' : 'Zainstaluj i połącz');
  chk.addEventListener('change', () => { goBtn.disabled = !chk.checked; });
  let sh = null;
  const guideBtn = h('button', { class: 'btn', onclick: () => { sh.close(); accUi(def.id).guide = true; render(); } }, iconEl('list', 13), 'Poprowadź mnie krok po kroku');
  sh = sheet({
    title: `Połącz z kontem ${def.name}`,
    subtitle: def.plan,
    body: h('div', { class: 'consent' },
      h('p', null, `Do połączenia potrzebny jest oficjalny, bezpłatny program ${def.program} od ${def.vendor}. Mogę zrobić wszystko za Ciebie albo poprowadzić Cię krok po kroku.`),
      h('div', { class: 'consent-box' },
        h('div', { class: 'consent-title' }, iconEl('wand', 14), 'Zrób to za mnie'),
        h('ol', { class: 'steps-list' },
          installed ? null : h('li', null, `Pobiorę i zainstaluję ${def.program} z oficjalnej strony ${def.vendor} – do Twojego folderu użytkownika, bez uprawnień administratora (ok. 1 minuty).`),
          h('li', null, def.id === 'gemini' ? 'Otworzę małe okienko logowania i stronę Google w przeglądarce – zalogujesz się swoim kontem Google.' : `Otworzę stronę logowania ${def.vendor} w przeglądarce – zalogujesz się swoim kontem.`),
          h('li', null, 'Sprawdzę połączenie i ustawię to konto do analizy aktów.')),
        h('label', { class: 'consent-check' }, chk, h('span', null, `Zgadzam się, aby aplikacja ${installed ? '' : `zainstalowała ${def.program} i `}przeprowadziła logowanie w moim imieniu.`))),
      h('div', { class: 'consent-note' }, iconEl('shield', 14), h('div', null,
        h('b', null, 'Twoje dane. '), `Hasło wpisujesz tylko na stronie ${def.vendor} – aplikacja go nie widzi i nie przechowuje. Do ${def.vendor} trafiają wyłącznie publiczne akty prawne i opis placówki z Ustawień, nigdy dane uczniów ani pracowników. `,
        def.free ? 'Na darmowych kontach dostawca może wykorzystywać przesłane treści do ulepszania modeli – możesz to wyłączyć w ' : 'Możesz sprawdzić ',
        h('a', { href: '#', onclick: (e) => { e.preventDefault(); P.openExternal(def.dataUrl); } }, 'ustawieniach prywatności konta'), '.')),
      h('div', { class: 'consent-actions' }, guideBtn, h('div', { class: 'spacer' }), goBtn)),
  });
  goBtn.addEventListener('click', async () => {
    sh.close();
    await saveSettings({ ai: { consent: { [def.id]: new Date().toISOString() } } }, true);
    runConnect(def);
  });
}

async function runConnect(def) {
  const A = accUi(def.id);
  A.guide = false;
  let st = state.accounts[def.id];
  try {
    if (!st || !st.installed) {
      A.installing = true; A.log = ''; render();
      st = state.accounts[def.id] = await P.accounts.install(def.id);
      A.installing = false;
    }
    if (st.loggedIn) { await syncConnected(); render(); return; }
    await startAccountLogin(def, 'auto');
  } catch (e) { A.installing = false; A.login = null; errToast(e); render(); }
}

async function startAccountLogin(def, mode) {
  const A = accUi(def.id);
  try {
    if (A.login) await P.accounts.cancel(def.id).catch(() => {});
    A.login = { stage: 'start', mode: def.id === 'gemini' ? 'terminal' : mode };
    render();
    await P.accounts.login(def.id, mode);
  } catch (e) { A.login = null; errToast(e); render(); }
}

function disconnectAccount(def) {
  sheet({
    title: `Odłączyć konto ${def.name}?`,
    body: h('p', { class: 'muted' }, def.id === 'gemini'
      ? 'Aplikacja przestanie korzystać z tego konta. Aby całkowicie wylogować program Antigravity CLI, uruchom w terminalu „agy” i wpisz /logout.'
      : `Program ${def.program} zostanie wylogowany z Twojego konta. Zmiany prawa i raporty pozostaną bez zmian.`),
    actions: [{ label: 'Anuluj' }, { label: 'Odłącz', kind: 'danger', onClick: async () => {
      try {
        await P.accounts.logout(def.id);
        await saveSettings({ ai: { connected: { [def.id]: false } } }, true);
        await refreshAccounts([def.id]);
        render();
      } catch (e) { errToast(e); }
    } }],
  });
}

function aiTestRow() {
  const status = h('div', { class: 'status-line' });
  const testBtn = h('button', { class: 'btn' }, iconEl('bolt', 14), 'Testuj analizę');
  testBtn.addEventListener('click', () => busy(testBtn, async () => {
    status.className = 'status-line'; status.replaceChildren(spinner(12), ' Analizuję przykładowy akt…');
    try { const r = await state.monitor.testAi(); status.className = 'status-line ok'; status.replaceChildren(iconEl('checkCircle', 14), r); } catch (e) { status.className = 'status-line bad'; status.replaceChildren(iconEl('warn', 14), e.message); }
  }, 'Testuję…'));
  return h('div', { class: 'group', style: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' } }, testBtn, status);
}

function keyRow(name, label, placeholder, url) {
  const input = h('input', { class: 'input', type: 'password', style: { width: '260px' }, placeholder: state.secrets[name] ? '•••••••• (zapisany)' : placeholder, autocomplete: 'off' });
  return [
    row(label, h('div', { class: 'btn-row' }, input,
      h('button', { class: 'btn', onclick: async () => {
        try { state.secrets[name] = await P.setSecret(name, input.value); toast(state.secrets[name] ? 'Zapisano klucz' : 'Usunięto klucz', 'success'); render(); } catch (e) { errToast(e); }
      } }, 'Zapisz')),
    { icon: 'key', color: state.secrets[name] ? 'var(--green)' : 'var(--text-3)', hint: state.secrets[name] ? 'Klucz zapisany. Zostaw pole puste i kliknij Zapisz, aby go usunąć.' : null }),
    row('Skąd wziąć klucz', h('button', { class: 'btn sm', onclick: () => P.openExternal(url) }, iconEl('globe', 12), new URL(url).hostname), { icon: 'globe', color: 'var(--teal)' }),
  ];
}

function apiKeyGroups() {
  const s = state.settings;
  const where = P.kind === 'desktop' ? 'Klucz jest szyfrowany przez system i nigdy nie trafia do okna aplikacji.' : 'Klucz jest zapisany tylko w pamięci tej aplikacji na telefonie.';
  return [
    group('Klucz API Gemini (darmowy poziom Google AI Studio)', [
      ...keyRow('gemini', 'Klucz', 'AIza…', 'https://aistudio.google.com/apikey'),
      row('Model', textInput(s.ai.geminiApiModel, (v) => saveSettings({ ai: { geminiApiModel: v.trim() || Engine.DEFAULT_GEMINI_MODEL } }), { width: '220px' }), { icon: 'sparkles', color: 'var(--purple)' }),
    ], `${where} Nie włączaj płatności w Google Cloud: bez niej przekroczenie darmowego limitu kończy się błędem, a nie opłatą.`),
    group('Klucz API Claude (płatny, rozliczany za zużycie)', [
      ...keyRow('anthropic', 'Klucz', 'sk-ant-…', 'https://platform.claude.com/settings/keys'),
      row('Model', select([{ value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (zalecany)' }, { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' }, { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 (najtańszy)' }], s.ai.apiModel, (v) => saveSettings({ ai: { apiModel: v } })), { icon: 'sparkles', color: 'var(--purple)' }),
    ], where),
  ];
}

function orderRows() {
  const ai = state.settings.ai;
  const order = Engine.migrateAiSettings(ai, P.kind).order;
  const move = async (i, d) => {
    const next = order.slice();
    [next[i], next[i + d]] = [next[i + d], next[i]];
    await saveSettings({ ai: { order: next } }, true);
    render();
  };
  return order.map((id, i) => {
    const def = accDef(id);
    const st = state.accounts[id] || {};
    return row(`${i + 1}. ${def.name}`, h('div', { class: 'btn-row' },
      h('span', { class: 'muted small' }, st.loggedIn ? 'połączone' : 'niepołączone'),
      h('button', { class: 'icon-btn', title: 'W górę', disabled: i === 0 ? true : null, onclick: () => move(i, -1), html: icon('arrowUp', 14) }),
      h('button', { class: 'icon-btn', title: 'W dół', disabled: i === order.length - 1 ? true : null, onclick: () => move(i, 1), html: icon('arrowDown', 14) })),
    { icon: def.icon, color: def.grad });
  });
}

function settingsAi() {
  const s = state.settings;

  if (P.kind !== 'desktop') {
    const p = s.ai.provider === 'api' ? 'api' : 'gemini-api';
    return h('div', null,
      group('Sposób analizy', [
        row('Analizuj przez', segmented([{ value: 'gemini-api', label: 'Klucz Gemini' }, { value: 'api', label: 'Klucz Claude' }], p, async (v) => { await saveSettings({ ai: { provider: v } }, true); render(); }), { icon: 'cpu', color: 'var(--accent)' }),
      ], 'Konta ChatGPT, Gemini i Claude łączy się w wersji na komputer (Windows, Linux). Na telefonie analizę wykonuje klucz API. Do modelu trafiają wyłącznie publiczne akty prawne.'),
      ...apiKeyGroups(),
      aiTestRow());
  }

  const anyConnected = ACCOUNTS.some((d) => state.accounts[d.id] && state.accounts[d.id].loggedIn);
  const usingKey = !isAccount(s.ai.provider);
  return h('div', null,
    h('section', { class: 'group' },
      h('h3', { class: 'group-title' }, 'Konta AI – połącz jedno lub kilka'),
      h('div', { class: 'group-body acc-list' }, ACCOUNTS.map(accountCard)),
      h('p', { class: 'group-footer' }, 'Kliknij „Połącz”: za Twoją zgodą aplikacja zainstaluje oficjalny program producenta i otworzy logowanie, albo poprowadzi Cię krok po kroku. Programy działają bez dostępu do plików na komputerze; do AI trafiają wyłącznie publiczne akty prawne i opis placówki.')),
    usingKey ? h('div', { class: 'connect-banner card' }, iconEl('key', 18), h('div', { style: { flex: 1 } },
      h('b', null, `Analiza korzysta z klucza: ${aiLabel()}`),
      h('div', { class: 'muted small' }, 'Zmienisz to w ustawieniach zaawansowanych albo klikając „Używaj” przy połączonym koncie.'))) : null,
    group('Działanie', [
      row('Gdy skończy się limit, użyj kolejnego połączonego konta', toggle(s.ai.fallback !== false, (v) => saveSettings({ ai: { fallback: v } }, true)), { icon: 'refresh', color: 'var(--indigo)', hint: 'Darmowe konta mają limity dzienne lub tygodniowe. Po ich wyczerpaniu skan sam przełączy się na następne połączone konto (kolejność w ustawieniach zaawansowanych).' }),
    ]),
    anyConnected || usingKey ? aiTestRow() : null,
    h('div', { class: 'group' }, h('button', { class: 'btn plain sm', onclick: () => { state.aiAdvanced = !state.aiAdvanced; render(); } }, iconEl(state.aiAdvanced ? 'chevronL' : 'chevronR', 12), state.aiAdvanced ? 'Ukryj ustawienia zaawansowane' : 'Ustawienia zaawansowane')),
    state.aiAdvanced ? h('div', null,
      group('Kolejność kont przy przełączaniu', orderRows()),
      group('Modele', [
        row('ChatGPT', textInput(s.ai.codexModel, (v) => saveSettings({ ai: { codexModel: v.trim() } }), { width: '200px', placeholder: 'domyślny dla konta' }), { icon: 'sparkles', color: '#10a37f', hint: 'Zostaw puste – darmowe konto użyje dostępnego modelu.' }),
        row('Google Gemini', textInput(s.ai.geminiModel, (v) => saveSettings({ ai: { geminiModel: v.trim() } }), { width: '200px', placeholder: 'automatyczny' }), { icon: 'brain', color: '#6b74ff', hint: 'Listę modeli pokazuje polecenie „agy models”.' }),
        row('Claude', select([{ value: 'sonnet', label: 'Sonnet (zalecany)' }, { value: 'opus', label: 'Opus (najdokładniejszy)' }, { value: 'haiku', label: 'Haiku (najszybszy)' }], s.ai.model, (v) => saveSettings({ ai: { model: v } })), { icon: 'speech', color: '#d97757' }),
      ]),
      group('Programy na tym komputerze', ACCOUNTS.map((d) => {
        const st = state.accounts[d.id] || {};
        return row(d.program, h('div', { class: 'btn-row' }, st.path ? h('span', { class: 'path', style: { maxWidth: '300px' } }, st.path) : h('span', { class: 'muted small' }, 'nie znaleziono'),
          h('button', { class: 'btn sm', onclick: () => browseProgram(d) }, 'Wskaż…')), { icon: 'folder', color: 'var(--orange)', hint: st.version || null });
      })),
      group('Klucz API zamiast konta', [
        row('Analizuj przez', segmented([{ value: 'account', label: 'Konto AI' }, { value: 'gemini-api', label: 'Klucz Gemini' }, { value: 'api', label: 'Klucz Claude' }], usingKey ? s.ai.provider : 'account', async (v) => {
          const next = v !== 'account' ? v : (ACCOUNTS.find((d) => state.accounts[d.id] && state.accounts[d.id].loggedIn) || ACCOUNTS[0]).id;
          await saveSettings({ ai: { provider: next } }, true); render();
        }), { icon: 'cpu', color: 'var(--accent)', hint: 'Klucz API przydaje się, gdy nie chcesz instalować programów producentów albo konta mają wyczerpane limity.' }),
      ]),
      ...apiKeyGroups()) : null);
}

function settingsScan() {
  const s = state.settings;
  const cfg = state.cfg;
  const hours = Array.from({ length: 17 }, (_, i) => i + 6).map((n) => ({ value: String(n), label: `${n}:00` }));
  return h('div', null,
    group('Automatyczny skan', [
      row('Skanuj codziennie sam', toggle(s.app.autoScan, (v) => saveSettings({ app: { autoScan: v } }, true)), { icon: 'refresh', color: 'var(--accent)',
        hint: P.kind === 'android' ? 'Na telefonie skan rusza po otwarciu aplikacji, jeśli tego dnia jeszcze go nie było.' : 'Raz dziennie, gdy aplikacja działa (także schowana w zasobniku).' }),
      row('Od godziny', select(hours, String(cfg.schedule.window.from), (v) => saveCfg({ schedule: { ...state.cfg.schedule, window: { ...state.cfg.schedule.window, from: Number(v) } } })), { icon: 'clock', color: 'var(--indigo)', hint: 'Jeśli o tej porze komputer był wyłączony, skan nadrobi się później tego samego dnia.' }),
      row('Powiadomienia o nowych zmianach', toggle(s.app.notifications, async (v) => { await saveSettings({ app: { notifications: v } }, true); if (v && P.requestNotifications) P.requestNotifications(); }), { icon: 'bell', color: 'var(--red)' }),
      P.kind === 'desktop' ? row('Działaj w tle po zamknięciu okna', toggle(s.app.runInBackground, (v) => saveSettings({ app: { runInBackground: v } }, true)), { icon: 'moon', color: 'var(--purple)', hint: 'Ikona w zasobniku systemowym, skąd zamkniesz aplikację całkowicie.' }) : null,
      P.kind === 'desktop' ? row('Uruchamiaj przy starcie systemu', toggle(s.app.autostart, async (v) => { try { await P.setAutostart(v); await saveSettings({ app: { autostart: v } }, true); } catch (e) { errToast(e); } }), { icon: 'bolt', color: 'var(--orange)' }) : null,
    ]),
    group('Zakres', [
      row('Pierwszy skan: dni wstecz', textInput(cfg.schedule.lookbackDays, (v) => saveCfg({ schedule: { ...state.cfg.schedule, lookbackDays: Math.max(1, Math.min(60, Number(v) || 7)) } }), { type: 'number', width: '90px', min: 1, max: 60 }), { icon: 'calendar', color: 'var(--teal)', hint: 'Każdy skan patrzy tyle dni wstecz; pozycje już widziane są pomijane.' }),
      row('Terminy w raporcie: dni naprzód', textInput(cfg.schedule.upcomingDays, (v) => saveCfg({ schedule: { ...state.cfg.schedule, upcomingDays: Math.max(1, Math.min(180, Number(v) || 30)) } }), { type: 'number', width: '90px', min: 1, max: 180 }), { icon: 'calendar', color: 'var(--green)' }),
      row('Próg trafności (słowa kluczowe)', textInput(cfg.filter.minScore, (v) => saveCfg({ filter: { ...state.cfg.filter, minScore: Math.max(1, Number(v) || 2) } }), { type: 'number', width: '90px', min: 1, max: 10 }), { icon: 'search', color: 'var(--orange)', hint: 'Niższy próg = więcej aktów trafia do analizy AI (dokładniej, ale drożej).' }),
    ]),
    group('Dane skanów', [
      row('Wyczyść historię', h('button', { class: 'btn danger sm', onclick: () => confirmReset() }, iconEl('trash', 13), 'Wyczyść'), { icon: 'trash', color: 'var(--red)', hint: 'Usuwa zmiany, raporty i listę widzianych aktów. Ustawienia placówki zostają.' }),
    ]));
}

function confirmReset() {
  sheet({
    title: 'Wyczyścić historię?',
    subtitle: 'Następny skan znów pobierze akty z ostatnich dni.',
    body: h('p', null, 'Usuniesz wszystkie zmiany (także ich stan i notatki), raporty i listę widzianych aktów. Zrób najpierw kopię danych, jeśli chcesz je zachować.'),
    actions: [{ label: 'Anuluj' }, { label: 'Wyczyść', kind: 'danger', onClick: async () => { await state.monitor.store.reset({ keepConfig: true }); await loadData(); render(); toast('Wyczyszczono historię', 'success'); } }],
  });
}

function listEditor({ items, onSave, fields, addLabel, emptyItem }) {
  const list = items.map((x) => ({ ...x }));
  const save = () => onSave(list.filter((x) => String(x.name || '').trim()));
  return h('div', null,
    group(null, list.map((it, i) => h('div', { class: 'row edit-row' },
      h('div', { class: 'edit-fields' }, fields.map((f) => f.type === 'toggle'
        ? h('label', { class: 'check' }, toggle(!!it[f.key], (v) => { it[f.key] = v; save(); }), h('span', null, f.label))
        : f.type === 'textarea'
          ? h('textarea', { class: 'input full', rows: 2, placeholder: f.label, value: it[f.key] || '', onchange: (e) => { it[f.key] = e.target.value; save(); } })
          : h('input', { class: 'input', style: { width: f.width || '260px' }, placeholder: f.label, value: it[f.key] || '', onchange: (e) => { it[f.key] = e.target.value.trim(); save(); } }))),
      h('button', { class: 'icon-btn', title: 'Usuń', onclick: async () => { list.splice(i, 1); await save(); render(); }, html: icon('trash', 15) })))),
    h('div', { class: 'group' }, h('button', { class: 'btn', onclick: async () => { list.push({ ...emptyItem }); await onSave(list); render(); } }, iconEl('plus', 14), addLabel)));
}

function settingsRoles() {
  return h('div', null,
    h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'AI przypisuje zadania wyłącznie do tych ról, używając dokładnie tych nazw. Zakres obowiązków pomaga trafnie dobrać osobę.'),
    listEditor({
      items: state.cfg.roles,
      fields: [{ key: 'name', label: 'Nazwa roli', width: '220px' }, { key: 'scope', label: 'Zakres obowiązków', type: 'textarea' }],
      addLabel: 'Dodaj rolę', emptyItem: { name: 'Nowa rola', scope: '' },
      onSave: (roles) => saveCfg({ roles: roles.filter((r) => r.name) }, true),
    }));
}

function settingsDocs() {
  return h('div', null,
    h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'Dokumenty szkoły, które AI może wskazać do aktualizacji. Zaznacz te, których zmiana wymaga uchwały rady pedagogicznej.'),
    listEditor({
      items: state.cfg.documents,
      fields: [{ key: 'name', label: 'Nazwa dokumentu', width: '320px' }, { key: 'needsCouncil', label: 'Wymaga uchwały rady', type: 'toggle' }],
      addLabel: 'Dodaj dokument', emptyItem: { name: 'Nowy dokument', needsCouncil: false },
      onSave: (docs) => saveCfg({ documents: docs.filter((d) => d.name) }, true),
    }));
}

function settingsRules() {
  const cfg = state.cfg;
  const saveRule = async (r, patch) => {
    const cur = (await state.monitor.store.getConfig()) || {};
    const list = (cur.rules || []).filter((x) => x.id !== r.id);
    await saveCfg({ rules: [...list, { ...r, ...patch }] }, true);
  };
  const kwGroups = Object.entries(cfg.keywords);
  const KW_LABEL = { education: 'Słowa oświatowe', supporting: 'Słowa wspierające', administrative: 'Słowa administracyjne', exclude: 'Wykluczenia' };
  return h('div', null,
    group('Reguły priorytetu', cfg.rules.map((r) => row(r.label,
      h('div', { class: 'btn-row' },
        r.num != null ? h('input', { class: 'input', type: 'number', style: { width: '76px' }, value: r.num, onchange: (e) => saveRule(r, { num: Number(e.target.value) || r.num }) }) : null,
        select([{ value: 'hi', label: 'Wysoki' }, { value: 'mid', label: 'Średni' }, { value: 'lo', label: 'Niski' }], r.prio, (v) => saveRule(r, { prio: v })),
        toggle(r.on !== false, (v) => saveRule(r, { on: v }))),
      { icon: 'flag', color: `var(--${PRIORITY_CHIP[r.prio] === 'teal' ? 'teal' : PRIORITY_CHIP[r.prio]})` })),
    'Gdy pasuje kilka reguł, wygrywa najwyższy priorytet.'),
    group('Słowa kluczowe', kwGroups.map(([k, words]) => row(KW_LABEL[k] || k,
      h('textarea', { class: 'input full', rows: 3, value: (words || []).join(', '), onchange: (e) => saveCfg({ keywords: { ...state.cfg.keywords, [k]: e.target.value.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) } }) }),
      { icon: 'search', color: 'var(--accent)', stack: true })), 'Wpisuj początki słów, np. „nauczyciel” pasuje też do „nauczycieli”. Oddzielaj przecinkami.'),
    group('Akty obserwowane', [
      ...cfg.watchedActs.map((w, i) => row(w.name, h('div', { class: 'btn-row' }, h('span', { class: 'mono muted' }, w.eli),
        h('button', { class: 'icon-btn', title: 'Usuń', html: icon('trash', 14), onclick: async () => { await saveCfg({ watchedActs: state.cfg.watchedActs.filter((_, j) => j !== i) }, true); render(); } })), { icon: 'book', color: 'var(--indigo)' })),
      row('Dodaj akt', (() => {
        const eli = h('input', { class: 'input', style: { width: '140px' }, placeholder: 'DU/2017/59' });
        const name = h('input', { class: 'input', style: { width: '200px' }, placeholder: 'Nazwa' });
        return h('div', { class: 'btn-row' }, eli, name, h('button', { class: 'btn sm', onclick: async () => {
          if (!/^(DU|MP)\/\d{4}\/\d+$/.test(eli.value.trim())) { toast('Podaj oznaczenie w formacie DU/rok/pozycja', 'error'); return; }
          await saveCfg({ watchedActs: [...state.cfg.watchedActs, { eli: eli.value.trim(), name: name.value.trim() || eli.value.trim() }] }, true); render();
        } }, iconEl('plus', 12), 'Dodaj'));
      })(), { icon: 'plus', color: 'var(--green)', stack: state.mobile }),
    ], 'Ustawa zmieniająca „niektóre inne ustawy” często nie ma w tytule nic o oświacie: silnik sprawdza też, czy akt zmienia któryś z tych aktów.'));
}

window.addEventListener('DOMContentLoaded', () => { init().catch((e) => { console.error(e); document.getElementById('content').textContent = 'Nie udało się uruchomić aplikacji: ' + e.message; }); });

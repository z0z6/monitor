'use strict';
// Proces główny Electrona (Windows, Linux). Interfejs i silnik skanu działają w oknie (www/),
// a tutaj są tylko rzeczy, których okno nie może zrobić samo: pobieranie stron bez blokad CORS,
// zapis plików, zaszyfrowane klucze API, programy kont AI (ChatGPT, Gemini, Claude), zasobnik i powiadomienia.
const { app, BrowserWindow, ipcMain, dialog, shell, Notification, Tray, Menu, nativeImage, nativeTheme, safeStorage, net } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Accounts } = require('./accounts');
const { DEFS, ACCOUNT_IDS, SAFE_MODEL, createProvider, runWithFallback } = require('./ai/providers');
const cliTools = require('./ai/cli-tools');

const APP_NAME = 'Monitor prawa';
app.setName(APP_NAME);
app.commandLine.appendSwitch('lang', 'pl');
if (process.platform === 'win32') app.setAppUserModelId('pl.projektnumer4.monitorprawa');

// Wersja portable (Windows): dane obok pliku .exe
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
const dataDir = process.env.MONITOR_DATA_DIR || (portableDir ? path.join(portableDir, `${APP_NAME} - dane`) : path.join(app.getPath('userData'), 'dane'));
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

if (!process.env.APP_SHOTS && !app.requestSingleInstanceLock()) app.quit();

let win = null;
let tray = null;
let quitting = false;
let accounts = null;

// ─────────────────────────── pliki danych ───────────────────────────
const KV_NAMES = new Set(['state', 'settings']);
const kvFile = (name) => path.join(dataDir, `${name}.json`);

// Zapis atomowy: nowy plik powstaje obok, poprzednia wersja zostaje jako .bak (zmiana nazwy, bez kopiowania danych).
// Zapisy do jednego pliku idą po kolei, żeby dwa równoległe nie nadpisały się nawzajem.
const writeQueues = new Map();
function writeAtomic(file, text) {
  const run = async () => {
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, text, { mode: 0o600 });
    try { await fs.promises.rename(file, `${file}.bak`); } catch (_) { /* pierwszy zapis: brak poprzedniej wersji */ }
    await fs.promises.rename(tmp, file);
  };
  const next = (writeQueues.get(file) || Promise.resolve()).then(run, run);
  writeQueues.set(file, next.catch(() => {}));
  return next;
}

function kvGet(name) {
  if (!KV_NAMES.has(name)) throw new Error('Nieznany magazyn');
  for (const f of [kvFile(name), `${kvFile(name)}.bak`]) {
    try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { /* następny */ }
  }
  return null;
}

async function kvSet(name, json) {
  if (!KV_NAMES.has(name)) throw new Error('Nieznany magazyn');
  if (typeof json !== 'string' || json.length > 200 * 1024 * 1024) throw new Error('Niepoprawne dane');
  JSON.parse(json); // walidacja: na dysk trafia wyłącznie poprawny JSON
  await writeAtomic(kvFile(name), json);
  return true;
}

// Ustawienia zapisuje okno (settings.json); proces główny tylko je czyta.
const SETTINGS_DEFAULTS = {
  ai: { provider: 'codex', fallback: true, order: [...ACCOUNT_IDS], connected: {}, paths: {}, model: 'sonnet', codexModel: '', geminiModel: '', claudePath: '' },
  ui: { theme: 'system' },
  app: { runInBackground: true, autostart: false, notifications: true },
};
// Modele i ścieżki programów trafiają do wiersza poleceń, więc przyjmujemy tylko bezpieczne wartości
// (na Windows pliki .cmd uruchamiają się przez powłokę, gdzie znaki & | ^ " miałyby specjalne znaczenie).
function settings() {
  const s = kvGet('settings') || {};
  const ai = { ...SETTINGS_DEFAULTS.ai, ...(s.ai || {}) };
  for (const k of ['model', 'codexModel', 'geminiModel']) if (ai[k] && !SAFE_MODEL.test(String(ai[k]))) ai[k] = SETTINGS_DEFAULTS.ai[k];
  const paths = {};
  for (const id of ACCOUNT_IDS) {
    const p = (ai.paths || {})[id] || (id === 'claude-code' ? ai.claudePath : '');
    if (p && cliTools.isAllowedBinary(DEFS[id], p)) paths[id] = p;
  }
  ai.paths = paths;
  ai.claudePath = '';
  ai.connected = { ...(ai.connected || {}) };
  return {
    ai,
    ui: { ...SETTINGS_DEFAULTS.ui, ...(s.ui || {}) },
    app: { ...SETTINGS_DEFAULTS.app, ...(s.app || {}) },
  };
}

// ─────────────────────────── klucze API ───────────────────────────
// Klucze są szyfrowane systemowo (safeStorage) i nigdy nie trafiają do okna:
// okno wysyła znacznik __SECRET:nazwa__, a proces główny podstawia klucz tuż przed wysłaniem zapytania.
const SECRET_HOSTS = { anthropic: 'api.anthropic.com', gemini: 'generativelanguage.googleapis.com' };
const secretFile = (name) => path.join(dataDir, `klucz-${name}.bin`);

function getSecret(name) {
  if (!SECRET_HOSTS[name]) return null;
  try {
    const raw = fs.readFileSync(secretFile(name));
    if (raw.slice(0, 4).toString() === 'b64:') return Buffer.from(raw.slice(4).toString(), 'base64').toString('utf8');
    return safeStorage.decryptString(raw);
  } catch (_) { return null; }
}

function setSecret(name, value) {
  if (!SECRET_HOSTS[name]) throw new Error('Nieznany klucz');
  const v = String(value || '').trim();
  if (!v) { try { fs.unlinkSync(secretFile(name)); } catch (_) { /* brak */ } return false; }
  // Bez systemowego magazynu kluczy (np. Linux bez keyringa) klucz jest tylko zakodowany: chroni go wtedy
  // wyłącznie dostęp do konta użytkownika (plik z prawami 0600).
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(v) : 'b64:' + Buffer.from(v, 'utf8').toString('base64');
  fs.writeFileSync(secretFile(name), data, { mode: 0o600 });
  return true;
}

function fillSecrets(url, headers) {
  const u = new URL(url);
  const out = {};
  let secret = false;
  for (const [k, v] of Object.entries(headers || {})) {
    if (typeof v !== 'string') continue;
    const m = v.match(/^__SECRET:(\w+)__$/);
    if (!m) { out[k] = v; continue; }
    if (SECRET_HOSTS[m[1]] !== u.hostname || u.protocol !== 'https:') throw new Error('Klucz API może trafić wyłącznie do swojego serwisu.');
    const key = getSecret(m[1]);
    if (!key) throw new Error('Brak zapisanego klucza API. Wpisz go w Ustawieniach → AI.');
    out[k] = key;
    secret = true;
  }
  return { headers: out, secret };
}

// ─────────────────────────── pobieranie stron ───────────────────────────
// Okno może poprosić tylko o publiczne adresy http(s): bez adresów lokalnych i sieci domowej/firmowej
// (gdyby ktoś wstrzyknął skrypt do okna, nie dostanie się przez aplikację do routera ani usług na komputerze).
const MAX_RESPONSE_BYTES = 30 * 1024 * 1024;
const METHODS = new Set(['GET', 'POST', 'HEAD']);
function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h === '0.0.0.0') return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
}

async function readLimited(res, limit) {
  const len = Number(res.headers.get('content-length') || 0);
  if (len > limit) throw Object.assign(new Error(`plik zbyt duży (${Math.round(len / 1048576)} MB), analiza tylko na podstawie metadanych`), { tooLarge: true });
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > limit) throw Object.assign(new Error(`plik zbyt duży (ponad ${Math.round(limit / 1048576)} MB), analiza tylko na podstawie metadanych`), { tooLarge: true });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)), total);
}

async function httpFetch(url, { method = 'GET', headers = {}, body, binary = false, timeoutMs = 90000, connectTimeoutMs = 20000, maxBytes } = {}) {
  let u;
  try { u = new URL(url); } catch (_) { throw new Error('Niepoprawny adres'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Dozwolone są tylko adresy http(s)');
  if (isPrivateHost(u.hostname)) throw new Error('Adresy lokalne i sieci wewnętrznej są zablokowane');
  const m = String(method).toUpperCase();
  if (!METHODS.has(m)) throw new Error('Niedozwolona metoda HTTP');
  const filled = fillSecrets(url, headers);
  const clamp = (v, d) => Math.min(Math.max(Number(v) || d, 1000), 10 * 60 * 1000);
  const ctl = new AbortController();
  // Dwa limity: na pierwszą odpowiedź serwera (martwy serwer wykrywamy szybko) i na całe pobranie (duże PDF-y).
  let phase = 'connect';
  const connectMs = clamp(connectTimeoutMs, 20000);
  const connectTimer = setTimeout(() => ctl.abort(), connectMs);
  const timer = setTimeout(() => ctl.abort(), clamp(timeoutMs, 90000));
  try {
    // Zapytanie z kluczem API nie może pójść za przekierowaniem: klucz trafiłby pod inny adres.
    const res = await net.fetch(url, { method: m, headers: filled.headers, body, signal: ctl.signal, redirect: filled.secret ? 'error' : 'follow' });
    phase = 'body';
    clearTimeout(connectTimer);
    if (res.redirected && isPrivateHost(new URL(res.url).hostname)) throw new Error('Przekierowanie na adres lokalny zostało zablokowane');
    const h = {};
    res.headers.forEach((v, k) => { h[k] = v; });
    const limit = Math.min(Number(maxBytes) || MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
    const buf = m === 'HEAD' ? Buffer.alloc(0) : await readLimited(res, limit);
    // Dane binarne idą do okna jako bajty (bez kodowania base64 w obie strony).
    if (binary && res.ok) return { status: res.status, headers: h, bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
    return { status: res.status, headers: h, text: buf.toString('utf8') };
  } catch (e) {
    if (e.tooLarge) return { status: 0, headers: {}, tooLarge: true, error: e.message };
    if (e.name === 'AbortError' || ctl.signal.aborted) {
      throw new Error(phase === 'connect' ? `brak odpowiedzi serwera w ciągu ${Math.round(connectMs / 1000)} s` : `przekroczono limit czasu ${timeoutMs} ms`);
    }
    throw new Error(e.message || String(e));
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(timer);
  }
}

// ─────────────────────────── okno ───────────────────────────
function emit(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const iconPath = () => path.join(__dirname, '..', 'www', 'icon.png');

function notify(title, body) {
  if (!settings().app.notifications || !Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath() });
  n.on('click', () => { showWindow(); emit('nav', { view: 'changes' }); });
  n.show();
}

function createWindow() {
  const isMac = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#f5f5f7',
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false, // automatyczny skan działa też przy oknie schowanym w zasobniku
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'www', 'index.html'));
  win.once('ready-to-show', () => { if (!process.argv.includes('--hidden')) win.show(); });
  if (process.env.APP_SHOTS) {
    win.webContents.on('console-message', (...a) => { const e = a[0]; console.log('[okno]', e && e.message ? e.message : a.slice(1).join(' ')); });
    win.webContents.once('did-finish-load', () => devScreenshots(process.env.APP_SHOTS));
  }
  win.on('close', (e) => {
    if (!quitting && settings().app.runInBackground && tray) {
      e.preventDefault();
      win.hide();
      const st = kvGet('settings') || {};
      if (!(st.hints && st.hints.tray)) {
        kvSet('settings', JSON.stringify({ ...st, hints: { ...(st.hints || {}), tray: true } })).catch(() => {});
        notify(`${APP_NAME} działa w tle`, 'Codzienny skan prawa uruchomi się sam. Aplikację zamkniesz z menu ikony w zasobniku.');
      }
    }
  });
  win.on('maximize', () => emit('window:state', { maximized: true }));
  win.on('unmaximize', () => emit('window:state', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href);
  } catch (_) { /* niepoprawny adres */ }
}

// Tryb deweloperski: zrzuty ekranu widoków (APP_SHOTS=katalog, APP_STEPS="nazwa=<JS>,...")
async function devScreenshots(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  fs.mkdirSync(dir, { recursive: true });
  const steps = (process.env.APP_STEPS || 'pulpit').split(',');
  const [sw, sh] = (process.env.APP_SIZE || '1320x860').split('x').map(Number);
  win.setMinimumSize(320, 480);
  win.setSize(sw, sh);
  await wait(1800);
  for (const step of steps) {
    const [name, js] = step.split('=');
    if (js) await win.webContents.executeJavaScript(decodeURIComponent(js)).catch((e) => console.error(e));
    await wait(1000);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
  }
  quitting = true;
  app.quit();
}

function showWindow() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

function createTray() {
  try {
    const img = nativeImage.createFromPath(iconPath()).resize({ width: 22, height: 22 });
    tray = new Tray(img);
    tray.setToolTip(APP_NAME);
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: `Otwórz ${APP_NAME}`, click: showWindow },
      { label: 'Skanuj teraz', click: () => emit('scan:request', { reason: 'z zasobnika' }) },
      { type: 'separator' },
      { label: 'Zakończ', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  } catch (_) { tray = null; }
}

// ─────────────────────────── autostart ───────────────────────────
function applyAutostart(on) {
  if (process.platform === 'linux') {
    const dir = path.join(os.homedir(), '.config', 'autostart');
    const file = path.join(dir, 'monitor-prawa.desktop');
    const exe = process.env.APPIMAGE || process.execPath;
    if (on) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nExec="${exe}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    } else {
      try { fs.unlinkSync(file); } catch (_) { /* brak */ }
    }
    return on;
  }
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setLoginItemSettings({ openAtLogin: !!on, path: exe, args: ['--hidden'] });
  return on;
}

function applySettings() {
  const s = settings();
  nativeTheme.themeSource = s.ui.theme || 'system';
}

// ─────────────────────────── IPC ───────────────────────────
function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try { return { ok: true, data: await fn(...args) }; } catch (err) { return { ok: false, error: err.message || String(err) }; }
  });
}

function registerIpc() {
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    kind: 'desktop',
    dataDir,
    portable: !!portableDir,
    shots: !!process.env.APP_SHOTS,
  }));

  handle('window:control', (action) => {
    if (!win) return false;
    if (action === 'close') { win.close(); return false; }
    if (action === 'minimize') { win.minimize(); return win.isMaximized(); }
    if (action === 'maximize') {
      const target = !win.isMaximized(); // Linux maksymalizuje asynchronicznie: zwracamy stan docelowy
      if (target) win.maximize(); else win.unmaximize();
      return target;
    }
    return win.isMaximized();
  });

  handle('kv:get', (name) => kvGet(name));
  handle('kv:set', (name, json) => kvSet(name, json));
  handle('settings:changed', () => { applySettings(); return true; });
  handle('autostart:set', (on) => applyAutostart(on));

  handle('secret:has', (name) => !!getSecret(name));
  handle('secret:set', (name, value) => setSecret(name, value));

  handle('http:fetch', (url, opts) => httpFetch(url, opts));
  handle('notify', (title, body) => { notify(title, body); return true; });

  // Analiza przez konto AI: wybrane konto, a przy wyczerpanym limicie – kolejne połączone (Ustawienia → AI).
  handle('ai:run', (req) => runWithFallback(settings(), req));
  // konta AI (ChatGPT / Gemini / Claude) – instalacja, logowanie, stan
  const accId = (id) => { if (!ACCOUNT_IDS.includes(id)) throw new Error('Nieznane konto AI.'); return id; };
  handle('account:test', (id) => createProvider(accId(id), settings()).test());
  handle('account:status', (id) => accounts.status(accId(id)));
  handle('account:install', (id) => accounts.install(accId(id)));
  handle('account:login', (id, mode) => accounts.startLogin(accId(id), ['auto', 'device', 'terminal'].includes(mode) ? mode : 'auto'));
  handle('account:code', (id, code) => accounts.submitCode(accId(id), code));
  handle('account:cancel', (id) => { accounts.cancelLogin(accId(id)); return true; });
  handle('account:logout', (id) => accounts.logout(accId(id)));
  handle('account:browse', async (id) => {
    const def = DEFS[accId(id)];
    const r = await dialog.showOpenDialog(win, { title: `Wskaż program ${def.program}`, properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    if (!cliTools.isAllowedBinary(def, r.filePaths[0])) throw new Error(`To nie jest program ${def.program} (oczekiwano pliku ${def.cmd}, ${def.cmd}.exe lub ${def.cmd}.cmd).`);
    return r.filePaths[0];
  });

  handle('file:save', async ({ title, name, text, ext = 'json' }) => {
    const r = await dialog.showSaveDialog(win, { title, defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, text);
    return r.filePath;
  });
  handle('file:open', async ({ title, ext = 'json' }) => {
    const r = await dialog.showOpenDialog(win, { title, filters: [{ name: ext.toUpperCase(), extensions: [ext] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return fs.readFileSync(r.filePaths[0], 'utf8');
  });
  handle('shell:openExternal', (url) => { openExternalSafe(url); return true; });
  handle('shell:openData', () => shell.openPath(dataDir));
}

app.on('second-instance', () => showWindow());

app.whenReady().then(() => {
  const { session } = require('electron');
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  applySettings();
  cliTools.refreshPath();
  accounts = new Accounts({ getSettings: settings, emit });
  registerIpc();
  createWindow();
  if (!process.env.APP_SHOTS) createTray();
  app.on('activate', showWindow);
});

app.on('before-quit', () => {
  quitting = true;
  if (accounts) accounts.cancelAll();
  cliTools.killAll();
  if (tray) { try { tray.destroy(); } catch (_) { /* ignore */ } }
});
app.on('window-all-closed', () => {
  if (!settings().app.runInBackground || !tray) app.quit();
});

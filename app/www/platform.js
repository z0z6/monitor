'use strict';
/* global Cap */
// Warstwa platformy: ten sam interfejs dla komputera (Electron, window.desktop z preload.js),
// Androida (Capacitor: natywny HTTP, pamięć aplikacji, powiadomienia) i zwykłej przeglądarki (tylko do podglądu).

(function () {
  const D = window.desktop;
  const native = !D && typeof Cap !== 'undefined' && Cap.Capacitor && Cap.Capacitor.isNativePlatform();
  const kind = D ? 'desktop' : native ? 'android' : 'web';

  const desktop = D && {
    kind,
    info: () => D.info(),
    kvGet: async (name) => D.kvGet(name),
    kvSet: (name, obj) => D.kvSet(name, typeof obj === 'string' ? obj : JSON.stringify(obj)),
    fetch: (url, o) => D.fetch(url, o),
    // Klucz zostaje w procesie głównym; silnik dostaje tylko znacznik, który proces główny podmienia przy wysyłce.
    secret: async (name) => ((await D.hasSecret(name)) ? `__SECRET:${name}__` : null),
    hasSecret: (name) => D.hasSecret(name),
    setSecret: (name, v) => D.setSecret(name, v),
    notify: (t, b) => D.notify(t, b).catch(() => {}),
    // Konta AI (ChatGPT, Gemini, Claude) przez oficjalne programy na komputerze – tylko w wersji na komputer.
    aiRun: (req) => D.aiRun(req),
    accounts: {
      status: (id) => D.accountStatus(id), install: (id) => D.accountInstall(id), login: (id, mode) => D.accountLogin(id, mode),
      code: (id, c) => D.accountCode(id, c), cancel: (id) => D.accountCancel(id), logout: (id) => D.accountLogout(id),
      browse: (id) => D.accountBrowse(id), test: (id) => D.accountTest(id),
    },
    settingsChanged: () => D.settingsChanged(),
    setAutostart: (on) => D.setAutostart(on),
    saveFile: (o) => D.saveFile(o),
    openFile: (o) => D.openFile(o),
    openExternal: (u) => D.openExternal(u),
    openData: () => D.openData(),
    windowControl: (a) => D.windowControl(a),
    on: (ch, fn) => D.on(ch, fn),
    onResume: () => {},
  };

  let notifId = 1;
  const android = native && {
    kind,
    info: async () => {
      const i = await Cap.App.getInfo().catch(() => ({}));
      return { version: i.version || '', platform: 'android', kind, dataDir: 'pamięć aplikacji', portable: false };
    },
    kvGet: async (name) => {
      try {
        const r = await Cap.Filesystem.readFile({ path: `${name}.json`, directory: Cap.Directory.Data, encoding: Cap.Encoding.UTF8 });
        return JSON.parse(r.data);
      } catch (_) { return null; }
    },
    kvSet: async (name, obj) => {
      const data = typeof obj === 'string' ? obj : JSON.stringify(obj);
      await Cap.Filesystem.writeFile({ path: `${name}.tmp.json`, data, directory: Cap.Directory.Data, encoding: Cap.Encoding.UTF8 });
      await Cap.Filesystem.rename({ from: `${name}.tmp.json`, to: `${name}.json`, directory: Cap.Directory.Data, toDirectory: Cap.Directory.Data });
      return true;
    },
    fetch: async (url, o = {}) => {
      const r = await Cap.CapacitorHttp.request({
        url, method: o.method || 'GET', headers: o.headers || {},
        data: o.body != null ? (typeof o.body === 'string' ? o.body : JSON.stringify(o.body)) : undefined,
        responseType: o.binary ? 'arraybuffer' : 'text',
        connectTimeout: o.connectTimeoutMs || 20000, readTimeout: o.timeoutMs || 90000,
      });
      if (o.binary && r.status >= 200 && r.status < 300) return { status: r.status, headers: r.headers || {}, base64: r.data };
      return { status: r.status, headers: r.headers || {}, text: typeof r.data === 'string' ? r.data : JSON.stringify(r.data) };
    },
    secret: async (name) => (await Cap.Preferences.get({ key: `secret.${name}` })).value || null,
    hasSecret: async (name) => !!(await Cap.Preferences.get({ key: `secret.${name}` })).value,
    setSecret: async (name, v) => {
      const val = String(v || '').trim();
      if (val) await Cap.Preferences.set({ key: `secret.${name}`, value: val }); else await Cap.Preferences.remove({ key: `secret.${name}` });
      return !!val;
    },
    notify: async (title, body) => {
      try {
        const p = await Cap.LocalNotifications.checkPermissions();
        if (p.display !== 'granted') { const r = await Cap.LocalNotifications.requestPermissions(); if (r.display !== 'granted') return; }
        await Cap.LocalNotifications.schedule({ notifications: [{ id: (Date.now() % 100000) * 10 + (notifId++ % 10), title, body }] });
      } catch (e) { console.error('Powiadomienie nie powiodło się', e); }
    },
    requestNotifications: async () => { try { return (await Cap.LocalNotifications.requestPermissions()).display === 'granted'; } catch (_) { return false; } },
    aiRun: null,
    accounts: null,
    settingsChanged: async () => true,
    setAutostart: async () => false,
    saveFile: async ({ name, text }) => {
      const r = await Cap.Filesystem.writeFile({ path: name, data: text, directory: Cap.Directory.Documents, encoding: Cap.Encoding.UTF8, recursive: true });
      return r.uri ? `Dokumenty/${name}` : name;
    },
    openFile: () => pickTextFile(),
    openExternal: async (u) => { if (/^https?:\/\//.test(u)) { const a = document.createElement('a'); a.href = u; a.rel = 'noopener'; a.click(); } },
    openData: async () => false,
    windowControl: async () => false,
    on: (ch, fn) => {
      if (ch === 'nav') Cap.LocalNotifications.addListener('localNotificationActionPerformed', () => fn({ view: 'changes' }));
      return () => {};
    },
    onResume: (fn) => Cap.App.addListener('appStateChange', (s) => { if (s.isActive) fn(); }),
  };

  // Przeglądarka (podgląd interfejsu bez aplikacji). Źródła mogą być niedostępne przez CORS.
  const web = {
    kind,
    info: async () => ({ version: 'web', platform: 'web', kind, dataDir: 'localStorage', portable: false }),
    kvGet: async (name) => { try { return JSON.parse(localStorage.getItem(`monitor.${name}`)); } catch (_) { return null; } },
    kvSet: async (name, obj) => { localStorage.setItem(`monitor.${name}`, typeof obj === 'string' ? obj : JSON.stringify(obj)); return true; },
    fetch: async (url, o = {}) => {
      const r = await fetch(url, { method: o.method || 'GET', headers: o.headers, body: o.body });
      const headers = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      if (o.binary && r.ok) return { status: r.status, headers, bytes: new Uint8Array(await r.arrayBuffer()) };
      return { status: r.status, headers, text: await r.text() };
    },
    secret: async (name) => localStorage.getItem(`monitor.secret.${name}`),
    hasSecret: async (name) => !!localStorage.getItem(`monitor.secret.${name}`),
    setSecret: async (name, v) => { if (v) localStorage.setItem(`monitor.secret.${name}`, v); else localStorage.removeItem(`monitor.secret.${name}`); return !!v; },
    notify: async () => {},
    aiRun: null,
    accounts: null,
    settingsChanged: async () => true,
    setAutostart: async () => false,
    saveFile: async ({ name, text }) => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' })); a.download = name; a.click(); return name; },
    openFile: () => pickTextFile(),
    openExternal: async (u) => { window.open(u, '_blank', 'noopener'); },
    openData: async () => false,
    windowControl: async () => false,
    on: () => () => {},
    onResume: () => {},
  };

  function pickTextFile() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.onchange = () => { const f = input.files[0]; if (!f) return resolve(null); f.text().then(resolve, () => resolve(null)); };
      input.click();
    });
  }

  window.P = desktop || android || web;
})();

'use strict';
// Testy logiki aplikacji bez Electrona i bez internetu: npm test (w folderze app)
// Silnik (www/engine.js) jest ładowany tak jak w przeglądarce, a zapytania HTTP obsługują dane testowe z ../test/fixtures.
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.join(__dirname, '..');
const fixtures = path.join(root, '..', 'test', 'fixtures');
const manifest = JSON.parse(fs.readFileSync(path.join(fixtures, 'manifest.json'), 'utf8'));

function loadEngine() {
  const ctx = { console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Intl, Date, URL, URLSearchParams, structuredClone };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(root, 'www', 'engine.js'), 'utf8'), ctx, { filename: 'engine.js' });
  return ctx.Engine;
}

// Odpowiedź konta AI w testach (zamiast prawdziwego ChatGPT/Gemini/Claude): akt dotyczy placówki.
const CANNED = JSON.stringify({ relevant: true, relevance_reason: 'test', summary: 'Streszczenie testowe', what_changes: 'zmiana', affects_school: 'yes', status: 'obowiazuje', effective_date: null, requires_statute_change: false, requires_council_resolution: false, documents_to_update: [], roles: [{ role: 'Dyrektor', action: 'Sprawdzić akt.', deadline: null }], legal_basis: 'test', confidence: 'medium', review_note: null });

function fixturePlatform(Engine, { settings = { ai: { provider: 'codex', v: 2 } } } = {}) {
  let saved = null;
  const requests = [];
  const aiCalls = [];
  return {
    saved: () => saved,
    requests,
    aiCalls,
    settings,
    platform: {
      async aiRun(req) { aiCalls.push(req); return { text: CANNED, provider: 'ChatGPT (Codex CLI)', id: 'codex' }; },
      async fetch(url, o = {}) {
        requests.push(url);
        const e = manifest[url];
        if (!e) return { status: 404, headers: {}, text: 'brak danych testowych' };
        if (e.error) throw new Error(e.error);
        const buf = fs.readFileSync(path.join(fixtures, e.file));
        return o.binary ? { status: 200, headers: {}, base64: buf.toString('base64') } : { status: 200, headers: {}, text: buf.toString('utf8') };
      },
      async loadState() { return saved ? JSON.parse(saved) : null; },
      async saveState(json) { saved = json; },
      async secret() { return null; },
      notify() {},
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('base64: kodowanie i dekodowanie bajtów', () => {
  const E = loadEngine();
  for (const n of [0, 1, 2, 3, 4, 5, 255, 1000]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);
    const b64 = E.bytesToBase64(bytes);
    assert.strictEqual(b64, Buffer.from(bytes).toString('base64'), `dł. ${n}`);
    assert.deepStrictEqual(Array.from(E.base64ToBytes(b64)), Array.from(bytes));
  }
});

test('skan na danych testowych (konto AI – atrapa) zapisuje zmiany, raport i historię', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  const sum = await m.scan({ reason: 'test', now: '2026-10-02T15:40:00Z' });
  assert.strictEqual(sum.date, '2026-10-02');
  assert.ok(sum.fresh.length > 0, 'powinny być nowe zmiany');
  assert.ok(sum.health.length >= 5, 'raport o źródłach');
  const changes = await m.store.listChanges();
  assert.ok(changes.every((c) => c.workflow === 'new'));
  assert.ok(changes.every((c) => ['hi', 'mid', 'lo'].includes(c.priority)));
  assert.ok(await m.store.getReport('2026-10-02'), 'raport zapisany');
  assert.strictEqual((await m.store.listRuns()).length, 1);
  assert.ok(fx.saved(), 'stan zapisany przez platformę');
  // drugi skan tego samego dnia nie dubluje zmian
  const again = await m.scan({ reason: 'test', now: '2026-10-02T16:10:00Z' });
  assert.strictEqual(again.fresh.length, 0);
});

test('stan zmiany (workflow) przetrwa ponowny zapis zmiany przez silnik', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  await m.scan({ now: '2026-10-02T15:40:00Z' });
  const [c] = await m.store.listChanges();
  await m.store.updateChange(c.key, { workflow: 'done', note: 'zrobione' });
  await m.store.saveChange({ ...c, summary: 'nowe' });
  const after = await m.store.getChange(c.key);
  assert.strictEqual(after.workflow, 'done');
  assert.strictEqual(after.note, 'zrobione');
  assert.ok(after.handled_at);
});

test('isDue: przed oknem nie, po oknie tak, po skanie nie', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  assert.strictEqual(await m.isDue(new Date('2026-10-02T12:00:00Z')), false); // 14:00 w Warszawie
  assert.strictEqual(await m.isDue(new Date('2026-10-02T19:30:00Z')), true); // 21:30, nadrabia po oknie
  await m.scan({ now: '2026-10-02T15:40:00Z' });
  assert.strictEqual(await m.isDue(new Date('2026-10-02T19:30:00Z')), false);
});

test('ustawienia z aplikacji nadpisują domyślne (wyłączone źródło)', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  const base = await m.config();
  await m.store.setConfig({ sources: [{ ...base.sources.find((s) => s.id === 'rcl'), enabled: false }] });
  const cfg = await m.config();
  assert.strictEqual(cfg.sources.find((s) => s.id === 'rcl').enabled, false);
  assert.strictEqual(cfg.sources.length, base.sources.length);
});

test('analizator konta AI: PDF trafia jako plik, wynik jest normalizowany, nazwa pokazuje użyte konto', async () => {
  const E = loadEngine();
  let call = null;
  const an = E.createAccountAnalyzer({ run: async (o) => { call = o; return { provider: 'Google Gemini (Antigravity CLI)', text: '```json\n{"relevant":true,"relevance_reason":"x","summary":"Streszczenie","what_changes":"y","affects_school":"yes","status":"obowiazuje","requires_statute_change":true,"requires_council_resolution":false,"documents_to_update":["Statut SOSW","Nieznany"],"roles":[{"role":"Dyrektor","action":"Zrobić"},{"role":"Obcy","action":"z"}],"legal_basis":"a","confidence":"high"}\n```' }; } });
  const cfg = E.defaultConfig;
  const a = await an.analyze({ title: 'Akt', sourceName: 'DU' }, { kind: 'pdf', base64: 'JVBERi0=' }, { score: 3, reasons: [] }, cfg, '2026-10-02');
  assert.strictEqual(call.files.length, 1);
  assert.strictEqual(call.files[0].data, 'JVBERi0=');
  assert.match(call.prompt, /PDF/);
  assert.strictEqual(JSON.stringify(a.documents), '["Statut SOSW"]');
  assert.strictEqual(JSON.stringify(a.roles.map((r) => r.role)), '["Dyrektor"]');
  assert.match(an.name, /Gemini/);
});

test('zbyt duży plik z procesu głównego: jeden błąd, bez ponawiania', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  let calls = 0;
  fx.platform.fetch = async () => { calls++; return { status: 0, headers: {}, tooLarge: true, error: 'plik zbyt duży (40 MB)' }; };
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  await assert.rejects(() => m.http.buffer('https://api.test/a.pdf'), /zbyt duży/);
  assert.strictEqual(calls, 1);
});

test('skan bez klucza API kończy się czytelnym błędem, zanim cokolwiek pobierze', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E, { settings: { ai: { provider: 'api', v: 2 } } });
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  await assert.rejects(() => m.scan({ now: '2026-10-02T15:40:00Z' }), /klucza API Claude/);
});

test('import i eksport kopii danych', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  await m.scan({ now: '2026-10-02T15:40:00Z' });
  const json = await m.store.exportAll();
  const fx2 = fixturePlatform(E);
  const m2 = E.createMonitor({ platform: fx2.platform, getSettings: () => fx2.settings });
  await m2.store.importAll(json);
  assert.strictEqual((await m2.store.listChanges()).length, (await m.store.listChanges()).length);
  await assert.rejects(() => m2.store.importAll('{"a":1}'));
});


test('migracja ustawień 1.0: klucze API zostają, tryb „Bez AI” znika, model Gemini API przechodzi', () => {
  const E = loadEngine();
  const m = (ai, kind) => E.migrateAiSettings(ai, kind);
  assert.strictEqual(m({ provider: 'rules' }).provider, 'codex');
  assert.strictEqual(m({ provider: 'rules' }, 'android').provider, 'gemini-api');
  assert.strictEqual(m({ provider: 'claude' }).provider, 'api');
  const g = m({ provider: 'gemini', geminiModel: 'gemini-x' });
  assert.strictEqual(g.provider, 'gemini-api');
  assert.strictEqual(g.geminiApiModel, 'gemini-x');
  assert.strictEqual(g.geminiModel, '');
  const c = m({ provider: 'claude-code', claudePath: '/opt/claude' });
  assert.strictEqual(c.provider, 'claude-code');
  assert.strictEqual(c.paths['claude-code'], '/opt/claude');
  assert.strictEqual(m({ provider: 'claude-code' }, 'android').provider, 'gemini-api');
  // już przeniesione ustawienia nie są zmieniane drugi raz („gemini” = konto Google)
  assert.strictEqual(m({ v: 2, provider: 'gemini', geminiModel: 'flash' }).geminiModel, 'flash');
  assert.strictEqual(m({ v: 2, provider: 'gemini' }).provider, 'gemini');
  assert.strictEqual(JSON.stringify(m(undefined).order), JSON.stringify(['codex', 'gemini', 'claude-code']));
  assert.strictEqual(m(undefined).fallback, true);
  assert.ok(!('rules' in E.AI_PROVIDERS));
});

test('konto AI na telefonie: czytelny błąd zamiast cichego trybu bez AI', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  delete fx.platform.aiRun;
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  await assert.rejects(() => m.testAi(), /tylko w wersji na komputer/);
  const none = E.createMonitor({ platform: fx.platform, getSettings: () => ({ ai: { provider: 'rules' } }) });
  await assert.rejects(() => none.testAi(), /Nie wybrano sposobu analizy/);
});

test('skan przez konto AI: zapytania nie zawierają kluczy, PDF idzie jako plik', async () => {
  const E = loadEngine();
  const fx = fixturePlatform(E);
  const m = E.createMonitor({ platform: fx.platform, getSettings: () => fx.settings });
  const sum = await m.scan({ now: '2026-10-02T15:40:00Z' });
  assert.ok(fx.aiCalls.length > 0, 'były zapytania do konta AI');
  assert.ok(fx.aiCalls.every((c) => typeof c.system === 'string' && typeof c.prompt === 'string' && Array.isArray(c.files)));
  assert.ok(fx.aiCalls.some((c) => c.files.length === 1), 'co najmniej jeden akt z PDF-em');
  assert.match(sum.analyzer, /ChatGPT/);
});

// ───────── programy kont AI (proces główny) ─────────
const os = require('os');
const { execFileSync } = require('child_process');
const prov = require('../electron/ai/providers');
const cliTools = require('../electron/ai/cli-tools');

test('kolejność kont: wybrane, potem połączone; bez przełączania tylko wybrane; klucz API poza łańcuchem', () => {
  const chain = (ai) => JSON.stringify(prov.providerChain(ai));
  assert.strictEqual(chain({ provider: 'gemini', connected: { codex: true, 'claude-code': true } }), '["gemini","codex","claude-code"]');
  assert.strictEqual(chain({ provider: 'gemini', order: ['claude-code', 'codex', 'gemini'], connected: { codex: true, 'claude-code': true } }), '["gemini","claude-code","codex"]');
  assert.strictEqual(chain({ provider: 'codex', fallback: false, connected: { gemini: true } }), '["codex"]');
  assert.strictEqual(chain({ provider: 'api', connected: { codex: true } }), '[]');
});

test('argumenty programów: Codex bez powłoki i sieci, agy z -p na końcu, Claude Code tylko z Read', () => {
  const s = { ai: { codexModel: 'gpt-x', geminiModel: '', model: 'sonnet' } };
  const c = new prov.CodexProvider(s).args({ outFile: '/tmp/o.txt' });
  for (const x of ['exec', '--skip-git-repo-check', '--ephemeral', 'read-only', 'features.shell_tool=false', 'web_search=disabled', '-o']) assert.ok(c.includes(x), x);
  assert.strictEqual(c[c.length - 1], '-');
  assert.deepStrictEqual(c.slice(c.indexOf('-m'), c.indexOf('-m') + 2), ['-m', 'gpt-x']);
  const g = new prov.GeminiProvider(s).args({ full: 'TREŚĆ', stream: false });
  assert.deepStrictEqual(g.slice(-2), ['-p', 'TREŚĆ']);
  assert.ok(g.includes('--sandbox') && g.includes('--disable-slash-commands'));
  const gs = new prov.GeminiProvider(s).args({ full: 'x', stream: true });
  assert.ok(gs.includes('stream-json') && !gs.includes('-p'));
  const cc = new prov.ClaudeCodeProvider(s).args({ hasFiles: true, bin: '/x/claude' });
  assert.deepStrictEqual(cc.slice(cc.indexOf('--tools'), cc.indexOf('--tools') + 2), ['--tools', 'Read']);
  const cc0 = new prov.ClaudeCodeProvider(s).args({ hasFiles: false, bin: '/x/claude' });
  assert.deepStrictEqual(cc0.slice(cc0.indexOf('--tools'), cc0.indexOf('--tools') + 2), ['--tools', '']);
  assert.throws(() => new prov.CodexProvider({ ai: { codexModel: 'a&b' } }).args({ outFile: 'o' }), /modelu/);
});

test('ścieżka programu z ustawień: tylko plik o nazwie programu, bez znaków powłoki', () => {
  const d = prov.DEFS.codex;
  assert.ok(cliTools.isAllowedBinary(d, 'C:\\Users\\a\\codex.exe'));
  assert.ok(!cliTools.isAllowedBinary(d, '/usr/bin/bash'));
  assert.ok(!cliTools.isAllowedBinary(d, '/tmp/x&y/codex'));
});

test('agy: wynik z result.response (polskie znaki), błąd limitu rozpoznany jako AI_LIMIT', () => {
  const ok = prov.parseAgyOutput('{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"Za\\ufffd"}}\n{"event":"result","result":{"status":"OK","response":"Zażółć gęślą jaźń"}}');
  assert.strictEqual(ok.response, 'Zażółć gęślą jaźń');
  const bad = prov.parseAgyOutput('{"status":"ERROR","error":"Individual quota reached for today"}');
  assert.strictEqual(bad.status, 'ERROR');
  assert.strictEqual(prov.classify(prov.DEFS.gemini, bad.error).code, 'AI_LIMIT');
  assert.strictEqual(prov.classify(prov.DEFS.codex, 'Error: Not logged in').code, 'AI_AUTH');
  // komunikat limitu wstrzymuje analizę w silniku do następnego skanu (FATAL_AI w src/pipeline.js)
  assert.match(prov.classify(prov.DEFS.codex, 'usage limit').message, /Wyczerpano limit/);
});

test('przełączanie przy limicie: Gemini bez limitu → ChatGPT; inny błąd przerywa od razu', async () => {
  const fake = (results) => (id) => ({ label: id, run: async () => { const r = results[id]; if (r instanceof Error) throw r; return { text: r }; } });
  const lim = Object.assign(new Error('limit'), { code: 'AI_LIMIT' });
  const s = { ai: { provider: 'gemini', connected: { gemini: true, codex: true } } };
  const r = await prov.runWithFallback(s, {}, fake({ gemini: lim, codex: 'OK' }));
  assert.strictEqual(r.id, 'codex');
  await assert.rejects(() => prov.runWithFallback(s, {}, fake({ gemini: new Error('inny błąd'), codex: 'OK' })), /inny błąd/);
  await assert.rejects(() => prov.runWithFallback({ ai: { provider: 'gemini', fallback: false, connected: { codex: true } } }, {}, fake({ gemini: lim, codex: 'OK' })), /limit/);
  await assert.rejects(() => prov.runWithFallback({ ai: { provider: 'api' } }, {}), /Brak połączonego konta/);
});

test('PDF aktu: tekst odczytany lokalnie trafia do zapytania ChatGPT/Gemini; nieczytelny PDF – uwaga dla modelu', async () => {
  const pdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'akt.pdf')).toString('base64');
  const p = await prov.inlinePdfText('Tytuł: X\n\nTreść aktu jest w załączonym pliku PDF: odczytaj go w całości przed oceną.', [{ data: pdf }]);
  assert.match(p, /<tekst_aktu plik="1">[\s\S]*kształcenia specjalnego/);
  assert.ok(!/odczytaj go w całości/.test(p));
  const bad = await prov.inlinePdfText('Tytuł: X', [{ data: Buffer.from('%PDF-1.4 śmieci').toString('base64') }]);
  assert.match(bad, /nie udało się odczytać tekstu/);
});

// Atrapy programów w PATH (bez prawdziwych kont): codex, agy (limit), claude.
function fakeBins() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'atrapy-'));
  const w = (name, body) => { const f = path.join(dir, name); fs.writeFileSync(f, '#!/bin/bash\n' + body, { mode: 0o755 }); return f; };
  w('codex', `if [ "$1" = "--version" ]; then echo "codex-cli 9.9.9"; exit 0; fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then echo "Logged in using ChatGPT"; exit 0; fi
if [ "$1" = "exec" ]; then out=""; while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; fi; shift; done
  input=$(cat); echo "$input" > "${dir}/codex-input.txt"; printf '%s' '{"ok":true,"z":"żółw"}' > "$out"; exit 0; fi
exit 1
`);
  w('agy', `if [ "$1" = "--version" ]; then echo "agy 1.0"; exit 0; fi
echo '{"status":"ERROR","error":"Individual quota reached. Try again tomorrow."}'; exit 1
`);
  w('claude', `if [ "$1" = "--version" ]; then echo "2.5.0 (Claude Code)"; exit 0; fi
if [ "$1" = "auth" ]; then echo '{"loggedIn":true,"email":"a@b.pl","subscriptionType":"pro"}'; exit 0; fi
echo "$@" > "${dir}/claude-args.txt"; cat > "${dir}/claude-input.txt"; echo '{"type":"result","is_error":false,"result":"{\\"ok\\":true}"}'
`);
  return dir;
}

test('atrapy programów: Gemini wyczerpany → ChatGPT odpowiada; Claude Code dostaje PDF i tylko Read', async () => {
  if (process.platform === 'win32') return;
  const dir = fakeBins();
  const oldPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + oldPath;
  try {
    const s = { ai: { provider: 'gemini', connected: { gemini: true, codex: true }, paths: {} } };
    const pdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'akt.pdf')).toString('base64');
    const r = await prov.runWithFallback(s, { system: 'SYS', prompt: 'Tytuł: akt', files: [{ name: 'a.pdf', data: pdf }] });
    assert.strictEqual(r.id, 'codex');
    assert.match(r.text, /żółw/);
    const sent = fs.readFileSync(path.join(dir, 'codex-input.txt'), 'utf8');
    assert.match(sent, /SYS[\s\S]*kształcenia specjalnego[\s\S]*Nie twórz ani nie modyfikuj/);
    const c = await new prov.ClaudeCodeProvider({ ai: { model: 'sonnet', paths: {} } }).run({ system: 'S', prompt: 'P', files: [{ data: pdf }] });
    assert.strictEqual(c.text, '{"ok":true}');
    assert.match(fs.readFileSync(path.join(dir, 'claude-args.txt'), 'utf8'), /--tools Read --allowedTools Read/);
    assert.match(fs.readFileSync(path.join(dir, 'claude-input.txt'), 'utf8'), /akt-1\.pdf/);
    const { Accounts } = require('../electron/accounts');
    const acc = new Accounts({ getSettings: () => s, emit: () => {} });
    assert.strictEqual((await acc.status('codex')).loggedIn, true);
    const cl = await acc.status('claude-code');
    assert.strictEqual(cl.email, 'a@b.pl');
    assert.strictEqual((await acc.status('gemini')).loggedIn, true); // z ustawień (agy nie ma „status”)
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); console.log(`  ok  ${t.name}`); } catch (e) { failed++; console.log(`  BŁĄD ${t.name}\n       ${e.stack}`); }
  }
  console.log(`\n${tests.length - failed}/${tests.length} testów zaliczonych`);
  process.exit(failed ? 1 : 0);
})();

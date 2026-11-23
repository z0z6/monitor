// Punkt wejścia silnika w aplikacji. Esbuild łączy ten plik z modułami z ../../src w jeden plik www/engine.js,
// który działa tak samo w Electronie (Windows, Linux) i w WebView na Androidzie.

import defaultConfig from '../../config/default.json';
import { runScan } from '../../src/pipeline.js';
import { mergeConfig, validateConfig } from '../../src/config.js';
import { buildSources } from '../../src/sources/index.js';
import {
  createClaudeAnalyzer, createGeminiAnalyzer, DEFAULT_MODEL, DEFAULT_GEMINI_MODEL,
  buildSystemPrompt, buildUserContent, normalizeAnalysis, parseJsonLoose,
} from '../../src/analyze.js';
import { localParts, addDays, daysBetween, plDate } from '../../src/util.js';
import { decidePriority } from '../../src/priority.js';
import { createHttp, makeResponse, bytesToBase64, base64ToBytes } from '../../src/http.js';
import { createStore } from '../../src/store.js';

export { DEFAULT_MODEL, DEFAULT_GEMINI_MODEL, defaultConfig, mergeConfig, validateConfig, localParts, addDays, daysBetween, plDate, decidePriority, makeResponse, bytesToBase64, base64ToBytes, createStore, createHttp };

// Konta AI na komputerze (oficjalne programy producentów, logowanie w przeglądarce) i klucze API (wszędzie).
// Trybu „Bez AI” już nie ma (listopad 2026): każdy akt dostaje streszczenie i zadania od modelu.
export const ACCOUNT_IDS = ['codex', 'gemini', 'claude-code'];
export const AI_PROVIDERS = {
  codex: 'ChatGPT (Codex CLI)',
  gemini: 'Google Gemini (Antigravity CLI)',
  'claude-code': 'Claude (Claude Code)',
  api: 'Klucz API Claude',
  'gemini-api': 'Klucz API Gemini',
};
export const AI_SETTINGS_VERSION = 2;

/**
 * Ustawienia AI z wcześniejszych wersji: „gemini” oznaczało klucz API Gemini, „claude” – klucz API Claude,
 * a „rules” – tryb bez AI (usunięty). Na telefonie konta AI nie działają, zostają klucze API.
 */
export function migrateAiSettings(ai, kind = 'desktop') {
  const desk = kind === 'desktop';
  const out = { ...(ai || {}) };
  if (ai && ai.v !== AI_SETTINGS_VERSION) {
    const map = { claude: 'api', gemini: 'gemini-api' };
    if (map[out.provider]) out.provider = map[out.provider];
    else if (out.provider !== 'claude-code') out.provider = null; // rules i nieznane
    // geminiModel był modelem klucza API; teraz to model konta Google (Antigravity), domyślnie automatyczny
    if (out.geminiModel && !out.geminiApiModel) out.geminiApiModel = out.geminiModel;
    out.geminiModel = '';
    if (out.claudePath && !(out.paths && out.paths['claude-code'])) out.paths = { ...(out.paths || {}), 'claude-code': out.claudePath };
    delete out.claudePath;
  }
  out.paths = { ...(out.paths || {}) };
  if (!out.provider || !AI_PROVIDERS[out.provider]) out.provider = desk ? 'codex' : 'gemini-api';
  if (!desk && ACCOUNT_IDS.includes(out.provider)) out.provider = 'gemini-api';
  if (!Array.isArray(out.order) || !out.order.length) out.order = [...ACCOUNT_IDS];
  out.order = [...new Set([...out.order.filter((id) => ACCOUNT_IDS.includes(id)), ...ACCOUNT_IDS])];
  out.connected = { ...(out.connected || {}) };
  if (out.fallback === undefined) out.fallback = true;
  out.v = AI_SETTINGS_VERSION;
  return out;
}

/**
 * Analizator korzystający z konta AI na komputerze (ChatGPT, Gemini albo Claude).
 * Proces główny wybiera program i przy wyczerpanym limicie przełącza się na kolejne połączone konto.
 */
export function createAccountAnalyzer({ run }) {
  let used = null;
  return {
    get name() { return used ? `konto AI: ${used}` : 'konto AI'; },
    async analyze(c, t, _score, cfg, today) {
      const blocks = buildUserContent(c, t, today);
      const files = blocks.filter((b) => b.type === 'document').map((b, i) => ({ name: `akt-${i + 1}.pdf`, data: b.source.data }));
      const prompt = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')
        + (files.length ? '\n\nTreść aktu jest w załączonym pliku PDF: odczytaj go w całości przed oceną.' : '');
      const r = await run({ system: buildSystemPrompt(cfg, 'json'), prompt, files });
      if (r.provider) used = r.provider;
      const a = normalizeAnalysis(parseJsonLoose(r.text), cfg);
      if (t.kind === 'none' && a.confidence === 'high') a.confidence = 'low';
      if (t.truncated && !a.review_note) a.review_note = 'Tekst aktu został obcięty do limitu, sprawdź pełną treść.';
      return a;
    },
  };
}

/**
 * Monitor: łączy silnik z platformą.
 * platform = { fetch(url, opts) → {status, headers, text|base64}, loadState(), saveState(json), secret(name),
 *              aiRun({system, prompt, files}) → {text, provider} (tylko komputer), notify(title, body) }
 */
export function createMonitor({ platform, getSettings }) {
  const store = createStore({ load: () => platform.loadState(), save: (json) => platform.saveState(json) });
  const http = createHttp({
    fetchImpl: async (url, o) => {
      const r = await platform.fetch(url, o);
      // Proces główny zgłasza zbyt duży plik wynikiem, a nie wyjątkiem, żeby nie zgubić tej informacji po drodze.
      if (r && r.tooLarge) throw Object.assign(new Error(`${r.error} dla ${url}`), { tooLarge: true });
      return makeResponse(r);
    },
  });
  let running = null;
  const listeners = new Set();
  const emit = (ev) => listeners.forEach((fn) => { try { fn(ev); } catch (e) { console.error(e); } });

  async function config() {
    const override = await store.getConfig();
    if (!override) return defaultConfig;
    const errors = validateConfig(override);
    return errors.length ? defaultConfig : mergeConfig(defaultConfig, override);
  }

  async function analyzer() {
    const ai = getSettings().ai;
    if (ACCOUNT_IDS.includes(ai.provider)) {
      if (!platform.aiRun) throw new Error('Konta AI (ChatGPT, Gemini, Claude) działają tylko w wersji na komputer. Na telefonie użyj klucza API Claude lub Gemini w Ustawieniach → AI.');
      return createAccountAnalyzer({ run: platform.aiRun });
    }
    if (ai.provider === 'api') {
      const key = await platform.secret('anthropic');
      if (!key) throw new Error('Brak klucza API Claude. Wpisz go w Ustawieniach → AI.');
      return createClaudeAnalyzer({ apiKey: key, model: ai.apiModel || DEFAULT_MODEL, http });
    }
    if (ai.provider === 'gemini-api') {
      const key = await platform.secret('gemini');
      if (!key) throw new Error('Brak klucza API Gemini. Wpisz go w Ustawieniach → AI.');
      return createGeminiAnalyzer({ apiKey: key, model: ai.geminiApiModel || DEFAULT_GEMINI_MODEL, http });
    }
    throw new Error('Nie wybrano sposobu analizy AI. Otwórz Ustawienia → AI i połącz konto ChatGPT, Gemini albo Claude.');
  }

  /** Czy automatyczny skan powinien ruszyć teraz: dziś jeszcze go nie było i minęła godzina startu. */
  async function isDue(now = new Date()) {
    const cfg = await config();
    const local = localParts(now, cfg.school.timezone);
    if (await store.hasRun(local.date)) return false;
    return local.hour >= (cfg.schedule.window?.from ?? 17);
  }

  async function scan({ reason = 'ręcznie', now = null } = {}) {
    if (running) return running;
    running = (async () => {
      const startedAt = now ? new Date(now) : new Date();
      const lines = [];
      const log = (...m) => { const line = m.join(' '); lines.push(line); emit({ type: 'progress', line }); };
      emit({ type: 'start', reason });
      try {
        const cfg = await config();
        const an = await analyzer();
        const before = new Set((await store.listChanges()).map((c) => c.key));
        const result = await runScan({ cfg, http, store, analyzer: an, now: startedAt, log });
        const today = localParts(startedAt, cfg.school.timezone).date;
        await store.saveReport(today, result.report);
        const fresh = result.changes.filter((c) => !before.has(c.key));
        const bad = result.health.filter((h) => !h.ok);
        await store.log({ kind: 'scan', reason, analyzer: an.name, fresh: fresh.length, errors: bad.length, lines: lines.slice(-80) });
        const summary = { date: today, fresh, health: result.health, ai: result.ai, analyzer: an.name, reviewed: result.summary.reviewed };
        if (result.ai.stopped) {
          platform.notify?.('Monitor prawa: analiza AI wstrzymana', `${result.ai.stopped.slice(0, 180)}. Pozycje wrócą przy następnym skanie.`);
        }
        if (fresh.length) {
          const hi = fresh.filter((c) => c.priority === 'hi').length;
          platform.notify?.('Monitor prawa: nowe zmiany', `${fresh.length} ${pl(fresh.length, 'nowa zmiana', 'nowe zmiany', 'nowych zmian')}${hi ? `, w tym ${hi} o wysokim priorytecie` : ''}.`);
        } else if (bad.length === result.health.length) {
          platform.notify?.('Monitor prawa: skan nieudany', 'Żadne źródło nie odpowiedziało. Sprawdź połączenie z internetem.');
        }
        emit({ type: 'done', summary });
        return summary;
      } catch (e) {
        await store.log({ kind: 'scan-error', reason, error: e.message, lines: lines.slice(-40) });
        emit({ type: 'error', error: e.message });
        throw e;
      } finally {
        running = null;
      }
    })();
    return running;
  }

  /** Krótki test wybranego sposobu analizy AI. */
  async function testAi() {
    const cfg = await config();
    const an = await analyzer();
    const sample = {
      key: 'test', sourceName: 'Test połączenia', title: 'Rozporządzenie Ministra Edukacji zmieniające rozporządzenie w sprawie organizacji kształcenia specjalnego',
      kind: 'act', publishedAt: new Date().toISOString().slice(0, 10),
    };
    const today = localParts(new Date(), cfg.school.timezone).date;
    const a = await an.analyze(sample, { kind: 'none', note: 'test połączenia' }, { score: 3, reasons: [] }, cfg, today);
    return `Połączenie działa (${an.name}). Przykładowe streszczenie: ${a.summary.slice(0, 120)}`;
  }

  /** Sprawdza źródła bez analizy (jak `npm run verify`). */
  async function checkSources() {
    const cfg = await config();
    const today = localParts(new Date(), cfg.school.timezone).date;
    http.resetHosts();
    const out = [];
    // Równolegle: jedno wolne źródło nie wstrzymuje pozostałych.
    await Promise.all(buildSources(cfg).map(async (s) => {
      let r;
      try {
        const items = await s.listNew({ http, today, now: new Date(), lookbackDays: cfg.schedule.lookbackDays, cfg });
        r = { id: s.id, name: s.name, ok: true, count: items.length, sample: items[0]?.title ?? '', warn: items.warning || null };
      } catch (e) {
        r = { id: s.id, name: s.name, ok: false, error: e.message };
      }
      out.push(r);
      emit({ type: 'check', results: [...out] });
    }));
    const order = new Map(cfg.sources.map((s, i) => [s.id, i]));
    return out.sort((a, b) => order.get(a.id) - order.get(b.id));
  }

  return {
    store, http, config, isDue, scan, testAi, checkSources,
    isRunning: () => !!running,
    on(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

function pl(n, a, b, c) {
  if (n === 1) return a;
  const d = n % 10, t = n % 100;
  return d >= 2 && d <= 4 && !(t >= 12 && t <= 14) ? b : c;
}

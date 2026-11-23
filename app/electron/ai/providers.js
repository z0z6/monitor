'use strict';
// Konta AI uruchamiane przez oficjalne programy producentów (logowanie w przeglądarce, bez kluczy
// i bez wyciągania tokenów). Do modelu trafiają wyłącznie publiczne akty prawne i opis placówki.
//
//  "codex"       – ChatGPT (OpenAI) przez Codex CLI; działa na darmowym koncie ChatGPT.
//  "gemini"      – Google Gemini przez Antigravity CLI (`agy`, następca Gemini CLI); darmowe konto Google.
//  "claude-code" – Claude (Anthropic) przez Claude Code; wymaga planu Pro lub Max.
//
// Każdy program działa w pustym katalogu tymczasowym, bez powłoki, sieci i zapisu plików.
// Claude Code dostaje tylko narzędzie Read do załączonego PDF-u; Codex i Antigravity dostają treść PDF-u
// jako tekst odczytany lokalnie (pdf-text.js). Klucze API (Claude, Gemini) obsługuje silnik w oknie aplikacji.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { findBinary, run } = require('./cli-tools');
const { pdfToText } = require('./pdf-text');

const TIMEOUT = 8 * 60 * 1000;
const SAFE_MODEL = /^[A-Za-z0-9._:-]{1,64}$/;

const DEFS = {
  codex: {
    id: 'codex', cmd: 'codex', name: 'ChatGPT', vendor: 'OpenAI', program: 'Codex CLI',
    install: { win: 'irm https://chatgpt.com/codex/install.ps1 | iex', unix: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh' },
    winPaths: ['{HOME}/.local/bin/codex.exe', '{LOCALAPPDATA}/Programs/OpenAI/Codex/bin/codex.exe', '{LOCALAPPDATA}/OpenAI/Codex/bin/codex.exe', '{HOME}/.codex/bin/codex.exe', '{APPDATA}/npm/codex.cmd'],
    unixPaths: ['{HOME}/.local/bin/codex', '{HOME}/.codex/bin/codex', '/usr/local/bin/codex', '/opt/homebrew/bin/codex', '{HOME}/.npm-global/bin/codex'],
    searchRoots: ['{HOME}/.codex/packages', '{LOCALAPPDATA}/Programs/OpenAI', '{LOCALAPPDATA}/OpenAI'],
  },
  gemini: {
    id: 'gemini', cmd: 'agy', name: 'Google Gemini', vendor: 'Google', program: 'Antigravity CLI',
    install: { win: 'irm https://antigravity.google/cli/install.ps1 | iex', unix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash' },
    winPaths: ['{LOCALAPPDATA}/agy/bin/agy.exe', '{HOME}/.local/bin/agy.exe'],
    unixPaths: ['{HOME}/.local/bin/agy', '/usr/local/bin/agy', '/opt/homebrew/bin/agy'],
    searchRoots: ['{LOCALAPPDATA}/agy'],
  },
  'claude-code': {
    id: 'claude-code', cmd: 'claude', name: 'Claude', vendor: 'Anthropic', program: 'Claude Code',
    install: { win: 'irm https://claude.ai/install.ps1 | iex', unix: '(curl -fsSL https://claude.ai/install.sh || wget -qO- https://claude.ai/install.sh) | bash' },
    winPaths: ['{HOME}/.local/bin/claude.exe', '{APPDATA}/npm/claude.cmd', '{LOCALAPPDATA}/Programs/claude/claude.exe', '{LOCALAPPDATA}/AnthropicClaude/claude.exe'],
    unixPaths: ['{HOME}/.local/bin/claude', '{HOME}/.claude/local/claude', '{HOME}/.npm-global/bin/claude', '{HOME}/.bun/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude', '/opt/homebrew/bin/claude'],
    searchRoots: [],
  },
};
const ACCOUNT_IDS = Object.keys(DEFS);

const stripAnsi = (s) => String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

function aiError(message, code) { const e = new Error(message); if (code) e.code = code; return e; }

// Rozpoznanie typowych błędów programów (limit darmowego planu, brak logowania).
const RX_LIMIT = /usage limit|rate.?limit|limit reached|quota|too many requests|\b429\b|resource.?exhausted|hit your .*limit|upgrade your (plan|subscription)/i;
const RX_AUTH = /not logged in|please log ?in|log ?in required|authenticat|unauthori[sz]ed|\b401\b|invalid.*(token|credential)|sign.?in (required|again)|expired.*(token|session)/i;

// Komunikaty AI_LIMIT i AI_AUTH zawierają słowa, po których silnik (src/pipeline.js) wstrzymuje analizę do następnego skanu.
function classify(def, msg) {
  const m = stripAnsi(msg).trim().slice(-600);
  if (RX_LIMIT.test(m)) return aiError(`Wyczerpano limit konta ${def.name}. Spróbuj później albo połącz kolejne konto w Ustawieniach → AI – aplikacja przełączy się na nie automatycznie.`, 'AI_LIMIT');
  if (RX_AUTH.test(m)) return aiError(`Konto ${def.name} nie jest zalogowane (lub sesja wygasła). Otwórz Ustawienia → AI i kliknij „Połącz” przy ${def.name}.`, 'AI_AUTH');
  return aiError(`${def.program}: ${m || 'nieoczekiwana odpowiedź'}`);
}

const NO_FILES = 'Nie twórz ani nie modyfikuj żadnych plików, nie uruchamiaj poleceń i nie korzystaj z internetu. Odpowiedz wyłącznie wynikiem w żądanym formacie JSON.';

function workDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'monitor-prawa-')); }
function cleanup(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } }

function checkRequest({ system, prompt, files }) {
  if (typeof system !== 'string' || typeof prompt !== 'string') throw new Error('Niepoprawne zapytanie do AI.');
  if (!Array.isArray(files) || files.length > 5) throw new Error('Za dużo plików do analizy.');
}

/** Dla programów bez dostępu do plików: treść załączonych PDF-ów dołączona jako tekst. */
async function inlinePdfText(prompt, files, toText = pdfToText) {
  if (!files.length) return prompt;
  const parts = [];
  for (const [i, f] of files.entries()) {
    let r = null;
    try { r = await toText(String(f && f.data || '')); } catch (_) { r = null; }
    if (r && r.text.trim().length >= 40) {
      parts.push(`<tekst_aktu plik="${i + 1}">\n${r.text}\n</tekst_aktu>${r.truncated ? '\n[UWAGA: tekst został obcięty, to tylko początek dokumentu]' : ''}`);
    } else {
      parts.push(`[Plik ${i + 1}: nie udało się odczytać tekstu z PDF (np. skan bez warstwy tekstowej). Oceń na podstawie tytułu i metadanych, ustaw confidence=low i napisz to w review_note.]`);
    }
  }
  return `${prompt.replace(/\n*Treść aktu jest w załączonym pliku PDF:[^\n]*/g, '')}\n\nTekst aktu odczytany z załączonego PDF:\n${parts.join('\n\n')}`;
}

class CliProvider {
  constructor(id, settings) { this.def = DEFS[id]; this.settings = settings; }
  get id() { return this.def.id; }
  get label() { return `${this.def.name} (${this.def.program})`; }
  locate() {
    const ai = this.settings.ai || {};
    return findBinary(this.def, (ai.paths || {})[this.def.id] || (this.def.id === 'claude-code' ? ai.claudePath : ''));
  }
  requireBin() {
    const bin = this.locate();
    if (!bin) throw aiError(`Nie znaleziono programu ${this.def.program}. Otwórz Ustawienia → AI i kliknij „Połącz” przy ${this.def.name}.`, 'AI_AUTH');
    return bin;
  }
  model(explicit, key) {
    const m = explicit || (this.settings.ai || {})[key] || '';
    if (m && !SAFE_MODEL.test(String(m))) throw new Error('Niepoprawna nazwa modelu.');
    return m;
  }
  async version() {
    const bin = this.locate();
    if (!bin) return null;
    const r = await run(bin, ['--version'], { timeoutMs: 20000 });
    return stripAnsi(r.out || r.err).trim().split('\n')[0] || null;
  }
  async test() {
    const v = await this.version();
    if (!v) throw aiError(`Nie znaleziono programu ${this.def.program} na tym komputerze.`);
    const r = await this.run({ system: 'Jesteś testem połączenia.', prompt: 'Odpowiedz dokładnie tekstem: {"ok":true}', files: [], test: true });
    return `${this.def.name}: połączenie działa (${v}) – ${r.text.trim().slice(0, 40)}`;
  }
}

// ─────────── ChatGPT – Codex CLI (`codex exec`) ───────────
class CodexProvider extends CliProvider {
  constructor(settings) { super('codex', settings); }

  args({ outFile, model }) {
    // read-only + wyłączone narzędzie powłoki: model nie czyta plików i nie uruchamia poleceń
    const a = ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never', '--sandbox', 'read-only',
      '-c', 'features.shell_tool=false', '-c', 'web_search=disabled', '-o', outFile];
    const m = this.model(model, 'codexModel');
    if (m) a.push('-m', m);
    a.push('-'); // treść zapytania ze standardowego wejścia (bez limitu długości wiersza poleceń)
    return a;
  }

  async run(req) {
    const { system, prompt, files = [], model } = req;
    checkRequest({ system, prompt, files });
    const bin = this.requireBin();
    const work = workDir();
    const outFile = path.join(work, 'odpowiedz.txt');
    try {
      const full = `${system}\n\n---\n\n${await inlinePdfText(prompt, files)}\n\n${NO_FILES}`;
      const r = await run(bin, this.args({ outFile, model }), { input: full, cwd: work, timeoutMs: TIMEOUT });
      let text = '';
      try { text = fs.readFileSync(outFile, 'utf8'); } catch (_) { /* brak */ }
      if (text.trim()) return { text };
      if (r.timedOut) throw aiError('ChatGPT nie odpowiedział w wyznaczonym czasie.');
      throw classify(this.def, r.err || r.out || `kod ${r.code}`);
    } finally { cleanup(work); }
  }
}

// ─────────── Google Gemini – Antigravity CLI (`agy`, tryb bez okna) ───────────
function parseAgyOutput(out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let env = null;
  let deltas = '';
  for (const l of lines) {
    let j;
    try { j = JSON.parse(l); } catch (_) { continue; }
    if (j && j.event === 'result' && j.result) env = j.result;
    else if (j && j.event === 'step_update' && j.step_update && j.step_update.step_type === 'agent_response' && j.step_update.text_delta) deltas += j.step_update.text_delta;
    else if (j && (j.response !== undefined || j.status)) env = j;
  }
  if (!env) {
    // całe wyjście jako jeden obiekt JSON (sformatowany w wielu wierszach)
    try { const j = JSON.parse(String(out || '').trim()); if (j && typeof j === 'object') env = j.result || j; } catch (_) { /* nie JSON */ }
  }
  // Wynik czytamy z result.response: składanie text_delta psuje polskie znaki (UTF-8 dzielone między zdarzenia).
  return { response: (env && env.response) || deltas || '', status: env && env.status, error: env && env.error };
}

class GeminiProvider extends CliProvider {
  constructor(settings) { super('gemini', settings); }

  // Krótsze zapytania: `-p` (na końcu – agy traktuje dalsze argumenty jako treść). Dłuższe niż limit wiersza
  // poleceń (Windows ~32 tys. znaków; akty mają do 70 tys.): tryb strumieniowy, zapytanie jako zdarzenie JSON na wejściu.
  args({ model, full, stream }) {
    const a = ['--output-format', stream ? 'stream-json' : 'json', '--print-timeout', '8m', '--disable-slash-commands', '--sandbox'];
    if (stream) a.push('--input-format', 'stream-json');
    const m = this.model(model, 'geminiModel');
    if (m) a.push('--model', m);
    if (!stream) a.push('-p', full);
    return a;
  }

  async run(req) {
    const { system, prompt, files = [], model } = req;
    checkRequest({ system, prompt, files });
    const bin = this.requireBin();
    const work = workDir();
    try {
      const full = `${system}\n\n---\n\n${await inlinePdfText(prompt, files)}\n\n${NO_FILES}`;
      const stream = full.length > (process.platform === 'win32' ? 24000 : 100000);
      const input = stream ? JSON.stringify({ event: 'user', message: { content: full } }) + '\n' : null;
      const r = await run(bin, this.args({ model, full, stream }), { input, cwd: work, timeoutMs: TIMEOUT });
      const p = parseAgyOutput(r.out);
      if (p.response && String(p.response).trim() && p.status !== 'ERROR') return { text: String(p.response) };
      if (r.timedOut) throw aiError('Gemini nie odpowiedział w wyznaczonym czasie.');
      throw classify(this.def, [p.error, r.err, r.out].filter(Boolean).join('\n') || `kod ${r.code}`);
    } finally { cleanup(work); }
  }
}

// ─────────── Claude – Claude Code (`claude -p`) ───────────
class ClaudeCodeProvider extends CliProvider {
  constructor(settings) { super('claude-code', settings); }

  args({ model, hasFiles, bin }) {
    const a = ['-p', '--output-format', 'json', '--no-session-persistence', '--model', this.model(model, 'model') || 'sonnet'];
    // Jedyne narzędzie to odczyt załączonego PDF-u: bez powłoki, sieci i zapisu.
    if (hasFiles) a.push('--tools', 'Read', '--allowedTools', 'Read');
    else a.push('--tools', process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin || '') ? '""' : '');
    return a;
  }

  async run(req) {
    const { system, prompt, files = [], model, test } = req;
    checkRequest({ system, prompt, files });
    const bin = this.requireBin();
    const work = workDir();
    try {
      const paths = files.map((f, i) => {
        const p = path.join(work, `akt-${i + 1}.pdf`); // stała nazwa: nazwa z okna nie wpływa na ścieżkę
        fs.writeFileSync(p, Buffer.from(String(f && f.data || ''), 'base64'), { mode: 0o600 });
        return p;
      });
      let full = `${system}\n\n---\n\n${prompt}`;
      if (paths.length) full += `\n\nPliki do analizy (odczytaj każdy w całości narzędziem Read):\n${paths.map((f) => '- ' + f).join('\n')}`;
      full += `\n\n${NO_FILES}`;
      const r = await run(bin, this.args({ model: model || (test ? 'haiku' : null), hasFiles: paths.length > 0, bin }), { input: full, cwd: work, timeoutMs: TIMEOUT });
      let parsed = null;
      try {
        parsed = JSON.parse(r.out);
        if (Array.isArray(parsed)) parsed = parsed.find((x) => x.type === 'result') || parsed[parsed.length - 1];
      } catch (_) { /* nie JSON */ }
      if (!parsed) {
        if (r.timedOut) throw aiError('Claude nie odpowiedział w wyznaczonym czasie.');
        throw classify(this.def, r.err || r.out || `kod ${r.code}`);
      }
      if (parsed.is_error) throw classify(this.def, String(parsed.result || parsed.subtype || 'błąd'));
      return { text: String(parsed.result || ''), usage: { costUsd: parsed.total_cost_usd || null } };
    } finally { cleanup(work); }
  }
}

function createProvider(id, settings) {
  if (id === 'gemini') return new GeminiProvider(settings);
  if (id === 'claude-code') return new ClaudeCodeProvider(settings);
  if (id === 'codex') return new CodexProvider(settings);
  throw new Error('Nieznane konto AI: ' + id);
}

// Kolejność prób: wybrane konto, a przy wyczerpanym limicie – kolejne połączone konta.
function providerChain(ai) {
  const first = ai.provider;
  if (!ACCOUNT_IDS.includes(first)) return [];
  if (ai.fallback === false) return [first];
  const order = (Array.isArray(ai.order) && ai.order.length ? ai.order : ACCOUNT_IDS).filter((id) => ACCOUNT_IDS.includes(id));
  return [first, ...order.filter((id) => id !== first && ai.connected && ai.connected[id])];
}

/** Analiza przez wybrane konto, a przy wyczerpanym limicie (AI_LIMIT) – przez kolejne połączone konta. */
async function runWithFallback(settings, req, create = createProvider) {
  const chain = providerChain(settings.ai || {});
  if (!chain.length) throw aiError('Brak połączonego konta AI. Otwórz Ustawienia → AI i kliknij „Połącz”.', 'AI_AUTH');
  let lastErr = null;
  for (const id of chain) {
    const p = create(id, settings);
    try {
      const r = await p.run(req || {});
      return { text: r.text, provider: p.label, id };
    } catch (e) {
      lastErr = e;
      if (e.code !== 'AI_LIMIT') throw e;
    }
  }
  throw lastErr;
}

const findClaude = (customPath) => findBinary(DEFS['claude-code'], customPath);

module.exports = {
  DEFS, ACCOUNT_IDS, SAFE_MODEL, CodexProvider, GeminiProvider, ClaudeCodeProvider,
  createProvider, providerChain, runWithFallback, parseAgyOutput, classify, stripAnsi, inlinePdfText, findClaude,
};

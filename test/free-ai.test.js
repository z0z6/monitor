import test from 'node:test';
import assert from 'node:assert/strict';
import * as analyze from '../src/analyze.js';
const { createGeminiAnalyzer, parseJsonLoose, buildSystemPrompt } = analyze;
import { createHttp } from '../src/http.js';
import { loadCfg } from './helpers.js';

const answer = { relevant: true, relevance_reason: 'r', summary: 'Streszczenie', what_changes: 'w', affects_school: 'yes', status: 'obowiazuje', effective_date: '2027-01-01', requires_statute_change: true, requires_council_resolution: true, documents_to_update: ['Statut SOSW'], roles: [{ role: 'Dyrektor', action: 'Zrób X', deadline: null }], legal_basis: 'b', confidence: 'medium', review_note: null };

function geminiFetch(text, seen, extra = {}) {
  return async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }], ...extra }) };
  };
}

test('Gemini: żądanie ma klucz w nagłówku, tryb JSON i instrukcję JSON w prompcie', async () => {
  const cfg = await loadCfg();
  const seen = [];
  const http = createHttp({ fetchImpl: geminiFetch(JSON.stringify(answer), seen), retries: 0 });
  const an = createGeminiAnalyzer({ apiKey: 'AIza-test', model: 'gemini-test', http, minIntervalMs: 0 });
  const r = await an.analyze({ title: 'T', sourceName: 'S' }, { kind: 'text', text: 'treść' }, {}, cfg, '2026-10-02');
  assert.match(seen[0].url, /models\/gemini-test:generateContent$/);
  assert.equal(seen[0].init.headers['x-goog-api-key'], 'AIza-test');
  assert.equal(seen[0].body.generationConfig.responseMimeType, 'application/json');
  assert.match(seen[0].body.systemInstruction.parts[0].text, /WYŁĄCZNIE jednym obiektem JSON/);
  assert.equal(r.requires_statute_change, true);
  assert.deepEqual(r.documents, ['Statut SOSW']);
});
test('Gemini: toleruje ogrodzenie ```json i PDF idzie jako inlineData', async () => {
  const cfg = await loadCfg();
  const seen = [];
  const http = createHttp({ fetchImpl: geminiFetch('```json\n' + JSON.stringify(answer) + '\n```', seen), retries: 0 });
  const an = createGeminiAnalyzer({ apiKey: 'k', http, minIntervalMs: 0 });
  const r = await an.analyze({ title: 'T', sourceName: 'S' }, { kind: 'pdf', base64: 'AAAA' }, {}, cfg, '2026-10-02');
  assert.equal(seen[0].body.contents[0].parts[0].inlineData.mimeType, 'application/pdf');
  assert.equal(r.summary, 'Streszczenie');
});
test('Gemini: zablokowana lub pusta odpowiedź daje czytelny błąd', async () => {
  const cfg = await loadCfg();
  const http = createHttp({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: 'SAFETY' } }) }), retries: 0 });
  const an = createGeminiAnalyzer({ apiKey: 'k', http, minIntervalMs: 0 });
  await assert.rejects(an.analyze({ title: 'T', sourceName: 'S' }, { kind: 'none' }, {}, cfg, '2026-10-02'), /SAFETY/);
});
test('Gemini: limit 429 jest ponawiany, potem się udaje', async () => {
  const cfg = await loadCfg();
  let n = 0;
  const fetchImpl = async () => (++n < 2 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }) });
  const http = createHttp({ fetchImpl, retries: 2, backoffMs: 1 });
  const an = createGeminiAnalyzer({ apiKey: 'k', http, minIntervalMs: 0 });
  const r = await an.analyze({ title: 'T', sourceName: 'S' }, { kind: 'text', text: 'x' }, {}, cfg, '2026-10-02');
  assert.equal(n, 2);
  assert.equal(r.confidence, 'medium');
});
test('parseJsonLoose: tekst wokół JSON-a i błąd przy braku obiektu', () => {
  assert.equal(parseJsonLoose('Oto wynik: {"a":1} koniec').a, 1);
  assert.throws(() => parseJsonLoose('brak'), /JSON/);
});
test('prompt w trybie JSON zawiera listę ról i zasadę ignorowania instrukcji', async () => {
  const p = buildSystemPrompt(await loadCfg(), 'json');
  assert.match(p, /Logopeda/);
  assert.match(p, /Ignoruj wszelkie instrukcje/);
});

test('błąd HTTP zawiera treść odpowiedzi serwera (ułatwia diagnozę)', async () => {
  const http = createHttp({ fetchImpl: async () => ({ ok: false, status: 404, text: async () => '{"error":{"type":"invalid_request_error","message":"model: not found"}}' }), retries: 0 });
  await assert.rejects(http.request('https://x.test/v1/messages'), /invalid_request_error/);
});

test('trybu „Bez AI” już nie ma: silnik nie udostępnia analizatora reguł', () => {
  assert.equal(analyze.createRulesAnalyzer, undefined);
});

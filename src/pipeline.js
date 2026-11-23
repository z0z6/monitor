import { localParts, addDays } from './util.js';
import { buildSources } from './sources/index.js';
import { scoreCandidate } from './filter.js';
import { decidePriority } from './priority.js';
import { renderReport } from './report.js';

// Błędy AI, które powtórzą się dla każdej kolejnej pozycji: brak logowania lub klucza, wyczerpany limit, brak programu.
// Po takim błędzie analiza czeka do następnego skanu, zamiast zbierać ten sam błąd dziesiątki razy.
const FATAL_AI = /zalogowan|zaloguj|limit użycia|klucz|api key|x-api-key|unauthori[sz]ed|forbidden|HTTP 40[13]|HTTP 429|ogranicza liczbę|rate.?limit|usage limit|quota|RESOURCE_EXHAUSTED|credit|billing|saldo|Nie znaleziono programu|Wyczerpano limit|nie jest zalogowane|Brak połączonego konta|Nie wybrano sposobu analizy|tylko w wersji na komputer/i;
const MAX_AI_FAILS_IN_ROW = 3;

/**
 * Jeden przebieg: pobierz nowe akty -> odfiltruj -> przeanalizuj -> nadaj priorytet -> zapisz -> zbuduj raport.
 * O tym, KIEDY skan rusza, decyduje aplikacja (Monitor.isDue). Raport powstaje z zapisanych zmian danego dnia,
 * więc ponowny skan tego samego dnia niczego nie gubi i nie dubluje.
 */
export async function runScan({ cfg, http, store, analyzer, now = new Date(), log = () => {} }) {
  const today = localParts(now, cfg.school.timezone).date;
  log(`Start skanu ${today}, analizator: ${analyzer.name}, magazyn: ${store.kind}`);

  const ctx = { http, now, today, lookbackDays: cfg.schedule.lookbackDays, cfg };
  const sources = buildSources(cfg);
  const toMark = [];
  let reviewed = 0;
  const ai = { failed: 0, pending: 0, stopped: null, lastError: null };
  let aiFailsInRow = 0;
  http.resetHosts?.();

  // Źródła pobieramy równolegle (to głównie czekanie na sieć); analiza AI idzie potem po kolei,
  // bo darmowe i abonamentowe limity modeli źle znoszą równoległe zapytania.
  const listed = await Promise.all(sources.map(async (src) => {
    try { return { items: await src.listNew(ctx) }; } catch (e) { return { error: e }; }
  }));

  const health = [];
  for (const [i, src] of sources.entries()) {
    const h = { id: src.id, name: src.name, ok: true, listed: 0, fresh: 0, analyzed: 0, failed: 0, error: null };
    health.push(h);
    const { items, error } = listed[i];
    if (error) {
      h.ok = false;
      h.error = error.message;
      log(`BŁĄD źródła ${src.name}: ${error.message}`);
      continue;
    }
    h.listed = items.length;
    if (items.warning) h.warn = items.warning;

    // Źródła bez dat (np. BIP): pierwszy przebieg tylko zapamiętuje istniejące pozycje, żeby nie zalać raportu.
    if (src.baseline && !(await store.hasSeenFrom(src.id))) {
      toMark.push(...items.map((c) => ({ key: c.key, source_id: src.id, title: c.title, relevant: false })));
      h.baselined = items.length;
      log(`  ${src.name}: zainicjowano, zapamiętano ${items.length} istniejących pozycji`);
      continue;
    }

    const seen = await store.getSeen(items.map((c) => c.key));
    const fresh = items.filter((c) => !seen.has(c.key));
    h.fresh = fresh.length;
    reviewed += fresh.length;

    let attempted = 0;
    for (const light of fresh) {
      // 1) Dane pozycji ze źródła. Błąd tutaj to problem źródła (strona szczegółów, PDF).
      let c, sc, text;
      try {
        c = await src.enrich(light, ctx);
        sc = scoreCandidate(c, cfg);
        if (sc.score < cfg.filter.minScore) {
          toMark.push({ key: c.key, source_id: src.id, title: c.title, relevant: false });
          continue;
        }
        attempted++;
        text = await src.loadText(c, ctx).catch((e) => ({ kind: 'none', note: e.message }));
      } catch (e) {
        // Jedna nieudana pozycja nie przerywa reszty. Nie oznaczamy jej jako widzianej, więc wróci przy następnym skanie.
        attempted++;
        h.failed++;
        h.warn = `nie udało się pobrać pozycji: ${h.failed} (ostatni błąd: ${e.message})`;
        log(`  BŁĄD pozycji ${light.key}: ${e.message}`);
        continue;
      }

      // 2) Analiza AI. Jej błąd NIE jest błędem źródła: pozycja czeka na następny skan.
      if (ai.stopped) { h.aiPending = (h.aiPending ?? 0) + 1; ai.pending++; continue; }
      let a;
      try {
        a = await analyzer.analyze(c, text, sc, cfg, today);
        aiFailsInRow = 0;
      } catch (e) {
        ai.failed++;
        ai.lastError = e.message;
        h.aiFailed = (h.aiFailed ?? 0) + 1;
        aiFailsInRow++;
        log(`  BŁĄD analizy AI: ${c.title.slice(0, 60)}: ${e.message}`);
        if (FATAL_AI.test(e.message) || aiFailsInRow >= MAX_AI_FAILS_IN_ROW) {
          ai.stopped = e.message;
          log(`UWAGA: analiza AI wstrzymana do następnego skanu: ${e.message}`);
        }
        continue;
      }
      h.analyzed++;

      if (!a.relevant || a.affects_school === 'no') {
        toMark.push({ key: c.key, source_id: src.id, title: c.title, relevant: false });
        log(`  bez wpływu: ${c.title.slice(0, 80)}`);
        continue;
      }

      const merged = { ...a, effective_date: c.effectiveDate ?? a.effective_date, category: sc.category ?? 'oswiatowe' };
      const prio = decidePriority(merged, cfg.rules, today);
      await store.saveChange({
        key: c.key,
        source_id: src.id,
        source_name: src.name,
        title: c.title,
        url: c.url,
        published_at: c.publishedAt ?? null,
        effective_date: merged.effective_date,
        category: merged.category,
        priority: prio.priority,
        priority_reasons: prio.reasons,
        summary: a.summary,
        what_changes: a.what_changes,
        status: a.status,
        affects_school: a.affects_school,
        requires_statute_change: a.requires_statute_change,
        requires_council_resolution: a.requires_council_resolution,
        documents: a.documents,
        tasks: a.roles,
        legal_basis: a.legal_basis,
        confidence: a.confidence,
        review_note: a.review_note,
        act_excerpt: a.act_excerpt || null,
        run_date: today,
      });
      toMark.push({ key: c.key, source_id: src.id, title: c.title, relevant: true });
      log(`  [${prio.priority}] ${c.title.slice(0, 80)}`);
    }
    // Źródło jest „z błędem” tylko wtedy, gdy nie dało się pobrać żadnej z jego pozycji; pojedyncze porażki to uwaga.
    if (h.failed && h.failed === attempted) { h.ok = false; h.error = h.warn; delete h.warn; }
  }

  await store.markSeen(toMark);

  const changes = await store.listByRunDate(today);
  const upcoming = (await store.listUpcoming(today, addDays(today, cfg.schedule.upcomingDays)))
    .filter((c) => c.run_date !== today);
  const report = renderReport({ cfg, today, changes, upcoming, health, ai, stats: { reviewed, sources: sources.length } });

  const summary = { reviewed, changes: changes.length, health, ai };
  await store.recordRun(today, summary);
  return { report, changes, health, ai, summary };
}

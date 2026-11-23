// Narzędzie dla programisty (Node 20+): podgląd działania silnika bez budowania aplikacji.
//   node src/cli.js scan [--fixtures=test/fixtures] [--now=ISO] [--out=out]   pokazowy skan, raport w out/report.html
//   node src/cli.js verify                                                                 dostępność źródeł i aktów obserwowanych
// Analiza AI działa w aplikacji (konto ChatGPT, Gemini lub Claude albo klucz API); tutaj tylko tryb próbny
// (wynik oznaczony „TRYB PRÓBNY”, do sprawdzania źródeł i raportu).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createNodeHttp, createFixtureHttp, fileBackend } from './node.js';
import { createMockAnalyzer } from './analyze.js';
import { createStore } from './store.js';
import { runScan } from './pipeline.js';
import { buildSources } from './sources/index.js';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'scan';
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const log = (...m) => console.log(...m);

const loadConfig = async () => JSON.parse(await readFile(opt('config') || 'config/default.json', 'utf8'));

async function scan() {
  const cfg = await loadConfig();
  const fixturesDir = opt('fixtures');
  const http = fixturesDir
    ? createFixtureHttp(JSON.parse(await readFile(path.join(fixturesDir, 'manifest.json'), 'utf8')), fixturesDir)
    : createNodeHttp();
  const out = opt('out') || 'out';
  // Uruchomienie na danych testowych nie zostawia stanu: każde daje ten sam raport.
  const store = createStore(fixturesDir ? {} : fileBackend(opt('state') || '.data/state.json'));
  const analyzer = createMockAnalyzer();
  const result = await runScan({ cfg, http, store, analyzer, now: opt('now') ? new Date(opt('now')) : new Date(), log });

  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, 'report.html'), result.report.html);
  await writeFile(path.join(out, 'report.txt'), `${result.report.subject}\n\n${result.report.text}`);
  const bad = result.health.filter((h) => !h.ok);
  log(`Gotowe: ${result.changes.length} zmian, ${bad.length} źródeł z błędem. Raport: ${out}/report.html`);
  if (bad.length === result.health.length) process.exitCode = 1;
}

async function verify() {
  const cfg = await loadConfig();
  const http = createNodeHttp();
  log('Akty obserwowane (sprawdź, czy tytuły się zgadzają):');
  await Promise.all(cfg.watchedActs.map(async (w) => {
    try {
      const [pub, year, pos] = w.eli.split('/');
      const d = await http.json(`https://api.sejm.gov.pl/eli/acts/${pub}/${year}/${pos}`);
      log(`  OK   ${w.eli}: ${d.title}`);
    } catch (e) {
      log(`  BŁĄD ${w.eli} (${w.name}): ${e.message}`);
    }
  }));

  log('\nŹródła (lista nowych pozycji z ostatnich dni):');
  const today = new Date().toISOString().slice(0, 10);
  const results = await Promise.all(buildSources(cfg).map(async (s) => {
    try {
      const items = await s.listNew({ http, today, now: new Date(), lookbackDays: cfg.schedule.lookbackDays, cfg });
      return `  OK   ${s.name}: ${items.length} pozycji${items[0] ? ` (np. ${items[0].title.slice(0, 70)})` : ''}`;
    } catch (e) {
      return `  BŁĄD ${s.name}: ${e.message}`;
    }
  }));
  results.forEach((r) => log(r));
}

const commands = { scan, verify };
if (!commands[cmd]) {
  log('Użycie: node src/cli.js <scan|verify> [--fixtures=katalog] [--now=ISO] [--out=katalog] [--state=plik] [--config=plik]');
  process.exit(2);
}
commands[cmd]().catch((e) => {
  console.error(`Błąd krytyczny: ${e.message}`);
  process.exit(1);
});

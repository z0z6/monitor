# Monitor prawa: aplikacja (Windows, Linux, Android)

Aplikacja sama pobiera nowe akty prawne (silnik z `../src`), filtruje je, analizuje przez AI, nadaje priorytety i przypisuje zadania rolom.
Wszystko dzieje się na urządzeniu: bez serwera, bez chmury, dane zostają lokalnie.

| Platforma | Plik | Jak działa skan |
|---|---|---|
| Windows | `Monitor-prawa-<wersja>-portable.exe` (bez instalacji, dane w folderze obok .exe) | codziennie od ustawionej godziny, także gdy okno jest schowane w zasobniku |
| Linux | `Monitor-prawa-<wersja>-linux-x86_64.AppImage` | jw. |
| Android | `Monitor-prawa-<wersja>.apk` | po otwarciu aplikacji, jeśli tego dnia skanu jeszcze nie było, albo przyciskiem „Skanuj teraz” |

## Analiza AI

| Sposób | Gdzie | Koszt |
|---|---|---|
| Konto ChatGPT (Codex CLI) – domyślne | komputer | darmowe konto ChatGPT |
| Konto Google Gemini (Antigravity CLI `agy`) | komputer | darmowe konto Google |
| Konto Claude (Claude Code) | komputer | w ramach planu Claude Pro/Max |
| Klucz API Gemini | komputer (zaawansowane) i telefon | darmowy poziom Google AI Studio |
| Klucz API Claude | komputer (zaawansowane) i telefon | za zużycie (platform.claude.com) |

Konta łączy się w Ustawieniach → AI przyciskiem „Połącz”: arkusz zgody, instalacja oficjalnego programu (bez administratora), logowanie w przeglądarce
(ChatGPT: także kodem urządzenia; Gemini: w okienku terminala, bo `agy` nie ma polecenia `login`). Aplikacja nie widzi haseł ani tokenów.
Przy wyczerpanym limicie skan przechodzi na kolejne połączone konto. Trybu „Bez AI” nie ma od wersji 1.1.

Klucze API na komputerze są szyfrowane systemowo (safeStorage) i nie trafiają do okna aplikacji. Na Linuksie bez magazynu kluczy (keyring) klucz jest tylko zakodowany w pliku dostępnym wyłącznie dla Twojego konta.
Na Androidzie klucze są w prywatnej pamięci aplikacji, wyłączonej z kopii zapasowych.

## Budowa

Pliki budują się same w GitHub Actions (workflow **Aplikacja (Windows, Linux, Android)**) po każdej zmianie w `app/`, `src/`, `config/` lub `test/`.
Gotowe pliki są w zakładce Actions → przebieg → *Artifacts*. Tag `v*` (np. `v1.0.0`) dodatkowo tworzy wydanie (Release) ze wszystkimi plikami.

### Podpis APK (zalecany)
Bez klucza powstaje wersja `-debug.apk`, podpisana kluczem jednorazowym: kolejnej wersji nie da się wtedy zainstalować „na” poprzednią
(trzeba odinstalować starą, a dane znikną, więc najpierw zrób kopię w Ustawieniach → Ogólne). Stały klucz rozwiązuje to na zawsze:

```bash
keytool -genkeypair -v -keystore monitor.keystore -alias monitor -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 monitor.keystore   # wynik wklej jako sekret ANDROID_KEYSTORE_BASE64
```
Sekrety repozytorium (Settings → Secrets and variables → Actions): `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` (np. `monitor`), `ANDROID_KEY_PASSWORD`.
Plik `monitor.keystore` przechowuj bezpiecznie poza repozytorium.

### Lokalnie
```bash
cd app
npm install
npm test            # testy silnika w wersji aplikacji (dane testowe z ../test/fixtures)
npm start           # uruchomienie na komputerze
npm run dist:linux  # AppImage
npm run dist:win    # portable .exe (na Windows)
npm run android:prepare && (cd android && ./gradlew assembleDebug)   # APK, wymaga JDK 21 i Android SDK
```

## Budowa kodu
- `www/`: wspólny interfejs (styl macOS/iOS, tryb jasny i ciemny, na telefonie pasek kart na dole).
- `engine/`: łączy silnik z `../src` (w tym magazyn danych i klient HTTP) z aplikacją, dodaje analizator kont AI i migrację ustawień AI z wersji 1.0. `npm run build:engine` składa go w `www/engine.js`.
- `electron/`: proces główny na komputer (pobieranie stron bez blokad CORS, zapis plików, klucze, zasobnik, autostart).
  - `ai/providers.js`: Codex CLI, Antigravity CLI, Claude Code; `providerChain` i `runWithFallback` (przełączanie przy `AI_LIMIT`), `classify` (limit/logowanie), `parseAgyOutput`.
  - `ai/cli-tools.js`: wyszukiwanie programów, uruchamianie, instalacja oficjalnym skryptem, okno terminala do logowania, `killAll` przy zamknięciu.
  - `ai/pdf-text.js`: tekst z PDF-u aktu (pdf.js, poza asar) dla ChatGPT i Gemini.
  - `accounts.js`: stan kont, instalacja, logowanie (przeglądarka, kod urządzenia, terminal), wylogowanie.
- Testy `npm test` (`spec/engine.spec.js`): silnik w wersji aplikacji, migracja ustawień, argumenty programów, przełączanie przy limicie i atrapy `codex`/`agy`/`claude` w PATH.
- Android: Capacitor. Projekt `android/` powstaje w CI ze skryptu `scripts/android-prepare.mjs` (ikony z `android-res/`).

## Czego aplikacja nie robi
- Nie wysyła e-maili i nie synchronizuje danych między urządzeniami. Przeniesienie danych: Ustawienia → Ogólne → Zapisz / Wczytaj kopię.
- Na Androidzie system nie pozwala na niezawodny skan w tle bez otwierania aplikacji, dlatego skan rusza przy jej otwarciu.
- Szkiców zmian w dokumentach szkoły (statut, procedury) nie ma jeszcze w aplikacji. Ich logika jest w historii repozytorium (commit `ee1722d`, pliki `src/drafts.js`, `web/js/drafts-lib.js`, `web/js/docx-export.js`).

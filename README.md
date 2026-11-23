# Monitor prawa oświatowego

Aplikacja na **Windows, Linux i Android**, która codziennie pobiera nowe akty prawne i komunikaty, wybiera te dotyczące placówki,
analizuje je przez AI (streszczenie, priorytet, zadania dla ról, dokumenty do zmiany) i pokazuje raport.
**Bez serwera i bez chmury**: wszystko dzieje się na urządzeniu, dane zostają lokalnie. Pliki aplikacji buduje GitHub Actions.

```
źródła (API Sejmu/ELI, RSS, BIP, RCL) -> filtr słów kluczowych -> analiza AI -> reguły priorytetu -> dane lokalne -> raport + powiadomienie
```

| Folder | Co zawiera |
|---|---|
| `src/` | silnik (wspólny dla wszystkich platform): źródła, filtr, analiza AI, priorytety, raport, magazyn danych |
| `app/` | aplikacja: Electron (Windows portable .exe, Linux AppImage) i Capacitor (Android .apk). Instrukcja: `app/README.md` |
| `config/default.json` | domyślna konfiguracja placówki; w aplikacji zmienisz ją w Ustawieniach |
| `test/` | testy silnika na zapisanych danych (bez internetu) |

## AI: połączenie z własnym kontem

W Ustawieniach → AI są trzy konta, jedno pod drugim. Przycisk „Połącz” (za zgodą użytkownika) instaluje oficjalny program
producenta do folderu użytkownika, bez uprawnień administratora, i otwiera stronę logowania. Jest też przewodnik krok po kroku z poleceniami do skopiowania.

| Konto | Program | Plan | Gdzie |
|---|---|---|---|
| ChatGPT (domyślne) | Codex CLI (OpenAI) | wystarczy darmowe konto ChatGPT | Windows, Linux |
| Google Gemini | Antigravity CLI `agy` (Google, następca Gemini CLI) | wystarczy darmowe konto Google | Windows, Linux |
| Claude | Claude Code (Anthropic) | wymaga planu Pro lub Max | Windows, Linux |
| Klucz API Gemini / Claude | (Ustawienia zaawansowane) | darmowy poziom AI Studio / za zużycie | wszędzie, na Androidzie jedyna opcja |

- Przy wyczerpanym limicie darmowego konta skan sam przechodzi na kolejne połączone konto (kolejność w ustawieniach zaawansowanych, przełącznik „Gdy skończy się limit…”).
- Trybu „Bez AI” już nie ma (od wersji 1.1): ocena samymi słowami kluczowymi dawała raport bez streszczeń i zadań. Ustawienia z wersji 1.0 przechodzą same: „Bez AI” → ChatGPT, klucze API zostają.
- Do modelu trafiają wyłącznie publiczne akty prawne i opis placówki z Ustawień, nigdy dane uczniów ani pracowników. Hasło wpisuje się tylko na stronie producenta; aplikacja nie widzi haseł ani tokenów.

## Źródła

| Źródło | Co daje | Jak | Wiarygodność |
|---|---|---|---|
| Dziennik Ustaw, Monitor Polski | obowiązujące akty ogólnopolskie | oficjalne API ELI Sejmu | oficjalne API |
| Sejm: druki | projekty ustaw (wczesny sygnał) | oficjalne API Sejmu | oficjalne API |
| RCL | projekty rozporządzeń i ustaw na etapie rządowym (najwcześniejszy sygnał) | czytanie stron HTML (brak API) | **eksperymentalne**: przy zmianie układu strony źródło zgłosi błąd w raporcie |
| Dziennik Urzędowy Woj. Mazowieckiego | uchwały organu prowadzącego, akty wojewody i sejmiku | API dziennika zgodne z ELI, zawężone do `scope` | oficjalne API, **struktura odpowiedzi niezweryfikowana na żywo** |
| Kuratorium Oświaty (komunikaty, na skróty) | komunikaty i wytyczne kuratora | oficjalne kanały RSS kuratorium | kanały podane na stronie kuratorium |
| MEN (komunikaty, wiadomości) | komunikaty ministerstwa | kanały RSS **zewnętrznego serwisu** `rss.mtsz.pl` | nieoficjalne |
| BIP Urzędu Miasta Ostrołęki | uchwały, projekty uchwał, zarządzenia Prezydenta | oficjalny kanał RSS + temat ze strony zarządzenia | kanał potwierdzony; wyciąganie tematu zależy od układu strony |

Ustawa zmieniająca „niektóre inne ustawy” często nie ma w tytule nic o oświacie. Dlatego silnik sprawdza też,
czy akt **zmienia któryś z aktów obserwowanych** (`watchedActs`: Prawo oświatowe, Karta Nauczyciela itd.).
Dotyczy to Dziennika Ustaw. Druki sejmowe i projekty RCL są oceniane po tytule, więc ogólny tytuł może je ukryć.

### Organ prowadzący: Miasto Ostrołęka
- **BIP Urzędu Miasta Ostrołęki** (`https://bip.um.ostroleka.pl/rss`): oficjalny kanał RSS ze wszystkimi nowymi uchwałami, projektami uchwał na sesje i zarządzeniami Prezydenta.
  Kanał podaje dla zarządzeń tylko numer, więc silnik pobiera ze strony zarządzenia jego temat („w sprawie”) i dopiero wtedy ocenia trafność (`detailWhenEmpty`).
- **Dziennik Urzędowy Woj. Mazowieckiego**: w `scope` są terminy, które muszą wystąpić w tytule aktu
  (`ostrołęk`, `w ostrołęce`, wojewoda mazowiecki, sejmik, kurator oświaty). Dziennik zawiera uchwały wszystkich gmin województwa,
  więc bez zawężenia raport byłby zalany. Ta sama uchwała może pojawić się dwa razy: w BIP (jako projekt lub uchwała)
  i w Dzienniku (publikacja, od której liczy się wejście w życie). To zamierzone.
- Dla innych stron bez RSS jest typ źródła `links` (lista linków ze strony, z inicjalizacją przy pierwszym skanie).

## Budowa i testy

Pliki aplikacji budują się w GitHub Actions (workflow **Aplikacja**) po każdej zmianie w `app/`, `src/`, `config/` lub `test/`.
Gotowe pliki: Actions → przebieg → *Artifacts*. Tag `v*` (np. `v1.1.0`) tworzy wydanie (Release).

```bash
npm install && npm test        # testy silnika (bez internetu)
npm run dry-run                # pokazowy skan na danych testowych (analiza próbna, bez AI), raport w out/report.html
npm run verify                 # czy źródła i akty obserwowane odpowiadają (wymaga internetu)
cd app && npm install && npm test && npm start   # aplikacja na komputerze
```

## Konfiguracja

`school.profile` (opis placówki dla AI), `keywords`, `watchedActs`, `roles`, `documents`, `rules` (priorytety), `sources`, `schedule`.
**Sprawdź i dopasuj `school.profile`, `roles` i `documents` do rzeczywistej placówki.** To one decydują, komu i co system przypisze.
W aplikacji te same ustawienia zmienisz w zakładce Ustawienia (zapisują się lokalnie, nad plikiem domyślnym).

## Bezpieczeństwo

- Okno aplikacji ma wyłączony Node, włączoną izolację kontekstu i piaskownicę, politykę CSP i zakaz nawigacji; raport z treściami z internetu jest wyświetlany w ramce bez skryptów.
- Klucze API są szyfrowane systemowo (Windows DPAPI, Linux keyring) i nigdy nie trafiają do okna: proces główny dokleja je dopiero do zapytania i tylko do właściwego serwisu (HTTPS, bez przekierowań).
- Okno nie może przez aplikację sięgnąć do adresów lokalnych ani sieci wewnętrznej; odpowiedzi mają limit rozmiaru i czasu.
- Bezpieczniki Electrona: bez trybu „uruchom jako Node”, bez `NODE_OPTIONS` i `--inspect`, aplikacja tylko z archiwum asar.
- Linux: piaskownica Chromium jest wyłączana wyłącznie na systemach, które blokują ją przez AppArmor (np. Ubuntu 23.10+).
- Android: dane i klucze są wyłączone z kopii zapasowej Google i `adb backup`, ruch tylko szyfrowany.
- Programy kont AI działają w pustym katalogu tymczasowym. Codex: `--sandbox read-only`, wyłączona powłoka i wyszukiwanie w sieci. Antigravity: `--sandbox`, bez poleceń z ukośnikiem.
  Claude Code: tylko narzędzie odczytu załączonego PDF-u. ChatGPT i Gemini dostają treść PDF-u jako tekst odczytany lokalnie (pdf.js), bo nie mają dostępu do plików.
  Nazwy modeli i ścieżki programów są sprawdzane przed uruchomieniem; przy zamknięciu aplikacji wszystkie uruchomione programy są kończone.
- GitHub Actions: domyślnie tylko odczyt repozytorium, zapis wyłącznie przy tworzeniu wydania; hasła podpisu APK czyta Gradle ze zmiennych, a plik klucza jest usuwany po budowie.

## Co jest sprawdzone, a co nie

Sprawdzone testami: filtr, reguły priorytetów, parsowanie ELI, RSS, RCL i BIP, odporność na awarię źródła,
brak dublowania zmian przy ponownym skanie, kształt żądań do API Claude i Gemini, argumenty programów kont AI, przełączanie przy limicie (na atrapach `codex`, `agy`, `claude`), odczyt tekstu z PDF, escapowanie treści w raporcie, magazyn danych.

**Nie sprawdzone na żywo**: rzeczywiste odpowiedzi wszystkich źródeł (uruchom `npm run verify` albo w aplikacji Źródła → Sprawdź)
oraz jakość analizy AI na prawdziwych aktach: przez pierwsze tygodnie czytaj streszczenia krytycznie.

## Znane ograniczenia

- Ustawa o bardzo długim tekście jest obcinana do ok. 70 tys. znaków, PDF powyżej 6 MB jest oceniany tylko po tytule i metadanych (raport to zaznacza).
- Akty bez słów kluczowych w tytule i bez odwołania do aktów obserwowanych mogą zostać pominięte. Rozszerzaj `keywords` i `watchedActs`.
- Android nie pozwala na niezawodny skan w tle, dlatego skan rusza przy otwarciu aplikacji.
- RCL (legislacja.rcl.gov.pl) bywa niedostępny i nie odpowiada na połączenia z serwerów za granicą (np. GitHub Actions). Aplikacja rezygnuje z niego po ok. 40 s i zgłasza to w raporcie; reszta skanu działa normalnie.
- Błąd analizy AI (brak logowania, wyczerpany limit wszystkich połączonych kont, zły klucz) nie jest błędem źródła: analiza czeka do następnego skanu, a nieprzeanalizowane pozycje wracają automatycznie.

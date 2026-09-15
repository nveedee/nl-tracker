# Live Win/Draw/Loss Probability – Machbarkeitsanalyse

Rein lesende Analyse (keine Dateien verändert). Basis: `server/scripts/sync-sihf.cjs`, `server/sync.js`, `server/index.js`, `server/scripts/predictions.js`, `src/elo.js`, `src/playoffSim.js`, `src/scorelineMatrix.js`, `src/components/MatchForecast.jsx`, `src/pages/MatchupDetail.jsx`, `src/api.js`, `src/components/SyncStatus.jsx`.

Ziel der geprüften Funktion: Auf der Match-Detailseite während eines laufenden Spiels eine Live-Win/Draw/Loss-Probability anzeigen, die sich über die Spielzeit hinweg aktualisiert – inkl. Timeline (0'–90+'), Ereignisse (Tore, Karten, Strafen) und Live-Statistiken (Ballbesitz, Schüsse, Corners, Offsides, Fouls, Karten).

---

## 1. Welche Live-Daten bereits vorhanden sind

- `server/scripts/sync-sihf.cjs` ruft `https://data.sihf.ch/statistic/api/cms/gameoverview?alias=gameDetail&searchQuery={gameId}` ab. Diese SIHF-API liefert laut Code auch für laufende Spiele:
  - `raw.status` (percent, name, canceled)
  - `raw.result.scores` / `sogs` (Score/Schüsse pro Periode)
  - `raw.stats` (Team-Stats-Tabelle: PP%, Faceoffs, SOG etc.)
  - `raw.summary.periods[].fouls[]` (Strafen mit `time`, `minutes`, `teamId`, `text`)
  - `raw.players[]`
- **Aber:** `parseSihfGame()` (Zeile 211–220) bricht für alles ausser `status:'final'` sofort ab (`if (statusInfo.local !== 'final') return result`). Für laufende Spiele wird **nur** geloggt (`determineLocalStatus` erkennt „live" nur als Log-Label), es wird **nichts** in `db.json` geschrieben – bewusst so konzipiert (Kommentar Zeilen 16–21: „Zwischenstand NIE als final übernehmen").
- `server/sync.js` (nationalleague.ch-API) liefert nur `status: 'finished'/'end'` vs. alles andere „scheduled" – keine granulare Live-Info, keine Minute, kein Zwischenstand.

**Fazit:** Es gibt aktuell **keinerlei Persistenz von Live-Zwischenständen, Spielminute oder Live-Events** in `server/data/db.json`. Die Rohdaten dafür kommen zwar bei jedem Sync-Poll durch die Leitung, werden aber sofort verworfen.

---

## 2. Nötige Daten vs. vorhanden

| Benötigt | Vorhanden im Code? |
|---|---|
| Live-Score | Kommt in SIHF-Response (`raw.result`), wird aber verworfen |
| Spielminute/Uhrzeit | Unsicher – `raw.status` hat `percent`, evtl. auch eine Uhrzeit/Clock-Property, aber der Parser liest das aktuell nicht aus; nicht verifizierbar ohne Live-Response zu inspizieren |
| Events mit Zeitstempel (Tore, Strafen, Karten) | Für Strafen ja (`summary.periods[].fouls[].time`), aber nur im Code-Pfad für finale Spiele erreichbar; für Tore mit Zeitstempel keine Struktur im Code sichtbar (nur `scores` = Torsumme pro Periode, nicht pro Ereignis) |
| Live-Statistiken (Possession, Corner, Offside, Fouls) | „unsicher" – Eishockey hat ohnehin kein Corner/Offside i.S. Fussball; `teamStats`-Tabelle liefert SIHF-spezifische Team-Stats (PP%, Faceoffs, SOG), Inhalt der Tabelle für Live-Spiele nicht verifiziert im Code |
| Status-Unterscheidung live vs. final im Datenmodell | Nicht vorhanden – `db.games[].status` kennt nur `'scheduled'` und `'final'`, kein `'live'`-Wert |

---

## 3. Taugt das bestehende ELO/Forecast-System als Basis?

**Ja, mit Erweiterung.** Das Prognosemodell (`src/elo.js` + `src/playoffSim.js::simulateGameResult`/`computeFixtures`) ist ein **Poisson-Modell**: Aus ELO-Differenz + Heimvorteil (`src/elo.js::homeWinProbability`) wird ein erwarteter Torwert (`fixture.expHome/expAway`) abgeleitet, daraus wird in `simulateGameResult()` je eine Poisson-verteilte Torzahl für Heim/Auswärts über die **vollen 60 Minuten** gezogen; bei Gleichstand nach 60' entscheidet eine kalibrierte OT/SO-Zuteilung (`CALIBRATION.otShareOfTies`, `fixture.pHome`). `MatchupDetail.jsx::simulateSingleGame` führt das 10'000x per Monte-Carlo aus (identischer Code wie Season-Simulation).

Für eine Live-Probability wäre das **konzeptionell direkt wiederverwendbar** über den bekannten „Zeit-verbleibend-Poisson"-Ansatz: `expHome`/`expAway` proportional zur verbleibenden Spielzeit skalieren, den bereits gefallenen Score als fixen Offset hinzufügen, dieselbe Poisson-Simulation für die Restzeit laufen lassen. Das ist **keine neue Modellklasse**, sondern eine Erweiterung der bestehenden Bausteine (`fixture.expHome`, `simulateGameResult`, `SeededRandom`).

Nicht abgedeckt sind aber Effekte wie Powerplay-Situation, Empty-Net-Endgame, Torhüterwechsel, die die Torrate innerhalb des Spiels verändern – das Modell würde die Restzeit mit einer konstanten Rate behandeln, was in den letzten Spielminuten (Empty Net etc.) ungenau wird.

---

## 4. Ist die Probability-Kurve über die Spieldauer rekonstruierbar/fortschreibbar?

**Nein, nicht rückwirkend – nur ab Einführung fortschreibbar.** Es existiert kein Log historischer Live-Zwischenstände; `db.predictions[]` (`server/scripts/predictions.js`) ist ein **einmaliger Pre-Game-Snapshot** pro Spiel (eingefroren vor Spielbeginn), keine Zeitreihe während des Spiels. Eine Timeline 0'–90+' müsste ab dem Zeitpunkt der Einführung neu aufgebaut werden, indem bei jedem Live-Sync-Poll ein Punkt (Minute, Score, berechnete Probability) in einem neuen Array pro Spiel gespeichert wird.

---

## 5. Live-Stats – Kategorisierung

**Bereits verfügbar (im Sync-Code sichtbar, aber verworfen für Live-Spiele):**
- Score pro Periode (`raw.result.scores`)
- Schüsse pro Periode (`raw.result.sogs`)
- Team-Stats-Tabelle (PP%, Faceoffs, SOG – `raw.stats` „Team Stats")
- Strafen mit Zeit (`raw.summary.periods[].fouls[]`)

**Verfügbar, aber muss anders verarbeitet werden:**
- Der komplette Parser-Pfad (`parseSihfGame`) müsste für Nicht-final-Status geöffnet werden (aktuell hart `return result` bei nicht-final)
- Zusätzlich müsste geprüft werden, ob die SIHF-API während eines laufenden Spiels überhaupt granularere Torzeitpunkte/Spielminute liefert (im Code nicht adressiert, „unsicher")

**Nicht verfügbar / unsicher aus dem Code ersichtlich:**
- Ballbesitz/Possession (im Eishockey untypisch, evtl. gar nicht Teil der SIHF-Antwort)
- Corner/Offside (Fussball-Konzepte, im Eishockey nicht anwendbar oder anders benannt)
- Exakte Torzeitpunkte als Einzelereignisse (nur Periodensummen im Code sichtbar)
- Kartentypen (Eishockey kennt Zeitstrafen/Matchstrafen statt Karten – ob SIHF das strukturiert liefert, ist unsicher)

---

## 6. Konkret betroffene Dateien für eine Implementierung

- `server/scripts/sync-sihf.cjs` – `parseSihfGame()` müsste für Nicht-final-Status erweitert werden (neuer Zweig statt frühem `return`), `determineLocalStatus()` bräuchte einen echten `'live'`-Status, `computeGameUpdate()` müsste Live-Felder separat/additiv patchen (ohne die bestehende Sicherheitsgarantie zu verletzen, dass Zwischenstände nie in `homeGoals`/`awayGoals`/`status` landen – neue, eigene Feldnamen nötig, z. B. `liveState`)
- `server/data/db.json` – neues Schema-Feld pro Spiel, z. B. `game.liveState = { minute, homeGoals, awayGoals, events: [...], stats: {...}, probabilityHistory: [...] }`
- `server/index.js` – neuer Endpoint (z. B. `GET /api/games/:id/live`) zum Ausliefern des Live-Zustands, ggf. schnellerer Sync-Trigger für laufende Spiele
- `src/api.js` – neue Client-Funktion für den Live-Endpoint
- `src/pages/MatchupDetail.jsx` – neue Sektion/Bedingung „Spiel läuft" mit Live-Timeline-Komponente
- Neue Komponente, z. B. `src/components/LiveProbabilityTimeline.jsx`
- Neues/erweitertes Logik-Modul, z. B. `src/liveProbability.js` (Restzeit-Poisson-Berechnung, analog `playoffSim.js`)

---

## 7. Integration in MatchupDetail

`MatchupDetail.jsx` ist aktuell rein statisch (lädt DataContext, berechnet einmalig Forecast via `simulateSingleGame`). Für Live-Betrieb müsste die Seite:

1. Erkennen, dass das aktuelle Spiel „live" ist (neuer Status nötig, s. o.)
2. Periodisch den neuen Live-Endpoint pollen (z. B. via `useEffect` + `setInterval`, ähnlich `SyncStatus.jsx`-Pattern)
3. Bei Live-Zustand die neue Timeline-Komponente statt/zusätzlich zur bestehenden `ScorelineMatrix`/`ExpectedGoals`/`GoalProbabilities`-Sektion rendern

---

## 8. Performance-Einschätzung

- Aktuelle SIHF-Sync-Frequenz: alle 5 Minuten (`server/index.js`, `SIHF_SYNC_INTERVAL_MIN`, Default 5). Für eine „Live"-Funktion mit Minutengenauigkeit ist das **zu grob** – eine 90-Sekunden-Torgenauigkeit wäre bei 5-Minuten-Sync nicht gegeben.
- SIHF-API selbst hat Rate-Limit-Handling im Code (`x-ratelimit-*`-Header, Backoff bei <5 verbleibend), d. h. ein deutlich engeres Intervall (z. B. 30–60s während echter Live-Spiele) ist möglich, aber nicht ungeprüft beliebig oft pollbar – müsste separat getestet werden (Rate-Limit-Höhe nicht im Code dokumentiert, nur der Header-Umgang).
- Frontend bräuchte eigenes Polling (bestehendes `SyncStatus.jsx`-Pattern zeigt nur manuellen Sync-Button + einmaligen Status-Fetch, kein Auto-Poll) – ein neuer Polling-Mechanismus (z. B. alle 15–30s) müsste in `MatchupDetail.jsx` ergänzt werden.
- Ein neuer, dedizierter Endpoint ist sinnvoll (nicht der komplette `/api/data`-Dump), um Payload klein zu halten.

---

## 9. Datenhistorie-Machbarkeit

Technisch machbar, aber neu zu bauen: Bei jedem (schnelleren) Live-Sync-Poll ein Element `{minute, homeGoals, awayGoals, pHome, pDraw, pAway}` an ein Array pro Spiel anhängen (analog zum bestehenden Muster `marketValueHistory` in `server/sync.js`, das schon ein Zeitreihen-Array pro Spieler führt – dasselbe Prinzip liesse sich für Spiele übertragen). Es gibt aber noch **kein** analoges Array für Spiele in `db.json`.

---

## 10. Mögliche Probleme (aus dem Code ersichtlich bzw. nicht abgedeckt)

- **Laufendes Spiel / delayed data:** Der Code behandelt „live" aktuell nur als reinen Log-Zustand, keinerlei Fehlerbehandlung für unvollständige/verzögerte Live-Daten vorgesehen.
- **Fehlende Minute:** Unsicher, ob SIHF überhaupt ein Minutenfeld für den aktuellen Spielstand liefert – im Code nicht verifiziert/genutzt.
- **Events in falscher Reihenfolge:** Für Strafen wird nur `p.fouls[]` pro Periode gelesen, keine explizite Sortier-/Dedupe-Logik für Events aus mehreren Polls sichtbar – müsste neu gebaut werden (Idempotenz wie bei `computeGameUpdate` fehlt für Live-Events komplett).
- **API-Ausfall:** Retry/Backoff-Logik existiert bereits generisch (`fetchSihfGame`, 2 Retries mit Backoff, Timeout 10s) – das würde für Live-Polling mitgenutzt werden können.
- **OT/SO:** `determineLocalStatus`/`parseSihfGame` erkennt OT/SO nur rückwirkend am fertigen Ergebnis (`scores.length > 3`, `shootoutEntries`); für den Live-Zustand (z. B. „wir sind gerade in OT") gibt es keine Erkennung – müsste neu ergänzt werden, und das Poisson-Restzeit-Modell hat für OT/SO ohnehin ein anderes Wahrscheinlichkeitsregime (aktuell nur `CALIBRATION.otShareOfTies` als grobe Konstante, keine „live OT"-Modellierung).
- **Mehrere gleichzeitige Live-Spiele:** `runSync()` iteriert bereits über alle `candidates` (Spiele im Zeitfenster) sequenziell mit Sleep zwischen Requests – mehrere parallele Live-Spiele würden funktional unterstützt, aber bei kurzem Poll-Intervall plus vielen gleichzeitigen Live-Spielen steigt die Zahl der SIHF-Requests entsprechend, was das (unklare) Rate-Limit stärker belasten würde.
- **Öffnen der Seite während laufendem Spiel / Refresh:** Da nichts persistiert wird, würde ein Seitenaufruf mitten im Spiel aktuell nur den zuletzt bekannten `'scheduled'`-Zustand zeigen (kein Zwischenstand, keine Historie) – ein Refresh nach Einführung des Features würde den bis dahin gespeicherten Timeline-Verlauf aus `db.json` laden können (falls dort persistiert), sonst nur den aktuellen Punkt.

---

## 11. Klare Einschätzung

**C) Ja, aber neue Daten-/Modellschicht nötig.**

Begründung: Die rohe SIHF-Datenquelle liefert prinzipiell genug für Score/Perioden/Team-Stats/Strafen, aber:
1. Der bestehende Sync-Code verwirft explizit alles Nicht-Finale.
2. Das Datenmodell kennt keinen Live-Status und keine Zeitreihen-Persistenz.
3. Das Prognosemodell rechnet aktuell nur „60 Minuten von Spielbeginn", nicht „Restzeit ab aktuellem Stand".

Alle drei Schichten (Sync-Parsing, Datenmodell/Persistenz, Vorhersage-Restzeit-Logik) müssten erweitert werden – es ist keine reine UI-Ergänzung auf vorhandenen Daten.

---

## 12. Aufwandsschätzung

**Gross.**

Begründung: Änderungen in allen drei Schichten (Backend-Sync mit neuer Live-Parsing-Logik + Rate-Limit-Verträglichkeit, neues Persistenzschema mit Event-Dedupe/Reihenfolge-Handling, neues Restzeit-Poisson-Modell, neuer API-Endpoint, neue Frontend-Timeline-Komponente mit Polling) plus mehrere unsichere/unverifizierte Annahmen über die tatsächliche Live-Antwortstruktur von SIHF (Minute, Torzeitpunkte, Possession-ähnliche Statistik), die vor Implementierung erst an einem echten laufenden Spiel verifiziert werden müssten (die vorhandenen Code-Kommentare selbst weisen mehrfach darauf hin, dass Annahmen „an einem echten Spiel noch zu verifizieren" sind, z. B. Shootout-Feldform Zeile 229–231).

---

## 13. Vorschlag technische Architektur (nur Vorschlag, NICHT implementiert)

1. **Sync-Erweiterung:** In `sync-sihf.cjs` einen neuen, additiven Zweig für `statusInfo.local === 'live'` einführen, der ausschliesslich in ein neues Feld `game.liveState` schreibt (nie in `homeGoals`/`status`/`decision` – bestehende Sicherheitsgarantie bleibt unangetastet). `liveState` enthält: `minute`, `homeGoals`, `awayGoals`, `events[]` (Tore/Strafen mit Zeit, dedupliziert per stabilem Schlüssel), `teamStats`.
2. **Schnelleres Live-Polling:** separates, kürzeres Intervall (z. B. 30–60s) NUR für Spiele, die im aktuellen Zeitfenster als „läuft" erkannt wurden (kein pauschal schnellerer Poll für alle Spiele).
3. **Restzeit-Modell:** neues Modul `src/liveProbability.js`, das `fixture.expHome/expAway` aus `computeFixtures()` übernimmt, auf verbleibende Spielzeit skaliert, aktuellen Score als Startpunkt der Poisson-Simulation setzt, per `SeededRandom`/`simulateGameResult`-Analogon 10'000 Restspiel-Verläufe simuliert → `pHomeWin/pDraw/pAwayWin` für den aktuellen Zeitpunkt.
4. **Persistenz der Timeline:** bei jedem Live-Poll einen Punkt `{minute, homeGoals, awayGoals, pHome, pDraw, pAway}` an `game.liveState.probabilityHistory[]` anhängen (Analogie zu `marketValueHistory` in `server/sync.js`).
5. **API:** `GET /api/games/:id/live` liefert nur `liveState` (klein, pollingfreundlich), statt des kompletten `/api/data`-Dumps.
6. **Frontend:** `MatchupDetail.jsx` pollt bei erkanntem Live-Status alle 15–30s den neuen Endpoint; neue Komponente zeichnet Timeline (Linien-/Flächenchart 0'–90+', Marker für Events) plus Live-Stats-Kacheln.

---

## 14. Machbarkeitstabelle

| Feature | Daten bereits vorhanden? | Aufwand | Möglich? |
|---|---|---|---|
| Live Score | Teilweise (in SIHF-Rohantwort, wird aktuell verworfen) | mittel | ja |
| Live Game Minute | Unsicher (nicht im Code genutzt/verifiziert) | mittel-gross | unsicher |
| Live Events (Tore/Strafen/Karten) | Teilweise (Strafen mit Zeit ja, Tor-Einzelereignisse unsicher) | gross | ja, mit Einschränkungen |
| Live Statistics (Possession, Schüsse, Corner, Offside, Fouls) | Teilweise (Team-Stats/SOG ja, Possession/Corner/Offside unsicher bzw. nicht anwendbar im Eishockey) | mittel-gross | teilweise |
| Win Probability (live) | Nein (nur Pre-Game-Modell vorhanden) | mittel | ja (Restzeit-Poisson-Erweiterung) |
| Draw Probability (live) | Nein | mittel | ja |
| Loss Probability (live) | Nein | mittel | ja |
| Probability Timeline | Nein | gross | ja, mit neuer Persistenz |
| Historical Probability Curve | Nein (nur einmaliger Pre-Game-Snapshot vorhanden) | gross | ja, nur ab Einführung (nicht rückwirkend) |
| Auto Refresh | Nein (aktuell nur manueller Sync-Button) | klein-mittel | ja |

---

## 15. Risiken und offene Fragen (Zusammenfassung)

- Ob SIHF für laufende Spiele überhaupt eine Spielminute/Clock liefert, ist **nicht verifiziert** – müsste an einem echten laufenden Spiel geprüft werden.
- Einzeltor-Zeitstempel sind im aktuellen Code nicht sichtbar (nur Periodensummen) – unsicher, ob SIHF das granularer liefert.
- Possession/Corner/Offside sind Fussball-Konzepte und im Eishockey-Kontext der SIHF-API unsicher bzw. nicht anwendbar.
- Rate-Limit-Obergrenze der SIHF-API ist nicht dokumentiert – engeres Poll-Intervall müsste vorsichtig getestet werden.
- Event-Reihenfolge/Dedupe-Logik für Live-Updates existiert aktuell nicht und müsste komplett neu gebaut werden.
- OT/SO-Erkennung funktioniert aktuell nur rückwirkend am Endergebnis, nicht live.
- Bei mehreren gleichzeitigen Live-Spielen steigt die Zahl der SIHF-Requests proportional – Belastung des unklaren Rate-Limits.

---

## 16. Verifikation der SIHF-API

Am 15.09.2026 wurde die zentrale offene Frage aus Abschnitt 1–5 gezielt mit echten, read-only GET-Requests gegen die produktiv genutzte SIHF-API (`https://data.sihf.ch/statistic/api/cms/gameoverview?alias=gameDetail&searchQuery={gameId}&language=de`) überprüft.

**1. Verifikationsmethode:** Die Feldstrukturen wurden anhand von zwei abgeschlossenen (finalen) Spielen verifiziert (u. a. Ambri–Kloten und Kloten–SCL Tigers, Shootout-Spiel). `externalId` aus `server/sync.js` (nationalleague.ch-Sync) folgt exakt demselben ID-Schema wie die SIHF-`gameId` und wurde erfolgreich 1:1 gegen die echte API getestet.

**2. Bestätigte Daten (strukturell in echten Responses nachgewiesen):**
- `summary.periods[].goals[]` – **Einzeltor-Events mit exaktem Zeitstempel** (`time` als absolute Spielzeit „MM:SS" über 60 Minuten), Torschütze (`scorerLicenceNr` + Klartext im `text`-Feld), Assists, sowie On-Ice-Spieler (`p1–p6`/`m1–m6`, ermöglicht sogar Plus/Minus-Rekonstruktion pro Tor). Zusätzlich `revokedGoals[]` (aberkannte Tore) und `goalkeepers[]` (Torhüterwechsel-Events mit Zeitstempel).
- `result.homeTeam`/`result.awayTeam` – aktueller Gesamt-Score, exakt.
- `result.scores[]` – Periodenscore pro Drittel/OT, inkl. `indicator:"OT1"` bei Verlängerung.
- `result.sogs[]` – Schüsse pro Periode (SOG), gleiche Struktur wie Periodenscore.
- `stats[]` („Team Stats") – vollständige Statistik-Tabelle: SOG, SHM, SHP, BkS, FO Total/Won/Lost/%(oz/nz/dz), PIM, PPT, PKT, PP OP, PPG, PP%, PP GA, PK SI, PK GA, SHG, PK% – deutlich mehr als der aktuelle Parser nutzt, aber bereits vollständig generisch eingelesen.
- `summary.periods[].fouls[]` – Strafen mit `time`, `startTime`, `endTime`, `minutes`, `playerLicenceNr`, `teamId`, eindeutiger `id`, `name` (Strafgrund) – reicher als vom aktuellen Parser genutzt (dieser liest nur `time, minutes, teamId, text`).
- `players[]` und Player-/Goalie-Stats-Tabellen (TOI, SOG, Punkte, +/-, Saves, GAA etc.) sowie `lineUps` (Aufstellung, Captain, Coach) – bisher ungenutzt im Parser.
- `summary.shootout.shoots[]` – Einzelschüsse im Penaltyschiessen (`scorerLicenceNr`, `goalkeeperLiceneNr`, `scored`, `number`).

**3. Nicht verifizierbar zum Testzeitpunkt:** Die Update-Latenz während eines laufenden Spiels konnte am 15.09.2026 **noch nicht** verifiziert werden, weil zum Zeitpunkt des Tests (vormittags) noch kein Spiel lief – der Saisonstart war erst am selben Abend um 19:45 Uhr.

**4. Deshalb weiterhin offen:**
- Wie schnell `goals[]` nach einem tatsächlichen Tor aktualisiert wird (sofort vs. erst am Perioden-/Spielende).
- Ob Live-Stats (SOG, Team Stats, Player Stats) sofort oder verzögert aktualisiert werden.
- Ob die Live-Daten während einer laufenden Partie tatsächlich kontinuierlich verfügbar sind, oder ob die API während des Spiels nur einen reduzierten/anderen Datenstand liefert als im finalen Zustand.

**5. Rate Limit:** Beobachtet wurden `x-ratelimit-limit: 1200` und ein pro Request um 1 sinkendes `x-ratelimit-remaining` mit einem gleitenden Reset-Fenster von ca. 27–60 Sekunden – d. h. **1200 Requests pro 60-Sekunden-Fenster**. Ein 30–60-Sekunden-Polling ist nach aktuellem Stand unproblematisch, auch für mehrere gleichzeitige Live-Spiele.

**6. Weiterhin nicht nachbauen:**
- Eine exakte Sekunden-Live-Uhr – es wurde kein dediziertes Clock-/Remaining-Feld gefunden (nur der grobe `status.percent`-Wert), und es wurde keine ausreichende Datenbasis dafür verifiziert.
- Ballbesitz.
- Corner.
- Offside.

(Diese drei Konzepte sind zudem im Eishockey nicht anwendbar bzw. nicht Teil der SIHF-Datenstruktur.)

**7. Empfehlung:** Vor der eigentlichen Implementierung sollte ein kurzer Live-Test an einem tatsächlich laufenden National-League-Spiel durchgeführt werden – idealerweise am Testtag selbst ab 19:45 Uhr. Dabei sollten mehrere Requests während des laufenden Spiels verglichen werden, insbesondere um die Update-Latenz von Score, `goals[]` und den Stats-Tabellen zu prüfen.

---

## 17. Zusätzlich gefundener unabhängiger Bug

Im Rahmen der Verifikation wurde ein von der Live-Funktion **unabhängiger** Bug im bestehenden Code entdeckt:

Die Shootout-Erkennung in `server/scripts/sync-sihf.cjs` sucht aktuell nach den Feldern `entries` / `attempts` / `rounds`, während die tatsächliche SIHF-Struktur das Array unter `shoots` führt (`summary.shootout.shoots[]`).

**Folge:** Bei echten Shootout-Spielen wird `decision: 'SO'` aktuell nicht korrekt erkannt; der Code fällt stattdessen auf den `scores.length > 3`-Fallback zurück und erkennt das Spiel fälschlich nur als `'OT'`.

Dieser Bug wird hier ausschliesslich **dokumentiert**, nicht behoben.

---

## Aktualisierte Schlussfolgerung

Die bisherige Einschätzung bleibt:

**C) Ja, aber neue Daten-/Modellschicht nötig.**

Aufwand: **Gross.**

Ergänzend gilt: Die grundsätzliche Datenverfügbarkeit der SIHF-API wurde anhand abgeschlossener Spiele bestätigt. Die entscheidende verbleibende Unsicherheit ist nicht mehr, ob die Felder grundsätzlich existieren, sondern wann und wie schnell sie während eines laufenden Spiels aktualisiert werden.

---

## 25. Mathematisches Audit & Implementierung der Live-Probability-Engine

Anlass: Die Demo zeigte bei „2:1 in der 58. Minute" die Werte 83% / 6% / 11% (Home/Draw/Away). Der Away-Wert von 11% wurde zu Recht als verdächtig gemeldet.

### 25.1 Root Cause

Es gab **keine Berechnung**. `src/liveDemoData.js` enthielt ein fest verdrahtetes Beispiel-Array (`DEMO_PROBABILITY_TIMELINE`) mit frei gewählten Illustrationszahlen für jeden Zeitpunkt der Demo-Kurve - inklusive des letzten Punkts (58', 83/6/11%), der nie aus ELO, Expected Goals oder einer Restzeit-Formel abgeleitet wurde. Es existierte zu diesem Zeitpunkt schlicht kein Live-Probability-Modell im Projekt, nur ein UI-Konzept mit Platzhalterwerten.

### 25.2 Implementierte Lösung

Neues, unabhängig testbares Modul **`src/liveProbability.js`** (`computeLiveWinProbability()`), reine Funktion ohne Zufallszahlen (geschlossene Poisson-Doppelsumme statt Monte-Carlo):

1. **Wiederverwendung des bestehenden Pre-Game-Modells**: `expHomeFull`/`expAwayFull` (erwartete Tore über 60 Minuten) und `pHomePreGame` kommen unverändert aus `src/playoffSim.js` (`computeFixtures()`/`buildFixture()` → ELO + Heimvorteil + SOG-Faktor). Die Engine erfindet keine eigene Teamstärke-Formel.
2. **Restzeit-Skalierung**: `remLambda = fullLambda * remainingFraction(elapsedMinutes)`, mit `remainingFraction(m) = (60 - clamp(m, 0, 60)) / 60`. Bereits gespielte Zeit wird nicht erneut simuliert.
3. **Score als fixer Offset**: Der aktuelle Torunterschied (`homeGoals - awayGoals`) plus die noch zu erzielenden Resttore (zwei unabhängige Poisson-Verteilungen) bestimmen das Regulationsergebnis über eine geschlossene Doppelsumme (identisches Prinzip wie `computeDecisionProbability()` in `playoffSim.js`, nur zusätzlich mit Score-Offset statt nur "Unentschieden ja/nein").
4. **OT/SO-Auflösung**: Ein Unentschieden nach 60 Minuten (`drawAfter60`) ist in der National League nie das Endergebnis. Es wird über `pHomePreGame` aufgelöst - exakt dieselbe Logik wie die bestehende OT/SO-Auslosung in `simulateGameResult()` (`rng.next() < fixture.pHome`, für OT und SO identisch). Diese bestehende Vereinfachung (kein separates OT- vs. SO-Sieger-Modell) wird bewusst **nicht** "verbessert" (keine erfundene Zusatzkalibrierung), sondern unverändert übernommen und dokumentiert.

### 25.3 Definition Home/Draw/Away (Korrektur der Inkonsistenz)

Die alte Demo behandelte "Draw" als dritten, in die 100%-Aufteilung eingerechneten Endzustand - das ist in einem Sport ohne echtes Unentschieden (NL entscheidet immer per OT/SO) mathematisch inkonsistent.

**Korrigierte, jetzt verwendete Definition:**
- **HOME / AWAY** (die prominenten Prozentwerte, z.B. "AJO 96% / AMB 3%") = `homeFinal`/`awayFinal` = Wahrscheinlichkeit, dass dieses Team das Spiel **endgültig** gewinnt, inkl. OT/SO. `homeFinal + awayFinal = 1` (exakt, garantiert).
- **„Unentschieden nach 60 Minuten"** (`drawAfter60`) ist **kein** Teil dieser 100%-Aufteilung, sondern ein separater, klar beschrifteter Zusatzwert - identisches Muster wie die bereits bestehende Pre-Game-Sektion in `MatchupDetail.jsx` (dort: "OT-Wahrscheinlichkeit"/"SO-Wahrscheinlichkeit" als eigene Kacheln neben dem Home/Away-Split, nicht eingerechnet).

### 25.4 Zeitmodell

`remainingFraction()` bildet exakt die in der Aufgabenstellung geforderten Beispielwerte ab (0'→100%, 30'→50%, 58'→3.33%, 60'→0%), getestet in `src/liveProbability.test.js`. Zusätzlich: `elapsedMinutesFromPeriodClock(period, remainingSeconds)` wandelt eine drittel-basierte Countdown-Uhr (wie SIHF sie führt) in absolute verstrichene Minuten um - vorbereitet für eine künftige echte Anbindung, von der Demo aktuell nicht benötigt.

### 25.5 Event-Handling (Tore/Strafen)

Ein Tor verursacht automatisch einen Sprung, weil die Engine bei jedem Aufruf den **aktuellen** Score als Eingabe erhält - es gibt keine separat gepflegte Kurve, die "angepasst" werden müsste. `src/liveDemoData.js` demonstriert das: `scoreAt(minute)` leitet den Spielstand direkt aus den Torereignissen ab, `buildProbabilityTimeline()` ruft `computeLiveWinProbability()` für jede Minute erneut auf. Strafen/Powerplay fliessen aktuell **nicht** in die Torerwartung ein (siehe 25.7).

### 25.6 SIHF-Live-Daten - was tatsächlich verwendet wird

Es besteht weiterhin **keine echte SIHF-Live-Anbindung** (kein Backend-Polling, kein neuer Endpoint, keine `liveState`-Struktur - das war für dieses Audit explizit nicht im Scope, siehe 25.9). Die Engine ist so gebaut, dass sie unabhängig von der Datenquelle funktioniert: Score, `elapsedMinutes` und Phase (`REG`/`OT`/`SO`) sind reine Eingabeparameter. Die bereits verifizierte SIHF-Struktur (Abschnitt 16) bleibt die Referenz für eine künftige Anbindung: `result.homeTeam`/`result.awayTeam`, `summary.periods[].goals[]` (Zeitstempel), `summary.periods[].fouls[]`, `summary.shootout.shoots[]`.

**Bugfix in diesem Zug:** `server/scripts/sync-sihf.cjs` suchte Shootout-Einträge unter `entries`/`attempts`/`rounds` - die echte SIHF-Antwort liefert das Array unter `shoots` (siehe Abschnitt 16/17). Dadurch wurde `decision: 'SO'` bisher **nie** korrekt erkannt (immer Fallback auf `'OT'`). Feldname korrigiert; betrifft nur den bestehenden Final-Sync-Pfad, keine Live-Logik.

### 25.7 Bekannte Einschränkungen (bewusst nicht "gelöst", um keine Fake-Präzision vorzutäuschen)

- **Kein Powerplay-/Penalty-Effekt auf die Torerwartung.** SIHF liefert Strafen mit Zeitstempel (verifiziert), aber ein belastbarer Powerplay-Torraten-Multiplikator wäre eine neue, unkalibrierte Modellannahme. Nicht eingebaut - Architektur (reine Parameter-Eingabe in `computeLiveWinProbability`) lässt das später zu, ohne die Engine umzubauen.
- **Kein Empty-Net-Effekt.** Ob SIHF "Goalie pulled" zuverlässig liefert, ist unverifiziert (nie an einem echten Spätphasen-Live-Spiel getestet). Nicht eingebaut.
- **OT/SO ohne Tor-für-Tor-Dynamik.** Sudden Death wird als einmalige, kalibrierte Auslosung behandelt (`pHomePreGame`), nicht als eigene Poisson-Rechnung - identisch zum bestehenden Saison-Simulationsmodell.
- **OT- und SO-Sieger-Wahrscheinlichkeit sind identisch** (beide = `pHomePreGame`) - eine bestehende Modell-Vereinfachung, keine neue.
- **Kein echtes Live-Backend/Polling.** `server/live/*` (Poller, 20-30s-Intervall, `liveState`-Persistenz) wurde in diesem Zug **nicht** gebaut - das würde produktives Polling gegen die SIHF-API während eines echten Spiels erfordern, was ohne Verifikation an einem tatsächlich laufenden Spiel unverantwortlich zu implementieren wäre (siehe Abschnitt 6 zur Update-Latenz, weiterhin ungeklärt). Die Engine ist bewusst so geschnitten (reine Funktion, Score/Zeit/Phase als Eingabe), dass ein künftiger Poller sie ohne Änderung aufrufen kann.

### 25.8 Beispiel 2:1 bei 58' (siehe `src/liveProbability.test.js`, Testfall 7)

Mit repräsentativen Pre-Game-Werten `expHomeFull=3.0`, `expAwayFull=2.6`, `pHomePreGame=0.56`:

```
remainingFraction = 0.0333  (2 von 60 Minuten übrig)
remHomeLambda = 0.10, remAwayLambda = 0.087

homeRegWin   = 0.9246
drawAfter60  = 0.0722
awayRegWin   = 0.0032

homeFinal = 0.9246 + 0.0722 * 0.56 = 0.9650  (96.5%)
awayFinal = 0.0032 + 0.0722 * 0.44 = 0.0350  (3.5%)
```

Der alte Demo-Wert von 11% Away hatte keinerlei Bezug zu dieser Rechnung. Der Test erzwingt `awayFinal < 8%` für dieses Szenario.

### 25.9 Testresultate

`npm run test:live` (`src/liveProbability.test.js`, 19 Tests, alle grün): Normierung (Summe = 1 in beiden Partitionen), Wertebereich [0,1], Monotonie (mehr Heimtore ⇒ homeFinal steigt; mehr Auswärtstore ⇒ awayFinal steigt; weniger Restzeit stärkt den Führenden), OT-/SO-Sonderfälle, Zeitmodell-Referenzwerte, Grid-Test über 11×5×5 Score-/Zeit-Kombinationen ohne NaN/negative Werte, sowie der 2:1-bei-58'-Debug-Fall. Bestehende Suiten (`test:sim`, `test:wheel`, `test:scoreline`) weiterhin grün, keine Regression an Pre-Game-Logik/Monte-Carlo/Scoreline-Matrix/Expected-Goals.

### 25.10 Scope-Entscheidung: nur Engine + Demo-Integration, kein Backend

Gemäss der in der Aufgabenstellung selbst genannten Priorität ("1. mathematische Korrektheit" vor "2. echte Live-Daten") wurde in diesem Zug ausschliesslich die Wahrscheinlichkeits-Engine implementiert und in die bestehende Demo integriert (`liveDemoData.js` berechnet die Timeline jetzt über `computeLiveWinProbability()` statt über ein Zahlen-Array). Ein echtes SIHF-Live-Backend (`server/live/*`, 20-30s-Polling, `liveState`-Persistenz, neuer API-Endpoint) wurde **nicht** gebaut - das ist ein separates, grösseres Vorhaben (bereits als "Aufwand: gross" in Abschnitt 12 eingeschätzt) und würde eine Verifikation an einem echten laufenden Spiel voraussetzen, die in dieser Session nicht stattfinden konnte. Die UI zeigt weiterhin klar **„LIVE DEMO"** (nicht „LIVE") im Header-Badge, solange keine echte Datenquelle angebunden ist.

---

## 26. SOG-Impact-Test (Ergebnis: NICHT implementiert)

Gemäss Auftrag zunächst rein empirisch geprüft, **ob** Live-SOG überhaupt einen sinnvollen zusätzlichen Informationswert liefert, bevor irgendetwas implementiert wird. `liveProbability.js` wurde dafür **nicht verändert** - der Test lief über ein temporäres, nicht ins Repo aufgenommenes Analyse-Script, das ausschliesslich die bestehende, unveränderte `computeLiveWinProbability()`-API aufruft (ein hypothetisches SOG-Modell wurde simuliert, indem `expHomeFull`/`expAwayFull` vor dem Aufruf mit einem Shot-Share-Faktor reskaliert wurden - architektonisch identisch zu Abschnitt 12 der Aufgabenstellung: Wirkung auf die verbleibende λ, nicht auf die fertige Prozentzahl).

**A) Hatten SOG bisher einen Einfluss?** Nein. `computeLiveWinProbability()` kennt exakt sechs Inputs: `expHomeFull`, `expAwayFull`, `pHomePreGame`, `homeGoals`, `awayGoals`, `elapsedMinutes` (+`phase`). Kein SOG-Feld, live oder aggregiert. Die einzige SOG-Verwendung im gesamten Projekt ist die bereits bestehende **Pre-Game**-Anpassung in `playoffSim.js`/`powerRankings.js` (`SOG_ADJUSTMENT`): eine Saison-**Durchschnitts**-Kennzahl "zugelassene Schüsse/Spiel" pro Team, z-normalisiert über die ganze Liga, mit Konfidenzrampe ab 10 Spielen - das ist eine völlig andere Grösse als das Live-In-Game-SOG eines einzelnen laufenden Spiels und bleibt unverändert.

**B) Wie gross ist der gemessene Unterschied?** Mit einem bewusst **grosszügigen, nicht kalibrierten** Testkoeffizienten (K=0.3, volle Konfidenz ab 20 kumulierten Schüssen) und extremen Szenarien:

| Situation | SOG | Baseline (AJO/DRAW/AMB) | SOG-adjusted | Delta AJO |
|---|---|---|---|---|
| 34:00, 1:2 | 13:15 (nahe real) | 31.7 / 22.5 / 68.3 % | 31.1 / 22.4 / 68.9 % | −0.6pp |
| 34:00, 1:2 | 30:10 (extrem) | 31.7 / 22.5 / 68.3 % | 35.7 / 23.8 / 64.3 % | +4.1pp |
| 34:00, 1:2 | 10:30 (extrem) | 31.7 / 22.5 / 68.3 % | 27.8 / 21.1 / 72.2 % | −3.9pp |
| **58:00, 2:1** | 10:30 (AMB dominiert Schüsse) | 96.6 / 7.1 / 3.4 % | 96.3 / 7.6 / 3.7 % | **−0.3pp** |
| **58:00, 2:1** | 30:10 (AJO dominiert Schüsse) | 96.6 / 7.1 / 3.4 % | 96.9 / 6.5 / 3.1 % | **+0.3pp** |
| 5:00, 0:0 | 4:1 (kleine Stichprobe) | 58.9 / 17.8 / 41.1 % | 60.8 / 17.6 / 39.2 % | +1.9pp |
| 31:00, 1:1→1:2 (Tor) | 12:14→12:15 | 57.1%→33.1% AJO (Tor-Sprung: **−24pp**) | 56.4%→32.2% AJO | Tor-Effekt bleibt dominant, SOG-Effekt <1pp |

**C) Welcher Ansatz wurde getestet?** Shot-Share (`homeSOG/(homeSOG+awaySOG)`) statt absoluter SOG-Differenz - vermeidet, dass spät im Spiel automatisch grössere Zahlen einen grösseren Effekt hätten, ohne dass die Spielzeit das schon über `remainingFraction` regelt. Multiplikative Reskalierung von `expHomeFull`/`expAwayFull` (wirkt nur auf die noch zu erwartenden Resttore, nicht direkt auf die fertige Prozentzahl - exakt die in Abschnitt 12 geforderte Architektur). Konfidenzrampe über die kumulierte Schusszahl (min. 20 für volle Wirkung) verhindert Overreaction bei sehr wenigen Schüssen früh im Spiel.

**D) Konkrete Deltas:** Selbst mit dem grosszügig gewählten Test-Koeffizienten bleiben die Effekte bei realistischen SOG-Differenzen (34') im Bereich von 3-4 Prozentpunkten, bei extremer Führung spät im Spiel (58') unter 0.5 Prozentpunkten - die Restzeit-Skalierung (`remainingFraction`) macht SOG-Einflüsse in der Schlussphase automatisch bedeutungslos, weil dort ohnehin fast keine Tore mehr erwartet werden. Der Score-Sprung durch ein Tor (~24pp im Test) bleibt um eine Grössenordnung dominanter als jeder getestete SOG-Effekt.

**E) Gibt es historische Evidenz für zusätzlichen Informationswert?** **Nein, nicht überprüfbar.** `server/data/db.json` enthält für die laufende Saison 2026/27 **0 finale Spiele** (Saisonstart war erst am Tag der vorherigen Analyse-Session) - keine einzige abgeschlossene Partie mit periodenweisem SOG-Verlauf zum Validieren. Der `server/data/historical/`-Ordner (frühere Saisons, von `server/scripts/backtesting/` genutzt) existiert lokal **nicht** (gitignored, nie generiert - bereits beim Testlauf von `test:backtest` in einer früheren Session mit `ENOENT` aufgefallen). Eine Brier-Score-/Log-Loss-/Calibration-Auswertung "Base Model vs. Base+SOG" war deshalb **nicht möglich** - es wird hier ausdrücklich **nicht vorgetäuscht**, dass eine solche Validierung stattgefunden hätte.

**F) Sollte SOG implementiert werden?** **Nein, aktuell nicht.** Entscheidung nach dem im Auftrag vorgegebenen Kriterium **B) "SOG verändert die Probability zwar, aber ohne ausreichende Evidenz → NICHT implementieren, als optionalen zukünftigen Faktor dokumentieren"**: Der gemessene Effekt ist real, klein und architektonisch stabil (kein Kaputtgehen von Score-Dominanz/Tor-Sprüngen, keine Overreaction früh im Spiel) - aber es gibt **keine Datenbasis**, um den Koeffizienten `K` oder die Konfidenz-Schwelle `MIN_SAMPLE_SOG` seriös zu kalibrieren, und **keine historische Validierung**, dass die Anpassung die tatsächliche Vorhersagegüte verbessert statt nur Rauschen hinzuzufügen.

**G) Falls ja - Gewichtung/Begründung:** Entfällt (siehe F).

**H) Falls nein - warum nicht:**
1. Keine Kalibrierungsdaten für `K`/`MIN_SAMPLE_SOG` (frei gewählt für den Test, exakt das in Abschnitt 4 der Aufgabenstellung verbotene "Prozente erfinden").
2. Keine historischen Spieldaten (0 finale Spiele in db.json, kein `historical/`-Ordner lokal vorhanden) zur Validierung von zusätzlicher Vorhersagekraft.
3. Der gemessene Effekt ist selbst im günstigsten Testfall klein (3-4pp) - ein Implementieren würde Komplexität/Fehleroberfläche hinzufügen, ohne nachweisbaren Nutzen.

**Konsequenz:** `liveProbability.js`, `liveDemoData.js` und alle bestehenden Tests bleiben **unverändert**. SOG bleibt ein reines Anzeige-/Statistikfeld in `LiveStatistics.jsx` (SOG, Schüsse, Bullys, Powerplay) - dort korrekt nicht als "beeinflusst die Probability" beschriftet. Dieser Abschnitt dient als Referenz, falls später (a) eine echte Live-Datenhistorie mit Ergebnissen vorliegt und (b) daraus ein kalibrierter Koeffizient abgeleitet werden kann - erst dann wäre eine Neubewertung sinnvoll.

---

**Hinweis:** Dies ist ausschliesslich eine Machbarkeitsanalyse plus (ab Abschnitt 25) die tatsächliche Implementierung der Probability-Engine. Backend/SIHF-Sync wurde nur um den in 25.6 genannten Bugfix ergänzt, sonst nicht verändert. Keine neuen Dependencies, keine `liveState`-Struktur, kein Live-Polling. Abschnitt 26 dokumentiert einen durchgeführten, aber NICHT umgesetzten SOG-Sensitivitätstest.

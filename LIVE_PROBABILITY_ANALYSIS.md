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

**Hinweis:** Dies ist ausschliesslich eine Machbarkeitsanalyse. Es wurde nichts implementiert, keine Dependencies installiert, keine anderen Dateien verändert.

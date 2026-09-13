# 🏒 NL Tracker 2026/27

Ein privater Tracker für die Schweizer **National League** Saison 2026/27:
ELO-Ranking der Teams, klassische Ligatabelle, Spieler-Ranglisten und schnelle
Erfassung von Spielen inkl. Spieler-Statistiken. Alle Daten trägst du selbst
ein – es wird keine externe Datenquelle benötigt.

Frontend: **React + Vite**. Persistenz: eine **JSON-Datei im Projekt**
(`server/data/db.json`), die ein kleiner **Node/Express-Server** liest und
schreibt.

---

## Voraussetzungen

- **Node.js 18 oder neuer** (empfohlen: 20/22). Prüfen mit `node -v`.
- npm (kommt mit Node).

## Installation & Start

```bash
npm install
npm run dev
```

`npm run dev` startet **beides gleichzeitig**:

- den API-Server auf <http://localhost:3001>
- das Vite-Frontend auf <http://localhost:5173>

Danach im Browser **http://localhost:5173** öffnen. Fertig.

> Der Vite-Dev-Server proxyt alle `/api`-Aufrufe automatisch an den Express-Server –
> du musst dich also um nichts kümmern.

### In IntelliJ IDEA / WebStorm öffnen

1. ZIP entpacken.
2. In IntelliJ **File → Open…** und den entpackten Ordner `nl-tracker` wählen.
3. Ein Terminal öffnen (unten) und `npm install`, dann `npm run dev` ausführen.
   (Alternativ die npm-Scripts im „npm"-Tool-Fenster per Doppelklick starten.)

---

## So benutzt du die App

1. **Kader anlegen** – unter **Teams & Kader** ein Team öffnen und Spieler
   hinzufügen (Name, Nummer, Position: Torhüter / Verteidiger / Stürmer).
   Die 14 NL-Teams sind bereits vorbefüllt.
2. **Spiel erfassen** – unter **Spiel erfassen**: Datum, Heim, Auswärts,
   Endstand und ggf. Overtime/Penalty wählen. Darunter erscheinen beide Kader.
   Trage Tore/Assists/± /Strafminuten (bzw. Gegentore/Paraden bei Torhütern)
   direkt in die Tabelle ein. Eine Zeile wird automatisch als „dabei" markiert,
   sobald du etwas einträgst. Mit **Tab** springst du schnell durch die Felder.
3. Alles Weitere – **Tabelle**, **ELO-Ranking** und **Spieler-Ranking** –
   berechnet sich automatisch aus den erfassten Spielen.

### Punkte- und ELO-System

- **Tabelle:** Sieg 3, OT/PS-Sieg 2, OT/PS-Niederlage 1, Niederlage 0.
- **ELO:** Startwert, K-Faktor und Heimvorteil sind in den **Einstellungen**
  anpassbar. Reguläre Siege zählen mit 1,0, OT/PS-Siege mit 0,75 (knappe
  Entscheidungen werden schwächer gewichtet).

---

## Datenspeicherung

- Alles liegt in **`server/data/db.json`**. Diese Datei wird beim ersten Start
  automatisch aus `server/data/seed.json` (14 Teams) erzeugt.
- In den **Einstellungen** kannst du zusätzlich ein Backup als JSON
  exportieren/importieren.
- Möchtest du bei Null anfangen: `server/data/db.json` löschen – beim nächsten
  Start wird sie neu aus dem Seed erstellt.

---

## Projektstruktur

```
nl-tracker/
├─ index.html              # HTML-Einstieg (Vite)
├─ vite.config.js          # Vite-Config inkl. /api-Proxy auf Port 3001
├─ package.json            # Scripts & Abhängigkeiten
├─ server/
│  ├─ index.js             # Express-API (liest/schreibt db.json)
│  └─ data/
│     ├─ seed.json         # 14 NL-Teams (Vorlage)
│     └─ db.json           # deine Live-Daten (wird automatisch erzeugt)
└─ src/
   ├─ main.jsx             # React-Einstieg
   ├─ App.jsx              # Layout + Routing
   ├─ DataContext.jsx      # zentraler State + abgeleitete Statistiken
   ├─ api.js               # fetch-Wrapper für die API
   ├─ elo.js               # ELO-Berechnung
   ├─ stats.js             # Tabelle & Spieler-Statistik
   ├─ styles.css           # Design-System (Dark Mode)
   ├─ components/
   │  └─ ui.jsx            # Wiederverwendbare UI (Tabelle, Modal, Toast …)
   └─ pages/
      ├─ Dashboard.jsx
      ├─ Standings.jsx
      ├─ EloRanking.jsx
      ├─ PlayerRankings.jsx
      ├─ Games.jsx
      ├─ GameEntry.jsx     # schnelle Spiel-/Stat-Erfassung
      ├─ Teams.jsx
      ├─ TeamDetail.jsx    # Kaderverwaltung
      ├─ PlayerDetail.jsx
      └─ Settings.jsx
```

## Nützliche Scripts

| Befehl            | Zweck                                                          |
|-------------------|-----------------------------------------------------------------|
| `npm run dev`     | Server **und** Frontend-Dev-Server starten (Entwicklung, 2 Ports) |
| `npm run build`   | Nur Produktions-Build des Frontends (`dist/`)                  |
| `npm run start`   | Nur den API-Server starten (kein Build, kein Frontend-Ausliefern) |
| `npm run serve`   | **Build + Server in einem Prozess** – siehe unten               |

---

## Dauerbetrieb / Produktion (ein Prozess, ein Port)

Für den Alltagsbetrieb (der Tracker soll einfach laufen, ohne dass du an Vite
denken musst) gibt es `npm run serve`:

```bash
npm run serve
```

Das baut das Frontend (`vite build` → `dist/`) und startet danach **nur noch
den Express-Server** – der liefert ab jetzt sowohl die API (`/api/...`) als
auch das gebaute Frontend selbst aus. **Alles läuft unter einem einzigen
Port:**

**http://localhost:3001**

Kein separater Vite-Prozess mehr nötig. Unbekannte Routen (z. B. ein
Deep-Link wie `/players/xyz` nach einem Reload) liefern automatisch
`index.html` aus (SPA-Fallback), `/api/...`-Pfade sind davon ausgenommen und
verhalten sich wie gewohnt.

> Der Dev-Modus (`npm run dev`, zwei Ports 3001 + 5173 mit Hot-Reload und
> `/api`-Proxy) ist davon unberührt und funktioniert weiterhin unverändert –
> nutze ihn, wenn du am Code arbeitest. `npm run serve` ist für den
> "einfach laufen lassen"-Betrieb gedacht.

### Auto-Sync im Dauerbetrieb

Sobald der Server läuft (egal ob per `npm run dev` oder `npm run serve`),
synchronisiert er automatisch im Hintergrund:

- **NL-API-Sync** (Spiele/Tabelle/Spieler, `nationalleague.ch`): einmal sofort
  beim Start, danach alle **30 Minuten** (die API selbst cacht 10 Minuten –
  30 Minuten respektiert das mit Puffer).
- **SIHF-Sync** (Live-Boxscores für bereits terminierte Spiele): alle **5
  Minuten**.

Beide sind standardmässig **aktiv** und brauchen keine Konfiguration. Falls du
einen davon (z. B. für einen kurzen lokalen Test) abschalten willst, setze vor
dem Start eine Umgebungsvariable:

```bash
# PowerShell
$env:NL_AUTO_SYNC = "0"       # NL-API-Sync-Intervall aus
$env:SIHF_AUTO_SYNC = "0"     # SIHF-Sync-Intervall aus
npm run serve
```

(`NL_SYNC_INTERVAL_MIN` bzw. `SIHF_SYNC_INTERVAL_MIN` überschreiben bei Bedarf
das jeweilige Intervall in Minuten.)

---

## Automatischer Start beim Windows-Login

Im Projektordner liegt **`start-nl-tracker.bat`** – sie wechselt automatisch
ins Projektverzeichnis und führt `npm run serve` aus. Lass das sich öffnende
Konsolenfenster einfach offen; der Tracker läuft, solange es offen ist
(Fenster schliessen = Server stoppen).

### Variante A – Autostart-Ordner (am einfachsten)

1. `Win + R` → `shell:startup` eingeben → Enter. Es öffnet sich dein
   persönlicher Autostart-Ordner.
2. Eine **Verknüpfung** zu `start-nl-tracker.bat` in diesen Ordner legen
   (Rechtsklick auf die Datei → *Senden an* → *Desktop (Verknüpfung
   erstellen)*, die Verknüpfung dann in den Autostart-Ordner verschieben).
3. Fertig – ab dem nächsten Login startet der Tracker automatisch (mit
   sichtbarem Konsolenfenster).

### Variante B – Aufgabenplanung (mehr Kontrolle, z. B. minimiert starten)

1. `Win + R` → `taskschd.msc` → Enter, öffnet die **Aufgabenplanung**.
2. Rechts **„Einfache Aufgabe erstellen…"** wählen.
3. Name z. B. `NL Tracker`, *Weiter*.
4. Trigger: **„Bei der Anmeldung"**, *Weiter*.
5. Aktion: **„Programm starten"**, *Weiter*.
6. *Programm/Skript*: Pfad zu `start-nl-tracker.bat` eintragen (z. B.
   `C:\Users\<dich>\OneDrive\Desktop\Nationalleague\nl-tracker\nl-tracker\start-nl-tracker.bat`),
   *Weiter* → *Fertig stellen*.
7. Optional für ein minimiertes/unauffälligeres Fenster: die erstellte
   Aufgabe in der Liste doppelklicken → Reiter **„Aktionen"** → Aktion
   bearbeiten → bei *Argumente hinzufügen* z. B. nichts nötig, aber im Reiter
   **„Allgemein"** lässt sich *„Nur ausführen, wenn Benutzer angemeldet ist"*
   setzen (empfohlen, da sonst kein sichtbares Fenster erscheint, in dem der
   Server läuft).

In beiden Fällen gilt: der PC muss eingeschaltet und eingeloggt sein, damit
der Tracker erreichbar ist – kein echter 24/7-Serverbetrieb ohne laufenden
PC, aber „läuft automatisch mit, solange der PC an ist".

Viel Spass mit der Saison 2026/27! 🇨🇭🏒

# Team-Logos

Dieser Ordner wird von `src/teamLogos.js` referenziert (Pfad `/teams/<datei>.png`).
Vite liefert alles unter `public/` unverändert unter der Root-URL aus (siehe
`public/favicon.svg` für dasselbe Muster) - es ist keine Build-Konfiguration
nötig, sobald die Dateien hier liegen.

Fehlt eine Datei (noch), fällt `TeamLogo`/`TeamBadge` automatisch auf den
bisherigen Farbpunkt zurück - kein kaputtes Bild-Icon, kein Dummy-Logo.

Benötigt werden genau diese 14 Dateien (Zuordnung siehe `src/teamLogos.js`):

| Datei              | Team-ID     | Verein                    |
|--------------------|-------------|----------------------------|
| `ajoie.png`        | `team_ajo`  | HC Ajoie                  |
| `ambri.png`        | `team_apk`  | HC Ambrì-Piotta            |
| `bern.png`         | `team_scb`  | SC Bern                   |
| `biel.png`         | `team_bie`  | EHC Biel                  |
| `davos.png`        | `team_dav`  | HC Davos                  |
| `fribourg.png`     | `team_fri`  | Fribourg-Gottéron          |
| `servette.png`     | `team_gse`  | Genève-Servette HC         |
| `kloten.png`       | `team_klo`  | EHC Kloten                |
| `tigers.png`       | `team_scl`  | SCL Tigers                |
| `lausanne.png`     | `team_lau`  | Lausanne HC                |
| `lugano.png`       | `team_lug`  | HC Lugano                 |
| `rapperswil.png`   | `team_rap`  | Rapperswil-Jona Lakers      |
| `zug.png`          | `team_zug`  | EV Zug                    |
| `zsc.png`          | `team_zsc`  | ZSC Lions                 |

Empfehlungen für die Dateien selbst:
- PNG mit transparentem Hintergrund
- möglichst quadratisch zugeschnitten (die Anzeige nutzt `object-fit: contain`,
  verzerrt also auch bei abweichendem Seitenverhältnis nicht - ein etwa
  quadratischer Zuschnitt sieht in dichten Listen/Tabellen aber am saubersten aus)
- mindestens ca. 128×128px, damit auch grössere Darstellungen (Team-Detail-Header,
  Match-Detail-Header) nicht verpixeln

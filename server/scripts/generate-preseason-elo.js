// ---------------------------------------------------------------------------
// Einmalig auszuführendes Generierungs-Skript für die Pre-Season-ELO-
// Komponente (src/preseasonElo.js).
//
// Berechnet das Saisonend-ELO jedes aktuell in der NL vertretenen Teams nach
// der letzten verfügbaren historischen Archiv-Saison (2025/26), indem die
// UNVERÄNDERTE, produktive computeElo()-Funktion aus src/elo.js direkt auf
// die (auf produktive team_xxx-IDs gemappten) historischen Spiele
// server/data/historical/*.json angewendet wird - inkl. deren eigener,
// bereits validierter Saisonübergangs-Regression (ELO_CONFIG.seasonEndRegression
// = 25%, siehe server/scripts/backtest-preseason-h2h.js für die Validierung,
// dass diese Regressionsstufe auch für den Pre-Season-Übertrag geeignet ist -
// die 0-30%-Regressionsstufen waren im Backtest statistisch nicht
// unterscheidbar, weshalb bewusst KEIN neuer, separat getunter Parameter
// eingeführt wird, sondern der bereits validierte Produktivwert wiederverwendet
// wird).
//
// Keine neue ELO-Formel, keine neuen Gewichtungen - reine Wiederverwendung
// von src/elo.js. Verändert KEINE historischen Quelldaten, nur ein rein
// abgeleiteter, statischer Export für den Client
// (public/preseason-elo.json = { teamId: saisonEndRating, ... }).
//
// Erneut ausführen, sobald eine neue Saison zum historischen Archiv
// hinzugefügt wird (server/data/historical/) - der laufenden Saison selbst
// wird dabei NIE etwas entnommen (streng leak-frei: nur abgeschlossene
// historische Saisons fliessen ein).
//
// Aufruf: node server/scripts/generate-preseason-elo.js
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { computeElo, ELO_CONFIG } from '../../src/elo.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'historical')
const OUT_PATH = path.join(__dirname, '..', '..', 'public', 'preseason-elo.json')

const SEASON_FILES = [
  '2017-18', '2018-19', '2019-20', '2020-21', '2021-22',
  '2022-23', '2023-24', '2024-25', '2025-26',
]

// sihfId (historische Daten) -> produktive Team-ID (server/data/db.json).
// Identische Tabelle wie in server/scripts/generate-historical-h2h.js
// (dupliziert statt importiert, um dieses Skript unabhängig lauffähig zu
// halten - genau wie beim bestehenden H2H-Export).
const SIHF_TO_TEAM_ID = {
  103144: 'team_ajo', 101152: 'team_apk', 102126: 'team_scb', 102128: 'team_bie',
  101151: 'team_dav', 103138: 'team_fri', 103140: 'team_gse', 101149: 'team_klo',
  102127: 'team_scl', 103141: 'team_lau', 101150: 'team_lug', 101060: 'team_rap',
  101144: 'team_zug', 101139: 'team_zsc',
}

function main() {
  const games = []
  let skippedUnmapped = 0

  for (const f of SEASON_FILES) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8'))
    for (const g of raw.games) {
      const homeTeamId = SIHF_TO_TEAM_ID[g.homeTeam.sihfId]
      const awayTeamId = SIHF_TO_TEAM_ID[g.awayTeam.sihfId]
      if (!homeTeamId || !awayTeamId) { skippedUnmapped++; continue }
      games.push({
        id: `${f}_${games.length}`,
        date: g.date,
        season: g.season,
        status: 'final',
        homeTeamId, awayTeamId,
        homeGoals: g.homeGoals, awayGoals: g.awayGoals, decision: g.decision,
      })
    }
  }
  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const teams = Object.values(SIHF_TO_TEAM_ID).map((id) => ({ id }))

  // Exakt dieselbe, unveränderte Produktivfunktion wie im laufenden Betrieb -
  // keine settings-Overrides, damit ELO_CONFIG-Defaults (K=16, homeAdv=65,
  // goalDiffFactor=0.7, OT/SO-Gewichtung, seasonEndRegression=0.25) greifen.
  const { ratings } = computeElo(teams, games, {})

  const out = {}
  for (const t of teams) out[t.id] = Math.round(ratings[t.id] * 10) / 10

  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2))
  console.log(`Geschrieben: ${OUT_PATH}`)
  console.log(`Spiele verarbeitet: ${games.length} (übersprungen, nicht mehr in der NL: ${skippedUnmapped})`)
  console.log(`Saisonende-ELO nach letzter Archiv-Saison (${SEASON_FILES.at(-1)}), seasonEndRegression=${ELO_CONFIG.seasonEndRegression}:`)
  for (const [id, r] of Object.entries(out).sort((a, b) => b[1] - a[1])) console.log(`  ${id.padEnd(10)} ${r}`)
}

main()

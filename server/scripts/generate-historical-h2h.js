// ---------------------------------------------------------------------------
// Einmalig auszuführendes Generierungs-Skript für die Head-to-Head-Seite.
//
// Liest die UNVERÄNDERTEN historischen SIHF-Saisondaten
// (server/data/historical/*.json) und exportiert daraus einen kompakten,
// statischen Datensatz aller historischen Spiele ZWISCHEN AKTUELL IN DER NL
// VERTRETENEN TEAMS (public/historical-h2h.json), im selben ID-Schema wie
// die produktiven Spiele (team_xxx statt sihfId) - damit die Head-to-Head-
// Seite historische und aktuelle Spiele einheitlich verarbeiten kann, ohne
// selbst irgendein ID-Mapping zu kennen.
//
// Verändert KEINE historischen Quelldaten, nur ein rein abgeleiteter,
// statischer Export für den Client. Erneut ausführen, falls sich die
// historischen Rohdaten oder die Team-Zuordnung ändern sollten (aktuell
// nicht der Fall).
//
// Aufruf: node server/scripts/generate-historical-h2h.js
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'historical')
const OUT_PATH = path.join(__dirname, '..', '..', 'public', 'historical-h2h.json')

const SEASON_FILES = [
  '2017-18', '2018-19', '2019-20', '2020-21', '2021-22',
  '2022-23', '2023-24', '2024-25', '2025-26',
]

// sihfId (historische Daten) -> produktive Team-ID (server/data/db.json).
// Verifiziert: sihfId ist über alle 9 Saisons hinweg stabil pro Team (siehe
// Analyse in der Konversation - keine Umbenennungen/ID-Wechsel).
const SIHF_TO_TEAM_ID = {
  103144: 'team_ajo', // HC Ajoie
  101152: 'team_apk', // HC Ambri-Piotta
  102126: 'team_scb', // SC Bern
  102128: 'team_bie', // EHC Biel-Bienne
  101151: 'team_dav', // HC Davos
  103138: 'team_fri', // Fribourg-Gottéron
  103140: 'team_gse', // Genève-Servette HC
  101149: 'team_klo', // EHC Kloten
  102127: 'team_scl', // SCL Tigers
  103141: 'team_lau', // Lausanne HC
  101150: 'team_lug', // HC Lugano
  101060: 'team_rap', // SC Rapperswil-Jona Lakers
  101144: 'team_zug', // EV Zug
  101139: 'team_zsc', // ZSC Lions
  // 103139 (HC La Chaux-de-Fonds) bewusst NICHT gemappt - aktuell nicht in der NL.
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
        date: g.date,
        season: g.season,
        homeTeamId,
        awayTeamId,
        homeGoals: g.homeGoals,
        awayGoals: g.awayGoals,
        decision: g.decision,
      })
    }
  }

  games.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  fs.writeFileSync(OUT_PATH, JSON.stringify(games))
  console.log(`Geschrieben: ${OUT_PATH}`)
  console.log(`Spiele exportiert: ${games.length} (übersprungen, nicht mehr in der NL: ${skippedUnmapped})`)
  const sizeKb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1)
  console.log(`Dateigrösse: ${sizeKb} KB`)
}

main()

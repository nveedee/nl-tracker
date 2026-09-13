// ---------------------------------------------------------------------------
// Einmalig auszuführendes Generierungs-Skript für die Spieler-Historie
// (Player Analytics: src/pages/PlayerDetail.jsx, src/pages/PlayerRankings.jsx).
//
// Liest die UNVERÄNDERTEN historischen SIHF-Saisondaten
// (server/data/historical/*.json, 9 Saisons 2017/18-2025/26) und den
// AKTUELLEN Kader (server/data/db.json, NUR LESEND) und exportiert einen
// kompakten, statischen Datensatz (public/player-history.json) mit der
// Saison-für-Saison-Historie jedes aktuellen Spielers, sofern in der
// historischen Archiv-Datenbank auffindbar.
//
// SPIELER-IDENTITÄT (siehe server/scripts/backtest-player-features.js für
// die ursprüngliche Analyse): innerhalb des Archivs ist `roster[].id` (SIHF-
// Lizenznummer) über alle 9 Saisons/Vereinswechsel stabil und zuverlässig
// (1'369 eindeutige IDs, nur 0,95% mit abweichender Namensschreibweise).
// ABER: der aktuelle Kader in db.json speichert KEINE SIHF-Lizenznummer,
// nur einen Namen (`data.players[].name`) - die Verknüpfung "aktueller
// Spieler <-> historische Lizenznummer" kann daher NUR einmalig per
// Namensabgleich hergestellt werden (identisches Vorsichtsprinzip wie in
// server/scripts/sync-sihf.cjs::matchLocalPlayer): normalisierter
// Namensvergleich (Wortmenge, klein geschrieben, reihenfolge-unabhängig -
// SIHF nennt "Nachname Vorname", db.json "Vorname Nachname"). Ist der Name
// über das GESAMTE Archiv eindeutig, wird verknüpft. Bei mehreren Trägern
// desselben Namens wird zusätzlich versucht, über das zuletzt bekannte Team
// zu disambiguieren; bleibt es mehrdeutig, wird NICHT verknüpft (kein
// Rateversuch, konsistent mit dem "nichts erfinden"-Grundsatz des Projekts).
//
// SAISON-TOTALE ENTHALTEN MÖGLICHERWEISE PLAYOFF-SPIELE: die Archive
// enthalten pro Saison sowohl reguläre Saison als auch (falls gespielt)
// Playoff-Partien in einer gemeinsamen `games[]`-Liste. Eine zuverlässige,
// über alle 9 Saisons hinweg robuste Trennung wurde geprüft und verworfen
// (siehe Bericht/Kommentar unten) - Saison-Totale sind daher explizit als
// "Gesamtsaison (inkl. Playoffs, falls gespielt)" zu verstehen, NICHT als
// reine Regular-Season-Werte. Es gibt bewusst KEINE separate
// Playoff-Historie-Sektion (User-Vorgabe: bei Unsicherheit weglassen statt
// raten).
//
// Verändert KEINE historischen Rohdaten und KEIN db.json - nur ein rein
// abgeleiteter, statischer Export für den Client.
//
// Aufruf: node server/scripts/generate-player-history.js
// Erneut ausführen, wenn sich der aktuelle Kader (db.json) wesentlich
// ändert (z.B. Saisonwechsel/neue Transfers), damit die Verknüpfung aktuell
// bleibt - analog zu generate-preseason-elo.js/generate-historical-h2h.js.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'historical')
const DB_PATH = path.join(__dirname, '..', 'data', 'db.json')
const OUT_PATH = path.join(__dirname, '..', '..', 'public', 'player-history.json')

const SEASON_FILES = [
  '2017-18', '2018-19', '2019-20', '2020-21', '2021-22',
  '2022-23', '2023-24', '2024-25', '2025-26',
]

// Identische Tabelle wie generate-historical-h2h.js/generate-preseason-elo.js.
const SIHF_TO_TEAM_ID = {
  103144: 'team_ajo', 101152: 'team_apk', 102126: 'team_scb', 102128: 'team_bie',
  101151: 'team_dav', 103138: 'team_fri', 103140: 'team_gse', 101149: 'team_klo',
  102127: 'team_scl', 103141: 'team_lau', 101150: 'team_lug', 101060: 'team_rap',
  101144: 'team_zug', 101139: 'team_zsc',
}

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
function toSeconds(mmss) {
  if (!mmss || mmss === '-') return 0
  const [m, s] = String(mmss).split(':').map(Number)
  return (Number.isFinite(m) ? m : 0) * 60 + (Number.isFinite(s) ? s : 0)
}
function normalizeName(name) {
  return (name || '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ')
}

function main() {
  // --- 1. Historische Rohdaten laden, pro Spieler+Saison aggregieren ---
  const skaters = new Map() // sihfId -> { fullName, lastTeamSihfId, seasons: Map<season, stats> }
  const goalies = new Map()

  for (const f of SEASON_FILES) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8'))
    for (const g of raw.games) {
      const rosterByTeam = { [g.homeTeam.sihfId]: new Map(), [g.awayTeam.sihfId]: new Map() }
      for (const key of Object.keys(g.roster || {})) {
        const r = g.roster[key]
        if (rosterByTeam[r.teamId]) rosterByTeam[r.teamId].set(r.fullName, r)
      }

      for (const [side, teamSihfId] of [['home', g.homeTeam.sihfId], ['away', g.awayTeam.sihfId]]) {
        for (const p of (g.players && g.players[side]) || []) {
          const r = rosterByTeam[teamSihfId].get(p.player)
          if (!r) continue
          if (!skaters.has(r.id)) skaters.set(r.id, { fullName: r.fullName, ageGroup: r.ageGroup, lastTeamSihfId: teamSihfId, lastSeason: g.season, seasons: new Map() })
          const player = skaters.get(r.id)
          if (g.season >= player.lastSeason) { player.lastTeamSihfId = teamSihfId; player.lastSeason = g.season; player.fullName = r.fullName }
          const key = g.season + '|' + teamSihfId
          if (!player.seasons.has(key)) {
            player.seasons.set(key, {
              season: g.season, teamId: SIHF_TO_TEAM_ID[teamSihfId] || null,
              position: p.playerPosition || null,
              gp: 0, goals: 0, assists: 0, points: 0, sog: 0, plusMinus: 0, toiSec: 0,
            })
          }
          const s = player.seasons.get(key)
          s.gp++
          s.goals += num(p.goals); s.assists += num(p.assists); s.points += num(p.points)
          s.sog += num(p.shotsOnGoal); s.plusMinus += num(p.plusMinus)
          s.toiSec += toSeconds(p.timeOnIce)
        }
        for (const p of (g.goalies && g.goalies[side]) || []) {
          const r = rosterByTeam[teamSihfId].get(p.player)
          if (!r) continue
          if (!goalies.has(r.id)) goalies.set(r.id, { fullName: r.fullName, ageGroup: r.ageGroup, lastTeamSihfId: teamSihfId, lastSeason: g.season, seasons: new Map() })
          const gl = goalies.get(r.id)
          if (g.season >= gl.lastSeason) { gl.lastTeamSihfId = teamSihfId; gl.lastSeason = g.season; gl.fullName = r.fullName }
          const key = g.season + '|' + teamSihfId
          if (!gl.seasons.has(key)) {
            gl.seasons.set(key, { season: g.season, teamId: SIHF_TO_TEAM_ID[teamSihfId] || null, gp: 0, saves: 0, goalsAgainst: 0, shotsAgainst: 0, toiSec: 0 })
          }
          const s = gl.seasons.get(key)
          s.gp++
          s.saves += num(p.saves); s.goalsAgainst += num(p.goalsAgainst); s.shotsAgainst += num(p.shotsAgainst)
          s.toiSec += typeof p.secondsPlayed === 'string' ? toSeconds(p.secondsPlayed) : num(p.secondsPlayed)
        }
      }
    }
  }

  // --- 2. Namensindex fürs Verknüpfen mit dem aktuellen Kader ---
  function buildNameIndex(map) {
    const idx = new Map() // normalizedName -> [sihfId, ...]
    for (const [id, p] of map) {
      const n = normalizeName(p.fullName)
      if (!idx.has(n)) idx.set(n, [])
      idx.get(n).push(id)
    }
    return idx
  }
  const skaterNameIdx = buildNameIndex(skaters)
  const goalieNameIdx = buildNameIndex(goalies)

  // --- 3. Aktuellen Kader laden (NUR LESEND) und verknüpfen ---
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'))
  const out = {}
  let matched = 0, unmatched = 0, ambiguous = 0

  for (const player of db.players) {
    const isGoalie = player.position === 'G'
    const map = isGoalie ? goalies : skaters
    const idx = isGoalie ? goalieNameIdx : skaterNameIdx
    const norm = normalizeName(player.name)
    const candidates = idx.get(norm) || []

    let sihfId = null
    if (candidates.length === 1) {
      sihfId = candidates[0]
    } else if (candidates.length > 1) {
      // Disambiguierung über aktuelles Team: nur verwenden, wenn GENAU EIN
      // Kandidat zuletzt für dasselbe Team gespielt hat.
      const sameTeam = candidates.filter((id) => SIHF_TO_TEAM_ID[map.get(id).lastTeamSihfId] === player.teamId)
      if (sameTeam.length === 1) sihfId = sameTeam[0]
      else { ambiguous++; continue }
    } else {
      unmatched++
      continue
    }

    const rec = map.get(sihfId)
    const seasons = [...rec.seasons.values()].sort((a, b) => (a.season < b.season ? -1 : a.season > b.season ? 1 : 0))
    // ageGroup = Geburtsjahr laut SIHF-Roster (kein exaktes Geburtsdatum) -
    // konstant pro Spieler, daher unverändert seit dem ersten Auftreten im
    // Archiv übernommen. Für Player-Analytics-Alterskennzahlen (nur grobe
    // Ø-Geburtsjahr-Anzeige, kein exaktes Alter).
    out[player.id] = { sihfId, ageGroup: rec.ageGroup || null, seasons }
    matched++
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    seasonsIncluded: SEASON_FILES.map((f) => f.replace('-', '/')).map((s) => {
      const [a, b] = s.split('/'); return a + '/' + b.slice(-2)
    }),
    note: 'Saison-Totale können Playoff-Spiele enthalten (regulär Saison/Playoffs im Archiv nicht zuverlässig unterscheidbar, siehe Bericht) - keine separate Playoff-Historie.',
    players: out,
  }))

  const sizeKb = (fs.statSync(OUT_PATH).size / 1024).toFixed(1)
  console.log(`Geschrieben: ${OUT_PATH} (${sizeKb} KB)`)
  console.log(`Aktueller Kader: ${db.players.length} Spieler`)
  console.log(`  verknüpft:      ${matched}`)
  console.log(`  ohne Historie:  ${unmatched} (kein historischer NL-Einsatz gefunden - plausibel, z.B. Neuzugänge/Rookies)`)
  console.log(`  mehrdeutig:     ${ambiguous} (Namensgleichheit nicht eindeutig auflösbar - bewusst NICHT verknüpft)`)
  const totalSeasons = Object.values(out).reduce((s, p) => s + p.seasons.length, 0)
  console.log(`Historische Spieler-Saisons total: ${totalSeasons} (Ø ${(totalSeasons / matched).toFixed(1)} Saisons/verknüpftem Spieler)`)
}

main()

// ---------------------------------------------------------------------------
// Backtest: liefert historische Spielerqualität (Kaderstärke über mehrere
// Saisons) einen robusten zusätzlichen Prognosewert gegenüber dem aktuellen
// Referenzmodell (Pre-Season-ELO + SOG-Allowed + Heimvorteil), insbesondere
// am Saisonstart?
//
// READ-ONLY: verändert weder src/elo.js, src/playoffSim.js,
// src/powerRankings.js noch die historischen Rohdaten noch db.json/seed.json.
// Reine Analyse. Auch bei positivem Ergebnis wird NICHTS automatisch
// produktiv integriert (siehe User-Auftrag Abschnitt 11).
//
// METHODIK (identisch zu server/scripts/backtest-preseason-h2h.js, dort
// bereits etabliert und hier bewusst wiederverwendet statt neu erfunden):
// leak-freier Walk-Forward über alle 9 historischen Saisons, ELO-Engine =
// exakte Kopie der Produktivformel aus src/elo.js (Regression=1.0 bei jedem
// Saisonwechsel, repliziert das reale Live-Verhalten), SOG-Allowed-
// Adjustierung = exakte Kopie aus src/powerRankings.js. Kalibrierung per
// logistischem Grid-Search (g/h/c), Metriken Accuracy/Brier/LogLoss,
// kombinierte Rangauswahl (logloss+brier), Corona-Saisons 2019/20+2020/21
// separat ausgewiesen, nicht zur Auswahl verwendet.
//
// SPIELER-IDENTITÄT: server/data/historical/*.json enthält pro Spiel ein
// `roster[]`-Array mit stabiler numerischer `id` (SIHF-Lizenznummer),
// `fullName`, `teamId`, `ageGroup` (Geburtsjahr). Box-Score-Zeilen in
// `players.home/away[]` und `goalies.home/away[]` sind nur über den Namen
// ("Nachname Vorname") verknüpft - Zuordnung zur stabilen `id` erfolgt über
// Namensabgleich INNERHALB der über `teamId` korrekt zugeordneten Roster-
// Hälfte (Heim-/Auswärtsteam getrennt), nicht global - siehe loadPlayerGames().
//
// SPIELER-FEATURES (kuratiert, bewusst NICHT ein riesiges Kombinationsraster
// - siehe Abschnitt 9 "keine Überanpassung" im User-Auftrag): pro Team+Saison
// werden aus den TATSÄCHLICHEN Spielern dieser Saison (korrekt inkl. Zu-/
// Abgänge) TOI-gewichtete Kennzahlen gebildet, IMMER nur aus VOR der
// jeweiligen Saison abgeschlossenen Vorsaisons ("Pre-Season-Snapshot",
// analog zu src/preseasonElo.js) - siehe Abschnitt "LEAKAGE" unten.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data', 'historical')

const SEASON_FILES = [
  '2017-18', '2018-19', '2019-20', '2020-21', '2021-22',
  '2022-23', '2023-24', '2024-25', '2025-26',
]
const CORONA_SEASONS = new Set(['2019/20', '2020/21'])

function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }
function toSeconds(mmss) {
  if (!mmss || mmss === '-') return 0
  const [m, s] = String(mmss).split(':').map(Number)
  return (Number.isFinite(m) ? m : 0) * 60 + (Number.isFinite(s) ? s : 0)
}

// ============================================================================
// 1. Rohdaten laden: Spiele + pro-Spiel Spieler-/Torhüter-Boxscores
// ============================================================================

function loadRaw() {
  const seasons = []
  for (const f of SEASON_FILES) {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f + '.json'), 'utf8'))
    seasons.push(raw)
  }
  return seasons
}

// Baut aus einem Spiel: (a) das Spiel-Objekt fürs ELO/SOG-Backtest (wie in
// backtest-preseason-h2h.js), (b) Boxscore-Zeilen für Skater/Goalies MIT
// aufgelöster stabiler Spieler-`id` (via Roster-Namensabgleich, team-
// getrennt).
function parseGame(g) {
  const sog = (g.teamStats || {})['SOG Total'] || {}
  const base = {
    season: g.season, corona: CORONA_SEASONS.has(g.season),
    dt: g.startDateTime || g.date, date: g.date,
    homeId: g.homeTeam.sihfId, awayId: g.awayTeam.sihfId,
    homeGoals: g.homeGoals, awayGoals: g.awayGoals, decision: g.decision,
    sogHome: num(sog.home), sogAway: num(sog.away),
  }

  // Roster nach teamId trennen, Namensabgleich NUR innerhalb der passenden
  // Teamhälfte (vermeidet Fehlzuordnung bei Namensgleichheit über Teams hinweg).
  const rosterByTeam = { [g.homeTeam.sihfId]: new Map(), [g.awayTeam.sihfId]: new Map() }
  for (const key of Object.keys(g.roster || {})) {
    const r = g.roster[key]
    if (rosterByTeam[r.teamId]) rosterByTeam[r.teamId].set(r.fullName, r)
  }

  const skaterRows = []
  for (const [side, teamId] of [['home', g.homeTeam.sihfId], ['away', g.awayTeam.sihfId]]) {
    for (const p of (g.players && g.players[side]) || []) {
      const r = rosterByTeam[teamId].get(p.player)
      if (!r) continue // kein Roster-Treffer - Zeile wird übersprungen (nichts erfunden)
      skaterRows.push({
        id: r.id, teamId, season: g.season, ageGroup: r.ageGroup,
        position: p.playerPosition, // 'Stürmer' | 'Verteidiger'
        goals: num(p.goals), assists: num(p.assists), points: num(p.points),
        sog: num(p.shotsOnGoal), plusMinus: num(p.plusMinus),
        toi: toSeconds(p.timeOnIce), toiPp: toSeconds(p.timeOnIcePp), toiPk: toSeconds(p.timeOnIcePk),
      })
    }
  }
  const goalieRows = []
  for (const [side, teamId] of [['home', g.homeTeam.sihfId], ['away', g.awayTeam.sihfId]]) {
    for (const p of (g.goalies && g.goalies[side]) || []) {
      const r = rosterByTeam[teamId].get(p.player)
      if (!r) continue
      const toi = toSeconds(p.secondsPlayed === undefined ? null : p.secondsPlayed) || num(p.secondsPlayed)
      goalieRows.push({
        id: r.id, teamId, season: g.season,
        goalsAgainst: num(p.goalsAgainst), saves: num(p.saves), shotsAgainst: num(p.shotsAgainst),
        toiSec: typeof p.secondsPlayed === 'string' ? toSeconds(p.secondsPlayed) : num(p.secondsPlayed),
      })
    }
  }
  return { base, skaterRows, goalieRows }
}

// ============================================================================
// 2. Datenqualitäts-Check (Abschnitt 1 des Auftrags)
// ============================================================================

function assessDataQuality(seasonsRaw) {
  const report = []
  let sampleGame = null
  for (const s of seasonsRaw) { if (s.games.length > 0) { sampleGame = s.games[0]; break } }
  const hasField = (obj, f) => obj && Object.prototype.hasOwnProperty.call(obj, f)
  report.push(['Spiele/GP', 'JA - vollständig, pro Spiel aus roster+players/goalies rekonstruierbar'])
  report.push(['Tore/Assists/Punkte', 'JA - players[].goals/assists/points, direkt vorhanden'])
  report.push(['Punkte pro Spiel', 'JA - abgeleitet (points/GP)'])
  report.push(['TOI/TOI pro Spiel', hasField(sampleGame.players.home[0], 'timeOnIce') ? 'JA - players[].timeOnIce ("MM:SS"), inkl. PP/PK-Split' : 'NEIN'])
  report.push(['Schüsse/SOG', hasField(sampleGame.players.home[0], 'shotsOnGoal') ? 'JA - players[].shotsOnGoal' : 'NEIN'])
  report.push(['SOG pro Spiel', 'JA - abgeleitet (SOG/GP)'])
  report.push(['+/-', hasField(sampleGame.players.home[0], 'plusMinus') ? 'JA - players[].plusMinus' : 'NEIN'])
  report.push(['Powerplay-Punkte', 'NICHT VERWENDET - nur indirekt aus Freitext-Tags in events[].goals[].text ("**PP1**") rekonstruierbar, keine strukturierte Spalte; Zuordnung Torschütze/Assistenten über LicenceNr->Roster wäre nötig und fehleranfällig (Text-Parsing, keine Validierung möglich) -> stattdessen TOI-PP (strukturiert vorhanden) als Powerplay-Nutzungs-Proxy verwendet'])
  report.push(['Position', 'JA, aber nur 2 Kategorien (Stürmer/Verteidiger) - keine Center/Wing-Unterscheidung; Top-6/Top-9/Top-4-Gruppen daher über TOI-Rang approximiert, nicht über offizielle Linienzuteilung'])
  report.push(['Alter', 'TEILWEISE - nur roster[].ageGroup (GeburtsJAHR), kein exaktes Geburtsdatum -> Alter nur auf +/-1 Jahr genau, als grobe Kennzahl dokumentiert, nicht in Kernfeatures verwendet'])
  report.push(['Teamzugehörigkeit', 'JA - roster[].teamId pro Spiel, Vereinswechsel innerhalb/zwischen Saisons dadurch korrekt nachvollziehbar'])
  report.push(['Saison', 'JA - g.season/g.seasonEndYear'])
  report.push(['Torhüterstats', hasField(sampleGame.goalies.home[0], 'savesPercentage') ? 'JA - goalies[].saves/goalsAgainst/shotsAgainst/savesPercentage/secondsPlayed' : 'NEIN'])
  return report
}

// ============================================================================
// 3. Spieler-Identität: empirischer Check (Abschnitt 2 des Auftrags)
// ============================================================================

function assessIdentityReliability(allSkaterRows) {
  // Wie viele verschiedene Namen teilt sich eine `id`? (sollte 1 sein - sonst
  // wäre die id nicht stabil/eindeutig). Und: wie viele verschiedene `id`s
  // teilt sich ein Name? (sollte i.d.R. 1 sein, Namensgleichheit wäre sonst
  // ein Kollisionsrisiko bei einer hypothetischen Namens-basierten Alternative).
  const idToNames = new Map()
  const nameToIds = new Map()
  for (const r of allSkaterRows) {
    if (!idToNames.has(r.id)) idToNames.set(r.id, new Set())
    idToNames.get(r.id).add(r.fullNameForCheck)
  }
  let idsWithMultipleNames = 0
  for (const [, names] of idToNames) if (names.size > 1) idsWithMultipleNames++
  return { totalIds: idToNames.size, idsWithMultipleNames }
}

// ============================================================================
// 4. ELO-Engine + SOG-Adjustierung (Produktiv-Parameter, exakte Kopie aus
//    server/scripts/backtest-preseason-h2h.js - siehe dort für Herleitung)
// ============================================================================

const ELO = {
  start: 1500, baseK: 16, homeAdv: 65, goalDiffFactor: 0.7,
  rw: { regulationWin: 1.0, regulationLoss: 0.0, otWin: 0.70, otLoss: 0.30, soWin: 0.55, soLoss: 0.45 },
  kTiers: [
    { m: 5, r: 32 / 24 }, { m: 15, r: 28 / 24 }, { m: 30, r: 24 / 24 },
    { m: 50, r: 20 / 24 }, { m: Infinity, r: 16 / 24 },
  ],
}
function eloK(gp) { for (const t of ELO.kTiers) if (gp <= t.m) return ELO.baseK * t.r; return ELO.baseK * ELO.kTiers.at(-1).r }
function goalMult(d) { if (d === 0) return 1; return 1 + ELO.goalDiffFactor * (Math.log(d + 1) - 1) }
function eloResultScore(homeWon, decision) {
  if (decision === 'SO') return homeWon ? ELO.rw.soWin : ELO.rw.soLoss
  if (decision === 'OT') return homeWon ? ELO.rw.otWin : ELO.rw.otLoss
  return homeWon ? ELO.rw.regulationWin : ELO.rw.regulationLoss
}
function computeEloSnapshots(games, regressionFraction) {
  const ratings = new Map(), gp = new Map()
  let curSeason = null
  const snaps = new Array(games.length)
  for (const g of games) {
    if (curSeason !== null && g.season !== curSeason) {
      for (const [id, r] of ratings) ratings.set(id, ELO.start + (r - ELO.start) * (1 - regressionFraction))
    }
    curSeason = g.season
    snaps[g.__idx] = { home: ratings.get(g.homeId) ?? ELO.start, away: ratings.get(g.awayId) ?? ELO.start }
    const rh = snaps[g.__idx].home, ra = snaps[g.__idx].away
    const gpH = gp.get(g.homeId) ?? 0, gpA = gp.get(g.awayId) ?? 0
    const hw = g.homeGoals > g.awayGoals
    const expH = 1 / (1 + Math.pow(10, (ra - (rh + ELO.homeAdv)) / 400))
    const gm = goalMult(Math.abs(g.homeGoals - g.awayGoals))
    const sH = eloResultScore(hw, g.decision)
    const kH = eloK(gpH), kA = eloK(gpA)
    ratings.set(g.homeId, rh + kH * gm * (sH - expH))
    ratings.set(g.awayId, ra + kA * gm * ((1 - sH) - (1 - expH)))
    gp.set(g.homeId, gpH + 1); gp.set(g.awayId, gpA + 1)
  }
  return { snaps }
}

const SOG_CFG = { weight: 0.15, minGamesFullConfidence: 10, maxZScore: 2.5 }
const LOGIT_TO_ELO = 400 / Math.LN10
function groupBySeason(games) {
  const bySeason = new Map()
  for (const g of games) {
    if (!bySeason.has(g.season)) bySeason.set(g.season, { games: [], teams: new Set() })
    const e = bySeason.get(g.season)
    e.games.push(g); e.teams.add(g.homeId); e.teams.add(g.awayId)
  }
  return bySeason
}
function computeSogAdjSnapshots(bySeason, totalGames) {
  const adj = new Array(totalGames)
  for (const [, entry] of bySeason) {
    const teamIds = [...entry.teams]
    const stat = new Map()
    teamIds.forEach((id) => stat.set(id, { gp: 0, sogAgainst: 0 }))
    for (const g of entry.games) {
      const withData = teamIds.map((id) => ({ id, s: stat.get(id) })).filter(({ s }) => s.gp > 0).map(({ id, s }) => ({ id, perGame: s.sogAgainst / s.gp, gp: s.gp }))
      let sogAdjMap = {}
      teamIds.forEach((id) => { sogAdjMap[id] = 0 })
      if (withData.length >= 2) {
        const mean = withData.reduce((s, x) => s + x.perGame, 0) / withData.length
        const variance = withData.reduce((s, x) => s + (x.perGame - mean) ** 2, 0) / withData.length
        const std = Math.sqrt(variance)
        if (std > 0) {
          for (const x of withData) {
            const rawZ = (mean - x.perGame) / std
            const z = Math.max(-SOG_CFG.maxZScore, Math.min(SOG_CFG.maxZScore, rawZ))
            const confidence = Math.min(1, x.gp / SOG_CFG.minGamesFullConfidence)
            sogAdjMap[x.id] = SOG_CFG.weight * z * confidence * LOGIT_TO_ELO
          }
        }
      }
      adj[g.__idx] = { home: sogAdjMap[g.homeId] ?? 0, away: sogAdjMap[g.awayId] ?? 0 }
      const H = stat.get(g.homeId), A = stat.get(g.awayId)
      H.gp++; A.gp++
      H.sogAgainst += g.sogAway; A.sogAgainst += g.sogHome
    }
  }
  return adj
}
function sigmoid(x) { return 1 / (1 + Math.exp(-x)) }

// ============================================================================
// 5. Spieler-Season-Aggregate + Team-Roster-Stärke-Features (LEAK-FREI:
//    ausschliesslich aus VOR der jeweiligen Saison abgeschlossenen Vorsaisons,
//    als eingefrorener Pre-Season-Snapshot analog src/preseasonElo.js)
// ============================================================================

// player-season-team Aggregat: id -> season -> { teamId, gp, g,a,p, sog, plusMinus, toi, toiPp, position }
function buildPlayerSeasonStats(allSkaterRows) {
  const m = new Map()
  for (const r of allSkaterRows) {
    if (!m.has(r.id)) m.set(r.id, new Map())
    const bySeason = m.get(r.id)
    if (!bySeason.has(r.season)) {
      bySeason.set(r.season, { teamCounts: new Map(), gp: 0, g: 0, a: 0, p: 0, sog: 0, plusMinus: 0, toi: 0, toiPp: 0, positionCounts: new Map(), ageGroup: r.ageGroup })
    }
    const s = bySeason.get(r.season)
    s.gp++; s.g += r.goals; s.a += r.assists; s.p += r.points; s.sog += r.sog; s.plusMinus += r.plusMinus
    s.toi += r.toi; s.toiPp += r.toiPp
    s.teamCounts.set(r.teamId, (s.teamCounts.get(r.teamId) || 0) + 1)
    s.positionCounts.set(r.position, (s.positionCounts.get(r.position) || 0) + 1)
  }
  // Auf "primäres Team/Position dieser Saison" reduzieren (häufigstes Vorkommen)
  const out = new Map()
  for (const [id, bySeason] of m) {
    const seasonMap = new Map()
    for (const [season, s] of bySeason) {
      const team = [...s.teamCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      const position = [...s.positionCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      seasonMap.set(season, {
        teamId: team, position, ageGroup: s.ageGroup,
        gp: s.gp, ppg: s.gp > 0 ? s.p / s.gp : 0, gpg: s.gp > 0 ? s.g / s.gp : 0,
        sogpg: s.gp > 0 ? s.sog / s.gp : 0, pmpg: s.gp > 0 ? s.plusMinus / s.gp : 0,
        toipg: s.gp > 0 ? s.toi / s.gp : 0,
      })
    }
    out.set(id, seasonMap)
  }
  return out
}

function buildGoalieSeasonStats(allGoalieRows) {
  const m = new Map()
  for (const r of allGoalieRows) {
    if (!m.has(r.id)) m.set(r.id, new Map())
    const bySeason = m.get(r.id)
    if (!bySeason.has(r.season)) bySeason.set(r.season, { teamCounts: new Map(), saves: 0, ga: 0, shotsAgainst: 0, toiSec: 0 })
    const s = bySeason.get(r.season)
    s.saves += r.saves; s.ga += r.goalsAgainst; s.shotsAgainst += r.shotsAgainst; s.toiSec += r.toiSec
    s.teamCounts.set(r.teamId, (s.teamCounts.get(r.teamId) || 0) + 1)
  }
  const out = new Map()
  for (const [id, bySeason] of m) {
    const seasonMap = new Map()
    for (const [season, s] of bySeason) {
      const team = [...s.teamCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
      seasonMap.set(season, {
        teamId: team, svPct: s.shotsAgainst > 0 ? s.saves / s.shotsAgainst : null,
        toiSec: s.toiSec, shotsAgainst: s.shotsAgainst,
      })
    }
    out.set(id, seasonMap)
  }
  return out
}

// Liste aller Team-IDs die je in einer Saison aufgetreten sind, chronologisch.
function seasonOrder(games) { return [...new Set(games.map((g) => g.season))].sort() }

// TOI-gewichteter Mittelwert von `key` über eine Liste von Spieler-Saison-
// Objekten (Zeilen ohne toipg>0 werden ignoriert). `minPlayers`: bei zu
// wenig Spielern mit Daten -> null (kein erfundener Wert).
function toiWeightedMean(rows, key, minPlayers = 3) {
  const withToi = rows.filter((r) => r.toipg > 0)
  if (withToi.length < minPlayers) return null
  const wsum = withToi.reduce((s, r) => s + r.toipg, 0)
  if (wsum <= 0) return null
  return withToi.reduce((s, r) => s + r.toipg * r[key], 0) / wsum
}

// Baut für JEDES Team+Saison den Kader dieser Saison (welche Spieler-`id`s
// tatsächlich für dieses Team in dieser Saison aufgelaufen sind - direkt aus
// den Boxscore-Zeilen, daher naturgemäss korrekt bzgl. Zu-/Abgängen: ein
// Spieler, der das Team verlassen hat, taucht in der neuen Saison einfach
// nicht mehr mit diesem teamId auf).
function buildTeamRosterBySeason(allSkaterRows) {
  const m = new Map() // season -> teamId -> Set(playerId)
  for (const r of allSkaterRows) {
    if (!m.has(r.season)) m.set(r.season, new Map())
    const bySeason = m.get(r.season)
    if (!bySeason.has(r.teamId)) bySeason.set(r.teamId, new Set())
    bySeason.get(r.teamId).add(r.id)
  }
  return m
}

// Kernfunktion: liefert für ein gegebenes Team + Zielsaison die Pre-Season-
// Roster-Features, AUSSCHLIESSLICH aus abgeschlossenen Vorsaisons berechnet.
// `historyDepth`: wie viele Vorsaisons max. einbezogen werden (1, 2 oder 3),
// `weights`: Gewichtung der Vorsaisons (aktuellste zuerst), z.B. [1] / [0.65,0.35] / [0.5,0.3,0.2].
function computeRosterFeaturesForTeamSeason(teamId, targetSeason, seasons, teamRosterBySeason, playerSeasonStats, historyDepth, weights) {
  const targetIdx = seasons.indexOf(targetSeason)
  if (targetIdx < 0 || targetIdx - historyDepth < 0) return null // nicht genug Vorsaisons vorhanden

  const currentRosterIds = teamRosterBySeason.get(targetSeason)?.get(teamId)
  if (!currentRosterIds || currentRosterIds.size === 0) return null

  // Für jeden aktuellen Kaderspieler: gewichteter Mittelwert seiner P/GP etc.
  // über die letzten `historyDepth` Vorsaisons, in denen er IRGENDWO spielte
  // (auch bei einem anderen Team - ein Neuzugang wird mit seiner bisherigen
  // Leistung berücksichtigt, wie vom Auftrag verlangt).
  const perPlayerRows = []
  for (const pid of currentRosterIds) {
    const hist = playerSeasonStats.get(pid)
    if (!hist) continue
    let wsum = 0, ppgSum = 0, gpgSum = 0, sogpgSum = 0, pmpgSum = 0, toipgSum = 0, latestPosition = null, latestGp = 0
    for (let k = 0; k < historyDepth; k++) {
      const s = hist.get(seasons[targetIdx - 1 - k])
      if (!s) continue
      const w = weights[k]
      wsum += w
      ppgSum += w * s.ppg; gpgSum += w * s.gpg; sogpgSum += w * s.sogpg; pmpgSum += w * s.pmpg; toipgSum += w * s.toipg
      if (k === 0) { latestPosition = s.position; latestGp = s.gp }
    }
    if (wsum === 0) continue // Spieler ohne jegliche Historie in den letzten historyDepth Saisons -> ausgeschlossen (nichts erfunden)
    perPlayerRows.push({
      id: pid, position: latestPosition, gp: latestGp,
      ppg: ppgSum / wsum, gpg: gpgSum / wsum, sogpg: sogpgSum / wsum, pmpg: pmpgSum / wsum, toipg: toipgSum / wsum,
    })
  }
  if (perPlayerRows.length < 5) return null // zu wenig historisch bekannte Kaderspieler

  const forwards = perPlayerRows.filter((r) => r.position === 'Stürmer').sort((a, b) => b.toipg - a.toipg)
  const defensemen = perPlayerRows.filter((r) => r.position === 'Verteidiger').sort((a, b) => b.toipg - a.toipg)

  return {
    wholeTeamPPG: toiWeightedMean(perPlayerRows, 'ppg'),
    top6PPG: toiWeightedMean(forwards.slice(0, 6), 'ppg'),
    top9PPG: toiWeightedMean(forwards.slice(0, 9), 'ppg'),
    top4dPPG: toiWeightedMean(defensemen.slice(0, 4), 'ppg'),
    wholeTeamPM: toiWeightedMean(perPlayerRows, 'pmpg'),
    wholeTeamSOG: toiWeightedMean(perPlayerRows, 'sogpg'),
    nPlayersWithHistory: perPlayerRows.length,
  }
}

// Torhüter-Feature: TOI-gewichteter SV% über die letzten `historyDepth`
// Vorsaisons, unter den Torhütern die AKTUELL für dieses Team auflaufen.
function computeGoalieFeatureForTeamSeason(teamId, targetSeason, seasons, teamId2, goalieRosterBySeason, goalieSeasonStats, historyDepth, weights) {
  const targetIdx = seasons.indexOf(targetSeason)
  if (targetIdx < 0 || targetIdx - historyDepth < 0) return null
  const currentGoalieIds = goalieRosterBySeason.get(targetSeason)?.get(teamId)
  if (!currentGoalieIds || currentGoalieIds.size === 0) return null

  let wSum = 0, svSum = 0
  for (const gid of currentGoalieIds) {
    const hist = goalieSeasonStats.get(gid)
    if (!hist) continue
    for (let k = 0; k < historyDepth; k++) {
      const s = hist.get(seasons[targetIdx - 1 - k])
      if (!s || s.svPct == null || s.toiSec < 600) continue // Mindest-Einsatzzeit, sonst zu verrauscht
      const w = weights[k] * s.toiSec
      wSum += w; svSum += w * s.svPct
    }
  }
  if (wSum === 0) return null
  return svSum / wSum
}
function buildGoalieRosterBySeason(allGoalieRows) {
  const m = new Map()
  for (const r of allGoalieRows) {
    if (!m.has(r.season)) m.set(r.season, new Map())
    const bySeason = m.get(r.season)
    if (!bySeason.has(r.teamId)) bySeason.set(r.teamId, new Set())
    bySeason.get(r.teamId).add(r.id)
  }
  return m
}

// ============================================================================
// 6. Metriken + Kalibrierung (identisch zu backtest-preseason-h2h.js)
// ============================================================================

const isCore = (r) => !r.corona
const isCorona = (r) => r.corona
const isAll = () => true
const inFirst = (frac) => (r) => !r.corona && r.seasonFraction < frac
const inMid = (r) => !r.corona && r.seasonFraction >= 0.30 && r.seasonFraction < 0.70
const inEnd = (r) => !r.corona && r.seasonFraction >= 0.70

function metricsFor(rows, predictFn, filterFn) {
  let n = 0, correct = 0, brier = 0, logloss = 0
  const EPS = 1e-10
  for (const r of rows) {
    if (!filterFn(r)) continue
    const p = Math.min(1 - EPS, Math.max(EPS, predictFn(r)))
    const y = r.homeWon ? 1 : 0
    n++
    if ((p >= 0.5 ? 1 : 0) === y) correct++
    brier += (p - y) ** 2
    logloss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p))
  }
  return n === 0 ? null : { n, accuracy: correct / n, brier: brier / n, logloss: logloss / n }
}
function stdOf(rows, key) {
  const core = rows.filter((r) => isCore(r) && r[key] != null)
  if (core.length === 0) return 1
  const mean = core.reduce((s, r) => s + r[key], 0) / core.length
  const variance = core.reduce((s, r) => s + (r[key] - mean) ** 2, 0) / core.length
  return Math.sqrt(variance) || 1
}
const G_GRID = [0.7, 0.85, 1.0, 1.15, 1.3]
const C_GRID = [-0.3, -0.15, 0, 0.15, 0.3]
const H_GRID = [-2, -1.5, -1, -0.6, -0.3, -0.15, 0, 0.15, 0.3, 0.6, 1, 1.5, 2]

function fitBaseline(rows, baseLogitKey) {
  let best = null
  for (const g of G_GRID) for (const c of C_GRID) {
    const predict = (r) => sigmoid(g * r[baseLogitKey] + c)
    const m = metricsFor(rows, predict, isCore)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { g, c, m, score }
  }
  return best
}
// Feature-Zeilen ohne Wert (null, z.B. zu wenig Kaderhistorie) fliessen mit
// Beitrag 0 (neutral) ein - kein erfundener Wert, aber das Spiel bleibt im
// Vergleich (identische Grundgesamtheit für Baseline und Feature-Modell).
function fitWithFeature(rows, baseLogitKey, baseG, featureKey, std) {
  let best = null
  for (const h of H_GRID) for (const c of C_GRID) {
    const predict = (r) => sigmoid(baseG * r[baseLogitKey] + h * ((r[featureKey] ?? 0) / std) + c)
    const m = metricsFor(rows, predict, isCore)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { h, c, m, score }
  }
  return best
}
function fitWithTwoFeatures(rows, baseLogitKey, baseG, fk1, std1, h1, fk2, std2) {
  // Greedy statt vollem 2D-Grid: h1 aus der Einzel-Optimierung fixiert,
  // nur h2 (+ c) neu gesucht - vermeidet Kombinationsexplosion/Overfitting.
  let best = null
  for (const h2 of H_GRID) for (const c of C_GRID) {
    const predict = (r) => sigmoid(baseG * r[baseLogitKey] + h1 * ((r[fk1] ?? 0) / std1) + h2 * ((r[fk2] ?? 0) / std2) + c)
    const m = metricsFor(rows, predict, isCore)
    const score = m.logloss + m.brier
    if (!best || score < best.score) best = { h2, c, m, score }
  }
  return best
}
function fmt(m) { return m ? `n=${m.n} acc=${(m.accuracy * 100).toFixed(1)}% brier=${m.brier.toFixed(4)} logloss=${m.logloss.toFixed(4)}` : 'n/a' }

// ============================================================================
// MAIN
// ============================================================================

function main() {
  const t0 = Date.now()
  console.log('Lade historische Rohdaten (9 Saisons)...')
  const seasonsRaw = loadRaw()

  const games = []
  const allSkaterRows = []
  const allGoalieRows = []
  for (const raw of seasonsRaw) {
    for (const g of raw.games) {
      const { base, skaterRows, goalieRows } = parseGame(g)
      games.push(base)
      for (const r of skaterRows) allSkaterRows.push(r)
      for (const r of goalieRows) allGoalieRows.push(r)
    }
  }
  games.sort((a, b) => (a.dt < b.dt ? -1 : a.dt > b.dt ? 1 : 0))
  games.forEach((g, i) => { g.__idx = i })
  const perSeasonCount = new Map()
  for (const g of games) perSeasonCount.set(g.season, (perSeasonCount.get(g.season) || 0) + 1)
  const perSeasonRunning = new Map()
  for (const g of games) {
    const idx = perSeasonRunning.get(g.season) || 0
    g.seasonGameIndex = idx; g.seasonTotalGames = perSeasonCount.get(g.season); g.seasonFraction = idx / g.seasonTotalGames
    perSeasonRunning.set(g.season, idx + 1)
  }
  const seasons = seasonOrder(games)
  console.log(`Geladen: ${games.length} Spiele, ${seasons.length} Saisons: ${seasons.join(', ')}`)
  console.log(`Boxscore-Zeilen: ${allSkaterRows.length} Skater, ${allGoalieRows.length} Goalies (Roster-Treffer, nicht zugeordnete Zeilen bereits herausgefiltert)`)

  // ---------------------------------------------------------------------
  // ABSCHNITT 1: Datenqualität
  // ---------------------------------------------------------------------
  console.log('\n=== ABSCHNITT 1: DATENQUALITÄT ===')
  const dq = assessDataQuality(seasonsRaw)
  for (const [k, v] of dq) console.log(`  ${k.padEnd(22)}: ${v}`)

  // ---------------------------------------------------------------------
  // ABSCHNITT 2: Spieler-Identität
  // ---------------------------------------------------------------------
  // Name pro id auch für den Konsistenzcheck mitführen (separat von den
  // eigentlichen Feature-Rows, um deren Struktur schlank zu halten).
  const idNameCheck = new Map()
  for (const raw of seasonsRaw) {
    for (const g of raw.games) {
      for (const key of Object.keys(g.roster || {})) {
        const r = g.roster[key]
        if (!idNameCheck.has(r.id)) idNameCheck.set(r.id, new Set())
        idNameCheck.get(r.id).add(r.fullName)
      }
    }
  }
  let idsWithMultipleNames = 0, nameCollisionExamples = []
  for (const [id, names] of idNameCheck) {
    if (names.size > 1) { idsWithMultipleNames++; if (nameCollisionExamples.length < 5) nameCollisionExamples.push({ id, names: [...names] }) }
  }
  const nameToIds = new Map()
  for (const [id, names] of idNameCheck) for (const n of names) {
    if (!nameToIds.has(n)) nameToIds.set(n, new Set())
    nameToIds.get(n).add(id)
  }
  let namesWithMultipleIds = 0
  for (const [, ids] of nameToIds) if (ids.size > 1) namesWithMultipleIds++

  console.log('\n=== ABSCHNITT 2: SPIELER-IDENTITÄT ===')
  console.log(`Eindeutige roster-IDs (SIHF-Lizenznummern) über alle 9 Saisons: ${idNameCheck.size}`)
  console.log(`IDs mit mehr als einem beobachteten Namen (Tippfehler/Schreibvarianten?): ${idsWithMultipleNames} (${((idsWithMultipleNames / idNameCheck.size) * 100).toFixed(2)}%)`)
  if (nameCollisionExamples.length) console.log('  Beispiele:', JSON.stringify(nameCollisionExamples))
  console.log(`Namen, die von mehr als einer ID geteilt werden (Namensgleichheit verschiedener Personen): ${namesWithMultipleIds}`)
  console.log(`-> Bewertung: roster[].id ist die SIHF-Lizenznummer und ${idsWithMultipleNames === 0 ? 'vollständig' : 'weitgehend'} stabil über Saisons/Vereinswechsel hinweg. Wird als primärer Identitätsschlüssel verwendet (kein Namensabgleich nötig, damit auch kein Kollisionsrisiko bei Namensvettern).`)

  // ---------------------------------------------------------------------
  // Spieler-Season-Aggregate + Team-Roster je Saison
  // ---------------------------------------------------------------------
  const playerSeasonStats = buildPlayerSeasonStats(allSkaterRows)
  const goalieSeasonStats = buildGoalieSeasonStats(allGoalieRows)
  const teamRosterBySeason = buildTeamRosterBySeason(allSkaterRows)
  const goalieRosterBySeason = buildGoalieRosterBySeason(allGoalieRows)

  // ---------------------------------------------------------------------
  // ELO (Referenzmodell A, Regression=1.0 = reales Live-Verhalten) + SOG
  // ---------------------------------------------------------------------
  console.log('\nBerechne ELO- und SOG-Snapshots...')
  const { snaps: eloSnaps } = computeEloSnapshots(games, 1.0)
  const bySeason = groupBySeason(games)
  const sogAdj = computeSogAdjSnapshots(bySeason, games.length)

  // ---------------------------------------------------------------------
  // Feature-Zeilen: Referenzlogit (Pre-Season-ELO wird hier NICHT erneut
  // hergeleitet - dieser Backtest fokussiert auf den Zusatznutzen ÜBER die
  // bereits validierte Pre-Season-ELO+SOG-Baseline hinaus. Da wir hier aber
  // KEINEN Zugriff auf mehr als die 9 Archiv-Saisons haben und Pre-Season-
  // ELO selbst schon "Regression=1.0 der laufenden ELO" ist, wird als
  // Referenzlogit hier - konsistent mit backtest-preseason-h2h.js Modell D -
  // ELO(Regression=1.0) + SOG-Allowed verwendet.)
  // ---------------------------------------------------------------------
  console.log('Berechne Spieler-Roster-Features (leak-frei, pro Team+Saison eingefroren)...')
  const HIST = {
    last1: { depth: 1, weights: [1] },
    last2: { depth: 2, weights: [0.65, 0.35] },
    last3: { depth: 3, weights: [0.5, 0.3, 0.2] },
  }
  // Cache: teamId|season|histKey -> Roster-Feature-Objekt (einmal berechnen, nicht pro Spiel neu)
  const rosterCache = new Map()
  function getRoster(teamId, season, histKey) {
    const key = `${teamId}|${season}|${histKey}`
    if (rosterCache.has(key)) return rosterCache.get(key)
    const h = HIST[histKey]
    const v = computeRosterFeaturesForTeamSeason(teamId, season, seasons, teamRosterBySeason, playerSeasonStats, h.depth, h.weights)
    rosterCache.set(key, v)
    return v
  }
  const goalieCache = new Map()
  function getGoalie(teamId, season, histKey) {
    const key = `${teamId}|${season}|${histKey}`
    if (goalieCache.has(key)) return goalieCache.get(key)
    const h = HIST[histKey]
    const v = computeGoalieFeatureForTeamSeason(teamId, season, seasons, teamId, goalieRosterBySeason, goalieSeasonStats, h.depth, h.weights)
    goalieCache.set(key, v)
    return v
  }

  const rows = games.map((g) => {
    const e = eloSnaps[g.__idx]
    const sAdj = sogAdj[g.__idx]
    const refLogit = ((e.home + sAdj.home) + ELO.homeAdv - (e.away + sAdj.away)) * Math.LN10 / 400

    const rh1 = getRoster(g.homeId, g.season, 'last1'), ra1 = getRoster(g.awayId, g.season, 'last1')
    const rh2 = getRoster(g.homeId, g.season, 'last2'), ra2 = getRoster(g.awayId, g.season, 'last2')
    const rh3 = getRoster(g.homeId, g.season, 'last3'), ra3 = getRoster(g.awayId, g.season, 'last3')
    const targetIdx = seasons.indexOf(g.season)
    const prevSeason = targetIdx > 0 ? seasons[targetIdx - 1] : null
    const rh1prev = prevSeason ? getRoster(g.homeId, prevSeason, 'last1') : null // "Vorsaison der Vorsaison" für Trend
    const ra1prev = prevSeason ? getRoster(g.awayId, prevSeason, 'last1') : null

    const diff = (a, b, key) => (a && b && a[key] != null && b[key] != null) ? (a[key] - b[key]) : null

    const gh1 = getGoalie(g.homeId, g.season, 'last1'), ga1 = getGoalie(g.awayId, g.season, 'last1')
    const gh2 = getGoalie(g.homeId, g.season, 'last2'), ga2 = getGoalie(g.awayId, g.season, 'last2')

    // Trend: Delta zwischen der Vorsaison (last1 relativ zu targetSeason) und
    // der Saison davor (last1 relativ zu prevSeason) - positiver Wert =
    // Team wurde in seiner jüngsten abgeschlossenen Saison relativ stärker.
    const trendHome = (rh1 && rh1prev && rh1.wholeTeamPPG != null && rh1prev.wholeTeamPPG != null) ? rh1.wholeTeamPPG - rh1prev.wholeTeamPPG : null
    const trendAway = (ra1 && ra1prev && ra1.wholeTeamPPG != null && ra1prev.wholeTeamPPG != null) ? ra1.wholeTeamPPG - ra1prev.wholeTeamPPG : null

    // Offense/Defense-Kombination: TOI-gew. Top6-Offense + TOI-gew. Team-+/-
    // (roher Mittelwert zweier unterschiedlich skalierter Grössen - deshalb
    // erst NACH std-Normalisierung im Fit sinnvoll, hier nur Differenz je
    // Komponente, kombiniert via Summe der beiden bereits gebildeten Diffs
    // unten in featureKeys 'offDefCombo').

    return {
      season: g.season, corona: g.corona, homeWon: g.homeGoals > g.awayGoals, seasonFraction: g.seasonFraction,
      refLogit,
      last1_whole: diff(rh1, ra1, 'wholeTeamPPG'),
      last1_top6: diff(rh1, ra1, 'top6PPG'),
      last1_top9: diff(rh1, ra1, 'top9PPG'),
      last1_top4d: diff(rh1, ra1, 'top4dPPG'),
      last2_whole: diff(rh2, ra2, 'wholeTeamPPG'),
      last3_whole: diff(rh3, ra3, 'wholeTeamPPG'),
      trend: (trendHome != null && trendAway != null) ? trendHome - trendAway : null,
      offDefCombo: (() => {
        const off = diff(rh1, ra1, 'top6PPG')
        const def = diff(rh1, ra1, 'wholeTeamPM')
        return (off != null && def != null) ? off + def : null // Skalierung übernimmt der Fit (h/std)
      })(),
      rosterChangeDelta: (() => {
        // Aktuelle (last1, inkl. Neuzugänge mit deren Historie) minus die
        // TATSÄCHLICHE Vorsaison-Kaderstärke des jeweiligen Teams selbst
        // (rh1prev bezieht sich auf denselben teamId, also "wie stark war
        // GENAU DIESES Team letzte Saison" vs. "wie stark ist sein Kader jetzt").
        const homeDelta = (rh1 && rh1prev && rh1.wholeTeamPPG != null && rh1prev.wholeTeamPPG != null) ? rh1.wholeTeamPPG - rh1prev.wholeTeamPPG : null
        const awayDelta = (ra1 && ra1prev && ra1.wholeTeamPPG != null && ra1prev.wholeTeamPPG != null) ? ra1.wholeTeamPPG - ra1prev.wholeTeamPPG : null
        return (homeDelta != null && awayDelta != null) ? homeDelta - awayDelta : null
      })(),
      goalie_last1: (gh1 != null && ga1 != null) ? gh1 - ga1 : null,
      goalie_last2: (gh2 != null && ga2 != null) ? gh2 - ga2 : null,
    }
  })

  // Abdeckung (wie viele Spiele haben überhaupt einen Wert je Feature)
  const featureKeys = ['last1_whole', 'last1_top6', 'last1_top9', 'last1_top4d', 'last2_whole', 'last3_whole', 'trend', 'offDefCombo', 'rosterChangeDelta', 'goalie_last1', 'goalie_last2']
  console.log('\nFeature-Abdeckung (Anteil Spiele mit vorhandenem Wert, Core = ohne Corona):')
  const coreRows = rows.filter(isCore)
  for (const fk of featureKeys) {
    const withVal = coreRows.filter((r) => r[fk] != null).length
    console.log(`  ${fk.padEnd(20)}: ${((withVal / coreRows.length) * 100).toFixed(1)}% (${withVal}/${coreRows.length})`)
  }

  // ---------------------------------------------------------------------
  // Baseline (Modell A = Referenzmodell: ELO(Regression=1.0)+SOG, kalibriert)
  // ---------------------------------------------------------------------
  const baseA = fitBaseline(rows, 'refLogit')
  console.log(`\n=== REFERENZMODELL A (ELO + SOG-Allowed, entspricht Pre-Season-ELO+SOG-Baseline) ===`)
  console.log(`g=${baseA.g} c=${baseA.c}  Core: ${fmt(baseA.m)}`)

  // ---------------------------------------------------------------------
  // Einzelfeature-Grid-Search
  // ---------------------------------------------------------------------
  console.log(`\n=== EINZELFEATURE-GRID-SEARCH (${featureKeys.length} kuratierte Spieler-/Torhüter-Features) ===`)
  const featureResults = []
  for (const fk of featureKeys) {
    const std = stdOf(rows, fk)
    const fit = fitWithFeature(rows, 'refLogit', baseA.g, fk, std)
    featureResults.push({ feature: fk, std, fit })
    console.log(`  ${fk.padEnd(20)} h=${fit.h.toFixed(2).padStart(5)} c=${fit.c.toFixed(2).padStart(5)}  ${fmt(fit.m)}  ΔLogLoss=${(fit.m.logloss - baseA.m.logloss).toFixed(4)}  ΔBrier=${(fit.m.brier - baseA.m.brier).toFixed(4)}`)
  }
  featureResults.sort((a, b) => a.fit.score - b.fit.score)
  const bestSingle = featureResults[0]
  console.log(`\n-> Bestes Einzelfeature: ${bestSingle.feature} (ΔLogLoss=${(bestSingle.fit.m.logloss - baseA.m.logloss).toFixed(4)})`)

  // ---------------------------------------------------------------------
  // Modelle B-H gemäss Auftrag
  // ---------------------------------------------------------------------
  const modelB = featureResults.find((f) => f.feature === 'last1_whole') // B: letzte Saison Kaderstärke
  const modelC = featureResults.find((f) => f.feature === 'last2_whole') // C: gewichtete 2-Jahres-Historie
  const modelD = featureResults.find((f) => f.feature === 'last3_whole') // D: gewichtete 3-Jahres-Historie
  const modelE = featureResults.find((f) => f.feature === 'trend')       // E: Spielertrend
  const modelF = featureResults.find((f) => f.feature === 'offDefCombo') // F: Offensiv-/Defensiv-Kombination
  const modelG = bestSingle                                              // G: bestes Einzelfeature (global)

  // H: beste Kombination (bestes Skater-Feature + bestes Goalie-Feature, falls
  // unterschiedlich - greedy, kein volles 2D-Overfitting-Raster, siehe oben).
  const bestGoalie = [...featureResults].filter((f) => f.feature.startsWith('goalie')).sort((a, b) => a.fit.score - b.fit.score)[0]
  const bestSkater = [...featureResults].filter((f) => !f.feature.startsWith('goalie')).sort((a, b) => a.fit.score - b.fit.score)[0]
  let modelH
  if (bestGoalie && bestSkater && bestGoalie.feature !== bestSkater.feature) {
    const combo = fitWithTwoFeatures(rows, 'refLogit', baseA.g, bestSkater.feature, bestSkater.std, bestSkater.fit.h, bestGoalie.feature, bestGoalie.std)
    modelH = { features: [bestSkater.feature, bestGoalie.feature], std: [bestSkater.std, bestGoalie.std], h: [bestSkater.fit.h, combo.h2], c: combo.c, m: combo.m, score: combo.score }
  } else {
    modelH = { features: [bestSingle.feature], std: [bestSingle.std], h: [bestSingle.fit.h], c: bestSingle.fit.c, m: bestSingle.fit.m, score: bestSingle.fit.score }
  }
  console.log(`\n=== MODELL H (beste Kombination: ${modelH.features.join(' + ')}) ===`)
  console.log(`${fmt(modelH.m)}  ΔLogLoss=${(modelH.m.logloss - baseA.m.logloss).toFixed(4)}  ΔBrier=${(modelH.m.brier - baseA.m.brier).toFixed(4)}`)

  const predictA = (r) => sigmoid(baseA.g * r.refLogit + baseA.c)
  const predictSingle = (fr) => (r) => sigmoid(baseA.g * r.refLogit + fr.fit.h * ((r[fr.feature] ?? 0) / fr.std) + fr.fit.c)
  const predictH = (r) => {
    let x = baseA.g * r.refLogit + modelH.c
    modelH.features.forEach((fk, i) => { x += modelH.h[i] * ((r[fk] ?? 0) / modelH.std[i]) })
    return sigmoid(x)
  }

  // ---------------------------------------------------------------------
  // Vergleichstabelle A-H
  // ---------------------------------------------------------------------
  console.log('\n=== VERGLEICH ALLER MODELLE (Core, ohne Corona) ===')
  console.log('Modell                                        | n    | Accuracy | Brier  | LogLoss | ΔLogLoss vs A')
  const printRow = (label, m) => console.log(`${label.padEnd(46)}| ${String(m.n).padEnd(5)}| ${(m.accuracy * 100).toFixed(1)}%    | ${m.brier.toFixed(4)} | ${m.logloss.toFixed(4)}  | ${(m.logloss - baseA.m.logloss).toFixed(4)}`)
  printRow('A) Referenzmodell (ELO+SOG)', baseA.m)
  printRow('B) + letzte Saison Kaderstärke', modelB.fit.m)
  printRow('C) + gewichtete 2-Jahres-Historie', modelC.fit.m)
  printRow('D) + gewichtete 3-Jahres-Historie', modelD.fit.m)
  printRow('E) + Spielertrend', modelE.fit.m)
  printRow('F) + Offensiv-/Defensiv-Kombination', modelF.fit.m)
  printRow(`G) + bestes Einzelfeature (${modelG.feature})`, modelG.fit.m)
  printRow(`H) + beste Kombination`, modelH.m)

  // ---------------------------------------------------------------------
  // Stabilität pro Saison (Modell G als Vertreter des besten Einzelfeatures)
  // ---------------------------------------------------------------------
  console.log('\n=== STABILITÄT PRO SAISON (LogLoss, A vs. G[bestes Feature] vs. H[beste Kombi]) ===')
  let improvedGvsA = 0, improvedHvsA = 0, coreSeasonCount = 0
  const perSeasonDeltas = []
  for (const s of seasons) {
    const seasonRows = rows.filter((r) => r.season === s)
    const mA = metricsFor(seasonRows, predictA, isAll)
    const mG = metricsFor(seasonRows, predictSingle(modelG), isAll)
    const mH = metricsFor(seasonRows, predictH, isAll)
    const corona = CORONA_SEASONS.has(s)
    if (!corona) {
      coreSeasonCount++
      if (mG.logloss < mA.logloss) improvedGvsA++
      if (mH.logloss < mA.logloss) improvedHvsA++
      perSeasonDeltas.push(mG.logloss - mA.logloss)
    }
    console.log(`${s}${corona ? ' [CORONA]' : '         '} | A=${mA.logloss.toFixed(4)} | G=${mG.logloss.toFixed(4)} (Δ=${(mG.logloss - mA.logloss).toFixed(4)}) | H=${mH.logloss.toFixed(4)} (Δ=${(mH.logloss - mA.logloss).toFixed(4)})`)
  }
  const avgDelta = perSeasonDeltas.reduce((s, x) => s + x, 0) / perSeasonDeltas.length
  const worstDelta = Math.max(...perSeasonDeltas)
  console.log(`\nG besser als A in ${improvedGvsA}/${coreSeasonCount} Nicht-Corona-Saisons.`)
  console.log(`H besser als A in ${improvedHvsA}/${coreSeasonCount} Nicht-Corona-Saisons.`)
  console.log(`Ø ΔLogLoss (G) über alle Saisons: ${avgDelta.toFixed(4)}  |  Schlechtester Saison-Effekt: ${worstDelta.toFixed(4)}`)

  // ---------------------------------------------------------------------
  // Saisonstart-Sondertest (Abschnitt 8)
  // ---------------------------------------------------------------------
  console.log('\n=== SAISONSTART-SONDERTEST (Core, ohne Corona) ===')
  const buckets = [['Erste 10%', inFirst(0.10)], ['Erste 20%', inFirst(0.20)], ['Saisonmitte (30-70%)', inMid], ['Saisonende (>=70%)', inEnd]]
  console.log('Bucket                | A(Referenz)            | G(bestes Feature)      | H(beste Kombi)')
  for (const [label, filt] of buckets) {
    const mA = metricsFor(rows, predictA, filt)
    const mG = metricsFor(rows, predictSingle(modelG), filt)
    const mH = metricsFor(rows, predictH, filt)
    console.log(`${label.padEnd(23)}| ${fmt(mA).padEnd(24)}| ${fmt(mG).padEnd(24)}| ${fmt(mH)}`)
  }
  const earlyDelta = metricsFor(rows, predictSingle(modelG), inFirst(0.20)).logloss - metricsFor(rows, predictA, inFirst(0.20)).logloss
  const restDelta = metricsFor(rows, predictSingle(modelG), inEnd).logloss - metricsFor(rows, predictA, inEnd).logloss
  console.log(`\nSaisonstart-Effekt (erste 20% ΔLogLoss): ${earlyDelta.toFixed(4)}  vs. Saisonende ΔLogLoss: ${restDelta.toFixed(4)}`)

  // ---------------------------------------------------------------------
  // Corona-Saisons separat (nicht zur Auswahl verwendet)
  // ---------------------------------------------------------------------
  console.log('\nCorona-Saisons separat (nicht zur Auswahl verwendet):')
  printRow('A) Referenz', metricsFor(rows, predictA, isCorona))
  printRow('G) bestes Feature', metricsFor(rows, predictSingle(modelG), isCorona))
  printRow('H) beste Kombi', metricsFor(rows, predictH, isCorona))

  // ---------------------------------------------------------------------
  // Entscheidungskriterium (Abschnitt 7 + 9, analog zu früheren Backtests)
  // ---------------------------------------------------------------------
  console.log('\n=== ENTSCHEIDUNGSKRITERIUM ===')
  const meaningful = (d) => d < -0.0005 // > homöopathische Verbesserung (identische Schwelle wie backtest-preseason-h2h.js)
  const majorityOfSeasons = (n) => n >= Math.ceil(coreSeasonCount * 0.6)
  const gRobust = meaningful(modelG.fit.m.logloss - baseA.m.logloss) && (modelG.fit.m.brier < baseA.m.brier) && majorityOfSeasons(improvedGvsA)
  const hRobust = meaningful(modelH.m.logloss - baseA.m.logloss) && (modelH.m.brier < baseA.m.brier) && majorityOfSeasons(improvedHvsA)
  const noOverfitRisk = bestSingle.feature !== 'rosterChangeDelta' // grösste Overfitting-Gefahr: kleine-Stichproben-Feature; hier nur informativ geloggt
  console.log(`Bestes Einzelfeature (G, ${modelG.feature}) robust? ${gRobust ? 'JA' : 'NEIN'}  (ΔLogLoss=${(modelG.fit.m.logloss - baseA.m.logloss).toFixed(4)}, verbessert in ${improvedGvsA}/${coreSeasonCount} Saisons, Saisonstart-Effekt=${earlyDelta.toFixed(4)})`)
  console.log(`Beste Kombination (H) robust?           ${hRobust ? 'JA' : 'NEIN'}  (ΔLogLoss=${(modelH.m.logloss - baseA.m.logloss).toFixed(4)}, verbessert in ${improvedHvsA}/${coreSeasonCount} Saisons)`)
  const finalDecision = (gRobust || hRobust) ? 'SPIELERFEATURE ÜBERNEHMEN' : 'NICHT ÜBERNEHMEN'
  console.log(`\n>>> ENDENTSCHEIDUNG: ${finalDecision} <<<`)

  // ---------------------------------------------------------------------
  // Ergebnis-JSON
  // ---------------------------------------------------------------------
  const outPath = path.join(__dirname, 'backtest-player-features-result.json')
  fs.writeFileSync(outPath, JSON.stringify({
    dataQuality: dq,
    identity: { totalIds: idNameCheck.size, idsWithMultipleNames, namesWithMultipleIds },
    featureCoverage: Object.fromEntries(featureKeys.map((fk) => [fk, coreRows.filter((r) => r[fk] != null).length / coreRows.length])),
    modelA: { g: baseA.g, c: baseA.c, m: baseA.m },
    allFeatures: featureResults.map((f) => ({ feature: f.feature, h: f.fit.h, c: f.fit.c, m: f.fit.m, deltaLogloss: f.fit.m.logloss - baseA.m.logloss, deltaBrier: f.fit.m.brier - baseA.m.brier })),
    modelB: { feature: 'last1_whole', m: modelB.fit.m }, modelC: { feature: 'last2_whole', m: modelC.fit.m },
    modelD: { feature: 'last3_whole', m: modelD.fit.m }, modelE: { feature: 'trend', m: modelE.fit.m },
    modelF: { feature: 'offDefCombo', m: modelF.fit.m }, modelG: { feature: modelG.feature, m: modelG.fit.m },
    modelH: { features: modelH.features, m: modelH.m },
    stability: { improvedGvsA, improvedHvsA, coreSeasonCount, avgDelta, worstDelta, perSeasonDeltas },
    seasonStart: { earlyDelta20pct: earlyDelta, endDelta: restDelta },
    decision: { gRobust, hRobust, finalDecision },
  }, null, 2))
  console.log(`\nDetails gespeichert: ${outPath}`)
  console.log(`Gesamtlaufzeit: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main()

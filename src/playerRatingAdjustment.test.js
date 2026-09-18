// ---------------------------------------------------------------------------
// Tests für src/playerRatingAdjustment.js (Phase 1 der Player-Rating-
// Integration) - synthetische, aber realistisch geformte Liga-Daten
// (gleiches game.playerStats/nlShots-Format wie server/nlGameDetailSync.js
// tatsächlich erzeugt, siehe src/playerRating.test.js für dasselbe Muster).
// ---------------------------------------------------------------------------

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePlayerRatingEloAdjustments, PLAYER_RATING_ADJUSTMENT } from './playerRatingAdjustment.js'
import { computeFixtures, computeMatchForecasts } from './playoffSim.js'

// ---------------------------------------------------------------------------
// Liga-Fixture-Generator (gleiches Muster wie src/playerRating.test.js)
// ---------------------------------------------------------------------------

function skaterRow(playerId, i, gameIndex, overrides = {}) {
  const base = {
    playerId,
    goals: i % 5 === 0 ? 1 : 0,
    assists: i % 3 === 0 ? 1 : 0,
    sog: 2 + (i % 4),
    toiSec: 700 + (i % 6) * 40,
    plusMinus: (i % 7) - 3,
    blockedShots: i % 6 === 0 ? 1 : 0,
    xg: 0.1 + ((i + gameIndex) % 5) * 0.04,
  }
  base.points = base.goals + base.assists
  return { ...base, ...overrides }
}

function shotsForSkaters(players, gameIndex) {
  const home = []
  for (const p of players) {
    if (p.position === 'G') continue
    const row = skaterRow(p.id, p._i, gameIndex)
    for (let g = 0; g < row.goals; g++) home.push({ playerId: p.id, type: 'GOAL', sit: 'EQ', xg: 0.3 })
    for (let s = 0; s < row.sog - row.goals; s++) home.push({ playerId: p.id, type: 'SOG', sit: 'EQ', xg: 0.08 })
  }
  return { home, away: [] }
}

// Baut eine Liga mit `numForwards`/`numDefense` Spielern pro Team (genug für
// die SKATER_MIN_N=20-Baseline aus src/playerRating.js) über `teamIds`
// verteilt, `gamesPerSkater` abgeschlossene Spiele.
// WICHTIG: Datumsangaben MÜSSEN in der Vergangenheit relativ zum realen
// "heute" liegen (Default-`asOfDate` in calculatePlayerRating() ist "heute" -
// spätere Daten würden sonst als "Zukunft" gefiltert und lieferten immer
// null-Ratings, siehe gamesBeforeDate() in src/playerRating.js).
function buildLeague({ teamIds = ['team_a', 'team_b', 'team_c'], perTeamF = 9, perTeamD = 7, gamesPerSkater = 12, datePrefix = '2020-01-' } = {}) {
  const players = []
  let i = 0
  for (const teamId of teamIds) {
    for (let f = 0; f < perTeamF; f++) { const p = { id: `${teamId}_f${f}`, teamId, position: 'F', _i: i++ }; players.push(p) }
    for (let d = 0; d < perTeamD; d++) { const p = { id: `${teamId}_d${d}`, teamId, position: 'D', _i: i++ }; players.push(p) }
  }
  const games = []
  for (let g = 0; g < gamesPerSkater; g++) {
    const playerStats = players.filter((p) => p.position !== 'G').map((p) => skaterRow(p.id, p._i, g))
    games.push({
      id: `g${g}`, date: `${datePrefix}${String(g + 1).padStart(2, '0')}`, status: 'final',
      homeTeamId: teamIds[0], awayTeamId: teamIds[1], homeGoals: 3, awayGoals: 2, decision: 'REG',
      playerStats, nlShots: shotsForSkaters(players, g),
    })
  }
  return { players: players.map(({ _i, ...p }) => p), games, teams: teamIds.map((id) => ({ id })) }
}

function tomorrow() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Grundverhalten
// ---------------------------------------------------------------------------

test('weight=0 (Default): Adjustment ist für jedes Team exakt 0', () => {
  const { players, games, teams } = buildLeague()
  const adj = computePlayerRatingEloAdjustments(teams, games, players, {})
  for (const t of teams) assert.equal(adj[t.id], 0)
})

test('weight=0: computeFixtures()/computeMatchForecasts() bleiben unverändert (playerRatingAdjHome/Away = 0, pHome unbeeinflusst)', () => {
  const { players, games, teams } = buildLeague()
  const scheduled = [{ id: 'sched1', status: 'scheduled', date: tomorrow(), homeTeamId: teams[0].id, awayTeamId: teams[1].id }]
  const allGames = [...games, scheduled[0]]

  const withoutWeight = computeMatchForecasts(teams, allGames, {}, players)
  const withExplicitZero = computeMatchForecasts(teams, allGames, { playerRatingWeight: 0 }, players)
  assert.deepEqual(withoutWeight, withExplicitZero)

  const f = withoutWeight.find((x) => x.gameId === 'sched1')
  assert.equal(f.playerRatingAdjHome, 0)
  assert.equal(f.playerRatingAdjAway, 0)
})

test('0 Spieler im Roster: Adjustment bleibt 0 (kein Crash, kein erfundener Wert)', () => {
  const teams = [{ id: 'team_empty' }, { id: 'team_b' }]
  const adj = computePlayerRatingEloAdjustments(teams, [], [], { weight: 0.25 })
  assert.equal(adj.team_empty, 0)
  assert.equal(adj.team_b, 0)
})

test('kein players-Array übergeben: Adjustment bleibt für alle Teams 0', () => {
  const teams = [{ id: 'team_a' }, { id: 'team_b' }]
  const adj = computePlayerRatingEloAdjustments(teams, [], null, { weight: 0.25 })
  assert.deepEqual(adj, { team_a: 0, team_b: 0 })
})

test('kein Rating verfügbar (Spieler ohne jede Saison-/Karrieredaten): Adjustment bleibt 0', () => {
  const teams = [{ id: 'team_a' }]
  const players = [{ id: 'rookie1', teamId: 'team_a', position: 'F' }, { id: 'rookie2', teamId: 'team_a', position: 'D' }]
  const adj = computePlayerRatingEloAdjustments(teams, [], players, { weight: 0.25 })
  assert.equal(adj.team_a, 0)
})

// ---------------------------------------------------------------------------
// Richtung des Effekts
// ---------------------------------------------------------------------------

test('stärkeres F+D-Roster ergibt ein POSITIVES Adjustment, schwächeres ein NEGATIVES (jeweils ggü. der Liga-Baseline)', () => {
  const { players, games, teams } = buildLeague()
  // Team A bekommt zusätzlich einen extrem starken Stürmer, Team C einen extrem schwachen.
  const strongPlayer = { id: 'team_a_star', teamId: teams[0].id, position: 'F' }
  const weakPlayer = { id: 'team_c_bust', teamId: teams[2].id, position: 'F' }
  const extendedPlayers = [...players, strongPlayer, weakPlayer]
  const extendedGames = games.map((g, gi) => ({
    ...g,
    playerStats: [
      ...g.playerStats,
      { playerId: strongPlayer.id, goals: 3, assists: 2, points: 5, sog: 9, toiSec: 1400, plusMinus: 4, xg: 0.4 },
      { playerId: weakPlayer.id, goals: 0, assists: 0, points: 0, sog: 0, toiSec: 300, plusMinus: -4, xg: 0.02 },
    ],
    nlShots: {
      home: [...g.nlShots.home,
        { playerId: strongPlayer.id, type: 'GOAL', sit: 'EQ', xg: 0.3 }, { playerId: strongPlayer.id, type: 'GOAL', sit: 'EQ', xg: 0.3 }, { playerId: strongPlayer.id, type: 'GOAL', sit: 'EQ', xg: 0.3 },
        { playerId: strongPlayer.id, type: 'SOG', sit: 'EQ', xg: 0.1 }, { playerId: strongPlayer.id, type: 'SOG', sit: 'EQ', xg: 0.1 }, { playerId: strongPlayer.id, type: 'SOG', sit: 'EQ', xg: 0.1 },
        { playerId: strongPlayer.id, type: 'SOG', sit: 'EQ', xg: 0.1 }, { playerId: strongPlayer.id, type: 'SOG', sit: 'EQ', xg: 0.1 }, { playerId: strongPlayer.id, type: 'SOG', sit: 'EQ', xg: 0.1 },
      ],
      away: g.nlShots.away,
    },
  }))
  const adj = computePlayerRatingEloAdjustments(teams, extendedGames, extendedPlayers, { weight: 0.25 })
  assert.ok(adj[teams[0].id] > 0, `Team mit Star-Spieler sollte ein positives Adjustment bekommen: ${adj[teams[0].id]}`)
  assert.ok(adj[teams[2].id] < 0, `Team mit sehr schwachem Zusatzspieler sollte ein negatives Adjustment bekommen: ${adj[teams[2].id]}`)
})

// ---------------------------------------------------------------------------
// Robustheit / Clamping / Konfidenz
// ---------------------------------------------------------------------------

test('null-Ratings (z.B. brandneue Spieler ohne Daten) werden übersprungen, nicht als 0 gezählt', () => {
  const { players, games, teams } = buildLeague()
  const rookie = { id: 'brand_new_rookie', teamId: teams[0].id, position: 'F' }
  const withRookie = [...players, rookie]
  const adjWithout = computePlayerRatingEloAdjustments(teams, games, players, { weight: 0.25 })
  const adjWith = computePlayerRatingEloAdjustments(teams, games, withRookie, { weight: 0.25 })
  // Ein Spieler ganz ohne Daten darf den Team-Durchschnitt NICHT verändern
  // (er wird übersprungen, nicht als neutraler/0-Wert eingerechnet).
  assert.equal(adjWithout[teams[0].id], adjWith[teams[0].id])
})

test('maxZScore-Clamp: Adjustment bleibt auch bei einem extrem dominanten Team innerhalb plausibler ELO-Grenzen', () => {
  const { players, games, teams } = buildLeague()
  // Ganzes Team A bekommt absurd starke Werte.
  const boosted = games.map((g) => ({
    ...g,
    playerStats: g.playerStats.map((s) => (players.find((p) => p.id === s.playerId)?.teamId === teams[0].id
      ? { ...s, goals: 10, assists: 10, points: 20, sog: 20, plusMinus: 15, xg: 2 }
      : s)),
  }))
  const adj = computePlayerRatingEloAdjustments(teams, boosted, players, { weight: 1.0 }) // weight=1 = worst case für die Grenzprüfung
  const maxPossible = PLAYER_RATING_ADJUSTMENT.maxZScore * (400 / Math.LN10) // weight=1, confidence<=1
  assert.ok(adj[teams[0].id] <= maxPossible + 1e-6, `Adjustment ${adj[teams[0].id]} übersteigt die theoretische Obergrenze ${maxPossible}`)
  assert.ok(Number.isFinite(adj[teams[0].id]))
})

test('Confidence-Rampe: dieselbe Team-Qualität mit weniger bewerteten Spielern ergibt ein betragsmässig kleineres (gedämpftes) Adjustment', () => {
  // "team_x" hat ALLE Spieler mit IDENTISCHER (überdurchschnittlicher) Quote,
  // damit ein Teilsatz dieser Spieler exakt denselben Durchschnitts-z wie das
  // volle Roster hat - so isoliert der Test ausschliesslich die
  // Konfidenz-Rampe (Spieleranzahl), nicht eine unterschiedliche
  // Team-Qualität.
  const teams = [{ id: 'team_x' }, { id: 'team_ref' }]
  const { players: refPlayers, games } = buildLeague({ teamIds: ['team_ref'], perTeamF: 20, perTeamD: 15 })
  const uniformPlayers = []
  for (let f = 0; f < 16; f++) uniformPlayers.push({ id: `team_x_f${f}`, teamId: 'team_x', position: 'F' })
  const allPlayers = [...refPlayers, ...uniformPlayers]
  const uniformGames = games.map((g) => ({
    ...g,
    playerStats: [
      ...g.playerStats,
      ...uniformPlayers.map((p) => ({ playerId: p.id, goals: 2, assists: 1, points: 3, sog: 6, toiSec: 1100, plusMinus: 3, xg: 0.3 })),
    ],
  }))
  const fewPlayers = [...refPlayers, ...uniformPlayers.slice(0, 3)] // nur 3 der 16 identisch starken Spieler bekannt

  const adjFew = computePlayerRatingEloAdjustments(teams, uniformGames, fewPlayers, { weight: 0.25 })
  const adjFull = computePlayerRatingEloAdjustments(teams, uniformGames, allPlayers, { weight: 0.25 })
  assert.ok(Math.abs(adjFew.team_x) < Math.abs(adjFull.team_x), `wenige Spieler (${adjFew.team_x}) sollten betragsmässig kleiner sein als viele (${adjFull.team_x})`)
})

test('settings.playerRatingWeight überschreibt den Default (0) - computeFixtures() reicht es korrekt durch', () => {
  const { players, games, teams } = buildLeague()
  const scheduled = { id: 'sched1', status: 'scheduled', date: tomorrow(), homeTeamId: teams[0].id, awayTeamId: teams[1].id }
  const withDefault = computeFixtures(teams, [...games, scheduled], {}, players)
  const withOverride = computeFixtures(teams, [...games, scheduled], { playerRatingWeight: 0.25 }, players)
  assert.deepEqual(withDefault.playerRatingAdjustments, Object.fromEntries(teams.map((t) => [t.id, 0])))
  // Mit Override zumindest EIN Team ungleich 0 (Liga hat echte Streuung).
  const anyNonZero = Object.values(withOverride.playerRatingAdjustments).some((v) => v !== 0)
  assert.ok(anyNonZero, 'Mit playerRatingWeight=0.25 sollte mindestens ein Team ein Adjustment != 0 haben')
})

test('Keine NaN/Infinity über eine breitere Stichprobe verschiedener Gewichte', () => {
  const { players, games, teams } = buildLeague()
  for (const weight of [0, 0.05, 0.10, 0.15, 0.25, 1.0]) {
    const adj = computePlayerRatingEloAdjustments(teams, games, players, { weight })
    for (const t of teams) assert.ok(Number.isFinite(adj[t.id]), `weight=${weight}: ${t.id} -> ${adj[t.id]}`)
  }
})

// ---------------------------------------------------------------------------
// Goalie-Ausschluss (Auftrag Punkt 6: "keine Goalie-Komponente")
// ---------------------------------------------------------------------------

test('Torhüter fliessen NIEMALS in die Teamstärke ein - extreme Torhüter-Werte verändern das Adjustment nicht', () => {
  const { players, games, teams } = buildLeague()
  const goalie = { id: 'team_a_goalie', teamId: teams[0].id, position: 'G' }
  const withGoalie = [...players, goalie]
  const gamesWithGoalie = games.map((g) => ({
    ...g,
    playerStats: [...g.playerStats, { playerId: goalie.id, saves: 40, goalsAgainst: 0, shotsAgainst: 40, toiSec: 3600 }],
  }))
  const adjWithout = computePlayerRatingEloAdjustments(teams, games, players, { weight: 0.25 })
  const adjWith = computePlayerRatingEloAdjustments(teams, gamesWithGoalie, withGoalie, { weight: 0.25 })
  assert.equal(adjWithout[teams[0].id], adjWith[teams[0].id])
})

// ---------------------------------------------------------------------------
// Snapshot-Pfad (Auftrag Punkt 3/5.11)
// ---------------------------------------------------------------------------

test('playerRatingAdjHome/Away sind in computeFixtures()-Fixtures und computeMatchForecasts()-Forecasts vorhanden', () => {
  const { players, games, teams } = buildLeague()
  const scheduled = { id: 'sched1', status: 'scheduled', date: tomorrow(), homeTeamId: teams[0].id, awayTeamId: teams[1].id }
  const { fixtures } = computeFixtures(teams, [...games, scheduled], { playerRatingWeight: 0.25 }, players)
  const fx = fixtures.find((f) => f.gameId === 'sched1')
  assert.ok('playerRatingAdjHome' in fx)
  assert.ok('playerRatingAdjAway' in fx)
  assert.ok(Number.isFinite(fx.playerRatingAdjHome))
  assert.ok(Number.isFinite(fx.playerRatingAdjAway))

  const forecasts = computeMatchForecasts(teams, [...games, scheduled], { playerRatingWeight: 0.25 }, players)
  const f = forecasts.find((x) => x.gameId === 'sched1')
  assert.ok('playerRatingAdjHome' in f)
  assert.ok('playerRatingAdjAway' in f)
})

test('positives Gewicht verändert pHome messbar ggü. weight=0, wenn ein Rating-Unterschied existiert', () => {
  const { players, games, teams } = buildLeague()
  const strongPlayer = { id: 'team_a_star2', teamId: teams[0].id, position: 'F' }
  const extendedPlayers = [...players, strongPlayer]
  const extendedGames = games.map((g) => ({
    ...g,
    playerStats: [...g.playerStats, { playerId: strongPlayer.id, goals: 3, assists: 2, points: 5, sog: 9, toiSec: 1400, plusMinus: 4, xg: 0.4 }],
  }))
  const scheduled = { id: 'sched1', status: 'scheduled', date: tomorrow(), homeTeamId: teams[0].id, awayTeamId: teams[1].id }
  const withoutWeight = computeMatchForecasts(teams, [...extendedGames, scheduled], {}, extendedPlayers)
  const withWeight = computeMatchForecasts(teams, [...extendedGames, scheduled], { playerRatingWeight: 0.25 }, extendedPlayers)
  const p0 = withoutWeight.find((f) => f.gameId === 'sched1').pHomeWin
  const p1 = withWeight.find((f) => f.gameId === 'sched1').pHomeWin
  assert.notEqual(p0, p1)
})

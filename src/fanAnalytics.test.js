import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildArenaUtilization,
  buildFanAnalytics,
  hasRealAttendance,
  pearsonCorrelation,
  resultForTeam,
  summarizeSelectedUtilization,
  weekdayForDate,
} from './fanAnalytics.js'
import { ARENA_CAPACITIES, capacityForGame } from './arenaCapacities.js'

const teams = [
  { id: 'a', name: 'Ajoie', short: 'AJO' },
  { id: 'b', name: 'Biel', short: 'BIE' },
  { id: 'c', name: 'Fribourg', short: 'FRI' },
]
const game = (id, date, homeTeamId, awayTeamId, homeGoals, awayGoals, attendance, extra = {}) => ({
  id, date, time: '19:45', status: 'final', homeTeamId, awayTeamId, homeGoals, awayGoals, decision: 'REG', attendance, ...extra,
})
const games = [
  game('g1', '2026-09-15', 'a', 'b', 3, 1, 1000),
  game('g2', '2026-09-18', 'b', 'a', 2, 3, 900, { decision: 'OT' }),
  game('g3', '2026-09-22', 'a', 'c', 1, 4, 1200),
  game('g4', '2026-09-25', 'c', 'a', 2, 1, '1200'),
  game('scheduled', '2026-09-26', 'a', 'b', null, null, 5000, { status: 'scheduled' }),
  game('live', '2026-09-27', 'a', 'b', 1, 0, 8000, { status: 'live' }),
]
const standings = [{ team: teams[1] }, { team: teams[0] }, { team: teams[2] }]

test('only positive finite numeric game.attendance values count as real observations', () => {
  assert.equal(hasRealAttendance({ attendance: 6061 }), true)
  for (const attendance of [undefined, null, 0, -4, '6061', Number.NaN, Infinity]) {
    assert.equal(hasRealAttendance({ attendance }), false)
  }
})

test('aggregates completed attendance only and reports missing data without estimating it', () => {
  const result = buildFanAnalytics({ games, teams, standings })
  assert.equal(result.finalGames.length, 4)
  assert.equal(result.observedGames.length, 3)
  assert.equal(result.missingAttendance, 1)
  assert.equal(result.totalAttendance, 3100)
  assert.equal(result.average, 3100 / 3)
  assert.equal(result.coverage, 0.75)
  assert.equal(result.highest.id, 'g3')
  assert.equal(result.lowest.id, 'g2')
})

test('team averages belong to the home arena even in the selected club away view', () => {
  const result = buildFanAnalytics({
    games,
    teams,
    standings,
    filters: { teamId: 'a', venuePerspective: 'away' },
  })
  assert.deepEqual(result.observedGames.map((entry) => entry.id), ['g2'])
  assert.equal(result.teamRows.find((row) => row.team.id === 'b').average, 900)
  assert.equal(result.teamRows.find((row) => row.team.id === 'a').average, 1100)
  assert.equal(result.rankAttendance.find((row) => row.team.id === 'b').rank, 1)
})

test('date, weekday, club and role filters scope the selected games', () => {
  assert.equal(weekdayForDate('2026-09-15'), 2)
  assert.equal(weekdayForDate('bad-date'), null)
  assert.equal(weekdayForDate('2026-02-31'), null)
  const result = buildFanAnalytics({
    games,
    teams,
    filters: { from: '2026-09-18', to: '2026-09-22', weekday: 2, teamId: 'a', venuePerspective: 'home' },
  })
  assert.deepEqual(result.finalGames.map((entry) => entry.id), ['g3'])
  assert.equal(result.weekdayRows[0].label, 'Dienstag')
  assert.deepEqual(result.kickoffRows.map((row) => row.label), ['19:45'])
  const inclusiveBounds = buildFanAnalytics({
    games,
    teams,
    filters: { from: '2026-09-15', to: '2026-09-15', teamId: 'a', venuePerspective: 'home' },
  })
  assert.deepEqual(inclusiveBounds.finalGames.map((entry) => entry.id), ['g1'])
  const invalidPeriod = buildFanAnalytics({ games, teams, filters: { from: '2026-02-31' } })
  assert.deepEqual(invalidPeriod.finalGames, [])
})

test('multiple games on a date are averaged into one date point with their own sample size', () => {
  const result = buildFanAnalytics({
    games: [games[0], game('same-day', '2026-09-15', 'c', 'a', 2, 0, 3000)],
    teams,
  })
  assert.equal(result.dailyRows.length, 1)
  assert.equal(result.dailyRows[0].games, 2)
  assert.equal(result.dailyRows[0].average, 2000)
  assert.equal(result.dailyRows[0].attendanceTotal, 4000)
})

test('missing team records and running games do not create form or result labels', () => {
  const result = buildFanAnalytics({
    games: [
      game('orphan', '2026-09-15', 'missing-team', 'b', 2, 1, 1500),
      game('running', '2026-09-16', 'b', 'a', 0, 0, 2200, { status: 'live' }),
    ],
    teams: [teams[1]],
  })
  assert.deepEqual(result.finalGames.map((entry) => entry.id), ['orphan'])
  assert.equal(result.observedGames.length, 1)
  assert.equal(result.outcomeRows.length, 0)
  assert.equal(result.formPoints.length, 0)
  assert.equal(result.teamRows[0].average, null)
})

test('non-finite or non-numeric scores are not treated as completed results', () => {
  const result = buildFanAnalytics({
    games: [
      game('bad-score', '2026-09-15', 'a', 'b', '2', 1, 1800),
      game('infinite-score', '2026-09-16', 'a', 'b', Infinity, 1, 1900),
    ],
    teams,
  })
  assert.equal(result.finalGames.length, 0)
  assert.equal(result.observedGames.length, 0)
})

test('empty data returns explicit empty aggregates without NaN values', () => {
  const result = buildFanAnalytics({ games: [], teams, standings: [] })
  assert.equal(result.average, null)
  assert.equal(result.totalAttendance, 0)
  assert.equal(result.coverage, null)
  assert.equal(result.missingAttendance, 0)
  assert.deepEqual(result.dailyRows, [])
  assert.equal(result.lowest, null)
  assert.equal(result.highest, null)
  assert.ok(result.teamRows.every((row) => row.average === null && row.coverage === null))
})

test('form uses only results before the game and history outside the display date filter', () => {
  const result = buildFanAnalytics({
    games,
    teams,
    filters: { from: '2026-09-22', to: '2026-09-22', teamId: 'a', venuePerspective: 'home' },
  })
  const point = result.formPoints.find((entry) => entry.game.id === 'g3')
  assert.equal(point.priorGames, 2)
  assert.equal(point.priorPoints, 5)
  assert.equal(point.x, 2.5)
  assert.equal(result.formPoints.some((entry) => entry.game.id === 'g1'), false)
})

test('result labels and correlations are descriptive and handle small or constant samples', () => {
  assert.deepEqual(resultForTeam(games[1], 'a'), {
    key: 'win-extra', label: 'Sieg nach Verlängerung/SO', points: 2,
  })
  assert.equal(pearsonCorrelation([{ x: 1, y: 2 }, { x: 2, y: 3 }]), null)
  assert.equal(pearsonCorrelation([{ x: 1, y: 2 }, { x: 1, y: 3 }, { x: 1, y: 4 }]), null)
  assert.equal(pearsonCorrelation([{ x: 1, y: 1 }, { x: 2, y: 2 }, { x: 3, y: 3 }]), 1)
  assert.equal(pearsonCorrelation([{ x: 1, y: 1 }, { x: Number.NaN, y: 2 }, { x: 3, y: 3 }]), null)
})

test('arena capacity catalog documents all 14 league teams and uses the SIHF capacities with caveats', () => {
  assert.equal(Object.keys(ARENA_CAPACITIES).length, 14)
  assert.equal(Object.values(ARENA_CAPACITIES).filter((record) => record.confidence === 'provisional').length, 14)
  for (const record of Object.values(ARENA_CAPACITIES)) {
    assert.ok(record.arena)
    assert.match(record.source, /^https:\/\//)
    assert.equal(record.checkedAt, '2026-10-10')
    assert.ok(record.validForSeason)
    assert.equal(record.capacityPeriods.length, 1)
  }
  const updated = [
    ['team_ajo', 5366, '1-1-103144', "2'400"],
    ['team_bie', 6556, '1-1-102128', "6'408"],
    ['team_fri', 9620, '1-1-103138', "9'372"],
    ['team_zug', 7450, '1-1-101144', "7'700"],
  ]
  for (const [teamId, capacity, sourceSuffix, caveat] of updated) {
    const record = ARENA_CAPACITIES[teamId]
    assert.equal(record.confidence, 'provisional')
    assert.equal(record.capacity, capacity)
    assert.equal(record.source.endsWith(sourceSuffix), true)
    assert.ok(record.note.includes(caveat))
    assert.equal(record.capacityPeriods[0].capacity, capacity)
    assert.equal(capacityForGame(teamId, '2026-10-10'), capacity)
  }
  assert.equal(capacityForGame('team_scb', '2026-10-10'), 17031)
  assert.equal(capacityForGame('team_scb', '2027-07-01'), null)
  assert.equal(capacityForGame('team_scb', 'bad-date'), null)
  assert.equal(ARENA_CAPACITIES.team_scb.capacityPeriods.length, 1)
  assert.equal(ARENA_CAPACITIES.team_ajo.capacityPeriods[0].capacity, 5366)

  const allTeams = Object.entries(ARENA_CAPACITIES).map(([id, record]) => ({ id, name: record.arena }))
  const allTeamRows = buildArenaUtilization({ teams: allTeams, games: [] }).rows
  assert.equal(allTeamRows.length, 14)
  assert.deepEqual(allTeamRows.map((row) => row.team.id), Object.keys(ARENA_CAPACITIES))
})

test('utilization averages per-game percentages, keeps over-capacity conflicts, and sorts ranking', () => {
  const sampleTeams = [
    { id: 'team_scb', name: 'Bern' },
    { id: 'team_apk', name: 'Ambri' },
    { id: 'team_ajo', name: 'Ajoie' },
  ]
  const result = buildArenaUtilization({
    teams: sampleTeams,
    asOf: '2026-10-10',
    games: [
      game('bern-a', '2026-09-15', 'team_scb', 'team_apk', 2, 1, 17031),
      game('bern-b', '2026-09-18', 'team_scb', 'team_ajo', 3, 1, 8515.5),
      game('ambri-a', '2026-09-22', 'team_apk', 'team_scb', 1, 4, 6775),
      game('ajoie-a', '2026-09-25', 'team_ajo', 'team_scb', 2, 3, 8000),
    ],
  })
  const bern = result.rows.find((row) => row.team.id === 'team_scb')
  assert.equal(bern.averageUtilization, 75)
  assert.equal(bern.averageAttendance, (17031 + 8515.5) / 2)
  assert.equal(bern.utilizationGames, 2)
  assert.equal(bern.isPreliminary, true)
  assert.deepEqual(result.ranking.map((row) => row.team.id), ['team_ajo', 'team_apk', 'team_scb'])
  assert.deepEqual(result.attendanceRanking.map((row) => row.team.id), ['team_scb', 'team_ajo', 'team_apk'])
  const ajoie = result.rows.find((row) => row.team.id === 'team_ajo')
  assert.equal(ajoie.averageAttendance, 8000)
  assert.equal(ajoie.averageUtilization, (8000 / 5366) * 100)
  assert.equal(ajoie.utilizationGames, 1)
  assert.equal(ajoie.capacityConflicts.length, 1)
})

test('utilization excludes missing or invalid attendance and ignores scheduled/live games', () => {
  const result = buildArenaUtilization({
    teams: [{ id: 'team_scb', name: 'Bern' }],
    asOf: '2026-10-10',
    games: [
      game('valid', '2026-09-15', 'team_scb', 'team_apk', 2, 1, 10000),
      game('missing', '2026-09-18', 'team_scb', 'team_apk', 2, 1, null),
      game('string', '2026-09-19', 'team_scb', 'team_apk', 2, 1, '16000'),
      game('scheduled', '2026-10-23', 'team_scb', 'team_apk', null, null, 16000, { status: 'scheduled' }),
      game('live', '2026-10-24', 'team_scb', 'team_apk', 1, 0, 16000, { status: 'live' }),
    ],
  })
  const bern = result.rows[0]
  assert.equal(bern.completedHomeGames, 3)
  assert.equal(bern.attendanceGames, 1)
  assert.equal(bern.missingAttendance, 2)
  assert.equal(bern.coverage, 1 / 3)
  assert.equal(bern.upcomingHomeGames, 1)
  assert.equal(bern.utilizationGames, 1)
})

test('utilization handles teams with no completed home games and does not render zero percent', () => {
  const result = buildArenaUtilization({
    teams: [{ id: 'team_zug', name: 'Zug' }, { id: 'team_scb', name: 'Bern' }],
    asOf: '2026-10-10',
    games: [game('zug-next', '2026-10-23', 'team_zug', 'team_lau', null, null, null, { status: 'scheduled' })],
  })
  const zug = result.rows.find((row) => row.team.id === 'team_zug')
  assert.equal(zug.state, 'no-home-games-yet')
  assert.equal(zug.completedHomeGames, 0)
  assert.equal(zug.upcomingHomeGames, 1)
  assert.equal(zug.averageAttendance, null)
  assert.equal(zug.averageUtilization, null)
  assert.equal(zug.coverage, null)
  assert.deepEqual(result.ranking, [])
})

test('empty Zug home selection retains calendar-scoped league ranking data', () => {
  const leagueTeams = [
    { id: 'team_zug', name: 'Zug' },
    { id: 'team_scb', name: 'Bern' },
  ]
  const analytics = buildFanAnalytics({
    teams: leagueTeams,
    games: [
      game('bern-home', '2026-09-15', 'team_scb', 'team_zug', 2, 1, 12000),
      game('zug-next', '2026-10-23', 'team_zug', 'team_scb', null, null, null, { status: 'scheduled' }),
    ],
    filters: { teamId: 'team_zug', venuePerspective: 'home' },
  })

  assert.deepEqual(analytics.finalGames, [])
  assert.deepEqual(analytics.observedGames, [])
  const calendarScopedGames = [
    ...analytics.calendarGames,
    game('zug-next', '2026-10-23', 'team_zug', 'team_scb', null, null, null, { status: 'scheduled' }),
  ]
  const ranking = buildArenaUtilization({ games: calendarScopedGames, teams: leagueTeams, asOf: '2026-10-10' })
  assert.deepEqual(ranking.rows.map((row) => row.team.id), ['team_zug', 'team_scb'])
  assert.equal(ranking.rows.find((row) => row.team.id === 'team_zug').state, 'no-home-games-yet')
  assert.equal(ranking.rows.find((row) => row.team.id === 'team_zug').averageAttendance, null)
  assert.equal(ranking.rows.find((row) => row.team.id === 'team_zug').averageUtilization, null)
  assert.equal(ranking.rows.find((row) => row.team.id === 'team_zug').coverage, null)
})

test('utilization above 100 percent remains visible and is explicitly flagged', () => {
  const result = buildArenaUtilization({
    teams: [{ id: 'team_scb', name: 'Bern' }],
    games: [game('over', '2026-09-15', 'team_scb', 'team_apk', 2, 1, 18000)],
  })
  assert.ok(result.rows[0].averageUtilization > 100)
  assert.equal(result.rows[0].highestUtilization.capacityConflict, true)
  assert.equal(result.rows[0].capacityConflicts.length, 1)
})

test('utilization uses the date-matched capacity period for each individual game', () => {
  const splitCapacity = {
    ...ARENA_CAPACITIES,
    team_scb: {
      ...ARENA_CAPACITIES.team_scb,
      capacityPeriods: [
        { validFrom: '2026-09-01', validTo: '2026-09-17', capacity: 16000 },
        { validFrom: '2026-09-18', validTo: '2027-06-30', capacity: 18000 },
      ],
    },
  }
  const result = buildArenaUtilization({
    teams: [{ id: 'team_scb', name: 'Bern' }],
    capacities: splitCapacity,
    games: [
      game('before-change', '2026-09-15', 'team_scb', 'team_apk', 2, 1, 16000),
      game('after-change', '2026-09-18', 'team_scb', 'team_apk', 2, 1, 18000),
      game('outside-period', '2026-08-31', 'team_scb', 'team_apk', 2, 1, 17000),
    ],
  })
  assert.equal(result.rows[0].utilizationGames, 2)
  assert.equal(result.rows[0].averageUtilization, 100)
  assert.equal(result.rows[0].capacityConflicts.length, 0)
})

test('league utilization average uses SIHF capacity despite a documented source discrepancy', () => {
  const result = buildArenaUtilization({
    teams: [{ id: 'team_scb', name: 'Bern' }, { id: 'team_ajo', name: 'Ajoie' }],
    games: [
      game('known', '2026-09-15', 'team_scb', 'team_ajo', 2, 1, 8515.5),
      game('unknown-capacity', '2026-09-18', 'team_ajo', 'team_scb', 2, 1, 4000),
    ],
  })
  assert.equal(result.averageUtilization, (50 + (4000 / 5366) * 100) / 2)
  assert.equal(result.utilizationGames, 2)
  assert.equal(result.attendanceWithoutCapacity, 0)
})

test('games with missing attendance or unknown capacity do not enter utilization averages', () => {
  const capacities = {
    ...ARENA_CAPACITIES,
    team_ajo: {
      ...ARENA_CAPACITIES.team_ajo,
      capacity: null,
      confidence: 'unverified',
      capacityPeriods: [],
    },
  }
  const result = buildArenaUtilization({
    teams: [{ id: 'team_scb', name: 'Bern' }, { id: 'team_ajo', name: 'Ajoie' }],
    capacities,
    games: [
      game('valid', '2026-09-15', 'team_scb', 'team_ajo', 2, 1, 10000),
      game('missing-attendance', '2026-09-18', 'team_scb', 'team_ajo', 2, 1, null),
      game('unknown-capacity', '2026-09-22', 'team_ajo', 'team_scb', 1, 2, 4000),
    ],
  })
  assert.equal(result.utilizationGames, 1)
  assert.equal(result.averageUtilization, (10000 / 17031) * 100)
  assert.equal(result.missingAttendanceGames, 1)
  assert.equal(result.attendanceWithoutCapacity, 1)
})

test('selected utilization follows the filtered games and uses each game home arena', () => {
  const selected = buildFanAnalytics({
    games,
    teams,
    filters: { teamId: 'a', venuePerspective: 'away' },
  })
  const summary = summarizeSelectedUtilization(selected.observedGames, {
    ...ARENA_CAPACITIES,
    a: { ...ARENA_CAPACITIES.team_ajo, confidence: 'provisional', capacityPeriods: [{ validFrom: '2026-07-01', validTo: '2027-06-30', capacity: 1000 }] },
    b: { ...ARENA_CAPACITIES.team_bie, confidence: 'provisional', capacityPeriods: [{ validFrom: '2026-07-01', validTo: '2027-06-30', capacity: 2000 }] },
  })

  assert.deepEqual(selected.observedGames.map((entry) => entry.id), ['g2'])
  assert.equal(summary.games, 1)
  assert.equal(summary.average, 45)
  assert.equal(summary.withoutCapacity, 0)
  assert.equal(summary.conflicts.length, 0)

  const noCapacity = summarizeSelectedUtilization(selected.observedGames, {
    ...ARENA_CAPACITIES,
    b: { ...ARENA_CAPACITIES.team_bie, confidence: 'unverified', capacityPeriods: [] },
  })
  assert.equal(noCapacity.average, null)
  assert.equal(noCapacity.withoutCapacity, 1)

  const overCapacity = summarizeSelectedUtilization(selected.observedGames, {
    ...ARENA_CAPACITIES,
    b: { ...ARENA_CAPACITIES.team_bie, capacityPeriods: [{ validFrom: '2026-07-01', validTo: '2027-06-30', capacity: 100 }] },
  })
  assert.equal(overCapacity.average, 900)
  assert.equal(overCapacity.conflicts.length, 1)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFanAnalytics,
  hasRealAttendance,
  pearsonCorrelation,
  resultForTeam,
  weekdayForDate,
} from './fanAnalytics.js'

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

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findAttendanceCandidates, parseLimit, runAttendanceBackfill } from './backfill-attendance.js'

const game = (id, patch = {}) => ({ id, date: '2026-09-15', status: 'final', externalId: id, homeGoals: 2, ...patch })

test('candidates require final status, an external id, and missing or invalid attendance', () => {
  const db = { games: [
    game('ok'),
    game('scheduled', { status: 'scheduled' }),
    game('no-id', { externalId: '' }),
    game('has-attendance', { attendance: 4500 }),
    game('zero', { attendance: 0 }),
    game('bad', { attendance: 'unknown' }),
  ] }
  assert.deepEqual(findAttendanceCandidates(db).map((g) => g.id), ['ok', 'zero', 'bad'])
})

test('dry-run does not fetch, save, or mutate local data', async () => {
  const db = { games: [game('one')] }
  const before = structuredClone(db)
  let fetched = 0
  let saved = 0
  const result = await runAttendanceBackfill({
    db,
    fetchDetail: async () => { fetched++ },
    save: async () => { saved++ },
  })
  assert.deepEqual(result, { candidates: 1, updated: 0, errors: 0 })
  assert.equal(fetched, 0)
  assert.equal(saved, 0)
  assert.deepEqual(db, before)
})

test('write adds only attendance and preserves valid values and all other game fields', async () => {
  const existing = game('existing', { attendance: 999, notes: { keep: true } })
  const pending = game('pending', { nlDetailSyncedAt: 'old', playerStats: [{ goals: 1 }] })
  const db = { games: [existing, pending], metadata: { keep: true } }
  const before = structuredClone(db)
  let saved
  const result = await runAttendanceBackfill({
    db,
    write: true,
    fetchDetail: async () => ({ overview: { status: 'finished', spectators: '5434' } }),
    save: async (value) => { saved = structuredClone(value) },
    delay: async () => {},
  })
  assert.deepEqual(result, { candidates: 1, updated: 1, errors: 0 })
  assert.equal(existing.attendance, 999)
  assert.equal(pending.attendance, 5434)
  const expected = structuredClone(before)
  expected.games[1].attendance = 5434
  assert.deepEqual(db, expected)
  assert.deepEqual(saved, expected)
})

test('missing or invalid API values do not write; request errors do not block later games', async () => {
  const db = { games: [game('bad-api'), game('throws'), game('good')] }
  let calls = 0
  let saves = 0
  const result = await runAttendanceBackfill({
    db,
    write: true,
    fetchDetail: async () => {
      calls++
      if (calls === 1) return { overview: { status: 'finished', spectators: '0' } }
      if (calls === 2) throw new Error('offline')
      return { overview: { status: 'finished', spectators: 2345 } }
    },
    save: async () => { saves++ },
    delay: async () => {},
  })
  assert.deepEqual(result, { candidates: 3, updated: 1, errors: 1 })
  assert.equal('attendance' in db.games[0], false)
  assert.equal('attendance' in db.games[1], false)
  assert.equal(db.games[2].attendance, 2345)
  assert.equal(saves, 1)
})

test('rerunning is idempotent once attendance is populated', async () => {
  const db = { games: [game('one')] }
  let calls = 0
  const run = () => runAttendanceBackfill({
    db,
    write: true,
    fetchDetail: async () => { calls++; return { overview: { status: 'finished', spectators: '5434' } } },
    save: async () => {},
    delay: async () => {},
  })
  await run()
  const second = await run()
  assert.equal(calls, 1)
  assert.deepEqual(second, { candidates: 0, updated: 0, errors: 0 })
})

test('--limit=5 caps API calls, mutations, and saves to the first five candidates', async () => {
  const db = { games: Array.from({ length: 8 }, (_, i) => game(`g${i + 1}`)) }
  const before = structuredClone(db)
  const fetchedIds = []
  let saved
  const result = await runAttendanceBackfill({
    db,
    write: true,
    limit: parseLimit(['--write', '--limit=5']),
    fetchDetail: async (id) => {
      fetchedIds.push(id)
      return { overview: { status: 'finished', spectators: '4321' } }
    },
    save: async (value) => { saved = structuredClone(value) },
    delay: async () => {},
  })
  assert.deepEqual(result, { candidates: 5, updated: 5, errors: 0 })
  assert.deepEqual(fetchedIds, ['g1', 'g2', 'g3', 'g4', 'g5'])
  for (let i = 0; i < 5; i++) assert.equal(db.games[i].attendance, 4321)
  for (let i = 5; i < 8; i++) assert.deepEqual(db.games[i], before.games[i])
  for (let i = 0; i < 5; i++) {
    const expected = structuredClone(before.games[i])
    expected.attendance = 4321
    assert.deepEqual(db.games[i], expected)
  }
  assert.deepEqual(saved, db)
})

test('a limit larger than the candidate count processes only available candidates', async () => {
  const db = { games: [game('one'), game('two')] }
  const fetchedIds = []
  const result = await runAttendanceBackfill({
    db,
    write: true,
    limit: parseLimit(['--limit=5']),
    fetchDetail: async (id) => {
      fetchedIds.push(id)
      return { overview: { status: 'finished', spectators: '1234' } }
    },
    save: async () => {},
    delay: async () => {},
  })
  assert.deepEqual(result, { candidates: 2, updated: 2, errors: 0 })
  assert.deepEqual(fetchedIds, ['one', 'two'])
})

test('missing limit retains unlimited candidate processing', async () => {
  assert.equal(parseLimit(['--write']), undefined)
  const db = { games: Array.from({ length: 6 }, (_, i) => game(`g${i + 1}`)) }
  let calls = 0
  const result = await runAttendanceBackfill({
    db,
    write: true,
    limit: parseLimit([]),
    fetchDetail: async () => {
      calls++
      return { overview: { status: 'finished', spectators: '1111' } }
    },
    save: async () => {},
    delay: async () => {},
  })
  assert.equal(result.candidates, 6)
  assert.equal(calls, 6)
})

test('invalid limits are rejected before API calls and saves', async () => {
  for (const invalid of ['--limit=0', '--limit=-1', '--limit=1.5', '--limit=nope', '--limit=', '--limit']) {
    assert.throws(() => parseLimit([invalid]), /Ungültiges --limit/)
  }
  assert.throws(() => parseLimit(['--limit=2', '--limit=3']), /Ungültiges --limit/)

  let calls = 0
  let saves = 0
  await assert.rejects(runAttendanceBackfill({
    db: { games: [game('one')] },
    write: true,
    limit: 0,
    fetchDetail: async () => { calls++ },
    save: async () => { saves++ },
  }), /Ungültiges --limit/)
  assert.equal(calls, 0)
  assert.equal(saves, 0)
})

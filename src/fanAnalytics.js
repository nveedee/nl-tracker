import { ARENA_CAPACITIES, PRELIMINARY_SAMPLE_SIZE, capacityForGame } from './arenaCapacities.js'

const WEEKDAYS = [
  { id: 1, label: 'Montag' },
  { id: 2, label: 'Dienstag' },
  { id: 3, label: 'Mittwoch' },
  { id: 4, label: 'Donnerstag' },
  { id: 5, label: 'Freitag' },
  { id: 6, label: 'Samstag' },
  { id: 0, label: 'Sonntag' },
]

export function isFinalGame(game) {
  return game?.status === 'final'
    && typeof game.homeGoals === 'number' && Number.isFinite(game.homeGoals)
    && typeof game.awayGoals === 'number' && Number.isFinite(game.awayGoals)
}

export function hasRealAttendance(game) {
  return typeof game?.attendance === 'number'
    && Number.isFinite(game.attendance)
    && game.attendance > 0
}

export function weekdayForDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const parsed = new Date(`${date}T12:00:00Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null
  const day = parsed.getUTCDay()
  return Number.isFinite(day) ? day : null
}

function compareGameOrder(a, b) {
  return String(a.date || '').localeCompare(String(b.date || ''))
    || String(a.time || '').localeCompare(String(b.time || ''))
    || String(a.id || '').localeCompare(String(b.id || ''))
}

function matchesCalendarFilters(game, filters) {
  if (filters.from && weekdayForDate(filters.from) == null) return false
  if (filters.to && weekdayForDate(filters.to) == null) return false
  const hasCalendarFilter = Boolean(filters.from || filters.to || (filters.weekday !== '' && filters.weekday != null))
  const validDate = weekdayForDate(game.date) != null
  if (hasCalendarFilter && !validDate) return false
  if (filters.from && game.date < filters.from) return false
  if (filters.to && game.date > filters.to) return false
  if (filters.weekday !== '' && filters.weekday != null && weekdayForDate(game.date) !== Number(filters.weekday)) return false
  return true
}

function matchesClubFilter(game, filters) {
  if (!filters.teamId) return true
  const isHome = game.homeTeamId === filters.teamId
  const isAway = game.awayTeamId === filters.teamId
  if (!isHome && !isAway) return false
  if (filters.venuePerspective === 'home') return isHome
  if (filters.venuePerspective === 'away') return isAway
  return true
}

function addToBucket(map, key, game) {
  let bucket = map.get(key)
  if (!bucket) {
    bucket = { key, games: 0, attendanceTotal: 0 }
    map.set(key, bucket)
  }
  bucket.games++
  bucket.attendanceTotal += game.attendance
}

function finishBuckets(map, labelForKey, sortFn) {
  return [...map.values()]
    .map((bucket) => ({
      ...bucket,
      label: labelForKey(bucket.key),
      average: bucket.games ? bucket.attendanceTotal / bucket.games : null,
    }))
    .sort(sortFn)
}

export function resultForTeam(game, teamId) {
  const isHome = teamId === game.homeTeamId
  const goalsFor = isHome ? game.homeGoals : game.awayGoals
  const goalsAgainst = isHome ? game.awayGoals : game.homeGoals
  if (goalsFor === goalsAgainst) return { key: 'draw', label: 'Unentschieden', points: 1 }
  const won = goalsFor > goalsAgainst
  if (game.decision === 'OT' || game.decision === 'SO') {
    return won
      ? { key: 'win-extra', label: 'Sieg nach Verlängerung/SO', points: 2 }
      : { key: 'loss-extra', label: 'Niederlage nach Verlängerung/SO', points: 1 }
  }
  return won
    ? { key: 'win', label: 'Sieg', points: 3 }
    : { key: 'loss', label: 'Niederlage', points: 0 }
}

function formBefore(game, teamId, teamGames, formLength) {
  const previous = teamGames
    .filter((candidate) => candidate.id !== game.id
      && (candidate.homeTeamId === teamId || candidate.awayTeamId === teamId)
      && compareGameOrder(candidate, game) < 0)
    .sort(compareGameOrder)
    .slice(-formLength)
  if (!previous.length) return null
  const points = previous.reduce((sum, played) => sum + resultForTeam(played, teamId).points, 0)
  return { games: previous.length, averagePoints: points / previous.length, points }
}

export function pearsonCorrelation(points) {
  const validPoints = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
  if (validPoints.length < 3) return null
  const meanX = validPoints.reduce((sum, point) => sum + point.x, 0) / validPoints.length
  const meanY = validPoints.reduce((sum, point) => sum + point.y, 0) / validPoints.length
  let covariance = 0
  let varianceX = 0
  let varianceY = 0
  for (const point of validPoints) {
    const dx = point.x - meanX
    const dy = point.y - meanY
    covariance += dx * dy
    varianceX += dx * dx
    varianceY += dy * dy
  }
  if (varianceX === 0 || varianceY === 0) return null
  return covariance / Math.sqrt(varianceX * varianceY)
}

/**
 * Arena utilization describes each completed home game using its host arena.
 * Attendance remains the real positive game.attendance observation; unknown
 * capacities and missing attendance are excluded, never imputed.
 */
export function buildArenaUtilization({
  games = [],
  teams = [],
  asOf = new Date().toISOString().slice(0, 10),
  capacities = ARENA_CAPACITIES,
} = {}) {
  const allObservations = []
  const rows = teams.map((team) => {
    const capacityRecord = capacities[team.id] || null
    const completedHomeGames = games.filter((game) => game.homeTeamId === team.id && isFinalGame(game))
    const upcomingHomeGames = games.filter((game) => game.homeTeamId === team.id
      && game.status === 'scheduled' && typeof game.date === 'string'
      && weekdayForDate(game.date) != null && game.date > asOf)
    const attendanceGames = completedHomeGames.filter(hasRealAttendance)
    const coverage = completedHomeGames.length
      ? attendanceGames.length / completedHomeGames.length
      : null
    const observations = attendanceGames.flatMap((game) => {
      const capacity = capacityForGame(team.id, game.date, capacities)
      if (capacity == null) return []
      const utilization = (game.attendance / capacity) * 100
      return [{ game, attendance: game.attendance, capacity, utilization, capacityConflict: utilization > 100 }]
    })
    const sorted = observations.slice().sort((a, b) => a.utilization - b.utilization)
    const mean = (values) => values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null
    const utilizationSampleSize = observations.length
    allObservations.push(...observations)
    return {
      team,
      arena: capacityRecord?.arena || null,
      capacity: capacityRecord?.confidence === 'unverified' ? null : capacityRecord?.capacity ?? null,
      capacityPeriods: capacityRecord?.capacityPeriods || [],
      capacityConfidence: capacityRecord?.confidence || 'unverified',
      capacitySource: capacityRecord?.source || null,
      capacityCheckedAt: capacityRecord?.checkedAt || null,
      capacityNote: capacityRecord?.note || null,
      completedHomeGames: completedHomeGames.length,
      upcomingHomeGames: upcomingHomeGames.length,
      attendanceGames: attendanceGames.length,
      missingAttendance: completedHomeGames.length - attendanceGames.length,
      coverage,
      averageAttendance: mean(attendanceGames.map((game) => game.attendance)),
      utilizationGames: utilizationSampleSize,
      averageUtilization: mean(observations.map((entry) => entry.utilization)),
      lowestUtilization: sorted[0] || null,
      highestUtilization: sorted.at(-1) || null,
      capacityConflicts: observations.filter((entry) => entry.capacityConflict),
      isPreliminary: utilizationSampleSize < PRELIMINARY_SAMPLE_SIZE,
      state: completedHomeGames.length === 0 && upcomingHomeGames.length > 0
        ? 'no-home-games-yet'
        : completedHomeGames.length === 0 ? 'no-completed-home-games' : 'has-home-games',
    }
  })

  const ranked = rows.filter((row) => row.averageUtilization != null)
    .sort((a, b) => b.averageUtilization - a.averageUtilization || a.team.name.localeCompare(b.team.name))
  const attendanceRanking = rows.filter((row) => row.averageAttendance != null)
    .sort((a, b) => b.averageAttendance - a.averageAttendance || a.team.name.localeCompare(b.team.name))
  return {
    rows,
    ranking: ranked,
    attendanceRanking,
    averageUtilization: allObservations.length
      ? allObservations.reduce((sum, entry) => sum + entry.utilization, 0) / allObservations.length
      : null,
    utilizationGames: allObservations.length,
    missingAttendanceGames: rows.reduce((sum, row) => sum + row.missingAttendance, 0),
    attendanceWithoutCapacity: rows.reduce((sum, row) => sum + row.attendanceGames - row.utilizationGames, 0),
    preliminarySampleSize: PRELIMINARY_SAMPLE_SIZE,
  }
}

export function buildFanAnalytics({ games = [], teams = [], standings = [], filters = {}, formLength = 5 } = {}) {
  const teamById = new Map(teams.map((team) => [team.id, team]))
  const allFinalGames = games.filter(isFinalGame)
  const finalGames = games.filter((game) => isFinalGame(game) && matchesCalendarFilters(game, filters))
  const scopedGames = finalGames
    .filter((game) => matchesClubFilter(game, filters))
    .sort(compareGameOrder)
  const observedGames = scopedGames.filter(hasRealAttendance)

  // Heim-Durchschnitte bleiben eine Arenastatistik. Die Auswahl eines Clubs
  // bzw. dessen Auswärtsperspektive verschiebt diese Zahl nicht zum Gastteam.
  const teamRows = teams.map((team) => {
    const homeGames = finalGames.filter((game) => game.homeTeamId === team.id)
    const recorded = homeGames.filter(hasRealAttendance)
    return {
      team,
      games: homeGames.length,
      recorded: recorded.length,
      coverage: homeGames.length ? recorded.length / homeGames.length : null,
      attendanceTotal: recorded.reduce((sum, game) => sum + game.attendance, 0),
      average: recorded.length
        ? recorded.reduce((sum, game) => sum + game.attendance, 0) / recorded.length
        : null,
    }
  }).sort((a, b) => (b.average ?? -1) - (a.average ?? -1) || a.team.name.localeCompare(b.team.name))

  const daily = new Map()
  const weekdays = new Map()
  const kickoffs = new Map()
  const outcomes = new Map()
  const formPoints = []
  // Die Filter begrenzen die analysierten Zuschauer-Spiele, nicht die
  // Vorgeschichte: Form wird aus allen lokalen Resultaten vor diesem Spiel
  // berechnet, auch wenn diese vor dem gewählten Anzeigezeitraum liegen.
  const formGames = allFinalGames
  const focusedTeamId = filters.teamId || null

  for (const game of observedGames) {
    const validDate = weekdayForDate(game.date) != null
    addToBucket(daily, validDate ? game.date : 'unknown', game)
    const weekday = weekdayForDate(game.date)
    if (weekday != null) addToBucket(weekdays, weekday, game)
    const kickoff = /^\d{2}:\d{2}$/.test(game.time || '') ? game.time : 'unknown'
    addToBucket(kickoffs, kickoff, game)

    const perspectiveId = focusedTeamId || game.homeTeamId
    if (!teamById.has(perspectiveId)) continue
    const outcome = resultForTeam(game, perspectiveId)
    const outcomeBucket = outcomes.get(outcome.key) || { ...outcome, games: 0, attendanceTotal: 0 }
    outcomeBucket.games++
    outcomeBucket.attendanceTotal += game.attendance
    outcomes.set(outcome.key, outcomeBucket)

    const clubForForm = focusedTeamId || game.homeTeamId
    const form = formBefore(game, clubForForm, formGames, formLength)
    if (form) formPoints.push({
      game,
      team: teamById.get(clubForForm),
      x: form.averagePoints,
      y: game.attendance,
      priorGames: form.games,
      priorPoints: form.points,
    })
  }

  const rankByTeamId = new Map(standings.map((row, index) => [row.team?.id || row.id, index + 1]))
  const rankAttendance = teamRows
    .filter((row) => row.average != null && rankByTeamId.has(row.team.id))
    .map((row) => ({ ...row, rank: rankByTeamId.get(row.team.id) }))
    .sort((a, b) => a.rank - b.rank)

  const dailyRows = finishBuckets(daily, (key) => key, (a, b) => a.key.localeCompare(b.key))
  const weekdayRows = finishBuckets(
    weekdays,
    (key) => WEEKDAYS.find((day) => day.id === key)?.label || 'Unbekannt',
    (a, b) => WEEKDAYS.findIndex((day) => day.id === a.key) - WEEKDAYS.findIndex((day) => day.id === b.key),
  )
  const kickoffRows = finishBuckets(kickoffs, (key) => key === 'unknown' ? 'Keine Zeitangabe' : key, (a, b) => a.key.localeCompare(b.key))
  const outcomeRows = [...outcomes.values()]
    .map((row) => ({ ...row, average: row.attendanceTotal / row.games }))
    .sort((a, b) => ['win', 'win-extra', 'loss-extra', 'loss', 'draw'].indexOf(a.key)
      - ['win', 'win-extra', 'loss-extra', 'loss', 'draw'].indexOf(b.key))
  const extremes = [...observedGames].sort((a, b) => a.attendance - b.attendance)

  return {
    finalGames: scopedGames,
    calendarGames: finalGames,
    observedGames,
    missingAttendance: scopedGames.length - observedGames.length,
    average: observedGames.length
      ? observedGames.reduce((sum, game) => sum + game.attendance, 0) / observedGames.length
      : null,
    totalAttendance: observedGames.reduce((sum, game) => sum + game.attendance, 0),
    coverage: scopedGames.length ? observedGames.length / scopedGames.length : null,
    dailyRows,
    weekdayRows,
    kickoffRows,
    teamRows,
    rankAttendance,
    outcomeRows,
    formPoints,
    formCorrelation: pearsonCorrelation(formPoints),
    lowest: extremes[0] || null,
    highest: extremes[extremes.length - 1] || null,
    weekDays: WEEKDAYS,
  }
}

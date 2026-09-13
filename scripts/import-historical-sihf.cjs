// ---------------------------------------------------------------------------
// Importiert historische NL-Saisons direkt von der offiziellen SIHF-API.
// Schreibt NUR nach server/data/historical/*.json — rührt seed.json/db.json
// (aktuelle Saison 2026/27) nicht an.
//
// Game-ID-Schema (empirisch ermittelt): {seasonEndYear}1105{seq:06d}
//   z.B. 20261105000001 = Saison 2025/26, NL Regular Season, Spiel 1.
// Funktioniert nachweislich für Saison-Endjahre 2018–2026 (= Saisons
// 2017/18 .. 2025/26). Saison 2016/17 (Endjahr 2017) liefert für dieses
// Schema durchgehend 404 -> nicht über diese API verfügbar, wird als
// "nicht verfügbar" protokolliert statt endlos zu raten.
//
// Läuft idempotent: bereits importierte gameIds pro Saison werden übersprungen.
// ---------------------------------------------------------------------------
const fs = require('fs')
const path = require('path')

const OUT_DIR = path.join(__dirname, '..', 'server', 'data', 'historical')
const BASE = 'https://data.sihf.ch/statistic/api/cms/gameoverview'
const REQUEST_DELAY_MS = 180 // ~5.5 req/s, deutlich unter dem beobachteten Limit (240 / ~34s)
const MAX_CONSECUTIVE_MISSES = 6 // Saisonende-Heuristik
const MAX_SEQ = Number(process.env.MAX_SEQ) || 500 // harte Obergrenze pro Saison (Sicherheitsnetz)

const SEASON_END_YEARS = process.env.SEASONS
  ? process.env.SEASONS.split(',').map(Number)
  : [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]

function seasonLabel(endYear) {
  return `${endYear - 1}/${String(endYear).slice(2)}`
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function fetchGame(gameId) {
  const url = `${BASE}?alias=gameDetail&searchQuery=${gameId}&language=de`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (nl-tracker historical import)' } })
  const remaining = Number(res.headers.get('x-ratelimit-remaining'))
  const reset = Number(res.headers.get('x-ratelimit-reset'))
  if (Number.isFinite(remaining) && remaining <= 5 && Number.isFinite(reset) && reset > 0) {
    await sleep((reset + 1) * 1000)
  }
  if (res.status === 404) return { ok: false, status: 404 }
  if (!res.ok) return { ok: false, status: res.status }
  const text = await res.text()
  if (!text || text.length < 10) return { ok: false, status: res.status, empty: true }
  let json
  try { json = JSON.parse(text) } catch { return { ok: false, status: res.status, parseError: true } }
  if (json.stub) return { ok: false, stub: true }
  return { ok: true, json }
}

function parseStatsTable(block) {
  if (!block || !block.header || !block.data) return []
  const keys = block.header.map((h) => h.alias)
  return block.data
    .filter((row) => !row.some((c) => c === 'Total'))
    .map((row) => Object.fromEntries(keys.map((k, i) => [k, row[i]])))
}

function parseTeamStats(block) {
  if (!block || !block.data) return null
  const out = {}
  for (const row of block.data) {
    const [statName, homeVal, awayVal] = row
    out[statName] = { home: homeVal, away: awayVal }
  }
  return out
}

function deriveDecision(scores, shootout) {
  if (!scores || scores.length <= 3) return 'REG'
  const hasShootout = !!(shootout && Array.isArray(shootout.shoots) && shootout.shoots.length > 0)
  return hasShootout ? 'SO' : 'OT'
}

function normalizeGame(gameId, seasonEndYear, json) {
  const scores = json.result?.scores || []
  const sogs = json.result?.sogs || []
  const stats = json.stats || []
  const findStat = (alias) => stats.find((s) => s.alias === alias)

  const homeId = json.details?.homeTeam?.id
  const awayId = json.details?.awayTeam?.id

  return {
    season: seasonLabel(seasonEndYear),
    seasonEndYear,
    gameId,
    date: (json.startDateTime || '').slice(0, 10),
    startDateTime: json.startDateTime,
    venue: json.details?.venue?.name || null,
    homeTeam: json.details?.homeTeam ? { sihfId: json.details.homeTeam.id, name: json.details.homeTeam.name, acronym: json.details.homeTeam.acronym } : null,
    awayTeam: json.details?.awayTeam ? { sihfId: json.details.awayTeam.id, name: json.details.awayTeam.name, acronym: json.details.awayTeam.acronym } : null,
    homeGoals: json.result ? Number(json.result.homeTeam) : null,
    awayGoals: json.result ? Number(json.result.awayTeam) : null,
    decision: deriveDecision(scores, json.summary?.shootout),
    periods: scores.map((s) => ({ name: s.name, indicator: s.indicator, home: Number(s.homeTeam), away: Number(s.awayTeam) })),
    shots: sogs.map((s) => ({ name: s.name, indicator: s.indicator, home: Number(s.homeTeam), away: Number(s.awayTeam) })),
    shootout: json.summary?.shootout?.shoots || null,
    events: (json.summary?.periods || []).map((p) => ({ name: p.name, goals: p.goals, fouls: p.fouls, goalkeepers: p.goalkeepers })),
    players: {
      home: parseStatsTable(findStat('gamePlayerStatsHome')),
      away: parseStatsTable(findStat('gamePlayerStatsAway')),
    },
    goalies: {
      home: parseStatsTable(findStat('gameGoalieStatsHome')),
      away: parseStatsTable(findStat('gameGoalieStatsAway')),
    },
    teamStats: parseTeamStats(findStat('gameTeamStats')),
    roster: (json.players || []).map((p) => ({ id: p.id, fullName: p.fullName, jerseyNumber: p.jerseyNumber, teamId: p.teamId, ageGroup: p.ageGroup })),
    referees: json.details?.referees || [],
    status: json.status ? { id: json.status.id, name: json.status.name, percent: json.status.percent, canceled: json.status.canceled } : null,
  }
}

function loadExisting(seasonEndYear) {
  const file = path.join(OUT_DIR, `${seasonLabel(seasonEndYear).replace('/', '-')}.json`)
  if (!fs.existsSync(file)) return { file, data: { season: seasonLabel(seasonEndYear), seasonEndYear, games: [], failed: [] } }
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return { file, data }
  } catch {
    return { file, data: { season: seasonLabel(seasonEndYear), seasonEndYear, games: [], failed: [] } }
  }
}

function saveSeason(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(data, null, 2))
}

async function importSeason(seasonEndYear) {
  const label = seasonLabel(seasonEndYear)
  const { file, data } = loadExisting(seasonEndYear)
  const existingIds = new Set(data.games.map((g) => g.gameId))
  const prefix = `${seasonEndYear}1105`

  let misses = 0
  let seq = 1
  let fetchedThisRun = 0

  while (seq <= MAX_SEQ && misses < MAX_CONSECUTIVE_MISSES) {
    const gameId = `${prefix}${String(seq).padStart(6, '0')}`
    seq++

    if (existingIds.has(gameId)) { misses = 0; continue } // schon importiert -> zählt als "vorhanden", kein Miss

    const result = await fetchGame(gameId)
    await sleep(REQUEST_DELAY_MS)

    if (!result.ok) {
      misses++
      continue
    }
    misses = 0
    fetchedThisRun++

    const json = result.json
    const finished = json.status && json.status.percent === 100 && json.status.name && !json.status.canceled
    if (!finished) {
      data.failed.push({ gameId, reason: json.status?.canceled ? 'canceled' : `not finished (status: ${json.status?.name}, ${json.status?.percent}%)` })
      continue
    }
    if (!json.result || json.result.homeTeam === '' || json.result.awayTeam === '') {
      data.failed.push({ gameId, reason: 'no result data' })
      continue
    }

    data.games.push(normalizeGame(gameId, seasonEndYear, json))

    if (fetchedThisRun % 50 === 0) {
      saveSeason(file, data) // Zwischenspeichern, falls der Lauf unterbrochen wird
      console.log(`  [${label}] ... ${data.games.length} Spiele importiert (seq ${seq})`)
    }
  }

  saveSeason(file, data)
  return data
}

async function main() {
  console.log('SIHF Historical Import — Start', new Date().toISOString())
  const summary = []

  for (const endYear of SEASON_END_YEARS) {
    const label = seasonLabel(endYear)
    console.log(`\n== Saison ${label} (Endjahr ${endYear}) ==`)

    // Schnelltest: erstes Spiel der Saison erreichbar?
    const probe = await fetchGame(`${endYear}1105000001`)
    await sleep(REQUEST_DELAY_MS)
    if (!probe.ok) {
      console.log(`  Saison ${label} über dieses ID-Schema nicht erreichbar (Probe-404) — übersprungen.`)
      summary.push({ season: label, games: 0, teams: 0, ot: 0, so: 0, failed: ['gesamte Saison nicht verfügbar (ID-Schema greift nicht)'], unavailable: true })
      continue
    }

    const data = await importSeason(endYear)
    const teams = new Set()
    let ot = 0, so = 0
    for (const g of data.games) {
      if (g.homeTeam) teams.add(g.homeTeam.sihfId)
      if (g.awayTeam) teams.add(g.awayTeam.sihfId)
      if (g.decision === 'OT') ot++
      if (g.decision === 'SO') so++
    }
    console.log(`  Fertig: ${data.games.length} Spiele, ${teams.size} Teams, OT=${ot}, SO=${so}, fehlerhaft/fehlend=${data.failed.length}`)
    summary.push({ season: label, games: data.games.length, teams: teams.size, ot, so, failed: data.failed.map((f) => f.gameId) })
  }

  fs.writeFileSync(path.join(OUT_DIR, '_summary.json'), JSON.stringify(summary, null, 2))
  console.log('\nSIHF Historical Import — Ende', new Date().toISOString())
}

main().catch((e) => { console.error('FATAL', e); process.exit(1) })

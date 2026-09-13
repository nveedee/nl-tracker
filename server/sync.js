// ---------------------------------------------------------------------------
// National-League-API-Sync: spiegelt Rohdaten der öffentlichen
// nationalleague.ch-API (Spiele, Tabelle, Spieler) nach server/data/db.json.
//
// Quellen (siehe Erkundungsbericht):
//   GET https://www.nationalleague.ch/api/games?lang=de-CH   (Resultate + Spielplan)
//   GET https://www.nationalleague.ch/api/teams?lang=de-CH   (Tabelle)
//   GET https://www.nationalleague.ch/api/player?lang=de-CH  (Spieler-Rohdaten)
//
// Getrennt vom bestehenden server/scripts/sync-sihf.cjs (Live-Boxscores pro
// Spiel über die offizielle SIHF-API) - dieser Sync liefert dagegen die
// Season-Totale/Marktwerte der Spieler sowie Tabelle + kompletten Spielplan
// aus einer zweiten, unabhängigen Quelle. Beide Syncs schreiben additiv in
// dieselbe db.json, ohne sich gegenseitig zu stören (siehe Feldgrenzen unten).
//
// Sicherheitsprinzipien (analog sync-sihf.cjs):
//   - Alle drei Endpunkte werden ZUERST abgerufen; erst wenn alle drei UND das
//     Team-Mapping erfolgreich sind, wird die in-memory db mutiert und
//     geschrieben. Bei jedem Fehler/Timeout bleibt db.json unverändert.
//   - Ein bereits `status:'final'` gemeldetes Spiel wird NIE zurück auf
//     `scheduled` gesetzt, nur weil die API (noch) nicht nachgezogen hat -
//     Resultate gehen so nie verloren, egal welche Quelle zuerst final war.
//   - Manuell erfasste Spieler/Spiele (ohne externalId) werden nie dupliziert,
//     sondern per (teamId + normalisierter Name) bzw. (Datum + Teams)
//     einmalig verknüpft (externalId angehängt) und danach nur noch per
//     externalId gefunden.
//   - Rührt NUR die unten explizit gelisteten Felder an - ELO-Einstellungen,
//     Power-Ranking-Gewichte, Team-Farben sowie alle manuellen Spieler-Felder
//     (name, positionDetail, shoots, nationality, heightCm, weightKg,
//     birthdate, injury*) bleiben unangetastet.
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, 'data', 'db.json')
const STATUS_PATH = path.join(__dirname, 'data', 'nl-sync-status.json')

const NL_API_BASE = 'https://www.nationalleague.ch/api'
const GAMES_URL = `${NL_API_BASE}/games?lang=de-CH`
const TEAMS_URL = `${NL_API_BASE}/teams?lang=de-CH`
const PLAYERS_URL = `${NL_API_BASE}/player?lang=de-CH`

// Default-Intervall für den optionalen automatischen Poll (siehe server/index.js,
// Env-Var NL_SYNC_INTERVAL_MIN überschreibt). Die API selbst cacht 10 Min
// (Cache-Control: max-age=600) - häufigeres Pollen bringt nichts.
export const DEFAULT_NL_SYNC_INTERVAL_MIN = 30

// ============================================================================
// HTTP
// ============================================================================

async function fetchJson(url, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'nl-tracker-sync/1.0', Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} von ${url}`)
    return await res.json()
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout nach ${timeoutMs}ms bei ${url}`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// ============================================================================
// DB-Helfer (eigenständig, analog sync-sihf.cjs - bewusst dupliziert)
// ============================================================================

function readDb() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')) }
function writeDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)) }

export function readNlSyncStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf-8')) } catch { return null }
}
function writeNlSyncStatus(status) { fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2)) }

// ============================================================================
// Namens-/Team-Abgleich (accent-insensitive, reihenfolge-unabhängig)
// ============================================================================

// Regex für kombinierende diakritische Zeichen (Unicode-Block U+0300-U+036F)
// über Zeichencodes statt Literal aufgebaut, um Encoding-Stolperfallen beim
// Editieren dieser Datei zu vermeiden.
const DIACRITIC_MARKS_RE = new RegExp(
  '[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g'
)
function stripAccents(s) {
  return String(s || '').normalize('NFD').replace(DIACRITIC_MARKS_RE, '')
}

// Spielername: SIHF/NL-API und unsere lokalen Daten schreiben Namen in
// derselben "Vorname Nachname"-Reihenfolge, aber teils mit/ohne Akzent
// (z.B. "Pontus Åberg" lokal vs. "Pontus Aberg" von der API). Wortmenge
// (sortiert, akzent-/klein geschrieben) macht den Vergleich robust, ohne
// etwas zu erfinden - kein Treffer wird einfach übersprungen.
function normalizePlayerName(name) {
  return stripAccents(name).toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ')
}

function normalizeTeamName(name) {
  return stripAccents(name).toLowerCase().replace(/\s+/g, ' ').trim()
}

// Bekannte Abweichungen zwischen dem API-Kürzel (teamShortName) und unserem
// eigenen `short`-Feld (verifiziert gegen /api/teams, siehe Erkundungsbericht).
// Alle anderen Teams matchen entweder direkt per Kürzel oder per vollem Namen.
const SHORT_NAME_OVERRIDES = {
  HCA: 'AJO',
  HCAP: 'AMB',
  EHCB: 'BIE',
  HCL: 'LUG',
  EVZ: 'ZUG',
  SCRJ: 'SCRJ', // identisch, nur zur Vollständigkeit dokumentiert
}

// Baut { apiTeamId -> lokale team_xxx-ID } frisch aus der Live-Antwort von
// /api/teams her (nichts hartkodiert). Wirft einen Fehler, wenn nicht ALLE
// 14 lokalen Teams eindeutig einem API-Team zugeordnet werden konnten -
// nichts wird geraten.
export function buildTeamIdMap(apiTeams, localTeams) {
  const map = {}
  const matchedLocalIds = new Set()

  for (const apiTeam of apiTeams) {
    const apiShort = String(apiTeam.shortName || '').toUpperCase()
    const overrideShort = SHORT_NAME_OVERRIDES[apiShort]

    let local = overrideShort
      ? localTeams.find((t) => t.short.toUpperCase() === overrideShort)
      : null
    if (!local) local = localTeams.find((t) => t.short.toUpperCase() === apiShort)
    if (!local) local = localTeams.find((t) => normalizeTeamName(t.name) === normalizeTeamName(apiTeam.name))
    if (!local) continue

    if (matchedLocalIds.has(local.id)) {
      throw new Error(
        `Team-Mapping mehrdeutig: lokales Team "${local.id}" wurde bereits einem anderen API-Team zugeordnet ` +
        `(jetzt zusätzlich: ${apiTeam.name}/${apiTeam.shortName}, teamId=${apiTeam.teamId}). Nichts wird geraten - bitte manuell prüfen.`
      )
    }
    matchedLocalIds.add(local.id)
    map[apiTeam.teamId] = local.id
  }

  const unmatchedLocal = localTeams.filter((t) => !matchedLocalIds.has(t.id))
  if (localTeams.length !== 14 || matchedLocalIds.size !== 14 || unmatchedLocal.length > 0) {
    throw new Error(
      `Team-Mapping unvollständig: ${matchedLocalIds.size}/${localTeams.length} lokale Teams eindeutig zugeordnet. ` +
      (unmatchedLocal.length ? `Nicht zugeordnet: ${unmatchedLocal.map((t) => `${t.id} (${t.name})`).join(', ')}.` : '')
    )
  }
  return map
}

// ============================================================================
// Teams (Tabelle) - additiv: externalId + apiStanding, sonst nichts angefasst.
// ============================================================================

function syncTeams(db, apiTeams, teamMap, log) {
  const byApiId = new Map(apiTeams.map((t) => [t.teamId, t]))
  let updated = 0
  for (const [apiTeamId, localTeamId] of Object.entries(teamMap)) {
    const local = db.teams.find((t) => t.id === localTeamId)
    const apiTeam = byApiId.get(apiTeamId)
    if (!local || !apiTeam) continue
    local.externalId = apiTeamId
    local.apiStanding = {
      rank: apiTeam.rank,
      gp: apiTeam.gp,
      gw: apiTeam.gw,
      gwot: apiTeam.gwot,
      gwpe: apiTeam.gwpe,
      gl: apiTeam.gl,
      glot: apiTeam.glot,
      glpe: apiTeam.glpe,
      points: apiTeam.po,
      goalsFor: apiTeam.g,
      goalsAgainst: apiTeam.ga,
      streak: apiTeam.streak,
    }
    updated++
  }
  log(`Teams: ${updated}/14 mit API-Tabellendaten ergänzt (externalId + apiStanding).`)
  return { teamsUpdated: updated }
}

// ============================================================================
// Spieler - upsert per externalId, sonst per (teamId + normalisierter Name).
// ============================================================================

const POSITION_MAP = { forwarder: 'F', defender: 'D', goalkeeper: 'G' }

function parseNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Marktwert-Verlauf: additiv, kleine {date, marketValue}-Liste pro Spieler
// (player.marketValueHistory), NEUES Feld - überschreibt nichts Bestehendes.
// Ein Eintrag pro Kalendertag (Europe/Zurich, wie der Rest der App - siehe
// zurichTime() unten), dedupliziert über mehrere Syncs am selben Tag (der
// häufigste Fall bei einem 30-Minuten-Intervall). Liste auf
// MAX_MARKET_VALUE_HISTORY begrenzt (älteste Einträge fallen zuerst raus).
const MAX_MARKET_VALUE_HISTORY = 200

export function todayInZurich() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(new Date())
}

export function appendMarketValueSnapshot(player, marketValue, todayIso) {
  if (marketValue == null) return false // kein aktueller Wert von der API -> nichts erfinden
  if (!Array.isArray(player.marketValueHistory)) player.marketValueHistory = []
  const hist = player.marketValueHistory
  const last = hist[hist.length - 1]
  if (last && last.date === todayIso) return false // heute schon ein Eintrag (Dedupe pro Tag)
  hist.push({ date: todayIso, marketValue })
  if (hist.length > MAX_MARKET_VALUE_HISTORY) hist.splice(0, hist.length - MAX_MARKET_VALUE_HISTORY)
  return true
}

function buildApiStats(p, position) {
  const stats = {
    gp: p.gp || 0,
    g: p.g || 0,
    a: p.assists || 0,
    points: p.points || 0,
    plusMinus: p.plusMinus || 0,
    pim: p.pim || 0,
  }
  if (position === 'G') {
    stats.ga = p.ga || 0
    stats.sa = p.sa || 0
    stats.svs = p.svs || 0
    stats.savePercentage = p.savePercentage || 0
    stats.so = p.so || 0
    stats.otw = p.otw || 0
    stats.otl = p.otl || 0
  }
  return stats
}

export function syncPlayers(db, apiPlayers, teamMap, log, todayIso = todayInZurich()) {
  let created = 0, updated = 0, skippedBroken = 0, matchedByName = 0, marketValueSnapshotsAppended = 0

  for (const p of apiPlayers) {
    // Kaputte Datensätze überspringen: position===0 (statt String), showRank
    // false, oder teamId ohne Treffer in unseren 14 NL-Teams.
    if (p.position === 0 || p.showRank === false) { skippedBroken++; continue }
    const position = POSITION_MAP[p.position]
    const localTeamId = teamMap[p.teamId]
    if (!position || !localTeamId) { skippedBroken++; continue }

    const fullName = `${p.firstName || ''} ${p.lastName || ''}`.trim()
    const number = parseNumber(p.number)
    const marketValue = typeof p.topscorerMarketValue === 'number' ? p.topscorerMarketValue : null
    const marketValueTrend = typeof p.topscorerMarketValueTrend === 'number' ? p.topscorerMarketValueTrend : null
    const apiStats = buildApiStats(p, position)

    let local = db.players.find((pl) => pl.externalId === p.playerId)
    if (!local) {
      local = db.players.find(
        (pl) => !pl.externalId && pl.teamId === localTeamId && normalizePlayerName(pl.name) === normalizePlayerName(fullName)
      )
      if (local) matchedByName++
    }

    if (local) {
      // Nur die von der API stammenden Felder anfassen - manuelle Felder
      // (name, positionDetail, shoots, nationality, heightCm, weightKg,
      // birthdate, injury*) bleiben unverändert, auch wenn die API dafür
      // keine (leeren) Werte liefert.
      local.externalId = p.playerId
      local.number = number
      local.teamId = localTeamId
      local.position = position
      local.apiStats = apiStats
      local.marketValue = marketValue
      local.marketValueTrend = marketValueTrend
      if (appendMarketValueSnapshot(local, marketValue, todayIso)) marketValueSnapshotsAppended++
      updated++
    } else {
      const newPlayer = {
        id: `player_api_${p.playerId}`,
        name: fullName,
        position,
        teamId: localTeamId,
        externalId: p.playerId,
        number,
        apiStats,
        marketValue,
        marketValueTrend,
      }
      if (appendMarketValueSnapshot(newPlayer, marketValue, todayIso)) marketValueSnapshotsAppended++
      db.players.push(newPlayer)
      created++
    }
  }

  log(`Spieler: ${updated} aktualisiert (davon ${matchedByName} neu per Name mit bestehendem Roster verknüpft), ${created} neu angelegt, ${skippedBroken} übersprungen (kaputt/kein Team-Match).`)
  log(`Marktwert-Verlauf: ${marketValueSnapshotsAppended} neue Tages-Snapshots (${todayIso}), Rest bereits vorhanden (Dedupe pro Tag).`)
  return {
    playersUpdated: updated, playersCreated: created, playersSkippedBroken: skippedBroken, playersMatchedByName: matchedByName,
    marketValueSnapshotsAppended,
  }
}

// ============================================================================
// Spiele - nur reguläre NL-Saisonspiele (keine Testspiele, keine Nicht-NL-Gegner).
// ============================================================================

function zurichTime(isoString) {
  try {
    return new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Europe/Zurich' }).format(new Date(isoString))
  } catch {
    return null
  }
}

function syncGames(db, apiGames, teamMap, log) {
  let finalCount = 0, scheduledCount = 0, created = 0, updated = 0, matchedByDate = 0
  let skippedExhibition = 0, skippedNotNl = 0

  for (const g of apiGames) {
    if (g.isExhibition) { skippedExhibition++; continue }
    const homeTeamId = teamMap[g.homeTeamId]
    const awayTeamId = teamMap[g.awayTeamId]
    if (!homeTeamId || !awayTeamId) { skippedNotNl++; continue }

    const dateOnly = String(g.date || '').slice(0, 10)
    const isFinal = g.status === 'finished' || g.status === 'end'
    if (isFinal) finalCount++
    else scheduledCount++

    let local = db.games.find((game) => game.externalId === g.gameId)
    if (!local) {
      local = db.games.find(
        (game) => !game.externalId && game.date === dateOnly && game.homeTeamId === homeTeamId && game.awayTeamId === awayTeamId
      )
      if (local) matchedByDate++
    }

    const patch = { externalId: g.gameId, date: dateOnly, homeTeamId, awayTeamId }
    if (isFinal) {
      patch.status = 'final'
      patch.homeGoals = g.homeTeamResult
      patch.awayGoals = g.awayTeamResult
      patch.decision = g.isShootout ? 'SO' : g.isOvertime ? 'OT' : 'REG'
    } else if (!local || local.status !== 'final') {
      patch.status = 'scheduled'
      patch.homeGoals = null
      patch.awayGoals = null
      patch.decision = null
    }
    // sonst: lokal bereits final, API (noch) nicht - status/goals/decision
    // bewusst NICHT anfassen, damit ein bestätigtes Resultat nie durch eine
    // nachhinkende Quelle zurückgesetzt wird.

    if (local) {
      Object.assign(local, patch) // playerStats/sihfGameId/sihf*-Felder bleiben unberührt (nicht im patch)
      updated++
    } else {
      db.games.push({
        id: `game_api_${g.gameId}`,
        date: dateOnly,
        time: zurichTime(g.date),
        homeTeamId,
        awayTeamId,
        status: patch.status || 'scheduled',
        homeGoals: patch.homeGoals ?? null,
        awayGoals: patch.awayGoals ?? null,
        decision: patch.decision ?? null,
        playerStats: [],
        externalId: g.gameId,
      })
      created++
    }
  }

  log(
    `Spiele: ${finalCount} final, ${scheduledCount} geplant (API-Sicht) · ${updated} bestehende aktualisiert (${matchedByDate} davon per Datum/Teams neu verknüpft), ${created} neu angelegt · ` +
    `${skippedExhibition} Testspiele und ${skippedNotNl} Spiele mit Nicht-NL-Team übersprungen.`
  )
  return {
    gamesFinal: finalCount, gamesScheduled: scheduledCount, gamesUpdated: updated, gamesCreated: created,
    gamesMatchedByDate: matchedByDate, gamesSkippedExhibition: skippedExhibition, gamesSkippedNotNl: skippedNotNl,
  }
}

// ============================================================================
// Orchestrierung
// ============================================================================

export async function runNlSync({ write = true, log = () => {} } = {}) {
  log('[NL SYNC] Starte...')

  // Alle drei Endpunkte ZUERST abrufen - erst wenn alle drei erfolgreich sind,
  // wird unten überhaupt etwas mutiert/geschrieben (siehe Kommentar oben).
  const [apiGames, apiTeams, apiPlayers] = await Promise.all([
    fetchJson(GAMES_URL),
    fetchJson(TEAMS_URL),
    fetchJson(PLAYERS_URL),
  ])

  if (!Array.isArray(apiGames) || !Array.isArray(apiTeams) || !Array.isArray(apiPlayers)) {
    throw new Error('Unerwartetes Antwortformat von der National-League-API (kein Array).')
  }

  const db = readDb()
  const teamMap = buildTeamIdMap(apiTeams, db.teams) // wirft bei unvollständigem Mapping - noch keine Mutation erfolgt

  const teamsSummary = syncTeams(db, apiTeams, teamMap, log)
  const playersSummary = syncPlayers(db, apiPlayers, teamMap, log)
  const gamesSummary = syncGames(db, apiGames, teamMap, log)

  const summary = { ...teamsSummary, ...playersSummary, ...gamesSummary }

  if (write) {
    writeDb(db)
    writeNlSyncStatus({ lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), ...summary })
  }

  log('[NL SYNC] Fertig.')
  return summary
}

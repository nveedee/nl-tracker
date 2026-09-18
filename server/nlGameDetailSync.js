// ---------------------------------------------------------------------------
// National-League-API Game-Detail-Sync: lädt für bereits `status:'final'`
// gemeldete Spiele (siehe server/sync.js, der `externalId`/status/Resultat
// setzt) die DETAILLIERTE Boxscore nach:
//
//   GET https://www.nationalleague.ch/api/games/{gameId}?isApp=false&lang=de-CH
//
// (Erkundung: siehe Chat-Report - öffentlich, ohne Auth/Cookies erreichbar,
// mit `curl` ohne Session verifiziert. Gleiche Player-/Team-ID-Basis wie
// server/sync.js: `lineupHome/Away[].players[].playerId` == player.externalId.)
//
// Bewusst ENTKOPPELT von server/sync.js (Team-/Spieler-/Spielplan-Sync) und
// server/scripts/sync-sihf.cjs (bestehende Boxscore-Quelle) - dieser Sync
// ERGÄNZT `game.playerStats[]` nur um zusätzliche Felder (Faceoffs, Blocks,
// PP/PK-TOI, Special-Teams-Tore, xG) und fügt die rohen Schuss-Daten neu
// hinzu. Bestehende, von SIHF gesetzte Felder (goals/assists/plusMinus/pim/
// sog/toiSec bzw. goalsAgainst/saves/decision/shutout) werden NIE entfernt
// oder überschrieben, nur ergänzt - siehe mergePlayerStat() unten.
//
// Sicherheitsprinzipien (analog server/sync.js/sync-sihf.cjs):
//   - Nur bereits `status:'final'` Spiele mit gesetzter `externalId` werden
//     angefasst (die IDENTIFIKATION eines Spiels bleibt ausschliesslich
//     Aufgabe von server/sync.js - hier wird nichts neu angelegt).
//   - Ein Spiel wird EINMALIG synchronisiert (`nlDetailSyncedAt` markiert
//     das) - kein wiederholter Request bei jedem Poll (siehe Performance-
//     Anforderung: ~450-500 Spiele/Saison, die Detail-API darf nicht bei
//     jedem Render/Poll erneut abgefragt werden).
//   - Schlägt der Abruf für EIN Spiel fehl (Timeout/5xx/unerwartetes Format),
//     wird das geloggt und mit dem NÄCHSTEN Spiel weitergemacht - der
//     gesamte Sync-Lauf bricht dafür nie ab, bestehende Spieldaten bleiben
//     unangetastet.
//   - `limit` pro Lauf (Default siehe DEFAULT_PER_RUN_LIMIT) verhindert, dass
//     ein einzelner Poll hunderte Requests auf einmal auslöst - neu
//     abgeschlossene Spiele werden so über mehrere Polls hinweg schrittweise
//     nachgezogen. Für einen gezielten Rückstands-Import vieler Spiele auf
//     einmal siehe server/scripts/backfill-nl-game-details.js (Punkt 12,
//     separater Mechanismus, NICHT Teil des normalen Auto-Sync-Polls).
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DB_PATH = path.join(__dirname, 'data', 'db.json')

const NL_API_BASE = 'https://www.nationalleague.ch/api'

// Wie viele Spiele höchstens EIN Sync-Lauf neu abruft (siehe Kommentar oben) -
// bei einem 30-Min-Poll werden normalerweise nur 0-5 Spiele neu final, dieser
// Wert ist bewusst grosszügig für Nachhol-Bedarf nach einem Ausfall.
export const DEFAULT_PER_RUN_LIMIT = 20

// Regulär-Perioden-Länge in Sekunden (20 Min.) - nur für die BEQUEMLICHKEITS-
// grösse `gameSecond` (kumulierte Spielzeit) verwendet, siehe normalizeShot()
// unten. Overtime-Perioden sind in der Realität kürzer (Playoff-OT: 20 Min.,
// Regular-Season-OT: 5 Min.) - `gameSecond` ist deshalb NUR für die Perioden
// 1-3 exakt, für Periode 4+ (OT) eine grobe, klar dokumentierte Näherung
// (Sortierreihenfolge bleibt trotzdem korrekt), NIE die alleinige Quelle der
// Wahrheit - `period`+`time` (beide roh von der API) bleiben immer mit
// gespeichert.
const REGULATION_PERIOD_SECONDS = 1200

// ============================================================================
// HTTP: Timeout + Retry (gleiches Prinzip wie server/sync.js::fetchJson und
// server/scripts/sync-sihf.cjs::fetchSihfGame, hier zusammengeführt)
// ============================================================================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function fetchJson(url, { timeoutMs = 10000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'nl-tracker-sync/1.0', Accept: 'application/json' },
    })
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} von ${url}`), { status: res.status })
    return await res.json()
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(`Timeout nach ${timeoutMs}ms bei ${url}`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

// Retry mit Exponential-Backoff bei transienten Fehlern (Timeout/5xx/Netzwerk) -
// 4xx (ausser 429) wird NICHT wiederholt (z.B. Spiel-ID existiert nicht).
async function fetchGameDetail(gameId, { retries = 2, log } = {}) {
  const url = `${NL_API_BASE}/games/${encodeURIComponent(gameId)}?isApp=false&lang=de-CH`
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchJson(url)
    } catch (e) {
      lastErr = e
      const retriable = !e.status || e.status >= 500 || e.status === 429
      if (!retriable || attempt >= retries) break
      const backoff = 500 * Math.pow(2, attempt)
      log && log(`  ⚠ Fehler beim Abruf von Game-Detail ${gameId} (Versuch ${attempt + 1}/${retries + 1}): ${e.message} - erneuter Versuch in ${backoff}ms`)
      await sleep(backoff)
    }
  }
  throw lastErr
}

// ============================================================================
// PARSING
// ============================================================================

// { "25" -> "300972", ... } aus lineupHome/lineupAway (siehe Erkundung:
// playerStatsHome/Away selbst tragen KEINE Spieler-ID, nur Trikotnummer -
// die stabile numerische NL-Spieler-ID (== player.externalId) kommt aus dem
// Lineup).
function buildNumberToPlayerId(lineupGroups) {
  const map = new Map()
  for (const group of lineupGroups || []) {
    for (const pl of group.players || []) {
      if (pl.number != null && pl.playerId != null) map.set(String(pl.number), String(pl.playerId))
    }
  }
  return map
}

function toNullableNumber(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// Faceoff-% kommt von der API bereits als -1, wenn der Spieler keine
// Bullys hatte (kein echter 0%-Wert) - als null übernehmen, nicht als 0.
function faceoffPct(v) {
  const n = toNullableNumber(v)
  return n == null || n < 0 ? null : n
}

// Baut aus EINEM playerStatsHome/Away-Eintrag der NL-Detail-API unser
// zusätzliches, additives Feld-Set (siehe Datei-Kopfkommentar - NICHTS
// überschreibt bestehende SIHF-Felder, siehe mergePlayerStat()).
function mapSkaterFields(row) {
  return {
    assistsPrimary: toNullableNumber(row.a1),
    assistsSecondary: toNullableNumber(row.a2),
    points: toNullableNumber(row.pts),
    shotsOnGoalNl: toNullableNumber(row.sog), // eigener Name (nicht `sog`) - siehe mergePlayerStat(): bestehendes `sog` (SIHF) hat Vorrang, dies ist der Vergleichs-/Fallback-Wert der zweiten Quelle
    shotsMissed: toNullableNumber(row.shm),
    shotsBlocked: toNullableNumber(row.shb), // eigener Schuss wurde vom Gegner geblockt
    blockedShots: toNullableNumber(row.bks), // Spieler hat selbst einen gegnerischen Schuss geblockt (defensiv)
    toiEqSec: toNullableNumber(row.toiEq),
    toiPpSec: toNullableNumber(row.toiPp),
    toiPkSec: toNullableNumber(row.toiPk),
    faceoffsWon: toNullableNumber(row.fow),
    faceoffsLost: toNullableNumber(row.fol),
    faceoffsTotal: toNullableNumber(row.fo),
    faceoffPercentage: faceoffPct(row.foPercentage),
    penaltyMinutes: toNullableNumber(row.pim),
    plusMinusNl: toNullableNumber(row.plMi),
  }
}

function mapGoalieFields(row) {
  return {
    goalsAgainstNl: toNullableNumber(row.ga),
    savesNl: toNullableNumber(row.svs),
    shotsAgainst: toNullableNumber(row.sa),
    savePercentageNl: toNullableNumber(row.savePercentage), // 0-100-Skala, roh von der API (siehe stats.js für Umrechnung bei Bedarf)
    gaaNl: toNullableNumber(row.gaa),
    toiSecNl: toNullableNumber(row.toi),
  }
}

// Rohe Schuss-Objekte einer Seite (shotsHome/shotsAway) -> unser Zielformat
// (siehe Auftrag Punkt 5). `pid` -> lokale playerId (über externalId,
// nicht übernommen falls kein Treffer - dann bleibt playerId null, der Shot
// wird trotzdem behalten, nur nicht einem Spieler zugeordnet, siehe
// Aufrufer). `period`/`time` bleiben ROH (sec=period, time=Sekunden
// innerhalb der Periode) - `gameSecond` ist eine zusätzliche, klar als
// Näherung dokumentierte Bequemlichkeitsgrösse (siehe Kommentar oben,
// REGULATION_PERIOD_SECONDS).
function normalizeShot(raw, localPlayerId) {
  const period = toNullableNumber(raw.sec)
  const time = toNullableNumber(raw.time)
  const gameSecond = period != null && time != null ? (period - 1) * REGULATION_PERIOD_SECONDS + time : null
  return {
    playerId: localPlayerId,
    period,
    time,
    gameSecond,
    situation: raw.sit ?? null, // EQ | PP | PK (roh von der API übernommen)
    type: raw.type ?? null, // GOAL | SOG | MISS | BLOCK (roh von der API übernommen)
    x: toNullableNumber(raw.posX),
    y: toNullableNumber(raw.posY),
    xg: toNullableNumber(raw.xg),
    xgSum: toNullableNumber(raw.xgSum),
    videoTime: toNullableNumber(raw.videoTime),
    unix: toNullableNumber(raw.unix),
  }
}

// Play-by-Play-Torereignisse (actions[].actions[], action==='goal') in
// chronologischer Reihenfolge (nach Periode, dann Spielzeit) - Basis für die
// Special-Teams-/Game-Winning-Goal-Ableitung unten. `time` ist bei Toren als
// Gesamt-Spielsekunde (nicht periodenrelativ) dokumentiert (siehe bestehende
// server/scripts/sync-sihf.cjs::parseLiveSnapshot-Kommentar zu SIHF - hier
// bei der NL-API separat, aber analog behandelt: numerisch sortiert).
function collectGoalEvents(actionsBlocks) {
  const goals = []
  for (const block of actionsBlocks || []) {
    for (const a of block.actions || []) {
      if (a.action !== 'goal') continue
      goals.push(a)
    }
  }
  goals.sort((x, y) => (Number(x.third) - Number(y.third)) || (Number(x.time) - Number(y.time)))
  return goals
}

// Standard-Definition "Game Winning Goal" (deterministisch aus den echten
// Toren hergeleitet, NICHT geschätzt): das früheste Tor des SIEGER-Teams, ab
// dem der Verlierer den Rückstand über den Rest des Spiels NIE mehr
// egalisiert/übertrifft. null bei Unentschieden nach 60 (kann nicht
// vorkommen, NL hat immer eine Entscheidung) oder bei Penaltyschiessen (die
// entscheidende Aktion ist dort kein regulärer `actions`-Toreintrag - siehe
// server/scripts/sync-sihf.cjs, dieselbe Vorsicht bei Shootouts) - dann
// bewusst null statt geraten.
function findGameWinningGoal(goalEvents, isShootout, finalHome, finalAway) {
  if (isShootout) return null
  if (finalHome === finalAway) return null
  const winnerIsHome = finalHome > finalAway
  for (let i = 0; i < goalEvents.length; i++) {
    const g = goalEvents[i]
    if (Boolean(g.homeTeam) !== winnerIsHome) continue
    const winnerScore = winnerIsHome ? Number(g.homeTeamResult) : Number(g.awayTeamResult)
    const loserScore = winnerIsHome ? Number(g.awayTeamResult) : Number(g.homeTeamResult)
    if (!(winnerScore > loserScore)) continue
    let stillAhead = true
    for (let j = i + 1; j < goalEvents.length; j++) {
      const h = goalEvents[j]
      const wLater = winnerIsHome ? Number(h.homeTeamResult) : Number(h.awayTeamResult)
      const lLater = winnerIsHome ? Number(h.awayTeamResult) : Number(h.homeTeamResult)
      if (lLater >= wLater) { stillAhead = false; break }
    }
    if (stillAhead) return g
  }
  return null
}

// Special-Teams-Zuordnung eines Tor-Ereignisses: `situation` beschreibt laut
// Erkundung die Situation AUS SICHT DES TORSCHÜTZEN-TEAMS ("PP1" bei einem
// verifizierten Powerplay-Tor). ANNAHME (nicht an einem echten
// Unterzahltor-Beispiel verifiziert, siehe Bericht): ein Präfix "SH" würde
// analog ein Unterzahltor markieren. Alles andere (insb. "EQ") zählt als
// keins von beidem - kein Raten bei unbekannten/leeren Werten.
function specialTeamsKind(situation) {
  if (!situation) return null
  const s = String(situation).toUpperCase()
  if (s.startsWith('PP')) return 'pp'
  if (s.startsWith('SH')) return 'sh'
  return null
}

// ============================================================================
// MERGE in game.playerStats[] - rein additiv (siehe Datei-Kopfkommentar)
// ============================================================================

function mergePlayerStat(existingArr, playerId, patch) {
  let entry = existingArr.find((s) => s.playerId === playerId)
  if (!entry) {
    entry = { playerId }
    existingArr.push(entry)
  }
  for (const [k, v] of Object.entries(patch)) {
    if (v != null) entry[k] = v // bestehende (z.B. SIHF-)Werte für Felder, die die NL-Detail-API NICHT liefert, bleiben unangetastet
  }
  return entry
}

// `db` wird IN-PLACE mutiert (gleiches Prinzip wie server/sync.js). Gibt eine
// kurze Zusammenfassung zurück; wirft NIE - Aufrufer (runNlGameDetailSync)
// fängt Fehler pro Spiel ab.
export function parseAndMergeGameDetail(db, game, raw, log) {
  const teamByExternalId = new Map(db.teams.map((t) => [String(t.externalId), t]))
  const homeTeam = teamByExternalId.get(String(raw.overview?.homeTeamId))
  const awayTeam = teamByExternalId.get(String(raw.overview?.awayTeamId))
  if (!homeTeam || !awayTeam || homeTeam.id !== game.homeTeamId || awayTeam.id !== game.awayTeamId) {
    throw new Error(`Team-Zuordnung der Game-Detail-Antwort stimmt nicht mit dem lokalen Spiel überein (erwartet ${game.homeTeamId}/${game.awayTeamId}).`)
  }

  const numToPlayerHome = buildNumberToPlayerId(raw.lineupHome)
  const numToPlayerAway = buildNumberToPlayerId(raw.lineupAway)
  const playerByExternalId = new Map(db.players.map((p) => [String(p.externalId), p]))

  if (!Array.isArray(game.playerStats)) game.playerStats = []
  let matched = 0, unmatched = 0

  const applySide = (rows, numToPlayer) => {
    for (const row of rows || []) {
      const externalId = numToPlayer.get(String(row.number))
      const localPlayer = externalId ? playerByExternalId.get(String(externalId)) : null
      if (!localPlayer) { unmatched++; continue }
      const patch = row.position === 'goalkeeper' ? mapGoalieFields(row) : mapSkaterFields(row)
      mergePlayerStat(game.playerStats, localPlayer.id, patch)
      matched++
    }
  }
  applySide(raw.playerStatsHome, numToPlayerHome)
  applySide(raw.playerStatsAway, numToPlayerAway)

  // --- Rohe Schuss-Daten (Punkt 5) - komplett neu, additiv, ersetzt bei
  //     erneutem Sync (sollte wegen nlDetailSyncedAt-Gate nicht vorkommen). ---
  const shotPlayerId = (pid) => {
    const p = pid != null ? playerByExternalId.get(String(pid)) : null
    return p ? p.id : null
  }
  const shotsHome = (raw.shotsHome || []).map((s) => normalizeShot(s, shotPlayerId(s.pid)))
  const shotsAway = (raw.shotsAway || []).map((s) => normalizeShot(s, shotPlayerId(s.pid)))
  game.nlShots = { home: shotsHome, away: shotsAway }

  // xG pro Spieler = Summe der xG-Werte all seiner Schüsse (ALLE Schuss-Typen,
  // nicht nur Tore - Standard-Definition für Spiel-xG). NUR gesetzt, wenn
  // mindestens ein Schuss mit einem xG-Wert existiert (sonst bleibt das Feld
  // weg statt fälschlich 0 zu zeigen).
  const xgByPlayer = new Map()
  for (const s of [...shotsHome, ...shotsAway]) {
    if (s.playerId == null || s.xg == null) continue
    xgByPlayer.set(s.playerId, (xgByPlayer.get(s.playerId) || 0) + s.xg)
  }
  for (const [playerId, xg] of xgByPlayer.entries()) {
    mergePlayerStat(game.playerStats, playerId, { xg: Math.round(xg * 10000) / 10000 })
  }

  // --- Team-Stats (additiv, neues Feld - bestehendes sihfTeamStats bleibt
  //     unangetastet, siehe server/scripts/sync-sihf.cjs) ---
  game.nlTeamStatsHome = raw.teamStatsHome || null
  game.nlTeamStatsAway = raw.teamStatsAway || null

  // --- Special Teams (PP/SH-Tore+Assists) + Game Winning Goal, aus dem
  //     Play-by-Play (actions[]) hergeleitet - siehe Funktionskommentare oben. ---
  const goalEvents = collectGoalEvents(raw.actions)
  const finalHome = toNullableNumber(raw.overview?.homeTeamResult)
  const finalAway = toNullableNumber(raw.overview?.awayTeamResult)
  const gwg = finalHome != null && finalAway != null
    ? findGameWinningGoal(goalEvents, !!raw.overview?.isShootout, finalHome, finalAway)
    : null

  const resolvePbpPlayer = (homeTeam_, number) => {
    const map = homeTeam_ ? numToPlayerHome : numToPlayerAway
    const externalId = number != null ? map.get(String(number)) : null
    const local = externalId ? playerByExternalId.get(String(externalId)) : null
    return local ? local.id : null
  }

  // Frische lokale Zähler (NICHT aus bereits gemergten playerStats-Werten
  // hochzählen - sonst würde ein erneuter Sync-Lauf desselben Spiels die
  // Special-Teams-Zähler bei jedem Aufruf verdoppeln statt sie korrekt neu
  // zu setzen, siehe Regressionstest "Aufruf ist idempotent").
  const ppGoals = new Map(), shGoals = new Map(), ppAssists = new Map(), shAssists = new Map()
  const gwgPlayerId = gwg ? resolvePbpPlayer(gwg.homeTeam, gwg.playerNumber) : null
  const bump = (map, id) => map.set(id, (map.get(id) || 0) + 1)

  for (const g of goalEvents) {
    const kind = specialTeamsKind(g.situation)
    if (!kind) continue
    const scorerId = resolvePbpPlayer(g.homeTeam, g.playerNumber)
    if (scorerId) bump(kind === 'pp' ? ppGoals : shGoals, scorerId)
    for (const assistNumber of [g.assist1Number, g.assist2Number]) {
      const assistId = resolvePbpPlayer(g.homeTeam, assistNumber)
      if (assistId) bump(kind === 'pp' ? ppAssists : shAssists, assistId)
    }
  }

  const specialTeamsPlayerIds = new Set([...ppGoals.keys(), ...shGoals.keys(), ...ppAssists.keys(), ...shAssists.keys(), ...(gwgPlayerId ? [gwgPlayerId] : [])])
  for (const playerId of specialTeamsPlayerIds) {
    mergePlayerStat(game.playerStats, playerId, {
      powerplayGoals: ppGoals.get(playerId) ?? null,
      shorthandedGoals: shGoals.get(playerId) ?? null,
      powerplayAssists: ppAssists.get(playerId) ?? null,
      shorthandedAssists: shAssists.get(playerId) ?? null,
      gameWinningGoals: playerId === gwgPlayerId ? 1 : null,
    })
  }

  game.nlDetailSyncedAt = new Date().toISOString()
  log && log(`  ✓ ${game.id}: ${matched} Spieler ergänzt (${unmatched} ohne Roster-Treffer), ${shotsHome.length + shotsAway.length} Schüsse, GWG ${gwg ? (gwg.playerFirstName + ' ' + gwg.playerLastName) : 'n/a (unentschieden unmöglich/SO)'}.`)
  return { matched, unmatched, shots: shotsHome.length + shotsAway.length }
}

// ============================================================================
// ORCHESTRIERUNG
// ============================================================================

function readDb() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')) }
function writeDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)) }

// Kandidaten: lokal `status:'final'`, `externalId` gesetzt (== NL-API-
// gameId, von server/sync.js gepflegt), noch KEIN `nlDetailSyncedAt`
// (Einmaligkeit, siehe Kommentar oben).
function findCandidates(db, limit) {
  return db.games
    .filter((g) => g.status === 'final' && g.externalId && !g.nlDetailSyncedAt)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) // älteste zuerst - stabile, nachvollziehbare Reihenfolge
    .slice(0, limit)
}

// `limit`: siehe DEFAULT_PER_RUN_LIMIT. `write=false` (Dry-Run) mutiert die
// eingelesene db NICHT auf Platte, berechnet aber alles (für Tests/Debug-
// Output, siehe Punkt 14 im Auftrag).
export async function runNlGameDetailSync({ write = true, log = () => {}, limit = DEFAULT_PER_RUN_LIMIT } = {}) {
  const db = readDb()
  const candidates = findCandidates(db, limit)
  if (candidates.length === 0) {
    log('[NL GAME DETAIL] Keine neuen Spiele zu synchronisieren.')
    return { checked: 0, updated: 0, errors: 0 }
  }
  log(`[NL GAME DETAIL] ${candidates.length} Spiel(e) ohne Detail-Daten gefunden (Limit ${limit}/Lauf)...`)

  let updated = 0, errors = 0
  for (const game of candidates) {
    let raw
    try {
      raw = await fetchGameDetail(game.externalId, { log })
    } catch (e) {
      errors++
      log(`  ✗ ${game.id}: Abruf fehlgeschlagen (${e.message}) - übersprungen, bestehende Daten unverändert.`)
      continue
    }
    if (!raw || !raw.overview || raw.overview.status !== 'finished') {
      log(`  … ${game.id}: bei der NL-API (noch) nicht als beendet markiert - übersprungen.`)
      continue
    }
    try {
      parseAndMergeGameDetail(db, game, raw, log)
      updated++
    } catch (e) {
      errors++
      log(`  ✗ ${game.id}: Verarbeitung fehlgeschlagen (${e.message}) - übersprungen, bestehende Daten unverändert.`)
    }
    await sleep(200) // sanftes Tempo, respektiert die 10-Min-Cache-Politik der API (siehe server/sync.js)
  }

  if (write && updated > 0) writeDb(db)
  log(`[NL GAME DETAIL] Fertig: ${updated} Spiel(e) ergänzt, ${errors} Fehler.`)
  return { checked: candidates.length, updated, errors }
}

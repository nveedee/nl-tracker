#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SIHF-Sync: hält den bestehenden Spielplan (server/data/db.json) mit den
// offiziellen SIHF-Daten synchron.
//
// Nutzt AUSSCHLIESSLICH die bereits vorgegebene, offizielle SIHF-API:
//   GET https://data.sihf.ch/statistic/api/cms/gameoverview
//       ?alias=gameDetail&searchQuery={gameId}&language=de
// Kein Scraping, keine anderen/undokumentierten Endpunkte.
//
// WICHTIG - Sicherheitsprinzipien:
//   - Matched Spiele AUSSCHLIESSLICH über die lokale game.id (nie neue Spiele
//     anlegen, nie Duplikate).
//   - Schreibt NUR, wenn sich die relevanten Felder tatsächlich geändert
//     haben (Idempotenz).
//   - Ein Spiel wird lokal erst `status: 'final'`, wenn SIHF es als beendet
//     meldet (status.percent === 100, status.name === 'Ende', nicht
//     abgesagt). Solange ein Spiel läuft ("live"), wird NICHTS in die
//     produktiv genutzten Felder (homeGoals/awayGoals/decision/status)
//     geschrieben - nur geloggt. So kann nie ein Zwischenstand fälschlich als
//     Endresultat in ELO/Tabelle/Playoff-Odds einfliessen.
//   - Rührt NIE server/data/historical/*.json an.
//   - Erweitert bestehende Spiel-Objekte nur additiv (neue, optionale Felder
//     wie `sihfGameId`, `periods`, `shots`, `teamStats`) - bestehende Felder
//     (id, date, time, homeTeamId, awayTeamId, status, homeGoals, awayGoals,
//     decision, playerStats) bleiben in Form und Bedeutung unverändert.
//
// Modi:
//   node server/scripts/sync-sihf.cjs                 (= --dry-run, sicherer Default)
//   node server/scripts/sync-sihf.cjs --dry-run        zeigt nur an, schreibt nichts
//   node server/scripts/sync-sihf.cjs --write           schreibt Änderungen tatsächlich
//   node server/scripts/sync-sihf.cjs --discover        einmaliger Abgleich: ordnet allen
//                                                        lokalen Spielen ihre SIHF-gameId zu
//                                                        (siehe "SIHF-gameId-Erkennung" unten)
//   node server/scripts/sync-sihf.cjs --discover --write speichert die gefundene Zuordnung
//
// SIHF-gameId-Erkennung:
//   Die lokalen Spiele (server/data/db.json) haben aktuell KEINE SIHF-gameId
//   (nur eine synthetische lokale id wie "game_2026-09-15_ajo_apk"). SIHFs
//   gameId folgt einem bekannten, bereits im historischen Import
//   dokumentierten Schema: {Saisonendjahr}1105{6-stellige laufende Nummer},
//   z.B. 20271105000001 für Saison 2026/27, Spiel 1. Der --discover-Modus
//   fragt diese Nummern sequenziell ab, vergleicht Datum + Heim-/Auswärtsteam
//   (über die unten stehende sihfId->Team-Zuordnung) mit dem lokalen
//   Spielplan und speichert nur BESTÄTIGTE Treffer als `sihfGameId` auf dem
//   jeweiligen lokalen Spiel. Kein Treffer = keine Zuordnung, keine Änderung.
//   Nach einmaligem --discover verwenden alle weiteren Syncs die
//   gespeicherte `sihfGameId` direkt (kein erneutes Suchen nötig).
// ---------------------------------------------------------------------------

'use strict'

const fs = require('fs')
const path = require('path')
const https = require('https')

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json')
const STATUS_PATH = path.join(__dirname, '..', 'data', 'sihf-sync-status.json')

const SIHF_BASE = 'https://data.sihf.ch/statistic/api/cms/gameoverview'

// sihfId (SIHF-interne Team-ID) -> produktive Team-ID (server/data/db.json).
// Identische, bereits validierte Tabelle wie in
// server/scripts/generate-historical-h2h.js (bewusst dupliziert, siehe dort).
const SIHF_TO_TEAM_ID = {
  103144: 'team_ajo', 101152: 'team_apk', 102126: 'team_scb', 102128: 'team_bie',
  101151: 'team_dav', 103138: 'team_fri', 103140: 'team_gse', 101149: 'team_klo',
  102127: 'team_scl', 103141: 'team_lau', 101150: 'team_lug', 101060: 'team_rap',
  101144: 'team_zug', 101139: 'team_zsc',
}

// Wie viele Tage in die Vergangenheit/Zukunft ein regulärer Sync-Lauf prüft
// (siehe Kommentar oben: "nicht bei jedem Poll alle Spiele abrufen").
const CHECK_WINDOW_PAST_DAYS = 2
const CHECK_WINDOW_FUTURE_DAYS = 3

// ============================================================================
// HTTP: Timeout, Retry, Rate-Limit-Beachtung
// ============================================================================

function httpGetJson(url, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'nl-tracker-sync/1.0' } }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => {
        const rateLimit = {
          limit: Number(res.headers['x-ratelimit-limit']) || null,
          remaining: res.headers['x-ratelimit-remaining'] != null ? Number(res.headers['x-ratelimit-remaining']) : null,
          resetSeconds: res.headers['x-ratelimit-reset'] != null ? Number(res.headers['x-ratelimit-reset']) : null,
        }
        if (res.statusCode === 404) return resolve({ status: 404, json: null, rateLimit })
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode, rateLimit }))
        }
        try {
          resolve({ status: res.statusCode, json: JSON.parse(body), rateLimit })
        } catch (e) {
          reject(new Error('Ungültiges JSON von SIHF: ' + e.message))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`Timeout nach ${timeoutMs}ms`)) })
  })
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

// Holt ein Spiel per gameId, mit Retry bei temporären Fehlern (Timeout, 5xx,
// Netzwerkfehler) und Pause, falls das Rate-Limit fast ausgeschöpft ist.
// 404 ist KEIN Fehler (Spiel existiert bei SIHF noch nicht) -> { status:404 }.
async function fetchSihfGame(gameId, { retries = 2, log } = {}) {
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = `${SIHF_BASE}?alias=gameDetail&searchQuery=${encodeURIComponent(gameId)}&language=de`
      const res = await httpGetJson(url)
      if (res.rateLimit.remaining != null && res.rateLimit.remaining < 5) {
        const wait = Math.min(30, (res.rateLimit.resetSeconds || 5) + 1)
        log && log(`  ⏳ Rate-Limit fast erreicht (${res.rateLimit.remaining} übrig) - warte ${wait}s…`)
        await sleep(wait * 1000)
      }
      return res
    } catch (e) {
      lastErr = e
      if (attempt < retries) {
        const backoff = 500 * Math.pow(2, attempt)
        log && log(`  ⚠ Fehler beim Abruf von ${gameId} (Versuch ${attempt + 1}/${retries + 1}): ${e.message} - erneuter Versuch in ${backoff}ms`)
        await sleep(backoff)
      }
    }
  }
  throw lastErr
}

// ============================================================================
// Parsing: rohe SIHF-Antwort -> Felder für unser lokales Spiel-Schema
// ============================================================================

// Zip von header[].alias + data[] (positional) -> benanntes Objekt.
// Exakt dasselbe Prinzip wie die bereits im Projekt verwendeten
// (vorverarbeiteten) historischen SIHF-Daten - SIHF liefert Tabellen roh so.
function zipRow(header, row) {
  const obj = {}
  header.forEach((h, i) => { obj[h.alias] = row[i] })
  return obj
}

function determineLocalStatus(sihfStatus) {
  if (!sihfStatus) return { local: 'scheduled', label: 'unbekannt' }
  if (sihfStatus.canceled) return { local: 'scheduled', label: 'abgesagt' }
  if (sihfStatus.percent === 100 && sihfStatus.name === 'Ende') return { local: 'final', label: 'final' }
  if (sihfStatus.percent > 0) return { local: 'scheduled', label: 'live' } // Zwischenstand NIE als final übernehmen
  return { local: 'scheduled', label: 'geplant' }
}

// Ermittelt Heim-/Auswärts-Team-Zuordnung eines Stats-Blocks über die
// Spieler-Team-Zugehörigkeit aus raw.players[] (robuster als sich auf die
// Reihenfolge der stats[]-Tabellen zu verlassen).
function resolveBlockTeamId(rows, sihfPlayers) {
  for (const row of rows) {
    const match = sihfPlayers.find((p) => p.fullName === row.player)
    if (match) return match.teamId
  }
  return null
}

// SIHF liefert Namen als "Nachname Vorname"; unsere lokalen Spieler als
// "Vorname Nachname". Wortmenge (sortiert, klein geschrieben) macht den
// Vergleich reihenfolge-unabhängig, ohne etwas zu erfinden - kein Treffer
// wird einfach übersprungen (mit Logging), nie geraten.
function normalizeName(name) {
  return (name || '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ')
}
function matchLocalPlayer(sihfName, teamId, localPlayers) {
  const norm = normalizeName(sihfName)
  return localPlayers.find((p) => p.teamId === teamId && normalizeName(p.name) === norm) || null
}

// Ordnet einen SIHF-Boxscore-Eintrag primär über die SIHF-Spieler-ID einem
// lokalen Spieler zu (raw.players[].id) - das ist DIESELBE numerische
// Spieler-ID wie player.externalId aus dem NL-API-Sync (server/sync.js:
// nationalleague.ch und SIHF teilen erwiesenermassen dieselbe Spieler- UND
// Team-ID-Basis, siehe SIHF_TO_TEAM_ID oben und der Verifikation im
// Erkundungsbericht). Bewusst OHNE Team-Einschränkung gesucht: ein Spieler
// kann kurzfristig für ein anderes Team auflaufen als sein zuletzt
// synchronisiertes player.teamId (z.B. Testspiel-Einsatz/Transfer während der
// Vorbereitung, live an einem echten Spiel beobachtet) - die Boxscore-
// Zuordnung bleibt trotzdem korrekt. player.teamId selbst wird davon NICHT
// verändert, das bleibt ausschliesslich Aufgabe des NL-API-Team-Syncs.
// Fallback (kein externalId-Treffer, z.B. Spieler noch nicht NL-API-
// verknüpft): bestehende, team-gebundene Name-Zuordnung.
function resolveLocalPlayer(sihfPlayerId, sihfName, teamId, localPlayers) {
  if (sihfPlayerId != null) {
    const byExternalId = localPlayers.find((p) => p.externalId === String(sihfPlayerId))
    if (byExternalId) return byExternalId
  }
  return matchLocalPlayer(sihfName, teamId, localPlayers)
}

// "MM:SS" -> Sekunden. Identisches Format/Prinzip wie in
// server/scripts/generate-player-history.js (historischer Import) - SIHF
// liefert TOI im Live-Player-Stats-Table im selben "MM:SS"-Format.
function toSeconds(mmss) {
  if (!mmss || mmss === '-') return 0
  const [m, s] = String(mmss).split(':').map(Number)
  return (Number.isFinite(m) ? m : 0) * 60 + (Number.isFinite(s) ? s : 0)
}

function parseSihfGame(raw, localPlayers) {
  const statusInfo = determineLocalStatus(raw.status)
  const homeSihfTeamId = raw.details && raw.details.homeTeam && raw.details.homeTeam.id
  const awaySihfTeamId = raw.details && raw.details.awayTeam && raw.details.awayTeam.id
  const homeTeamId = SIHF_TO_TEAM_ID[homeSihfTeamId]
  const awayTeamId = SIHF_TO_TEAM_ID[awaySihfTeamId]

  const result = { statusInfo, homeTeamId, awayTeamId, startDateTime: raw.startDateTime }

  if (statusInfo.local !== 'final') return result // während "live"/"geplant" keine Resultatfelder befüllen

  const scores = (raw.result && raw.result.scores) || []
  const sogs = (raw.result && raw.result.sogs) || []
  const homeGoals = Number(raw.result && raw.result.homeTeam)
  const awayGoals = Number(raw.result && raw.result.awayTeam)

  // Entscheidung: >3 Perioden = OT/SO. Shootout-Einträge (falls von SIHF
  // geliefert) unterscheiden SO von reinem OT. Die exakte Feldform für
  // Shootout-Einzelschüsse ist an einem echten SO-Spiel dieser Saison noch zu
  // verifizieren (siehe Bericht) - hier defensiv mehrere bekannte
  // Feldnamen-Varianten geprüft, mit Fallback auf die Perioden-Anzahl.
  const shootoutBlock = raw.summary && raw.summary.shootout
  const shootoutEntries = (shootoutBlock && (shootoutBlock.entries || shootoutBlock.attempts || shootoutBlock.rounds)) || []
  let decision = 'REG'
  if (shootoutEntries.length > 0) decision = 'SO'
  else if (scores.length > 3) decision = 'OT'

  const periods = scores.map((s) => ({ name: s.name, indicator: s.indicator, home: Number(s.homeTeam), away: Number(s.awayTeam) }))
  const shots = sogs.map((s) => ({ name: s.name, indicator: s.indicator, home: Number(s.homeTeam), away: Number(s.awayTeam) }))

  // Team-Statistiken (PP%, Faceoffs, SOG etc.)
  const teamStatsTable = (raw.stats || []).find((s) => s.title === 'Team Stats')
  const teamStats = {}
  if (teamStatsTable && teamStatsTable.data) {
    // Spalten sind ["Statistic", homeTeamName, awayTeamName] - Reihenfolge über Team-Namen bestätigen, sonst Fallback [1]=home,[2]=away
    const homeName = raw.details.homeTeam && raw.details.homeTeam.name
    const idxHome = teamStatsTable.header.findIndex((h) => h.name === homeName)
    const iHome = idxHome > 0 ? idxHome : 1
    const iAway = iHome === 1 ? 2 : 1
    for (const row of teamStatsTable.data) {
      teamStats[row[0]] = { home: row[iHome], away: row[iAway] }
    }
  }

  // Spieler-/Torhüterstatistiken: 4 Tabellen (Player+Goalie je Team), Team
  // pro Block über raw.players[] ermittelt (nicht über Array-Reihenfolge).
  const sihfPlayers = raw.players || []
  const sihfPlayerByName = new Map(sihfPlayers.map((p) => [p.fullName, p]))
  const winningTeamId = homeGoals > awayGoals ? homeTeamId : awayTeamId
  const playerStats = []
  const unmatched = []
  for (const table of raw.stats || []) {
    if (table.title !== 'Player Stats' && table.title !== 'Goalie Stats') continue
    // "Total"-Summenzeile (SIHF hängt sie ans Tabellenende) ist kein Spieler - ausfiltern.
    const rows = (table.data || []).map((r) => zipRow(table.header, r)).filter((row) => row.player && row.player !== 'Total')
    const blockTeamSihfId = resolveBlockTeamId(rows, sihfPlayers)
    const blockTeamId = SIHF_TO_TEAM_ID[blockTeamSihfId]
    if (!blockTeamId) continue
    // Sieg/Niederlage-Entscheidung nur zuweisen, wenn EINDEUTIG: genau ein
    // Torhüter dieses Teams hat Einsatzzeit > 0 (kein Torhüterwechsel im
    // Spiel) - dann entscheidet das Endresultat. Bei mehreren eingesetzten
    // Torhütern (z.B. gezogener Torhüter) ist die offizielle Entscheidung
    // ohne periodengenaue Netzminder-Daten nicht zuverlässig ableitbar -
    // dann bleibt decision:null für alle Torhüter dieses Blocks (nicht
    // geraten, siehe Kommentar bei resolveLocalPlayer oben).
    const playedGoalieRows = table.title === 'Goalie Stats' ? rows.filter((r) => toSeconds(r.secondsPlayed) > 0) : []
    const unambiguousDecision = playedGoalieRows.length === 1 ? (blockTeamId === winningTeamId ? 'W' : 'L') : null
    for (const row of rows) {
      const sihfId = sihfPlayerByName.get(row.player)?.id
      const localPlayer = resolveLocalPlayer(sihfId, row.player, blockTeamId, localPlayers)
      if (!localPlayer) { unmatched.push(row.player); continue }
      if (table.title === 'Player Stats') {
        playerStats.push({
          playerId: localPlayer.id,
          goals: Number(row.goals) || 0,
          assists: Number(row.assists) || 0,
          plusMinus: Number(row.plusMinus) || 0,
          pim: Number(row.pimTotal) || 0,
          // Additiv (Player Tracker/laufende-Saison-Kennzahlen, siehe
          // src/stats.js::computePlayerStats): SIHF liefert diese Felder in
          // derselben "Player Stats"-Tabelle (Aliase `shotsOnGoal`/
          // `timeOnIce`), live verifiziert an einem echten abgeschlossenen
          // Spiel. Nicht Teil des bisherigen Schemas, rein additiv.
          sog: Number(row.shotsOnGoal) || 0,
          toiSec: toSeconds(row.timeOnIce),
        })
      } else {
        const played = toSeconds(row.secondsPlayed) > 0
        playerStats.push({
          playerId: localPlayer.id,
          goalsAgainst: Number(row.goalsAgainst) || 0,
          saves: Number(row.saves) || 0,
          decision: played ? unambiguousDecision : null,
          shutout: Number(row.goalsAgainst) === 0 && Number(row.shotsAgainst) > 0,
          pim: Number(row.penaltyInMinutes) || 0,
        })
      }
    }
  }

  // Strafen (aus summary.periods[].fouls[])
  const penalties = []
  for (const p of (raw.summary && raw.summary.periods) || []) {
    for (const f of p.fouls || []) {
      penalties.push({ period: p.name, time: f.time, minutes: f.minutes, teamSihfId: f.teamId, text: f.text })
    }
  }

  return {
    ...result,
    homeGoals, awayGoals, decision,
    periods, shots, teamStats, playerStats, penalties,
    unmatchedPlayers: unmatched,
  }
}

// ============================================================================
// DB-Helfer (eigenständig, dieses Skript läuft als .cjs unabhängig vom
// ESM-Server, liest/schreibt aber dieselbe server/data/db.json)
// ============================================================================

function readDb() { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')) }
function writeDb(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)) }

function readSyncStatus() {
  try { return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf-8')) } catch { return null }
}
function writeSyncStatus(status) { fs.writeFileSync(STATUS_PATH, JSON.stringify(status, null, 2)) }

// ============================================================================
// Diff / Idempotenz
// ============================================================================

// Vergleicht nur die Felder, die der Sync tatsächlich setzt - unberührt
// bleibt z.B. playerStats-Einträge, die der Sync mangels Namensmatch gar
// nicht erzeugt hat.
function computeGameUpdate(existing, parsed) {
  if (parsed.statusInfo.local !== 'final') {
    return { changed: false, patch: null, note: parsed.statusInfo.label }
  }
  const patch = {
    status: 'final',
    homeGoals: parsed.homeGoals,
    awayGoals: parsed.awayGoals,
    decision: parsed.decision,
    sihfPeriods: parsed.periods,
    sihfShots: parsed.shots,
    sihfTeamStats: parsed.teamStats,
    playerStats: parsed.playerStats.length > 0 ? parsed.playerStats : (existing.playerStats || []),
  }
  const relevantExisting = {
    status: existing.status, homeGoals: existing.homeGoals, awayGoals: existing.awayGoals, decision: existing.decision,
    sihfPeriods: existing.sihfPeriods, sihfShots: existing.sihfShots, sihfTeamStats: existing.sihfTeamStats,
    playerStats: existing.playerStats,
  }
  const changed = JSON.stringify(relevantExisting) !== JSON.stringify(patch)
  return { changed, patch, note: changed ? 'FINAL' : 'unverändert' }
}

// ============================================================================
// Discovery: lokale Spiele <-> SIHF-gameId zuordnen
// ============================================================================

async function runDiscover({ write, log, maxSeq = 450, seasonEndYear }) {
  const db = readDb()
  const unresolved = db.games.filter((g) => !g.sihfGameId)
  if (unresolved.length === 0) { log('Alle Spiele haben bereits eine sihfGameId.'); return { matched: 0, checked: 0 } }

  log(`Suche SIHF-gameId für ${unresolved.length} Spiele (Präfix ${seasonEndYear}1105, bis Sequenz ${maxSeq})…`)
  let matched = 0, checked = 0, consecutive404 = 0
  for (let seq = 1; seq <= maxSeq; seq++) {
    const gameId = `${seasonEndYear}1105${String(seq).padStart(6, '0')}`
    let res
    try {
      res = await fetchSihfGame(gameId, { log })
    } catch (e) {
      log(`  ✗ ${gameId}: ${e.message}`)
      continue
    }
    checked++
    if (res.status === 404 || !res.json || !res.json.details) {
      consecutive404++
      if (consecutive404 >= 15) { log(`  → 15x in Folge nicht gefunden, breche Discovery ab (Sequenz ${seq}).`); break }
      continue
    }
    consecutive404 = 0
    const raw = res.json
    const homeSihfTeamId = raw.details.homeTeam && raw.details.homeTeam.id
    const awaySihfTeamId = raw.details.awayTeam && raw.details.awayTeam.id
    const homeTeamId = SIHF_TO_TEAM_ID[homeSihfTeamId]
    const awayTeamId = SIHF_TO_TEAM_ID[awaySihfTeamId]
    const sihfDate = (raw.startDateTime || '').slice(0, 10)
    const local = unresolved.find((g) => !g.sihfGameId && g.date === sihfDate && g.homeTeamId === homeTeamId && g.awayTeamId === awayTeamId)
    if (local) {
      local.sihfGameId = gameId
      matched++
      log(`  ✓ ${gameId} -> ${local.id} (${sihfDate} ${homeTeamId} - ${awayTeamId})`)
    }
    await sleep(120) // sanft, respektiert Rate-Limit (240/min laut Header)
  }
  if (write) { writeDb(db) } else { log('(--dry-run: Zuordnung NICHT gespeichert)') }
  log(`Discovery fertig: ${matched}/${checked} geprüfte Spiele zugeordnet.`)
  return { matched, checked }
}

// ============================================================================
// Regulärer Sync
// ============================================================================

function inCheckWindow(game, now) {
  const d = new Date(game.date)
  const past = new Date(now); past.setDate(past.getDate() - CHECK_WINDOW_PAST_DAYS)
  const future = new Date(now); future.setDate(future.getDate() + CHECK_WINDOW_FUTURE_DAYS)
  return d >= new Date(past.toDateString()) && d <= new Date(future.toDateString())
}

async function runSync({ write, log, now = new Date() }) {
  const db = readDb()
  const candidates = db.games.filter((g) => g.sihfGameId && inCheckWindow(g, now))

  log(`Prüfe ${candidates.length} Spiele...`)
  let updated = 0, unchanged = 0, errors = 0, duplicates = 0
  const seenIds = new Set()

  for (const g of candidates) {
    if (seenIds.has(g.id)) { duplicates++; continue }
    seenIds.add(g.id)

    const label = `${g.homeTeamId} – ${g.awayTeamId}`
    let res
    try {
      res = await fetchSihfGame(g.sihfGameId, { log })
    } catch (e) {
      errors++
      log(`✗ ${label}: Fehler (${e.message})`)
      continue
    }
    if (res.status === 404) { log(`… ${label}: bei SIHF noch nicht verfügbar`); continue }

    const parsed = parseSihfGame(res.json, db.players)
    if (parsed.statusInfo.local !== 'final') {
      log(`✓ ${label}: ${parsed.statusInfo.label}`)
      unchanged++
      continue
    }

    const { changed, patch, note } = computeGameUpdate(g, parsed)
    if (!changed) {
      log(`✓ ${label}: unverändert`)
      unchanged++
      continue
    }

    if (write) Object.assign(g, patch)
    updated++
    log(`✓ ${label}: FINAL ${parsed.homeGoals}:${parsed.awayGoals}${parsed.decision !== 'REG' ? ' (' + parsed.decision + ')' : ''} ${write ? 'importiert' : '(würde importiert)'}`)
    if (parsed.unmatchedPlayers.length > 0) {
      log(`   ⚠ ${parsed.unmatchedPlayers.length} Spieler ohne lokalen Roster-Treffer (übersprungen, nichts erfunden): ${parsed.unmatchedPlayers.slice(0, 5).join(', ')}${parsed.unmatchedPlayers.length > 5 ? '…' : ''}`)
    }
  }

  // Pre-Game Prediction Snapshots: läuft NACH dem Games-Update-Schritt oben,
  // damit ein Spiel, das in diesem selben Sync-Lauf gerade final geworden
  // ist, hier bereits korrekt `status: 'final'` trägt und NICHT nachträglich
  // einen Snapshot bekommt. dynamischer import(), da predictions.js ein
  // ESM-Modul ist (muss aus src/*.js importieren) und dieses Skript CommonJS
  // ist - siehe server/scripts/predictions.js für Details.
  const { ensurePredictionSnapshots } = await import('./predictions.js')
  const predictionSummary = ensurePredictionSnapshots(db, { log })

  if (write && (updated > 0 || predictionSummary.created > 0)) writeDb(db)

  const summary = {
    checked: candidates.length, updated, unchanged, duplicates, errors,
    predictionsCreated: predictionSummary.created,
  }
  log(`→ ${updated} Spiel${updated === 1 ? '' : 'e'} aktualisiert`)
  log(`→ ${duplicates} Duplikate`)
  log(`→ ${errors} Fehler`)
  log(`→ ${predictionSummary.created} neue Prediction-Snapshot${predictionSummary.created === 1 ? '' : 's'}${write ? '' : ' (würden erstellt)'}`)

  if (write) {
    writeSyncStatus({ lastRunAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString(), ...summary })
  }
  return summary
}

// ============================================================================
// CLI
// ============================================================================

async function main() {
  const args = process.argv.slice(2)
  const write = args.includes('--write')
  const discover = args.includes('--discover')
  const log = (...a) => console.log(...a)

  log('[SIHF SYNC]' + (write ? '' : ' (DRY RUN - es wird nichts geschrieben)'))

  try {
    if (discover) {
      const db = readDb()
      const seasonEndYear = new Date().getMonth() >= 6 ? new Date().getFullYear() + 1 : new Date().getFullYear()
      await runDiscover({ write, log, seasonEndYear })
    } else {
      await runSync({ write, log })
    }
  } catch (e) {
    console.error('[SIHF SYNC] Abbruch wegen Fehler:', e.message)
    process.exitCode = 1
  }
}

module.exports = { runSync, runDiscover, parseSihfGame, computeGameUpdate, fetchSihfGame, SIHF_TO_TEAM_ID, readSyncStatus }

if (require.main === module) {
  main()
}

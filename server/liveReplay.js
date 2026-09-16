// ---------------------------------------------------------------------------
// DEV-ONLY LIVE-REPLAY - spielt ein bereits abgeschlossenes, archiviertes
// Spiel zeitlich zurück, um den ECHTEN Live-Datenfluss (SIHF-Payload ->
// parseLiveSnapshot() -> liveState -> /api/.../live -> useLiveGame() ->
// Live-UI -> liveProbability.js) ohne ein aktuell laufendes NL-Spiel zu
// testen. KEINE zweite Probability-Engine, KEINE hartkodierten historischen
// Prozentwerte - dieses Modul rekonstruiert AUSSCHLIESSLICH eine SIHF-
// Rohpayload für den gewünschten Zeitpunkt und übergibt sie an die
// UNVERÄNDERTE sihfSync.parseLiveSnapshot() (server/scripts/sync-sihf.cjs).
// Die Wahrscheinlichkeit selbst wird weiterhin ausschliesslich clientseitig
// über liveProbability.js berechnet (siehe src/liveGameClient.js) - exakt
// wie im echten Live-Pfad, keine Änderung an diesem Datenfluss.
//
// Fixture-Auswahl (siehe Bericht): HC Davos - EV Zug, 08.09.2017,
// SIHF-gameId 20181105000001 (server/data/historical/2017-18.json) -
// 4 Regulationstore über 3 Drittel, 13 Strafen, Schüsse pro Drittel,
// Overtime + 9 Shootout-Versuche (Endergebnis 2:3 n.P.). Einziges Spiel im
// Archiv, das beim Prüfen ALLE geforderten Testpunkte (Tore, Strafen,
// Periodenwechsel, OT, SO) in einem einzigen Spiel abdeckt.
//
// Nur zum Testen/Debugging - siehe server/index.js: die Route wird nur
// registriert, wenn NODE_ENV !== 'production' (existiert im Produktions-
// Build gar nicht, kein Laufzeit-Flag nötig).
// ---------------------------------------------------------------------------

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import sihfSync from './scripts/sync-sihf.cjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_FILE = path.join(__dirname, 'data', 'historical', '2017-18.json')
const FIXTURE_GAME_ID = '20181105000001'

let cachedFixture = null
function loadFixture() {
  if (cachedFixture) return cachedFixture
  const raw = JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf-8'))
  const game = raw.games.find((g) => g.gameId === FIXTURE_GAME_ID)
  if (!game) throw new Error(`Replay-Fixture ${FIXTURE_GAME_ID} nicht im Archiv gefunden`)
  cachedFixture = game
  return game
}

function toMinutes(mmss) {
  const [m, s] = String(mmss).split(':').map(Number)
  return (Number.isFinite(m) ? m : 0) + (Number.isFinite(s) ? s / 60 : 0)
}

// REG-Perioden enden fix bei 20/40/60' - eine Perioden-ZEILE aus
// result.scores/sogs wird erst sichtbar, sobald ihre Endzeit erreicht ist
// (verhindert, dass ein Replay-Zeitpunkt MITTEN in Drittel 1 bereits das
// (dann noch unbekannte) Endresultat von Drittel 1 verrät). Die OT/Shootout-
// Zeile wird erst am tatsächlichen Spielende sichtbar (deren reale Dauer ist
// nicht separat bekannt - die einzige vorhandene Zeitangabe dafür ist die
// Marker-Zeit des SO-Toreintrags selbst, siehe unten).
function periodEndMinutes(indicator, lastEventMinuteInPeriod) {
  if (indicator === '1') return 20
  if (indicator === '2') return 40
  if (indicator === '3') return 60
  return Math.max(60, lastEventMinuteInPeriod ?? 60) // OT/Shootout
}

// Baut aus dem archivierten (bereits leicht normalisierten) Spiel eine
// SIHF-gameoverview-RAW-Payload für den Zustand "bis zu elapsedMinutes" -
// exakt die Rohform, die sihfSync.parseLiveSnapshot() von einem echten
// Live-Request erwartet (raw.status/details/result/summary), siehe
// LIVE_PROBABILITY_ANALYSIS.md Abschnitt 16 für die verifizierten Felder.
function buildRawPayloadAt(game, elapsedMinutes) {
  const revealedGoalsByPeriod = game.events.map((p) => (p.goals || []).filter((g) => toMinutes(g.time) <= elapsedMinutes))

  const periodRevealed = game.periods.map((p, i) => {
    const eventsInPeriod = game.events[i]
    const lastGoalMinute = Math.max(0, ...(eventsInPeriod?.goals || []).map((g) => toMinutes(g.time)))
    const end = periodEndMinutes(p.indicator, lastGoalMinute)
    return elapsedMinutes >= end
  })

  const scores = game.periods.filter((_, i) => periodRevealed[i]).map((p) => ({ name: p.name, indicator: p.indicator, homeTeam: String(p.home), awayTeam: String(p.away) }))
  const sogs = (game.shots || []).filter((_, i) => periodRevealed[i]).map((s) => ({ name: s.name, indicator: s.indicator, homeTeam: String(s.home), awayTeam: String(s.away) }))

  // "Final" wird nur EXPLIZIT über einen elapsedMinutes-Wert >= dem
  // tatsächlichen Spielende (letzte bekannte Periode vollständig + Shootout
  // entschieden) signalisiert - siehe isReplayFinal() unten, vom Aufrufer
  // (server/index.js) VOR dem Payload-Bau geprüft, um status:'Ende' bewusst
  // zu setzen (parseLiveSnapshot() verlangt genau diese Kombination).
  const allPeriodsRevealed = periodRevealed.every(Boolean)
  const shootoutDecided = game.decision === 'SO' && allPeriodsRevealed
  const isFinalNow = allPeriodsRevealed && (game.decision !== 'SO' || shootoutDecided)

  return {
    status: {
      percent: isFinalNow ? 100 : Math.min(99, Math.round((elapsedMinutes / 60) * 100)),
      // Zwischen 60' und dem SO-Marker-Zeitpunkt (siehe periodEndMinutes()
      // oben) ist aus den Rohdaten nicht unterscheidbar, ob "echte" Overtime
      // oder bereits Penaltyschiessen läuft (keine separaten SO-Zeitstempel
      // im Archiv, siehe Dateikopf) - bewusst konservativ als "Overtime"
      // gelabelt, bis der tatsächliche SO-Ausgang sichtbar wird.
      name: isFinalNow ? 'Ende' : elapsedMinutes >= 60 ? 'Overtime' : `${Math.min(3, Math.floor(elapsedMinutes / 20) + 1)}. Drittel`,
      canceled: false,
    },
    details: {
      homeTeam: { id: game.homeTeam.sihfId, name: game.homeTeam.name, acronym: game.homeTeam.acronym },
      awayTeam: { id: game.awayTeam.sihfId, name: game.awayTeam.name, acronym: game.awayTeam.acronym },
    },
    // homeTeam/awayTeam (Gesamtscore) bewusst WEGGELASSEN statt '' - Number('')
    // ist 0 (fälschlich "gültig"), Number(undefined) ist NaN und lässt
    // parseLiveSnapshot() korrekt auf das Zählen der (bereits gefilterten)
    // Goal-Events zurückfallen, exakt wie beim echten Live-Fetch, falls SIHF
    // das Feld während des Spiels nicht befüllt.
    result: { scores, sogs },
    summary: {
      periods: game.events.map((p, i) => ({ name: p.name, goals: revealedGoalsByPeriod[i], fouls: (p.fouls || []).filter((f) => toMinutes(f.time) <= elapsedMinutes) })),
      shootout: isFinalNow && game.shootout ? { shoots: game.shootout } : { shoots: [] },
    },
    stats: [], // Team-Stats-Tabelle bewusst nicht rekonstruiert (siehe MatchupDetail.jsx-Kommentar zu LiveStatistics: SIHF-Row-Labels nicht verifiziert)
  }
}

// Öffentliche API für server/index.js: liefert denselben liveState wie ein
// echter Live-Fetch, zusätzlich mit `replay:true` + Fixture-Metadaten
// markiert (additiv, verändert die von parseLiveSnapshot() gelieferten
// Felder nicht).
export function buildReplayLiveState(elapsedSeconds) {
  const game = loadFixture()
  const elapsedMinutes = Math.max(0, Number(elapsedSeconds) || 0) / 60
  const raw = buildRawPayloadAt(game, elapsedMinutes)
  const liveState = sihfSync.parseLiveSnapshot(raw)
  return {
    ...liveState,
    replay: true,
    replaySourceGameId: FIXTURE_GAME_ID,
    replaySourceLabel: `${game.homeTeam.acronym} - ${game.awayTeam.acronym}, ${game.date} (historisches Archiv-Spiel)`,
    replayElapsedSeconds: Math.round(elapsedMinutes * 60),
  }
}

// ============================================================================
// HISTORISCHER LIVE-REPLAY FÜR ECHTE, ABGESCHLOSSENE DB-SPIELE (produktives
// Feature, siehe status:'final' -> "Spielverlauf anzeigen" in
// MatchupDetail.jsx) - GENERISCH für jedes Spiel mit `sihfGameId`, KEINE
// Hardcodierung eines einzelnen Matchups. Nutzt exakt dieselbe
// buildRawPayloadAt()/periodEndMinutes()-Zeitfenster-Logik wie das
// Dev-Fixture oben (identisches "GameRecord"-Zwischenformat: homeTeam/
// awayTeam/periods/shots/shootout/events - normalizeSihfRawToGameRecord()
// unten baut es aus einer frisch von SIHF geholten Rohantwort statt aus dem
// Archiv-JSON). Fällt NIE auf erfundene Daten zurück: schlägt der SIHF-Fetch
// fehl oder fehlt sihfGameId, wird ein Fehler geworfen statt etwas zu raten.
// ============================================================================

// Ein abgeschlossenes Spiel ändert sich nicht mehr rückwirkend - die rohe
// SIHF-Antwort wird EINMAL geholt und dauerhaft (Prozesslaufzeit) gecacht,
// damit Scrubben über den Zeitregler im Frontend keinen erneuten SIHF-Request
// pro Positionswechsel auslöst.
const finalRawCache = new Map() // sihfGameId -> raw SIHF-Antwort

async function fetchFinalRaw(sihfGameId, { log } = {}) {
  if (finalRawCache.has(sihfGameId)) return finalRawCache.get(sihfGameId)
  const res = await sihfSync.fetchSihfGame(sihfGameId, { log })
  if (res.status === 404 || !res.json || !res.json.details) {
    throw new Error(`SIHF liefert für ${sihfGameId} keine Daten (404/leer)`)
  }
  finalRawCache.set(sihfGameId, res.json)
  return res.json
}

// Wandelt eine rohe SIHF-gameoverview-Antwort in dasselbe "GameRecord"-
// Zwischenformat wie das Archiv (server/scripts/import-historical-sihf.cjs::
// normalizeGame(), hier bewusst reduziert auf die für den Replay nötigen
// Felder) - `localGame.decision` (bereits vom bestehenden SIHF-Sync
// verifiziert, siehe sync-sihf.cjs::parseSihfGame) wird 1:1 übernommen statt
// hier ein zweites Mal aus scores/shootout hergeleitet.
function normalizeSihfRawToGameRecord(raw, localGame) {
  const scores = (raw.result && raw.result.scores) || []
  const sogs = (raw.result && raw.result.sogs) || []
  return {
    homeTeam: { sihfId: raw.details.homeTeam.id, name: raw.details.homeTeam.name, acronym: raw.details.homeTeam.acronym },
    awayTeam: { sihfId: raw.details.awayTeam.id, name: raw.details.awayTeam.name, acronym: raw.details.awayTeam.acronym },
    decision: localGame.decision,
    date: localGame.date,
    periods: scores.map((s) => ({ name: s.name, indicator: s.indicator, home: Number(s.homeTeam), away: Number(s.awayTeam) })),
    shots: sogs.map((s) => ({ name: s.name, indicator: s.indicator, home: Number(s.homeTeam), away: Number(s.awayTeam) })),
    shootout: (raw.summary && raw.summary.shootout && raw.summary.shootout.shoots) || null,
    events: ((raw.summary && raw.summary.periods) || []).map((p) => ({ name: p.name, goals: p.goals || [], fouls: p.fouls || [] })),
  }
}

// Tatsächliche Spieldauer (Minuten) direkt aus den Daten - Maximum über
// ALLE periodEndMinutes()-Werte (REG-Perioden fix bei 20/40/60, OT/Shootout
// an der letzten bekannten Torzeit dieser Periode, siehe periodEndMinutes()
// oben). Ersetzt den vorherigen willkürlichen 6h-Sentinel (der fälschlich
// als "replayElapsedSeconds" zurückgegeben worden wäre, statt der echten
// Spielendzeit) - KEIN erfundener Wert, ausschliesslich aus game.periods/
// game.events abgeleitet.
function computeGameDurationMinutes(game) {
  let end = 60
  game.periods.forEach((p, i) => {
    const eventsInPeriod = game.events[i]
    const lastGoalMinute = Math.max(0, ...(eventsInPeriod?.goals || []).map((g) => toMinutes(g.time)))
    end = Math.max(end, periodEndMinutes(p.indicator, lastGoalMinute))
  })
  return end
}

// `elapsedSeconds` fehlt/ist grösser als die tatsächliche Spieldauer ->
// vollständiger Endstand (wird jetzt korrekt auf die ECHTE Spieldauer
// gekappt, siehe computeGameDurationMinutes(), nicht mehr auf einen
// willkürlichen Sentinel).
export const FULL_GAME_SENTINEL_SECONDS = 6 * 3600

export async function buildRealGameReplayState(localGame, elapsedSeconds, { log } = {}) {
  if (localGame.status !== 'final') throw new Error(`Spiel ${localGame.id} ist nicht abgeschlossen (status=${localGame.status}) - kein historischer Replay möglich`)
  if (!localGame.sihfGameId) throw new Error(`Spiel ${localGame.id} hat keine sihfGameId - historische SIHF-Daten nicht verknüpft`)

  const raw = await fetchFinalRaw(localGame.sihfGameId, { log })
  const gameRecord = normalizeSihfRawToGameRecord(raw, localGame)
  const durationMinutes = computeGameDurationMinutes(gameRecord)
  const requestedMinutes = Math.max(0, Number(elapsedSeconds) || 0) / 60
  const elapsedMinutes = Math.min(durationMinutes, requestedMinutes)
  const rawWindowed = buildRawPayloadAt(gameRecord, elapsedMinutes)
  const liveState = sihfSync.parseLiveSnapshot(rawWindowed)

  return {
    ...liveState,
    replay: true,
    isHistoricalGameReplay: true,
    replaySourceGameId: localGame.sihfGameId,
    replaySourceLabel: `${gameRecord.homeTeam.acronym} - ${gameRecord.awayTeam.acronym}, ${gameRecord.date} (abgeschlossenes Spiel, historischer Verlauf)`,
    replayElapsedSeconds: Math.round(elapsedMinutes * 60),
    replayDurationSeconds: Math.round(durationMinutes * 60),
  }
}

// ============================================================================
// VOLLSTÄNDIGE ZEITREIHE für die grosse Live-Win-Probability-Kurve
// (Requirement: "ICH WILL DIE KOMPLETTE HISTORISCHE LIVE-PROBABILITY-LINIE",
// nicht nur den am Regler ausgewählten Einzelpunkt). Ruft
// buildRawPayloadAt()/parseLiveSnapshot() MEHRFACH für ein Raster aus
// Sekunden-Zeitpunkten auf (regelmässiges Intervall + exakt an jedem echten
// Tor-Zeitpunkt, siehe unten) - KEINE zweite Engine, nur derselbe
// Einzelpunkt-Aufruf wiederholt für eine dichte Linie. Alle Snapshots kommen
// aus EINEM bereits gecachten SIHF-Fetch (fetchFinalRaw()), das Raster wird
// rein lokal (kein weiterer Netzwerk-Request) berechnet.
// ============================================================================

// Sekunden-Raster für die Kurve (Requirement: "sehr fliessende ... Linien",
// FMD-artige Optik) - 1s-Auflösung kostet auf einem realen 65'-OT-Spiel
// server-seitig ~40-60ms (gemessen, warmer SIHF-Cache) - unproblematisch für
// einen einmaligen Request pro Spielaufruf. NUR die eigentliche Zeitreihe
// wird so dicht berechnet; die vollständigen Ereignisdaten (Tore/Strafen/
// Team-Stats) werden weiterhin bloss EINMAL (siehe `finalState` unten)
// übertragen statt pro Sekunden-Punkt dupliziert (sonst >3MB Payload bei
// 1s-Auflösung für ein 65'-Spiel).
const DEFAULT_STEP_SECONDS = 1

export async function buildRealGameReplayTimeline(localGame, { log, stepSeconds = DEFAULT_STEP_SECONDS } = {}) {
  if (localGame.status !== 'final') throw new Error(`Spiel ${localGame.id} ist nicht abgeschlossen (status=${localGame.status}) - kein historischer Replay möglich`)
  if (!localGame.sihfGameId) throw new Error(`Spiel ${localGame.id} hat keine sihfGameId - historische SIHF-Daten nicht verknüpft`)

  const raw = await fetchFinalRaw(localGame.sihfGameId, { log })
  const gameRecord = normalizeSihfRawToGameRecord(raw, localGame)
  const durationMinutes = computeGameDurationMinutes(gameRecord)
  const durationSeconds = Math.round(durationMinutes * 60)

  // Regelmässiges Raster (Requirement 3: "genügend Zwischenpunkte ...
  // natürliche zeitliche Entwicklung sichtbar") + für JEDES echte Tor
  // zusätzlich die Sekunde davor (letzter Stand vor dem Sprung) und exakt
  // die Torsekunde selbst (Stand danach) - damit die Linie an der echten
  // SIHF-Sekunde springt statt erst beim nächsten Raster-Tick (Requirement 2:
  // "Tore müssen harte Events bleiben").
  const sampleSeconds = new Set()
  for (let s = 0; s <= durationSeconds; s += stepSeconds) sampleSeconds.add(s)
  sampleSeconds.add(durationSeconds)
  for (const p of gameRecord.events) {
    for (const g of p.goals || []) {
      const s = Math.round(toMinutes(g.time) * 60)
      if (s > 0) sampleSeconds.add(Math.max(0, s - 1))
      sampleSeconds.add(Math.min(durationSeconds, s))
    }
  }
  const sortedSeconds = [...sampleSeconds].filter((s) => s >= 0 && s <= durationSeconds).sort((a, b) => a - b)

  // Jeder Punkt weiterhin EINZELN über buildRawPayloadAt()/parseLiveSnapshot()
  // berechnet (keine Interpolation der Werte selbst, siehe Dateikopf) - hier
  // nur auf die für die Kurve tatsächlich nötigen Felder reduziert
  // (homeGoals/awayGoals/phase - das ist alles, was liveProbability.js
  // braucht). Volle Tor-/Straf-/Status-Details liefert `finalState` unten
  // (EIN vollständiger Snapshot, nicht dupliziert pro Sekunde).
  const points = sortedSeconds.map((elapsedSeconds) => {
    const rawWindowed = buildRawPayloadAt(gameRecord, elapsedSeconds / 60)
    const liveState = sihfSync.parseLiveSnapshot(rawWindowed)
    // Nur die für Wahrscheinlichkeit + Status-/Score-Anzeige nötigen Skalar-
    // Felder - die array-lastigen Felder (goals/penalties/periods/shots/
    // teamStats) wachsen mit der Spielzeit und würden bei 1s-Auflösung auf
    // mehrere MB aufsummieren, wenn sie pro Sekunde dupliziert würden (siehe
    // `finalState` unten für die vollständigen Ereignisdaten).
    return {
      elapsedSeconds, homeGoals: liveState.homeGoals, awayGoals: liveState.awayGoals,
      phase: liveState.phase, status: liveState.status, statusLabel: liveState.statusLabel, percent: liveState.percent,
    }
  })

  // Vollständiger Snapshot GENAU am Spielende (alle Tore/Strafen/Status
  // sichtbar) - liefert die Ereignisliste (Events-Timeline/Tor-Marker) sowie
  // Status/Percent/Label für die "aktueller Punkt"-Anzeige, ohne das für
  // jeden der (jetzt sehr vielen) Kurvenpunkte einzeln mitschicken zu müssen.
  const finalRawWindowed = buildRawPayloadAt(gameRecord, durationMinutes)
  const finalLiveState = sihfSync.parseLiveSnapshot(finalRawWindowed)

  return {
    replay: true,
    isHistoricalGameReplay: true,
    replaySourceGameId: localGame.sihfGameId,
    replaySourceLabel: `${gameRecord.homeTeam.acronym} - ${gameRecord.awayTeam.acronym}, ${gameRecord.date} (abgeschlossenes Spiel, historischer Verlauf)`,
    replayDurationSeconds: durationSeconds,
    points,
    finalState: { ...finalLiveState, replay: true, replayElapsedSeconds: durationSeconds },
  }
}

// Nur für Tests: Cache zwischen Testfällen zurücksetzen.
export function _resetRealGameCacheForTests() {
  finalRawCache.clear()
}

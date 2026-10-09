// ---------------------------------------------------------------------------
// ECHTE Live-Anbindung fürs Frontend (Gegenstück zu src/liveDemoData.js,
// siehe dortiger Kommentar: "Sobald eine echte Anbindung existiert, liefert
// sie Score/Events/elapsedMinutes im selben Rohformat"). Pollt
// GET /api/games/:gameId/live (server/liveSync.js) und baut daraus dieselbe
// Struktur, die buildDemoLiveMatch() liefert - LiveMatchHeader.jsx/
// LiveWinProbabilityPanel.jsx/LiveGameTimeline.jsx bleiben dadurch komplett
// UNVERÄNDERT wiederverwendbar.
//
// Wahrscheinlichkeit wird bewusst HIER im Client berechnet (nicht im
// Backend) - liveProbability.js ist bereits eine reine, überall importierbare
// Funktion, computeFixtures()/die Pre-Game-Prognose (Prediction Snapshot)
// laufen ohnehin nur im Frontend. Der Server liefert ausschliesslich rohe
// SIHF-Fakten (Score/Events/Status), nie eine Wahrscheinlichkeit - dieselbe
// Trennung wie beim Pre-Game-Modell.
// ---------------------------------------------------------------------------
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  computeLiveWinProbability, buildLiveProbabilityTimeline, REGULATION_MINUTES, MINUTES_PER_PERIOD, formatClock, periodTimeFromElapsed,
  regulationElapsedMinutes, regulationPeriodOffsetMinutes, isIntermissionStatus, advanceDisplayedElapsed,
} from './liveProbability.js'

export const LIVE_CLIENT_POLL_MS = 20_000
// Lokaler Zwischen-Tick: schreibt die angezeigte Spielzeit/den "JETZT"-Marker
// zwischen zwei SIHF-Polls per Wanduhr fort, damit er ~laufend wandert statt
// nur alle 20s zu springen (Anforderung: ~alle 30s aktualisieren). Kürzer als
// LIVE_CLIENT_POLL_MS, löst aber KEINEN zusätzlichen Netzwerk-Request aus.
export const LIVE_LOCAL_TICK_MS = 15_000

// Die SIHF-Spielzeit (grobes `status.percent`, verbindlicher Drittel-Name) wird
// jetzt zentral in liveProbability.js aufgelöst (regulationElapsedMinutes/
// advanceDisplayedElapsed) - Drittel-geklemmt, monoton, Pausen-fest. Für OT/SO
// übernimmt weiterhin die per Wanduhr mitgezählte otElapsedMinutes nur die
// X-Position (die Quote bleibt der eingefrorene Pre-Game-Split, siehe unten).

function toMinute(mmss) {
  if (!mmss) return null
  const [m, s] = String(mmss).split(':').map(Number)
  if (!Number.isFinite(m)) return null
  return m + (Number.isFinite(s) ? s / 60 : 0)
}

function buildEvents(liveState, homeTeamId) {
  const goalEvents = (liveState.goals || [])
    .map((g) => ({ minute: toMinute(g.time), type: 'goal', side: g.teamId === homeTeamId ? 'home' : 'away', text: g.text ? `Tor · ${g.text}` : 'Tor' }))
    .filter((e) => e.minute != null)
  const penaltyEvents = (liveState.penalties || [])
    .map((p) => ({ minute: toMinute(p.time), type: 'penalty', side: p.teamId === homeTeamId ? 'home' : 'away', text: p.text || `Strafe (${p.minutes}′)` }))
    .filter((e) => e.minute != null)
  return [...goalEvents, ...penaltyEvents].sort((a, b) => a.minute - b.minute)
}

// Baut EIN Objekt in exakt der Form von buildDemoLiveMatch() (liveDemoData.js)
// aus dem rohen Live-Snapshot (server) + der bereits vorhandenen Pre-Game-
// Prognose (unverändert - kommt aus dem Prediction Snapshot bzw. Monte-Carlo-
// Forecast, siehe MatchupDetail.jsx::displayForecast). `history` ist der
// bisher im Hook gesammelte Verlauf ECHTER Snapshots (kein Interpolieren,
// siehe LiveWinProbabilityPanel.jsx-Kommentar).
// Chart-Obergrenze für die OT/SO-X-Achse - identisch zu DEMO_MAX_MINUTE
// (src/liveDemoData.js) bzw. dem `maxMinute`, mit dem MatchupDetail.jsx die
// Live-Panels rendert, damit ein sehr langes OT/SO nicht über den
// sichtbaren Chart-Bereich hinausläuft. Reine Anzeige-Begrenzung, KEINE
// neue Wahrscheinlichkeitsannahme.
const OT_DISPLAY_CAP_MINUTES = REGULATION_MINUTES + 5

export function buildRealLiveMatch({ liveState, homeTeam, awayTeam, pregame, history, otElapsedMinutes, regElapsedMinutes }) {
  // Replay (server/liveReplay.js) kennt die exakte angefragte Spielzeit
  // (`replayElapsedSeconds`, direkt aus den absoluten SIHF-Torzeitstempeln
  // abgeleitet) - dort NIEMALS die grobe `percent`-Näherung verwenden, die
  // nur für echte Live-Spiele ohne bekanntes Zeitfeld ein Behelf ist (siehe
  // elapsedMinutesFromPercent()-Kommentar).
  //
  // OT/SO (`otElapsedMinutes`, von useLiveGame() per Wanduhr mitgezählt -
  // siehe dortiger Kommentar): NUR die X-Position des Chart-Punkts wandert
  // dadurch über die Zeit weiter, der Wahrscheinlichkeitswert selbst bleibt
  // exakt der eingefrorene Pre-Game-Split aus computeLiveWinProbability()
  // (dort unverändert - `elapsedMinutes` fliesst in den OT/SO-Zweig gar
  // nicht in die Berechnung ein, nur zur Info zurückgegeben). Ohne diese
  // Fortschreibung blieb jeder OT-Snapshot exakt bei 60:00 stehen - eine
  // "Linie" aus einem einzigen Punkt ist im SVG nicht sichtbar (nur die
  // Torereignis-Marker), siehe LiveWinProbabilityPanel.jsx::buildMonotonePath
  // (n===1 -> reines "M x y" ohne Liniensegment).
  // REG: bevorzugt der von useLiveGame() per Wanduhr fortgeschriebene,
  // Drittel-geklemmte Wert (regElapsedMinutes). Fehlt er (z.B. Dashboard-
  // Einzelabruf über LiveNowSection), wird die bestätigte, ebenfalls
  // Drittel-geklemmte Zeit direkt aus dem Snapshot abgeleitet - nie mehr die
  // ungeklemmte percent-Rohschätzung (siehe liveProbability.js::
  // regulationElapsedMinutes - Marker lag an Drittelgrenzen sonst im falschen
  // Abschnitt). Replay/OT/SO unverändert.
  const elapsedMinutes = liveState.replay
    ? Math.min(REGULATION_MINUTES, liveState.replayElapsedSeconds / 60)
    : (liveState.phase === 'REG'
      ? (regElapsedMinutes ?? regulationElapsedMinutes({ statusLabel: liveState.statusLabel, percent: liveState.percent }))
      : (otElapsedMinutes ?? REGULATION_MINUTES))
  const prob = computeLiveWinProbability({
    expHomeFull: pregame.expHomeFull, expAwayFull: pregame.expAwayFull, pHomePreGame: pregame.pHomePreGame,
    homeGoals: liveState.homeGoals, awayGoals: liveState.awayGoals,
    elapsedMinutes, phase: liveState.phase,
  })
  const { period, periodTime } = liveState.phase === 'REG'
    ? periodTimeFromElapsed(elapsedMinutes)
    : { period: liveState.phase === 'SO' ? 'SO' : 'OT', periodTime: null }

  return {
    isDemo: false,
    isLive: liveState.status === 'live',
    homeTeam, awayTeam,
    status: {
      period,
      periodLabel: liveState.statusLabel || (typeof period === 'number' ? `${period}. Drittel` : period),
      // periodTime ist bereits "MM:SS" (formatClock() lief schon in
      // periodTimeFromElapsed()) - NUR eine Näherung aus `percent` (siehe
      // Kommentar bei elapsedMinutesFromPercent), deshalb kein Sekunden-
      // Countdown-Anspruch, aber besser als gar keine Zeitangabe.
      clock: liveState.phase === 'REG' ? periodTime : null,
      percent: liveState.percent,
    },
    score: { home: liveState.homeGoals, away: liveState.awayGoals },
    // pHome/pAway = FINAL Win Probability (inkl. OT/SO, summiert zu 100%).
    // pHomeReg/pAwayReg/pDraw = REGULATION Outcome nach 60' (summiert
    // ebenfalls zu 100%, aber ein ANDERER Wahrscheinlichkeitsraum - siehe
    // LiveWinProbabilityPanel.jsx-Kommentar). Beide kommen unverändert aus
    // liveProbability.js::computeLiveWinProbability() (homeRegWin/
    // awayRegWin/drawAfter60), hier nur zusätzlich durchgereicht statt wie
    // bisher nur pDraw allein (das ohne pHomeReg/pAwayReg fälschlich wie ein
    // dritter Teil der Final-Aufteilung aussah).
    // `phase` zusätzlich durchgereicht (unverändert aus computeLiveWinProbability()
    // - siehe dort) - einzig dafür, dass die UI (LiveWinProbabilityPanel) bei
    // OT/SO sichtbar kennzeichnen kann, dass die Quote der eingefrorene
    // Pre-Game-Split ist, KEINE neue/zusätzliche Berechnung.
    probability: { pHome: prob.homeFinal, pDraw: prob.drawAfter60, pAway: prob.awayFinal, pHomeReg: prob.homeRegWin, pAwayReg: prob.awayRegWin, phase: prob.phase },
    probabilityHistory: history,
    events: buildEvents(liveState, homeTeam.id),
    stats: liveState.teamStats,
    // Linienaufstellungen (Positionsgruppen aus SIHF raw.lineUps, serverseitig
    // zu Name/Nummer aufgelöst - siehe sync-sihf.cjs::parseLineups). null,
    // wenn SIHF für dieses Spiel keine Aufstellung liefert (Replay-Snapshots
    // haben das Feld gar nicht -> undefined); die UI zeigt dann einen Hinweis.
    lineups: liveState.lineups ?? null,
    raw: liveState,
  }
}

// React-Hook: pollt den Live-Endpoint alle LIVE_CLIENT_POLL_MS, solange
// `enabled` true ist, und sammelt bei jedem NEUEN Snapshot (Score/Zeit hat
// sich geändert) einen weiteren echten Punkt in `probabilityHistory` -
// identisches Prinzip wie buildProbabilityHistory() in liveDemoData.js, nur
// mit real ankommenden statt vorab bekannten Zuständen. Stoppt automatisch,
// sobald der Server 404 liefert (Spiel final geworden/kein Live-Zustand mehr,
// siehe server/liveSync.js::pollOne - der Cache wird dort bei "final" geleert)
// - Requirement 7: kein weiteres Live-Polling nach Spielende.
export function useLiveGame({ gameId, homeTeam, awayTeam, pregame, enabled }) {
  const [liveMatch, setLiveMatch] = useState(null)
  const [ended, setEnded] = useState(false)
  // Letzter empfangener Snapshot - der lokale Zwischen-Tick (rebuild) baut die
  // Ansicht daraus neu auf, OHNE neu zu fetchen (nur die Zeitposition wandert).
  const lastStateRef = useRef(null)
  // REG-Zeitanker: bestätigte Spielzeit des letzten Snapshots + Wanduhr-
  // Zeitpunkt des Empfangs, plus Drittel-Offset/Pause-Flag. advanceDisplayedElapsed()
  // (liveProbability.js) schreibt daraus die angezeigte Spielzeit zwischen den
  // Snapshots per Wanduhr fort - monoton, innerhalb des Drittels, Uhr steht in
  // der Pause. `prevMin` trägt den zuletzt gezeigten Wert für die Monotonie.
  const regAnchorRef = useRef(null)
  // Wanduhr-Zeitpunkt des ersten beobachteten OT/SO-Ticks (Date.now()) - NUR
  // dafür, dass die Chart-X-Position während OT/SO mit der echten
  // verstrichenen Zeit weiterwandert (siehe buildRealLiveMatch()-Kommentar).
  const otStartRef = useRef(null)

  useEffect(() => {
    if (!enabled || !gameId || !pregame) {
      lastStateRef.current = null
      regAnchorRef.current = null
      otStartRef.current = null
      setLiveMatch(null)
      setEnded(false)
      return
    }

    let cancelled = false
    let pollTimer = null
    let tickTimer = null

    // Baut die Ansicht aus dem zuletzt empfangenen Snapshot neu auf und
    // schreibt dabei NUR die Zeitposition (REG per Wanduhr innerhalb des
    // Drittels, OT/SO per Wanduhr ab 60') fort - kein Fetch, keine geänderte
    // Wahrscheinlichkeitsberechnung.
    function rebuild() {
      const liveState = lastStateRef.current
      if (!liveState || cancelled) return
      const now = Date.now()

      let otElapsedMinutes = null
      let regElapsedMinutes = null
      if (liveState.phase === 'REG') {
        const a = regAnchorRef.current
        if (a) {
          regElapsedMinutes = advanceDisplayedElapsed({
            confirmedMin: a.confirmedMin, anchorWallMs: a.wallMs, nowMs: now,
            offsetMin: a.offset, intermission: a.intermission, prevDisplayedMin: a.prevMin,
          })
          a.prevMin = regElapsedMinutes // Monotonie über die Zwischen-Ticks hinweg
        }
      } else {
        if (otStartRef.current == null) otStartRef.current = now
        otElapsedMinutes = Math.min(REGULATION_MINUTES + (now - otStartRef.current) / 60000, OT_DISPLAY_CAP_MINUTES)
      }

      // Vollständige Kurve (Spielbeginn -> jetzt) aus den echten Toren +
      // Engine rekonstruieren (durchgehende Linie, siehe
      // liveProbability.js::buildLiveProbabilityTimeline).
      const goalsAbs = (liveState.goals || [])
        .map((g) => ({ minute: toMinute(g.time), side: g.teamId === homeTeam.id ? 'home' : 'away' }))
        .filter((g) => g.minute != null)
      const elapsedForTimeline = liveState.phase === 'REG' ? (regElapsedMinutes ?? 0) : otElapsedMinutes
      const history = buildLiveProbabilityTimeline({
        expHomeFull: pregame.expHomeFull, expAwayFull: pregame.expAwayFull, pHomePreGame: pregame.pHomePreGame,
        goals: goalsAbs, homeGoals: liveState.homeGoals, awayGoals: liveState.awayGoals,
        elapsedMinutes: elapsedForTimeline, phase: liveState.phase,
      })

      setLiveMatch(buildRealLiveMatch({ liveState, homeTeam, awayTeam, pregame, history, otElapsedMinutes, regElapsedMinutes }))
    }

    async function poll() {
      let liveState
      try {
        const res = await fetch(`/api/games/${gameId}/live`)
        if (res.status === 404) {
          // Spiel final geworden (server/liveSync.js räumt den Cache bei
          // status:'final') oder nie live gewesen - Polling stoppen
          // (kein weiteres Fortschreiben der Zeit/Wahrscheinlichkeit).
          if (!cancelled) { setEnded(true); if (pollTimer) clearInterval(pollTimer); if (tickTimer) clearInterval(tickTimer) }
          return
        }
        if (!res.ok) return // vorübergehender Fehler (502 etc.) - nächster Poll versucht es erneut, bisheriger Stand bleibt sichtbar
        liveState = await res.json()
      } catch {
        return // Netzwerkfehler - wie oben, nichts zurücksetzen
      }
      if (cancelled) return

      lastStateRef.current = liveState
      // Zeitanker mit der BESTÄTIGTEN Spielzeit synchronisieren (Drittel-
      // geklemmt). Bei Drittelwechsel wird die Monotonie-Basis zurückgesetzt
      // (erlaubter Vorwärtssprung ins neue Drittel), innerhalb desselben
      // Drittels verhindert prevMin Rücksprünge.
      if (liveState.phase === 'REG') {
        const offset = regulationPeriodOffsetMinutes(liveState.statusLabel)
        const intermission = isIntermissionStatus(liveState.statusLabel)
        const confirmed = regulationElapsedMinutes({ statusLabel: liveState.statusLabel, percent: liveState.percent })
        const prev = regAnchorRef.current
        const prevMin = prev && prev.offset === offset ? prev.prevMin : null
        regAnchorRef.current = { confirmedMin: confirmed, wallMs: Date.now(), offset, intermission, prevMin }
        otStartRef.current = null
      } else if (otStartRef.current == null) {
        otStartRef.current = Date.now()
      }
      rebuild()
    }

    poll()
    pollTimer = setInterval(poll, LIVE_CLIENT_POLL_MS)
    // Lokaler Zwischen-Tick: bewegt den "JETZT"-Marker auch zwischen den
    // SIHF-Polls ~laufend nach rechts (Wanduhr-Fortschreibung), ohne zu fetchen.
    tickTimer = setInterval(rebuild, LIVE_LOCAL_TICK_MS)
    return () => { cancelled = true; if (pollTimer) clearInterval(pollTimer); if (tickTimer) clearInterval(tickTimer) }
  }, [gameId, homeTeam, awayTeam, pregame, enabled])

  return { liveMatch, ended }
}

export const LIVE_LIST_POLL_MS = 20_000 // identisch zu LIVE_CLIENT_POLL_MS/dem Server-Hintergrund-Poll-Intervall - der Cache (server/liveSync.js) aktualisiert sich ohnehin nicht öfter, schnelleres Polling hier würde nur denselben Stand mehrfach abfragen.

// React-Hook: EIN zentraler Poll auf GET /api/live-games (server/liveSync.js::
// getAllLiveStates) statt eines eigenen useLiveGame()-Polls pro Spiel -
// liefert die rohen Live-Snapshots ALLER aktuell laufenden Spiele in einem
// Request (Dashboard "Live jetzt", siehe Dashboard.jsx). Löst selbst keinen
// zusätzlichen SIHF-Request aus, liest nur den bestehenden Server-Cache.
// Liefert [] sowohl vor dem ersten erfolgreichen Request als auch wenn
// tatsächlich kein Spiel live ist - der Aufrufer unterscheidet das nicht,
// da in beiden Fällen kein Live-Bereich angezeigt werden soll.
export function useLiveGamesList() {
  const [liveStates, setLiveStates] = useState([])

  useEffect(() => {
    let cancelled = false
    let interval = null

    async function tick() {
      try {
        const res = await fetch('/api/live-games')
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled) setLiveStates(json)
      } catch {
        // vorübergehender Netzwerkfehler - bisheriger Stand bleibt sichtbar, nächster Tick versucht erneut
      }
    }

    tick()
    interval = setInterval(tick, LIVE_LIST_POLL_MS)
    return () => { cancelled = true; clearInterval(interval) }
  }, [])

  return liveStates
}

// React-Hook: historischer Verlauf eines ABGESCHLOSSENEN echten Spiels
// (GET /api/games/:gameId/replay, server/liveReplay.js::buildRealGameReplayState).
// Im Unterschied zu useLiveGame() kein Intervall-Polling (das Spiel ändert
// sich nicht mehr) - stattdessen explizit über `elapsed` (Sekunden)
// erkundbar, siehe MatchupDetail.jsx-Zeitregler. Lädt beim ersten Aktivieren
// EINMAL den vollständigen Endstand (liefert die echten Tor-/Straf-
// Zeitstempel für die Sprungmarken + die Gesamtdauer inkl. OT/SO), danach
// bei jeder `elapsed`-Änderung den entsprechenden Zwischenstand - server-
// seitig gecacht (server/liveReplay.js::finalRawCache), kein wiederholter
// SIHF-Request pro Regler-Bewegung.
export function useGameReplay({ gameId, homeTeam, awayTeam, pregame, enabled }) {
  const [elapsed, setElapsed] = useState(0)
  const [liveMatch, setLiveMatch] = useState(null)
  const [finalState, setFinalState] = useState(null) // vollständiger Endstand - liefert Sprungmarken (Tore/Strafen) + Gesamtdauer
  const [error, setError] = useState(null)
  const historyRef = useRef([])

  useEffect(() => {
    historyRef.current = []
    setLiveMatch(null)
    setFinalState(null)
    setError(null)
    setElapsed(0)
    if (!enabled || !gameId || !pregame) return

    let cancelled = false
    fetch(`/api/games/${gameId}/replay`)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() })
      .then((json) => { if (!cancelled) setFinalState(json) })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [gameId, homeTeam, awayTeam, pregame, enabled])

  useEffect(() => {
    if (!enabled || !gameId || !pregame) return
    let cancelled = false
    fetch(`/api/games/${gameId}/replay?elapsed=${Math.round(elapsed)}`)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() })
      .then((liveState) => {
        if (cancelled) return
        setError(null)
        const point = buildRealLiveMatch({ liveState, homeTeam, awayTeam, pregame, history: [] })
        historyRef.current = [
          ...historyRef.current.filter((p) => p.elapsedSeconds !== liveState.replayElapsedSeconds),
          {
            elapsedSeconds: liveState.replayElapsedSeconds,
            gameTime: formatClock(Math.min(REGULATION_MINUTES, liveState.replayElapsedSeconds / 60)),
            homeGoals: liveState.homeGoals, awayGoals: liveState.awayGoals,
            homeWin: point.probability.pHome, drawAfter60: point.probability.pDraw, awayWin: point.probability.pAway,
            eventType: null, event: null,
          },
        ].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds)
        setLiveMatch(buildRealLiveMatch({ liveState, homeTeam, awayTeam, pregame, history: historyRef.current }))
      })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
  }, [gameId, homeTeam, awayTeam, pregame, enabled, elapsed])

  return { liveMatch, finalState, elapsed, setElapsed, error }
}

// React-Hook: DIE VOLLSTÄNDIGE historische Live-Win-Probability-KURVE eines
// abgeschlossenen Spiels (GET /api/games/:gameId/replay/timeline,
// server/liveReplay.js::buildRealGameReplayTimeline) - im Unterschied zu
// useGameReplay() oben wird NICHT nur der am Regler ausgewählte Einzelpunkt
// geladen, sondern EIN Request liefert die komplette Snapshot-Serie über das
// ganze Spiel; die Wahrscheinlichkeit für JEDEN dieser Punkte wird hier
// (identisch zu useLiveGame()/useGameReplay()) über die UNVERÄNDERTE
// liveProbability.js berechnet - `probabilityHistory` enthält dadurch von
// Anfang an die GESAMTE Kurve 0' bis Spielende, unabhängig vom Regler.
// `elapsed` steuert nur, welcher Punkt als "aktuell" (Score/Status im Header,
// Crosshair-Startposition) hervorgehoben wird.
export function useGameReplayTimeline({ gameId, homeTeam, awayTeam, pregame, enabled }) {
  // `points`: dichte, schlanke Zeitreihe (nur die für liveProbability.js
  // nötigen Skalarfelder - siehe server/liveReplay.js::buildRealGameReplayTimeline,
  // 1s-Auflösung). `finalState`: EIN vollständiger liveState-Snapshot (mit
  // goals/penalties/teamStats) für Events/aktuelle-Punkt-Fallback-Felder -
  // nicht pro Sekunde dupliziert (sonst mehrere MB Payload).
  const [points, setPoints] = useState(null)
  const [finalState, setFinalState] = useState(null)
  const [history, setHistory] = useState(null) // vollständige probabilityHistory, EINMAL aus points berechnet
  const [durationSeconds, setDurationSeconds] = useState(0)
  const [sourceLabel, setSourceLabel] = useState(null)
  const [finalPhase, setFinalPhase] = useState(null) // Phase des LETZTEN Punkts (REG/OT/SO) - der wahre Spielausgang, unabhängig vom Regler
  const [elapsed, setElapsed] = useState(0)
  const [error, setError] = useState(null)

  useEffect(() => {
    setPoints(null); setFinalState(null); setHistory(null); setError(null); setElapsed(0); setDurationSeconds(0); setFinalPhase(null)
    if (!enabled || !gameId || !pregame) return
    let cancelled = false
    fetch(`/api/games/${gameId}/replay/timeline`)
      .then((res) => { if (!res.ok) throw new Error(`HTTP ${res.status}`); return res.json() })
      .then((timeline) => {
        if (cancelled) return
        const fullHistory = timeline.points.map((pt) => {
          const elapsedMinutes = Math.min(REGULATION_MINUTES, pt.elapsedSeconds / 60)
          const prob = computeLiveWinProbability({
            expHomeFull: pregame.expHomeFull, expAwayFull: pregame.expAwayFull, pHomePreGame: pregame.pHomePreGame,
            homeGoals: pt.homeGoals, awayGoals: pt.awayGoals, elapsedMinutes, phase: pt.phase,
          })
          return {
            elapsedSeconds: pt.elapsedSeconds, gameTime: formatClock(elapsedMinutes),
            homeGoals: pt.homeGoals, awayGoals: pt.awayGoals,
            homeWin: prob.homeFinal, drawAfter60: prob.drawAfter60, awayWin: prob.awayFinal,
            eventType: null, event: null,
          }
        })
        setPoints(timeline.points)
        setFinalState(timeline.finalState)
        setHistory(fullHistory)
        setDurationSeconds(timeline.replayDurationSeconds)
        setSourceLabel(timeline.replaySourceLabel)
        setFinalPhase(timeline.finalState?.phase ?? null)
        setElapsed(timeline.replayDurationSeconds) // Default: Endstand/komplette Kurve zeigen
      })
      .catch((e) => { if (!cancelled) setError(e.message) })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameId, homeTeam, awayTeam, pregame, enabled])

  // Nächstgelegener Punkt zum gewählten `elapsed` - bestimmt NUR Score/
  // Status/Periode im Header, NICHT die Kurve selbst (die bleibt immer
  // vollständig, siehe `history` oben). Punkte sind sekundengenau + nach
  // elapsedSeconds sortiert -> Bisektion statt linearem Scan über bis zu
  // ~4000 Punkte.
  const currentPoint = useMemo(() => {
    if (!points || points.length === 0) return null
    let lo = 0, hi = points.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (points[mid].elapsedSeconds < elapsed) lo = mid + 1
      else hi = mid
    }
    if (lo > 0 && Math.abs(points[lo - 1].elapsedSeconds - elapsed) <= Math.abs(points[lo].elapsedSeconds - elapsed)) return points[lo - 1]
    return points[lo]
  }, [points, elapsed])

  const timelineMatch = useMemo(() => {
    if (!currentPoint || !history || !homeTeam || !awayTeam) return null
    const liveState = { ...currentPoint, replay: true, replayElapsedSeconds: currentPoint.elapsedSeconds }
    return buildRealLiveMatch({ liveState, homeTeam, awayTeam, pregame, history })
  }, [currentPoint, history, homeTeam, awayTeam, pregame])

  // Events (Tore/Strafen) IMMER aus `finalState` (= alle Ereignisse des
  // bereits abgeschlossenen Spiels sind dort vollständig sichtbar) -
  // unabhängig vom gewählten `elapsed`, damit die Timeline/Goal-Marker beim
  // Zurückscrubben nicht plötzlich Ereignisse "verlieren" (nur Score/Status
  // im Header folgen dem Regler, siehe `timelineMatch` oben).
  const allEvents = useMemo(() => {
    if (!finalState || !history || !homeTeam || !awayTeam) return []
    return buildRealLiveMatch({ liveState: finalState, homeTeam, awayTeam, pregame, history }).events
  }, [finalState, history, homeTeam, awayTeam, pregame])

  return { timelineMatch, allEvents, durationSeconds, sourceLabel, finalPhase, elapsed, setElapsed, error }
}

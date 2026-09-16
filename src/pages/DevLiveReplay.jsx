// ---------------------------------------------------------------------------
// DEV-ONLY: Live-Replay eines abgeschlossenen Archiv-Spiels (HC Davos - EV
// Zug, 08.09.2017, server/liveReplay.js) - testet den kompletten echten
// Live-Datenfluss (parseLiveSnapshot() -> /api/dev/live-replay ->
// buildRealLiveMatch() -> Live-UI -> liveProbability.js) ohne ein aktuell
// laufendes NL-Spiel. Verwendet DIESELBEN Live-Komponenten wie ein echtes
// Spiel (LiveMatchHeader/LiveWinProbabilityPanel/LiveGameTimeline) - kein
// separates Replay-UI, nur ein zusätzlicher Zeit-Regler + klarer Hinweis.
//
// Route nur im Dev-Build registriert (siehe App.jsx: import.meta.env.DEV) -
// existiert im Produktions-Bundle gar nicht (Vite entfernt den toten Zweig
// beim Build), zusätzlich zur serverseitigen NODE_ENV-Sperre in
// server/index.js.
// ---------------------------------------------------------------------------
import { useEffect, useState } from 'react'
import { useData } from '../DataContext.jsx'
import { homeWinProbability, ELO_CONFIG } from '../elo.js'
import LiveMatchHeader from '../components/LiveMatchHeader.jsx'
import LiveWinProbabilityPanel from '../components/LiveWinProbabilityPanel.jsx'
import LiveGameTimeline from '../components/LiveGameTimeline.jsx'
import { buildRealLiveMatch } from '../liveGameClient.js'
import { REGULATION_MINUTES, formatClock } from '../liveProbability.js'

// Identisch zu CALIBRATION.leagueHomeGPG/leagueAwayGPG in src/playoffSim.js
// (bewusst dupliziert statt importiert - CALIBRATION dort ist nicht
// exportiert, siehe Kommentar in server/scripts/backtesting/predictors.js
// für dasselbe, bereits etablierte Muster). Nur eine NEUTRALE Referenz für
// dieses Dev-Tool (reine Verkabelungsprüfung, keine echte Prognose für ein
// Spiel von 2017) - pHomePreGame kommt aus der unveränderten ELO-Formel bei
// gleicher Start-Stärke beider Teams (nur Heimvorteil wirkt).
const REPLAY_PREGAME = {
  expHomeFull: 3.0496, expAwayFull: 2.5309,
  pHomePreGame: homeWinProbability(ELO_CONFIG.eloStart, ELO_CONFIG.eloStart, ELO_CONFIG.homeAdvantage),
}

const PERIOD_MARKERS = [0, 20, 40, 60]
const MAX_MINUTE = 66

// Vordefinierte Testzeitpunkte (Sekunden) - deckt Requirement 6 ab: Anpfiff,
// nach jedem Tor, Drittelende, 30/40/50', kurz vor Schluss, Overtime, Final.
// Torzeiten aus dem Fixture (server/liveReplay.js-Kommentar): 15:53, 22:50,
// 23:09, 33:56, SO-Marker 65:00.
const PRESETS = [
  { label: '00:00 (Anpfiff)', seconds: 0 },
  { label: 'Nach 1. Tor (16:00)', seconds: 16 * 60 },
  { label: 'Drittelende 1 (20:00)', seconds: 20 * 60 },
  { label: 'Nach 2 weiteren Toren (23:30)', seconds: 23.5 * 60 },
  { label: '30:00', seconds: 30 * 60 },
  { label: 'Nach 4. Tor (34:00)', seconds: 34 * 60 },
  { label: '40:00 (Drittelende 2)', seconds: 40 * 60 },
  { label: '50:00', seconds: 50 * 60 },
  { label: 'Kurz vor Schluss (59:30)', seconds: 59.5 * 60 },
  { label: 'Overtime (61:00)', seconds: 61 * 60 },
  { label: 'Final (inkl. Shootout)', seconds: 66 * 60 },
]

export default function DevLiveReplay() {
  const { data } = useData()
  const [elapsed, setElapsed] = useState(0)
  const [liveState, setLiveState] = useState(null)
  const [history, setHistory] = useState([])
  const [error, setError] = useState(null)

  const homeTeam = data?.teams?.find((t) => t.id === 'team_dav')
  const awayTeam = data?.teams?.find((t) => t.id === 'team_zug')

  // Lädt den gewählten Replay-Zeitpunkt und hängt ihn (dedupliziert nach
  // Sekunde, chronologisch sortiert) an die Chart-Historie an - identisches
  // Prinzip wie useLiveGame() im echten Pfad: jeder Punkt ist ein ECHTER,
  // über liveProbability.js berechneter Snapshot für genau diesen
  // Zeitpunkt, nichts wird interpoliert oder aus der Zukunft vorgezogen.
  useEffect(() => {
    if (!homeTeam || !awayTeam) return
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/dev/live-replay?elapsed=${elapsed}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = await res.json()
        if (cancelled) return
        setLiveState(json)
        setError(null)
        const point = buildRealLiveMatch({ liveState: json, homeTeam, awayTeam, pregame: REPLAY_PREGAME, history: [] })
        setHistory((h) => [
          ...h.filter((p) => p.elapsedSeconds !== json.replayElapsedSeconds),
          {
            elapsedSeconds: json.replayElapsedSeconds,
            gameTime: formatClock(Math.min(REGULATION_MINUTES, json.replayElapsedSeconds / 60)),
            homeGoals: json.homeGoals, awayGoals: json.awayGoals,
            homeWin: point.probability.pHome, drawAfter60: point.probability.pDraw, awayWin: point.probability.pAway,
            eventType: null, event: null,
          },
        ].sort((a, b) => a.elapsedSeconds - b.elapsedSeconds))
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    }
    load()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elapsed, homeTeam, awayTeam])

  const liveMatch = liveState && homeTeam && awayTeam
    ? buildRealLiveMatch({ liveState, homeTeam, awayTeam, pregame: REPLAY_PREGAME, history })
    : null

  if (!homeTeam || !awayTeam) return <div className="muted" style={{ padding: '20px 0' }}>Lädt…</div>

  return (
    <div>
      <div className="live-demo-banner" style={{ marginBottom: 14 }}>
        <strong style={{ color: 'var(--text)' }}>LIVE REPLAY / HISTORISCHE DATEN:</strong>{' '}
        {liveState?.replaySourceLabel || 'wird geladen…'} - kein echtes Live-Spiel, Zeitpunkt manuell gewählt.
      </div>

      <div className="card card-pad mb">
        <div className="row spread" style={{ marginBottom: 10, flexWrap: 'wrap', gap: 8 }}>
          <strong>Zeitpunkt: {formatClock(elapsed / 60)}</strong>
          {error && <span className="bad" style={{ fontSize: 12 }}>Fehler: {error}</span>}
        </div>
        <div className="row gap-sm wrap">
          {PRESETS.map((p) => (
            <button key={p.seconds} className={'btn ghost sm' + (elapsed === p.seconds ? ' active' : '')} onClick={() => setElapsed(p.seconds)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {liveMatch && (
        <div className="live-section-group">
          <LiveMatchHeader homeTeam={homeTeam} awayTeam={awayTeam} live={{ ...liveMatch, isDemo: true }} />
          <LiveWinProbabilityPanel
            homeTeam={homeTeam} awayTeam={awayTeam}
            probability={liveMatch.probability}
            probabilityHistory={liveMatch.probabilityHistory}
            events={liveMatch.events}
            periodMarkers={PERIOD_MARKERS}
            maxMinute={MAX_MINUTE}
            isLive={liveMatch.isLive}
          />
          <LiveGameTimeline homeTeam={homeTeam} awayTeam={awayTeam} events={liveMatch.events} />
        </div>
      )}
    </div>
  )
}

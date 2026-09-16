// ---------------------------------------------------------------------------
// Historischer Live-Replay für ein ECHTES, abgeschlossenes Spiel. Zeigt DIE
// VOLLSTÄNDIGE Live-Win-Probability-Kurve über das ganze Spiel (0' bis
// Spielende) - nicht nur den am Regler ausgewählten Einzelpunkt - über
// src/liveGameClient.js::useGameReplayTimeline(). Verwendet GENAU dieselben
// Komponenten wie ein laufendes Spiel (LiveMatchHeader/
// LiveWinProbabilityPanel/LiveGameTimeline), mit klar abweichender
// Beschriftung (sourceLabel/badgeLabel/nowLabel-Props, siehe dortige
// Kommentare) statt der Demo-/Live-Texte - keine zweite Probability-Engine,
// keine hartkodierten Prozentwerte, keine spielspezifische Sonderlogik.
//
// LiveStatistics bewusst NICHT eingebunden - siehe MatchupDetail.jsx-
// Kommentar zum echten Live-Pfad: die SIHF-Team-Stats-Zeilenbeschriftungen
// sind nicht verifiziert, eine geratene Zuordnung würde falsche Zahlen
// zeigen (weder als "aktuell" noch als "Endstand" vertretbar).
// ---------------------------------------------------------------------------
import { useMemo } from 'react'
import LiveMatchHeader from './LiveMatchHeader.jsx'
import LiveWinProbabilityPanel from './LiveWinProbabilityPanel.jsx'
import LiveGameTimeline from './LiveGameTimeline.jsx'
import { useGameReplayTimeline } from '../liveGameClient.js'
import { formatClock } from '../liveProbability.js'

const PERIOD_MARKERS = [0, 20, 40, 60]

export default function GameReplayView({ gameId, homeTeam, awayTeam, pregame }) {
  const { timelineMatch, allEvents, durationSeconds, sourceLabel, finalPhase, elapsed, setElapsed, error } = useGameReplayTimeline({ gameId, homeTeam, awayTeam, pregame, enabled: true })

  // Sprungmarken ("Timeline erkundbar") AUS DEN ECHTEN Ereignissen dieses
  // Spiels abgeleitet (Anpfiff, jedes Tor, jede erreichte Drittelgrenze,
  // Ende) - keine Hardcodierung eines einzelnen Matchups, funktioniert
  // automatisch für jedes Spiel mit sihfGameId.
  const jumpPoints = useMemo(() => {
    if (!timelineMatch || !durationSeconds) return []
    const goalSeconds = (allEvents || []).filter((e) => e.type === 'goal').map((e) => Math.round(e.minute * 60))
    const periodBoundaries = PERIOD_MARKERS.filter((m) => m > 0 && m * 60 < durationSeconds).map((m) => m * 60)
    const points = new Map()
    points.set(0, 'Anpfiff')
    for (const s of goalSeconds) points.set(Math.min(durationSeconds, s + 1), `Tor ${formatClock(Math.min(durationSeconds, s + 1) / 60)}`)
    for (const s of periodBoundaries) if (!points.has(s)) points.set(s, formatClock(s / 60))
    points.set(durationSeconds, 'Spielende')
    return [...points.entries()].sort((a, b) => a[0] - b[0]).map(([seconds, label]) => ({ seconds, label }))
  }, [timelineMatch, durationSeconds])

  // Regulation-Endstand (Score bei genau 60:00) getrennt vom tatsächlichen
  // Endstand (inkl. OT/SO) - Requirement 5: "60:00 = Ende der regulären
  // Spielzeit" MUSS getrennt von einem späteren OT/SO-Entscheid angezeigt
  // werden, kein erfundener OT-Zeitpunkt, ausschliesslich aus den echten
  // Goal-Events abgeleitet (`allEvents`, bereits mit dem korrekten
  // MM:SS-Minutenwert versehen).
  const scoreInfo = useMemo(() => {
    if (!allEvents || durationSeconds <= 3600) return null // reines REG-Spiel - keine separate OT/SO-Zeile nötig
    const goals = allEvents.filter((e) => e.type === 'goal')
    const regHome = goals.filter((e) => e.side === 'home' && e.minute <= 60).length
    const regAway = goals.filter((e) => e.side === 'away' && e.minute <= 60).length
    const finalHome = goals.filter((e) => e.side === 'home').length
    const finalAway = goals.filter((e) => e.side === 'away').length
    return { regHome, regAway, finalHome, finalAway }
  }, [allEvents, durationSeconds])

  if (error) return <div className="muted" style={{ padding: '12px 0' }}>Historischer Verlauf nicht verfügbar: {error}</div>
  if (!timelineMatch) return <div className="muted" style={{ padding: '12px 0' }}>Lädt historischen Verlauf…</div>

  const atEnd = elapsed >= durationSeconds
  // `finalPhase` = Phase des LETZTEN Snapshots (immer der wahre Spielausgang),
  // NICHT `timelineMatch.raw.phase` (das ist die Phase am aktuell gewählten
  // Regler-Punkt und wäre z.B. beim Zurückscrubben in die Regulationszeit
  // fälschlich 'REG', obwohl das Spiel tatsächlich in die Verlängerung ging).
  const finalPhaseLabel = finalPhase === 'SO' ? 'n.P.' : finalPhase === 'OT' ? 'n.V.' : null
  const nowLabel = atEnd ? (finalPhaseLabel ? `Ende (${finalPhaseLabel})` : 'Spielende (60:00)') : formatClock(Math.min(60, elapsed / 60))

  return (
    <div className="mb">
      <div className="live-demo-banner">
        <strong style={{ color: 'var(--text)' }}>📈 Historischer Spielverlauf · rekonstruiert:</strong>{' '}
        Live-Wahrscheinlichkeitsverlauf aus historischen Spieldaten rekonstruiert (echte SIHF-Tor-/Straf-Zeitstempel, Wahrscheinlichkeit über die bestehende Restzeit-Engine liveProbability.js neu berechnet) - kein Live-Spiel, keine Demo-Daten.
        {sourceLabel && <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>{sourceLabel}</div>}
        {scoreInfo && (
          <div className="muted" style={{ fontSize: 11, marginTop: 4 }}>
            REGULATION ENDE (60:00): {scoreInfo.regHome}:{scoreInfo.regAway}
            {' · '}
            {finalPhaseLabel || 'OT/SO'}: {scoreInfo.finalHome}:{scoreInfo.finalAway}
          </div>
        )}
      </div>

      <div className="live-section-group">
        <LiveMatchHeader
          homeTeam={homeTeam} awayTeam={awayTeam}
          live={{
            ...timelineMatch, isDemo: false,
            // Am Spielende zeigt status.clock (periodTime INNERHALB des 3.
            // Drittels) sonst verwirrend "20:00" (= volle Drittellänge, siehe
            // periodTimeFromElapsed()-Kommentar in liveProbability.js) statt
            // des tatsächlichen Endzeitpunkts - hier durch denselben
            // nowLabel/Gesamtdauer-Text ersetzt, den auch der Chart zeigt.
            status: atEnd
              ? { ...timelineMatch.status, periodLabel: finalPhaseLabel ? `Ende (${finalPhaseLabel})` : 'Spielende', clock: formatClock(durationSeconds / 60) }
              : timelineMatch.status,
          }}
          badgeLabel="SPIELVERLAUF · REKONSTRUIERT"
          badgeStatic
        />
        <LiveWinProbabilityPanel
          homeTeam={homeTeam} awayTeam={awayTeam}
          probability={timelineMatch.probability}
          probabilityHistory={timelineMatch.probabilityHistory}
          events={allEvents}
          periodMarkers={PERIOD_MARKERS}
          maxMinute={Math.max(65, Math.ceil(durationSeconds / 60))}
          isLive={false}
          sourceLabel="Historisch rekonstruiert"
          nowLabel={nowLabel}
        />
        <LiveGameTimeline homeTeam={homeTeam} awayTeam={awayTeam} events={allEvents} sourceLabel="Historisch rekonstruiert" />
      </div>

      <div className="card card-pad mb" style={{ marginTop: 10 }}>
        <div className="row spread" style={{ marginBottom: 10 }}>
          <strong>Zeitpunkt wählen: {nowLabel}</strong>
        </div>
        <input
          type="range" min={0} max={durationSeconds} value={elapsed}
          onChange={(e) => setElapsed(Number(e.target.value))}
          style={{ width: '100%', marginBottom: 10 }}
        />
        <div className="row gap-sm wrap">
          {jumpPoints.map((p) => (
            <button key={p.seconds} className={'btn ghost sm' + (elapsed === p.seconds ? ' active' : '')} onClick={() => setElapsed(p.seconds)}>
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

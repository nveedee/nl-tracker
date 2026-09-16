// ---------------------------------------------------------------------------
// UI-KONZEPT: Live-Ticker statt normaler Tabelle - dichte Event-Zeilen
// (Zeit, Icon, Team, bei Toren der Score danach, Text), mit einem kleinen
// Alle/Tore/Strafen-Filter (rein clientseitig auf den bereits geladenen
// Demo-Events, keine Backend-Anbindung). Nach Dritteln gruppiert über sehr
// dezente Trennzeilen (kein grosser Section-Header) - kein 90'-Fussball-
// Raster. Rein präsentational, erwartet `events: [{ minute, type: 'goal'|
// 'penalty', side: 'home'|'away', text }]`.
// ---------------------------------------------------------------------------
import { Fragment, useMemo, useState } from 'react'
import { formatClock } from '../liveProbability.js'

const EVENT_ICON = { goal: '⚪', penalty: '⏱' }

const PERIODS = [
  { label: '1. Drittel', from: 0, to: 20 },
  { label: '2. Drittel', from: 20, to: 40 },
  { label: '3. Drittel', from: 40, to: 60 },
  { label: 'Overtime', from: 60, to: Infinity },
]
function periodForMinute(minute) {
  return PERIODS.find((p) => minute >= p.from && minute < p.to) || PERIODS[PERIODS.length - 1]
}

const FILTERS = [
  { key: 'all', label: 'Alle', test: () => true },
  { key: 'goal', label: 'Tore', test: (e) => e.type === 'goal' },
  { key: 'penalty', label: 'Strafen', test: (e) => e.type === 'penalty' },
]

export default function LiveGameTimeline({ homeTeam, awayTeam, events, sourceLabel = 'Demo-Daten' }) {
  const [filter, setFilter] = useState('all')

  // Chronologisch aufsteigend sortieren und laufenden Score je Tor mitführen
  // (für die Live-Ticker-Anzeige "2:0", "2:1", ...) - rein clientseitig aus
  // den Demo-Events abgeleitet, keine neue Datenquelle.
  const withScore = useMemo(() => {
    const sorted = [...events].sort((a, b) => a.minute - b.minute)
    let h = 0, a = 0
    return sorted.map((e) => {
      if (e.type === 'goal') {
        if (e.side === 'home') h++
        else a++
      }
      return { ...e, scoreAfter: e.type === 'goal' ? `${h}:${a}` : null }
    })
  }, [events])

  const counts = useMemo(() => ({
    all: withScore.length,
    goal: withScore.filter((e) => e.type === 'goal').length,
    penalty: withScore.filter((e) => e.type === 'penalty').length,
  }), [withScore])

  const activeTest = FILTERS.find((f) => f.key === filter).test
  const filtered = withScore.filter(activeTest)

  return (
    <div className="card card-pad live-section">
      <div className="row spread live-section-head">
        <h2 style={{ fontSize: 13 }}>Events</h2>
        <span className="chip" style={{ color: 'var(--text-dim)', fontSize: 10 }}>{sourceLabel}</span>
      </div>

      <div className="live-events-filter">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={'live-events-filter-btn' + (filter === f.key ? ' active' : '')}
            onClick={() => setFilter(f.key)}
          >
            {f.label} <span>{counts[f.key]}</span>
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="muted" style={{ fontSize: 12.5, padding: '8px 0' }}>Keine Ereignisse in dieser Kategorie.</div>
      ) : (
        <div className="live-ticker">
          {filtered.map((e, i) => {
            const team = e.side === 'home' ? homeTeam : awayTeam
            const prevPeriod = i > 0 ? periodForMinute(filtered[i - 1].minute).label : null
            const period = periodForMinute(e.minute).label
            return (
              <Fragment key={i}>
                {period !== prevPeriod && <div className="live-ticker-period">{period}</div>}
                <div className={'live-ticker-row ' + e.type}>
                  <span className="live-ticker-time">{formatClock(e.minute)}</span>
                  <span className="live-ticker-icon">{EVENT_ICON[e.type] || '•'}</span>
                  <span className="live-ticker-team" style={{ color: team.color }}>{team.short}</span>
                  {e.scoreAfter && <span className="live-ticker-score">{e.scoreAfter}</span>}
                  {/* Nur Anzeige-Kürzung ("Tor · " ist bei Icon+Score redundant) -
                      die Demo-Daten selbst (liveDemoData.js) bleiben unverändert. */}
                  <span className="live-ticker-text">{e.type === 'goal' ? e.text.replace(/^Tor\s*·\s*/, '') : e.text}</span>
                </div>
              </Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}

import { useData } from '../DataContext.jsx'
import { TeamBadge } from '../components/ui.jsx'

export default function EloRanking() {
  const { data, derived } = useData()
  const { ranking, history, ratings } = derived.elo
  const start = data.settings.eloStart
  const maxRating = Math.max(...ranking.map((r) => r.rating), start + 60)
  const minRating = Math.min(...ranking.map((r) => r.rating), start - 60)

  // Für die Seite relevante Settings
  const homeAdv = data.settings.eloHomeAdvantage || 50

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ELO-Ranking</h1>
          <div className="sub">
            Start {start} · Heimvorteil +{homeAdv}
            <br />
            <span style={{ fontSize: '0.85rem', color: 'var(--text-faint)' }}>
              Dynamischer K-Faktor · Torunterschied-Gewichtung · OT/SO-Unterscheidung · Form-Modifier
            </span>
          </div>
          {derived.eloPriorSource === 'marketValue' && (
            <span className="chip" style={{ fontSize: 10.5, marginTop: 4 }} title="Start-ELOs dieser Saison aus der Summe der Kader-Marktwerte abgeleitet (Einstellungen → Prognose-Erweiterungen)">
              Vorsaison-Prior aus Marktwert
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card card-pad" style={{ gridColumn: '1 / -1' }}>
          <h2>ELO-Verlauf</h2>
          <EloChart history={history} teams={data.teams} start={start} />
        </div>

        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">#</th>
                  <th className="left">Team</th>
                  <th className="num">SP</th>
                  <th className="num">ELO</th>
                  <th className="num" title="Veränderung seit letztem Spiel">Δ 1</th>
                  <th className="num" title="Veränderung über letzte 5 Spiele">Δ 5</th>
                  <th className="left" style={{ width: '25%' }}>Relativ</th>
                  <th className="num">Δ Start</th>
                </tr>
              </thead>
              <tbody>
                {ranking.map((r, i) => {
                  const diff = r.rating - start
                  const pct = ((r.rating - minRating) / (maxRating - minRating || 1)) * 100
                  const deltaColor = (v) =>
                    v > 0 ? 'var(--good)' : v < 0 ? 'var(--bad)' : 'inherit'
                  return (
                    <tr key={r.team.id}>
                      <td className="left rank">{i + 1}</td>
                      <td className="left"><TeamBadge team={r.team} /></td>
                      <td className="num">{r.games}</td>
                      <td className="num"><strong>{r.rating}</strong></td>
                      <td className="num" style={{ color: deltaColor(r.deltaLast), fontSize: '0.9rem' }}>
                        {r.deltaLast > 0 ? '+' : ''}{r.deltaLast}
                      </td>
                      <td className="num" style={{ color: deltaColor(r.deltaLast5), fontSize: '0.9rem' }}>
                        {r.deltaLast5 > 0 ? '+' : ''}{r.deltaLast5}
                      </td>
                      <td className="left">
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: pct + '%', background: r.team.color }} />
                        </div>
                      </td>
                      <td className="num" style={{ color: deltaColor(diff) }}>
                        {diff > 0 ? '+' + diff : diff}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  )
}

// Einfaches SVG-Liniendiagramm des ELO-Verlaufs aller Teams.
function EloChart({ history, teams, start }) {
  const maxSteps = Math.max(1, ...teams.map((t) => (history[t.id]?.length || 1) - 1))
  if (maxSteps < 1) {
    return <div className="muted" style={{ padding: '30px 0' }}>Sobald Spiele erfasst sind, erscheint hier der Verlauf.</div>
  }

  const W = 900, H = 300, pad = { l: 44, r: 12, t: 12, b: 22 }
  const allRatings = teams.flatMap((t) => (history[t.id] || []).map((p) => p.rating))
  const min = Math.min(...allRatings, start - 40)
  const max = Math.max(...allRatings, start + 40)
  const x = (i) => pad.l + (i / maxSteps) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b)

  const yTicks = 4
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => Math.round(min + ((max - min) * i) / yTicks))

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 560 }}>
        {ticks.map((tk) => (
          <g key={tk}>
            <line x1={pad.l} x2={W - pad.r} y1={y(tk)} y2={y(tk)} stroke="var(--border)" />
            <text x={pad.l - 8} y={y(tk) + 4} fontSize="11" fill="var(--text-dim)" textAnchor="end">{tk}</text>
          </g>
        ))}
        <line x1={pad.l} x2={W - pad.r} y1={y(start)} y2={y(start)} stroke="var(--border-strong)" strokeDasharray="4 4" />
        {teams.map((t) => {
          const pts = history[t.id] || []
          if (pts.length < 2) return null
          const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.index)},${y(p.rating)}`).join(' ')
          return <path key={t.id} d={d} fill="none" stroke={t.color} strokeWidth="2" opacity="0.9" />
        })}
      </svg>
      <div className="row wrap gap-sm mt" style={{ gap: 12 }}>
        {teams.map((t) => (
          <span key={t.id} className="row gap-sm" style={{ fontSize: 12 }}>
            <span className="dot" style={{ background: t.color }} />{t.short}
          </span>
        ))}
      </div>
    </div>
  )
}

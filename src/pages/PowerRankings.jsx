import { useMemo } from 'react'
import { useData } from '../DataContext.jsx'
import { computePowerRankings, POWER_CONFIG } from '../powerRankings.js'
import { TeamBadge } from '../components/ui.jsx'

function RatingBar({ value, label }) {
  return (
    <div className="row" style={{ fontSize: 12.5, marginBottom: 7 }}>
      <span className="muted" style={{ minWidth: 72 }}>{label}</span>
      <div className="bar-track" style={{ flex: 1 }}>
        <div className="bar-fill" style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
      <strong style={{ minWidth: 28, textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5 }}>
        {Math.round(value)}
      </strong>
    </div>
  )
}

export default function PowerRankings() {
  const { data, derived } = useData()

  const rankings = useMemo(() => {
    if (!data?.teams || !data?.games || !derived?.elo?.ratings) return []
    return computePowerRankings(data.teams, data.games, derived.elo.ratings, data.players || [])
  }, [data, derived])

  if (!rankings.length) {
    return (
      <div className="card card-pad">
        <div className="muted">Noch keine Spiele erfasst.</div>
      </div>
    )
  }

  const weights = POWER_CONFIG.weights
  const w = POWER_CONFIG.strengthWeights

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Power Ranking</h1>
          <div className="sub">
            Siegkraft {Math.round(weights.strength * 100)}% (ELO {Math.round(w.elo * 100)}% + Pts/Sp {Math.round(w.pointsPerGame * 100)}% + Win% {Math.round(w.winRate * 100)}%)
            {' '}· Offensive {Math.round(weights.offense * 100)}% · Defensive {Math.round(weights.defense * 100)}% · Form {Math.round(weights.form * 100)}%
          </div>
          {derived.eloPriorSource === 'marketValue' && (
            <span className="chip" style={{ fontSize: 10.5, marginTop: 4 }} title="Start-ELOs dieser Saison aus der Summe der Kader-Marktwerte abgeleitet (Einstellungen → Prognose-Erweiterungen)">
              Vorsaison-Prior aus Marktwert
            </span>
          )}
        </div>
      </div>

      <div className="card mb">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="left">#</th>
                <th className="left">Team</th>
                <th className="num">Power</th>
                <th className="num">ELO</th>
                <th className="num">OFF</th>
                <th className="num">DEF</th>
                <th className="num">Form</th>
                <th className="num">Pts/Sp</th>
                <th className="left">Letzte 5</th>
              </tr>
            </thead>
            <tbody>
              {rankings.map((r, i) => (
                <tr key={r.team.id}>
                  <td className="left rank">{i + 1}</td>
                  <td className="left"><TeamBadge team={r.team} /></td>
                  <td className="num"><strong>{r.powerScore}</strong></td>
                  <td className="num">{Math.round(r.elo)}</td>
                  <td className="num">{r.components.offense}</td>
                  <td className="num">{r.components.defense}</td>
                  <td className="num">{r.components.form}</td>
                  <td className="num">{r.ptsPerGame.toFixed(2)}</td>
                  <td className="left" style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                    {r.recentForm.map((res, j) => (
                      <span key={j} className={res.startsWith('W') ? 'good' : 'bad'} style={{ marginRight: 3, fontWeight: 700 }}>
                        {res}
                      </span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section-label">Detaillierte Auswertung</div>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
        {rankings.map((r) => (
          <div key={r.team.id} className="card card-pad">
            <div className="row spread mb">
              <span className="row gap-sm">
                <TeamBadge team={r.team} />
              </span>
              <span className="muted" style={{ fontSize: 12 }}>{r.gp} SP · {r.w}-{r.otw}-{r.otl}-{r.l}</span>
            </div>

            <div className="row spread" style={{ paddingBottom: 12, marginBottom: 10, borderBottom: '1px solid var(--border)' }}>
              <span className="muted" style={{ fontSize: 12.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>Power Score</span>
              <strong style={{ fontSize: 18, fontFamily: 'var(--mono)' }}>{r.powerScore}</strong>
            </div>

            <RatingBar value={r.components.strength} label="Siegkraft" />
            <RatingBar value={r.components.offense} label="Offensive" />
            <RatingBar value={r.components.defense} label="Defensive" />
            <RatingBar value={r.components.form} label="Form" />

            <div className="grid grid-2" style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', fontSize: 12.5, gap: 8 }}>
              <div><span className="muted">ELO:</span> <strong>{Math.round(r.elo)}</strong></div>
              <div><span className="muted">Pts/Sp:</span> <strong>{r.ptsPerGame.toFixed(2)}</strong></div>
              <div><span className="muted">Tore/Sp:</span> <strong>{r.gpg.toFixed(2)}</strong></div>
              <div><span className="muted">GA/Sp:</span> <strong>{r.gag.toFixed(2)}</strong></div>
              <div><span className="muted">Punkte:</span> <strong>{r.pts}</strong></div>
              <div><span className="muted">Tor-Diff:</span> <strong className={r.gf - r.ga > 0 ? 'good' : r.gf - r.ga < 0 ? 'bad' : ''}>{r.gf - r.ga > 0 ? '+' : ''}{r.gf - r.ga}</strong></div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

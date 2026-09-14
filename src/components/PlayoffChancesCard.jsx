import { Link } from 'react-router-dom'
import { TeamBadge, SectionHeader } from './ui.jsx'

const ROUNDS = [
  { key: 'pPlayoffs', short: 'VF', title: 'Viertelfinal', intensity: 1 },
  { key: 'pSemifinal', short: 'HF', title: 'Halbfinal', intensity: 0.78 },
  { key: 'pFinal', short: 'F', title: 'Final', intensity: 0.6 },
]

function fmtPct(v) {
  if (v == null) return '–'
  const pct = v * 100
  return (pct < 10 ? pct.toFixed(1) : Math.round(pct)) + '%'
}

// MoneyPuck-artige Playoff-Chancen-Karte: eine Zeile pro Team, drei pill-
// shaped Balken (Viertelfinal/Halbfinal/Final erreicht) in Teamfarbe, mit
// leicht abgestufter Intensität zwischen den Runden (VF voll, Final am
// hellsten) - bewusst KEINE Tabelle (keine Zeilenlinien/Zellrahmen), stark
// abgerundete Karte statt der sonst im Projekt üblichen scharfkantigen
// .table-wrap-Tabellen. `rows`: [{ team, pPlayoffs, pSemifinal, pFinal }].
export default function PlayoffChancesCard({ rows, updatedLabel }) {
  return (
    <div className="playoff-chances-card mb">
      <SectionHeader
        title="Playoff-Chancen"
        caption={`Wahrscheinlichkeit, die jeweilige Runde zu erreichen${updatedLabel ? ` · ${updatedLabel}` : ''}.`}
        action={<Link className="btn ghost sm" to="/playoff-odds">Alle →</Link>}
      />

      <div className="pc-head" style={{ marginTop: 10 }}>
        <span></span>
        {ROUNDS.map((r) => <span key={r.key} title={r.title}>{r.short}</span>)}
      </div>
      <div className="pc-divider" />

      {rows.map(({ team, ...probs }) => (
        <div key={team.id} className="pc-row">
          <TeamBadge team={team} short />
          {ROUNDS.map((r) => {
            const v = probs[r.key]
            const pct = v == null ? 0 : Math.max(0, Math.min(1, v)) * 100
            return (
              <div key={r.key} className="pc-cell">
                <div className="pc-bar-track">
                  <div
                    className="pc-bar-fill"
                    style={{ width: `${pct}%`, background: team.color, opacity: r.intensity }}
                  />
                </div>
                <span className="pc-value">{fmtPct(v)}</span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

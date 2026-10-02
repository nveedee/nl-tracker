import { SectionHeader } from './ui.jsx'

// Tore/Schüsse pro Drittel (Game Center, src/gameCenter.js::getPeriodBreakdown) -
// dasselbe Bar-Zeilenmuster wie GoalProbabilities.jsx (.gp-*-Klassen), hier
// mit absoluten Zählwerten statt Prozent-Wahrscheinlichkeiten je Drittel.
function Block({ title, rows, valueKey, homeTeam, awayTeam }) {
  const values = rows.map((r) => r[valueKey]).filter((v) => v != null)
  if (values.length === 0) return null
  const max = Math.max(1, ...values)
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="muted" style={{ fontSize: 11.5, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: 6 }}>{title}</div>
      <div className="gp-head">
        <span />
        <span className="gp-head-team" style={{ color: homeTeam.color }}>{homeTeam.short}</span>
        <span className="gp-head-team" style={{ color: awayTeam.color }}>{awayTeam.short}</span>
      </div>
      {rows.map((r) => {
        const home = valueKey === 'homeGoals' ? r.homeGoals : r.homeShots
        const away = valueKey === 'homeGoals' ? r.awayGoals : r.awayShots
        if (home == null && away == null) return null
        return (
          <div className="gp-row" key={r.indicator}>
            <span className="gp-bucket" title={r.label}>{periodShortLabel(r.label, r.indicator)}</span>
            <span className="gp-bar-cell">
              <span className="gp-bar-track">
                <span className="gp-bar-fill" style={{ width: `${((home ?? 0) / max) * 100}%`, background: homeTeam.color }} />
              </span>
              <span className="gp-pct">{home ?? '–'}</span>
            </span>
            <span className="gp-bar-cell">
              <span className="gp-bar-track">
                <span className="gp-bar-fill" style={{ width: `${((away ?? 0) / max) * 100}%`, background: awayTeam.color }} />
              </span>
              <span className="gp-pct">{away ?? '–'}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function periodShortLabel(label, indicator) {
  if (/^\d+$/.test(indicator)) return indicator + '.'
  if (indicator?.startsWith('OT')) return 'OT'
  if (indicator === 'SO' || /shootout/i.test(label || '')) return 'SO'
  return label?.slice(0, 4) || indicator
}

export default function PeriodBreakdown({ homeTeam, awayTeam, periods }) {
  if (!periods || periods.length === 0 || !homeTeam || !awayTeam) return null
  return (
    <div className="card card-pad mb">
      <SectionHeader title="Verlauf nach Drittel" />
      <Block title="Tore pro Drittel" rows={periods} valueKey="homeGoals" homeTeam={homeTeam} awayTeam={awayTeam} />
      <Block title="Schüsse pro Drittel" rows={periods} valueKey="homeShots" homeTeam={homeTeam} awayTeam={awayTeam} />
    </div>
  )
}

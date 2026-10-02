// Formverlauf-Sparkline (Game Center, Auftrag Punkt 3) - kumulierte Punkte
// über die letzten N Spiele je Team, aus bereits vorhandenen Form-Daten
// (computeRecentFormDetailed, chronologisch aufsteigend übergeben). Keine
// neue Kennzahl - nur eine Linie durch bereits angezeigte Punktwerte.
// Teamfarben sind die bestehenden, app-weiten Markenfarben (homeTeam.color/
// awayTeam.color, siehe ExpectedGoals.jsx etc.), keine neue Palette.
const WIDTH = 280
const HEIGHT = 64
const PAD = 6

function cumulativePoints(games, teamId) {
  let sum = 0
  const pts = []
  for (const g of games) {
    const isHome = g.homeTeamId === teamId
    const won = (isHome ? g.homeGoals : g.awayGoals) > (isHome ? g.awayGoals : g.homeGoals)
    const overtime = g.decision === 'OT' || g.decision === 'SO'
    sum += won ? (overtime ? 2 : 3) : (overtime ? 1 : 0)
    pts.push(sum)
  }
  return pts
}

function buildPoints(values) {
  if (values.length === 0) return { points: [], path: '' }
  const max = Math.max(1, ...values)
  const n = values.length
  const points = values.map((v, i) => {
    const x = n === 1 ? WIDTH / 2 : PAD + (i / (n - 1)) * (WIDTH - PAD * 2)
    const y = HEIGHT - PAD - (v / max) * (HEIGHT - PAD * 2)
    return [x, y]
  })
  const path = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  return { points, path }
}

export default function FormSparkline({ homeTeam, awayTeam, homeGames, awayGames }) {
  if (!homeTeam || !awayTeam) return null
  const homeValues = cumulativePoints(homeGames || [], homeTeam.id)
  const awayValues = cumulativePoints(awayGames || [], awayTeam.id)
  if (homeValues.length === 0 && awayValues.length === 0) return null

  const home = buildPoints(homeValues)
  const away = buildPoints(awayValues)

  return (
    <div>
      <div className="row gap-sm" style={{ marginBottom: 6, fontSize: 11.5 }}>
        <span className="row gap-sm" style={{ alignItems: 'center' }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: homeTeam.color, display: 'inline-block' }} />
          <span className="muted">{homeTeam.short}</span>
        </span>
        <span className="row gap-sm" style={{ alignItems: 'center' }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: awayTeam.color, display: 'inline-block' }} />
          <span className="muted">{awayTeam.short}</span>
        </span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} width="100%" height={HEIGHT} role="img" aria-label="Formverlauf (kumulierte Punkte)">
        <line x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} stroke="var(--border)" strokeWidth="1" />
        {home.path && (
          <path d={home.path} fill="none" stroke={homeTeam.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {away.path && (
          <path d={away.path} fill="none" stroke={awayTeam.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        )}
        {home.points.map(([x, y], i) => (
          <circle key={'h' + i} cx={x} cy={y} r="2.5" fill={homeTeam.color}>
            <title>{`${homeTeam.short}: ${homeValues[i]} Pkt. (Spiel ${i + 1})`}</title>
          </circle>
        ))}
        {away.points.map(([x, y], i) => (
          <circle key={'a' + i} cx={x} cy={y} r="2.5" fill={awayTeam.color}>
            <title>{`${awayTeam.short}: ${awayValues[i]} Pkt. (Spiel ${i + 1})`}</title>
          </circle>
        ))}
      </svg>
    </div>
  )
}

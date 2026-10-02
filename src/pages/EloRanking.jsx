import { useState } from 'react'
import { useData } from '../DataContext.jsx'
import { TeamBadge } from '../components/ui.jsx'

const fmtD = (v) => (v > 0 ? '+' + v : String(v))

export default function EloRanking() {
  const { data, derived } = useData()
  const { ranking, history } = derived.elo
  const start = data.settings.eloStart
  const maxRating = Math.max(...ranking.map((r) => r.rating), start + 60)
  const minRating = Math.min(...ranking.map((r) => r.rating), start - 60)

  // Für die Seite relevante Settings
  const homeAdv = data.settings.eloHomeAdvantage || 50

  const gps = ranking.map((r) => r.games)
  const minGp = Math.min(...gps)
  const maxGp = Math.max(...gps)

  // Start-ELO = erster Verlaufseintrag (history[0]) = tatsächlicher Startwert
  // des Teams inkl. Vorsaison-Prior - gleiche Definition wie "seit
  // Saisonstart" auf dem Dashboard. Keine neue Berechnung, nur Lesen des
  // bestehenden Verlaufs. (Das frühere "Δ Start" rechnete gegen den
  // einheitlichen Referenzwert 1500, obwohl Teams mit Prior anders starten.)
  const rows = ranking.map((r) => {
    const startElo = history[r.team.id]?.[0]?.rating
    return {
      ...r,
      startElo: startElo != null ? Math.round(startElo) : null,
      sinceStart: startElo != null ? r.rating - Math.round(startElo) : null,
    }
  })
  const movers = rows.filter((r) => r.games > 0 && r.sinceStart != null)
  const risers = movers.filter((r) => r.sinceStart > 0).sort((a, b) => b.sinceStart - a.sinceStart).slice(0, 3)
  const fallers = movers.filter((r) => r.sinceStart < 0).sort((a, b) => a.sinceStart - b.sinceStart).slice(0, 3)

  const priorLabel =
    derived.eloPriorSource === 'marketValue' ? 'Start-ELO pro Team aus Kader-Marktwert (Vorsaison-Prior)'
      : derived.eloPriorSource === 'historicalArchive' ? 'Start-ELO pro Team aus Vorsaison-Archiv'
        : 'Alle Teams starten beim Referenzwert'

  return (
    <>
      <div className="page-head">
        <div>
          <h1>ELO-Ranking</h1>
          <div className="sub">
            Referenzwert {start} · Heimvorteil +{homeAdv} · Aktueller Stand nach {minGp}–{maxGp} Spielen pro Team
          </div>
          {derived.eloPriorSource === 'marketValue' && (
            <span className="chip" style={{ fontSize: 10.5, marginTop: 4 }} title="Start-ELOs dieser Saison aus der Summe der Kader-Marktwerte abgeleitet (Einstellungen → Prognose-Erweiterungen)">
              Vorsaison-Prior aus Marktwert
            </span>
          )}
        </div>
      </div>

      <div className="card card-pad mb" style={{ fontSize: 13, lineHeight: 1.55 }}>
        <strong>Was ist ELO?</strong> ELO misst die relative Teamstärke: {start} ist der Referenzwert, höhere Werte bedeuten eine höhere modellierte Stärke, und nach jedem Spiel verschiebt sich der Wert. ELO ist <strong>keine Gewinnwahrscheinlichkeit</strong> und nicht mit dem Power Score identisch.
        <details style={{ marginTop: 8 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12.5 }}>ⓘ Modellparameter</summary>
          <ul className="muted" style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12.5 }}>
            <li>Referenzwert: {start}</li>
            <li>Heimvorteil: +{homeAdv}</li>
            <li>Dynamischer K-Faktor</li>
            <li>Torunterschied wird berücksichtigt</li>
            <li>OT/SO wird separat behandelt</li>
            <li>Form-Modifikator aktiv</li>
            <li>{priorLabel}</li>
          </ul>
        </details>
      </div>

      <div className="grid grid-2">
        <div className="card card-pad" style={{ gridColumn: '1 / -1', minWidth: 0 }}>
          <h2>ELO-Verlauf</h2>
          <EloChart history={history} teams={data.teams} ranking={ranking} start={start} />
        </div>

        {(risers.length > 0 || fallers.length > 0) && (
          <div style={{ gridColumn: '1 / -1', minWidth: 0 }}>
            <div className="section-label">Stärkste ELO-Veränderungen seit Saisonstart</div>
            <div className="muted" style={{ fontSize: 12, margin: '2px 0 8px' }}>Basierend auf dem aktuellen Saisonstand ({minGp}–{maxGp} Spiele pro Team) · kleine Stichprobe zu Saisonbeginn</div>
            <div className="grid grid-2">
            {[['📈 Stärkste Zuwächse', risers, 'good'], ['📉 Stärkste Rückgänge', fallers, 'bad']].map(([title, list, cls]) => (
              <div key={title} className="card card-pad">
                <div className="section-label" style={{ marginBottom: 6 }}>
                  {title}
                </div>
                {list.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12.5 }}>–</div>
                ) : list.map((r) => (
                  <div key={r.team.id} className="row spread" style={{ padding: '5px 0' }}>
                    <TeamBadge team={r.team} />
                    <strong className={cls} style={{ fontFamily: 'var(--mono)' }}>{fmtD(r.sinceStart)}</strong>
                  </div>
                ))}
              </div>
            ))}
            </div>
          </div>
        )}

        <div className="card" style={{ gridColumn: '1 / -1', minWidth: 0 }}>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">#</th>
                  <th className="left">Team</th>
                  <th className="num" title="Gespielte Spiele (Basis des ELO)">SP</th>
                  <th className="num">ELO</th>
                  <th className="num" title="Veränderung seit letztem Spiel">Δ 1 Spiel</th>
                  <th className="num" title="Veränderung über letzte 5 Spiele">Δ 5 Spiele</th>
                  <th className="left" style={{ width: '22%' }} title="Balkenlänge = Position innerhalb der aktuellen ELO-Spanne der Liga. Keine Prozentzahl und keine Gewinnwahrscheinlichkeit.">Liga-Position</th>
                  <th className="num" title="Tatsächlicher Start-ELO des Teams zu Saisonbeginn (inkl. Vorsaison-Prior)">Start-ELO</th>
                  <th className="num" title="Aktuelles ELO minus Start-ELO des Teams">Δ seit Start</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => {
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
                      <td className="num muted">{r.startElo ?? '–'}</td>
                      <td className="num" style={{ color: deltaColor(r.sinceStart) }}>
                        {r.sinceStart == null ? '–' : fmtD(r.sinceStart)}
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

// SVG-Liniendiagramm des ELO-Verlaufs. Die Legende ist zugleich Team-Auswahl:
// Klick schaltet Teams ein/aus (keine Auswahl = alle Teams gleichwertig,
// sonst werden nicht gewählte Linien stark abgeschwächt). Voreinstellungen:
// Alle / Top 5 (nach aktuellem ELO) / Kloten.
function EloChart({ history, teams, ranking, start }) {
  // Standard: Top 5 nach aktuellem ELO (übersichtlicher als 14 Linien)
  const [selected, setSelected] = useState(() => ranking.slice(0, 5).map((r) => r.team.id))

  // x = globaler Spielschritt (p.index, chronologisch über die ganze Liga) -
  // die Skala muss daher am höchsten Index enden, nicht an der Spielzahl eines Teams.
  const maxSteps = Math.max(0, ...teams.flatMap((t) => (history[t.id] || []).map((p) => p.index)))
  if (maxSteps < 1) {
    return <div className="muted" style={{ padding: '30px 0' }}>Sobald Spiele erfasst sind, erscheint hier der Verlauf.</div>
  }

  const W = 900, H = 300, pad = { l: 48, r: 60, t: 12, b: 24 }
  const allRatings = teams.flatMap((t) => (history[t.id] || []).map((p) => p.rating))
  const min = Math.min(...allRatings, start - 40)
  const max = Math.max(...allRatings, start + 40)
  const x = (i) => pad.l + (i / maxSteps) * (W - pad.l - pad.r)
  const y = (v) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b)

  const yTicks = 4
  const ticks = Array.from({ length: yTicks + 1 }, (_, i) => Math.round(min + ((max - min) * i) / yTicks))

  const hasSel = selected.length > 0
  const isSel = (id) => selected.includes(id)
  const toggle = (id) => setSelected((cur) => (cur.includes(id) ? cur.filter((c) => c !== id) : [...cur, id]))
  const top5 = ranking.slice(0, 5).map((r) => r.team.id)
  const kloten = teams.find((t) => t.id === 'team_klo')
  const sameSel = (ids) => ids.length === selected.length && ids.every((id) => selected.includes(id))

  return (
    <div>
      <div className="row wrap gap-sm" style={{ gap: 6, marginBottom: 10 }}>
        <button className={`btn sm ${sameSel(top5) ? '' : 'ghost'}`} onClick={() => setSelected(top5)}>Top 5</button>
        <button className={`btn sm ${!hasSel ? '' : 'ghost'}`} onClick={() => setSelected([])}>Alle</button>
        {kloten && (
          <button className={`btn sm ${sameSel([kloten.id]) ? '' : 'ghost'}`} onClick={() => setSelected([kloten.id])}>Kloten</button>
        )}
      </div>

      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 520 }}>
          {ticks.map((tk) => (
            <g key={tk}>
              <line x1={pad.l} x2={W - pad.r} y1={y(tk)} y2={y(tk)} stroke="var(--border)" />
              <text x={pad.l - 8} y={y(tk) + 4} fontSize="12" fill="var(--text-dim)" textAnchor="end">{tk}</text>
            </g>
          ))}
          <line x1={pad.l} x2={W - pad.r} y1={y(start)} y2={y(start)} stroke="var(--text-dim)" strokeWidth="1.5" strokeDasharray="5 4" />
          <text x={pad.l + 6} y={y(start) - 5} fontSize="12" fill="var(--text-dim)">{start} = Referenzwert</text>
          {teams.map((t) => {
            const pts = history[t.id] || []
            if (pts.length < 2) return null
            const active = !hasSel || isSel(t.id)
            const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.index)},${y(p.rating)}`).join(' ')
            return (
              <path
                key={t.id} d={d} fill="none" stroke={t.color}
                strokeWidth={hasSel && active ? 3 : 2}
                opacity={active ? 0.95 : 0.1}
              />
            )
          })}
          {hasSel && teams.filter((t) => isSel(t.id) && (history[t.id] || []).length >= 2).map((t) => {
            const pts = history[t.id]
            const last = pts[pts.length - 1]
            return (
              <text key={t.id} x={x(last.index) + 5} y={y(last.rating) + 4} fontSize="12" fontWeight="700" fill={t.color}>
                {t.short} {Math.round(last.rating)}
              </text>
            )
          })}
        </svg>
      </div>

      <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
        X-Achse: Ligaspiele in chronologischer Reihenfolge · gestrichelt: Referenzwert {start} · höher = stärkere modellierte Teamstärke
      </div>
      <div className="row wrap gap-sm mt" style={{ gap: 8 }}>
        {teams.map((t) => {
          const active = !hasSel || isSel(t.id)
          return (
            <button
              key={t.id} onClick={() => toggle(t.id)} aria-pressed={isSel(t.id)}
              className="row gap-sm"
              style={{
                padding: '4px 8px', borderRadius: 999, cursor: 'pointer', font: 'inherit', fontSize: 12,
                border: `1px solid ${isSel(t.id) ? t.color : 'var(--border)'}`,
                background: 'transparent', color: 'var(--text)', opacity: active ? 1 : 0.4,
              }}
            >
              <span className="dot" style={{ background: t.color }} />{t.short}
            </button>
          )
        })}
      </div>
    </div>
  )
}

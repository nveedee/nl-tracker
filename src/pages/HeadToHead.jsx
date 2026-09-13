import { useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge } from '../components/ui.jsx'
import { computeStandings } from '../stats.js'
import { computePowerRankings } from '../powerRankings.js'
import { homeWinProbability, ELO_CONFIG } from '../elo.js'
import {
  mergeMatchups, summarizeRecord, summarizeHomeAway,
  computeRecentFormDetailed, computeShotsAllowedPerGame, useHistoricalH2H,
} from '../headToHead.js'

function fmt1(v) { return v == null ? '–' : v.toFixed(1) }
function fmt2(v) { return v == null ? '–' : v.toFixed(2) }
function fmtPct(v) { return v == null ? '–' : (v * 100).toFixed(0) + '%' }

const BADGE_STYLE = {
  S: { bg: 'var(--good)', label: 'S' },
  OTS: { bg: 'var(--good)', label: 'OTS' },
  SOS: { bg: 'var(--good)', label: 'SOS' },
  N: { bg: 'var(--bad)', label: 'N' },
  OTN: { bg: 'var(--bad)', label: 'OTN' },
  SON: { bg: 'var(--bad)', label: 'SON' },
}

function ResultBadge({ code }) {
  const s = BADGE_STYLE[code] || { bg: 'var(--text-dim)', label: code }
  return (
    <span style={{
      display: 'inline-block', minWidth: 30, textAlign: 'center', padding: '2px 6px',
      borderRadius: 5, fontSize: 11, fontWeight: 700, color: '#fff', background: s.bg,
    }}>
      {s.label}
    </span>
  )
}

function StatTile({ label, value, color }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12 }}>{label}</div>
      <div style={{ fontWeight: 700, fontSize: 20, color: color || 'inherit' }}>{value}</div>
    </div>
  )
}

// Vergleichsbalken für Sektion 6 (Direkter Vergleich)
function CompareRow({ label, v1, v2, format = fmt2, higherIsBetter = true }) {
  const has1 = v1 != null, has2 = v2 != null
  if (!has1 && !has2) return null
  const max = Math.max(Math.abs(v1 ?? 0), Math.abs(v2 ?? 0)) || 1
  const pct1 = has1 ? Math.min(100, (Math.abs(v1) / max) * 100) : 0
  const pct2 = has2 ? Math.min(100, (Math.abs(v2) / max) * 100) : 0
  const better1 = has1 && has2 ? (higherIsBetter ? v1 > v2 : v1 < v2) : false
  const better2 = has1 && has2 ? (higherIsBetter ? v2 > v1 : v2 < v1) : false
  return (
    <tr>
      <td className="left muted" style={{ fontSize: 13, width: '22%' }}>{label}</td>
      <td style={{ width: '39%', padding: '6px 10px' }}>
        <div className="row gap-sm">
          <strong style={{ minWidth: 46, textAlign: 'right', color: better1 ? 'var(--good)' : 'inherit' }}>{format(v1)}</strong>
          <div className="bar-track" style={{ flex: 1 }}>
            <div className="bar-fill" style={{ width: pct1 + '%', marginLeft: 'auto', background: better1 ? 'var(--good)' : 'var(--text-dim)' }} />
          </div>
        </div>
      </td>
      <td style={{ width: '39%', padding: '6px 10px' }}>
        <div className="row gap-sm">
          <div className="bar-track" style={{ flex: 1 }}>
            <div className="bar-fill" style={{ width: pct2 + '%', background: better2 ? 'var(--good)' : 'var(--text-dim)' }} />
          </div>
          <strong style={{ minWidth: 46, color: better2 ? 'var(--good)' : 'inherit' }}>{format(v2)}</strong>
        </div>
      </td>
    </tr>
  )
}

export default function HeadToHead() {
  const { data, derived } = useData()
  const historical = useHistoricalH2H()
  const [searchParams] = useSearchParams()
  // Vorauswahl per URL (z.B. von der Match-Detailseite: /head-to-head?team1=X&team2=Y)
  const [team1Id, setTeam1Id] = useState(searchParams.get('team1') || '')
  const [team2Id, setTeam2Id] = useState(searchParams.get('team2') || '')

  const teams = useMemo(() => [...(data?.teams || [])].sort((a, b) => a.name.localeCompare(b.name)), [data])
  const team1 = data?.teams?.find((t) => t.id === team1Id)
  const team2 = data?.teams?.find((t) => t.id === team2Id)
  const valid = team1Id && team2Id && team1Id !== team2Id
  const loadingHistorical = historical === null

  const analysis = useMemo(() => {
    if (!valid || !data || loadingHistorical) return null

    const players = data.players || []
    const eloRatings = derived.elo.ratings
    const eloStart = data.settings?.eloStart ?? ELO_CONFIG.eloStart
    const homeAdv = data.settings?.eloHomeAdvantage ?? ELO_CONFIG.homeAdvantage

    const standings = computeStandings(data.teams, data.games)
    const power = computePowerRankings(data.teams, data.games, eloRatings, players)
    const standingsByTeam = Object.fromEntries(standings.map((s, i) => [s.team.id, { ...s, rank: i + 1 }]))
    const powerByTeam = Object.fromEntries(power.map((p) => [p.team.id, p]))

    const allMatchups = mergeMatchups(team1Id, team2Id, data.games, historical)
    const currentSeasonMatchups = allMatchups.filter((g) => g.isCurrentSeason)
    const hasCurrentSeasonH2H = currentSeasonMatchups.length > 0
    const hasAnyH2H = allMatchups.length > 0

    const overall = hasAnyH2H ? {
      t1: summarizeRecord(team1Id, allMatchups),
      t2: summarizeRecord(team2Id, allMatchups),
    } : null

    const last10 = [...allMatchups].slice(-10).reverse()
    const homeAway = hasAnyH2H ? summarizeHomeAway(team1Id, team2Id, allMatchups) : null

    const form1 = computeRecentFormDetailed(team1Id, data.games, historical, 5)
    const form2 = computeRecentFormDetailed(team2Id, data.games, historical, 5)

    const sog1 = computeShotsAllowedPerGame(team1Id, data.games, players)
    const sog2 = computeShotsAllowedPerGame(team2Id, data.games, players)

    const s1 = standingsByTeam[team1Id]
    const s2 = standingsByTeam[team2Id]

    // ELO-Modellprognose (klar gekennzeichnet, keine reale Wahrscheinlichkeit) -
    // bestehende, unveränderte Funktion aus src/elo.js.
    const pTeam1Home = homeWinProbability(eloRatings[team1Id] ?? eloStart, eloRatings[team2Id] ?? eloStart, homeAdv)
    const pTeam2Home = homeWinProbability(eloRatings[team2Id] ?? eloStart, eloRatings[team1Id] ?? eloStart, homeAdv)

    return {
      standingsByTeam, powerByTeam, s1, s2,
      allMatchups, hasCurrentSeasonH2H, hasAnyH2H, last10, overall, homeAway,
      form1, form2, sog1, sog2, pTeam1Home, pTeam2Home,
    }
  }, [valid, data, derived, historical, team1Id, team2Id, loadingHistorical])

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Head-to-Head</h1>
          <div className="sub">Direktvergleich zweier Teams – aktuelle Saison + historische Duelle, falls vorhanden.</div>
        </div>
      </div>

      {/* 1. Team-Auswahl */}
      <div className="card card-pad mb">
        <div className="grid grid-2">
          <div>
            <label className="field">Team 1</label>
            <select value={team1Id} onChange={(e) => setTeam1Id(e.target.value)}>
              <option value="">– Team wählen –</option>
              {teams.map((t) => <option key={t.id} value={t.id} disabled={t.id === team2Id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="field">Team 2</label>
            <select value={team2Id} onChange={(e) => setTeam2Id(e.target.value)}>
              <option value="">– Team wählen –</option>
              {teams.map((t) => <option key={t.id} value={t.id} disabled={t.id === team1Id}>{t.name}</option>)}
            </select>
          </div>
        </div>
      </div>

      {!valid && (
        <div className="empty">
          <div className="title">Wähle zwei unterschiedliche Teams</div>
          <div className="hint">Danach erscheint hier die vollständige Matchup-Analyse.</div>
        </div>
      )}

      {valid && loadingHistorical && (
        <div className="muted" style={{ padding: '20px 0' }}>Lädt historische Duelle…</div>
      )}

      {valid && analysis && (
        <>
          {/* 2. Team-Vergleich (Übersicht) */}
          <div className="grid grid-2 mb">
            {[[team1, analysis.s1], [team2, analysis.s2]].map(([t, s], i) => {
              const form = i === 0 ? analysis.form1 : analysis.form2
              const power = analysis.powerByTeam[t.id]
              return (
                <div key={t.id} className="card card-pad">
                  <div className="row gap-sm" style={{ marginBottom: 14 }}>
                    <span className="dot" style={{ background: t.color, width: 14, height: 14 }} />
                    <h2 style={{ margin: 0 }}>{t.name}</h2>
                  </div>
                  <div className="tiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                    <div className="tile"><div className="label">ELO</div><div className="value mono">{Math.round(derived.elo.ratings[t.id] ?? 1500)}</div></div>
                    <div className="tile"><div className="label">Power</div><div className="value mono">{power?.powerScore ?? '–'}</div></div>
                    <div className="tile"><div className="label">Rang</div><div className="value mono">{s ? s.rank : '–'}</div></div>
                    <div className="tile"><div className="label">Punkte</div><div className="value mono">{s ? s.pts : '–'}</div></div>
                    <div className="tile"><div className="label">Spiele</div><div className="value mono">{s ? s.gp : '–'}</div></div>
                    <div className="tile">
                      <div className="label">Form (5)</div>
                      <div className="value" style={{ fontSize: 15, display: 'flex', gap: 3, marginTop: 8, flexWrap: 'wrap' }}>
                        {form.letters.length === 0 ? <span className="muted" style={{ fontSize: 13 }}>–</span> : form.letters.map((l, j) => <ResultBadge key={j} code={l} />)}
                      </div>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {!analysis.hasCurrentSeasonH2H && (
            <div className="card card-pad mb" style={{ borderColor: 'var(--warn)' }}>
              <strong>Noch keine direkten Duelle in der Saison {data.settings?.seasonName?.match(/\d{4}\/\d{2}/)?.[0] || 'aktuell'}.</strong>
              {analysis.hasAnyH2H ? (
                <div className="muted mt" style={{ fontSize: 13 }}>Die folgenden Abschnitte zeigen die historische Bilanz aus den verfügbaren historischen Spielen.</div>
              ) : (
                <div className="muted mt" style={{ fontSize: 13 }}>Keine historischen Duelle verfügbar.</div>
              )}
            </div>
          )}

          {analysis.hasAnyH2H && (
            <>
              {/* 3. Gesamtbilanz */}
              <div className="card card-pad mb">
                <h2>Gesamtbilanz{!analysis.hasCurrentSeasonH2H ? ' (historisch)' : ''}</h2>
                <div className="grid grid-2">
                  {[[team1, analysis.overall.t1], [team2, analysis.overall.t2]].map(([t, r]) => (
                    <div key={t.id}>
                      <div className="row gap-sm" style={{ marginBottom: 10 }}>
                        <TeamBadge team={t} link={false} />
                      </div>
                      <div className="tiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                        <StatTile label="Spiele" value={r.gp} />
                        <StatTile label="Siege" value={r.wins} color="var(--good)" />
                        <StatTile label="Niederlagen" value={r.losses} color="var(--bad)" />
                        <StatTile label="Tore" value={r.gf} />
                        <StatTile label="Gegentore" value={r.ga} />
                        <StatTile label="Punkte" value={r.pts} />
                      </div>
                      <div className="muted mt" style={{ fontSize: 12.5 }}>
                        OT: {r.otw}S/{r.otl}N · SO: {r.sow}S/{r.sol}N · Siegquote {fmtPct(r.winRate)} · Ø Tore {fmt2(r.avgGf)} · Ø Diff {r.avgDiff > 0 ? '+' : ''}{fmt2(r.avgDiff)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 4. Letzte Duelle */}
              <div className="card card-pad mb">
                <h2>Letzte {analysis.last10.length} Duelle</h2>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th className="left">Datum</th>
                        <th className="left">Heim</th>
                        <th className="left">Auswärts</th>
                        <th className="num">Ergebnis</th>
                        <th className="left">Entscheidung</th>
                      </tr>
                    </thead>
                    <tbody>
                      {analysis.last10.map((g, i) => {
                        const hTeam = g.homeTeamId === team1Id ? team1 : team2
                        const aTeam = g.awayTeamId === team1Id ? team1 : team2
                        const homeWon = g.homeGoals > g.awayGoals
                        return (
                          <tr key={i}>
                            <td className="left" style={{ fontSize: 13 }}>
                              {new Date(g.date).toLocaleDateString('de-CH')}
                              {!g.isCurrentSeason && <span className="muted" style={{ marginLeft: 6, fontSize: 11 }}>({g.season})</span>}
                            </td>
                            <td className="left" style={{ fontWeight: homeWon ? 700 : 400, color: homeWon ? 'var(--good)' : 'inherit' }}>{hTeam.short}</td>
                            <td className="left" style={{ fontWeight: !homeWon ? 700 : 400, color: !homeWon ? 'var(--good)' : 'inherit' }}>{aTeam.short}</td>
                            <td className="num"><strong>{g.homeGoals}:{g.awayGoals}</strong></td>
                            <td className="left"><span className="chip">{g.decision}</span></td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* 5. Heim/Auswärts */}
              <div className="card card-pad mb">
                <h2>Heim/Auswärts-Bilanz</h2>
                <div className="grid grid-2">
                  {[[team1, analysis.homeAway.team1AtHome, team2], [team2, analysis.homeAway.team2AtHome, team1]].map(([home, r, away]) => (
                    <div key={home.id}>
                      <div className="muted" style={{ fontSize: 13, marginBottom: 8 }}>
                        <strong style={{ color: 'var(--text)' }}>{home.short}</strong> zuhause gegen {away.short}
                      </div>
                      <div className="tiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                        <StatTile label="Spiele" value={r.gp} />
                        <StatTile label="Siege" value={r.wins} color="var(--good)" />
                        <StatTile label="Niederlagen" value={r.losses} color="var(--bad)" />
                        <StatTile label="Tore" value={r.gf} />
                        <StatTile label="Ø Tore" value={fmt2(r.avgGf)} />
                        <StatTile label="Ø Diff" value={r.avgDiff != null ? (r.avgDiff > 0 ? '+' : '') + fmt2(r.avgDiff) : '–'} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* 6. Aktuelle Form */}
          <div className="card card-pad mb">
            <h2>Aktuelle Form (letzte 5 Spiele)</h2>
            <div className="grid grid-2">
              {[[team1, analysis.form1], [team2, analysis.form2]].map(([t, f]) => (
                <div key={t.id}>
                  <div className="row gap-sm" style={{ marginBottom: 8 }}>
                    <TeamBadge team={t} link={false} />
                  </div>
                  {f.letters.length === 0 ? (
                    <div className="muted" style={{ fontSize: 13 }}>Keine Spiele vorhanden.</div>
                  ) : (
                    <>
                      <div className="row gap-sm" style={{ marginBottom: 10 }}>
                        {f.letters.map((l, j) => <ResultBadge key={j} code={l} />)}
                      </div>
                      <div className="tiles" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
                        <StatTile label="Spiele" value={f.gp} />
                        <StatTile label="Punkte" value={f.pts} />
                        <StatTile label="Tore" value={f.gf} />
                        <StatTile label="Gegentore" value={f.ga} />
                        <StatTile label="Ø Tore" value={fmt2(f.avgGf)} />
                        <StatTile label="Ø Gegentore" value={fmt2(f.avgGa)} />
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          {/* 7. Direkter Vergleich */}
          <div className="card card-pad mb">
            <h2>Direkter Vergleich</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="left"></th>
                    <th className="left">{team1.short}</th>
                    <th className="left">{team2.short}</th>
                  </tr>
                </thead>
                <tbody>
                  <CompareRow label="ELO" v1={Math.round(derived.elo.ratings[team1Id] ?? 1500)} v2={Math.round(derived.elo.ratings[team2Id] ?? 1500)} format={(v) => (v == null ? '–' : String(v))} />
                  <CompareRow label="Power Score" v1={analysis.powerByTeam[team1Id]?.powerScore ?? null} v2={analysis.powerByTeam[team2Id]?.powerScore ?? null} format={(v) => (v == null ? '–' : String(v))} />
                  <CompareRow label="Form (Pkt/5 Sp.)" v1={analysis.form1.gp > 0 ? analysis.form1.pts : null} v2={analysis.form2.gp > 0 ? analysis.form2.pts : null} format={(v) => (v == null ? '–' : String(v))} />
                  <CompareRow label="Ø Tore (Saison)" v1={analysis.s1?.gp > 0 ? analysis.s1.gf / analysis.s1.gp : null} v2={analysis.s2?.gp > 0 ? analysis.s2.gf / analysis.s2.gp : null} />
                  <CompareRow label="Ø Gegentore (Saison)" v1={analysis.s1?.gp > 0 ? analysis.s1.ga / analysis.s1.gp : null} v2={analysis.s2?.gp > 0 ? analysis.s2.ga / analysis.s2.gp : null} higherIsBetter={false} />
                  <CompareRow label="SOG zugelassen/Sp." v1={analysis.sog1} v2={analysis.sog2} higherIsBetter={false} />
                </tbody>
              </table>
            </div>
          </div>

          {/* 8. Matchup-Einschätzung */}
          <div className="card card-pad">
            <h2>Matchup-Einschätzung</h2>
            <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.9 }}>
              {(() => {
                const e1 = Math.round(derived.elo.ratings[team1Id] ?? 1500)
                const e2 = Math.round(derived.elo.ratings[team2Id] ?? 1500)
                const items = []
                if (Math.abs(e1 - e2) < 5) items.push(<li key="elo">ELO ist aktuell nahezu ausgeglichen ({e1} vs. {e2}).</li>)
                else items.push(<li key="elo">{e1 > e2 ? team1.name : team2.name} hat aktuell das höhere ELO ({Math.max(e1, e2)} vs. {Math.min(e1, e2)}).</li>)

                if (analysis.hasAnyH2H) {
                  const { t1, t2 } = analysis.overall
                  if (t1.wins === t2.wins) items.push(<li key="h2h">In den direkten Duellen halten sich beide Teams die Waage ({t1.wins}:{t2.wins} Siege).</li>)
                  else items.push(<li key="h2h">{t1.wins > t2.wins ? team1.name : team2.name} hat in den direkten Duellen die bessere Bilanz ({Math.max(t1.wins, t2.wins)}:{Math.min(t1.wins, t2.wins)} Siege{!analysis.hasCurrentSeasonH2H ? ', historisch' : ''}).</li>)
                } else {
                  items.push(<li key="h2h">Keine direkten Duelle bekannt.</li>)
                }

                const f1pts = analysis.form1.gp > 0 ? analysis.form1.pts / analysis.form1.gp : null
                const f2pts = analysis.form2.gp > 0 ? analysis.form2.pts / analysis.form2.gp : null
                if (f1pts != null && f2pts != null) {
                  if (Math.abs(f1pts - f2pts) < 0.15) items.push(<li key="form">Beide Teams sind zuletzt ähnlich in Form.</li>)
                  else items.push(<li key="form">{f1pts > f2pts ? team1.name : team2.name} hat zuletzt die bessere Form (Ø {fmt2(Math.max(f1pts, f2pts))} vs. {fmt2(Math.min(f1pts, f2pts))} Pkt/Spiel, letzte 5).</li>)
                }

                return items
              })()}
            </ul>
            <div className="muted mt" style={{ fontSize: 12.5, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              ELO-Modellprognose (kein garantiertes Ergebnis, nur Modellwert aus src/elo.js): bei {team1.short} zuhause {fmtPct(analysis.pTeam1Home)} für {team1.short} · bei {team2.short} zuhause {fmtPct(analysis.pTeam2Home)} für {team2.short}.
            </div>
          </div>
        </>
      )}
    </div>
  )
}

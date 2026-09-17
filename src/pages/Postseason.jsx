// ---------------------------------------------------------------------------
// Postseason Paths / Most Likely Matchups (Route /postseason).
//
// Baut ausschliesslich auf der bestehenden, unveränderten Monte-Carlo-
// Simulation auf (simulateSeasonProjections({ trackPaths: true }),
// src/playoffSim.js) - keine eigene/zweite Simulationsengine. Jeder der
// 10'000 Läufe simuliert bereits die komplette Kette Restsaison -> Seeding
// -> Play-in -> Bracket -> Meister; trackPaths sammelt daraus zusätzlich die
// konkreten Gegner/Serienlängen/Pfade pro Lauf (src/postseasonPaths.js
// aggregiert diese EINMAL zu einem festen Ergebnis - die UI rechnet danach
// nur noch auf diesem aggregierten Objekt, kein Re-Simulieren pro Klick).
// ---------------------------------------------------------------------------

import { useMemo, useState } from 'react'
import { useData } from '../DataContext.jsx'
import { simulateSeasonProjections } from '../playoffSim.js'
import { aggregatePostseasonPaths, validatePostseasonAggregate } from '../postseasonPaths.js'
import { usePreseasonElo, computePreseasonRatings } from '../preseasonElo.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from '../marketValuePrior.js'
import { TeamBadge, SectionHeader, StatTile, ProbBar, Tabs } from '../components/ui.jsx'
import PostseasonMatchups from '../components/PostseasonMatchups.jsx'
import PostseasonBracket from '../components/PostseasonBracket.jsx'

const RUNS = 10000

const STAGE_LABEL = { PI: 'Play-In', QF: 'Viertelfinal', SF: 'Halbfinal', F: 'Final' }
const OPPONENT_TABS = [
  { key: 'playIn', label: 'Play-In' },
  { key: 'quarterfinal', label: 'Viertelfinal' },
  { key: 'semifinal', label: 'Halbfinal' },
  { key: 'final', label: 'Final' },
]

function fmtPct(v) {
  if (v == null) return '–'
  const pct = v * 100
  if (pct > 0 && pct < 1) return pct.toFixed(1) + '%'
  return Math.round(pct) + '%'
}

function generateSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

export default function Postseason() {
  const { data } = useData()
  const preseasonSeasonEnd = usePreseasonElo()
  const [simulating, setSimulating] = useState(false)
  const [sim, setSim] = useState(null)
  const [aggregate, setAggregate] = useState(null)
  const [issues, setIssues] = useState([])
  const [updatedAt, setUpdatedAt] = useState(null)
  const [selectedTeamId, setSelectedTeamId] = useState(null)
  const [oppTab, setOppTab] = useState('playIn')

  const initialRatings = useMemo(() => {
    if (!data?.teams) return null
    const eloStart = data.settings?.eloStart ?? 1500
    const useMarketValue = data.settings?.marketValuePriorEnabled !== false
    const marketPrior = useMarketValue
      ? computeMarketValuePrior(data.teams, data.players, eloStart, data.settings?.priorSpread ?? DEFAULT_PRIOR_SPREAD)
      : null
    return marketPrior || computePreseasonRatings(preseasonSeasonEnd, eloStart)
  }, [data, preseasonSeasonEnd])

  const teamById = useMemo(() => new Map((data?.teams || []).map((t) => [t.id, t])), [data])

  const scheduledCount = useMemo(() => {
    if (!data?.games) return 0
    return data.games.filter((g) => g.status === 'scheduled').length
  }, [data])

  const runSimulation = () => {
    if (!data?.teams || !data?.games) return
    setSimulating(true)
    const seed = generateSeed()
    setTimeout(() => {
      try {
        const result = simulateSeasonProjections(data.teams, data.games, data.settings, {
          runs: RUNS, seed, players: data.players || [], initialRatings, trackPaths: true,
        })
        if (!result || !result.bracketSimulated) {
          setSim(result); setAggregate(null); setIssues([])
          return
        }
        const agg = aggregatePostseasonPaths(result, data.teams)
        const teamIds = data.teams.map((t) => t.id)
        const foundIssues = validatePostseasonAggregate(agg, teamIds)
        if (foundIssues.length > 0) console.warn('Postseason-Paths-Validierung:', foundIssues)
        setSim(result)
        setAggregate(agg)
        setIssues(foundIssues)
        setUpdatedAt(new Date())
        if (!selectedTeamId) setSelectedTeamId(result.rows[0]?.team.id ?? null)
      } catch (err) {
        console.error('Postseason-Simulation fehlgeschlagen:', err)
      } finally {
        setSimulating(false)
      }
    }, 0)
  }

  if (scheduledCount === 0) {
    return (
      <div className="card card-pad">
        <div className="muted">Keine anstehenden Spiele im Spielplan erfasst.</div>
      </div>
    )
  }

  const row = sim?.rows.find((r) => r.team.id === selectedTeamId) || null
  const tp = aggregate?.teamPaths?.[selectedTeamId] || null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Postseason Paths</h1>
          <div className="sub">
            How the National League postseason could unfold
            {sim ? ` · ${sim.runs.toLocaleString()} Simulationen` : ''}
            {updatedAt ? ` · aktualisiert ${updatedAt.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </div>
          <span className="chip" style={{ fontSize: 10.5, marginTop: 4 }}>
            Restsaison → Seeding → Bracket: eine gemeinsame Monte-Carlo-Kette pro Lauf, kein fixiertes Seeding
          </span>
        </div>
      </div>

      <div className="row gap-sm" style={{ marginBottom: 14 }}>
        <button onClick={runSimulation} disabled={simulating} className="btn primary" style={{ minHeight: 40, flex: 1 }}>
          {simulating ? 'Simuliert…' : sim ? `Simulation aktualisieren (${RUNS.toLocaleString()} Läufe)` : `Simulation starten (${RUNS.toLocaleString()} Läufe)`}
        </button>
      </div>

      {!sim && !simulating && (
        <div className="card card-pad">
          <div className="muted">Noch keine Simulation gelaufen. Starte die 10'000er-Simulation oben.</div>
        </div>
      )}

      {sim && !sim.bracketSimulated && (
        <div className="card card-pad">
          <div className="muted">Bracket-Simulation nicht möglich (Teamanzahl weicht vom 14-Team-Format ab).</div>
        </div>
      )}

      {sim && aggregate && (
        <>
          <div className="row gap-sm" style={{ marginBottom: 14 }}>
            <select value={selectedTeamId ?? ''} onChange={(e) => setSelectedTeamId(e.target.value)} style={{ width: 'auto', minHeight: 40 }}>
              {sim.rows.map((r) => <option key={r.team.id} value={r.team.id}>{r.team.name}</option>)}
            </select>
          </div>

          {row && tp && (
            <>
              <div className="row gap-sm mb"><TeamBadge team={row.team} /></div>

              <div className="tiles mb">
                <StatTile label="Playoff Qualification" value={fmtPct(row.pPlayoffs)} />
                <StatTile label="Quarterfinal" value={fmtPct(tp.quarterfinal.reachProbability)} />
                <StatTile label="Semifinal" value={fmtPct(tp.semifinal.reachProbability)} />
                <StatTile label="Final" value={fmtPct(tp.final.reachProbability)} />
                <StatTile label="Champion" value={fmtPct(tp.championshipProbability)} accent />
              </div>

              <SectionHeader title="Most Likely Path" caption="Der tatsächlich am häufigsten beobachtete komplette Pfad dieses Teams über alle Simulationsläufe - keine nachträglich kombinierten Einzelwahrscheinlichkeiten." />
              <div className="card card-pad mb">
                {tp.mostLikelyPath ? (
                  <>
                    <div className="postseason-path">
                      <div className="postseason-path-step">
                        <TeamBadge team={row.team} short />
                      </div>
                      {tp.mostLikelyPath.path.map((seg, i) => (
                        <div className="postseason-path-step" key={i}>
                          <div className="postseason-path-arrow">↓</div>
                          <div className="postseason-path-label">{STAGE_LABEL[seg.stage] || seg.stage}</div>
                          <div className="row gap-sm"><span className="muted" style={{ fontSize: 12 }}>vs</span><TeamBadge team={teamById.get(seg.opponentId)} short /></div>
                        </div>
                      ))}
                    </div>
                    <div className="row spread" style={{ marginTop: 14 }}>
                      <div>
                        <div className="stat-tile" style={{ padding: 0 }}>
                          <div className="label">Path Probability</div>
                          <div className="value accent">{fmtPct(tp.mostLikelyPath.probability)}</div>
                          <div className="hint">{tp.mostLikelyPath.count.toLocaleString('de-CH')} von {aggregate.runs.toLocaleString('de-CH')} simulierten Läufen</div>
                        </div>
                      </div>
                    </div>
                    {tp.topPaths.length > 1 && (
                      <div style={{ marginTop: 14 }}>
                        <div className="section-label">Weitere häufige Pfade</div>
                        {tp.topPaths.slice(1).map((p) => (
                          <div key={p.key} className="row spread" style={{ fontSize: 12, padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                            <span className="muted">
                              {p.path.map((seg, i) => (
                                <span key={i}>{i > 0 ? ' → ' : ''}{STAGE_LABEL[seg.stage] || seg.stage} vs {teamById.get(seg.opponentId)?.short || '?'}</span>
                              ))}
                            </span>
                            <strong>{fmtPct(p.probability)}</strong>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="muted">Dieses Team hat in keinem Simulationslauf das Play-in/den Playoff erreicht.</div>
                )}
              </div>

              <SectionHeader title="Most Likely Opponents" caption="Gegner-Verteilung je Runde - conditional = Anteil unter den Läufen, in denen die Runde erreicht wurde; absolute = Anteil über alle Läufe." />
              <div className="card mb">
                <div style={{ padding: '10px 16px 0' }}><Tabs tabs={OPPONENT_TABS} active={oppTab} onChange={setOppTab} /></div>
                <div className="card-pad">
                  {tp[oppTab].opponents.length === 0 && (
                    <div className="muted" style={{ fontSize: 12.5 }}>Dieses Team erreicht diese Runde in keinem Simulationslauf.</div>
                  )}
                  {tp[oppTab].opponents.map((o) => {
                    const opp = teamById.get(o.opponentId)
                    return (
                      <div key={o.opponentId} className="row" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)', gap: 10 }}>
                        <div style={{ width: 90, flex: 'none' }}><TeamBadge team={opp} short /></div>
                        <div style={{ flex: 1 }}><ProbBar value={o.conditionalProbability} /></div>
                        <span className="muted" style={{ fontSize: 11, width: 70, textAlign: 'right', flex: 'none' }}>{fmtPct(o.absoluteProbability)} absolut</span>
                      </div>
                    )
                  })}
                </div>
              </div>

              {oppTab === 'playIn' && tp.playIn.reachProbability > 0.005 && (
                <div className="card card-pad mb">
                  <div className="section-label">Play-in-Analytics</div>
                  <div className="tiles">
                    <StatTile label="1. Spiel gewonnen" value={fmtPct(tp.playIn.firstGameWinProbability)} />
                    <StatTile label="1. Spiel verloren" value={fmtPct(tp.playIn.firstGameLossProbability)} />
                    <StatTile label="2. Chance genutzt" value={fmtPct(tp.playIn.secondChanceProbability)} hint={tp.playIn.secondChanceProbability == null ? 'keine zweite Chance im Format' : undefined} />
                    <StatTile label="Playoff-Qualifikation gesamt" value={fmtPct(tp.playIn.conditionalQualificationProbability)} accent />
                  </div>
                </div>
              )}
            </>
          )}

          <PostseasonMatchups aggregate={aggregate} teamById={teamById} />
          <PostseasonBracket sim={sim} aggregate={aggregate} teamById={teamById} />

          {issues.length > 0 && (
            <div className="card card-pad mb" style={{ borderColor: '#b4530955' }}>
              <div className="section-label" style={{ color: 'var(--warn)' }}>Validierungshinweise (intern)</div>
              {issues.slice(0, 5).map((iss, i) => <div key={i} className="muted" style={{ fontSize: 11 }}>{iss}</div>)}
            </div>
          )}
        </>
      )}
    </>
  )
}

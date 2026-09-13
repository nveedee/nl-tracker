// ---------------------------------------------------------------------------
// Season Projections (Route /playoff-odds, Nav-Label bleibt "Playoff Odds" -
// Platzgründe in der einzeiligen Hauptnavigation). Komplette Saisonprojektion
// statt nur Playoff-Wahrscheinlichkeit: nutzt ausschliesslich die bestehende,
// um eine echte Playoff-Bracket-Simulation erweiterte Monte-Carlo-Logik aus
// src/playoffSim.js (simulatePlayoffOdds -> simulateSeasonProjections).
// Keine eigene Prognoseformel, keine erfundenen Werte.
// ---------------------------------------------------------------------------

import { useState, useMemo } from 'react'
import { useData } from '../DataContext.jsx'
import { simulatePlayoffOdds } from '../playoffSim.js'
import { usePreseasonElo, computePreseasonRatings } from '../preseasonElo.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from '../marketValuePrior.js'
import { computePowerRankings } from '../powerRankings.js'
import { TeamBadge } from '../components/ui.jsx'

function fmtPct(v) { return v == null ? '–' : (v * 100).toFixed(1) + '%' }

// Neuer Zufalls-Seed pro manuellem Simulationslauf (Web Crypto API, kryptografisch
// sicher) - NICHT derselbe hardcodierte Default-Seed wie zuvor. Ändert nichts an
// SeededRandom/simulateSeasonProjections selbst: derselbe Seed erzeugt weiterhin
// exakt denselben Lauf (siehe src/playoffSim.js, unverändert). Der Seed lebt nur
// im UI-State dieser Seite - wird nirgends persistiert (db.json/seed.json).
function generateSeed() {
  return crypto.getRandomValues(new Uint32Array(1))[0]
}

export default function PlayoffOdds() {
  const { data, derived } = useData()
  const [simulating, setSimulating] = useState(false)
  const [results, setResults] = useState(null)
  const [lastSimAt, setLastSimAt] = useState(null)
  const [lastSeed, setLastSeed] = useState(null)
  const [expandedTeam, setExpandedTeam] = useState(null)
  const preseasonSeasonEnd = usePreseasonElo()

  const scheduledCount = useMemo(() => {
    if (!data?.games) return 0
    return data.games.filter((g) => g.status === 'scheduled').length
  }, [data])

  const powerByTeam = useMemo(() => {
    if (!data?.teams || !data?.games || !derived?.elo?.ratings) return {}
    const power = computePowerRankings(data.teams, data.games, derived.elo.ratings, data.players || [])
    return Object.fromEntries(power.map((p) => [p.team.id, p]))
  }, [data, derived])

  // Marktwert-Prior (src/marketValuePrior.js), wenn aktiviert und Daten
  // vorhanden, sonst der bestehende historische Pre-Season-ELO - identische
  // Priorität wie in DataContext.jsx (derived.eloPriorSource). Einmal
  // gemeinsam für Anzeige (Zeile "preElo" unten) UND die Simulation selbst
  // berechnet, statt wie zuvor zweimal separat.
  const initialRatings = useMemo(() => {
    if (!data?.teams) return null
    const eloStart = data.settings?.eloStart ?? 1500
    const useMarketValue = data.settings?.marketValuePriorEnabled !== false
    const marketPrior = useMarketValue
      ? computeMarketValuePrior(data.teams, data.players, eloStart, data.settings?.priorSpread ?? DEFAULT_PRIOR_SPREAD)
      : null
    return marketPrior || computePreseasonRatings(preseasonSeasonEnd, eloStart)
  }, [data, preseasonSeasonEnd])

  const handleSimulate = async () => {
    if (!data?.teams || !data?.games) return
    setSimulating(true)
    // Ein neuer Seed wird genau EINMAL pro Klick erzeugt (hier, als lokale
    // Variable) - nicht bei jedem Re-Render. Explizite Seeds (z.B. in Tests
    // oder src/pages/SimulationTest.jsx) bleiben davon unberührt, da dort
    // weiterhin ein eigener `seed` an simulatePlayoffOdds()/
    // simulateSeasonProjections() übergeben wird.
    const seed = generateSeed()
    setTimeout(() => {
      try {
        const sim = simulatePlayoffOdds(data.teams, data.games, data.settings, { players: data.players || [], initialRatings, seed })
        setResults(sim)
        setLastSimAt(new Date())
        setLastSeed(seed)
        setExpandedTeam(null)
      } catch (err) {
        console.error('Simulation error:', err)
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

  const byChampion = results ? [...results.rows].sort((a, b) => b.pChampion - a.pChampion) : []
  const favorite = byChampion[0]
  const top3 = byChampion.slice(0, 3)

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Season Projections</h1>
          <div className="sub">
            {data.settings?.seasonName || 'National League'} · {results ? results.runs.toLocaleString() : '10.000'} Simulationen
            {lastSimAt ? ` · aktualisiert ${lastSimAt.toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' })}` : ''}
          </div>
          {derived.eloPriorSource === 'marketValue' && (
            <span className="chip" style={{ fontSize: 10.5, marginTop: 4 }} title="Start-ELOs dieser Saison aus der Summe der Kader-Marktwerte abgeleitet (Einstellungen → Prognose-Erweiterungen)">
              Vorsaison-Prior aus Marktwert
            </span>
          )}
        </div>
        <button onClick={handleSimulate} disabled={simulating} className="btn primary">
          {simulating ? 'Simuliert…' : `Simulation starten (${scheduledCount} Spiele)`}
        </button>
      </div>

      {results && (
        <>
          {/* Wer wird Meister - kompakt, keine Hero-Card */}
          <div className="grid mb" style={{ gridTemplateColumns: '220px 1fr', gap: 14 }}>
            <div className="card card-pad">
              <div className="section-label">Meisterschafts-Favorit</div>
              <div className="row gap-sm" style={{ marginTop: 6 }}>
                <TeamBadge team={favorite.team} />
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, marginTop: 8, fontFamily: 'var(--mono)', color: 'var(--accent)' }}>
                {fmtPct(favorite.pChampion)}
              </div>
              <div className="muted" style={{ fontSize: 11 }}>Meisterchance</div>
            </div>
            <div className="card card-pad">
              <div className="section-label">Top 3 Meisterschaftsfavoriten</div>
              {top3.map((r, i) => (
                <div key={r.team.id} className="row spread" style={{ padding: '6px 0', borderBottom: i < top3.length - 1 ? '1px solid var(--border)' : 'none' }}>
                  <span className="row gap-sm"><span className="rank">{i + 1}</span><TeamBadge team={r.team} /></span>
                  <strong style={{ fontFamily: 'var(--mono)' }}>{fmtPct(r.pChampion)}</strong>
                </div>
              ))}
            </div>
          </div>

          {/* National League Projektion */}
          <div className="section-label">National League Projektion</div>
          <div className="card mb">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="left">Team</th>
                    <th className="num">Playoffs</th>
                    <th className="num">Direkt Top 6</th>
                    <th className="num">Play-in</th>
                    <th className="num">Halbfinale</th>
                    <th className="num">Finale</th>
                    <th className="num">Meister</th>
                    <th className="num">Play-out 13/14</th>
                    <th className="num">Ligaqualifikation</th>
                    <th className="num">Ø Punkte</th>
                    <th className="num">Ø Rang</th>
                    <th className="num">Best Case</th>
                    <th className="num">Worst Case</th>
                    <th className="num"></th>
                  </tr>
                </thead>
                <tbody>
                  {results.rows.map((r) => (
                    <tr key={r.team.id}>
                      <td className="left"><TeamBadge team={r.team} /></td>
                      <td className="num">{fmtPct(r.pPlayoffs)}</td>
                      <td className="num">{fmtPct(r.pTop6)}</td>
                      <td className="num">{fmtPct(r.pPlayIn)}</td>
                      <td className="num">{fmtPct(r.pSemifinal)}</td>
                      <td className="num">{fmtPct(r.pFinal)}</td>
                      <td className="num"><strong style={{ color: 'var(--accent)' }}>{fmtPct(r.pChampion)}</strong></td>
                      <td className="num">{fmtPct(r.pPlayout1314)}</td>
                      <td className="num">{fmtPct(r.pLigaQualifikation)}</td>
                      <td className="num">{r.avgPts.toFixed(1)}</td>
                      <td className="num">{r.avgRank.toFixed(1)}</td>
                      <td className="num muted" style={{ fontSize: 11.5 }}>{Math.round(r.maxPts)}</td>
                      <td className="num muted" style={{ fontSize: 11.5 }}>{Math.round(r.minPts)}</td>
                      <td className="num">
                        <button
                          className="btn ghost sm"
                          onClick={() => setExpandedTeam(expandedTeam === r.team.id ? null : r.team.id)}
                        >
                          {expandedTeam === r.team.id ? '▲' : '▼'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Detailansicht: Rangverteilung + ELO/Power-Vergleich */}
          {expandedTeam && (() => {
            const r = results.rows.find((row) => row.team.id === expandedTeam)
            if (!r) return null
            const power = powerByTeam[r.team.id]
            const preElo = initialRatings?.[r.team.id]
            const curElo = derived?.elo?.ratings?.[r.team.id]
            return (
              <div className="card card-pad mb">
                <div className="row gap-sm mb"><TeamBadge team={r.team} /><span className="muted" style={{ fontSize: 12.5 }}>– Detaillierte Projektion</span></div>

                <div className="grid grid-2 mb" style={{ fontSize: 12.5 }}>
                  <div className="card card-pad">
                    <div className="section-label">Punkte-Szenarien</div>
                    <div className="grid grid-2" style={{ gap: 8 }}>
                      <div><span className="muted">Ø Punkte:</span> <strong>{r.avgPts.toFixed(1)}</strong></div>
                      <div><span className="muted">Median:</span> <strong>{r.medianPts}</strong></div>
                      <div><span className="muted">Best Case:</span> <strong>{Math.round(r.maxPts)}</strong></div>
                      <div><span className="muted">Worst Case:</span> <strong>{Math.round(r.minPts)}</strong></div>
                    </div>
                  </div>
                  <div className="card card-pad">
                    <div className="section-label">ELO / Power / Cup</div>
                    <div className="grid grid-2" style={{ gap: 8 }}>
                      <div><span className="muted">Pre-Season-ELO:</span> <strong>{preElo != null ? Math.round(preElo) : '–'}</strong></div>
                      <div><span className="muted">Aktuelles ELO:</span> <strong>{curElo != null ? Math.round(curElo) : '–'}</strong></div>
                      <div><span className="muted">Power Score:</span> <strong>{power?.powerScore ?? '–'}</strong></div>
                      <div><span className="muted">Meisterchance:</span> <strong style={{ color: 'var(--accent)' }}>{fmtPct(r.pChampion)}</strong></div>
                    </div>
                  </div>
                </div>

                <div className="section-label">Rangverteilung ({results.teamCount} Teams, Summe = 100%)</div>
                {Object.entries(r.rankDistribution)
                  .sort((a, b) => Number(a[0]) - Number(b[0]))
                  .map(([rank, count]) => {
                    const pct = count / results.runs
                    return (
                      <div key={rank} className="row" style={{ fontSize: 12, marginBottom: 4 }}>
                        <span className="muted" style={{ minWidth: 58, fontWeight: 600 }}>Rang {rank}</span>
                        <div className="bar-track" style={{ flex: 1 }}>
                          <div className="bar-fill" style={{ width: `${Math.min(pct * 100, 100)}%` }} />
                        </div>
                        <strong style={{ minWidth: 46, textAlign: 'right', fontFamily: 'var(--mono)' }}>{fmtPct(pct)}</strong>
                      </div>
                    )
                  })}
              </div>
            )
          })()}

          {/* Simulationsdetails */}
          <div className="card card-pad">
            <div className="section-label">Simulation</div>
            <div className="stat-strip">
              <div className="stat"><strong>{results.runs.toLocaleString()}</strong><span>Saison-Simulationen</span></div>
              <div className="stat"><strong>{results.scheduledCount}</strong><span>Offene Spiele</span></div>
              <div className="stat"><strong>{results.teamCount}</strong><span>Teams</span></div>
            </div>
            <div className="row spread">
              <div className="muted" style={{ fontSize: 12 }}>
                Seed: <span style={{ fontFamily: 'var(--mono)' }}>{lastSeed ?? results.seed}</span>
                {' · '}Letzte Simulation: {lastSimAt ? lastSimAt.toLocaleString('de-CH') : '–'}
              </div>
              <button className="btn ghost sm" onClick={handleSimulate} disabled={simulating}>
                {simulating ? 'Simuliert…' : 'Simulation aktualisieren'}
              </button>
            </div>
          </div>
        </>
      )}
    </>
  )
}

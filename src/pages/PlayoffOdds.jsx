// ---------------------------------------------------------------------------
// Season Projections (Route /playoff-odds, Nav-Label bleibt "Playoff Odds" -
// Platzgründe in der einzeiligen Hauptnavigation). Komplette Saisonprojektion
// statt nur Playoff-Wahrscheinlichkeit: nutzt ausschliesslich die bestehende,
// um eine echte Playoff-Bracket-Simulation erweiterte Monte-Carlo-Logik aus
// src/playoffSim.js (simulatePlayoffOdds -> simulateSeasonProjections).
// Keine eigene Prognoseformel, keine erfundenen Werte.
//
// Mobile: die Auswertungen sitzen hinter Sub-Tabs (Matrix/Brackets/What-if/
// Swing/Locks/Targets/Verlauf, siehe Tabs-Komponente) statt alle auf einmal
// untereinander - progressive disclosure statt einer sehr langen Seite.
// ---------------------------------------------------------------------------

import { useState, useMemo } from 'react'
import { useData } from '../DataContext.jsx'
import { simulatePlayoffOdds, computeMatchForecasts } from '../playoffSim.js'
import { usePreseasonElo, computePreseasonRatings } from '../preseasonElo.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from '../marketValuePrior.js'
import { computePowerRankings } from '../powerRankings.js'
import { withPregamePredictions } from '../pregamePrediction.js'
import { TeamBadge, Delta, SectionHeader, StatTile, ProbBar, Tabs, useScrollFade } from '../components/ui.jsx'
import { getLastBaseline, recordBaselineIfNeeded, computeMovers } from '../baselineStore.js'
import { useSimResults } from '../simResultsContext.jsx'
import PositionMatrix from '../components/PositionMatrix.jsx'
import BracketCards from '../components/BracketCards.jsx'
import MatchForecast from '../components/MatchForecast.jsx'
import WhatIfSimulator from '../components/WhatIfSimulator.jsx'
import SwingAnalysis from '../components/SwingAnalysis.jsx'
import LockStandings from '../components/LockStandings.jsx'
import PointsTargets from '../components/PointsTargets.jsx'
import SeasonEvolution from '../components/SeasonEvolution.jsx'

// Ganzzahlig für lesbare Werte, aber mit einer Dezimalstelle unterhalb von 1%
// (sonst würde eine echte, kleine Restchance als "0%" verschwinden) - reine
// Anzeigeformatierung, keine Rundung der zugrundeliegenden Simulationswerte.
function fmtPct(v) {
  if (v == null) return '–'
  const pct = v * 100
  if (pct > 0 && pct < 1) return pct.toFixed(1) + '%'
  return Math.round(pct) + '%'
}

const RUN_CHOICES = [1000, 2500, 5000, 10000]

const TABS = [
  { key: 'matrix', label: 'Matrix' },
  { key: 'brackets', label: 'Brackets' },
  { key: 'whatif', label: 'What-if' },
  { key: 'swing', label: 'Swing' },
  { key: 'locks', label: 'Locks' },
  { key: 'targets', label: 'Targets' },
  { key: 'evolution', label: 'Verlauf' },
]

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
  const [runsChoice, setRunsChoice] = useState(10000)
  const [tab, setTab] = useState('matrix')
  const tableWrapRef = useScrollFade()
  // Beim Laden der Seite EINMAL geladen (nicht nach jedem Simulationslauf neu) -
  // so vergleicht die gesamte Session konsistent gegen denselben Referenzpunkt
  // ("seit dem letzten Checkpoint"), statt bei jedem Klick gegen den gerade
  // selbst erzeugten Lauf. Siehe src/baselineStore.js für die genaue Regel.
  const [baseline] = useState(() => getLastBaseline())
  const { setLiveResults } = useSimResults()
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
    // Variable) - nicht bei jedem Re-Render. Explizite Seeds (z.B. in Tests)
    // bleiben davon unberührt, da dort weiterhin ein eigener `seed` an
    // simulatePlayoffOdds()/simulateSeasonProjections() übergeben wird.
    const seed = generateSeed()
    setTimeout(() => {
      try {
        const sim = simulatePlayoffOdds(data.teams, data.games, data.settings, { runs: runsChoice, players: data.players || [], initialRatings, seed })
        setResults(sim)
        setLastSimAt(new Date())
        setLastSeed(seed)
        setExpandedTeam(null)
        recordBaselineIfNeeded(sim)
        // Zentraler Live-Store (src/simResultsContext.jsx): macht das neue
        // Ergebnis SOFORT auch dem Playoff Wheel auf dem Dashboard verfügbar -
        // ganz ohne Page Reload, unabhängig von der Tages-Baseline oben.
        setLiveResults(sim)
      } catch (err) {
        console.error('Simulation error:', err)
      } finally {
        setSimulating(false)
      }
    }, 0)
  }

  // Geschlossene Form (kein Monte-Carlo-Lauf nötig) - daher unabhängig von
  // `results` immer verfügbar, sobald Daten geladen sind. computeMatchForecasts()
  // liefert Expected Goals/OT-SO-Split/ELO bereits mit (siehe dortiger
  // Kommentar) - kein zweiter computeFixtures()-Aufruf mehr nötig.
  // withPregamePredictions() ersetzt die Live-Werte durch den eingefrorenen
  // Prediction-Snapshot, sobald einer existiert (src/pregamePrediction.js) -
  // dieselbe Single Source of Truth wie auf Dashboard/Schedule/TeamDetail/
  // MatchupDetail, damit dasselbe Spiel hier nie eine andere Prozentzahl
  // zeigt als anderswo.
  const forecasts = useMemo(() => {
    if (!data?.teams || !data?.games) return []
    const base = computeMatchForecasts(data.teams, data.games, data.settings, data.players || [], initialRatings)
    return withPregamePredictions(base, data.predictions)
  }, [data, initialRatings])

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
  const movers = results ? computeMovers(results.rows, baseline) : { risers: [], fallers: [] }

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
      </div>

      {/* N-Wähler + Simulieren: wichtigste Aktion, bleibt oben griffbereit */}
      <div className="row gap-sm" style={{ marginBottom: 14 }}>
        <select value={runsChoice} onChange={(e) => setRunsChoice(Number(e.target.value))} disabled={simulating} style={{ width: 'auto', minHeight: 40 }} title="Anzahl Saison-Simulationen">
          {RUN_CHOICES.map((n) => <option key={n} value={n}>{n.toLocaleString('de-CH')} Läufe</option>)}
        </select>
        <button onClick={handleSimulate} disabled={simulating} className="btn primary" style={{ minHeight: 40, flex: 1 }}>
          {simulating ? 'Simuliert…' : `Simulation starten (${scheduledCount} Spiele)`}
        </button>
      </div>

      <MatchForecast forecasts={forecasts} />

      {results && (
        <>
          <Tabs tabs={TABS} active={tab} onChange={setTab} />

          {tab === 'matrix' && (
            <>
              <PositionMatrix rows={results.rows} runs={results.runs} />

              {/* Volle Zahlen-Tabelle (alle Kategorien nebeneinander) + Detailansicht je Team */}
              <SectionHeader title="National League Projektion" caption="Alle Kategorien nebeneinander, antippen für Rangverteilung/ELO-Details." />
              <div className="card mb">
                {/* Gruppenzeile über den Kategorien - rein visuelle Gliederung
                    (Playoff-Weg / Meisterschaft / Abstiegszone / Saison), keine
                    eigenen Werte, nur Einordnung der bestehenden Spalten darunter. */}
                <div className="table-wrap pin-first" ref={tableWrapRef}>
                  <table className="projection-table">
                    <thead>
                      <tr className="group-row">
                        <th className="left"></th>
                        <th className="num group-start" colSpan={3}>Playoff-Weg</th>
                        <th className="num group-start" colSpan={3}>Meisterschaft</th>
                        <th className="num group-start" colSpan={2}>Abstiegszone</th>
                        <th className="num group-start" colSpan={2}>Saison Ø</th>
                        <th className="num group-start"></th>
                        <th className="num"></th>
                      </tr>
                      <tr>
                        <th className="left">Team</th>
                        <th className="num group-start" title="Wahrscheinlichkeit, die Playoffs zu erreichen (Top 10)">Playoffs</th>
                        <th className="num" title="Wahrscheinlichkeit, direkt in die Halbfinal-Runde zu kommen (Top 6)">Top 6</th>
                        <th className="num" title="Wahrscheinlichkeit, über das Play-in in die Playoffs zu kommen">Play-in</th>
                        <th className="num group-start" title="Wahrscheinlichkeit, das Halbfinale zu erreichen">Halbfinale</th>
                        <th className="num" title="Wahrscheinlichkeit, den Final zu erreichen">Finale</th>
                        <th className="num" title="Meisterchance">Meister</th>
                        <th className="num group-start" title="Wahrscheinlichkeit, in die Play-out-Runde (Platz 13/14) zu müssen">Play-out</th>
                        <th className="num" title="Wahrscheinlichkeit einer Ligaqualifikation (direkte Abstiegsgefahr)">Ligaqual.</th>
                        <th className="num group-start" title="Erwartete Punktezahl am Saisonende, Mittel über alle Simulationsläufe">Ø Pkt</th>
                        <th className="num" title="Erwarteter Schlussrang, Mittel über alle Simulationsläufe">Ø Rang</th>
                        <th className="num group-start" title="Bester und schlechtester simulierter Punktestand (Spannweite)">Range</th>
                        <th className="num"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.rows.map((r) => (
                        <tr key={r.team.id} className={expandedTeam === r.team.id ? 'active-row' : ''}>
                          <td className="left"><TeamBadge team={r.team} short /></td>
                          <td className="num group-start" style={{ fontWeight: 600 }}>{fmtPct(r.pPlayoffs)}</td>
                          <td className="num">{fmtPct(r.pTop6)}</td>
                          <td className="num">{fmtPct(r.pPlayIn)}</td>
                          <td className="num group-start">{fmtPct(r.pSemifinal)}</td>
                          <td className="num">{fmtPct(r.pFinal)}</td>
                          <td className="num"><strong style={{ color: 'var(--accent)' }}>{fmtPct(r.pChampion)}</strong></td>
                          <td className="num group-start" style={r.pPlayout1314 >= 0.1 ? { color: 'var(--warn)', fontWeight: 600 } : undefined}>{fmtPct(r.pPlayout1314)}</td>
                          <td className="num" style={r.pLigaQualifikation >= 0.05 ? { color: 'var(--bad)', fontWeight: 600 } : undefined}>{fmtPct(r.pLigaQualifikation)}</td>
                          <td className="num group-start" style={{ fontWeight: 600 }}>{r.avgPts.toFixed(1)}</td>
                          <td className="num" style={{ fontWeight: 600 }}>{r.avgRank.toFixed(1)}</td>
                          <td className="num group-start muted" style={{ fontSize: 11.5 }}>{Math.round(r.minPts)}–{Math.round(r.maxPts)}</td>
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

              {expandedTeam && (() => {
                const r = results.rows.find((row) => row.team.id === expandedTeam)
                if (!r) return null
                const power = powerByTeam[r.team.id]
                const preElo = initialRatings?.[r.team.id]
                const curElo = derived?.elo?.ratings?.[r.team.id]
                return (
                  <div className="card card-pad mb">
                    <div className="row gap-sm mb"><TeamBadge team={r.team} /><span className="muted" style={{ fontSize: 12.5 }}>– Detaillierte Projektion</span></div>

                    <div className="tiles mb">
                      <StatTile label="Ø Punkte" value={r.avgPts.toFixed(1)} />
                      <StatTile label="Median" value={r.medianPts} />
                      <StatTile label="Best Case" value={Math.round(r.maxPts)} />
                      <StatTile label="Worst Case" value={Math.round(r.minPts)} />
                      <StatTile label="Pre-Season-ELO" value={preElo != null ? Math.round(preElo) : '–'} />
                      <StatTile label="Aktuelles ELO" value={curElo != null ? Math.round(curElo) : '–'} />
                      <StatTile label="Power Score" value={power?.powerScore ?? '–'} />
                      <StatTile label="Meisterchance" value={fmtPct(r.pChampion)} accent />
                    </div>

                    <SectionHeader title="Rangverteilung" caption={`${results.teamCount} Teams, Summe = 100%`} />
                    {Object.entries(r.rankDistribution)
                      .sort((a, b) => Number(a[0]) - Number(b[0]))
                      .map(([rank, count]) => (
                        <div key={rank} className="row" style={{ fontSize: 12, marginBottom: 4 }}>
                          <span className="muted" style={{ minWidth: 50, fontWeight: 600, flex: 'none' }}>Rang {rank}</span>
                          <div style={{ flex: 1 }}><ProbBar value={count / results.runs} /></div>
                        </div>
                      ))}
                  </div>
                )
              })()}
            </>
          )}

          {tab === 'brackets' && (
            <>
              <div className="tiles mb">
                <StatTile label="Meisterschafts-Favorit" value={<span className="row gap-sm" style={{ fontSize: 14 }}><TeamBadge team={favorite.team} short /></span>} hint={fmtPct(favorite.pChampion) + ' Meisterchance'} accent />
                {top3.slice(1).map((r) => (
                  <StatTile key={r.team.id} label="Meisterschaftsfavorit" value={<TeamBadge team={r.team} short />} hint={fmtPct(r.pChampion)} />
                ))}
              </div>

              {baseline && (movers.risers.length > 0 || movers.fallers.length > 0) && (
                <div className="grid grid-2 mb" style={{ gap: 14 }}>
                  <div className="card card-pad">
                    <SectionHeader title={`Riser seit ${baseline.date}`} caption="Grösster Zuwachs bei der Playoff-Chance." />
                    {movers.risers.length === 0 && <div className="muted" style={{ fontSize: 12 }}>Keine nennenswerte Bewegung</div>}
                    {movers.risers.map((m) => (
                      <div key={m.row.team.id} className="row spread" style={{ padding: '4px 0' }}>
                        <TeamBadge team={m.row.team} short />
                        <Delta pp={m.delta} />
                      </div>
                    ))}
                  </div>
                  <div className="card card-pad">
                    <SectionHeader title={`Faller seit ${baseline.date}`} caption="Grösster Rückgang bei der Playoff-Chance." />
                    {movers.fallers.length === 0 && <div className="muted" style={{ fontSize: 12 }}>Keine nennenswerte Bewegung</div>}
                    {movers.fallers.map((m) => (
                      <div key={m.row.team.id} className="row spread" style={{ padding: '4px 0' }}>
                        <TeamBadge team={m.row.team} short />
                        <Delta pp={m.delta} />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <BracketCards rows={results.rows} compare={baseline} />
            </>
          )}

          {tab === 'whatif' && (
            <WhatIfSimulator
              teams={data.teams} games={data.games} settings={data.settings}
              players={data.players || []} initialRatings={initialRatings}
              baseResults={results} forecasts={forecasts} runs={runsChoice}
            />
          )}

          {tab === 'swing' && (
            <SwingAnalysis
              teams={data.teams} games={data.games} settings={data.settings}
              players={data.players || []} initialRatings={initialRatings}
              baseResults={results} forecasts={forecasts}
            />
          )}

          {tab === 'locks' && <LockStandings teams={data.teams} baseResults={results} />}

          {tab === 'targets' && <PointsTargets baseResults={results} />}

          {tab === 'evolution' && <SeasonEvolution teams={data.teams} />}

          {/* Simulationsdetails - unabhängig vom aktiven Tab immer sichtbar */}
          <div className="card card-pad">
            <div className="section-label">Simulation</div>
            <div className="stat-strip">
              <div className="stat"><strong>{results.runs.toLocaleString()}</strong><span>Saison-Simulationen</span></div>
              <div className="stat"><strong>{results.scheduledCount}</strong><span>Offene Spiele</span></div>
              <div className="stat"><strong>{results.teamCount}</strong><span>Teams</span></div>
            </div>
            <div className="row spread wrap" style={{ gap: 10 }}>
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

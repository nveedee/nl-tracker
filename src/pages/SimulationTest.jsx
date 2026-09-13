// ---------------------------------------------------------------------------
// Simulation testen ("Was-wäre-wenn"-Modus, automatisch)
//
// Simuliert per Knopfdruck die nächsten 5/10 Spiele oder den Rest der Saison
// ausgehend vom aktuellen, echten Saisonstand - komplett automatisch, keine
// manuelle Ergebniseingabe. Nutzt ausschliesslich die bestehenden,
// unveränderten ELO-/Power-Ranking-/Monte-Carlo-Funktionen:
//   - Eine konkrete "Story" (ein Durchlauf mit der validierten
//     Torgenerierung aus src/playoffSim.js): nach jedem simulierten Spiel
//     werden ELO, Punkte und Power Ranking neu berechnet - liefert die
//     Rang-/ELO-/Punkte-/Power-Score-Spalten sowie die Liste der simulierten
//     Spiele mit Resultat.
//   - Die bestehende 10'000-Läufe-Simulation (simulatePlayoffOdds,
//     unverändert) über exakt dieselben nächsten X Spiele - liefert die
//     Playoff-/Top6-/Top4-Wahrscheinlichkeiten und den Ø Rang statistisch
//     robust aus vielen Durchläufen statt aus nur einer Story.
//
// WICHTIG: Es wird an keiner Stelle die API (`api.*`) aufgerufen oder
// `refresh()` getriggert - alles läuft ausschliesslich mit lokalem
// React-State auf einer In-Memory-Kopie von `data.games`. db.json/seed.json
// werden nicht berührt, echte Spiele nicht verändert. "Zurücksetzen" (oder
// ein Reload) verwirft den gesamten Demo-Stand rückstandslos - `data` selbst
// wird nie mutiert.
// ---------------------------------------------------------------------------

import { useState } from 'react'
import { useData } from '../DataContext.jsx'
import { TeamBadge, toast } from '../components/ui.jsx'
import { computeElo } from '../elo.js'
import { computeStandings } from '../stats.js'
import { computePowerRankings } from '../powerRankings.js'
import { simulatePlayoffOdds, computeFixtures, simulateGameResult, SeededRandom } from '../playoffSim.js'
import { usePreseasonElo, computePreseasonRatings } from '../preseasonElo.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from '../marketValuePrior.js'

const MODES = [
  { key: 'next5', label: 'Nächste 5 Spiele', count: 5 },
  { key: 'next10', label: 'Nächste 10 Spiele', count: 10 },
  { key: 'rest', label: 'Restliche Saison', count: Infinity },
]

const SEED = 20260818

export default function SimulationTest() {
  const { data, derived } = useData()
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState(null)
  const preseasonSeasonEnd = usePreseasonElo()

  const teamById = (id) => data.teams.find((t) => t.id === id)
  const reset = () => setResult(null)

  const run = (mode) => {
    setRunning(true)
    // In setTimeout ausgelagert, damit der "Simuliert…"-Zustand sichtbar rendert.
    setTimeout(() => {
      try {
        const eloStart = data.settings?.eloStart ?? 1500
        const useMarketValue = data.settings?.marketValuePriorEnabled !== false
        const marketPrior = useMarketValue
          ? computeMarketValuePrior(data.teams, data.players, eloStart, data.settings?.priorSpread ?? DEFAULT_PRIOR_SPREAD)
          : null
        const initialRatings = marketPrior || computePreseasonRatings(preseasonSeasonEnd, eloStart)

        const scheduledSorted = data.games
          .filter((g) => g.status === 'scheduled')
          .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

        if (scheduledSorted.length === 0) {
          toast('Keine offenen Spiele mehr im Spielplan.', true)
          setRunning(false)
          return
        }

        const count = mode.count === Infinity ? scheduledSorted.length : Math.min(mode.count, scheduledSorted.length)
        const nextGames = scheduledSorted.slice(0, count)
        const nextIds = new Set(nextGames.map((g) => g.id))
        // Spielplan für die 10'000er-Simulation: reale bereits gespielte Spiele
        // + genau die ausgewählten nächsten X Spiele als offen. Alles danach
        // wird für diese Projektion bewusst ausgeblendet.
        const restrictedGames = data.games.filter((g) => g.status === 'final' || nextIds.has(g.id))

        // === A) Eine konkrete Story: Spiel für Spiel, ELO/Punkte/Power danach neu ===
        const rng = new SeededRandom(SEED)
        let cumulativeGames = data.games.filter((g) => g.status === 'final')
        const steps = []

        for (const g of nextGames) {
          const { fixtures, eloRatings: preElo } = computeFixtures(
            data.teams, [...cumulativeGames, g], data.settings, data.players || [], initialRatings
          )
          const fixture = fixtures[0]
          const outcome = simulateGameResult(rng, fixture)
          const finishedGame = {
            ...g,
            homeGoals: outcome.homeGoals,
            awayGoals: outcome.awayGoals,
            decision: outcome.decision,
            status: 'final',
            playerStats: [],
          }
          cumulativeGames = [...cumulativeGames, finishedGame]
          const { ratings: postElo } = computeElo(data.teams, cumulativeGames, data.settings, initialRatings)

          steps.push({
            homeTeam: teamById(g.homeTeamId),
            awayTeam: teamById(g.awayTeamId),
            homeGoals: outcome.homeGoals,
            awayGoals: outcome.awayGoals,
            decision: outcome.decision,
            homeEloBefore: preElo[g.homeTeamId] ?? eloStart,
            homeEloAfter: postElo[g.homeTeamId],
            awayEloBefore: preElo[g.awayTeamId] ?? eloStart,
            awayEloAfter: postElo[g.awayTeamId],
          })
        }

        const finalElo = computeElo(data.teams, cumulativeGames, data.settings, initialRatings)
        const finalStandings = computeStandings(data.teams, cumulativeGames)
        const finalPower = computePowerRankings(data.teams, cumulativeGames, finalElo.ratings, data.players || [])

        // === B) Wahrscheinlichkeiten aus vielen Läufen (bestehende 10'000er-Logik, unverändert) ===
        const playoff = simulatePlayoffOdds(data.teams, restrictedGames, data.settings, {
          players: data.players || [], runs: 10000, seed: SEED, initialRatings,
        })

        // === Vergleich zum aktuellen echten Stand ===
        const currentElo = derived.elo.ratings
        const powerByTeam = Object.fromEntries(finalPower.map((p) => [p.team.id, p]))
        const playoffByTeam = playoff ? Object.fromEntries(playoff.rows.map((p) => [p.team.id, p])) : {}

        const combined = finalStandings.map((s, i) => {
          const t = s.team
          const eloAfter = finalElo.ratings[t.id] ?? eloStart
          const eloBefore = currentElo[t.id] ?? eloStart
          return {
            team: t,
            rank: i + 1,
            gp: s.gp,
            pts: s.pts,
            elo: Math.round(eloAfter),
            eloDelta: Math.round(eloAfter - eloBefore),
            powerScore: powerByTeam[t.id]?.powerScore ?? null,
            pPlayoffs: playoffByTeam[t.id]?.pPlayoffs ?? null,
            pTop6: playoffByTeam[t.id]?.pTop6 ?? null,
            pTop4: playoffByTeam[t.id]?.pTop4 ?? null,
            avgRank: playoffByTeam[t.id]?.avgRank ?? null,
          }
        })

        const byEloDelta = [...combined].sort((a, b) => b.eloDelta - a.eloDelta)
        const winners = byEloDelta.slice(0, 3)
        const losers = byEloDelta.slice(-3).reverse()

        setResult({ mode, steps, combined, winners, losers, playoff })
      } catch (err) {
        console.error('Simulation fehlgeschlagen:', err)
        toast('Simulation fehlgeschlagen: ' + err.message, true)
      } finally {
        setRunning(false)
      }
    }, 0)
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Simulation testen</h1>
          <div className="sub">
            Was-wäre-wenn-Modus: simuliert automatisch die nächsten Spiele mit dem bestehenden ELO-/Power-Ranking-/
            Monte-Carlo-Modell.
            <br />
            <span style={{ fontSize: '0.85rem', color: 'var(--text-dim)' }}>
              Rein lokal – nichts wird gespeichert. Ausgangspunkt ist der aktuelle, echte Saisonstand.
            </span>
          </div>
        </div>
        <div className="row gap-sm">
          {result && <button className="btn ghost" onClick={reset} disabled={running}>Zurücksetzen</button>}
          {MODES.map((m) => (
            <button key={m.key} className="btn primary" onClick={() => run(m)} disabled={running}>
              {running ? '⟳ Simuliert…' : `▶ ${m.label}`}
            </button>
          ))}
        </div>
      </div>

      {!result && !running && (
        <div className="empty">
          <div className="title">Wähle oben, wie viele Spiele simuliert werden sollen</div>
          <div className="hint">Danach siehst du hier die projizierte Tabelle inkl. Playoff-Chancen.</div>
        </div>
      )}

      {result && (
        <>
          <div className="card card-pad mb">
            <h2>Simulierte Spiele ({result.steps.length}, Modus: {result.mode.label})</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="left">#</th>
                    <th className="left">Spiel</th>
                    <th className="left">Resultat</th>
                  </tr>
                </thead>
                <tbody>
                  {result.steps.map((s, i) => (
                    <tr key={i}>
                      <td className="left rank">{i + 1}</td>
                      <td className="left">
                        <TeamBadge team={s.homeTeam} link={false} short /> – <TeamBadge team={s.awayTeam} link={false} short />
                      </td>
                      <td className="left">
                        <strong>{s.homeGoals}:{s.awayGoals}</strong>{s.decision !== 'REG' ? ` (${s.decision})` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card card-pad mb">
            <h2>Grösste Gewinner / Verlierer gegenüber aktuellem Stand (Δ ELO)</h2>
            <div className="grid grid-2">
              <div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Gewinner</div>
                {result.winners.map((r) => (
                  <div key={r.team.id} className="row spread" style={{ padding: '6px 0' }}>
                    <TeamBadge team={r.team} link={false} />
                    <strong style={{ color: 'var(--good)' }}>{r.eloDelta > 0 ? '+' : ''}{r.eloDelta}</strong>
                  </div>
                ))}
              </div>
              <div>
                <div className="muted" style={{ fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Verlierer</div>
                {result.losers.map((r) => (
                  <div key={r.team.id} className="row spread" style={{ padding: '6px 0' }}>
                    <TeamBadge team={r.team} link={false} />
                    <strong style={{ color: 'var(--bad)' }}>{r.eloDelta > 0 ? '+' : ''}{r.eloDelta}</strong>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card card-pad">
            <h2>Projizierte Tabelle nach {result.steps.length} Spielen + Playoff-Odds ({result.playoff?.runs?.toLocaleString() ?? '–'} Läufe)</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th className="left">#</th>
                    <th className="left">Team</th>
                    <th className="num">SP</th>
                    <th className="num">Pkt</th>
                    <th className="num">ELO</th>
                    <th className="num">Power</th>
                    <th className="num">Playoffs</th>
                    <th className="num">Top 6</th>
                    <th className="num">Top 4</th>
                    <th className="num">Ø Rang</th>
                  </tr>
                </thead>
                <tbody>
                  {result.combined.map((r) => (
                    <tr key={r.team.id}>
                      <td className="left rank">{r.rank}</td>
                      <td className="left"><TeamBadge team={r.team} link={false} /></td>
                      <td className="num">{r.gp}</td>
                      <td className="num"><strong>{r.pts}</strong></td>
                      <td className="num">
                        {r.elo}{' '}
                        <span style={{ fontSize: '0.8rem', color: r.eloDelta > 0 ? 'var(--good)' : r.eloDelta < 0 ? 'var(--bad)' : 'inherit' }}>
                          ({r.eloDelta > 0 ? '+' : ''}{r.eloDelta})
                        </span>
                      </td>
                      <td className="num">{r.powerScore ?? '–'}</td>
                      <td className="num">{r.pPlayoffs != null ? (r.pPlayoffs * 100).toFixed(1) + '%' : '–'}</td>
                      <td className="num">{r.pTop6 != null ? (r.pTop6 * 100).toFixed(1) + '%' : '–'}</td>
                      <td className="num">{r.pTop4 != null ? (r.pTop4 * 100).toFixed(1) + '%' : '–'}</td>
                      <td className="num">{r.avgRank != null ? r.avgRank.toFixed(1) : '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!result.playoff && (
              <div className="muted mt" style={{ fontSize: 13 }}>
                Keine Playoff-Simulation möglich (keine offenen Spiele mehr für diese Projektion).
              </div>
            )}
          </div>
        </>
      )}
    </>
  )
}

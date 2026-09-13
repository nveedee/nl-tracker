// ---------------------------------------------------------------------------
// Team-Builder (/team-builder) - bestes Topscorers-Team fürs Budget, exakte
// Optimierung (src/teamBuilder.js) über die Fantasy-Punkte
// (src/fantasyScore.js) und derived.playerStats. Rein additiv, kein Eingriff
// in ELO/Prognose.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge } from '../components/ui.jsx'
import { fmtChf } from '../stats.js'
import { computeFantasyScores } from '../fantasyScore.js'
import { solveTeamBuilder, DEFAULT_TEAM_BUILDER_SETTINGS, POSITION_ORDER, POSITION_FULL_LABEL } from '../teamBuilder.js'

const MIN_GP_OPTIONS = [5, 10, 15, 20]
const BUDGET_MIN = 1_000_000
const BUDGET_MAX = 8_000_000
const BUDGET_UI_STEP = 50_000
const DEBOUNCE_MS = 150

// Debounced Wert - der Slider selbst bleibt sofort responsiv, die (etwas
// teurere) Solver-Neuberechnung folgt mit kurzer Verzögerung nach dem letzten
// Drag-Tick (siehe Bericht: Solve-Zeit selbst liegt im niedrigen
// zweistelligen Millisekundenbereich, das Debounce ist reine UX-Politur
// gegen viele Zwischen-Ticks während des Ziehens).
function useDebounced(value, ms) {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return debounced
}

export default function TeamBuilder() {
  const { data, derived } = useData()
  const [budget, setBudget] = useState(DEFAULT_TEAM_BUILDER_SETTINGS.budget)
  const [objective, setObjective] = useState(DEFAULT_TEAM_BUILDER_SETTINGS.objective)
  const [minGp, setMinGp] = useState(DEFAULT_TEAM_BUILDER_SETTINGS.minGp)

  const debouncedBudget = useDebounced(budget, DEBOUNCE_MS)

  const teamMap = useMemo(() => Object.fromEntries(data.teams.map((t) => [t.id, t])), [data.teams])
  const scored = useMemo(() => computeFantasyScores(derived.playerStats), [derived.playerStats])

  const result = useMemo(
    () => solveTeamBuilder(scored, { budget: debouncedBudget, minGp, objective }),
    [scored, debouncedBudget, minGp, objective]
  )

  const objectiveLabel = objective === 'total' ? 'Fantasy-Punkte (Saison-Total)' : 'Fantasy-Punkte/Spiel'

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Team-Builder</h1>
          <div className="sub">Bestes Topscorers-Team fürs Budget · exakte Optimierung (dynamische Programmierung)</div>
        </div>
      </div>

      <div className="card card-pad mb">
        <div className="form-row">
          <div>
            <label className="field">Budget: {fmtChf(budget)} CHF</label>
            <input
              type="range" min={BUDGET_MIN} max={BUDGET_MAX} step={BUDGET_UI_STEP}
              value={budget} onChange={(e) => setBudget(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            <div className="muted row spread" style={{ fontSize: 11 }}>
              <span>{fmtChf(BUDGET_MIN)}</span><span>{fmtChf(BUDGET_MAX)}</span>
            </div>
          </div>
          <div>
            <label className="field">Zielgrösse</label>
            <div className="pill-tabs">
              <button className={objective === 'perGame' ? 'active' : ''} onClick={() => setObjective('perGame')}>Punkte/Spiel</button>
              <button className={objective === 'total' ? 'active' : ''} onClick={() => setObjective('total')}>Saison-Total</button>
            </div>
          </div>
          <div>
            <label className="field">Mindest-Spiele</label>
            <select value={minGp} onChange={(e) => setMinGp(Number(e.target.value))}>
              {MIN_GP_OPTIONS.map((n) => <option key={n} value={n}>≥ {n} Spiele</option>)}
            </select>
          </div>
        </div>
        <div className="muted mt" style={{ fontSize: 11.5 }}>
          Aufstellung fix: 1 Torhüter, 6 Verteidiger, 9 Stürmer (16 Spieler, offizielle Topscorers-Regel). Exakte DP über ein
          CHF-10&#39;000-Budgetraster - keine Heuristik, das Ergebnis ist innerhalb dieses Rasters garantiert optimal.
          Nur Spieler mit bekanntem Marktwert (NL-API) und mindestens {minGp} Spielen kommen in Frage.
        </div>
      </div>

      {!result.feasible ? (
        <div className="empty">
          <div className="title">Kein gültiges Team innerhalb des Budgets</div>
          <div className="hint">
            {result.reason}
            {result.minRequiredBudget != null && (
              <> Minimal nötiges Budget für eine gültige Aufstellung: <strong>{fmtChf(result.minRequiredBudget)} CHF</strong>.</>
            )}
          </div>
          {result.minRequiredBudget != null && result.minRequiredBudget <= BUDGET_MAX && (
            <div style={{ marginTop: 14 }}>
              <button className="btn primary" onClick={() => setBudget(Math.ceil(result.minRequiredBudget / BUDGET_UI_STEP) * BUDGET_UI_STEP)}>
                Budget auf Minimum setzen
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="stat-strip mb">
            <div className="stat"><strong>{fmtChf(result.totalCost)}</strong><span>Gesamtkosten</span></div>
            <div className="stat"><strong>{fmtChf(result.remainingBudget)}</strong><span>Restbudget</span></div>
            <div className="stat"><strong>{result.totalValue.toFixed(objective === 'total' ? 0 : 1)}</strong><span>{objectiveLabel} (Team)</span></div>
            <div className="stat"><strong>16</strong><span>Spieler</span></div>
          </div>

          {POSITION_ORDER.map((pos) => (
            <RosterTable
              key={pos}
              title={`${POSITION_FULL_LABEL[pos]} (${result.roster[pos].length})`}
              entries={result.roster[pos]}
              objective={objective}
              teamMap={teamMap}
            />
          ))}
        </>
      )}
    </>
  )
}

function RosterTable({ title, entries, objective, teamMap }) {
  return (
    <div className="card mb">
      <div className="card-pad" style={{ paddingBottom: 6 }}><h2 style={{ margin: 0 }}>{title}</h2></div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="left">Spieler</th>
              <th className="left">Team</th>
              <th className="num">Marktwert</th>
              <th className="num">Fantasy-Pkt</th>
              <th className="num">Pkt/Spiel</th>
              <th className="num">Pkt/Mio CHF</th>
            </tr>
          </thead>
          <tbody>
            {entries.map(({ row, marketValue }) => {
              const perM = marketValue > 0 ? row.fantasy.total / (marketValue / 1_000_000) : null
              return (
                <tr key={row.player.id}>
                  <td className="left"><Link to={`/players/${row.player.id}`}>{row.player.name}</Link></td>
                  <td className="left"><TeamBadge team={teamMap[row.player.teamId]} short /></td>
                  <td className="num">{fmtChf(marketValue)}</td>
                  <td className="num"><strong className={objective === 'total' ? 'good' : ''}>{Math.round(row.fantasy.total)}</strong></td>
                  <td className="num"><strong className={objective === 'perGame' ? 'good' : ''}>{row.fantasy.perGame != null ? row.fantasy.perGame.toFixed(1) : '–'}</strong></td>
                  <td className="num">{perM != null ? Math.round(perM).toLocaleString('de-CH') : '–'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

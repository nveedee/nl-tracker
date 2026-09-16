import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, Empty, StatTile, SectionHeader } from '../components/ui.jsx'
import { isFinalGame } from '../stats.js'
import { useSimResults, getProbsRow } from '../simResultsContext.jsx'
import { computeMatchForecasts, computeFixtures } from '../playoffSim.js'
import { usePreseasonElo, computePreseasonRatings } from '../preseasonElo.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from '../marketValuePrior.js'
import { OT_SHARE_OF_TIES } from '../liveProbability.js'
import PlayoffWheel from '../components/PlayoffWheel.jsx'
import MatchForecast from '../components/MatchForecast.jsx'

export default function Dashboard() {
  const { data, derived } = useData()
  const { standings, playerStats, elo } = derived
  const games = data.games

  const topScorers = [...playerStats]
    .filter((p) => p.gp > 0)
    .sort((a, b) => b.points - a.points || b.goals - a.goals)
    .slice(0, 5)

  const playedGames = games.filter(isFinalGame)
  const upcoming = games.filter((g) => !isFinalGame(g)).sort((a, b) => (a.date > b.date ? 1 : -1))
  const showUpcoming = playedGames.length === 0
  const recent = showUpcoming
    ? upcoming.slice(0, 6)
    : [...playedGames].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6)
  const scheduledCount = games.filter((g) => g.status === 'scheduled').length

  // Playoff Probability Wheel: aus dem zentralen Live-Ergebnis-Store
  // (src/simResultsContext.jsx) - kein eigener Simulationslauf auf dem
  // Dashboard (10'000 Läufe würden das sonst sofortige Laden blockieren).
  // Der Store wird beim ersten Simulationslauf auf /playoff-odds befüllt
  // (danach bei jedem weiteren Lauf SOFORT aktualisiert, ohne Reload) - ohne
  // bisherigen Lauf in dieser Session zeigt er die letzte Tages-Baseline,
  // ohne jegliche vorherige Baseline bleibt das Wheel aus (kein erfundener/
  // leerer Sektor). Dieselbe Datenquelle wie die Detailansicht PlayoffOdds.jsx.
  const { rows: simRows, updatedAt: simUpdatedAt } = useSimResults()
  const playoffWheelRows = useMemo(() => {
    if (!simRows) return []
    return data.teams
      .map((team) => {
        const row = getProbsRow(simRows, team.id)
        return row ? { team, pPlayoffs: row.pPlayoffs, pSemifinal: row.pSemifinal, pFinal: row.pFinal, pChampion: row.pChampion } : null
      })
      .filter(Boolean)
  }, [simRows, data.teams])
  const simUpdatedLabel = simUpdatedAt
    ? new Date(simUpdatedAt).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' }).replace(/\.$/, '')
    : null

  // Match Forecasts (Requirement "Dashboard Polish": eigene Sektion
  // zwischen Season Projection und Tabelle/ELO/Topskorer) - identische
  // Herleitung wie PlayoffOdds.jsx (siehe dortiger Kommentar), hier auf die
  // nächsten 4 Spiele begrenzt. usePreseasonElo() lädt einmalig, danach
  // synchron aus dem Cache (siehe preseasonElo.js) - kein zusätzlicher
  // Ladezustand nötig, den das Dashboard abfangen müsste.
  const preseasonSeasonEnd = usePreseasonElo()
  const initialRatings = useMemo(() => {
    if (!data?.teams) return null
    const eloStart = data.settings?.eloStart ?? 1500
    const useMarketValue = data.settings?.marketValuePriorEnabled !== false
    const marketPrior = useMarketValue
      ? computeMarketValuePrior(data.teams, data.players, eloStart, data.settings?.priorSpread ?? DEFAULT_PRIOR_SPREAD)
      : null
    return marketPrior || computePreseasonRatings(preseasonSeasonEnd, eloStart)
  }, [data, preseasonSeasonEnd])
  const forecasts = useMemo(() => {
    if (!data?.teams || !data?.games) return []
    const base = computeMatchForecasts(data.teams, data.games, data.settings, data.players || [], initialRatings)
    const { fixtures, eloRatings } = computeFixtures(data.teams, data.games, data.settings, data.players || [], initialRatings)
    const fixtureByGameId = new Map(fixtures.map((f) => [f.gameId, f]))
    return base.map((f) => {
      const fx = fixtureByGameId.get(f.gameId)
      if (!fx) return f
      return {
        ...f,
        expHomeGoals: fx.expHome, expAwayGoals: fx.expAway,
        eloHome: eloRatings[f.homeTeam.id], eloAway: eloRatings[f.awayTeam.id],
        pOT: f.pDecision * OT_SHARE_OF_TIES, pSO: f.pDecision * (1 - OT_SHARE_OF_TIES),
      }
    })
  }, [data, initialRatings])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{data.settings.seasonName}</h1>
        </div>
      </div>

      <div className="tiles mb">
        <StatTile label="Teams" value={data.teams.length} />
        <StatTile label="Spieler" value={data.players.length} />
        <StatTile label="Spiele" value={playedGames.length} />
        <StatTile label="Tore" value={playedGames.reduce((s, g) => s + g.homeGoals + g.awayGoals, 0)} />
      </div>

      {games.length === 0 ? (
        <Empty
          title="Noch keine Daten synchronisiert"
          hint={'Teams, Kader und Spiele werden automatisch per Sync geladen (siehe „Sync" oben rechts).'}
        />
      ) : (
        <>
          <div className="section-label">Season Projection</div>
          {playoffWheelRows.length > 0 ? (
            <PlayoffWheel rows={playoffWheelRows} updatedLabel={`Stand ${simUpdatedLabel}`} />
          ) : (
            <div className="playoff-wheel-card mb">
              <SectionHeader
                title="Playoff-Chancen"
                caption="Noch keine Simulation gelaufen."
                action={<Link className="btn ghost sm" to="/playoff-odds">Simulieren →</Link>}
              />
            </div>
          )}

          {forecasts.length > 0 && (
            <>
              <div className="section-label" style={{ marginTop: 22 }}>Match Forecasts</div>
              <MatchForecast
                forecasts={forecasts}
                title="Nächste Spiele"
                caption="Heimsieg-/Auswärtssieg-Chance, Expected Goals, OT/SO-Anteil und ELO."
                limit={4}
                showCount={false}
              />
            </>
          )}

          <div className="section-label" style={{ marginTop: 22 }}>Tabelle · ELO · Topskorer · Letzte Spiele</div>
          <div className="grid grid-2">
          <div className="card card-pad">
            <SectionHeader
              title="Tabelle" caption="Aktueller Stand nach Punkten."
              action={<Link className="btn ghost sm" to="/standings">Alle →</Link>}
            />
            {standings.slice(0, 6).map((r, i) => (
              <div key={r.team.id} className="row spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="row gap-sm"><span className="rank">{i + 1}</span><TeamBadge team={r.team} /></span>
                <span className="num" style={{ fontFamily: 'var(--mono)' }}>{r.pts} <span className="muted">Pkt</span></span>
              </div>
            ))}
          </div>

          <div className="card card-pad">
            <SectionHeader
              title="ELO-Ranking" caption="Spielstärke aus bisherigen Resultaten, laufend aktualisiert."
              action={<Link className="btn ghost sm" to="/elo">Alle →</Link>}
            />
            {elo.ranking.slice(0, 6).map((r, i) => (
              <div key={r.team.id} className="row spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="row gap-sm"><span className="rank">{i + 1}</span><TeamBadge team={r.team} /></span>
                <span className="num" style={{ fontFamily: 'var(--mono)' }}>{r.rating}</span>
              </div>
            ))}
          </div>

          <div className="card card-pad">
            <SectionHeader
              title="Playoff Odds"
              caption={scheduledCount > 0 ? `${scheduledCount} offene Spiele im Spielplan.` : 'Keine offenen Spiele im Spielplan.'}
              action={<Link className="btn ghost sm" to="/playoff-odds">Öffnen →</Link>}
            />
            <div className="muted" style={{ fontSize: 13, lineHeight: 1.6 }}>
              Monte-Carlo-Simulation der Resttabelle auf Basis von ELO, Offensive/Defensive und Form.
            </div>
          </div>

          <div className="card card-pad">
            <SectionHeader
              title="Topskorer" caption="Beste Scorer nach Skorerpunkten (Tore + Assists)."
              action={<Link className="btn ghost sm" to="/players">Alle →</Link>}
            />
            {topScorers.length === 0 && <div className="muted">Noch keine Spieler-Stats.</div>}
            {topScorers.map((p, i) => (
              <div key={p.player.id} className="row spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="row gap-sm">
                  <span className="rank">{i + 1}</span>
                  <Link to={`/players/${p.player.id}`}>{p.player.name}</Link>
                </span>
                <span className="num" style={{ fontFamily: 'var(--mono)' }}>
                  {p.points} P <span className="muted">({p.goals}+{p.assists})</span>
                </span>
              </div>
            ))}
          </div>

          <div className="card card-pad" style={{ gridColumn: '1 / -1' }}>
            <SectionHeader
              title={showUpcoming ? 'Nächste Spiele' : 'Letzte Spiele'}
              caption={showUpcoming ? 'Die kommenden Ansetzungen.' : 'Zuletzt gespielte Partien.'}
              action={<Link className="btn ghost sm" to={showUpcoming ? '/schedule' : '/games'}>Alle →</Link>}
            />
            {recent.length === 0 ? (
              <div className="muted">Noch keine Spiele im Spielplan.</div>
            ) : (
              <div className="grid grid-3">
                {recent.map((g) => {
                  const h = data.teams.find((t) => t.id === g.homeTeamId)
                  const a = data.teams.find((t) => t.id === g.awayTeamId)
                  const gamePlayed = isFinalGame(g)
                  return (
                    <Link key={g.id} to={`/matchup/${g.id}`} className="card card-pad" style={{ display: 'block' }}>
                      <div className="muted" style={{ fontSize: 11.5 }}>
                        {g.date}{g.time ? ` · ${g.time}` : ''}{gamePlayed && g.decision !== 'REG' ? ` · ${g.decision}` : ''}
                      </div>
                      <div className="row spread mt">
                        <TeamBadge team={h} short link={false} />
                        {gamePlayed
                          ? <strong style={{ fontFamily: 'var(--mono)' }}>{g.homeGoals}:{g.awayGoals}</strong>
                          : <span className="muted" style={{ fontFamily: 'var(--mono)' }}>–:–</span>}
                        <TeamBadge team={a} short link={false} />
                      </div>
                    </Link>
                  )
                })}
              </div>
            )}
          </div>
          </div>
        </>
      )}
    </>
  )
}

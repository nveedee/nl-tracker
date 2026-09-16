import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { computeMatchForecasts } from '../playoffSim.js'
import { withPregamePredictions } from '../pregamePrediction.js'
import { usePreseasonElo, computePreseasonRatings } from '../preseasonElo.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from '../marketValuePrior.js'
import { useLiveGamesList, buildRealLiveMatch } from '../liveGameClient.js'
import LiveMatchHeader from './LiveMatchHeader.jsx'

// Zentrale "Live jetzt"-Sektion - EINE Implementierung, wiederverwendet auf
// Dashboard.jsx UND Schedule.jsx (keine zweite Live-Logik). Rendert
// ausschliesslich, wenn tatsächlich mindestens ein Spiel live ist
// (liveGames.length === 0 -> null, kein Platzhalter, keine leere Card).
//
// Pre-Game-Werte (expHomeFull/expAwayFull/pHomePreGame) laufen über
// dieselbe zentrale Quelle wie überall sonst (src/pregamePrediction.js,
// Snapshot zuerst) - computeMatchForecasts() hier ist NUR der bestehende,
// unveränderte Live-Fallback-Pfad (geschlossene ELO-Formel, keine
// Monte-Carlo), falls für ein live laufendes Spiel ausnahmsweise kein
// Snapshot existiert. buildRealLiveMatch() ist exakt dieselbe Funktion, die
// auch MatchupDetail.jsx für die echte Live-Ansicht verwendet.
export default function LiveNowSection() {
  const { data } = useData()
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
    return withPregamePredictions(base, data.predictions)
  }, [data, initialRatings])

  const rawLiveStates = useLiveGamesList()
  const teamById = useMemo(() => new Map(data.teams.map((t) => [t.id, t])), [data.teams])
  const gameById = useMemo(() => new Map(data.games.map((g) => [g.id, g])), [data.games])
  const forecastByGameId = useMemo(() => new Map(forecasts.map((f) => [f.gameId, f])), [forecasts])

  const liveGames = useMemo(() => {
    return rawLiveStates
      .map((liveState) => {
        const game = gameById.get(liveState.gameId)
        const forecast = forecastByGameId.get(liveState.gameId)
        if (!game || !forecast) return null
        const homeTeam = teamById.get(game.homeTeamId)
        const awayTeam = teamById.get(game.awayTeamId)
        if (!homeTeam || !awayTeam) return null
        const pregame = { expHomeFull: forecast.expHomeGoals, expAwayFull: forecast.expAwayGoals, pHomePreGame: forecast.pHomeWin }
        return { gameId: liveState.gameId, homeTeam, awayTeam, live: buildRealLiveMatch({ liveState, homeTeam, awayTeam, pregame, history: [] }) }
      })
      .filter(Boolean)
  }, [rawLiveStates, gameById, teamById, forecastByGameId])

  if (liveGames.length === 0) return null

  return (
    <>
      <div className="section-label" style={{ marginTop: 4 }}>🔴 Live jetzt</div>
      <div className={`grid mb ${liveGames.length === 1 ? '' : liveGames.length === 2 ? 'grid-2' : 'grid-3'}`}>
        {liveGames.map((lg) => (
          <Link key={lg.gameId} to={`/matchup/${lg.gameId}`} className="live-dashboard-link">
            <LiveMatchHeader homeTeam={lg.homeTeam} awayTeam={lg.awayTeam} live={lg.live} probability={lg.live.probability} />
          </Link>
        ))}
      </div>
    </>
  )
}

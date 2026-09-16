// ---------------------------------------------------------------------------
// Dashboard (/) - "Command Center": kompakte Hierarchie statt Tabellen-
// Sammlung. Reihenfolge (oben -> unten, wichtig -> Detail):
//   1. Season Hero  2. Next Games  3. Playoff Picture  4. League Pulse
//   5. Table Snapshot  6. Last Games
// Die vormals grosse Playoff-Probability-Kreisgrafik (PlayoffWheel.jsx) ist
// entfernt (redundant zur ausführlichen Visualisierung auf /playoff-odds,
// die unverändert bleibt) - "Playoff Picture" unten nutzt dieselben,
// bereits vorhandenen Werte nur als kompakte Liste + ProbBar. Keine neue
// Berechnung irgendwo auf dieser Seite - ausschliesslich bereits bestehende
// Datenquellen (derived.*, simResultsContext, playerHistory.js,
// marketValueHistory.js, restDays.js), nur anders/kompakter dargestellt.
// ---------------------------------------------------------------------------

import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, Empty, SectionHeader, ProbBar } from '../components/ui.jsx'
import { isFinalGame, computeTeamForm, fmtChf } from '../stats.js'
import { useSimResults, getProbsRow } from '../simResultsContext.jsx'
import { computeMatchForecasts } from '../playoffSim.js'
import { usePreseasonElo, computePreseasonRatings } from '../preseasonElo.js'
import { computeMarketValuePrior, DEFAULT_PRIOR_SPREAD } from '../marketValuePrior.js'
import { computeRestAdjustment, DEFAULT_BACK_TO_BACK_PENALTY } from '../restDays.js'
import { withPregamePredictions } from '../pregamePrediction.js'
import { computeLeagueMarketMovers } from '../marketValueHistory.js'
import { usePlayerHistory, usePositionBaselines, getPlayerSeasons, computeImpactScore, POSITION_LABEL } from '../playerHistory.js'
import MatchForecast from '../components/MatchForecast.jsx'
import SyncStatus from '../components/SyncStatus.jsx'

const PULSE_MARKET_WINDOW_DAYS = 14

export default function Dashboard() {
  const { data, derived } = useData()
  const { standings, playerStats, elo } = derived
  const games = data.games
  const playerHistoryData = usePlayerHistory()
  const baselines = usePositionBaselines()

  const topScorers = [...playerStats]
    .filter((p) => p.gp > 0)
    .sort((a, b) => b.points - a.points || b.goals - a.goals)
    .slice(0, 5)

  const playedGames = games.filter(isFinalGame)
  const recent = [...playedGames].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 6)
  const scheduledCount = games.filter((g) => g.status === 'scheduled').length

  // 3) Playoff Picture: aus dem zentralen Live-Ergebnis-Store
  // (src/simResultsContext.jsx) - kein eigener Simulationslauf auf dem
  // Dashboard (10'000 Läufe würden das sonst sofortige Laden blockieren).
  // Der Store wird beim ersten Simulationslauf auf /playoff-odds befüllt
  // (danach bei jedem weiteren Lauf SOFORT aktualisiert) - ohne bisherigen
  // Lauf in dieser Session zeigt er die letzte Tages-Baseline, ohne
  // jegliche vorherige Baseline bleibt der Abschnitt aus (kein erfundener
  // Wert). Dieselbe Datenquelle wie die Detailansicht PlayoffOdds.jsx.
  const { rows: simRows, updatedAt: simUpdatedAt } = useSimResults()
  const championshipRows = useMemo(() => {
    if (!simRows) return []
    return data.teams
      .map((team) => {
        const row = getProbsRow(simRows, team.id)
        return row ? { team, pChampion: row.pChampion } : null
      })
      .filter(Boolean)
      .sort((a, b) => b.pChampion - a.pChampion)
      .slice(0, 6)
  }, [simRows, data.teams])
  const simUpdatedLabel = simUpdatedAt
    ? new Date(simUpdatedAt).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit' }).replace(/\.$/, '')
    : null

  // 2) Next Games - identische Herleitung wie PlayoffOdds.jsx (siehe
  // dortiger Kommentar), hier auf die nächsten Spiele begrenzt.
  // usePreseasonElo() lädt einmalig, danach synchron aus dem Cache.
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
  const restDaysEnabled = data.settings?.restDaysEnabled !== false
  const backToBackPenalty = data.settings?.backToBackPenalty ?? DEFAULT_BACK_TO_BACK_PENALTY
  const gameById = useMemo(() => new Map(data.games.map((g) => [g.id, g])), [data.games])
  // EIN einziger Aufruf holt bereits Elo/xG/OT-SO-Split mit (siehe
  // computeMatchForecasts()-Kommentar) - kein zweiter computeFixtures()-Aufruf
  // mehr nur zum Nachladen dieser Felder. withPregamePredictions() ersetzt
  // pHomeWin/pAwayWin/pOT/pSO/expHomeGoals/expAwayGoals/eloHome/eloAway durch
  // den eingefrorenen Snapshot (server/scripts/predictions.js), sobald einer
  // existiert - dieselbe Single Source of Truth wie auf allen anderen Seiten
  // (siehe src/pregamePrediction.js). Ohne Snapshot bleiben die hier live
  // berechneten Werte unverändert bestehen (Fallback).
  const forecasts = useMemo(() => {
    if (!data?.teams || !data?.games) return []
    const base = computeMatchForecasts(data.teams, data.games, data.settings, data.players || [], initialRatings)
    const withPredictions = withPregamePredictions(base, data.predictions)
    return withPredictions.map((f) => {
      // B2B/Rest-Hinweis (identisch zu Schedule.jsx) - reine Anzeige, fliesst
      // NICHT in pHomeWin ein (das steckt bereits in der Prediction selbst,
      // egal ob Snapshot oder Live-Fallback - siehe restDays.js/predictions.js).
      let restNote = null
      if (restDaysEnabled) {
        const game = gameById.get(f.gameId)
        const adj = game ? computeRestAdjustment(game, data.games, backToBackPenalty) : 0
        if (adj > 0) restNote = `${f.homeTeam.short} ausgeruht (Back-to-back bei ${f.awayTeam.short})`
        else if (adj < 0) restNote = `${f.awayTeam.short} ausgeruht (Back-to-back bei ${f.homeTeam.short})`
      }
      return { ...f, restNote }
    })
  }, [data, initialRatings, restDaysEnabled, backToBackPenalty, gameById])

  // 4a) Form: "heisseste" Teams nach Punkten/Spiel der letzten 5 Partien
  // (src/stats.js::computeTeamForm, unverändert) - nur Teams mit >=1 Spiel
  // im Fenster (sonst wäre ein 0-Spiele-Team fälschlich "Form 0.00").
  const formPulse = useMemo(() => {
    return data.teams
      .map((team) => ({ team, form: computeTeamForm(team.id, data.games, 5) }))
      .filter((r) => r.form.gp > 0)
      .sort((a, b) => b.form.avgPts - a.form.avgPts)
      .slice(0, 3)
  }, [data.teams, data.games])

  // 4b) ELO Movement: Veränderung ggü. dem ERSTEN Verlaufseintrag
  // (Pre-Season-ELO, history[0] - siehe elo.js: `history[t.id] = [{ index:
  // 0, date: null, rating: teamStart }]`) - also exakt "seit Saisonstart",
  // identische Kennzahl wie die "Veränderung" auf TeamDetail.jsx. Hier in
  // Gewinner/Verlierer getrennt (statt nach Betrag gemischt) und auf je
  // max. 3 begrenzt - reine Darstellung, keine neue ELO-Berechnung.
  const eloMovers = useMemo(() => {
    const changes = data.teams
      .map((team) => {
        const hist = elo.history[team.id] || []
        if (hist.length < 2) return null
        const current = elo.ranking.find((r) => r.team.id === team.id)?.rating
        if (current == null) return null
        return { team, change: Math.round(current - hist[0].rating) }
      })
      .filter(Boolean)
    return {
      winners: changes.filter((c) => c.change > 0).sort((a, b) => b.change - a.change).slice(0, 3),
      losers: changes.filter((c) => c.change < 0).sort((a, b) => a.change - b.change).slice(0, 3),
    }
  }, [data.teams, elo])

  // 4c) Market Movers: echte CHF-Veränderung (marketValueHistory.js, wie auf
  // /players) - solange nicht genug Verlaufsdaten vorliegen, ehrlicher
  // Hinweis statt erfundener Werte.
  const marketMovers = useMemo(
    () => computeLeagueMarketMovers(data.players, PULSE_MARKET_WINDOW_DAYS, { limit: 2 }),
    [data.players]
  )

  // 4d) Scoring: Topscorer/P-GP/Impact Score aus bereits vorhandenen
  // Player-Daten (derived.playerStats, playerHistory.js::computeImpactScore -
  // identisch zu /players).
  const scoringPulse = useMemo(() => {
    const withGames = playerStats.filter((p) => p.gp > 0 && p.player.position !== 'G')
    const topPoints = [...withGames].sort((a, b) => b.points - a.points)[0] || null
    const topPpg = [...withGames].sort((a, b) => (b.points / b.gp) - (a.points / a.gp))[0] || null
    let topImpact = null
    if (baselines && playerHistoryData) {
      let best = null
      for (const p of data.players) {
        if (p.position === 'G') continue
        const impact = computeImpactScore(getPlayerSeasons(playerHistoryData, p.id), POSITION_LABEL[p.position], baselines)
        if (impact && (!best || impact.score > best.impact.score)) best = { player: p, impact }
      }
      topImpact = best
    }
    return { topPoints, topPpg, topImpact }
  }, [playerStats, data.players, baselines, playerHistoryData])

  return (
    <>
      {/* 1) Season Hero / Status */}
      <div className="page-head">
        <div>
          <h1>{data.settings.seasonName}</h1>
        </div>
        <SyncStatus />
      </div>

      {games.length === 0 ? (
        <Empty
          title="Noch keine Daten synchronisiert"
          hint={'Teams, Kader und Spiele werden automatisch per Sync geladen (siehe „Sync" oben rechts).'}
        />
      ) : (
        <>
          <div className="card card-pad mb">
            <div className="stat-strip">
              <div className="stat"><strong>{data.teams.length}</strong><span>Teams</span></div>
              <div className="stat"><strong>{data.players.length}</strong><span>Spieler</span></div>
              <div className="stat"><strong>{playedGames.length}</strong><span>Spiele gespielt</span></div>
              <div className="stat"><strong>{playedGames.reduce((s, g) => s + g.homeGoals + g.awayGoals, 0)}</strong><span>Tore</span></div>
              <div className="stat"><strong>{scheduledCount}</strong><span>Offene Spiele</span></div>
            </div>
          </div>

          {/* 2) Next Games */}
          {forecasts.length > 0 && (
            <MatchForecast
              forecasts={forecasts}
              title="Nächste Spiele"
              caption="Heimsieg-/Auswärtssieg-Chance, Expected Goals, OT/SO-Anteil und ELO."
              limit={6}
              showCount={false}
            />
          )}

          {/* 3) Playoff Picture - ersetzt die frühere Kreisgrafik durch eine
              kompakte Liste derselben, bereits vorhandenen Werte. */}
          <SectionHeader
            title="Playoff Picture"
            caption={championshipRows.length > 0 ? `Meisterchance · Stand ${simUpdatedLabel}` : 'Noch keine Simulation gelaufen.'}
            action={<Link className="btn ghost sm" to="/playoff-odds">{championshipRows.length > 0 ? 'Alle 14 Teams →' : 'Simulieren →'}</Link>}
          />
          {championshipRows.length > 0 && (
            <div className="card mb">
              {championshipRows.map((r, i) => (
                <div key={r.team.id} className="row gap-sm" style={{ padding: '9px 14px', borderBottom: '1px solid var(--border)' }}>
                  <span className="rank" style={{ width: 16, flex: 'none' }}>{i + 1}</span>
                  <div style={{ width: 130, flex: 'none' }}><TeamBadge team={r.team} short /></div>
                  <div style={{ flex: 1 }}><ProbBar value={r.pChampion} color="var(--accent)" /></div>
                </div>
              ))}
            </div>
          )}

          {/* 4) League Pulse */}
          <div className="section-label" style={{ marginTop: 22 }}>League Pulse</div>
          <div className="grid grid-4 mb">
            <PulseCard title="Form" caption="Letzte 5 Spiele, Punkte/Spiel">
              {formPulse.map((r) => (
                <Link key={r.team.id} to={`/teams/${r.team.id}`} className="leader-item">
                  <span className="leader-name">{r.team.short}</span>
                  <span className="leader-value">{r.form.avgPts.toFixed(2)}</span>
                </Link>
              ))}
            </PulseCard>

            <PulseCard title="ELO">
              {eloMovers.winners.length > 0 || eloMovers.losers.length > 0 ? (
                <>
                  <div className="muted" style={{ fontSize: 10.5, marginTop: -2, marginBottom: 6 }}>Veränderung seit Saisonstart</div>
                  {eloMovers.winners.length > 0 && (
                    <div className="pulse-elo-group">
                      <div className="pulse-elo-label good"><span className="dot" style={{ background: 'var(--good)' }} />Winners</div>
                      {eloMovers.winners.map((r) => (
                        <Link key={r.team.id} to={`/teams/${r.team.id}`} className="leader-item">
                          <span className="leader-name">{r.team.short}</span>
                          <span className="leader-value good">+{r.change}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                  {eloMovers.losers.length > 0 && (
                    <div className="pulse-elo-group">
                      <div className="pulse-elo-label bad"><span className="dot" style={{ background: 'var(--bad)' }} />Losers</div>
                      {eloMovers.losers.map((r) => (
                        <Link key={r.team.id} to={`/teams/${r.team.id}`} className="leader-item">
                          <span className="leader-name">{r.team.short}</span>
                          <span className="leader-value bad">{r.change}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </>
              ) : null}
            </PulseCard>

            <PulseCard
              title="Market Movers"
              caption={marketMovers.ready ? `${PULSE_MARKET_WINDOW_DAYS} Tage` : `sammelt Daten (${marketMovers.count}/${marketMovers.minPlayers})`}
            >
              {marketMovers.ready && [...marketMovers.risers, ...marketMovers.fallers].slice(0, 3).map(({ player, delta }) => (
                <Link key={player.id} to={`/players/${player.id}`} className="leader-item">
                  <span className="leader-name">{player.name}</span>
                  <span className="leader-value" style={{ color: delta > 0 ? 'var(--good)' : 'var(--bad)' }}>
                    {delta >= 0 ? '+' : ''}{fmtChf(delta)}
                  </span>
                </Link>
              ))}
            </PulseCard>

            <PulseCard title="Scoring" caption="Topscorer · P/GP · Impact">
              {scoringPulse.topPoints && (
                <Link to={`/players/${scoringPulse.topPoints.player.id}`} className="leader-item">
                  <span className="leader-name">{scoringPulse.topPoints.player.name}</span>
                  <span className="leader-value">{scoringPulse.topPoints.points} P</span>
                </Link>
              )}
              {scoringPulse.topPpg && (
                <Link to={`/players/${scoringPulse.topPpg.player.id}`} className="leader-item">
                  <span className="leader-name">{scoringPulse.topPpg.player.name}</span>
                  <span className="leader-value">{(scoringPulse.topPpg.points / scoringPulse.topPpg.gp).toFixed(2)} P/GP</span>
                </Link>
              )}
              {scoringPulse.topImpact && (
                <Link to={`/players/${scoringPulse.topImpact.player.id}`} className="leader-item">
                  <span className="leader-name">{scoringPulse.topImpact.player.name}</span>
                  <span className="leader-value">{scoringPulse.topImpact.impact.score.toFixed(1)} Impact</span>
                </Link>
              )}
            </PulseCard>
          </div>

          {/* 5) Table Snapshot + 6) Last Games */}
          <div className="grid grid-2">
            <div className="card card-pad">
              <SectionHeader
                title="Tabelle" caption="Top 6 nach Punkten."
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
                title="Letzte Spiele" caption="Zuletzt gespielte Partien."
                action={<Link className="btn ghost sm" to="/schedule">Alle →</Link>}
              />
              {recent.length === 0 ? (
                <div className="muted">Noch keine Spiele gespielt.</div>
              ) : recent.map((g) => {
                const h = data.teams.find((t) => t.id === g.homeTeamId)
                const a = data.teams.find((t) => t.id === g.awayTeamId)
                return (
                  <Link key={g.id} to={`/matchup/${g.id}`} className="row spread" style={{ padding: '7px 0', borderBottom: '1px solid var(--border)' }}>
                    <span className="muted" style={{ fontSize: 11.5, width: 70, flex: 'none' }}>{g.date}</span>
                    <span className="row gap-sm" style={{ flex: 1, justifyContent: 'center' }}>
                      <TeamBadge team={h} short link={false} />
                      <strong style={{ fontFamily: 'var(--mono)' }}>{g.homeGoals}:{g.awayGoals}</strong>
                      <TeamBadge team={a} short link={false} />
                    </span>
                  </Link>
                )
              })}
            </div>
          </div>
        </>
      )}
    </>
  )
}

// Kompakte Kennzahlen-Karte für "League Pulse" - nutzt dieselben
// .leader-card/.leader-item-Styles wie die League-Leader-Reihe auf
// /players (siehe styles.css), hier in einem statischen 4er-Grid statt
// einer horizontal scrollenden Reihe.
function PulseCard({ title, caption, children }) {
  const hasChildren = Array.isArray(children) ? children.some(Boolean) : Boolean(children)
  return (
    <div className="card leader-card">
      <div className="card-pad" style={{ paddingBottom: 8 }}>
        <div className="leader-title">{title}</div>
        {hasChildren ? children : <div className="muted" style={{ fontSize: 11.5 }}>{caption || 'Noch keine Daten'}</div>}
      </div>
    </div>
  )
}

import { useMemo, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, MarketValueTrend } from '../components/ui.jsx'
import { fmtPct, fmtNum, plusMinusStr, ageFromBirthdate, fmtChf } from '../stats.js'
import { computeFantasyBreakdown } from '../fantasyScore.js'
import { hasEnoughHistoryForChart, computeMarketValueChange } from '../marketValueHistory.js'
import {
  usePlayerHistory, usePositionBaselines, getPlayerSeasons, seasonRates, careerSummary, yoyDevelopment,
  computeImpactScore, computePercentile, classifyTrend, recentPpg, POSITION_LABEL,
  buildCurrentSeasonRecord, computeSeasonImpactScore, computeImpactScoreHistory, computeRollingForm,
  TREND_MIN_LATEST_GP, resolveGameTeam, computeHomeAwaySplit, computeOpponentBreakdown, computeTeamStints,
} from '../playerHistory.js'

const posLabel = { G: 'Torhüter', D: 'Verteidiger', F: 'Stürmer' }
const shootsLabel = { L: 'schiesst L', R: 'schiesst R' }

function fmt2(v) { return v == null ? '–' : v.toFixed(2) }
function fmtSec(v) {
  if (v == null) return '–'
  const m = Math.floor(v / 60), s = Math.round(v % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

export default function PlayerDetail() {
  const { id } = useParams()
  const { data, derived } = useData()
  const playerHistoryData = usePlayerHistory()
  const baselines = usePositionBaselines()
  const player = data.players.find((p) => p.id === id)
  if (!player) return <div className="muted">Spieler nicht gefunden.</div>

  const team = data.teams.find((t) => t.id === player.teamId)
  const stat = derived.playerStats.find((s) => s.player.id === id)
  const goalie = player.position === 'G'
  const fantasy = computeFantasyBreakdown(stat)

  const age = ageFromBirthdate(player.birthdate)
  const infoBits = [
    age != null && `${age} J.`,
    player.heightCm && `${player.heightCm} cm`,
    player.weightKg && `${player.weightKg} kg`,
    player.nationality,
    shootsLabel[player.shoots],
  ].filter(Boolean)

  // Spielprotokoll dieses Spielers (aktuelle Saison), neueste zuerst.
  // `resolveGameTeam` löst H/A/Gegner über das AKTUELLE Team auf - siehe
  // Kommentar dort zur Datenmodell-Grenze bei unterjährigem Vereinswechsel:
  // Spiele, die keinem der beiden Spiel-Teams zugeordnet werden können
  // (Team "damals" unklar), bekommen `isHome:null`/`opp:null` statt einer
  // geratenen Zuordnung.
  const log = []
  for (const g of data.games) {
    const s = (g.playerStats || []).find((x) => x.playerId === id)
    if (!s) continue
    const r = resolveGameTeam(g, player)
    const opp = r.certain ? data.teams.find((t) => t.id === (r.isHome ? g.awayTeamId : g.homeTeamId)) : null
    log.push({ game: g, s, opp, isHome: r.certain ? r.isHome : null })
  }
  log.sort((a, b) => (a.game.date < b.game.date ? 1 : -1))
  const logAsc = [...log].reverse() // chronologisch für Formkurve/rollierende Werte

  // Game-Log-Filter (Abschnitt 8) - Saison (aktuell nur eine verfügbar, aber
  // strukturell vorbereitet), Heim/Auswärts, Gegner.
  const [logHaFilter, setLogHaFilter] = useState('all')
  const [logOppFilter, setLogOppFilter] = useState('all')
  const opponentOptions = useMemo(() => {
    const seen = new Map()
    for (const { opp } of log) if (opp) seen.set(opp.id, opp)
    return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [log])
  const filteredLog = useMemo(() => log.filter((r) => {
    if (logHaFilter === 'home' && r.isHome !== true) return false
    if (logHaFilter === 'away' && r.isHome !== false) return false
    if (logOppFilter !== 'all' && r.opp?.id !== logOppFilter) return false
    return true
  }), [log, logHaFilter, logOppFilter])

  const homeAwaySplit = useMemo(() => (!goalie ? computeHomeAwaySplit(log) : null), [goalie, log])
  const opponentBreakdown = useMemo(() => (!goalie ? computeOpponentBreakdown(log) : []), [goalie, log])
  const teamStints = useMemo(() => (!goalie ? computeTeamStints(log, player, data.teams) : null), [goalie, log, player, data.teams])

  // --- Historische Mehrsaison-Daten (public/player-history.json) ---
  const historySeasons = useMemo(
    () => getPlayerSeasons(playerHistoryData, id),
    [playerHistoryData, id]
  )
  const career = useMemo(() => careerSummary(historySeasons), [historySeasons])
  const yoy = useMemo(() => yoyDevelopment(historySeasons), [historySeasons])
  const posLabelHist = POSITION_LABEL[player.position] // 'Stürmer'|'Verteidiger'|'Torhüter'
  const impact = useMemo(
    () => (!goalie && baselines ? computeImpactScore(historySeasons, posLabelHist, baselines) : null),
    [historySeasons, posLabelHist, baselines, goalie]
  )
  const trend = useMemo(() => (!goalie ? classifyTrend(historySeasons) : null), [historySeasons, goalie])
  const last3Ppg = useMemo(() => (!goalie ? recentPpg(historySeasons, 3) : null), [historySeasons, goalie])
  const latestSeason = [...historySeasons].reverse().find((s) => s.gp > 0)
  const percentiles = useMemo(() => {
    if (goalie || !baselines || !latestSeason) return null
    const r = seasonRates(latestSeason)
    return {
      ppg: computePercentile(r.ppg, posLabelHist, 'ppg', baselines),
      gpg: computePercentile(r.gpg, posLabelHist, 'gpg', baselines),
      apg: computePercentile(r.apg, posLabelHist, 'apg', baselines),
      toipg: computePercentile(r.toipg, posLabelHist, 'toipg', baselines),
      sogpg: computePercentile(r.sogpg, posLabelHist, 'sogpg', baselines),
    }
  }, [goalie, baselines, latestSeason, posLabelHist])
  const teamsByHistory = useMemo(() => {
    const seen = []
    for (const s of [...historySeasons].reverse()) {
      const t = data.teams.find((x) => x.id === s.teamId)
      seen.push({ season: s.season, team: t })
    }
    return seen
  }, [historySeasons, data.teams])

  // --- Player Tracker: laufende Saison 2026/27 mit der historischen Ebene
  // verbinden (Abschnitte 2-4, 9 der Aufgabe). `stat` kommt ausschliesslich
  // aus bereits abgeschlossenen ('status:final') Spielen (siehe
  // computePlayerStats in stats.js) - kein Leakage, keine zukünftigen Daten,
  // keine Berührung von db.predictions[].
  const currentSeasonLabel = data.settings?.seasonName?.match(/\d{4}\/\d{2}/)?.[0] || null
  const currentSeasonRecord = useMemo(
    () => (!goalie ? buildCurrentSeasonRecord(stat, player, currentSeasonLabel) : null),
    [goalie, stat, player, currentSeasonLabel]
  )
  // combinedSeasons: historische Saisons + laufende Saison (falls bereits
  // Spiele vorhanden) - wird an dieselben, unveränderten Vergleichs-/Trend-/
  // Impact-Funktionen übergeben, die bereits mergeSeasonSplits() intern
  // verwenden (Schutz vor künstlichem Sprung bei unterjährigem Wechsel).
  const combinedSeasons = useMemo(
    () => (currentSeasonRecord ? [...historySeasons, currentSeasonRecord] : historySeasons),
    [historySeasons, currentSeasonRecord]
  )
  // Vorjahresvergleich der LAUFENDEN Saison - erst ab TREND_MIN_LATEST_GP
  // Spielen dieser Saison (sonst würde 1 frühes Spiel eine irreführend
  // grosse %-Veränderung zeigen).
  const seasonYoy = useMemo(
    () => (!goalie ? yoyDevelopment(combinedSeasons, TREND_MIN_LATEST_GP) : null),
    [goalie, combinedSeasons]
  )
  const priorHistorical = [...historySeasons].reverse().filter((s) => s.gp > 0).slice(0, 2) // [Vorjahr, 2 Jahre zuvor]
  const twoYearsAgo = priorHistorical[1]
  const impactHistory = useMemo(
    () => (!goalie && baselines ? computeImpactScoreHistory(combinedSeasons, posLabelHist, baselines) : []),
    [goalie, baselines, combinedSeasons, posLabelHist]
  )
  const currentImpact = useMemo(
    () => (!goalie && baselines && currentSeasonRecord ? computeSeasonImpactScore(currentSeasonRecord, posLabelHist, baselines) : null),
    [goalie, baselines, currentSeasonRecord, posLabelHist]
  )
  const rollingForm5 = useMemo(() => (!goalie ? computeRollingForm(log, 5) : null), [goalie, log])
  const rollingForm10 = useMemo(() => (!goalie ? computeRollingForm(log, 10) : null), [goalie, log])

  const [histSort, setHistSort] = useState('season')
  const [histDir, setHistDir] = useState('desc')
  const sortedHistory = useMemo(() => {
    const rows = [...historySeasons]
    const val = (s) => {
      if (histSort === 'season') return s.season
      if (histSort === 'team') return s.teamId || ''
      if (histSort === 'gp') return s.gp
      if (histSort === 'goals') return s.goals
      if (histSort === 'assists') return s.assists
      if (histSort === 'points') return s.points
      if (histSort === 'ppg') return seasonRates(s).ppg ?? -1
      if (histSort === 'sog') return s.sog
      if (histSort === 'toipg') return seasonRates(s).toipg ?? -1
      if (histSort === 'plusMinus') return s.plusMinus
      if (histSort === 'saves') return s.saves
      if (histSort === 'svpct') return s.shotsAgainst > 0 ? s.saves / s.shotsAgainst : -1
      if (histSort === 'gaa') return s.gp > 0 ? s.goalsAgainst / s.gp : 99
      return s.season
    }
    rows.sort((a, b) => {
      const va = val(a), vb = val(b)
      const cmp = typeof va === 'string' ? va.localeCompare(vb) : va - vb
      return histDir === 'asc' ? cmp : -cmp
    })
    return rows
  }, [historySeasons, histSort, histDir])

  const sortHist = (key) => {
    if (key === histSort) setHistDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    else { setHistSort(key); setHistDir('desc') }
  }
  const sortInd = (key) => (histSort === key ? (histDir === 'asc' ? ' ▲' : ' ▼') : '')

  return (
    <>
      <div className="page-head">
        <div>
          <div className="row gap-sm"><TeamBadge team={team} /></div>
          <h1 className="row gap-sm">
            {player.number != null && player.number !== '' && <span className="muted">#{player.number}</span>}
            {player.name}
          </h1>
          <div className="sub">
            {posLabel[player.position]}{player.positionDetail ? ` (${player.positionDetail})` : ''}
          </div>
          {infoBits.length > 0 && <div className="sub" style={{ marginTop: 4 }}>{infoBits.join(' · ')}</div>}
        </div>
      </div>

      <div className="tiles mb">
        {goalie ? (
          <>
            <Tile label="Spiele" value={stat?.gp || 0} />
            <Tile label="Bilanz S–N" value={`${stat?.wins || 0}–${stat?.losses || 0}`} />
            <Tile label="Fangquote" value={fmtPct(stat?.savePct)} />
            <Tile label="Gegentorschnitt" value={fmtNum(stat?.gaa)} />
            <Tile label="Shutouts" value={stat?.shutouts || 0} />
          </>
        ) : (
          <>
            <Tile label="Spiele" value={stat?.gp || 0} />
            <Tile label="Tore" value={stat?.goals || 0} />
            <Tile label="Assists" value={stat?.assists || 0} />
            <Tile label="Punkte" value={stat?.points || 0} />
            <Tile label="+/–" value={stat ? plusMinusStr(stat.plusMinus) : 0} />
            <Tile label="Strafminuten" value={stat?.pim || 0} />
          </>
        )}
        {player.marketValue != null && (
          <Tile
            label="Marktwert"
            value={<span className="row gap-sm">{fmtChf(player.marketValue)}<MarketValueTrend trend={player.marketValueTrend} /></span>}
          />
        )}
      </div>

      {/* Fantasy-Punkte (angenäherter Topscorers-Score, src/fantasyScore.js) -
          rein additive Anzeige, keine neue Datenquelle. */}
      {fantasy && fantasy.gp > 0 && (
        <div className="card card-pad mb">
          <div className="row spread" style={{ alignItems: 'baseline', flexWrap: 'wrap', rowGap: 4, marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Fantasy-Punkte</h2>
            <span className="muted" style={{ fontSize: 11 }}>angenäherter Topscorers-Score</span>
          </div>
          <div className="tiles mb" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
            <Tile label="Total" value={Math.round(fantasy.total)} />
            <Tile label="Punkte/Spiel" value={fantasy.perGame != null ? fantasy.perGame.toFixed(1) : '–'} />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th className="left">Kategorie</th><th className="num">Anzahl</th><th className="num">Satz</th><th className="num">Punkte</th></tr>
              </thead>
              <tbody>
                {fantasy.lines.filter((l) => l.count !== 0 || l.key === 'gp').map((l) => (
                  <tr key={l.key}>
                    <td className="left">{l.label}</td>
                    <td className="num">{l.count}</td>
                    <td className="num muted">{l.rate >= 0 ? '+' : ''}{l.rate}</td>
                    <td className="num"><strong className={l.points > 0 ? 'good' : l.points < 0 ? 'bad' : ''}>{Math.round(l.points)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="muted mt" style={{ fontSize: 11 }}>
            Nur Kategorien mit verlässlichen Daten berücksichtigt (Details/fehlende Kategorien siehe „Kategorien anzeigen" auf der{' '}
            <Link to="/fantasy">Fantasy-Rangliste</Link>).
          </div>
        </div>
      )}

      {/* Marktwert-Verlauf (player.marketValueHistory, server/sync.js) - rein
          additive Anzeige, ein Snapshot pro Kalendertag seit Einführung
          dieser Funktion. */}
      {player.marketValue != null && (
        <div className="card card-pad mb">
          <div className="row spread" style={{ alignItems: 'baseline', flexWrap: 'wrap', rowGap: 4, marginBottom: 10 }}>
            <h2 style={{ margin: 0 }}>Marktwert-Verlauf</h2>
            {player.marketValueHistory?.length > 0 && (
              <span className="muted" style={{ fontSize: 11 }}>{player.marketValueHistory.length} Tages-Snapshot{player.marketValueHistory.length === 1 ? '' : 's'}</span>
            )}
          </div>
          {hasEnoughHistoryForChart(player.marketValueHistory) ? (
            <>
              <MarketValueHistoryChart history={player.marketValueHistory} />
              {(() => {
                const change14 = computeMarketValueChange(player.marketValueHistory, 14)
                if (!change14) return null
                return (
                  <div className="muted mt" style={{ fontSize: 12 }}>
                    Letzte {change14.daysSpanned} Tage: <strong className={change14.delta > 0 ? 'good' : change14.delta < 0 ? 'bad' : ''}>
                      {change14.delta >= 0 ? '+' : ''}{fmtChf(change14.delta)} CHF
                      {change14.deltaPct != null && ` (${change14.deltaPct >= 0 ? '+' : ''}${(change14.deltaPct * 100).toFixed(1)}%)`}
                    </strong>
                  </div>
                )
              })()}
            </>
          ) : (
            <div className="muted" style={{ fontSize: 12.5 }}>
              Sammelt Verlaufsdaten – aussagekräftig ab einigen Tagen ({player.marketValueHistory?.length || 0} von mindestens 3 Snapshots).
            </div>
          )}
        </div>
      )}

      {/* Aktuelle Saison vs. Historie + YoY */}
      {!goalie && historySeasons.length > 0 && (
        <div className="card card-pad mb">
          <h2 className="mb">Aktuelle Saison vs. Historie</h2>
          <div className="grid" style={{ gridTemplateColumns: `repeat(${Math.min(historySeasons.length + 1, 5)}, 1fr)`, gap: 10 }}>
            <div className="tile">
              <div className="label">{data.settings?.seasonName?.split(' ').pop() || 'Aktuell'}</div>
              <div className="value mono" style={{ fontSize: 18 }}>{fmt2(stat && stat.gp > 0 ? stat.points / stat.gp : 0)}</div>
              <div className="muted" style={{ fontSize: 10.5 }}>Punkte/Spiel</div>
            </div>
            {[...historySeasons].reverse().slice(0, 4).map((s) => (
              <div className="tile" key={s.season}>
                <div className="label">{s.season}</div>
                <div className="value mono" style={{ fontSize: 18 }}>{fmt2(seasonRates(s).ppg)}</div>
                <div className="muted" style={{ fontSize: 10.5 }}>Punkte/Spiel</div>
              </div>
            ))}
          </div>
          {yoy && (
            <div className="muted mt" style={{ fontSize: 12.5 }}>
              <strong className={yoy.pctChange >= 0 ? 'good' : 'bad'}>
                {yoy.pctChange >= 0 ? '+' : ''}{yoy.pctChange.toFixed(0)}%
              </strong> gegenüber Vorjahr ({yoy.prev.season}: {fmt2(yoy.prevPpg)} → {yoy.latest.season}: {fmt2(yoy.latestPpg)} Pkt/Sp.)
            </div>
          )}
        </div>
      )}

      {/* Saisontrend (laufende Saison 2026/27) - Player Tracker */}
      {!goalie && currentSeasonRecord && (
        <div className="card card-pad mb">
          <h2 className="mb">Saisontrend {currentSeasonLabel}</h2>
          <div className="tiles mb" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <Tile label="Spiele" value={currentSeasonRecord.gp} />
            <Tile label="Tore / Assists" value={`${currentSeasonRecord.goals} / ${currentSeasonRecord.assists}`} />
            <Tile label="Punkte" value={currentSeasonRecord.points} />
            <Tile label="+/–" value={plusMinusStr(currentSeasonRecord.plusMinus)} />
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th className="left">Zeitraum</th><th className="num">P/GP</th><th className="num">SOG/GP</th><th className="num">TOI/GP</th><th className="num">Veränderung</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td className="left"><strong>{currentSeasonLabel} (bisher)</strong></td>
                  <td className="num"><strong>{fmt2(seasonRates(currentSeasonRecord).ppg)}</strong></td>
                  <td className="num">{fmt2(seasonRates(currentSeasonRecord).sogpg)}</td>
                  <td className="num">{fmtSec(seasonRates(currentSeasonRecord).toipg)}</td>
                  <td className="num muted">–</td>
                </tr>
                {priorHistorical[0] && (
                  <tr>
                    <td className="left">Vorjahr ({priorHistorical[0].season})</td>
                    <td className="num">{fmt2(seasonRates(priorHistorical[0]).ppg)}</td>
                    <td className="num">{fmt2(seasonRates(priorHistorical[0]).sogpg)}</td>
                    <td className="num">{fmtSec(seasonRates(priorHistorical[0]).toipg)}</td>
                    <td className="num">
                      {seasonYoy ? (
                        <strong className={seasonYoy.pctChange >= 0 ? 'good' : 'bad'}>{seasonYoy.pctChange >= 0 ? '+' : ''}{seasonYoy.pctChange.toFixed(0)}%</strong>
                      ) : <span className="muted">–</span>}
                    </td>
                  </tr>
                )}
                {twoYearsAgo && (
                  <tr>
                    <td className="left">2 Jahre zuvor ({twoYearsAgo.season})</td>
                    <td className="num">{fmt2(seasonRates(twoYearsAgo).ppg)}</td>
                    <td className="num">{fmt2(seasonRates(twoYearsAgo).sogpg)}</td>
                    <td className="num">{fmtSec(seasonRates(twoYearsAgo).toipg)}</td>
                    <td className="num muted">–</td>
                  </tr>
                )}
                {career && (
                  <tr>
                    <td className="left">Karriere</td>
                    <td className="num">{fmt2(career.careerPpg)}</td>
                    <td className="num muted">–</td>
                    <td className="num muted">–</td>
                    <td className="num muted">–</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {!seasonYoy && currentSeasonRecord.gp < TREND_MIN_LATEST_GP && (
            <div className="muted mt" style={{ fontSize: 11 }}>Vorjahresvergleich erst ab {TREND_MIN_LATEST_GP} Spielen dieser Saison verfügbar (aktuell {currentSeasonRecord.gp}).</div>
          )}
        </div>
      )}

      {/* Form Splits (Abschnitt 4): letzte 5 / letzte 10 / Saison, jeweils
          GP/G/A/P/P-GP/SOG/TOI - nur Zeilen mit ausreichend Spielen. */}
      {!goalie && (rollingForm5 || rollingForm10 || currentSeasonRecord) && (
        <div className="card mb">
          <div className="card-pad" style={{ paddingBottom: 6 }}><h2 style={{ margin: 0 }}>Form</h2></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th className="left">Zeitraum</th><th className="num">GP</th><th className="num">G</th><th className="num">A</th><th className="num">P</th><th className="num">P/GP</th><th className="num">SOG</th><th className="num">TOI/GP</th></tr>
              </thead>
              <tbody>
                <FormRow label="Letzte 5 Spiele" f={rollingForm5} fmtSec={fmtSec} fmt2={fmt2} />
                <FormRow label="Letzte 10 Spiele" f={rollingForm10} fmtSec={fmtSec} fmt2={fmt2} />
                {currentSeasonRecord && (
                  <FormRow
                    label={`Saison ${currentSeasonLabel || ''}`}
                    f={{
                      gp: currentSeasonRecord.gp, goals: currentSeasonRecord.goals, assists: currentSeasonRecord.assists,
                      points: currentSeasonRecord.points, ppg: seasonRates(currentSeasonRecord).ppg,
                      sog: currentSeasonRecord.sog, toipg: seasonRates(currentSeasonRecord).toipg,
                    }}
                    fmtSec={fmtSec} fmt2={fmt2}
                  />
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Player Analytics: Impact Score, Trend, Positionsvergleich */}
      {!goalie && (impact || trend || percentiles) && (
        <div className="card card-pad mb">
          <h2 className="mb">Player Analytics</h2>
          <div className="grid grid-2 mb" style={{ gap: 14 }}>
            <div className="card card-pad">
              <div className="section-label">Impact Score (Karriere)</div>
              {impact ? (
                <>
                  <div className="value mono" style={{ fontSize: 30 }}>{impact.score.toFixed(1)}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    Perzentil unter allen {posLabelHist === 'Stürmer' ? 'Stürmern' : 'Verteidigern'} (Karrierewerte, {impact.componentsUsed} Komponenten, {impact.careerGp} Karriere-Sp.)
                  </div>
                  {currentImpact && (
                    <div className="muted mt" style={{ fontSize: 11.5 }}>
                      {currentSeasonLabel}: <strong>{currentImpact.score.toFixed(1)}</strong>
                      {impactHistory.length >= 2 && (() => {
                        const prior = impactHistory[impactHistory.length - 2]
                        const delta = currentImpact.score - prior.impact.score
                        return <> · Vorjahr ({prior.season}): {prior.impact.score.toFixed(1)} (<strong className={delta >= 0 ? 'good' : 'bad'}>{delta >= 0 ? '+' : ''}{delta.toFixed(1)}</strong>)</>
                      })()}
                    </div>
                  )}
                </>
              ) : (
                <div className="muted" style={{ fontSize: 12.5 }}>Zu wenig Karriere-Spiele für einen aussagekräftigen Score.</div>
              )}
            </div>
            <div className="card card-pad">
              <div className="section-label">Trend</div>
              {trend ? (
                <>
                  <div style={{ fontSize: 18, fontWeight: 800 }} className={trend.label.includes('steigend') ? 'good' : trend.label === 'fallend' ? 'bad' : ''}>
                    {trend.label}
                  </div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {trend.latestSeason}: {fmt2(trend.latestPpg)} P/GP vs. Karriere davor: {fmt2(trend.careerPpgExclLatest)} P/GP
                  </div>
                </>
              ) : (
                <div className="muted" style={{ fontSize: 12.5 }}>Mindestens 3 gespielte Saisons nötig.</div>
              )}
            </div>
          </div>

          <div className="grid grid-3 mb" style={{ gap: 10 }}>
            <div className="tile"><div className="label">Karriere P/GP</div><div className="value mono" style={{ fontSize: 18 }}>{fmt2(career?.careerPpg)}</div></div>
            <div className="tile"><div className="label">Letzte Saison P/GP</div><div className="value mono" style={{ fontSize: 18 }}>{fmt2(trend?.latestPpg ?? (latestSeason ? seasonRates(latestSeason).ppg : null))}</div></div>
            <div className="tile"><div className="label">3-Jahres P/GP</div><div className="value mono" style={{ fontSize: 18 }}>{fmt2(last3Ppg)}</div></div>
          </div>

          {percentiles && (
            <>
              <div className="section-label">Vergleich mit {posLabelHist === 'Stürmer' ? 'Stürmern' : 'Verteidigern'} ({latestSeason.season})</div>
              <PercentileRow label="P/GP" value={seasonRates(latestSeason).ppg} pct={percentiles.ppg} baselines={baselines} position={posLabelHist} statKey="ppg" fmt={fmt2} />
              <PercentileRow label="Tore/Spiel" value={seasonRates(latestSeason).gpg} pct={percentiles.gpg} baselines={baselines} position={posLabelHist} statKey="gpg" fmt={fmt2} />
              <PercentileRow label="Assists/Spiel" value={seasonRates(latestSeason).apg} pct={percentiles.apg} baselines={baselines} position={posLabelHist} statKey="apg" fmt={fmt2} />
              <PercentileRow label="TOI/Spiel" value={seasonRates(latestSeason).toipg} pct={percentiles.toipg} baselines={baselines} position={posLabelHist} statKey="toipg" fmt={fmtSec} />
              {percentiles.sogpg != null && <PercentileRow label="SOG/Spiel" value={seasonRates(latestSeason).sogpg} pct={percentiles.sogpg} baselines={baselines} position={posLabelHist} statKey="sogpg" fmt={fmt2} />}
            </>
          )}
        </div>
      )}

      {/* Saisonverlauf-Chart (inkl. laufender Saison, sofern schon Spiele
          vorhanden - mergeSeasonSplits() in seasonRates/computeImpactScoreHistory
          verhindert einen künstlichen Sprung bei unterjährigem Vereinswechsel) */}
      {combinedSeasons.length >= 2 && (
        <div className="card card-pad mb">
          <h2 className="mb">Saisonverlauf</h2>
          {goalie ? <GoalieChart seasons={historySeasons} /> : <SkaterChart seasons={combinedSeasons} />}
        </div>
      )}

      {/* Impact-Score-Verlauf über die Saisons */}
      {!goalie && impactHistory.length >= 2 && (
        <div className="card card-pad mb">
          <h2 className="mb">Impact Score – Verlauf</h2>
          <ImpactChart rows={impactHistory} />
        </div>
      )}

      {/* Karriere-Zusammenfassung */}
      {career && (
        <div className="card card-pad mb">
          <h2 className="mb">Karriere-Zusammenfassung</h2>
          <div className="tiles" style={{ gridTemplateColumns: goalie ? 'repeat(4, 1fr)' : 'repeat(4, 1fr)' }}>
            {goalie ? (
              <>
                <Tile label="NL-Spiele" value={career.gp} />
                <Tile label="Saisons" value={career.seasonCount} />
                <Tile label="Teams" value={career.teamCount} />
                <Tile label="Ø Saisons/Team" value={fmt2(career.seasonCount / career.teamCount)} />
              </>
            ) : (
              <>
                <Tile label="NL-Spiele" value={career.gp} />
                <Tile label="NL-Tore" value={career.goals} />
                <Tile label="NL-Assists" value={career.assists} />
                <Tile label="NL-Punkte" value={career.points} />
                <Tile label="Karriere P/GP" value={fmt2(career.careerPpg)} />
                <Tile label="Saisons" value={career.seasonCount} />
                <Tile label="Teams" value={career.teamCount} />
                {career.bestByPoints && <Tile label={`Beste Saison (${career.bestByPoints.season})`} value={`${career.bestByPoints.points} Pkt`} />}
              </>
            )}
          </div>
          <div className="muted mt" style={{ fontSize: 11 }}>
            Basierend auf historischen NL-Archivdaten ({playerHistoryData?.seasonsIncluded?.[0]}–{playerHistoryData?.seasonsIncluded?.at(-1)}). Saison-Totale können Playoff-Spiele enthalten – reguläre Saison und Playoffs sind in den Archivdaten nicht zuverlässig unterscheidbar, daher keine separate Playoff-Historie.
          </div>
        </div>
      )}

      {/* Teams über die Jahre */}
      {teamsByHistory.length > 0 && (
        <div className="card card-pad mb">
          <h2 className="mb">Teams</h2>
          <div className="grid grid-2" style={{ gap: 6 }}>
            {teamsByHistory.map((t, i) => (
              <div key={i} className="row spread" style={{ padding: '5px 0', borderBottom: i < teamsByHistory.length - 1 ? '1px solid var(--border)' : 'none' }}>
                <span className="muted" style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{t.season}</span>
                <TeamBadge team={t.team} short />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Historische Saison-für-Saison-Tabelle */}
      {historySeasons.length > 0 && (
        <div className="card mb">
          <div className="card-pad" style={{ paddingBottom: 6 }}><h2 style={{ margin: 0 }}>Saison-Historie</h2></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left sortable" onClick={() => sortHist('season')}>Saison{sortInd('season')}</th>
                  <th className="left sortable" onClick={() => sortHist('team')}>Team{sortInd('team')}</th>
                  <th className="num sortable" onClick={() => sortHist('gp')}>GP{sortInd('gp')}</th>
                  {goalie ? (
                    <>
                      <th className="num sortable" onClick={() => sortHist('svpct')}>SV%{sortInd('svpct')}</th>
                      <th className="num sortable" onClick={() => sortHist('gaa')}>GTS{sortInd('gaa')}</th>
                      <th className="num sortable" onClick={() => sortHist('saves')}>Paraden{sortInd('saves')}</th>
                    </>
                  ) : (
                    <>
                      <th className="num sortable" onClick={() => sortHist('goals')}>T{sortInd('goals')}</th>
                      <th className="num sortable" onClick={() => sortHist('assists')}>A{sortInd('assists')}</th>
                      <th className="num sortable" onClick={() => sortHist('points')}>P{sortInd('points')}</th>
                      <th className="num sortable" onClick={() => sortHist('ppg')}>P/GP{sortInd('ppg')}</th>
                      <th className="num sortable" onClick={() => sortHist('sog')}>SOG{sortInd('sog')}</th>
                      <th className="num sortable" onClick={() => sortHist('toipg')}>TOI/GP{sortInd('toipg')}</th>
                      <th className="num sortable" onClick={() => sortHist('plusMinus')}>+/–{sortInd('plusMinus')}</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody>
                {sortedHistory.map((s) => {
                  const t = data.teams.find((x) => x.id === s.teamId)
                  const r = seasonRates(s)
                  const svp = s.shotsAgainst > 0 ? s.saves / s.shotsAgainst : null
                  const gaa = s.gp > 0 ? s.goalsAgainst / s.gp : null
                  return (
                    <tr key={s.season + s.teamId}>
                      <td className="left" style={{ fontFamily: 'var(--mono)' }}>{s.season}</td>
                      <td className="left">{t ? <TeamBadge team={t} short /> : <span className="muted">–</span>}</td>
                      <td className="num">{s.gp}</td>
                      {goalie ? (
                        <>
                          <td className="num">{fmtPct(svp)}</td>
                          <td className="num">{fmtNum(gaa)}</td>
                          <td className="num">{s.saves}</td>
                        </>
                      ) : (
                        <>
                          <td className="num">{s.goals}</td>
                          <td className="num">{s.assists}</td>
                          <td className="num"><strong>{s.points}</strong></td>
                          <td className="num">{fmt2(r.ppg)}</td>
                          <td className="num">{s.sog}</td>
                          <td className="num">{fmtSec(r.toipg)}</td>
                          <td className="num">{plusMinusStr(s.plusMinus)}</td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Formkurve über die laufende Saison (Abschnitt 2) - wählbare
          Kennzahl, X-Achse = Spielnummer (chronologisch), plus gleitender
          5er-/10er-Schnitt. Nur Feldspieler (Torhüter-Kennzahlen sind andere
          Grössen - SV%/GTS -, kein Punkte-Analog). */}
      {!goalie && logAsc.length >= 3 && <GameFormChart log={logAsc} />}

      {/* Game-by-Game Impact (Abschnitt 3): bewusst NICHT implementiert.
          Der validierte Impact Score (siehe oben, Karriere/Saison) beruht auf
          Jahr-zu-Jahr-Stabilität (Spearman-Korrelation) als Validierungs-
          methode - das funktioniert auf Einzelspiel-Ebene nicht analog, da
          es dort kein "Jahr-zu-Jahr"-Äquivalent gibt (Spiel-zu-Spiel-
          Korrelation misst nur Serien-Persistenz, ein anderes, deutlich
          verrauschteres Signal). Jede Gewichtungs-Kombination aus G/A/SOG/
          TOI/+- auf Spiel-Ebene wäre im Kern eine geratene Formel (analog zur
          bekannten, aber nicht aus diesen Daten hergeleiteten NHL-"Game
          Score"-Formel) - daher konsequent weggelassen statt erfunden. Die
          rohen Box-Score-Werte je Spiel (Game Log unten) sind die ehrliche,
          nicht-erfundene Leistungskennzahl pro Spiel. */}

      {/* Heim/Auswärts-Split (Abschnitt 5) */}
      {!goalie && homeAwaySplit && (
        <div className="card card-pad mb">
          <h2 className="mb">Heim / Auswärts</h2>
          <div className="grid grid-2" style={{ gap: 14 }}>
            <HomeAwayCard label="Heim" split={homeAwaySplit.home} fmt2={fmt2} />
            <HomeAwayCard label="Auswärts" split={homeAwaySplit.away} fmt2={fmt2} />
          </div>
        </div>
      )}

      {/* Gegner-Auswertung (Abschnitt 6) */}
      {!goalie && opponentBreakdown.length > 0 && (
        <div className="card mb">
          <div className="card-pad" style={{ paddingBottom: 6 }}>
            <h2 style={{ margin: 0 }}>Gegen welche Teams produziert {player.name.split(' ')[0]} am meisten?</h2>
            <div className="sub">Ab 2 Spielen gegen denselben Gegner</div>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th className="left">Gegner</th><th className="num">GP</th><th className="num">P</th><th className="num">P/GP</th></tr></thead>
              <tbody>
                {opponentBreakdown.map((r) => (
                  <tr key={r.opp.id}>
                    <td className="left"><TeamBadge team={r.opp} short /></td>
                    <td className="num">{r.gp}</td>
                    <td className="num">{r.points}</td>
                    <td className="num"><strong>{fmt2(r.ppg)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Team-Stints innerhalb der laufenden Saison (Abschnitt 7) - nur bei
          mehr als einem sicher zugeordneten Team bzw. unsicheren Spielen
          angezeigt, siehe resolveGameTeam()/computeTeamStints() für die
          Datenmodell-Grenze bei unterjährigem Vereinswechsel. */}
      {!goalie && teamStints && (teamStints.hasMultipleTeams || teamStints.uncertainGames > 0) && (
        <div className="card card-pad mb">
          <h2 className="mb">Teams (laufende Saison)</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th className="left">Team</th><th className="num">GP</th><th className="num">T</th><th className="num">A</th><th className="num">P</th><th className="num">P/GP</th></tr></thead>
              <tbody>
                {teamStints.stints.map((st) => (
                  <tr key={st.teamId}>
                    <td className="left">{st.team ? <TeamBadge team={st.team} short /> : <span className="muted">{st.teamId}</span>}</td>
                    <td className="num">{st.gp}</td>
                    <td className="num">{st.goals}</td>
                    <td className="num">{st.assists}</td>
                    <td className="num"><strong>{st.points}</strong></td>
                    <td className="num">{fmt2(st.ppg)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {teamStints.uncertainGames > 0 && (
            <div className="muted mt" style={{ fontSize: 11 }}>
              {teamStints.uncertainGames} Spiel{teamStints.uncertainGames === 1 ? '' : 'e'} keinem Team sicher zuordenbar (Vereinswechsel seither - das aktuelle Datenmodell speichert keine Team-Zugehörigkeit je Spiel, daher hier nicht geraten statt falsch zugeordnet).
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-pad" style={{ paddingBottom: 6 }}>
          <div className="row spread wrap" style={{ gap: 10 }}>
            <h2 style={{ margin: 0 }}>Game Log ({currentSeasonLabel || data.settings?.seasonName || 'Aktuelle Saison'})</h2>
            {log.length > 0 && !goalie && (
              <div className="row gap-sm wrap">
                <select style={{ width: 'auto' }} value={logHaFilter} onChange={(e) => setLogHaFilter(e.target.value)}>
                  <option value="all">Heim &amp; Auswärts</option>
                  <option value="home">Nur Heim</option>
                  <option value="away">Nur Auswärts</option>
                </select>
                <select style={{ width: 'auto' }} value={logOppFilter} onChange={(e) => setLogOppFilter(e.target.value)}>
                  <option value="all">Alle Gegner</option>
                  {opponentOptions.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            )}
          </div>
        </div>
        {log.length === 0 ? (
          <div className="card-pad muted">
            {stat && stat.gp > 0
              ? 'Offizielle Saison-Totale (siehe oben) – keine Spiel-für-Spiel-Aufschlüsselung verfügbar.'
              : 'Noch keine Einsätze erfasst.'}
          </div>
        ) : filteredLog.length === 0 ? (
          <div className="card-pad muted">Keine Spiele für diesen Filter.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">Datum</th>
                  <th className="left">Gegner</th>
                  <th className="left">H/A</th>
                  <th className="num">Resultat</th>
                  {goalie ? (
                    <><th className="num">GT</th><th className="num">PAR</th><th className="num">SV%</th><th className="left">E</th></>
                  ) : (
                    <><th className="num">GP</th><th className="num">G</th><th className="num">A</th><th className="num">P</th><th className="num">SOG</th><th className="num">TOI</th><th className="num">±</th></>
                  )}
                </tr>
              </thead>
              <tbody>
                {filteredLog.map(({ game, s, opp, isHome }) => {
                  const res = `${game.homeGoals}:${game.awayGoals}`
                  const shots = (Number(s.saves) || 0) + (Number(s.goalsAgainst) || 0)
                  const svp = shots > 0 ? (Number(s.saves) || 0) / shots : null
                  return (
                    <tr key={game.id}>
                      <td className="left muted">{game.date}</td>
                      <td className="left">{opp ? <TeamBadge team={opp} short /> : <span className="muted">unklar</span>}</td>
                      <td className="left">{isHome == null ? <span className="muted">–</span> : isHome ? 'H' : 'A'}</td>
                      <td className="num">{res}</td>
                      {goalie ? (
                        <>
                          <td className="num">{s.goalsAgainst ?? 0}</td>
                          <td className="num">{s.saves ?? 0}</td>
                          <td className="num">{fmtPct(svp)}</td>
                          <td className="left">{s.decision === 'W' ? 'S' : s.decision === 'L' ? 'N' : '–'}{s.shutout ? ' · SO' : ''}</td>
                        </>
                      ) : (
                        <>
                          <td className="num">1</td>
                          <td className="num">{s.goals ?? 0}</td>
                          <td className="num">{s.assists ?? 0}</td>
                          <td className="num"><strong>{(Number(s.goals) || 0) + (Number(s.assists) || 0)}</strong></td>
                          <td className="num">{s.sog ?? <span className="muted">–</span>}</td>
                          <td className="num">{s.toiSec != null ? fmtSec(s.toiSec) : <span className="muted">–</span>}</td>
                          <td className="num">{plusMinusStr(Number(s.plusMinus) || 0)}</td>
                        </>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        {!goalie && log.some((r) => r.s.sog == null) && log.length > 0 && (
          <div className="muted card-pad" style={{ paddingTop: 0, fontSize: 11 }}>
            SOG/TOI „–": nur vom SIHF-Sync automatisch erfasst, nicht bei manuell nachgetragenen Spielen verfügbar.
          </div>
        )}
      </div>
    </>
  )
}

function Tile({ label, value }) {
  return <div className="tile"><div className="label">{label}</div><div className="value" style={{ fontSize: 22 }}>{value}</div></div>
}

// Eine Zeile der Form-Splits-Tabelle (letzte 5 / letzte 10 / Saison) - `f`
// ist null, solange nicht genug Spiele vorhanden sind ("computeRollingForm"
// liefert dann null statt einer Berechnung auf zu wenig Datenbasis).
function FormRow({ label, f, fmtSec, fmt2 }) {
  if (!f) return (
    <tr><td className="left">{label}</td><td className="num muted" colSpan={7} style={{ textAlign: 'left' }}>zu wenig Spiele</td></tr>
  )
  return (
    <tr>
      <td className="left"><strong>{label}</strong></td>
      <td className="num">{f.gp}</td>
      <td className="num">{f.goals}</td>
      <td className="num">{f.assists}</td>
      <td className="num"><strong>{f.points}</strong></td>
      <td className="num">{fmt2(f.ppg)}</td>
      <td className="num">{f.sog ?? <span className="muted">–</span>}</td>
      <td className="num">{f.toipg != null ? fmtSec(f.toipg) : <span className="muted">–</span>}</td>
    </tr>
  )
}

// Heim- bzw. Auswärts-Kachel für den Heim/Auswärts-Split (Abschnitt 5).
function HomeAwayCard({ label, split, fmt2 }) {
  if (!split) return (
    <div className="card card-pad"><div className="section-label">{label}</div><div className="muted" style={{ fontSize: 12.5 }}>Keine Spiele</div></div>
  )
  return (
    <div className="card card-pad">
      <div className="row spread mb">
        <div className="section-label" style={{ marginBottom: 0 }}>{label}</div>
        {split.smallSample && <span className="chip" style={{ fontSize: 10.5 }}>n={split.gp} – geringe Aussagekraft</span>}
      </div>
      <div className="grid grid-2" style={{ gap: 8, fontSize: 12.5 }}>
        <div><span className="muted">P/GP:</span> <strong>{fmt2(split.ppg)}</strong></div>
        <div><span className="muted">GP:</span> <strong>{split.gp}</strong></div>
        <div><span className="muted">G/GP:</span> {fmt2(split.gpg)}</div>
        <div><span className="muted">A/GP:</span> {fmt2(split.apg)}</div>
        {split.sogpg != null && <div><span className="muted">SOG/GP:</span> {fmt2(split.sogpg)}</div>}
      </div>
    </div>
  )
}

// Formkurve über die laufende Saison (Abschnitt 2): wählbare Kennzahl
// (Rohwert je Spiel), plus gleitender 5er-/10er-Schnitt. `log` ist
// chronologisch (älteste zuerst). Handgebautes SVG nach dem Muster von
// EloChart/SkaterChart - keine Chart-Bibliothek.
const FORM_METRICS = [
  { key: 'points', label: 'Punkte', get: (s) => (Number(s.goals) || 0) + (Number(s.assists) || 0) },
  { key: 'goals', label: 'Tore', get: (s) => Number(s.goals) || 0 },
  { key: 'assists', label: 'Assists', get: (s) => Number(s.assists) || 0 },
  { key: 'sog', label: 'SOG', get: (s) => (s.sog != null ? Number(s.sog) : null) },
  { key: 'toi', label: 'TOI', get: (s) => (s.toiSec != null ? Number(s.toiSec) / 60 : null) },
]
function rollingAvg(values, n) {
  return values.map((_, i) => {
    if (i < n - 1) return null
    const window = values.slice(i - n + 1, i + 1).filter((v) => v != null)
    if (window.length < n) return null
    return window.reduce((a, b) => a + b, 0) / window.length
  })
}
function GameFormChart({ log }) {
  const [metric, setMetric] = useState('points')
  const def = FORM_METRICS.find((m) => m.key === metric)
  const values = log.map(({ s }) => def.get(s))
  const avail = values.filter((v) => v != null)
  if (avail.length === 0) return null // z.B. SOG/TOI gewählt, aber keine Sync-Daten vorhanden

  const roll5 = rollingAvg(values, 5)
  const roll10 = rollingAvg(values, 10)

  const W = 700, H = 220, pad = { l: 34, r: 12, t: 12, b: 24 }
  const n = log.length
  const max = Math.max(1, ...avail, ...roll5.filter((v) => v != null), ...roll10.filter((v) => v != null))
  const x = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r))
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b)
  const dots = values.map((v, i) => (v == null ? null : { i, v })).filter(Boolean)
  const linePath = (series) => series.map((v, i) => (v == null ? null : `${i === 0 || series[i - 1] == null ? 'M' : 'L'}${x(i)},${y(v)}`)).filter(Boolean).join(' ')

  return (
    <div className="card card-pad mb">
      <div className="row spread mb wrap" style={{ gap: 10 }}>
        <h2 style={{ margin: 0 }}>Form über die Saison</h2>
        <div className="pill-tabs">
          {FORM_METRICS.map((m) => <button key={m.key} className={metric === m.key ? 'active' : ''} onClick={() => setMetric(m.key)}>{m.label}</button>)}
        </div>
      </div>
      <div style={{ overflowX: 'auto' }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 480 }}>
          <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--border)" />
          {dots.map((d) => <circle key={d.i} cx={x(d.i)} cy={y(d.v)} r="2.2" fill="var(--text-faint)" />)}
          <path d={linePath(roll10)} fill="none" stroke="var(--text-dim)" strokeWidth="2" />
          <path d={linePath(roll5)} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        </svg>
      </div>
      <div className="row wrap gap-sm mt" style={{ gap: 14, fontSize: 12 }}>
        <span className="row gap-sm"><span className="dot" style={{ background: 'var(--text-faint)' }} />{def.label} je Spiel</span>
        <span className="row gap-sm"><span className="dot" style={{ background: 'var(--accent)' }} />Ø letzte 5</span>
        <span className="row gap-sm"><span className="dot" style={{ background: 'var(--text-dim)' }} />Ø letzte 10</span>
      </div>
    </div>
  )
}

// Eine Kennzahl im Positionsvergleich: Spielerwert vs. Positionsdurchschnitt
// vs. Perzentil, mit kleiner Balken-Visualisierung (bar-track/bar-fill).
function PercentileRow({ label, value, pct, baselines, position, statKey, fmt }) {
  if (value == null || pct == null) return null
  const avg = baselines?.[position]?.[statKey]?.mean
  return (
    <div className="row" style={{ fontSize: 12.5, marginBottom: 8 }}>
      <span className="muted" style={{ minWidth: 90 }}>{label}</span>
      <div className="bar-track" style={{ flex: 1 }}>
        <div className="bar-fill" style={{ width: `${Math.min(Math.max(pct, 0), 100)}%` }} />
      </div>
      <span style={{ minWidth: 230, textAlign: 'right', fontFamily: 'var(--mono)' }}>
        <strong>{fmt(value)}</strong>
        <span className="muted"> · Ø {fmt(avg)} · Perzentil {pct.toFixed(0)}%</span>
      </span>
    </div>
  )
}

// Handgebautes SVG-Liniendiagramm (Muster: EloChart in EloRanking.jsx) -
// P/GP (Akzent), G/GP und A/GP (gedämpft) über die verfügbaren Saisons.
function SkaterChart({ seasons }) {
  const rows = seasons.map((s) => ({ season: s.season, ...seasonRates(s) }))
  const W = 700, H = 220, pad = { l: 38, r: 12, t: 12, b: 26 }
  const allVals = rows.flatMap((r) => [r.ppg, r.gpg, r.apg]).filter((v) => v != null)
  const max = Math.max(0.5, ...allVals)
  const x = (i) => pad.l + (rows.length <= 1 ? 0 : (i / (rows.length - 1)) * (W - pad.l - pad.r))
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b)
  const line = (key) => rows.map((r, i) => (r[key] == null ? null : `${i === 0 || rows[i - 1]?.[key] == null ? 'M' : 'L'}${x(i)},${y(r[key])}`)).filter(Boolean).join(' ')

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 480 }}>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--border)" />
        <path d={line('gpg')} fill="none" stroke="var(--text-faint)" strokeWidth="2" />
        <path d={line('apg')} fill="none" stroke="var(--text-dim)" strokeWidth="2" />
        <path d={line('ppg')} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {rows.map((r, i) => (
          <text key={r.season} x={x(i)} y={H - 6} fontSize="10.5" fill="var(--text-dim)" textAnchor="middle">{r.season.slice(2)}</text>
        ))}
      </svg>
      <div className="row wrap gap-sm mt" style={{ gap: 14, fontSize: 12 }}>
        <span className="row gap-sm"><span className="dot" style={{ background: 'var(--accent)' }} />Punkte/Spiel</span>
        <span className="row gap-sm"><span className="dot" style={{ background: 'var(--text-dim)' }} />Assists/Spiel</span>
        <span className="row gap-sm"><span className="dot" style={{ background: 'var(--text-faint)' }} />Tore/Spiel</span>
      </div>
    </div>
  )
}

// Torhüter-Variante: SV% über die Saisons.
function GoalieChart({ seasons }) {
  const rows = seasons.map((s) => ({ season: s.season, svPct: s.shotsAgainst > 0 ? s.saves / s.shotsAgainst : null }))
  const W = 700, H = 220, pad = { l: 40, r: 12, t: 12, b: 26 }
  const vals = rows.map((r) => r.svPct).filter((v) => v != null)
  if (vals.length === 0) return <div className="muted">Keine ausreichenden Torhüter-Daten für einen Verlauf.</div>
  const min = Math.min(...vals) - 0.02, max = Math.max(...vals) + 0.02
  const x = (i) => pad.l + (rows.length <= 1 ? 0 : (i / (rows.length - 1)) * (W - pad.l - pad.r))
  const y = (v) => pad.t + (1 - (v - min) / (max - min || 1)) * (H - pad.t - pad.b)
  const line = rows.map((r, i) => (r.svPct == null ? null : `${i === 0 || rows[i - 1]?.svPct == null ? 'M' : 'L'}${x(i)},${y(r.svPct)}`)).filter(Boolean).join(' ')

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 480 }}>
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {rows.map((r, i) => r.svPct != null && (
          <circle key={r.season} cx={x(i)} cy={y(r.svPct)} r="3" fill="var(--accent)" />
        ))}
        {rows.map((r, i) => (
          <text key={r.season} x={x(i)} y={H - 6} fontSize="10.5" fill="var(--text-dim)" textAnchor="middle">{r.season.slice(2)}</text>
        ))}
      </svg>
      <div className="muted mt" style={{ fontSize: 12 }}>Fangquote (SV%) pro Saison</div>
    </div>
  )
}

// Impact-Score-Verlauf (0-100) über die Saisons, inkl. laufender Saison
// sofern bereits genug Spiele (computeImpactScoreHistory in playerHistory.js
// überspringt Saisons ohne ausreichende Datenbasis - kein erfundener Punkt).
function ImpactChart({ rows }) {
  const W = 700, H = 220, pad = { l: 32, r: 12, t: 12, b: 26 }
  const x = (i) => pad.l + (rows.length <= 1 ? 0 : (i / (rows.length - 1)) * (W - pad.l - pad.r))
  const y = (v) => pad.t + (1 - v / 100) * (H - pad.t - pad.b)
  const line = rows.map((r, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(r.impact.score)}`).join(' ')

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 480 }}>
        <line x1={pad.l} x2={W - pad.r} y1={y(50)} y2={y(50)} stroke="var(--border)" strokeDasharray="4 4" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {rows.map((r, i) => <circle key={r.season} cx={x(i)} cy={y(r.impact.score)} r="3" fill="var(--accent)" />)}
        {rows.map((r, i) => (
          <text key={r.season} x={x(i)} y={H - 6} fontSize="10.5" fill="var(--text-dim)" textAnchor="middle">{r.season.slice(2)}</text>
        ))}
      </svg>
      <div className="muted mt" style={{ fontSize: 12 }}>Positions-relatives Perzentil (0-100) pro Saison · gestrichelt = Positionsdurchschnitt (50)</div>
    </div>
  )
}

// Marktwert-Verlauf über die Zeit (player.marketValueHistory, server/sync.js -
// ein Snapshot pro Kalendertag). Gleiches SVG-Muster wie GoalieChart/
// SkaterChart oben. Nur gerendert, wenn hasEnoughHistoryForChart() bereits
// grünes Licht gegeben hat (siehe Aufrufer) - hier kein erneuter Check nötig.
function MarketValueHistoryChart({ history }) {
  const W = 700, H = 200, pad = { l: 56, r: 12, t: 12, b: 26 }
  const vals = history.map((h) => h.marketValue)
  const min = Math.min(...vals), max = Math.max(...vals)
  const pad_ = Math.max((max - min) * 0.1, 5000)
  const yMin = Math.max(0, min - pad_), yMax = max + pad_
  const x = (i) => pad.l + (history.length <= 1 ? 0 : (i / (history.length - 1)) * (W - pad.l - pad.r))
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b)
  const line = history.map((h, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(h.marketValue)}`).join(' ')

  // Datumsbeschriftung: höchstens ~6 Ticks, sonst überlappt es bei langer Historie.
  const labelEvery = Math.max(1, Math.ceil(history.length / 6))

  return (
    <div style={{ overflowX: 'auto' }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ minWidth: 480 }}>
        <line x1={pad.l} x2={W - pad.r} y1={y(yMin)} y2={y(yMin)} stroke="var(--border)" />
        <text x={pad.l - 8} y={y(yMax) + 3} fontSize="9.5" fill="var(--text-dim)" textAnchor="end">{Math.round(yMax / 1000)}k</text>
        <text x={pad.l - 8} y={y(yMin) + 3} fontSize="9.5" fill="var(--text-dim)" textAnchor="end">{Math.round(yMin / 1000)}k</text>
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
        {history.map((h, i) => (
          <circle key={h.date} cx={x(i)} cy={y(h.marketValue)} r="2.5" fill="var(--accent)">
            <title>{`${h.date}: ${h.marketValue.toLocaleString('de-CH')} CHF`}</title>
          </circle>
        ))}
        {history.map((h, i) => (i % labelEvery === 0 || i === history.length - 1) && (
          <text key={'lbl' + h.date} x={x(i)} y={H - 6} fontSize="9" fill="var(--text-dim)" textAnchor="middle">{h.date.slice(5)}</text>
        ))}
      </svg>
      <div className="muted mt" style={{ fontSize: 12 }}>Marktwert (CHF) pro Kalendertag seit Beginn der Aufzeichnung</div>
    </div>
  )
}

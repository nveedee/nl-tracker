import { Fragment, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useData } from '../DataContext.jsx'
import { TeamBadge, Empty, SectionHeader } from '../components/ui.jsx'
import { homeWinProbability } from '../elo.js'
import { applyRestAdjustment, computeRestAdjustment, DEFAULT_BACK_TO_BACK_PENALTY } from '../restDays.js'
import { isFinalGame } from '../stats.js'
import { getPregamePrediction } from '../pregamePrediction.js'
import { useLiveGamesList } from '../liveGameClient.js'
import LiveNowSection from '../components/LiveNowSection.jsx'

const NEXT_GAMES_LIMIT = 8 // "Nächste Spiele": kompakte Vorschau, nicht die komplette Saison
const ALL_GAMES_PAGE_SIZE = 20 // "Alle Spiele": initiale/inkrementelle Ladegrösse statt aller Spiele auf einmal

const ALL_GAMES_FILTERS = [
  { key: 'all', label: 'Alle' },
  { key: 'past', label: 'Vergangen' },
  { key: 'upcoming', label: 'Kommend' },
]

function monthLabel(dateStr) {
  return new Date(dateStr).toLocaleDateString('de-CH', { month: 'long', year: 'numeric' })
}

// Zentrale Spiele-Seite (/schedule) - vereint kommende Spiele (mit Prognose)
// und abgeschlossene Spiele/Ergebnisse (vormals die separate Seite /games,
// siehe App.jsx-Redirect). Struktur (UX-Überarbeitung: 357 offene Spiele
// direkt untereinander waren für die normale Nutzung zu lang):
//   1. Live jetzt (LiveNowSection, nur wenn >=1 Spiel live)
//   2. Nächste Spiele (kompakt, NEXT_GAMES_LIMIT Stück, mit Prognose)
//   3. Alle Spiele (initial eingeklappt -> Filter Alle/Vergangen/Kommend,
//      seitenweise geladen statt alle 364 Zeilen auf einmal)
// Keine neue Berechnung, keine neue Prognoselogik - nur Darstellung/Paging.
export default function Schedule() {
  const { data, derived } = useData()
  const navigate = useNavigate()
  const homeAdv = data.settings.eloHomeAdvantage
  const ratings = derived.elo.ratings
  const start = data.settings.eloStart
  const restDaysEnabled = data.settings?.restDaysEnabled !== false
  const backToBackPenalty = data.settings?.backToBackPenalty ?? DEFAULT_BACK_TO_BACK_PENALTY
  const teamMap = Object.fromEntries(data.teams.map((t) => [t.id, t]))

  const upcoming = useMemo(
    () => data.games
      .filter((g) => g.status === 'scheduled')
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || '').localeCompare(b.time || ''))),
    [data.games]
  )

  const played = useMemo(
    () => data.games.filter(isFinalGame),
    [data.games]
  )

  // "Alle Spiele" - EIN zentraler Live-Poll (dieselbe Quelle wie
  // LiveNowSection/Dashboard, src/liveGameClient.js::useLiveGamesList(),
  // kein zweiter eigener Live-Mechanismus) nur für den 🔴-LIVE-Statuschip
  // pro Zeile - Filterung selbst bleibt bewusst bei Alle/Vergangen/Kommend
  // (ein live laufendes Spiel ist noch nicht abgeschlossen, zählt also zu
  // "Kommend", wird aber sichtbar als LIVE statt "Geplant" markiert).
  const liveStates = useLiveGamesList()
  const liveGameIds = useMemo(() => new Set(liveStates.map((s) => s.gameId)), [liveStates])

  const [allExpanded, setAllExpanded] = useState(false)
  const [allFilter, setAllFilter] = useState('all')
  const [visibleCount, setVisibleCount] = useState(ALL_GAMES_PAGE_SIZE)

  const allGamesSorted = useMemo(
    () => [...data.games].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.time || '').localeCompare(b.time || ''))),
    [data.games]
  )
  const allGamesByFilter = useMemo(() => ({
    all: allGamesSorted,
    past: allGamesSorted.filter(isFinalGame),
    upcoming: allGamesSorted.filter((g) => !isFinalGame(g)),
  }), [allGamesSorted])
  const allGamesFiltered = allGamesByFilter[allFilter]
  const allGamesVisible = allGamesFiltered.slice(0, visibleCount)

  function selectFilter(key) {
    setAllFilter(key)
    setVisibleCount(ALL_GAMES_PAGE_SIZE)
  }

  // Pre-Game-Prognose über die zentrale Single Source of Truth
  // (src/pregamePrediction.js) - Snapshot bevorzugt, sonst der geschlossene
  // ELO-Live-Fallback (z.B. für ein Spiel, das erst nach dem letzten
  // Sync-Lauf hinzugefügt wurde). Dieselbe Priorisierung wie auf Dashboard,
  // Season Projections, TeamDetail und MatchupDetail - kein Ort im
  // Frontend berechnet mehr eine eigene, potenziell abweichende Prognose.

  let lastMonth = null

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Spielplan</h1>
          <div className="sub">{upcoming.length} kommende Spiele · {played.length} gespielt</div>
        </div>
      </div>

      <LiveNowSection />

      <SectionHeader
        title="Nächste Spiele"
        caption="Prognose aus dem gespeicherten Pre-Game-Snapshot (Fallback: aktuelle ELO-Werte)."
      />
      {upcoming.length === 0 ? (
        <Empty
          title="Keine offenen Spiele im Spielplan"
          hint="Alle erfassten Spiele haben bereits ein Resultat."
        />
      ) : (
        <div className="card mb">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th className="left">Datum</th>
                  <th className="left">Heim</th>
                  <th className="left">Prognose</th>
                  <th className="left">Auswärts</th>
                  <th className="num"></th>
                </tr>
              </thead>
              <tbody>
                {upcoming.slice(0, NEXT_GAMES_LIMIT).map((g) => {
                  const h = data.teams.find((t) => t.id === g.homeTeamId)
                  const a = data.teams.find((t) => t.id === g.awayTeamId)
                  // NUR für den B2B-Hinweis-Chip - unabhängig davon, ob die
                  // Prognose aus dem Snapshot oder live berechnet wird. Reine
                  // Anzeige-Information (wer ist ausgeruht), fliesst NICHT
                  // nochmal in die Prognose ein, wenn ein Snapshot verwendet
                  // wird - dessen Wert hat die B2B-Anpassung bereits
                  // eingerechnet (siehe server/scripts/predictions.js), eine
                  // erneute Anwendung hier wäre eine doppelte Anpassung.
                  const restAdjustmentForDisplay = restDaysEnabled ? computeRestAdjustment(g, data.games, backToBackPenalty) : 0
                  // Live-Fallback-Kandidat (nur verwendet, wenn kein Snapshot
                  // existiert) - identische Formel wie zuvor, jetzt hinter
                  // getPregamePrediction() konsolidiert.
                  const rh = ratings[g.homeTeamId] ?? start
                  const ra = ratings[g.awayTeamId] ?? start
                  const rawPHome = homeWinProbability(rh, ra, homeAdv)
                  const livePHome = restAdjustmentForDisplay !== 0 ? applyRestAdjustment(rawPHome, g, data.games, backToBackPenalty) : rawPHome
                  const prediction = getPregamePrediction(g.id, data.predictions, { gameId: g.id, pHomeWin: livePHome, pAwayWin: 1 - livePHome })
                  const pctHome = Math.round(prediction.pHomeWin * 100)
                  const pctAway = 100 - pctHome
                  return (
                    <tr key={g.id} onClick={() => navigate(`/matchup/${g.id}`)} style={{ cursor: 'pointer' }}>
                      <td className="left muted">{g.date}{g.time ? ` · ${g.time}` : ''}</td>
                      <td className="left" onClick={(e) => e.stopPropagation()}><TeamBadge team={h} /></td>
                      <td className="left">
                        <span className="row gap-sm" style={{ fontFamily: 'var(--mono)' }}>
                          <strong style={{ color: pctHome >= pctAway ? 'var(--good)' : 'var(--text-dim)' }}>{h?.short} {pctHome}%</strong>
                          <span className="muted">–</span>
                          <strong style={{ color: pctAway > pctHome ? 'var(--good)' : 'var(--text-dim)' }}>{pctAway}% {a?.short}</strong>
                          {restAdjustmentForDisplay !== 0 && (
                            <span className="muted" style={{ fontSize: 10.5 }} title={`Back-to-back-Anpassung berücksichtigt (${restAdjustmentForDisplay > 0 ? h?.short : a?.short} ausgeruht)`}>B2B</span>
                          )}
                        </span>
                      </td>
                      <td className="left" onClick={(e) => e.stopPropagation()}><TeamBadge team={a} /></td>
                      <td className="num"><Link className="btn ghost sm" to={`/matchup/${g.id}`} onClick={(e) => e.stopPropagation()}>Matchup</Link></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {upcoming.length > NEXT_GAMES_LIMIT && (
            <button
              className="expander-trigger"
              onClick={() => { setAllExpanded(true); setAllFilter('upcoming'); setVisibleCount(ALL_GAMES_PAGE_SIZE) }}
            >
              Alle {data.games.length} Spiele anzeigen →
            </button>
          )}
        </div>
      )}

      <SectionHeader
        title="Alle Spiele"
        caption={allExpanded ? `Alle ${allGamesByFilter.all.length} · Vergangen ${allGamesByFilter.past.length} · Kommend ${allGamesByFilter.upcoming.length}` : `${data.games.length} Spiele total · ${played.length} abgeschlossen.`}
      />
      {!allExpanded ? (
        <button className="btn ghost" onClick={() => setAllExpanded(true)}>
          Alle Spiele anzeigen ({data.games.length}) →
        </button>
      ) : (
        <>
          <div className="filter-tabs">
            {ALL_GAMES_FILTERS.map((f) => (
              <button
                key={f.key}
                className={allFilter === f.key ? 'active' : ''}
                onClick={() => selectFilter(f.key)}
              >
                {f.label} ({allGamesByFilter[f.key].length})
              </button>
            ))}
          </div>
          {allGamesFiltered.length === 0 ? (
            <Empty title="Keine Spiele in dieser Ansicht" hint="Anderen Filter oben wählen." />
          ) : (
            <div className="card">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="left">Datum</th>
                      <th className="left">Heim</th>
                      <th className="num">Status</th>
                      <th className="left">Auswärts</th>
                      <th className="left">Modus</th>
                      <th className="num"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {allGamesVisible.map((g) => {
                      const h = teamMap[g.homeTeamId], a = teamMap[g.awayTeamId]
                      const isPlayed = isFinalGame(g)
                      const isLive = !isPlayed && liveGameIds.has(g.id)
                      const homeWon = isPlayed && g.homeGoals > g.awayGoals
                      // Monats-Gruppierung: nur eine dezente Trennzeile, sobald
                      // sich der Monat gegenüber der vorherigen Zeile ändert -
                      // hilft bei der Übersicht über eine ganze Saison, ohne
                      // eine zweite Datenstruktur/Verschachtelung einzuführen.
                      const month = monthLabel(g.date)
                      const showMonthHeader = month !== lastMonth
                      lastMonth = month
                      return (
                        <Fragment key={g.id}>
                          {showMonthHeader && (
                            <tr key={`m-${g.id}`} className="month-row">
                              <td colSpan={6}>{month}</td>
                            </tr>
                          )}
                          <tr key={g.id} onClick={() => navigate(`/matchup/${g.id}`)} style={{ cursor: 'pointer' }}>
                            <td className="left muted">{g.date}{g.time ? ` · ${g.time}` : ''}</td>
                            <td className="left" style={{ fontWeight: homeWon ? 700 : 400 }} onClick={(e) => e.stopPropagation()}><TeamBadge team={h} /></td>
                            <td className="num">
                              {isPlayed ? (
                                <strong>{g.homeGoals} : {g.awayGoals}</strong>
                              ) : isLive ? (
                                <span className="live-badge" style={{ fontSize: 10.5 }}><span className="live-dot" />LIVE</span>
                              ) : (
                                <span className="chip">Geplant</span>
                              )}
                            </td>
                            <td className="left" style={{ fontWeight: isPlayed && !homeWon ? 700 : 400 }} onClick={(e) => e.stopPropagation()}><TeamBadge team={a} /></td>
                            <td className="left">
                              {isPlayed
                                ? (g.decision === 'REG' ? <span className="muted">–</span> : <span className="chip">{g.decision === 'OT' ? 'Overtime' : 'Penalty'}</span>)
                                : <span className="muted">–</span>}
                            </td>
                            <td className="num"><Link className="btn ghost sm" to={`/matchup/${g.id}`} onClick={(e) => e.stopPropagation()}>Matchup</Link></td>
                          </tr>
                        </Fragment>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {visibleCount < allGamesFiltered.length && (
                <button className="expander-trigger" onClick={() => setVisibleCount((c) => c + ALL_GAMES_PAGE_SIZE)}>
                  Weitere {Math.min(ALL_GAMES_PAGE_SIZE, allGamesFiltered.length - visibleCount)} laden ({allGamesVisible.length}/{allGamesFiltered.length})
                </button>
              )}
            </div>
          )}
        </>
      )}
    </>
  )
}

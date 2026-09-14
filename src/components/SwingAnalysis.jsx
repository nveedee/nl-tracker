import { useState, useMemo } from 'react'
import { TeamBadge, SectionHeader, ProbBar, useScrollFade } from './ui.jsx'
import { computeSwingAnalysisForMatchday, SWING_CATEGORIES, SWING_RUNS } from '../playoffSim.js'

function fmtPct(v) { return (v * 100).toFixed(1) + '%' }
function fmtPp(v) { return (v * 100).toFixed(1) + 'pp' }
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('de-CH', { weekday: 'short', day: '2-digit', month: '2-digit' })
}

// "Was steht auf dem Spiel?": für jedes Spiel eines gewählten Spieltags Max-/
// Expected-Swing je Team/Kategorie (src/playoffSim.js::computeSwingAnalysisForMatchday),
// Spiele nach Einfluss geordnet, Klick öffnet die Team/Kategorie-Aufschlüsselung.
export default function SwingAnalysis({ teams, games, settings, players, initialRatings, baseResults, forecasts }) {
  const matchdays = useMemo(() => {
    const map = new Map()
    for (const f of forecasts) {
      if (!map.has(f.date)) map.set(f.date, [])
      map.get(f.date).push(f.gameId)
    }
    return [...map.entries()].map(([date, gameIds]) => ({ date, gameIds }))
  }, [forecasts])

  const [selectedDate, setSelectedDate] = useState(matchdays[0]?.date)
  const [category, setCategory] = useState('all')
  const [swing, setSwing] = useState(null)
  const [loading, setLoading] = useState(false)
  const [expandedGameId, setExpandedGameId] = useState(null)

  const handleAnalyze = () => {
    const md = matchdays.find((m) => m.date === selectedDate)
    if (!md) return
    setLoading(true)
    setExpandedGameId(null)
    setTimeout(() => {
      try {
        const result = computeSwingAnalysisForMatchday(teams, games, settings, md.gameIds, {
          runs: SWING_RUNS, seed: baseResults.seed, players, initialRatings, baseResults, forecasts,
        })
        setSwing(result)
      } catch (err) {
        console.error('Swing-Analyse error:', err)
      } finally {
        setLoading(false)
      }
    }, 0)
  }

  // Ranking-Metrik bei aktivem Kategorie-Filter: grösster Expected Swing NUR
  // dieser Kategorie (statt des vom Engine gelieferten Maximums über alle
  // Kategorien) - rein clientseitig aus den bereits berechneten Daten, kein
  // erneuter Simulationslauf nötig.
  const rankedGames = useMemo(() => {
    if (!swing) return []
    if (category === 'all') return swing
    return [...swing].sort((a, b) => {
      const maxA = Math.max(...a.teams.map((t) => t.categories[category].expectedSwing))
      const maxB = Math.max(...b.teams.map((t) => t.categories[category].expectedSwing))
      return maxB - maxA
    })
  }, [swing, category])

  const expandedGame = rankedGames.find((g) => g.gameId === expandedGameId)
  const categoriesToShow = category === 'all' ? SWING_CATEGORIES : SWING_CATEGORIES.filter((c) => c.key === category)
  const breakdownWrapRef = useScrollFade()

  if (!matchdays.length) return null

  const expandedTeams = expandedGame
    ? [...expandedGame.teams]
      .filter((t) => categoriesToShow.some((c) => t.categories[c.key].maxSwing > 0.005))
      .sort((a, b) => {
        const maxA = Math.max(...categoriesToShow.map((c) => a.categories[c.key].expectedSwing))
        const maxB = Math.max(...categoriesToShow.map((c) => b.categories[c.key].expectedSwing))
        return maxB - maxA
      })
    : []

  return (
    <div className="card mb">
      <div className="card-pad" style={{ paddingBottom: 10 }}>
        <SectionHeader title="Swing-Analyse" caption="Welches Spiel eines Spieltags beeinflusst die Endtabelle am meisten?" />
        <div className="row gap-sm wrap" style={{ marginTop: 10 }}>
          <select
            value={selectedDate}
            onChange={(e) => { setSelectedDate(e.target.value); setSwing(null); setExpandedGameId(null) }}
            style={{ width: 'auto', minHeight: 40 }}
          >
            {matchdays.map((m) => (
              <option key={m.date} value={m.date}>{fmtDate(m.date)} ({m.gameIds.length} Spiele)</option>
            ))}
          </select>
          <button className="btn primary sm" onClick={handleAnalyze} disabled={loading} style={{ minHeight: 40, flex: 1 }}>
            {loading ? 'Analysiert…' : 'Spieltag analysieren'}
          </button>
        </div>
      </div>

      {swing && (
        <div className="card-pad" style={{ paddingTop: 0 }}>
          <div className="pill-tabs mb">
            <button className={category === 'all' ? 'active' : ''} onClick={() => setCategory('all')}>Alle</button>
            {SWING_CATEGORIES.map((c) => (
              <button key={c.key} className={category === c.key ? 'active' : ''} onClick={() => setCategory(c.key)}>{c.label}</button>
            ))}
          </div>

          <div className="match-list mb" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
            {rankedGames.map((g) => (
              <button key={g.gameId} className="match-item" onClick={() => setExpandedGameId(expandedGameId === g.gameId ? null : g.gameId)}>
                <div className="match-meta">
                  <span>Heimsieg {fmtPct(g.pHomeWin)}</span>
                  <span>{expandedGameId === g.gameId ? '▲ weniger' : '▼ Details'}</span>
                </div>
                <div className="row spread" style={{ marginBottom: 6 }}>
                  <span className="row gap-sm"><TeamBadge team={g.homeTeam} short /> <span className="muted">–</span> <TeamBadge team={g.awayTeam} short /></span>
                </div>
                <div className="row gap-sm">
                  <span className="muted" style={{ fontSize: 11, flex: 'none' }}>Einfluss</span>
                  <div style={{ flex: 1 }}><ProbBar value={g.influence} digits={1} /></div>
                </div>
              </button>
            ))}
          </div>

          {expandedGame && (
            <div className="table-wrap pin-first" ref={breakdownWrapRef}>
              <table>
                <thead>
                  <tr>
                    <th className="left">Team</th>
                    {categoriesToShow.map((c) => <th key={c.key} className="num">{c.label} (Max / Erw.)</th>)}
                  </tr>
                </thead>
                <tbody>
                  {expandedTeams.map((t) => (
                    <tr key={t.team.id}>
                      <td className="left"><TeamBadge team={t.team} short /></td>
                      {categoriesToShow.map((c) => (
                        <td key={c.key} className="num">
                          {fmtPp(t.categories[c.key].maxSwing)} / <span className="muted">{fmtPp(t.categories[c.key].expectedSwing)}</span>
                        </td>
                      ))}
                    </tr>
                  ))}
                  {expandedTeams.length === 0 && (
                    <tr><td colSpan={categoriesToShow.length + 1} className="muted" style={{ textAlign: 'center' }}>Keine nennenswerte Auswirkung für die gewählte Kategorie</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

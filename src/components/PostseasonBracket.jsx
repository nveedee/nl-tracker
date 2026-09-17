import { SectionHeader, TeamBadge } from './ui.jsx'

function fmtPct(v) {
  if (v == null) return '–'
  const pct = v * 100
  if (pct > 0 && pct < 1) return pct.toFixed(1) + '%'
  return Math.round(pct) + '%'
}

function BracketRow({ label, teamA, teamB, probability, teamById }) {
  return (
    <div className="row spread postseason-bracket-row">
      <div className="row gap-sm" style={{ flex: 1 }}>
        <TeamBadge team={teamById.get(teamA)} short />
        <span className="muted" style={{ fontSize: 11 }}>vs</span>
        <TeamBadge team={teamById.get(teamB)} short />
      </div>
      <span className="muted" style={{ fontSize: 11.5, flex: 'none' }}>{label}: {fmtPct(probability)}</span>
    </div>
  )
}

// "Most Likely Bracket" (Punkt 14 im Auftrag): zeigt für die nach Ø-Rang
// wahrscheinlichste Setzliste (1-8) je Team dessen laut Aggregation
// (src/postseasonPaths.js) häufigsten Gegner der jeweiligen Runde - bewusst
// als "wahrscheinlichste Setzliste + häufigste Gegner" gekennzeichnet statt
// als garantierter Bracket, da sich Setzliste/Rang zwischen Läufen ändert.
export default function PostseasonBracket({ sim, aggregate, teamById }) {
  if (!sim || !aggregate) return null

  const bySeed = [...sim.rows].sort((a, b) => a.avgRank - b.avgRank)
  const top8 = bySeed.slice(0, 8).map((r) => r.team.id)
  const playInSeeds = bySeed.slice(6, 10).map((r) => r.team.id)

  const withTopOpponent = (teamId, stage) => {
    const tp = aggregate.teamPaths[teamId]
    if (!tp) return null
    const top = tp[stage]?.opponents?.[0]
    return top ? { opponentId: top.opponentId, probability: top.conditionalProbability } : null
  }

  return (
    <>
      <SectionHeader title="Most Likely Bracket" caption="Basierend auf der wahrscheinlichsten Setzliste (Ø Rang über alle Läufe) und den je Team häufigsten Gegnern pro Runde - keine feste Garantie, da sich das Seeding zwischen den Läufen verschiebt." />
      <div className="card card-pad mb">
        <div className="section-label">Play-in (Rang 7-10, wahrscheinlichste Setzliste)</div>
        <div className="postseason-bracket-group">
          {playInSeeds.length === 4 && (
            <>
              <BracketRow label="häufigster Sieger" teamA={playInSeeds[0]} teamB={playInSeeds[1]} probability={aggregate.teamPaths[playInSeeds[0]]?.playIn.firstGameWinProbability} teamById={teamById} />
              <BracketRow label="häufigster Sieger" teamA={playInSeeds[2]} teamB={playInSeeds[3]} probability={aggregate.teamPaths[playInSeeds[2]]?.playIn.firstGameWinProbability} teamById={teamById} />
            </>
          )}
        </div>

        <div className="section-label" style={{ marginTop: 16 }}>Viertelfinal (häufigste Gegner der Top-8-Setzliste)</div>
        <div className="postseason-bracket-group">
          {top8.map((id) => {
            const opp = withTopOpponent(id, 'quarterfinal')
            if (!opp) return null
            return <BracketRow key={id} label="häufigster Gegner" teamA={id} teamB={opp.opponentId} probability={opp.probability} teamById={teamById} />
          })}
        </div>

        <div className="section-label" style={{ marginTop: 16 }}>Halbfinal &amp; Final (häufigste Gegner, aggregiert)</div>
        <div className="postseason-bracket-group">
          {aggregate.globalMatchups.semifinal.slice(0, 4).map((m) => (
            <BracketRow key={m.key} label="Halbfinal" teamA={m.teamAId} teamB={m.teamBId} probability={m.probability} teamById={teamById} />
          ))}
          {aggregate.globalMatchups.final.slice(0, 3).map((m) => (
            <BracketRow key={m.key} label="Final" teamA={m.teamAId} teamB={m.teamBId} probability={m.probability} teamById={teamById} />
          ))}
        </div>
      </div>
    </>
  )
}

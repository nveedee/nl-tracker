// ---------------------------------------------------------------------------
// Fantasy-Punkte, angenähert an das offizielle NL-Topscorers-Punktesystem.
// Rein additiv: liest nur bereits vorhandene Saison-Stats (dieselbe
// konsolidierte Quelle wie überall sonst - src/stats.js::computePlayerStats,
// bevorzugt player.apiStats/NL-API, sonst Boxscore-Summe, siehe dort). Rührt
// ELO/Prognose/predictions.js/DataContext.jsx nicht an - Aufrufer übergibt
// die bereits berechneten derived.playerStats-Zeilen.
//
// EHRLICHKEIT: nur Kategorien, für die wir tatsächlich Daten haben, fliessen
// ein (siehe FANTASY_CATEGORIES_CONSIDERED/_OMITTED unten). Das Ergebnis ist
// deshalb explizit ein "angenäherter" Topscorers-Score, keine exakte
// Nachbildung - Kategorien wie Game-Winning-Goal, Hattrick-Bonus, PP/SH-
// Aufschlüsselung, Bully, geblockte Schüsse oder ein Eiszeit-Bonus werden
// NICHT erfunden, sondern klar als fehlend ausgewiesen.
// ---------------------------------------------------------------------------

// Offizielle Topscorers-Werte - editierbare Konstanten, positionsabhängig wo
// zutreffend ('F' Stürmer, 'D' Verteidiger, 'G' Torhüter, wie überall im
// Projekt - siehe src/playerHistory.js::POSITION_LABEL).
export const FANTASY_SCORING = {
  goal: { F: 60, D: 70, G: 100 },
  assist: { F: 40, D: 50, G: 55 },
  plusMinus: 5, // pro +1 (negativ bei -1 entsprechend)
  gp: 5, // Einsatz/aufgestellt, pro Spiel
  goalieSave: 4,
  goalieShutout: 40,
  goalieGoalAgainst: -15,
  sog: 5, // Schuss aufs Tor - nur wo Daten vorhanden (siehe Kommentar unten)
  // Strafminuten: offizielle Regel ist -10 je 2-Minuten-Kleine Strafe. Wir
  // kennen nur die SUMME der Strafminuten (nicht die Anzahl einzelner
  // Strafen), daher als lineare Näherung -5 pro Strafminute (= -10 je volle
  // 2 Minuten bei ausschliesslich kleinen Strafen). Explizit als Näherung
  // gekennzeichnet, siehe FANTASY_CATEGORIES_CONSIDERED.
  pimPerMinuteApprox: -5,
}

// Kategorien, die tatsächlich in die Berechnung einfliessen (für die
// "berücksichtigt"-Anzeige in der UI).
export const FANTASY_CATEGORIES_CONSIDERED = [
  { key: 'goals', label: 'Tore', detail: 'Stürmer +60 / Verteidiger +70 / Torhüter +100' },
  { key: 'assists', label: 'Assists', detail: 'Stürmer +40 / Verteidiger +50 / Torhüter +55' },
  { key: 'plusMinus', label: 'Plus/Minus', detail: '+5 pro +1, -5 pro -1' },
  { key: 'gp', label: 'Einsatz (aufgestellt)', detail: '+5 pro Spiel' },
  { key: 'goalieSaves', label: 'Paraden (Torhüter)', detail: '+4 pro Parade' },
  { key: 'goalieShutout', label: 'Shutout (Torhüter)', detail: '+40 pro Shutout' },
  { key: 'goalieGoalsAgainst', label: 'Gegentore (Torhüter)', detail: '-15 pro Gegentor' },
  { key: 'sog', label: 'Schuss aufs Tor (SOG)', detail: '+5 pro Schuss - nur aus Boxscore-Daten (SIHF-Sync); bei Spielern ohne bisherige Spiel-Einträge dieser Saison aktuell 0, nicht "fehlend"' },
  { key: 'pim', label: 'Strafminuten', detail: 'Näherung: -5 pro Strafminute (≈ -10 je 2-Minuten-Kleine Strafe) - wir kennen nur die Summe, nicht die Anzahl einzelner Strafen' },
]

// Kategorien des offiziellen Systems, die wir NICHT berechnen - mangels
// verlässlicher Daten bewusst nicht erfunden.
export const FANTASY_CATEGORIES_OMITTED = [
  { key: 'teamResult', label: 'Sieg/Niederlage-Ergebnispunkte', reason: 'Keine zuverlässige Zuordnung "im Line-up beim Sieg" pro Spiel und Spieler vorhanden.' },
  { key: 'gwg', label: 'Game-Winning-Goal-Bonus', reason: 'Das siegbringende Tor ist in den Saison-Stats nicht gekennzeichnet.' },
  { key: 'hattrick', label: 'Hattrick-Bonus', reason: 'Keine verlässliche Spiel-für-Spiel-Torfolge für alle Spieler vorhanden.' },
  { key: 'ppsh', label: 'Powerplay-/Unterzahl-Tor-Splits', reason: 'Keine Special-Teams-Aufschlüsselung pro Tor/Assist in den Daten.' },
  { key: 'faceoff', label: 'Bully-Gewinne', reason: 'Keine Faceoff-Daten in den Saison-Stats.' },
  { key: 'blockedShots', label: 'Geblockte Schüsse', reason: 'Wird weder von der NL-API noch vom Boxscore-Sync erfasst.' },
  { key: 'toiBonus', label: 'Eiszeit-Bonus (TOI)', reason: 'Nur lückenhaft aus dem Boxscore-Sync vorhanden, nicht verlässlich genug für eine eigene Bonus-Kategorie.' },
]

function num(v) { return Number.isFinite(v) ? v : 0 }

// Baut die Fantasy-Punkte-Aufschlüsselung EINER Spieler-Saison-Statistik
// (Zeile aus src/stats.js::computePlayerStats, inkl. `.player`). Gibt null
// zurück, wenn keine Statistik vorhanden ist.
export function computeFantasyBreakdown(statRow) {
  if (!statRow || !statRow.player) return null
  const position = statRow.player.position // 'F' | 'D' | 'G'
  const isGoalie = position === 'G'
  const goalRate = FANTASY_SCORING.goal[position] ?? FANTASY_SCORING.goal.F
  const assistRate = FANTASY_SCORING.assist[position] ?? FANTASY_SCORING.assist.F

  const lines = [
    { key: 'goals', label: 'Tore', count: num(statRow.goals), rate: goalRate, points: num(statRow.goals) * goalRate },
    { key: 'assists', label: 'Assists', count: num(statRow.assists), rate: assistRate, points: num(statRow.assists) * assistRate },
    { key: 'plusMinus', label: 'Plus/Minus', count: num(statRow.plusMinus), rate: FANTASY_SCORING.plusMinus, points: num(statRow.plusMinus) * FANTASY_SCORING.plusMinus },
    { key: 'gp', label: 'Einsätze', count: num(statRow.gp), rate: FANTASY_SCORING.gp, points: num(statRow.gp) * FANTASY_SCORING.gp },
    { key: 'sog', label: 'Schüsse aufs Tor', count: num(statRow.sog), rate: FANTASY_SCORING.sog, points: num(statRow.sog) * FANTASY_SCORING.sog },
    { key: 'pim', label: 'Strafminuten', count: num(statRow.pim), rate: FANTASY_SCORING.pimPerMinuteApprox, points: num(statRow.pim) * FANTASY_SCORING.pimPerMinuteApprox },
  ]
  if (isGoalie) {
    lines.push(
      { key: 'goalieSaves', label: 'Paraden', count: num(statRow.saves), rate: FANTASY_SCORING.goalieSave, points: num(statRow.saves) * FANTASY_SCORING.goalieSave },
      { key: 'goalieShutout', label: 'Shutouts', count: num(statRow.shutouts), rate: FANTASY_SCORING.goalieShutout, points: num(statRow.shutouts) * FANTASY_SCORING.goalieShutout },
      { key: 'goalieGoalsAgainst', label: 'Gegentore', count: num(statRow.goalsAgainst), rate: FANTASY_SCORING.goalieGoalAgainst, points: num(statRow.goalsAgainst) * FANTASY_SCORING.goalieGoalAgainst },
    )
  }

  const total = lines.reduce((s, l) => s + l.points, 0)
  const gp = num(statRow.gp)
  return { total, perGame: gp > 0 ? total / gp : null, gp, lines, isGoalie }
}

// Reicherte eine bereits vorhandene Liste von Spieler-Stat-Zeilen
// (derived.playerStats aus src/stats.js) um `.fantasy` an - rein additiv,
// keine erneute Aggregation der Rohdaten.
export function computeFantasyScores(playerStatRows) {
  return (playerStatRows || []).map((row) => ({ ...row, fantasy: computeFantasyBreakdown(row) }))
}

// ---------------------------------------------------------------------------
// VALUE-ANALYSE: Fantasy-Punkte im Verhältnis zum Marktwert (NL-API,
// player.marketValue). Rein abgeleitet aus bereits vorhandenen Werten -
// keine neue Datenquelle, kein Eingriff in ELO/Prognose.
// ---------------------------------------------------------------------------

// "Punkte pro CHF", normiert auf 1 Mio CHF Marktwert (sonst sehr kleine
// Dezimalzahlen). null, wenn kein Marktwert bekannt ist (nicht 0 - ein
// fehlender Marktwert ist etwas anderes als ein Marktwert von 0).
export function pointsPerMillionChf(fantasyTotal, marketValue) {
  if (marketValue == null || marketValue <= 0 || fantasyTotal == null) return null
  return fantasyTotal / (marketValue / 1_000_000)
}

// Einfache lineare Regression (Fantasy-Punkte ~ Marktwert) über die
// übergebenen Punkte - liefert die Trendlinie für die Scatter-Ansicht UND
// die Grundlage für "Value"/"überbezahlt" (Residuum = tatsächliche Punkte
// minus die durch den Marktwert erwartete Punktzahl gemäss dieser Linie).
// null bei zu wenig Datenpunkten oder wenn alle x-Werte identisch sind.
export function fitValueTrendLine(points) {
  const n = points.length
  if (n < 2) return null
  const meanX = points.reduce((s, p) => s + p.x, 0) / n
  const meanY = points.reduce((s, p) => s + p.y, 0) / n
  let num = 0, den = 0
  for (const p of points) { num += (p.x - meanX) * (p.y - meanY); den += (p.x - meanX) ** 2 }
  if (den === 0) return null
  const slope = num / den
  const intercept = meanY - slope * meanX
  return { slope, intercept, predict: (x) => slope * x + intercept }
}

// ---------------------------------------------------------------------------
// Ableitung aller Statistiken aus den erfassten Spielen.
// Nichts wird doppelt gespeichert – Team- und Spieler-Saisonwerte werden hier
// jedes Mal frisch berechnet.
// ---------------------------------------------------------------------------

// Ein Spiel zählt für Tabelle/ELO/Stats nur, wenn es tatsächlich gespielt wurde.
// Fehlt `status`, gilt das Spiel (Abwärtskompatibilität) als "final".
export function isFinalGame(g) {
  const status = g.status || 'final'
  return status === 'final' && g.homeGoals != null && g.awayGoals != null
}

// NL-Punktesystem: Sieg 3, OT/SO-Sieg 2, OT/SO-Niederlage 1, Niederlage 0.
export function computeStandings(teams, games) {
  const rows = {}
  teams.forEach((t) => {
    rows[t.id] = {
      team: t,
      gp: 0, w: 0, otw: 0, otl: 0, l: 0,
      gf: 0, ga: 0, pts: 0,
    }
  })

  for (const g of games) {
    const h = rows[g.homeTeamId]
    const a = rows[g.awayTeamId]
    if (!h || !a) continue
    if (!isFinalGame(g)) continue
    h.gp++; a.gp++
    h.gf += g.homeGoals; h.ga += g.awayGoals
    a.gf += g.awayGoals; a.ga += g.homeGoals

    const homeWon = g.homeGoals > g.awayGoals
    const overtime = g.decision === 'OT' || g.decision === 'SO'
    const winner = homeWon ? h : a
    const loser = homeWon ? a : h

    if (overtime) {
      winner.otw++; winner.pts += 2
      loser.otl++; loser.pts += 1
    } else {
      winner.w++; winner.pts += 3
      loser.l++
    }
  }

  const h2h = buildHeadToHeadPointsMap(games)

  return Object.values(rows)
    .map((r) => ({ ...r, gd: r.gf - r.ga }))
    .sort((a, b) => compareTiebreak(
      { id: a.team.id, pts: a.pts, wins: a.w + a.otw, gf: a.gf, ga: a.ga },
      { id: b.team.id, pts: b.pts, wins: b.w + b.otw, gf: b.gf, ga: b.ga },
      h2h,
    ))
}

// Punkte je Team aus den direkten Duellen gegen genau einen anderen Team,
// über alle übergebenen Spiele. Schlüssel: die beiden Team-IDs alphabetisch
// sortiert und mit "|" verbunden -> { [teamIdA]: pts, [teamIdB]: pts }.
// Wird sowohl von computeStandings() (reale Saison) als auch von
// simulateSeasonProjections() (src/playoffSim.js, reale + simulierte Spiele
// kombiniert) für den Tiebreaker "direkter Vergleich" verwendet.
export function buildHeadToHeadPointsMap(games) {
  const map = new Map()
  for (const g of games) {
    if (!isFinalGame(g)) continue
    const { homeTeamId: home, awayTeamId: away } = g
    const key = home < away ? `${home}|${away}` : `${away}|${home}`
    let entry = map.get(key)
    if (!entry) { entry = {}; map.set(key, entry) }
    const homeWon = g.homeGoals > g.awayGoals
    const overtime = g.decision === 'OT' || g.decision === 'SO'
    const homePts = homeWon ? (overtime ? 2 : 3) : (overtime ? 1 : 0)
    const awayPts = homeWon ? (overtime ? 1 : 0) : (overtime ? 2 : 3)
    entry[home] = (entry[home] || 0) + homePts
    entry[away] = (entry[away] || 0) + awayPts
  }
  return map
}

// Offizieller NL-Tabellen-Tiebreaker, in dieser Reihenfolge: Punkte -> Anzahl
// Siege (regulär + OT/SO) -> direkter Vergleich (Punkte aus den Spielen
// zwischen genau diesen beiden Teams) -> Tordifferenz -> erzielte Tore.
// `a`/`b`: { id, pts, wins, gf, ga }. `h2hMap` optional (siehe
// buildHeadToHeadPointsMap) - ohne Map wird der direkte Vergleich übersprungen.
export function compareTiebreak(a, b, h2hMap) {
  if (b.pts !== a.pts) return b.pts - a.pts
  if (b.wins !== a.wins) return b.wins - a.wins
  if (h2hMap) {
    const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`
    const h2h = h2hMap.get(key)
    if (h2h) {
      const hA = h2h[a.id] || 0
      const hB = h2h[b.id] || 0
      if (hB !== hA) return hB - hA
    }
  }
  const gdA = a.gf - a.ga
  const gdB = b.gf - b.ga
  if (gdB !== gdA) return gdB - gdA
  return b.gf - a.gf
}

// Aggregierte Spieler-Statistik. Zwei unabhängige Quellen sind im Datenmodell
// vorhanden - hier wird pro Spieler GENAU EINE davon für die Kernwerte
// (GP/G/A/P/+-/SM, bei Torhütern GA/SV%/GTS/SO) verwendet, nie beide addiert:
//
//   1. player.apiStats  - offizielle Saison-Totale von nationalleague.ch
//      (server/sync.js), bevorzugt wenn vorhanden.
//   2. Spielbasierte Aggregation über games[].playerStats[] (SIHF-Sync) -
//      Fallback für Spieler ohne player.apiStats (z.B. (noch) nicht
//      verknüpfte Kader-Einträge).
//
// SOG/TOI sowie die Sieg/Niederlage-Bilanz eines Torhüters liefert AUSSCHLIESSLICH
// die spielbasierte Aggregation - die NL-API-Saison-Totale kennen diese Felder
// nicht (siehe Erkundungsbericht). Das ist keine Doppelzählung, sondern eine
// Ergänzung um Werte, die die bevorzugte Quelle schlicht nicht liefert.
export function computePlayerStats(players, games) {
  const box = {}
  players.forEach((p) => {
    box[p.id] = {
      gp: 0,
      goals: 0, assists: 0, plusMinus: 0, pim: 0,
      sog: 0, toiSec: 0,
      goalsAgainst: 0, saves: 0, shotsAgainst: 0,
      wins: 0, losses: 0, shutouts: 0,
    }
  })

  for (const g of games) {
    if (!isFinalGame(g)) continue
    for (const s of g.playerStats || []) {
      const r = box[s.playerId]
      if (!r) continue
      r.gp++
      r.goals += num(s.goals)
      r.assists += num(s.assists)
      r.plusMinus += num(s.plusMinus)
      r.pim += num(s.pim)
      r.sog += num(s.sog)
      r.toiSec += num(s.toiSec)
      r.goalsAgainst += num(s.goalsAgainst)
      r.saves += num(s.saves)
      r.shotsAgainst += num(s.saves) + num(s.goalsAgainst)
      if (s.decision === 'W') r.wins++
      if (s.decision === 'L') r.losses++
      if (s.shutout) r.shutouts++
    }
  }

  return players.map((p) => {
    const b = box[p.id]
    const api = p.apiStats
    const isGoalie = p.position === 'G'

    let gp, goals, assists, plusMinus, pim
    let goalsAgainst = null, saves = null, shotsAgainst = null, savePct = null, gaa = null, shutouts

    if (api) {
      gp = num(api.gp)
      goals = num(api.g)
      assists = num(api.a)
      plusMinus = num(api.plusMinus)
      pim = num(api.pim)
      if (isGoalie) {
        goalsAgainst = num(api.ga)
        saves = num(api.svs)
        shotsAgainst = num(api.sa)
        // savePct bevorzugt aus svs/sa (Rohzahlen); sonst API-eigenes
        // savePercentage (0-100-Skala -> /100), sonst kein Wert.
        savePct = shotsAgainst > 0
          ? saves / shotsAgainst
          : (typeof api.savePercentage === 'number' && gp > 0 ? api.savePercentage / 100 : null)
        gaa = gp > 0 ? goalsAgainst / gp : null
        shutouts = num(api.so) // Sieg/Niederlage-Bilanz kennt die API nicht -> aus Boxscore (unten)
      } else {
        shutouts = 0
      }
    } else {
      gp = b.gp
      goals = b.goals
      assists = b.assists
      plusMinus = b.plusMinus
      pim = b.pim
      if (isGoalie) {
        goalsAgainst = b.goalsAgainst
        saves = b.saves
        shotsAgainst = b.shotsAgainst
        savePct = b.shotsAgainst > 0 ? b.saves / b.shotsAgainst : null
        gaa = b.gp > 0 ? b.goalsAgainst / b.gp : null
      }
      shutouts = b.shutouts
    }

    return {
      player: p,
      statSource: api ? 'api' : 'box', // für UI-Hinweise (z.B. Spielprotokoll ohne Boxscore)
      gp, goals, assists, points: goals + assists, plusMinus, pim,
      sog: b.sog, toiSec: b.toiSec,
      sogpg: b.gp > 0 ? b.sog / b.gp : null,
      toipg: b.gp > 0 ? b.toiSec / b.gp : null,
      goalsAgainst, saves, shotsAgainst, savePct, gaa,
      wins: b.wins, losses: b.losses, shutouts,
    }
  })
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function fmtPct(v) {
  if (v == null) return '–'
  return (v * 100).toFixed(1) + '%'
}

export function fmtNum(v, digits = 2) {
  if (v == null) return '–'
  return v.toFixed(digits)
}

export function plusMinusStr(v) {
  if (v > 0) return '+' + v
  return String(v)
}

// Marktwert (CHF, von nationalleague.ch) - Schweizer Tausender-Trennzeichen
// (Apostroph), z.B. 1'250'000.
export function fmtChf(v) {
  if (v == null) return '–'
  return v.toLocaleString('de-CH')
}

// Alter in Jahren aus Geburtsdatum ("YYYY-MM-DD"), Stichtag heute.
export function ageFromBirthdate(birthdate) {
  if (!birthdate) return null
  const bd = new Date(birthdate)
  if (Number.isNaN(bd.getTime())) return null
  const now = new Date()
  let age = now.getFullYear() - bd.getFullYear()
  const beforeBirthday = now.getMonth() < bd.getMonth() ||
    (now.getMonth() === bd.getMonth() && now.getDate() < bd.getDate())
  if (beforeBirthday) age--
  return age
}

// Team-Form: Letzte N Spiele als Buchstaben (S/OTS/OTN/N) + Punkteschnitt
export function computeTeamForm(teamId, games, n = 5) {
  const finalGames = games
    .filter(isFinalGame)
    .filter((g) => g.homeTeamId === teamId || g.awayTeamId === teamId)
    .sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0))
    .slice(0, n)

  const letters = finalGames.map((g) => {
    const isHome = g.homeTeamId === teamId
    const won = isHome ? g.homeGoals > g.awayGoals : g.awayGoals > g.homeGoals
    const overtime = g.decision === 'OT' || g.decision === 'SO'
    if (won) return overtime ? 'OTS' : 'S'
    return overtime ? 'OTN' : 'N'
  })

  const pts = finalGames.reduce((sum, g) => {
    const isHome = g.homeTeamId === teamId
    const won = isHome ? g.homeGoals > g.awayGoals : g.awayGoals > g.homeGoals
    const overtime = g.decision === 'OT' || g.decision === 'SO'
    if (won) return sum + (overtime ? 2 : 3)
    return sum + (overtime ? 1 : 0)
  }, 0)

  const avgPts = finalGames.length > 0 ? pts / finalGames.length : 0
  return { form: letters.join('/'), avgPts, gp: finalGames.length }
}

// Heim/Auswärts-Splits für ein Team
export function computeHomeSplits(teamId, games) {
  const home = { gp: 0, w: 0, otw: 0, otl: 0, l: 0, gf: 0, ga: 0, pts: 0 }
  const away = { gp: 0, w: 0, otw: 0, otl: 0, l: 0, gf: 0, ga: 0, pts: 0 }

  for (const g of games) {
    if (!isFinalGame(g)) continue
    const isHome = g.homeTeamId === teamId
    const isAway = g.awayTeamId === teamId
    if (!isHome && !isAway) continue

    const split = isHome ? home : away
    const won = isHome ? g.homeGoals > g.awayGoals : g.awayGoals > g.homeGoals
    const overtime = g.decision === 'OT' || g.decision === 'SO'

    split.gp++
    split.gf += isHome ? g.homeGoals : g.awayGoals
    split.ga += isHome ? g.awayGoals : g.homeGoals

    if (overtime) {
      if (won) {
        split.otw++
        split.pts += 2
      } else {
        split.otl++
        split.pts += 1
      }
    } else {
      if (won) {
        split.w++
        split.pts += 3
      } else {
        split.l++
      }
    }
  }

  return {
    home: { ...home, gd: home.gf - home.ga },
    away: { ...away, gd: away.gf - away.ga },
  }
}

// Head-to-Head: Alle Spiele zwischen zwei Teams
export function computeHeadToHead(team1Id, team2Id, games) {
  const matchups = games
    .filter(isFinalGame)
    .filter((g) => (g.homeTeamId === team1Id && g.awayTeamId === team2Id) ||
                   (g.homeTeamId === team2Id && g.awayTeamId === team1Id))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  let t1w = 0, t1otw = 0, t1otl = 0, t1l = 0, t1gf = 0, t1ga = 0
  let t2w = 0, t2otw = 0, t2otl = 0, t2l = 0, t2gf = 0, t2ga = 0

  for (const g of matchups) {
    const t1Home = g.homeTeamId === team1Id
    const t1Won = t1Home ? g.homeGoals > g.awayGoals : g.awayGoals > g.homeGoals
    const overtime = g.decision === 'OT' || g.decision === 'SO'

    if (t1Home) {
      t1gf += g.homeGoals
      t1ga += g.awayGoals
      t2gf += g.awayGoals
      t2ga += g.homeGoals
    } else {
      t1gf += g.awayGoals
      t1ga += g.homeGoals
      t2gf += g.homeGoals
      t2ga += g.awayGoals
    }

    if (t1Won) {
      if (overtime) {
        t1otw++
        t2otl++
      } else {
        t1w++
        t2l++
      }
    } else {
      if (overtime) {
        t1otl++
        t2otw++
      } else {
        t1l++
        t2w++
      }
    }
  }

  return {
    matchups,
    t1: {
      w: t1w, otw: t1otw, otl: t1otl, l: t1l, gf: t1gf, ga: t1ga,
      pts: t1w * 3 + t1otw * 2 + t1otl,
      gp: matchups.length,
    },
    t2: {
      w: t2w, otw: t2otw, otl: t2otl, l: t2l, gf: t2gf, ga: t2ga,
      pts: t2w * 3 + t2otw * 2 + t2otl,
      gp: matchups.length,
    },
  }
}

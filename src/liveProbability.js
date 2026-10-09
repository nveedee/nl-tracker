// ---------------------------------------------------------------------------
// LIVE WIN/DRAW/LOSS PROBABILITY - reine Restzeit-Poisson-Engine.
//
// Ersetzt die vorherige Demo-Darstellung (LIVE_PROBABILITY_ANALYSIS.md,
// Abschnitt "Verifikation der SIHF-API"), in der die angezeigten Prozentwerte
// (z.B. "83% / 6% / 11%" bei 2:1 in der 58. Minute) ein fest verdrahtetes
// Demo-Array in src/liveDemoData.js waren - KEINE Berechnung, nur
// Illustrationswerte. Root Cause des als "verdächtig" gemeldeten 11%-Away-
// Werts: Es gab bis zu diesem Modul GAR KEINE Live-Wahrscheinlichkeitsformel,
// nur erfundene Beispieldaten.
//
// METHODE (Restzeit-Poisson, wie in der Aufgabenstellung gefordert):
//   1. Aus dem bestehenden, UNVERÄNDERTEN Pre-Game-Modell (src/playoffSim.js
//      computeFixtures()/buildFixture() -> ELO + Heimvorteil + SOG-Faktor)
//      liegen bereits `expHomeFull`/`expAwayFull` (erwartete Tore über die
//      vollen 60 Minuten) und `pHomePreGame` (Heimsieg-Wahrscheinlichkeit,
//      identisch zur bestehenden OT/SO-Auslosung in simulateGameResult())vor.
//      Dieses Modul berechnet KEINE eigene Teamstärke - reine Restzeit-Logik
//      auf Basis der bereits vorhandenen Zahlen.
//   2. Torerwartung für die VERBLEIBENDE Regulationszeit wird linear aus der
//      vollen Erwartung skaliert: remLambda = fullLambda * remainingFraction.
//      Bereits gespielte Zeit wird NICHT erneut simuliert - nur die Zukunft.
//   3. Der bereits gefallene Score ist ein fixer Offset (currentHomeGoals -
//      currentAwayGoals). Für die verbleibenden, noch zu erzielenden Tore
//      wird die geschlossene Poisson-Doppelsumme verwendet (identisches
//      Prinzip wie computeDecisionProbability() in playoffSim.js) statt
//      Monte-Carlo-Rauschen - exakt, deterministisch, kein Seed nötig.
//   4. OT/SO: Ein Unentschieden nach 60 Minuten ("drawAfter60") ist in der
//      National League NIE das Endergebnis. Die FINALEN Home/Away-Werte
//      lösen drawAfter60 über die bestehende, kalibrierte OT/SO-Logik auf
//      (siehe HOME/AWAY_FINAL unten) - identisch zur Home-Win-Auslosung in
//      simulateGameResult() (dort: `rng.next() < fixture.pHome`, sowohl für
//      OT als auch SO). Das bestehende Modell unterscheidet den Sieger-Anteil
//      von OT und SO NICHT (beide nutzen fixture.pHome) - diese Vereinfachung
//      wird hier bewusst NICHT "verbessert" (keine erfundene Kalibrierung),
//      sondern unverändert übernommen und dokumentiert (bekannte Einschränkung,
//      siehe LIVE_PROBABILITY_ANALYSIS.md).
//
// UI-DEFINITION (ersetzt die vorherige, undokumentierte/inkonsistente Demo-
// Definition, siehe LIVE_PROBABILITY_ANALYSIS.md):
//   HOME/AWAY („AJO 92% / AMB 3%“) = homeFinal/awayFinal, d.h. die
//   Wahrscheinlichkeit, dass dieses Team das Spiel ENDGÜLTIG gewinnt (inkl.
//   OT/SO) - IN SUMME 100%, weil ein Eishockeyspiel nie unentschieden endet.
//   Ein separates "Unentschieden nach 60 Minuten" (drawAfter60) wird NICHT
//   in diese 100%-Aufteilung eingerechnet, sondern als eigener, klar
//   beschrifteter Zusatzwert geführt - exakt das bereits bestehende Muster
//   der Pre-Game-Sektion (MatchupDetail.jsx: "OT-Wahrscheinlichkeit"/
//   "SO-Wahrscheinlichkeit" als separate Kacheln neben dem Home/Away-Split,
//   nicht Teil davon). Die vorherige Demo hatte stattdessen "DRAW" als
//   dritten Teil der 100%-Aufteilung behandelt, als wäre ein Unentschieden
//   ein mögliches Endergebnis - das war die dokumentierte Inkonsistenz.
// ---------------------------------------------------------------------------

export const REGULATION_MINUTES = 60
export const MINUTES_PER_PERIOD = 20

// Identisch zu playoffSim.js CALIBRATION.otShareOfTies - bewusst dupliziert
// (gleiches Muster wie SOG_ADJUSTMENT zwischen powerRankings.js/playoffSim.js,
// siehe dortiger Kommentar), damit dieses Modul unabhängig von playoffSim.js
// importierbar/testbar bleibt und KEINE eigene, abweichende Zahl erfindet.
export const OT_SHARE_OF_TIES = 0.6056

const POISSON_TRUNCATION_MIN = 6
const POISSON_TRUNCATION_MAX = 40

function poissonPmfTable(lambda, n) {
  const table = new Array(n + 1)
  table[0] = Math.exp(-lambda)
  for (let k = 1; k <= n; k++) table[k] = table[k - 1] * (lambda / k)
  return table
}

// Truncation adaptiv zur Lambda-Grösse (spät im Spiel ist lambda oft <0.1 ->
// eine kleine Tabelle reicht; früh im Spiel braucht es mehr Terme für
// vernachlässigbaren Rest, siehe FORECAST_GOAL_TRUNCATION in playoffSim.js
// für dasselbe Prinzip bei vollen 60-Minuten-Lambdas).
function truncationFor(lambda) {
  const n = Math.ceil(lambda + 8 * Math.sqrt(lambda + 1))
  return Math.max(POISSON_TRUNCATION_MIN, Math.min(POISSON_TRUNCATION_MAX, n))
}

// Verbleibender Anteil der 60 Regulationsminuten (0..1). Kappt elapsedMinutes
// auf [0, 60] - Overtime/Shootout-Zeit ist NICHT Teil der Regulationszeit und
// wird separat über `phase` behandelt (siehe computeLiveWinProbability).
export function remainingFraction(elapsedMinutes) {
  const clamped = Math.max(0, Math.min(REGULATION_MINUTES, elapsedMinutes))
  return (REGULATION_MINUTES - clamped) / REGULATION_MINUTES
}

// Wandelt Drittel + verbleibende Zeit IM Drittel (Countdown-Uhr, wie SIHF/die
// meisten Live-Anzeigen sie führen) in absolute verstrichene Spielzeit um.
// `periodClockRemainingSeconds`: Sekunden bis Drittelende (20:00 -> 0:00).
// Rein informativer Hilfsbaustein für eine künftige echte Anbindung - wird
// von der Demo (liveDemoData.js) nicht benötigt, da dort die verstrichene
// Minute bereits direkt bekannt ist.
export function elapsedMinutesFromPeriodClock(period, periodClockRemainingSeconds) {
  const elapsedInPeriod = MINUTES_PER_PERIOD - periodClockRemainingSeconds / 60
  return (period - 1) * MINUTES_PER_PERIOD + Math.max(0, Math.min(MINUTES_PER_PERIOD, elapsedInPeriod))
}

// Zentrale Zeitformatierung ("MM:SS" aus einem Minutenwert) - EINZIGE Stelle,
// die Minuten in eine Uhrzeit-Anzeige umwandelt. Wird sowohl für die
// Gesamtspielzeit (`gameTime`) als auch für die Drittelzeit (`periodTime`,
// siehe periodTimeFromElapsed()) verwendet, damit z.B. Header und
// Probability-Chart niemals unterschiedliche Zeitdarstellungen zeigen
// können.
export function formatClock(minutes) {
  const totalSeconds = Math.max(0, Math.round(minutes * 60))
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

// Zentrale Umkehrfunktion zu elapsedMinutesFromPeriodClock(): aus der
// GESAMT-verstrichenen Spielzeit (elapsedMinutes) das aktuelle Drittel und
// die verstrichene Zeit INNERHALB dieses Drittels ableiten (1. Drittel:
// 0-20', 2. Drittel: 20-40' -> periodTime = elapsed-20, 3. Drittel: 40-60' ->
// periodTime = elapsed-40 - exakt wie in der Aufgabenstellung gefordert).
// Einzige Quelle dieser Umrechnung - jede Live-Komponente (Header, Chart,
// künftige weitere Anzeigen), die "Drittel X, MM:SS" zeigen will, MUSS diese
// Funktion verwenden statt eine eigene/abweichende Berechnung zu pflegen.
export function periodTimeFromElapsed(elapsedMinutes) {
  const clamped = Math.max(0, elapsedMinutes)
  const periodIndex = Math.min(2, Math.floor(clamped / MINUTES_PER_PERIOD)) // 0,1,2 -> Drittel 1,2,3
  const period = periodIndex + 1
  const periodMinutes = clamped - periodIndex * MINUTES_PER_PERIOD
  return { period, periodTime: formatClock(periodMinutes) }
}

// Kern der Engine: geschlossene Poisson-Doppelsumme für die VERBLEIBENDEN
// Tore (kein Monte-Carlo, keine Zufallszahlen, deterministisch) - liefert
// P(Heimsieg nach Regulationszeit) / P(Unentschieden nach 60') /
// P(Auswärtssieg nach Regulationszeit) für einen gegebenen aktuellen Score.
function regulationOutcomeProbabilities(remHomeLambda, remAwayLambda, goalDiff) {
  const nHome = truncationFor(remHomeLambda)
  const nAway = truncationFor(remAwayLambda)
  const pmfHome = poissonPmfTable(remHomeLambda, nHome)
  const pmfAway = poissonPmfTable(remAwayLambda, nAway)

  let homeWin = 0, draw = 0, awayWin = 0
  for (let h = 0; h <= nHome; h++) {
    const ph = pmfHome[h]
    if (ph <= 0) continue
    for (let a = 0; a <= nAway; a++) {
      const p = ph * pmfAway[a]
      if (p <= 0) continue
      const finalDiff = goalDiff + h - a
      if (finalDiff > 0) homeWin += p
      else if (finalDiff < 0) awayWin += p
      else draw += p
    }
  }
  // Normalisierung gegen den (durch die Truncation) minimal <1 verbleibenden
  // Rest - hält die Summe exakt bei 1 statt z.B. 0.999999998.
  const total = homeWin + draw + awayWin
  if (total <= 0) return { homeWin: 0, draw: 1, awayWin: 0 }
  return { homeWin: homeWin / total, draw: draw / total, awayWin: awayWin / total }
}

/**
 * Berechnet die Live Win/Draw/Loss-Wahrscheinlichkeit aus dem aktuellen
 * Spielzustand. Reine Funktion, keine Zufallszahlen, kein Seed nötig
 * (geschlossene Form statt Simulation).
 *
 * @param {object} params
 * @param {number} params.expHomeFull  Erwartete Heimtore über 60' (Pre-Game-Modell, z.B. fixture.expHome aus playoffSim.js)
 * @param {number} params.expAwayFull  Erwartete Auswärtstore über 60' (Pre-Game-Modell)
 * @param {number} params.pHomePreGame Pre-Game Heimsieg-Wahrscheinlichkeit (fixture.pHome) - bestimmt NUR die OT/SO-Auflösung, identisch zum bestehenden Modell
 * @param {number} params.homeGoals    Aktueller Score Heim
 * @param {number} params.awayGoals    Aktueller Score Auswärts
 * @param {number} params.elapsedMinutes Verstrichene REGULATIONS-Spielzeit in Minuten (0-60)
 * @param {'REG'|'OT'|'SO'} [params.phase='REG'] Spielphase - 'OT'/'SO' bedeutet: Regulationszeit ist vorbei (60:00), das Spiel ist bereits unentschieden und wird gerade in der Verlängerung/im Penaltyschiessen entschieden (Sudden Death - keine weitere Restzeit-Poisson-Rechnung sinnvoll, siehe Doku unten)
 */
// Baut die VOLLSTÄNDIGE Wahrscheinlichkeits-Zeitreihe (Spielbeginn -> jetzt)
// aus den bereits gefallenen Toren + dem aktuellen Spielzustand - identisches
// Prinzip wie buildProbabilityHistory() in src/liveDemoData.js und der
// historische Replay (server/liveReplay.js::buildRealGameReplayTimeline): für
// jeden Stützpunkt wird der Score ZU DIESEM ZEITPUNKT aus den echten
// Torzeitstempeln bestimmt und die Wahrscheinlichkeit über die UNVERÄNDERTE
// computeLiveWinProbability() berechnet. KEINE interpolierten/erfundenen
// Werte - nur echte Tore, echter Spielstand, echte Spielzeit und die
// bestehende Engine.
//
// Grund: Der echte Live-Hook (src/liveGameClient.js::useLiveGame) sammelte
// bisher nur EINEN Punkt pro Poll ab Beobachtungsbeginn - bei einem bereits
// laufenden Spiel ergab das 1-2 Punkte, also keine durchgehende Kurve (nur
// die Event-/Jetzt-Marker). Diese Funktion rekonstruiert stattdessen die
// gesamte bisher gespielte Zeit, sodass die Kurven wie in der historischen
// Ansicht durchgehend sind und mit dem Spielverlauf weiterwachsen.
//
// @param goals [{ minute:number (absolute Spielminute), side:'home'|'away' }]
// @param homeGoals/awayGoals aktueller (massgeblicher) Spielstand
// @param elapsedMinutes aktuell verstrichene Zeit (REG: 0-60; OT/SO: >=60,
//        Wanduhr-fortgeschrieben, siehe liveGameClient.js)
// @param phase 'REG'|'OT'|'SO'
// Requirement 7 (OT/SO = kein belastbarer Restzeit-Verlauf): die
// Regulations-Kurve endet sauber bei 60:00; für OT/SO wird NUR der aktuelle,
// eingefrorene Punkt angehängt (homeFinal=pHome, drawAfter60=1 - exakt
// computeLiveWinProbability()), nie eine irreführende dynamische Kurve.
export function buildLiveProbabilityTimeline({
  expHomeFull, expAwayFull, pHomePreGame,
  goals = [], homeGoals = 0, awayGoals = 0, elapsedMinutes = 0, phase = 'REG', stepSeconds = 30,
}) {
  const cleanGoals = (goals || [])
    .filter((g) => g && Number.isFinite(g.minute) && (g.side === 'home' || g.side === 'away'))
    .sort((a, b) => a.minute - b.minute)
  const scoreAt = (tMinutes) => {
    let h = 0, a = 0
    for (const g of cleanGoals) {
      if (g.minute > tMinutes) break
      if (g.side === 'home') h++; else a++
    }
    return { home: h, away: a }
  }
  const pointAt = (elapsedSeconds, phaseAt, scoreOverride) => {
    const elapsedMin = elapsedSeconds / 60
    const score = scoreOverride || scoreAt(elapsedMin)
    const r = computeLiveWinProbability({
      expHomeFull, expAwayFull, pHomePreGame,
      homeGoals: score.home, awayGoals: score.away,
      elapsedMinutes: Math.min(elapsedMin, REGULATION_MINUTES), phase: phaseAt,
    })
    return {
      elapsedSeconds,
      gameTime: formatClock(elapsedMin),
      homeGoals: score.home, awayGoals: score.away,
      homeWin: r.homeFinal, drawAfter60: r.drawAfter60, awayWin: r.awayFinal,
      eventType: null, event: null,
    }
  }

  // Regulations-Stützpunkte: gleichmässiges Raster bis min(jetzt, 60') PLUS
  // für jedes echte Tor die Sekunde davor (letzter Stand) und die Torsekunde
  // selbst (Stand danach) -> harte Sprünge an der echten Torzeit statt erst
  // beim nächsten Raster-Tick (identisch zum historischen Replay).
  const regEndSeconds = Math.round(Math.min(elapsedMinutes, REGULATION_MINUTES) * 60)
  const sampleSeconds = new Set()
  for (let s = 0; s <= regEndSeconds; s += stepSeconds) sampleSeconds.add(s)
  sampleSeconds.add(regEndSeconds)
  for (const g of cleanGoals) {
    const s = Math.round(g.minute * 60)
    if (s > 0 && s <= regEndSeconds) { sampleSeconds.add(s - 1); sampleSeconds.add(s) }
  }
  const history = [...sampleSeconds]
    .filter((s) => s >= 0 && s <= regEndSeconds)
    .sort((a, b) => a - b)
    .map((s) => pointAt(s, 'REG'))
  if (history.length > 0) history[0].eventType = 'START'

  // Aktueller (massgeblicher) Punkt: Score/Phase/Zeit exakt wie der Live-
  // Snapshot - garantiert, dass der "Jetzt"-Punkt der Kurve mit der oben
  // angezeigten aktuellen Quote (buildRealLiveMatch) übereinstimmt. Bei OT/SO
  // liegt er jenseits von 60:00 (eingefrorene Quote, flache Verbindung).
  const curSeconds = Math.round(elapsedMinutes * 60)
  const curPoint = pointAt(curSeconds, phase, { home: homeGoals, away: awayGoals })
  const last = history[history.length - 1]
  if (last && last.elapsedSeconds === curSeconds) history[history.length - 1] = curPoint
  else history.push(curPoint)

  return history
}

export function computeLiveWinProbability({
  expHomeFull, expAwayFull, pHomePreGame,
  homeGoals, awayGoals, elapsedMinutes, phase = 'REG',
}) {
  if (!Number.isFinite(expHomeFull) || !Number.isFinite(expAwayFull) || !Number.isFinite(pHomePreGame)) {
    throw new Error('computeLiveWinProbability: expHomeFull/expAwayFull/pHomePreGame müssen endliche Zahlen sein')
  }
  const pHome = Math.max(0, Math.min(1, pHomePreGame))
  const goalDiff = (homeGoals || 0) - (awayGoals || 0)

  // OT/SO: Regulationszeit ist abgeschlossen (60:00, Score laut Definition
  // ausgeglichen) - Sudden Death. Das bestehende Modell (simulateGameResult())
  // kennt keine tor-für-tor-Dynamik INNERHALB von OT/SO, sondern nur die
  // kalibrierte Sieger-Auslosung am Ende (fixture.pHome, für OT und SO
  // identisch). Diese Engine übernimmt das unverändert (keine erfundene
  // "Sudden-Death-Poisson"-Formel) - siehe bekannte Einschränkung in
  // LIVE_PROBABILITY_ANALYSIS.md.
  if (phase === 'OT' || phase === 'SO') {
    return {
      phase,
      elapsedMinutes,
      remainingFraction: 0,
      remHomeLambda: 0,
      remAwayLambda: 0,
      homeRegWin: 0,
      drawAfter60: 1,
      awayRegWin: 0,
      otShare: OT_SHARE_OF_TIES,
      soShare: 1 - OT_SHARE_OF_TIES,
      homeFinal: pHome,
      awayFinal: 1 - pHome,
    }
  }

  const remFrac = remainingFraction(elapsedMinutes)
  const remHomeLambda = expHomeFull * remFrac
  const remAwayLambda = expAwayFull * remFrac

  const { homeWin: homeRegWin, draw: drawAfter60, awayWin: awayRegWin } =
    regulationOutcomeProbabilities(remHomeLambda, remAwayLambda, goalDiff)

  // Finale (Match-Ausgang, inkl. OT/SO) - das nach 60' ausgeglichene Rest-
  // Wahrscheinlichkeitsgewicht wird exakt wie im bestehenden Modell verteilt
  // (fixture.pHome, siehe Kommentar oben) - HOME_FINAL + AWAY_FINAL = 1
  // GARANTIERT, weil drawAfter60 vollständig auf beide verteilt wird.
  const homeFinal = homeRegWin + drawAfter60 * pHome
  const awayFinal = awayRegWin + drawAfter60 * (1 - pHome)

  return {
    phase: 'REG',
    elapsedMinutes,
    remainingFraction: remFrac,
    remHomeLambda,
    remAwayLambda,
    homeRegWin,
    drawAfter60,
    awayRegWin,
    otShare: OT_SHARE_OF_TIES,
    soShare: 1 - OT_SHARE_OF_TIES,
    homeFinal,
    awayFinal,
  }
}

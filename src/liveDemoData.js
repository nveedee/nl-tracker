// ---------------------------------------------------------------------------
// LIVE DEMO-DATEN für das Live-Match-Konzept (MatchupDetail.jsx).
//
// WICHTIG: Score/Ereignisse/Zeitpunkte unten sind erfundenes Beispielmaterial
// (keine SIHF-Anbindung, kein Live-Polling, nicht mit db.json verbunden,
// nichts wird gespeichert) - ABER die angezeigte Probability-Timeline ist
// SEIT DIESER VERSION eine ECHTE Berechnung über src/liveProbability.js
// (Restzeit-Poisson-Engine), nicht mehr ein fest verdrahtetes Zahlen-Array.
//
// Vorher zeigte die Demo bei "2:1 in der 58. Minute" die Werte 83/6/11% -
// das waren reine Illustrationszahlen ohne jede Berechnung (siehe
// LIVE_PROBABILITY_ANALYSIS.md, Abschnitt "Root Cause"). Mit dem echten
// Modell ergibt exakt dieselbe Situation ca. 96.5% / 3.5% (siehe
// src/liveProbability.test.js, Testfall "2:1 bei 58'") - der Sprung zeigt,
// dass die alten Zahlen keinen mathematischen Bezug zur Situation hatten.
//
// Diese Datei bleibt "LIVE DEMO" (klar von echten Live-Daten getrennt, siehe
// LiveMatchHeader.jsx-Badge) - der einzige Unterschied zu einer echten
// Anbindung ist die Datenquelle für Score/Events (hier: statisches Skript
// statt SIHF-Live-Polling). Sobald eine echte Anbindung existiert, liefert
// sie Score/Events/elapsedMinutes im selben Rohformat, das computeLiveMatch()
// unten bereits durch dieselbe Probability-Engine schickt.
// ---------------------------------------------------------------------------
import { computeLiveWinProbability, REGULATION_MINUTES, formatClock, periodTimeFromElapsed } from './liveProbability.js'

// Hockey-Spielzeit: 3 Drittel à 20 Minuten (0-60'), danach Overtime (60-65').
// Kein 90'-Fussball-Raster - siehe Analyse: "an Eishockey anpassen".
export const DEMO_PERIOD_MARKERS = [0, 20, 40, 60]
export const DEMO_MAX_MINUTE = 65

// Illustrative Pre-Game-Parameter für die Demo (Grössenordnung wie
// CALIBRATION.leagueHomeGPG/leagueAwayGPG in src/playoffSim.js für ein leicht
// heimfavorisiertes Spiel) - bewusst NICHT aus echten Team-ELO-Werten
// abgeleitet, da die Demo unabhängig von den echten, im Browser geladenen
// Team-/Saisondaten funktionieren muss (z.B. auf einer Detailseite für ein
// Spiel ohne aussagekräftige ELO-Historie). Für eine echte Anbindung liefert
// computeFixtures()/buildFixture() (src/playoffSim.js) dieselben drei Werte
// aus dem echten Modell - die Engine (liveProbability.js) ist identisch.
const DEMO_PREGAME = { expHomeFull: 3.05, expAwayFull: 2.55, pHomePreGame: 0.56 }

// UI-/Mathematik-Testszenario: AJO 1:2 AMB bei 34:00 (2. Drittel). Nur der
// Demo-Spielzustand wurde geändert - Engine/Berechnung unverändert (siehe
// buildProbabilityHistory() unten, unangetastet).
const DEMO_EVENTS = [
  { minute: 14, type: 'goal', side: 'home', text: 'Tor · M. Fritsche (Assist: L. Meier)' },
  { minute: 31, type: 'goal', side: 'away', text: 'Tor · J. Corvi' },
  { minute: 34, type: 'goal', side: 'away', text: 'Tor · P. Ott (Powerplay)' },
]

// Moderate Werte passend zu 34:00 (2. Drittel) statt der vorherigen
// Endphase-Zahlen - keine künstlich extremen End-of-game-Statistiken.
const DEMO_STATS = {
  sogHome: 13, sogAway: 15,
  shotsHome: 17, shotsAway: 19,
  faceoffsWonHome: 15, faceoffsWonAway: 13,
  ppHome: 2, ppAway: 2,
  ppGoalsHome: 0, ppGoalsAway: 1,
  pimHome: 2, pimAway: 2,
}

const CURRENT_MINUTE = 34 // "Jetzt" - letzter beobachteter Live-Snapshot der Demo (Testszenario: 34:00)

// Score zum Zeitpunkt `minute` aus den chronologischen Events ableiten (keine
// separate Score-Quelle - ein Tor-Event IST die einzige Quelle der Wahrheit
// für den Spielstand, wie bei einer echten Anbindung auch).
function scoreAt(minute) {
  let home = 0, away = 0
  for (const e of DEMO_EVENTS) {
    if (e.type !== 'goal' || e.minute > minute) continue
    if (e.side === 'home') home++
    else away++
  }
  return { home, away }
}

// Baut die HISTORISCHEN Probability-Snapshots: ein tatsächlich berechneter
// Punkt pro Minute (0..CURRENT_MINUTE) über die echte Restzeit-Poisson-Engine
// (src/liveProbability.js) - inkl. des durch jedes Tor verursachten,
// mathematisch begründeten Sprungs (der Sprung entsteht automatisch aus
// scoreAt(), nicht aus einer separat gepflegten Kurve).
//
// Feldnamen/Struktur bewusst identisch zu dem, was eine künftige echte
// SIHF-Live-Anbindung liefern würde (siehe LIVE_PROBABILITY_ANALYSIS.md,
// Abschnitt "Live Probability Timeline"): `elapsedSeconds`, `gameTime`,
// `homeGoals`/`awayGoals`, `homeWin`/`drawAfter60`/`awayWin`, `eventType` -
// keine UI-spezifische Sonderstruktur, die später ersetzt werden müsste.
// Jeder Punkt ist ein ECHTER Modellwert für genau diesen Zeitpunkt, kein
// interpolierter/erfundener Zwischenwert (siehe LiveWinProbabilityPanel.jsx:
// der Hover sucht den nächstgelegenen dieser Punkte, statt zu interpolieren).
function buildProbabilityHistory() {
  const eventByMinute = new Map(DEMO_EVENTS.map((e) => [e.minute, e]))
  const history = []
  for (let minute = 0; minute <= CURRENT_MINUTE; minute++) {
    const { home, away } = scoreAt(minute)
    const r = computeLiveWinProbability({
      ...DEMO_PREGAME,
      homeGoals: home,
      awayGoals: away,
      elapsedMinutes: Math.min(minute, REGULATION_MINUTES),
    })
    const event = eventByMinute.get(minute)
    history.push({
      elapsedSeconds: minute * 60,
      gameTime: formatClock(minute),
      homeGoals: home,
      awayGoals: away,
      homeWin: r.homeFinal,
      drawAfter60: r.drawAfter60,
      awayWin: r.awayFinal,
      eventType: minute === 0 ? 'START' : event ? event.type.toUpperCase() : null,
      event: event || null,
    })
  }
  return history
}

// Baut ein vollständiges Demo-Objekt für zwei konkrete Teams (übernimmt nur
// deren id/name/short/color aus den echten Team-Stammdaten - keine erfundenen
// Team-Infos). Score/Status/Probability sind intern konsistent, weil beide
// aus denselben DEMO_EVENTS/DEMO_PREGAME abgeleitet werden.
export function buildDemoLiveMatch(homeTeam, awayTeam) {
  const probabilityHistory = buildProbabilityHistory()
  const current = probabilityHistory[probabilityHistory.length - 1]

  // Drittel + Drittelzeit IMMER aus periodTimeFromElapsed() (src/liveProbability.js)
  // ableiten statt als eigenen String zu pflegen - einzige Zeitquelle für
  // Header/Chart, damit beide nie auseinanderlaufen können (0-20'/20-40'/
  // 40-60' -> periodTime = elapsed - Drittelstart).
  const { period, periodTime } = periodTimeFromElapsed(CURRENT_MINUTE)

  return {
    isDemo: true,
    // Steuert den pulsierenden LIVE-Marker am Chart-Ende (LiveWinProbabilityPanel.jsx)
    // sowie das LIVE/LIVE DEMO-Badge im Header - `false` würde einen ruhigen,
    // statischen Endpunkt ohne Puls/Label zeigen (Spiel beendet).
    isLive: true,
    homeTeam, awayTeam,
    status: { period, periodLabel: `${period}. Drittel`, clock: periodTime, percent: Math.round((CURRENT_MINUTE / REGULATION_MINUTES) * 100) },
    score: { home: current.homeGoals, away: current.awayGoals },
    probability: { pHome: current.homeWin, pDraw: current.drawAfter60, pAway: current.awayWin },
    probabilityHistory,
    events: DEMO_EVENTS,
    stats: DEMO_STATS,
  }
}

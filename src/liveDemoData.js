// ---------------------------------------------------------------------------
// NUR UI-DEMO-DATEN für das Live-Match-Konzept (MatchupDetail.jsx).
//
// WICHTIG: Das hier ist AUSSCHLIESSLICH statisches Beispielmaterial für die
// visuelle Gestaltung der geplanten Live-Ansicht. Es ist:
// - keine echte SIHF-Anbindung, kein Live-Polling
// - keine Festlegung der künftigen `liveState`-Datenstruktur im Backend
// - nicht mit db.json oder dem Sync verbunden, wird nirgends gespeichert
// - rein clientseitig erzeugt und verschwindet beim Reload
//
// Sobald die echte Live-Datenschicht (SIHF-Sync-Erweiterung, neuer Endpoint)
// steht, wird diese Datei durch einen echten Data-Hook ersetzt - die
// Komponenten (LiveMatchHeader, LiveWinProbabilityPanel, LiveGameTimeline,
// LiveStatistics) erwarten bewusst einfache, flache Props, damit dieser
// Austausch ohne Component-Umbau möglich ist. Siehe LIVE_PROBABILITY_ANALYSIS.md.
// ---------------------------------------------------------------------------

// Hockey-Spielzeit: 3 Drittel à 20 Minuten (0-60'), danach Overtime (60-65').
// Kein 90'-Fussball-Raster - siehe Analyse: "an Eishockey anpassen".
export const DEMO_PERIOD_MARKERS = [0, 20, 40, 60]
export const DEMO_MAX_MINUTE = 65

// Eine beispielhafte Wahrscheinlichkeits-Timeline für ein fiktives, bereits
// weit fortgeschrittenes Spiel - Werte frei erfunden, nur zur Illustration
// der späteren Chart-Form (Kurve reagiert sichtbar auf die zwei Beispiel-Tore).
const DEMO_PROBABILITY_TIMELINE = [
  { minute: 0, pHome: 0.54, pDraw: 0.20, pAway: 0.26 },
  { minute: 5, pHome: 0.55, pDraw: 0.19, pAway: 0.26 },
  { minute: 10, pHome: 0.52, pDraw: 0.21, pAway: 0.27 },
  { minute: 14, pHome: 0.68, pDraw: 0.14, pAway: 0.18 }, // Tor Heim
  { minute: 20, pHome: 0.66, pDraw: 0.15, pAway: 0.19 },
  { minute: 25, pHome: 0.63, pDraw: 0.16, pAway: 0.21 },
  { minute: 31, pHome: 0.45, pDraw: 0.22, pAway: 0.33 }, // Tor Auswärts
  { minute: 35, pHome: 0.47, pDraw: 0.21, pAway: 0.32 },
  { minute: 40, pHome: 0.49, pDraw: 0.20, pAway: 0.31 },
  { minute: 46, pHome: 0.71, pDraw: 0.11, pAway: 0.18 }, // Tor Heim
  { minute: 50, pHome: 0.74, pDraw: 0.10, pAway: 0.16 },
  { minute: 55, pHome: 0.79, pDraw: 0.08, pAway: 0.13 },
  { minute: 58, pHome: 0.83, pDraw: 0.06, pAway: 0.11 },
]

const DEMO_EVENTS = [
  { minute: 14, type: 'goal', side: 'home', text: 'Tor · M. Fritsche (Assist: L. Meier)' },
  { minute: 22, type: 'penalty', side: 'away', text: '2′ Behinderung · D. Kast' },
  { minute: 31, type: 'goal', side: 'away', text: 'Tor · J. Corvi (Powerplay)' },
  { minute: 38, type: 'penalty', side: 'home', text: '2′ Halten · R. Steiner' },
  { minute: 46, type: 'goal', side: 'home', text: 'Tor · L. Meier (Assist: M. Fritsche, T. Wick)' },
  { minute: 52, type: 'penalty', side: 'away', text: '2′ Hoher Stock · P. Ott' },
]

const DEMO_STATS = {
  sogHome: 27, sogAway: 21,
  shotsHome: 34, shotsAway: 29,
  faceoffsWonHome: 26, faceoffsWonAway: 21,
  ppHome: 4, ppAway: 3,
  ppGoalsHome: 1, ppGoalsAway: 1,
  pimHome: 6, pimAway: 4,
}

// Baut ein vollständiges Demo-Objekt für zwei konkrete Teams (übernimmt nur
// deren id/name/short/color aus den echten Team-Stammdaten - keine erfundenen
// Team-Infos). Aktueller Score/Status wird aus der letzten Timeline-Zeile
// abgeleitet, damit Header und Chart konsistent bleiben.
export function buildDemoLiveMatch(homeTeam, awayTeam) {
  const last = DEMO_PROBABILITY_TIMELINE[DEMO_PROBABILITY_TIMELINE.length - 1]
  const homeGoals = DEMO_EVENTS.filter((e) => e.type === 'goal' && e.side === 'home').length
  const awayGoals = DEMO_EVENTS.filter((e) => e.type === 'goal' && e.side === 'away').length

  return {
    isDemo: true,
    homeTeam, awayTeam,
    status: { period: 3, periodLabel: '3. Drittel', clock: '01:42', percent: 92 },
    score: { home: homeGoals, away: awayGoals },
    probability: { pHome: last.pHome, pDraw: last.pDraw, pAway: last.pAway },
    probabilityTimeline: DEMO_PROBABILITY_TIMELINE,
    events: DEMO_EVENTS,
    stats: DEMO_STATS,
  }
}

// ---------------------------------------------------------------------------
// SINGLE SOURCE OF TRUTH für Pre-Game-Match-Prognosen. Ein konkretes Spiel
// darf im gesamten Frontend nur EINE Pre-Game-Wahrscheinlichkeit haben -
// diese Datei ist die einzige Stelle, die entscheidet, welche der beiden
// bereits bestehenden Quellen für ein gegebenes Spiel gilt:
//
//   1. Eingefrorener Prediction-Snapshot (server/scripts/predictions.js,
//      db.predictions[]) - existiert für praktisch jedes 'scheduled'-Spiel
//      (wird bei jedem SIHF-Sync für neu angesetzte Spiele nachgezogen,
//      siehe ensurePredictionSnapshots()). IMMER bevorzugt, wenn vorhanden.
//   2. Live-Fallback aus der bestehenden, UNVERÄNDERTEN Forecast-Logik
//      (computeMatchForecasts()/computeFixtures(), src/playoffSim.js) - nur
//      für den seltenen Fall, dass ein Spiel (noch) keinen Snapshot hat
//      (z.B. zwischen zwei Sync-Läufen neu ins System gekommen).
//
// KEINE neue Modellberechnung - reine Priorisierung/Vereinheitlichung
// zweier bereits bestehender, unveränderter Quellen. Vorher zeigten
// verschiedene Seiten für dasselbe Spiel unterschiedliche Werte, weil jede
// Seite ihre eigene Kopie dieser Priorisierung (oder gar keine, sondern nur
// die Live-Neuberechnung) hatte - siehe Commit-Historie.
//
// PRÄZISION: alle zurückgegebenen Wahrscheinlichkeiten/Torerwartungen sind
// die vollen Fliesskommazahlen der jeweiligen Quelle (Snapshot: bereits auf
// 4 Nachkommastellen gerundet beim Erzeugen, siehe predictions.js; Live-
// Fallback: exakte Werte aus playoffSim.js). Rundung auf ganze Prozent für
// die Anzeige passiert ausschliesslich in der jeweiligen UI-Komponente beim
// Rendern - hier wird NIE mit einem bereits gerundeten UI-Wert
// weitergerechnet.
//
// OT/SO-SEMANTIK: `pHomeWin`/`pAwayWin` sind die FINALE Sieg-Wahrschein-
// lichkeit INKLUSIVE Verlängerung/Penaltyschiessen (identisch zu
// predictions.js/playoffSim.js::simulateGameResult - eine Entscheidung nach
// 60 Minuten zählt als Sieg für das jeweilige Team, unabhängig davon, ob
// sie reguär oder in OT/SO fiel). `pOT`/`pSO` sind ZUSÄTZLICH die
// Wahrscheinlichkeit, dass die Entscheidung erst NACH der regulären
// Spielzeit fällt (OT bzw. SO je einzeln, `pDecision` = pOT+pSO) - eine
// separate Zusatzinfo, NICHT Teil von pHomeWin/pAwayWin und nicht mit einer
// Regulation-3-Wege-Quote (Heimsieg n.60'/Unentschieden n.60'/Auswärtssieg
// n.60') zu verwechseln, die diese Datei nicht liefert.
// ---------------------------------------------------------------------------

// Baut aus einem Prediction-Snapshot (db.predictions[]-Eintrag, siehe
// server/scripts/predictions.js) das gemeinsame interne Prediction-Format.
function fromSnapshot(snapshot) {
  return {
    source: 'snapshot',
    gameId: snapshot.gameId,
    pHomeWin: snapshot.homeWinProbability,
    pAwayWin: snapshot.awayWinProbability,
    pOT: snapshot.otProbability,
    pSO: snapshot.soProbability,
    pDecision: (snapshot.otProbability ?? 0) + (snapshot.soProbability ?? 0),
    expHomeGoals: snapshot.expectedHomeGoals,
    expAwayGoals: snapshot.expectedAwayGoals,
    eloHome: snapshot.eloHome,
    eloAway: snapshot.eloAway,
    playerRatingAdjHome: snapshot.playerRatingAdjHome ?? null,
    playerRatingAdjAway: snapshot.playerRatingAdjAway ?? null,
    createdAt: snapshot.createdAt,
    modelVersion: snapshot.modelVersion,
    seed: snapshot.seed,
  }
}

// Baut aus einem live berechneten Forecast-Eintrag (Form von
// computeMatchForecasts()/dessen üblicher Anreicherung in den Seiten, siehe
// z.B. Dashboard.jsx) das gemeinsame interne Prediction-Format - reine
// Umbenennung/Durchreichung vorhandener Felder, keine neue Berechnung.
function fromLiveForecast(f) {
  if (!f) return null
  return {
    source: 'live',
    gameId: f.gameId,
    pHomeWin: f.pHomeWin,
    pAwayWin: f.pAwayWin,
    pOT: f.pOT ?? null,
    pSO: f.pSO ?? null,
    pDecision: f.pDecision ?? null,
    expHomeGoals: f.expHomeGoals ?? null,
    expAwayGoals: f.expAwayGoals ?? null,
    eloHome: f.eloHome ?? null,
    eloAway: f.eloAway ?? null,
    playerRatingAdjHome: f.playerRatingAdjHome ?? null,
    playerRatingAdjAway: f.playerRatingAdjAway ?? null,
  }
}

// Zentrale Lookup-Funktion für EIN Spiel: liefert dessen Pre-Game-Prediction
// - Snapshot bevorzugt, sonst `liveForecast` (falls übergeben) als Fallback.
// `predictions`: data.predictions (roh, ungefiltert, wie aus der API/DataContext).
// `liveForecast`: optionales, bereits berechnetes Live-Fixture/Forecast-
// Objekt (z.B. aus computeMatchForecasts() oder einer einzelnen
// simulateSingleGame()/computeFixtures()-Auswertung) mit mindestens
// {gameId, pHomeWin, pAwayWin} - nur verwendet, wenn kein Snapshot existiert.
export function getPregamePrediction(gameId, predictions, liveForecast) {
  const snapshot = (predictions || []).find((p) => p.gameId === gameId)
  if (snapshot) return fromSnapshot(snapshot)
  return fromLiveForecast(liveForecast)
}

// Reichert eine ganze Forecast-Liste (computeMatchForecasts()-Form, siehe
// src/playoffSim.js) mit den Snapshot-Werten an, wo vorhanden - EIN Aufruf
// für alle Listenansichten (Dashboard "Nächste Spiele", PlayoffOdds
// "Per-Match-Forecast", TeamDetail "Matchups") statt denselben Merge an
// jeder Stelle zu duplizieren. Reihenfolge/Länge des Arrays bleibt
// unverändert, nur die Prognosefelder werden ggf. ersetzt.
export function withPregamePredictions(forecasts, predictions) {
  if (!Array.isArray(forecasts)) return forecasts
  return forecasts.map((f) => {
    const p = getPregamePrediction(f.gameId, predictions, f)
    if (!p) return f
    return {
      ...f,
      pHomeWin: p.pHomeWin,
      pAwayWin: p.pAwayWin,
      pOT: p.pOT,
      pSO: p.pSO,
      pDecision: p.pDecision,
      expHomeGoals: p.expHomeGoals,
      expAwayGoals: p.expAwayGoals,
      eloHome: p.eloHome,
      eloAway: p.eloAway,
      playerRatingAdjHome: p.playerRatingAdjHome,
      playerRatingAdjAway: p.playerRatingAdjAway,
      predictionSource: p.source,
    }
  })
}

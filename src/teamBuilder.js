// ---------------------------------------------------------------------------
// Team-Builder: bestes Topscorers-Team fürs Budget, aus den Fantasy-Punkten
// (src/fantasyScore.js) und derived.playerStats. Rein additiv - kein Eingriff
// in ELO/Prognose.
//
// PROBLEM: aus 3 Positions-Pools (Torhüter/Verteidiger/Stürmer) je eine feste
// Anzahl Spieler wählen (1/6/9), gemeinsames Budget, Zielgrösse maximieren.
// Das ist ein Multiple-Choice-Knapsack-artiges Problem mit GETEILTEM Budget
// über 3 Gruppen mit je einer festen Auswahlanzahl (nicht "höchstens 1 pro
// Gruppe" wie klassisches MCKP, sondern "genau k pro Gruppe").
//
// LÖSUNG (exakte dynamische Programmierung, kein Heuristik-Fallback nötig -
// bei den vorliegenden Kadergrössen (~30-250 Spieler je Position) und einem
// CHF-10'000-Budgetraster ist die exakte DP schnell genug, siehe Bericht):
//   1. Je Position: 0/1-Knapsack-DP "wähle GENAU k Spieler, maximiere Wert,
//      Kosten <= b" für jedes Budget b auf dem Raster (Standardrekursion,
//      liefert dp[k][b] UND erlaubt exakte Rückverfolgung der Auswahl).
//   2. Die 3 Positions-Kurven (Wert als Funktion des ihr zugewiesenen
//      Budgets) werden über eine zweite kleine DP kombiniert (Budget-
//      Aufteilung zwischen den 3 Gruppen maximieren) - liefert die optimale
//      Budgetaufteilung UND daraus die exakte Kader-Rekonstruktion.
// ---------------------------------------------------------------------------

export const DEFAULT_TEAM_BUILDER_SETTINGS = {
  budget: 4_000_000, // CHF 3 Mio Team + 1 Mio Transfer (offizielle Topscorers-Regel)
  budgetStep: 10_000, // Budget-Raster für die exakte DP
  rosterSize: { G: 1, D: 6, F: 9 }, // 16 Spieler total (offizielle Topscorers-Aufstellung)
  minGp: 5,
  objective: 'perGame', // 'perGame' | 'total'
}

const POSITION_ORDER = ['G', 'D', 'F']
const POSITION_FULL_LABEL = { G: 'Torhüter', D: 'Verteidiger', F: 'Stürmer' }

// ============================================================================
// 0/1-Knapsack mit exakter Auswahlanzahl k, vollständige 3D-DP-Tabelle
// (Item-Schritt x Anzahl x Budget) für exakte Rückverfolgung. dp[i][c][b] =
// bester Wert aus den ersten i Kandidaten, GENAU c gewählt, Kosten <= b -
// Standardrekursion (skip vs. take), daher automatisch "<= b" (siehe
// Bericht), keine separate Glättung nötig.
// ---------------------------------------------------------------------------
function buildGroupDp(items, count, maxB) {
  const n = items.length
  const K = count
  const rowSize = (K + 1) * (maxB + 1)
  const dp = new Float64Array((n + 1) * rowSize).fill(-Infinity)
  for (let b = 0; b <= maxB; b++) dp[b] = 0 // itemStep 0, c=0: Kosten 0, für jedes Budget gültig

  for (let i = 1; i <= n; i++) {
    const it = items[i - 1]
    const prevBase = (i - 1) * rowSize
    const curBase = i * rowSize
    for (let c = 0; c <= K; c++) {
      const prevRowC = prevBase + c * (maxB + 1)
      const curRowC = curBase + c * (maxB + 1)
      const prevRowC1 = c >= 1 ? prevBase + (c - 1) * (maxB + 1) : -1
      for (let b = 0; b <= maxB; b++) {
        let best = dp[prevRowC + b] // Kandidat i nicht wählen
        if (c >= 1 && b >= it.costSteps) {
          const cand = dp[prevRowC1 + (b - it.costSteps)] + it.value
          if (cand >= best) best = cand // Gleichstand -> "nehmen" bevorzugt (konsistent mit Rückverfolgung unten)
        }
        dp[curRowC + b] = best
      }
    }
  }

  const valueAtB = new Float64Array(maxB + 1)
  const lastRowK = n * rowSize + K * (maxB + 1)
  for (let b = 0; b <= maxB; b++) valueAtB[b] = dp[lastRowK + b]

  // Rekonstruiert die GENAU count gewählten Kandidaten für ein Ziel-Budget
  // targetB - leitet exakt dieselbe Entscheidung wie der Vorwärtslauf her
  // (identische Gleichstand-Regel "nehmen bei >="), daher robust ohne
  // Float-Vergleichs-Klimmzüge.
  function reconstruct(targetB) {
    let c = K, b = targetB
    const chosen = []
    for (let i = n; i >= 1 && c > 0; i--) {
      const it = items[i - 1]
      const prevBase = (i - 1) * rowSize
      const skipVal = dp[prevBase + c * (maxB + 1) + b]
      let takeVal = -Infinity
      if (c >= 1 && b >= it.costSteps) {
        takeVal = dp[prevBase + (c - 1) * (maxB + 1) + (b - it.costSteps)] + it.value
      }
      if (takeVal >= skipVal && takeVal > -Infinity) {
        chosen.push(it)
        c -= 1
        b -= it.costSteps
      }
    }
    return chosen
  }

  return { valueAtB, reconstruct }
}

// Kombiniert zwei Wert-Kurven (Funktion des jeweils zugewiesenen Budgets) zu
// einer gemeinsamen Kurve über die Budget-Summe - liefert zusätzlich, welcher
// Teilbudget-Wert (für Kurve A) die Kombination je Gesamtbudget erreicht hat
// (für die spätere Rückverfolgung).
function combineCurves(valueA, valueB, maxB) {
  const combined = new Float64Array(maxB + 1).fill(-Infinity)
  const splitA = new Int32Array(maxB + 1).fill(-1)
  for (let b = 0; b <= maxB; b++) {
    let best = -Infinity, bestSplit = -1
    for (let ba = 0; ba <= b; ba++) {
      const bb = b - ba
      if (valueA[ba] === -Infinity || valueB[bb] === -Infinity) continue
      const val = valueA[ba] + valueB[bb]
      if (val > best) { best = val; bestSplit = ba }
    }
    combined[b] = best
    splitA[b] = bestSplit
  }
  return { combined, splitA }
}

// ============================================================================
// ÖFFENTLICHE API
// ============================================================================

// `playerStatRows`: derived.playerStats (bereits mit .fantasy angereichert
// via computeFantasyScores, siehe src/fantasyScore.js - Aufrufer übergibt das
// fertige Array, keine erneute Aggregation hier).
export function solveTeamBuilder(playerStatRows, settings = {}) {
  const cfg = { ...DEFAULT_TEAM_BUILDER_SETTINGS, ...settings, rosterSize: { ...DEFAULT_TEAM_BUILDER_SETTINGS.rosterSize, ...(settings.rosterSize || {}) } }
  const { budget, budgetStep, rosterSize, minGp, objective } = cfg
  const maxB = Math.floor(budget / budgetStep)

  const pools = { G: [], D: [], F: [] }
  for (const row of playerStatRows || []) {
    if (!row.fantasy || row.gp < minGp) continue
    const mv = row.player.marketValue
    if (mv == null || mv <= 0) continue // kein Marktwert bekannt -> nicht budgetierbar, ehrlich ausgeschlossen (nicht erfunden)
    const value = objective === 'total' ? row.fantasy.total : (row.fantasy.perGame ?? 0)
    const costSteps = Math.ceil(mv / budgetStep) // aufrunden: nie zu günstig rechnen
    const pos = row.player.position
    if (pools[pos]) pools[pos].push({ value, costSteps, marketValue: mv, row })
  }

  // 1) Kadergrössen-Machbarkeit (unabhängig vom Budget)
  for (const pos of POSITION_ORDER) {
    if (pools[pos].length < rosterSize[pos]) {
      return {
        feasible: false,
        reason: `Nicht genug ${POSITION_FULL_LABEL[pos]} mit >= ${minGp} Spielen und bekanntem Marktwert (${pools[pos].length} verfügbar, ${rosterSize[pos]} benötigt). Mindest-Spiele-Filter senken oder NL-API-Sync prüfen.`,
        minRequiredBudget: null,
        objective, cfg,
      }
    }
  }

  // 2) Minimalbudget der günstigsten GÜLTIGEN Aufstellung (unabhängig vom
  // Value) - ehrliche Angabe, falls das gewählte Budget nicht reicht.
  const minRequiredBudget = POSITION_ORDER.reduce((sum, pos) => {
    const cheapest = [...pools[pos]].sort((a, b) => a.marketValue - b.marketValue).slice(0, rosterSize[pos])
    return sum + cheapest.reduce((s, x) => s + x.marketValue, 0)
  }, 0)
  if (minRequiredBudget > budget) {
    return {
      feasible: false,
      reason: `Selbst die günstigste gültige 1/${rosterSize.D}/${rosterSize.F}-Aufstellung übersteigt das gewählte Budget.`,
      minRequiredBudget,
      objective, cfg,
    }
  }

  // 3) Exakte DP je Position + Kombination der Budget-Aufteilung
  const dpG = buildGroupDp(pools.G, rosterSize.G, maxB)
  const dpD = buildGroupDp(pools.D, rosterSize.D, maxB)
  const dpF = buildGroupDp(pools.F, rosterSize.F, maxB)

  const { combined: combinedGD, splitA: splitG } = combineCurves(dpG.valueAtB, dpD.valueAtB, maxB)
  const { combined: combinedGDF, splitA: splitGD } = combineCurves(combinedGD, dpF.valueAtB, maxB)

  const totalValue = combinedGDF[maxB]
  if (!Number.isFinite(totalValue)) {
    // Sollte nach dem Minimalbudget-Check oben nicht mehr vorkommen - defensiv trotzdem sauber gemeldet, nichts erfunden.
    return { feasible: false, reason: 'Keine gültige Aufstellung innerhalb des Budgets gefunden.', minRequiredBudget, objective, cfg }
  }

  const bgd = splitGD[maxB]
  const bf = maxB - bgd
  const bg = splitG[bgd]
  const bd = bgd - bg

  const chosenG = dpG.reconstruct(bg)
  const chosenD = dpD.reconstruct(bd)
  const chosenF = dpF.reconstruct(bf)

  const allChosen = [...chosenG, ...chosenD, ...chosenF]
  const totalCost = allChosen.reduce((s, x) => s + x.marketValue, 0)

  const withRatio = (list) => list
    .map((x) => ({ row: x.row, marketValue: x.marketValue, value: x.value }))
    .sort((a, b) => b.value - a.value)

  return {
    feasible: true,
    exact: true, // exakte DP, keine Heuristik
    objective,
    cfg,
    roster: { G: withRatio(chosenG), D: withRatio(chosenD), F: withRatio(chosenF) },
    totalCost,
    remainingBudget: budget - totalCost,
    totalValue,
  }
}

export { POSITION_ORDER, POSITION_FULL_LABEL }

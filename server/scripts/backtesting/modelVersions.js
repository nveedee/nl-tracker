// ---------------------------------------------------------------------------
// MODEL VERSION HISTORY - zentrale, menschenlesbare Definition jeder
// Modellversion (Abschnitt 9). Rein deklarativ (Name/Beschreibung/Features/
// Datum/Status) - die eigentliche Implementierung lebt in predictors.js.
//
// `status` ist HANDVERGEBEN (kein Automatismus, der Production wechselt) -
// siehe Bericht/UI "Model Verdict" für die Begründung je Version. Dieselbe
// Datei wird sowohl vom Backtest-Runner (run.js, hängt Backtest-Ergebnisse
// an) als auch vom Frontend (public/backtest-results.json) konsumiert.
// ---------------------------------------------------------------------------

export const MODEL_VERSION_REGISTRY = [
  {
    id: 'v0',
    name: 'v0 – Naive Basisrate',
    description: 'Konstante historische Heimsieg-Quote (walk-forward aus Vorsaisons). Keine Team-Stärke-Information. Reine untere Referenzlinie.',
    features: ['Heimsieg-Basisrate'],
    date: '2026-08-24',
    status: 'candidate',
  },
  {
    id: 'v1',
    name: 'v1 – ELO Baseline',
    description: 'Produktives ELO (src/elo.js, unverändert) mit flachem Saisonstart bei 1500 – entspricht dem tatsächlichen Live-Verhalten OHNE die separate Pre-Season-ELO-Komponente.',
    features: ['ELO', 'Heimvorteil'],
    date: '2026-08-24',
    status: 'candidate',
  },
  {
    id: 'v2',
    name: 'v2 – ELO + Pre-Season-ELO',
    description: 'v1 + Saisonstart-ELO aus dem 25%-regressierten Saisonend-ELO der Vorsaison (src/preseasonElo.js) – das ist bereits eine PRODUKTIVE Komponente (Toggle in den Einstellungen, Default an).',
    features: ['ELO', 'Heimvorteil', 'Pre-Season-ELO-Carryover'],
    date: '2026-08-24',
    status: 'production',
  },
  {
    id: 'v2_marketvalue',
    name: 'v2b – ELO + Marktwert-Prior',
    description: 'Produktive Komponente (src/marketValuePrior.js, Toggle Default an), aber HISTORISCH NICHT VALIDIERBAR – keine saisonbezogenen historischen Marktwerte verfügbar, rückwirkende Anwendung heutiger Werte wäre Leakage.',
    features: ['Marktwert-Prior'],
    date: '2026-08-24',
    status: 'not_validatable',
  },
  {
    id: 'v3',
    name: 'v3 – v2 + Ruhetage/Back-to-back',
    description: 'v2 + Anpassung der Heimsieg-Wahrscheinlichkeit bei einseitigem Back-to-back (src/restDays.js) – ebenfalls bereits produktiv (Toggle Default an).',
    features: ['ELO', 'Heimvorteil', 'Pre-Season-ELO-Carryover', 'Ruhetage/Back-to-back'],
    date: '2026-08-24',
    status: 'production',
  },
  {
    id: 'v2_sog',
    name: 'v2c – v2 + SOG-Allowed (Ablation)',
    description: 'v2 + ELO-Adjustierung nach zugelassenen Schüssen/Spiel (Teil der Live-Einzelspiel-Prognose via src/playoffSim.js), isoliert getestet OHNE Ruhetage/Poisson-Transformation.',
    features: ['ELO', 'Heimvorteil', 'Pre-Season-ELO-Carryover', 'SOG-Allowed'],
    date: '2026-08-24',
    status: 'production',
  },
  {
    id: 'production_reference',
    name: 'Produktions-Referenz (ohne Marktwert-Prior)',
    description: 'Die tatsächlich live laufende Einzelspiel-Prognose-Pipeline (server/scripts/predictions.js), soweit historisch rekonstruierbar: v3 + SOG-Allowed + Poisson/Skellam-Toreerwartung. Fehlt: Marktwert-Prior (siehe v2b).',
    features: ['ELO', 'Heimvorteil', 'Pre-Season-ELO-Carryover', 'SOG-Allowed', 'Poisson/Skellam-Toreerwartung', 'Ruhetage/Back-to-back'],
    date: '2026-08-24',
    status: 'production',
  },
]

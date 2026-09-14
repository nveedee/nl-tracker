import { SectionHeader } from './ui.jsx'
import { SCORELINE_BUCKET_COUNT, scorelineLabel, maxCellProbability, cellIntensity } from '../scorelineMatrix.js'

const INDICES = Array.from({ length: SCORELINE_BUCKET_COUNT }, (_, i) => i)

function fmtCellPct(prob) {
  const pct = prob * 100
  if (pct <= 0) return '0%'
  // "0.0%" soll vermieden werden, wenn intern eine kleine Wahrscheinlichkeit
  // vorliegt (siehe Auftrag) - unter 0.05% wird stattdessen "<0.1%" gezeigt.
  if (pct < 0.05) return '<0.1%'
  return pct.toFixed(1) + '%'
}

function fmtTooltipPct(prob) {
  const pct = prob * 100
  return pct < 0.01 ? '<0.01%' : pct.toFixed(2) + '%'
}

function hexToRgb(hex) {
  if (!hex || hex[0] !== '#') return null
  const n = hex.length === 4
    ? [hex[1] + hex[1], hex[2] + hex[2], hex[3] + hex[3]]
    : [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)]
  const [r, g, b] = n.map((h) => parseInt(h, 16))
  if ([r, g, b].some(Number.isNaN)) return null
  return [r, g, b]
}

// WICHTIG: die Intensität wird als rgba()-ALPHA in die Hintergrundfarbe
// codiert - NICHT als CSS `opacity` auf die ganze Zelle. `opacity` würde
// auch den Prozent-TEXT mitverblassen lassen (bei kleiner Wahrscheinlichkeit
// dann kaum noch lesbar) - hier bleibt der Text unabhängig von der
// Hintergrund-Intensität immer voll lesbar.
function heatBackground(hex, alpha) {
  const rgb = hexToRgb(hex)
  if (!rgb) return `rgba(150, 150, 150, ${alpha})`
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`
}

// Heim-Teamfarbe (Hex) -> hell/dunkel, für Textkontrast bei hoher Zell-
// Intensität (dieselbe Luminanz-Formel wie PositionMatrix.jsx::heatColor).
function isDarkHex(hex) {
  const rgb = hexToRgb(hex)
  if (!rgb) return false
  const [r, g, b] = rgb
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.55
}

// Scoreline Probabilities (%) - Heim-x-Auswärtstore-Wahrscheinlichkeits-
// matrix für EIN Spiel, im Football-MD-Stil (konzentrierte Heatmap statt
// Excel-Tabelle) für den NL Tracker adaptiert. Keine eigene Wahrschein-
// lichkeitsberechnung - `scorelineProbabilities` kommt 1:1 aus
// src/scorelineMatrix.js::buildScorelineMatrix(), gespeist von den bereits
// vorhandenen Monte-Carlo-Läufen der Match-Detailseite (siehe
// MatchupDetail.jsx::simulateSingleGame()). Teamnamen/-farben vollständig
// dynamisch - keine hartcodierten Teams.
export default function ScorelineMatrix({ homeTeam, awayTeam, scorelineProbabilities }) {
  const { matrix, totalRuns } = scorelineProbabilities || { matrix: null, totalRuns: 0 }
  if (!matrix || totalRuns === 0 || !homeTeam || !awayTeam) return null

  const maxProb = maxCellProbability(matrix)
  const darkText = isDarkHex(homeTeam.color)

  return (
    <div className="card card-pad mb">
      <SectionHeader
        title="Scoreline Probabilities (%)"
        caption={`Wahrscheinlichkeit je Endresultat · ${totalRuns.toLocaleString('de-CH')} Simulationen`}
      />

      <div className="scoreline-body">
        <div className="scoreline-vaxis" aria-hidden="true">
          <span>↑ {homeTeam.short} Tore</span>
        </div>
        <div className="scoreline-content">
          <div className="scoreline-haxis">{awayTeam.short} Tore →</div>
          <div className="scoreline-grid">
            <div className="scoreline-cell scoreline-corner" />
            {INDICES.map((c) => (
              <div key={`ch-${c}`} className="scoreline-cell scoreline-colhead">{scorelineLabel(c)}</div>
            ))}
            {INDICES.map((r) => (
              <div key={`row-${r}`} className="scoreline-row" style={{ display: 'contents' }}>
                <div className="scoreline-cell scoreline-rowhead">{scorelineLabel(r)}</div>
                {INDICES.map((c) => {
                  const prob = matrix[r][c]
                  const intensity = cellIntensity(prob, maxProb)
                  return (
                    <div
                      key={`${r}-${c}`}
                      className="scoreline-cell scoreline-data"
                      style={{
                        background: heatBackground(homeTeam.color, intensity),
                        color: intensity > 0.45 && darkText ? '#fff' : 'var(--text)',
                      }}
                      title={`${scorelineLabel(r)} : ${scorelineLabel(c)}\nProbability: ${fmtTooltipPct(prob)}`}
                    >
                      {fmtCellPct(prob)}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

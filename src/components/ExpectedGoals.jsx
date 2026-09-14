import { SectionHeader } from './ui.jsx'

// Expected Goals (xG) - Ø simulierte Tore je Team (Hockey-Definition, siehe
// Auftrag: NICHT die Fussball-xG-Definition/Schussqualität, sondern der aus
// der bestehenden Monte-Carlo-Simulation erwartete Torschnitt). Keine eigene
// Berechnung hier - `xg` kommt 1:1 aus src/scorelineMatrix.js::
// expectedGoals(), gespeist von denselben Simulationsläufen wie die
// Scoreline-Matrix/Goal Probabilities auf derselben Seite. Teamnamen/-farben
// vollständig dynamisch - keine hartcodierten Teams.
export default function ExpectedGoals({ homeTeam, awayTeam, xg }) {
  if (!xg || xg.totalRuns === 0 || !homeTeam || !awayTeam) return null

  return (
    <div className="card card-pad mb">
      <SectionHeader title="Expected Goals" caption="Ø erwartete Tore aus der Simulation" />
      <div className="xg-teams">
        <div className="xg-team">
          <div className="xg-label" style={{ color: homeTeam.color }}>Heim</div>
          <div className="xg-team-name">{homeTeam.short}</div>
          <div className="xg-value">{xg.homeXG.toFixed(2)}</div>
        </div>
        <div className="xg-divider" aria-hidden="true" />
        <div className="xg-team">
          <div className="xg-label" style={{ color: awayTeam.color }}>Auswärts</div>
          <div className="xg-team-name">{awayTeam.short}</div>
          <div className="xg-value">{xg.awayXG.toFixed(2)}</div>
        </div>
      </div>
      <div className="xg-total">
        <span>Total</span>
        <strong>{xg.totalXG.toFixed(2)}</strong>
      </div>
    </div>
  )
}

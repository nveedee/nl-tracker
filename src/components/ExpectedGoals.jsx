import { SectionHeader } from './ui.jsx'

// Expected Goals (xG) - Ø erwartete Tore je Team (Hockey-Definition, siehe
// Auftrag: NICHT die Fussball-xG-Definition/Schussqualität). Die Headline-
// Werte (homeXG/awayXG/totalXG) kommen aus derselben zentralen Pre-Game-
// Prediction wie die "Model Forecast"-Karte (src/pregamePrediction.js) -
// nicht mehr direkt aus der lokalen 10'000er-Live-Simulation dieser Seite,
// damit hier nie eine zweite, abweichende xG-Zahl für dasselbe Spiel
// auftaucht (siehe MatchupDetail.jsx). Teamnamen/-farben vollständig
// dynamisch - keine hartcodierten Teams.
export default function ExpectedGoals({ homeTeam, awayTeam, xg }) {
  if (!xg || !homeTeam || !awayTeam) return null

  return (
    <div className="card card-pad mb">
      <SectionHeader title="Expected Goals" caption="Aus dem Model Forecast (Pre-Game-Snapshot)" />
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

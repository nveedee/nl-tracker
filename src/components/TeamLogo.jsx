import { useState } from 'react'
import { getTeamLogoPath } from '../teamLogos.js'

// Zentrale Logo-Komponente - lädt automatisch das richtige Logo aus der
// zentralen Zuordnung (src/teamLogos.js), z.B. <TeamLogo teamId="team_klo" size={32} />.
// `team` (optional, ein Team-Objekt aus data.teams) kann statt/zusätzlich zu
// `teamId` übergeben werden - liefert dann `team.color` als Fallback-Farbe
// für den Platzhalter-Punkt (siehe unten), falls kein Logo geladen werden kann.
//
// Fallback-Verhalten (WICHTIG, siehe Auftrag "keine Dummy-Logos"): Ist kein
// Logo für diese Team-ID hinterlegt ODER schlägt das Laden fehl (Datei fehlt
// noch im Repo, 404), wird NIE ein kaputtes Bild-Icon gezeigt, sondern der
// bestehende, bereits überall genutzte Farbpunkt (.dot) - sobald die echten
// PNG-Dateien unter public/teams/ abgelegt werden, erscheinen die Logos ohne
// weitere Code-Änderung automatisch.
//
// object-fit:contain in einer quadratischen Box verhindert Verzerrung,
// unabhängig vom tatsächlichen Seitenverhältnis des Logos (manche Vereins-
// logos sind eher breit, andere eher rund/quadratisch) - kein Zuschneiden,
// kein Strecken.
export default function TeamLogo({ teamId, team, size = 20, className, style }) {
  const [failed, setFailed] = useState(false)
  const id = teamId ?? team?.id
  const path = id ? getTeamLogoPath(id) : null

  if (!path || failed) {
    const color = team?.color
    if (!color) return null
    // Gleicher Platzhalter wie der bisherige TeamBadge-Punkt (.dot,
    // src/styles.css) - Grösse proportional zu `size`, damit der Wechsel
    // Logo <-> Fallback keinen Layout-Sprung verursacht.
    return (
      <span
        className={'dot' + (className ? ' ' + className : '')}
        style={{ width: Math.round(size * 0.4), height: Math.round(size * 0.4), background: color, ...style }}
      />
    )
  }

  return (
    <img
      src={path}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={className}
      style={{ width: size, height: size, objectFit: 'contain', flex: 'none', display: 'inline-block', ...style }}
      onError={() => setFailed(true)}
    />
  )
}

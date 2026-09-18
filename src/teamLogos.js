// ---------------------------------------------------------------------------
// Zentrale Team-Logo-Konfiguration.
//
// Ergänzt die bestehenden Team-Stammdaten (id/name/short/color, siehe
// server/data/seed.json bzw. db.teams - Single Source of Truth für
// Team-IDENTITÄT, hier NICHT dupliziert) um GENAU EIN neues Feld: das Logo.
// Bestehende Team-IDs werden unverändert übernommen (keine neuen IDs
// erfunden) - nur der Dateiname weicht an einigen Stellen vom Vereinsnamen
// ab (z.B. "team_apk" = HC Ambrì-Piotta -> ambri.png, "team_gse" =
// Genève-Servette HC -> servette.png, "team_scl" = SCL Tigers -> tigers.png),
// siehe Mapping unten.
//
// Erwartete Ablage: public/teams/<datei>.png (Vite liefert alles unter
// public/ unverändert unter der Root-URL aus, siehe public/favicon.svg für
// dasselbe Muster) - referenziert hier als "/teams/<datei>.png".
//
// Die 14 PNG-Dateien selbst sind NICHT Teil dieses Commits (siehe Bericht) -
// TeamLogo.jsx fällt bis dahin automatisch auf den bestehenden Farbpunkt
// zurück (kein Dummy-Logo, kein kaputtes Bild-Icon).
// ---------------------------------------------------------------------------

export const TEAM_LOGOS = {
  team_ajo: 'ajoie.png',       // HC Ajoie
  team_apk: 'ambri.png',       // HC Ambrì-Piotta
  team_scb: 'bern.png',        // SC Bern
  team_bie: 'biel.png',        // EHC Biel
  team_dav: 'davos.png',       // HC Davos
  team_fri: 'fribourg.png',    // Fribourg-Gottéron
  team_gse: 'servette.png',    // Genève-Servette HC
  team_klo: 'kloten.png',      // EHC Kloten
  team_scl: 'tigers.png',      // SCL Tigers
  team_lau: 'lausanne.png',    // Lausanne HC
  team_lug: 'lugano.png',      // HC Lugano
  team_rap: 'rapperswil.png',  // Rapperswil-Jona Lakers
  team_zug: 'zug.png',         // EV Zug
  team_zsc: 'zsc.png',         // ZSC Lions
}

const TEAM_LOGO_DIR = '/teams/'

// Öffentlicher Logo-Pfad für eine Team-ID, oder null wenn kein Logo
// hinterlegt ist (z.B. unbekannte/zukünftige Team-ID) - Aufrufer (TeamLogo.jsx)
// fallen dann auf den Farbpunkt zurück statt ein kaputtes <img> zu rendern.
export function getTeamLogoPath(teamId) {
  const file = TEAM_LOGOS[teamId]
  return file ? TEAM_LOGO_DIR + file : null
}

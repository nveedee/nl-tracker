/**
 * Hockey spectator capacities researched on 2026-10-10.
 * Values are bound to the 2026/27 season; source URLs and confidence are kept
 * beside the data so later updates do not require editing analytics/UI code.
 * Unverified values deliberately remain null and are never used for ratios.
 */
const ARENA_CAPACITY_SOURCES = {
  team_ajo: {
    teamId: 'team_ajo', arena: 'Raiffeisen Arena', capacity: 5366,
    seating: null, standing: null, source: 'https://www.sihf.ch/de/game-center/team/heimarena/1-1-103144',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'SIHF-Angabe 5\'366; eine aeltere Bundesquelle nennt 2\'400. Die Differenz ist nicht geklaert.',
  },
  team_apk: {
    teamId: 'team_apk', arena: 'Gottardo Arena', capacity: 6775,
    seating: 3775, standing: 3000, source: 'https://joomla.hcap.ch/de/stadion/gottardo-arena/portrait',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'Clubangabe; SIHF bestätigt das Total.',
  },
  team_scb: {
    teamId: 'team_scb', arena: 'PostFinance Arena', capacity: 17031,
    seating: 5635, standing: 9778, source: 'https://www.scb.ch/postfinance-arena-1/wissenswertes/',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'Clubangabe; Total umfasst weitere ausgewiesene VIP-, Boxen- und Presseplätze.',
  },
  team_bie: {
    teamId: 'team_bie', arena: 'Tissot Arena', capacity: 6556,
    seating: null, standing: null, source: 'https://www.sihf.ch/de/game-center/team/heimarena/1-1-102128',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'SIHF-Angabe 6\'556; Club-PDF nennt 6\'408 Plaetze. Die Differenz ist ungeklärt.',
  },
  team_dav: {
    teamId: 'team_dav', arena: 'VAT Arena (zondacrypto Arena)', capacity: 6547,
    seating: null, standing: null, source: 'https://www.sihf.ch/de/game-center/team/heimarena/122-2-103652',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'SIHF bestätigt das Total; Sitz-/Stehplatzaufteilung nicht primär bestätigt.',
  },
  team_fri: {
    teamId: 'team_fri', arena: 'BCF Arena', capacity: 9620,
    seating: null, standing: null, source: 'https://www.sihf.ch/de/game-center/team/heimarena/1-1-103138',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'SIHF-Angabe 9\'620; Clubangaben nennen teils 9\'600 bzw. 9\'372. Die Differenz bleibt ungeklärt.',
  },
  team_gse: {
    teamId: 'team_gse', arena: 'Les Vernets', capacity: 7135,
    seating: null, standing: null, source: 'https://www.sihf.ch/de/game-center/team/heimarena/1-1-103140',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'SIHF-Gesamtkapazität; Club berichtet ebenfalls ausverkaufte Spiele mit 7’135.',
  },
  team_klo: {
    teamId: 'team_klo', arena: 'SWISS Arena', capacity: 7453,
    seating: 5123, standing: null, source: 'https://www.ehc-kloten.ch/swiss-arena/stadion/',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'Clubangabe zum Total und Sitzplätzen; übrige Kategorien nicht vollständig aufgeschlüsselt.',
  },
  team_scl: {
    teamId: 'team_scl', arena: 'emmental versicherung arena', capacity: 6000,
    seating: null, standing: null, source: 'https://www.sihf.ch/de/game-center/team/heimarena/1-1-102127',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'SIHF-Gesamtkapazität; Club-Spielberichte nennen ebenfalls 6’000.',
  },
  team_lau: {
    teamId: 'team_lau', arena: 'Vaudoise aréna', capacity: 9600,
    seating: null, standing: null, source: 'https://www.sihf.ch/de/game-center/team/heimarena/1-1-103141',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'SIHF-Wert für die Eishockey-Heimarena; Eventkapazitäten sind nicht vergleichbar.',
  },
  team_lug: {
    teamId: 'team_lug', arena: 'Cornèr Arena', capacity: 6733,
    seating: null, standing: 1850, source: 'https://www.hclugano.ch/la_corner_arena_compie_30_anni2345678910111213141516171819202122232425262728293031323334353637383940.jspx2',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'Clubangabe, vom SIHF bestätigt; 1’850 Stehplätze.',
  },
  team_rap: {
    teamId: 'team_rap', arena: 'St.Galler Kantonalbank Arena', capacity: 6100,
    seating: null, standing: null, source: 'https://www.sihf.ch/de/game-center/team/heimarena/33-1-103750',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'SIHF-Gesamtkapazität.',
  },
  team_zug: {
    teamId: 'team_zug', arena: 'OYM hall', capacity: 7450,
    seating: null, standing: null, source: 'https://www.sihf.ch/de/game-center/team/heimarena/1-1-101144',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'SIHF-Angabe 7\'450; eine aeltere EVZ-Meldung nennt 7\'700.',
  },
  team_zsc: {
    teamId: 'team_zsc', arena: 'Swiss Life Arena', capacity: 12000,
    seating: 11156, standing: null, source: 'https://www.swisslifearena.ch/en/business/roomfinder/detail/main-arena/',
    checkedAt: '2026-10-10', confidence: 'provisional', validForSeason: '2026/27',
    note: 'Arenaseite nennt 12’000 gesamt und 11’156 Sitzplätze.',
  },
}

const SEASON_VALID_FROM = '2026-07-01'
const SEASON_VALID_TO = '2027-06-30'

export const ARENA_CAPACITIES = Object.freeze(Object.fromEntries(
  Object.entries(ARENA_CAPACITY_SOURCES).map(([teamId, record]) => [teamId, Object.freeze({
    ...record,
    // Future changes can split this into multiple evidence-backed date ranges.
    capacityPeriods: record.confidence === 'unverified' ? Object.freeze([]) : Object.freeze([
      Object.freeze({ validFrom: SEASON_VALID_FROM, validTo: SEASON_VALID_TO, capacity: record.capacity }),
    ]),
  })]),
))

export const PRELIMINARY_SAMPLE_SIZE = 10

export function capacityForGame(teamId, gameDate, capacities = ARENA_CAPACITIES) {
  const record = capacities[teamId]
  if (!record || record.confidence === 'unverified') return null
  if (record.validForSeason !== '2026/27' || typeof gameDate !== 'string') return null
  const date = new Date(`${gameDate}T12:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== gameDate) return null
  const period = record.capacityPeriods?.find((candidate) => gameDate >= candidate.validFrom && gameDate <= candidate.validTo)
  if (!period || !Number.isInteger(period.capacity) || period.capacity <= 0) return null
  return period.capacity
}

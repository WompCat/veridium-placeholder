// ---- Riot LoL DTOs (only the fields we use) ----

export interface LolParticipantDto {
  puuid: string;
  championName: string;
  teamPosition?: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  totalMinionsKilled: number;
  neutralMinionsKilled: number;
  gameEndedInEarlySurrender?: boolean; // remake
}

export interface LolMatchDto {
  metadata: { matchId: string; participants: string[] };
  info: {
    gameEndTimestamp: number; // epoch ms
    gameDuration: number; // seconds
    queueId: number;
    participants: LolParticipantDto[];
  };
}

export interface LolLeagueEntryDto {
  queueType: string; // RANKED_SOLO_5x5, RANKED_FLEX_SR, ...
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

// ---- Profile response ----

/** Riot's league queue type, e.g. RANKED_SOLO_5x5, RANKED_FLEX_SR, RANKED_PREMADE_5x5. */
export type LolQueue = string;

export interface LolRank {
  tier: string;
  division: string;
  leaguePoints: number;
  wins: number; // Riot's season totals for this queue
  losses: number;
}

export interface LolMatchRow {
  matchId: string;
  date: string; // YYYY-MM-DD
  queueId: number; // 420 Solo/Duo, 440 Flex; others shown as plain "Ranked"
  remake: boolean; // listed, but excluded from every stat
  champion: string;
  role: string;
  win: boolean;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  durationMin: number;
}

export interface LolChampionStats {
  champion: string;
  games: number;
  wins: number;
  winRate: number;
  kda: number;
}

export interface LolProfile {
  game: 'lol';
  riotId: string;
  region: string;
  season: number; // calendar year
  ranks: { solo: LolRank | null; flex: LolRank | null };
  otherRanks: Array<LolRank & { queue: LolQueue }>; // any other ranked queue Riot reports (e.g. RANKED_PREMADE_5x5)
  games: number; // ranked games this season that Veridium has verified, remakes excluded
  remakes: number;
  wins: number;
  winRate: number;
  kills: number; // averages per game
  deaths: number;
  assists: number;
  kda: number; // (kills + assists) / max(1, deaths)
  csPerMin: number;
  champions: LolChampionStats[]; // most played first
  roles: Array<{ role: string; games: number; winRate: number }>;
  matches: LolMatchRow[]; // newest first, the whole season
  history: { complete: boolean; syncing: boolean };
}

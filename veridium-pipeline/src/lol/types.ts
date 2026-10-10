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

export type LolQueue = 'RANKED_SOLO_5x5' | 'RANKED_FLEX_SR';

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
  queue: LolQueue;
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
  games: number; // ranked games this season that Veridium has verified
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

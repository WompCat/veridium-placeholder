// ---- Entity model (product spec) ----

export type QueueType = 'RANKED_TFT' | 'NORMAL_TFT';

export interface Player {
  puuid: string;
  riotId: string;
  region: string;
  verified: true;
  matches: Matchup[];
  rank: RankEntry | null;
}

export interface Matchup {
  matchId: string;
  queueType: QueueType;
  placement: number;
  timestamp: string; // ISO 8601
}

export interface RankEntry {
  tier: string;
  division: string;
  leaguePoints: number;
}

// Out of scope for the ingestion pipeline; typed now so the org dashboard can build on it.
export interface Organization {
  id: string;
  name: string;
  roster: Player[];
}

export interface Tournament {
  id: string;
  name: string;
  organizations: string[];
}

// ---- Riot API DTOs (only the fields we use) ----

export interface RiotAccountDto {
  puuid: string;
  gameName: string;
  tagLine: string;
}

export interface TftParticipantDto {
  puuid: string;
  placement: number;
  level?: number;
}

export interface TftMatchDto {
  metadata: { match_id: string; participants: string[] };
  info: {
    game_datetime: number; // epoch ms
    queue_id: number;
    tft_set_number?: number;
    participants: TftParticipantDto[];
  };
}

export interface TftLeagueEntryDto {
  queueType: string; // 'RANKED_TFT', 'RANKED_TFT_TURBO', ...
  tier?: string;
  rank?: string;
  leaguePoints?: number;
  wins: number;
  losses: number;
}

// ---- Stored rank snapshot (one per ingestion run) ----

export interface RankSnapshot extends RankEntry {
  wins: number;
  losses: number;
  fetchedAt: number; // epoch ms
}

// ---- API response for the Player Profile UI ----

export interface ProfileRank extends RankEntry {
  percentile: number | null; // Riot does not expose this; null until we have a source
}

export interface RecentMatch {
  matchId: string;
  date: string; // YYYY-MM-DD
  queueType: QueueType;
  placement: number;
  lpChange: number | null; // only known when a rank snapshot brackets the match
  rankAfter: string | null;
}

export interface PlayerProfile {
  riotId: string;
  region: string;
  verified: true;
  rank: ProfileRank | null;
  totalMatches: number;
  winRate: number; // top-4 rate, which is how Riot counts a TFT "win"
  avgPlacement: number;
  top1Rate: number;
  highestRank: string | null;
  recentMatches: RecentMatch[];
}

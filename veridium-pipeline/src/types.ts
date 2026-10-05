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
  set: number; // TFT set number; each set is a ranked season
}

export interface RankEntry {
  tier: string;
  division: string;
  leaguePoints: number;
}

// ---- Organizations, rosters, vacancies (org & vacancy backend) ----

/** The roster isn't stored on the org: it's derived from active OrgMembership rows joined against players. */
export interface Organization {
  id: string;
  name: string;
  createdAt: string;
}

export type MembershipStatus = 'active' | 'bench';

export interface OrgMembership {
  playerPuuid: string;
  organizationId: string;
  role: string;
  status: MembershipStatus;
  joinedAt: string;
  leftAt: string | null;
}

export type VacancyLevel = 'competitive' | 'casual';
export type VacancyStatus = 'open' | 'closed';

export interface Vacancy {
  id: string;
  organizationId: string;
  title: string;
  game: string;
  region: string;
  role: string | null; // the roster role this is for; pre-fills the roster entry on accept
  level: VacancyLevel;
  status: VacancyStatus;
  postedAt: string;
}

export type ApplicationStatus = 'pending' | 'accepted' | 'rejected';

export interface Application {
  id: string;
  vacancyId: string;
  playerPuuid: string;
  status: ApplicationStatus;
  appliedAt: string;
}

/** A player's verified stats, read from the pipeline's tables at request time (never stored on org rows). */
export interface PlayerSummary {
  puuid: string;
  riotId: string;
  region: string;
  verified: true;
  rank: ProfileRank | null;
  currentSet: number | null;
  totalMatches: number;
  rankedMatches: number;
  winRate: number;
  avgPlacement: number;
}

export interface RosterEntry extends OrgMembership {
  player: PlayerSummary;
}

export interface VacancyListing extends Vacancy {
  organizationName: string;
  applicationCount: number;
  pendingCount: number;
}

export interface ApplicationView extends Application {
  player: PlayerSummary;
  onRoster: boolean; // currently on the vacancy's org roster (an accepted applicant may not be added yet)
}

/** A player's own application, with the vacancy and org it's for. */
export interface PlayerApplication extends Application {
  vacancy: Pick<Vacancy, 'title' | 'game' | 'region' | 'role' | 'level' | 'status'>;
  organizationId: string;
  organizationName: string;
  onRoster: boolean;
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
    tft_set_number: number;
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
  set: number;
  queueType: QueueType;
  placement: number;
  lpChange: number | null; // only known when a rank snapshot brackets the match
  rankAfter: string | null;
}

export interface SeasonStats {
  totalMatches: number;
  rankedMatches: number;
  winRate: number; // top-4 rate, which is how Riot counts a TFT "win"
  avgPlacement: number;
  top1Rate: number;
}

export interface Season extends SeasonStats {
  set: number;
  label: string; // "Set 18"
  current: boolean;
  matches: RecentMatch[]; // newest first, the whole season
}

export interface HistoryStatus {
  complete: boolean; // every match in the tracked seasons is cached
  syncing: boolean; // a background backfill is running now
}

/** Top-level stats and recentMatches describe the current season; `seasons` has each tracked season. */
export interface PlayerProfile extends SeasonStats {
  riotId: string;
  region: string;
  verified: true;
  rank: ProfileRank | null;
  highestRank: string | null;
  recentMatches: RecentMatch[];
  currentSet: number | null;
  seasons: Season[]; // newest first: the current set plus previous ones
  history: HistoryStatus;
}

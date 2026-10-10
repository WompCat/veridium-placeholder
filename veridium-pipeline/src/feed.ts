import { LolStore } from './lol/store';
import type { LolRank } from './lol/types';
import type { OrgRepo } from './orgs/repo';
import { playerSummary } from './orgs/players';
import { ladderScore } from './tft/aggregate';
import type { IngestDeps } from './tft/ingest';
import type { PlayerSummary, QueueType } from './types';

// The home feed is built from what actually happened on the platform (TFT and League of Legends games,
// roster signings, vacancies). There are no user posts yet.

export interface SessionItem {
  type: 'session'; // one player's TFT games on one day
  at: string; // newest game in the session
  player: PlayerSummary;
  date: string; // YYYY-MM-DD
  set: number;
  games: Array<{ matchId: string; placement: number; queueType: QueueType }>; // newest first
  rankedGames: number;
  best: number;
  avgPlacement: number;
}

export interface RosterJoinItem {
  type: 'roster_join';
  at: string;
  organization: { id: string; name: string };
  player: PlayerSummary;
  role: string;
  status: 'active' | 'bench';
  roster: Array<{ riotId: string; role: string }>; // the org's current roster
}

export interface VacancyItem {
  type: 'vacancy';
  at: string;
  organization: { id: string; name: string };
  vacancy: { id: string; title: string; role: string | null; game: string; region: string; level: string; status: string };
}

export interface LolSessionItem {
  type: 'lol_session'; // one player's ranked League of Legends games on one day (remakes left out)
  at: string;
  player: PlayerSummary;
  soloRank: LolRank | null;
  date: string; // YYYY-MM-DD
  games: Array<{ matchId: string; queueId: number; champion: string; role: string; win: boolean; kills: number; deaths: number; assists: number }>; // newest first
  wins: number;
  losses: number;
  kda: number; // (kills + assists) / max(1, deaths) over the day
  topChampion: string;
}

export type FeedItem = SessionItem | LolSessionItem | RosterJoinItem | VacancyItem;

const RECENT_MATCHUPS = 400; // how far back to look for sessions

export function buildFeed(deps: IngestDeps & { orgs: OrgRepo }, limit = 20): FeedItem[] {
  const db = deps.store.db;
  const summaries = new Map<string, PlayerSummary | null>();
  const summary = (puuid: string) => {
    if (!summaries.has(puuid)) summaries.set(puuid, playerSummary(deps, puuid));
    return summaries.get(puuid)!;
  };

  // Sessions: only players who've been loaded (lobby-mates have matchups but no players row).
  const matchups = db
    .prepare(
      `SELECT mu.puuid, mu.match_id, mu.queue_type, mu.placement, mu.timestamp, m.set_number
       FROM matchups mu
       JOIN players p ON p.puuid = mu.puuid
       JOIN matches m ON m.match_id = mu.match_id
       ORDER BY mu.timestamp DESC LIMIT ?`,
    )
    .all(RECENT_MATCHUPS) as Array<{
    puuid: string;
    match_id: string;
    queue_type: QueueType;
    placement: number;
    timestamp: number;
    set_number: number;
  }>;
  const sessions = new Map<string, SessionItem>();
  for (const m of matchups) {
    const date = new Date(m.timestamp).toISOString().slice(0, 10);
    const key = `${m.puuid}|${date}`;
    let s = sessions.get(key);
    if (!s) {
      const player = summary(m.puuid);
      if (!player) continue;
      s = {
        type: 'session',
        at: new Date(m.timestamp).toISOString(),
        player,
        date,
        set: m.set_number,
        games: [],
        rankedGames: 0,
        best: 8,
        avgPlacement: 0,
      };
      sessions.set(key, s);
    }
    s.games.push({ matchId: m.match_id, placement: m.placement, queueType: m.queue_type });
  }
  for (const s of sessions.values()) {
    s.rankedGames = s.games.filter((g) => g.queueType === 'RANKED_TFT').length;
    s.best = Math.min(...s.games.map((g) => g.placement));
    s.avgPlacement = Math.round((s.games.reduce((t, g) => t + g.placement, 0) / s.games.length) * 10) / 10;
  }

  const rosters = new Map<string, Array<{ riotId: string; role: string }>>();
  const rosterOf = (orgId: string) => {
    if (!rosters.has(orgId)) {
      rosters.set(
        orgId,
        deps.orgs.listRoster(orgId).flatMap((m) => {
          const p = summary(m.playerPuuid);
          return p ? [{ riotId: p.riotId, role: m.role }] : [];
        }),
      );
    }
    return rosters.get(orgId)!;
  };

  const joins = db
    .prepare(
      `SELECT m.player_puuid, m.role, m.status, m.joined_at, o.id AS org_id, o.name AS org_name
       FROM org_memberships m JOIN organizations o ON o.id = m.organization_id
       ORDER BY m.joined_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    player_puuid: string;
    role: string;
    status: 'active' | 'bench';
    joined_at: string;
    org_id: string;
    org_name: string;
  }>;
  const joinItems: RosterJoinItem[] = joins.flatMap((j) => {
    const player = summary(j.player_puuid);
    return player
      ? [
          {
            type: 'roster_join' as const,
            at: j.joined_at,
            organization: { id: j.org_id, name: j.org_name },
            player,
            role: j.role,
            status: j.status,
            roster: rosterOf(j.org_id),
          },
        ]
      : [];
  });

  const vacancyItems: VacancyItem[] = deps.orgs.listVacancies({}).slice(0, limit).map((v) => ({
    type: 'vacancy',
    at: v.postedAt,
    organization: { id: v.organizationId, name: v.organizationName },
    vacancy: { id: v.id, title: v.title, role: v.role, game: v.game, region: v.region, level: v.level, status: v.status },
  }));

  // League of Legends: the same per-player-per-day grouping, from loaded players only, remakes excluded.
  const lolRows = db
    .prepare(
      `SELECT p.puuid, p.match_id, p.champion, p.role, p.win, p.kills, p.deaths, p.assists, m.game_end, m.queue_id
       FROM lol_participants p
       JOIN players pl ON pl.puuid = p.puuid
       JOIN lol_matches m ON m.match_id = p.match_id
       WHERE m.remake = 0
       ORDER BY m.game_end DESC LIMIT ?`,
    )
    .all(RECENT_MATCHUPS) as Array<{
    puuid: string;
    match_id: string;
    champion: string;
    role: string;
    win: number;
    kills: number;
    deaths: number;
    assists: number;
    game_end: number;
    queue_id: number;
  }>;
  const lolStore = new LolStore(db);
  const lolSessions = new Map<string, LolSessionItem>();
  for (const r of lolRows) {
    const date = new Date(r.game_end).toISOString().slice(0, 10);
    const key = `${r.puuid}|${date}`;
    let s = lolSessions.get(key);
    if (!s) {
      const player = summary(r.puuid);
      if (!player) continue;
      s = {
        type: 'lol_session',
        at: new Date(r.game_end).toISOString(),
        player,
        soloRank: lolStore.latestRank(r.puuid, 'RANKED_SOLO_5x5'),
        date,
        games: [],
        wins: 0,
        losses: 0,
        kda: 0,
        topChampion: '',
      };
      lolSessions.set(key, s);
    }
    s.games.push({
      matchId: r.match_id,
      queueId: r.queue_id,
      champion: r.champion,
      role: r.role,
      win: r.win === 1,
      kills: r.kills,
      deaths: r.deaths,
      assists: r.assists,
    });
  }
  for (const s of lolSessions.values()) {
    s.wins = s.games.filter((g) => g.win).length;
    s.losses = s.games.length - s.wins;
    const total = (key: 'kills' | 'deaths' | 'assists') => s.games.reduce((t, g) => t + g[key], 0);
    s.kda = Math.round(((total('kills') + total('assists')) / Math.max(1, total('deaths'))) * 100) / 100;
    const counts = new Map<string, number>();
    for (const g of s.games) counts.set(g.champion, (counts.get(g.champion) ?? 0) + 1);
    s.topChampion = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  return [...sessions.values(), ...lolSessions.values(), ...joinItems, ...vacancyItems]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

/** Loaded players with their verified summary: ranked players first (best rank in any game first), then by name. */
export function listPlayerSummaries(deps: IngestDeps): PlayerSummary[] {
  const players = deps.store.listPlayers().flatMap((p) => {
    const s = playerSummary(deps, p.puuid);
    return s ? [s] : [];
  });
  return players.sort((a, b) => {
    if (a.bestRank && b.bestRank) return ladderScore(b.bestRank) - ladderScore(a.bestRank) || a.riotId.localeCompare(b.riotId);
    if (a.bestRank || b.bestRank) return a.bestRank ? -1 : 1;
    return a.riotId.localeCompare(b.riotId);
  });
}
